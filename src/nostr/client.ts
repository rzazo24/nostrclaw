// A small read-only Nostr client: one short-lived connection per call. It never authenticates and never publishes (signing is a
// separate, later feature). Every event it returns has had its signature and id verified; invalid ones are counted and dropped.
import WebSocket from 'ws'
import { verifyEvent, type Event, type Filter } from 'nostr-tools'

export interface QueryResult {
  events: Event[]
  /** The relay said it sent everything it had for the filter (EOSE). False when we stopped on the timeout or the limit. */
  eose: boolean
  /** Why the relay closed the subscription itself (for example "auth-required: ..."). */
  closed?: string
  notices: string[]
  invalid: number
  ms: number
}

export interface CountResult { count: number | null; reason?: string; ms: number }

export interface PublishResult { ok: boolean; reason: string; ms: number }

export interface Nip11Result { doc: Record<string, unknown>; ms: number }

/** What the tools need from the network. Tests can pass a fake one. */
export interface NostrApi {
  query(relay: string, filter: Filter, o: { timeoutMs: number; max: number }): Promise<QueryResult>
  count(relay: string, filter: Filter, o: { timeoutMs: number }): Promise<CountResult>
  nip11(relay: string, o: { timeoutMs: number }): Promise<Nip11Result>
  /** Sends one signed event and waits for the relay's OK. Only the signing tools use it. */
  publish(relay: string, event: Event, o: { timeoutMs: number }): Promise<PublishResult>
  /** The relay's own public statistics document, if it publishes one (nostr-relay-khatru does, at /stats.json). */
  publicStats(relay: string, o: { timeoutMs: number }): Promise<Record<string, unknown> | null>
}

const MAX_BODY = 1_000_000
const MAX_FRAME = 4_000_000

export const httpUrl = (relay: string, path = '') => relay.replace(/^ws/, 'http').replace(/\/+$/, '') + path

async function readLimited(res: Response): Promise<string> {
  const reader = res.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    if (size > MAX_BODY) { await reader.cancel(); throw new Error('response too large') }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function getJson(url: string, accept: string, timeoutMs: number): Promise<{ doc: Record<string, unknown>; ms: number }> {
  const t0 = Date.now()
  // `redirect: error`: an allowed relay must not be able to bounce us to some other host
  const res = await fetch(url, { headers: { Accept: accept }, signal: AbortSignal.timeout(timeoutMs), redirect: 'error' })
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`)
  const doc = JSON.parse(await readLimited(res))
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) throw new Error(`${url} did not return a JSON object`)
  return { doc: doc as Record<string, unknown>, ms: Date.now() - t0 }
}

/** Opens a connection, runs `use` and always closes it. `use` resolves the call; timeouts are handled here. */
function withSocket<T>(relay: string, timeoutMs: number, use: (ws: WebSocket, done: (v: T) => void, fail: (e: Error) => void) => void, onTimeout: () => T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const ws = new WebSocket(relay, { handshakeTimeout: timeoutMs, maxPayload: MAX_FRAME, followRedirects: false, perMessageDeflate: false })
    let finished = false
    const finish = (fn: () => void) => { if (finished) return; finished = true; clearTimeout(timer); try { ws.close() } catch { /* already closed */ } fn() }
    const timer = setTimeout(() => finish(() => resolve(onTimeout())), timeoutMs)
    ws.on('error', (e) => finish(() => reject(new Error(`could not talk to ${relay}: ${e.message}`))))
    ws.on('close', () => finish(() => reject(new Error(`${relay} closed the connection`))))
    ws.on('open', () => use(ws, (v) => finish(() => resolve(v)), (e) => finish(() => reject(e))))
  })
}

let counter = 0
const subId = () => `nc${Date.now().toString(36)}${(counter++).toString(36)}`

export const realApi: NostrApi = {
  query(relay, filter, { timeoutMs, max }) {
    const t0 = Date.now()
    const events = new Map<string, Event>()
    const notices: string[] = []
    let invalid = 0, closed: string | undefined
    const result = (eose: boolean): QueryResult => ({ events: [...events.values()], eose, closed, notices, invalid, ms: Date.now() - t0 })
    return withSocket<QueryResult>(relay, timeoutMs, (ws, done) => {
      const id = subId()
      ws.on('message', (raw) => {
        let msg: unknown[]
        try { msg = JSON.parse(String(raw)) } catch { return }
        if (!Array.isArray(msg)) return
        if (msg[0] === 'EVENT' && msg[1] === id && msg[2] && typeof msg[2] === 'object') {
          const ev = msg[2] as Event
          if (events.has(ev.id)) return
          let ok = false
          try { ok = verifyEvent(ev) } catch { ok = false }
          if (!ok) { invalid++; return }
          events.set(ev.id, ev)
          if (events.size >= max) { try { ws.send(JSON.stringify(['CLOSE', id])) } catch { /* closing anyway */ } done(result(false)) }
        } else if (msg[0] === 'EOSE' && msg[1] === id) {
          try { ws.send(JSON.stringify(['CLOSE', id])) } catch { /* closing anyway */ }
          done(result(true))
        } else if (msg[0] === 'CLOSED' && msg[1] === id) {
          closed = String(msg[2] ?? '')
          done(result(false))
        } else if (msg[0] === 'NOTICE' && notices.length < 5) {
          notices.push(String(msg[1] ?? ''))
        }
        // AUTH challenges are ignored on purpose: this client is anonymous and read-only
      })
      ws.send(JSON.stringify(['REQ', id, { ...filter, limit: Math.min(filter.limit ?? max, max) }]))
    }, () => result(false))
  },

  count(relay, filter, { timeoutMs }) {
    const t0 = Date.now()
    return withSocket<CountResult>(relay, timeoutMs, (ws, done) => {
      const id = subId()
      ws.on('message', (raw) => {
        let msg: unknown[]
        try { msg = JSON.parse(String(raw)) } catch { return }
        if (!Array.isArray(msg)) return
        if (msg[0] === 'COUNT' && msg[1] === id && msg[2] && typeof (msg[2] as { count?: unknown }).count === 'number') {
          done({ count: (msg[2] as { count: number }).count, ms: Date.now() - t0 })
        } else if (msg[0] === 'CLOSED' && msg[1] === id) {
          done({ count: null, reason: String(msg[2] ?? 'closed by the relay'), ms: Date.now() - t0 })
        } else if (msg[0] === 'NOTICE') {
          done({ count: null, reason: `notice: ${String(msg[1] ?? '')}`, ms: Date.now() - t0 })
        }
      })
      ws.send(JSON.stringify(['COUNT', id, filter]))
    }, () => ({ count: null, reason: 'no answer (the relay may not support NIP-45 COUNT)', ms: Date.now() - t0 }))
  },

  publish(relay, event, { timeoutMs }) {
    const t0 = Date.now()
    return withSocket<PublishResult>(relay, timeoutMs, (ws, done) => {
      ws.on('message', (raw) => {
        let msg: unknown[]
        try { msg = JSON.parse(String(raw)) } catch { return }
        if (Array.isArray(msg) && msg[0] === 'OK' && msg[1] === event.id) done({ ok: msg[2] === true, reason: String(msg[3] ?? ''), ms: Date.now() - t0 })
      })
      ws.send(JSON.stringify(['EVENT', event]))
    }, () => ({ ok: false, reason: 'no answer from the relay', ms: Date.now() - t0 }))
  },

  nip11: (relay, { timeoutMs }) => getJson(httpUrl(relay), 'application/nostr+json', timeoutMs),

  async publicStats(relay, { timeoutMs }) {
    try { return (await getJson(httpUrl(relay, '/stats.json'), 'application/json', timeoutMs)).doc } catch { return null }
  },
}
