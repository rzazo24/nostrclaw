// Against the real relay (skipped when no relay binary is available: set RELAY_BIN). Covers the network code that the fake API skips:
// the WebSocket queries, NIP-45 COUNT, NIP-11, the relay's /stats.json, signature checking, and the stdio transport end to end.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { nip19 } from 'nostr-tools'
import { VERSION } from '../src/config.js'
import { realApi } from '../src/nostr/client.js'
import { call, cfg, connect, ev, key } from './helpers.js'
import { relayBinary, startRelay, type TestRelay } from './relay-harness.js'

const bin = relayBinary()
const NOW = Math.floor(Date.now() / 1000)
let relay: TestRelay
const alice = key(), mallory = key()
const spammers = [key(), key(), key(), key()]

describe.skipIf(!bin)('against the real relay', () => {
  beforeAll(async () => {
    relay = await startRelay(bin!)
    const events = [
      ev(alice, 0, JSON.stringify({ name: 'Alice', about: 'Hello, I like relays' }), NOW - 3000),
      ev(alice, 1, 'my first note', NOW - 900), ev(alice, 1, 'second note', NOW - 600), ev(alice, 7, '+', NOW - 300, [['e', 'a'.repeat(64)]]),
      ev(alice, 3, '', NOW - 2500, [['p', mallory.pk], ['p', spammers[0]!.pk]]),
      ev(alice, 10002, '', NOW - 2400, [['r', 'wss://relay.example.com']]),
      ...spammers.map((k, i) => ev(k, 1, 'Azul', NOW - 100 - i)),
      ...Array.from({ length: 12 }, (_, i) => ev(mallory, 1, `buy now ${i}`, NOW - 200 - i)),
    ]
    await relay.publish(events)
  })
  afterAll(async () => { await relay?.stop() })

  const local = () => cfg({ relays: [relay.url], allowPrivate: true, timeoutMs: 5000 })

  it('the raw client: queries, counts and reads NIP-11 and /stats.json', async () => {
    const q = await realApi.query(relay.url, { kinds: [1], authors: [alice.pk] }, { timeoutMs: 5000, max: 50 })
    expect(q.eose).toBe(true); expect(q.events).toHaveLength(2); expect(q.invalid).toBe(0)
    expect((await realApi.count(relay.url, { kinds: [1] }, { timeoutMs: 5000 })).count).toBe(2 + 4 + 12)
    const info = await realApi.nip11(relay.url, { timeoutMs: 5000 })
    expect(info.doc.name).toBe('nostrclaw test relay')
    expect(Array.isArray(info.doc.supported_nips)).toBe(true)
    const stats = await realApi.publicStats(relay.url, { timeoutMs: 5000 })
    expect((stats!.events as { total: number }).total).toBeGreaterThanOrEqual(20)
  })

  it('stops at the limit instead of waiting for the end', async () => {
    const q = await realApi.query(relay.url, { kinds: [1] }, { timeoutMs: 5000, max: 5 })
    expect(q.events).toHaveLength(5)
    expect(q.eose).toBe(false)
  })

  it('fails with a readable error for a dead relay', async () => {
    await expect(realApi.query('ws://127.0.0.1:9', { kinds: [1] }, { timeoutMs: 2000, max: 5 })).rejects.toThrow(/could not talk to|closed the connection/)
  })

  it('relay_overview shows real information and statistics', async () => {
    const { client, close } = await connect(local())
    const r = await call(client, 'relay_overview')
    expect(r.json.reachable).toEqual({ http: true, websocket: true })
    expect(r.json.supportedNips).toContain(45)
    expect(r.json.publicStats.eventsStored).toBeGreaterThanOrEqual(20)
    expect(r.json.untrusted.name).toBe('nostrclaw test relay')
    await close()
  })

  it('recent_events, count_events and author_report work end to end', async () => {
    const { client, close } = await connect(local())
    const recent = await call(client, 'recent_events', { kinds: [1], authors: [alice.pk], limit: 10 })
    expect(recent.json.untrusted.events.map((e: { content: string }) => e.content)).toEqual(['second note', 'my first note'])
    expect((await call(client, 'count_events', { kinds: [1] })).json.count).toBe(18)
    const a = await call(client, 'author_report', { pubkey: nip19.npubEncode(alice.pk) })
    expect(a.json).toMatchObject({ hasProfile: true, follows: 2, eventsAnalysed: 6 })
    expect(a.json.untrusted.profile.name).toBe('Alice')
    expect(a.json.untrusted.relayList).toEqual(['wss://relay.example.com'])
    await close()
  })

  it('activity_report spots the repeated text across keys and the burst', async () => {
    const { client, close } = await connect(local())
    const r = await call(client, 'activity_report', { hours: 1, sampleLimit: 100, kinds: [1] })
    expect(r.json.sampleIsTruncated).toBe(false)
    expect(r.json.untrusted.repeatedText[0]).toMatchObject({ text: 'Azul', authors: 4 })
    expect(r.json.bursts[0]).toMatchObject({ pubkey: mallory.pk, events: 12 })
    expect(r.json.signals.map((s: { kind: string }) => s.kind)).toEqual(expect.arrayContaining(['duplicate-text', 'burst']))
    await close()
  })

  it('refuses to touch a local relay unless explicitly allowed', async () => {
    const { client, close } = await connect(cfg({ relays: [relay.url], allowPrivate: false }))
    const r = await call(client, 'relay_overview')
    expect(r.isError).toBe(true); expect(r.text).toMatch(/private address/)
    await close()
  })

  it('with signing enabled over stdio: the signing tools appear and the server says so', async () => {
    const entry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/index.js')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-stdio-'))
    const transport = new StdioClientTransport({
      command: process.execPath, args: [entry],
      env: { ...(process.env as Record<string, string>), NOSTRCLAW_RELAYS: relay.url, NOSTRCLAW_ALLOW_PRIVATE: '1', NOSTRCLAW_ENABLE_SIGNING: '1', NOSTRCLAW_CONFIG_DIR: dir, NOSTRCLAW_STATE_DIR: dir },
      stderr: 'pipe',
    })
    const client = new Client({ name: 'stdio-signing', version: '0' })
    let stderr = ''
    transport.stderr?.on('data', (d) => { stderr += d })
    await client.connect(transport)
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(expect.arrayContaining(['signer_connect', 'draft_event', 'publish_event']))
    const st = await client.callTool({ name: 'signer_status', arguments: {} })
    expect(JSON.parse((st.content as { text: string }[])[0]!.text)).toMatchObject({ state: 'disconnected', policy: { allowedKinds: [1, 7], maxEventsPerHour: 5 } })
    await client.close()
    expect(stderr).toMatch(/signing ENABLED/)
  })

  it('fails closed: an invalid policy.json stops the server instead of starting with something looser', async () => {
    const entry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/index.js')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-badpolicy-'))
    fs.writeFileSync(path.join(dir, 'policy.json'), JSON.stringify({ allowedKinds: 'everything' }))
    const child = spawn(process.execPath, [entry], { env: { ...process.env, NOSTRCLAW_RELAYS: relay.url, NOSTRCLAW_ALLOW_PRIVATE: '1', NOSTRCLAW_ENABLE_SIGNING: '1', NOSTRCLAW_CONFIG_DIR: dir, NOSTRCLAW_STATE_DIR: dir }, stdio: ['pipe', 'pipe', 'pipe'] })
    let stderr = '', stdout = ''
    child.stderr.on('data', (d) => { stderr += d }); child.stdout.on('data', (d) => { stdout += d })
    const code = await new Promise<number | null>((resolve) => child.on('exit', resolve))
    expect(code).not.toBe(0)
    expect(stderr).toMatch(/policy\.json.*allowedKinds/)
    expect(stdout).toBe('')
  })

  it('works as a real stdio MCP server: only protocol on stdout, tools usable', async () => {
    const entry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/index.js')
    const transport = new StdioClientTransport({
      command: process.execPath, args: [entry],
      env: { ...(process.env as Record<string, string>), NOSTRCLAW_RELAYS: relay.url, NOSTRCLAW_ALLOW_PRIVATE: '1', NOSTRCLAW_TIMEOUT_MS: '5000' },
      stderr: 'pipe',
    })
    const client = new Client({ name: 'stdio-test', version: '0' })
    let stderr = ''
    transport.stderr?.on('data', (d) => { stderr += d })
    await client.connect(transport)
    const { tools } = await client.listTools()
    expect(tools).toHaveLength(12)
    const r = await client.callTool({ name: 'recent_events', arguments: { kinds: [7], limit: 5 } })
    expect(r.isError).toBeFalsy()
    expect(JSON.parse((r.content as { text: string }[])[0]!.text).returned).toBe(1)
    await client.close()
    expect(stderr).toContain(`nostrclaw ${VERSION} ready (read-only)`)
  })
})
