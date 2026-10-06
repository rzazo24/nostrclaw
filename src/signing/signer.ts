// The NIP-46 session with the user's remote signer. The user's private key is never here: this process holds only an app key, which
// identifies it to the signer, and asks the signer to sign. Saved session (app key + the signer's pubkey/relays) lives in
// `<config dir>/signer.json`, mode 0600.
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import WebSocket from 'ws'
import { generateSecretKey, getPublicKey, type EventTemplate, type VerifiedEvent } from 'nostr-tools'
import { BunkerSigner, createNostrConnectURI, type BunkerPointer } from 'nostr-tools/nip46'
import { SimplePool, useWebSocketImplementation } from 'nostr-tools/pool'
import { bytesToHex, hexToBytes } from 'nostr-tools/utils'
import { normalizeRelayUrl, type Config } from '../config.js'
import { assertPublicHost, cleanText } from '../safety.js'

useWebSocketImplementation(WebSocket)

export type SignerState = 'disconnected' | 'connecting' | 'connected'

interface Saved { clientSecret: string; signerPubkey?: string; relays?: string[] }

const CONNECT_WINDOW_MS = 120_000
/** After the handshake the signer must tell us which key it signs as. Signer apps on a phone are often suspended in the background, so this waits longer. */
const IDENTITY_WAIT_MS = 75_000
/** Resuming a saved session: how long to keep asking while the user opens the signer app, and how long each ask waits. */
const RESUME_WAIT_MS = 150_000
const RESUME_ATTEMPT_MS = 20_000

const asError = (e: unknown): Error => (e instanceof Error ? e : new Error(typeof e === 'string' ? e : JSON.stringify(e)))

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} did not answer within ${Math.round(ms / 1000)} s`)), ms)
    p.then((v) => { clearTimeout(t); resolve(v) }, (e) => { clearTimeout(t); reject(asError(e)) })
  })
}

export class SignerManager {
  state: SignerState = 'disconnected'
  /** What a 'connecting' state is waiting for (shown in the status). */
  phase?: 'waiting-for-approval' | 'waiting-for-the-signer-to-answer'
  userPubkey?: string
  signerPubkey?: string
  relays: string[] = []
  lastError?: string
  /** An approval page the signer asked the user to open (some signers do), cleaned; shown only in status for the user. */
  authUrl?: string
  /** Set when a signature came back too fast to be a human decision (see publish_event). */
  autoApprovalSuspected = false
  private signer?: BunkerSigner
  private pool?: SimplePool
  private pending?: { uri: string; until: number }
  private readonly file: string

  constructor(private cfg: Config, private now: () => number = Date.now) {
    this.file = path.join(cfg.signing.configDir, 'signer.json')
  }

  // ---- saved session ----
  private load(): Saved | null {
    try {
      const s = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Saved
      return typeof s.clientSecret === 'string' && /^[0-9a-f]{64}$/.test(s.clientSecret) ? s : null
    } catch { return null }
  }
  private save(s: Saved): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
    const tmp = `${this.file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 })
    fs.renameSync(tmp, this.file)
  }
  private clientKey(): Uint8Array {
    const saved = this.load()
    if (saved) return hexToBytes(saved.clientSecret)
    const sk = generateSecretKey()
    this.save({ clientSecret: bytesToHex(sk) })
    return sk
  }

  private params() {
    this.pool ??= new SimplePool()
    return { pool: this.pool, skipSwitchRelays: true, onauth: (url: string) => { this.authUrl = cleanText(url, 300) } }
  }

  private async established(signer: BunkerSigner, clientSecretHex: string): Promise<void> {
    this.signer = signer
    this.signerPubkey = signer.bp.pubkey
    this.relays = signer.bp.relays
    this.phase = 'waiting-for-the-signer-to-answer'
    this.userPubkey = await withTimeout(signer.getPublicKey(), this.cfg.signing.identityWaitMs ?? IDENTITY_WAIT_MS, 'the signer (which key it signs as). Keep the signer app open on screen while connecting; phone apps are suspended in the background')
    this.save({ clientSecret: clientSecretHex, signerPubkey: this.signerPubkey, relays: this.relays })
    this.state = 'connected'
    this.phase = undefined
    this.lastError = undefined
    this.autoApprovalSuspected = false
    this.pending = undefined
  }

  private failed(e: unknown): void {
    this.state = 'disconnected'
    this.phase = undefined
    this.lastError = cleanText(asError(e).message, 300)
    this.pending = undefined
  }

  // ---- connecting ----
  /** True when a previous session (app key + the signer's pubkey and relays) is saved on this machine. */
  hasSavedSession(): boolean {
    const saved = this.load()
    return !!(saved?.signerPubkey && saved.relays?.length)
  }

  /**
   * Resumes the saved session. True when the signer answered. A phone signer is often suspended until the user opens it, so this does not give up
   * after one try: it asks again every few seconds until `resumeWaitMs` has passed (so the user can open the app while this waits). The saved
   * session is left untouched when it fails.
   */
  async resume(): Promise<boolean> {
    if (this.state === 'connected') return true
    const saved = this.load()
    if (!saved?.signerPubkey || !saved.relays?.length) return false
    const budget = this.cfg.signing.resumeWaitMs ?? this.cfg.signing.identityWaitMs ?? RESUME_WAIT_MS
    const attempt = Math.min(this.cfg.signing.identityWaitMs ?? RESUME_ATTEMPT_MS, RESUME_ATTEMPT_MS)
    const end = Date.now() + budget
    try {
      const bp: BunkerPointer = { pubkey: saved.signerPubkey, relays: saved.relays, secret: null }
      const signer = BunkerSigner.fromBunker(hexToBytes(saved.clientSecret), bp, this.params())
      this.state = 'connecting'
      this.phase = 'waiting-for-the-signer-to-answer'
      this.signer = signer; this.signerPubkey = bp.pubkey; this.relays = bp.relays
      for (;;) {
        try {
          this.userPubkey = await withTimeout(signer.getPublicKey(), Math.max(1, Math.min(attempt, end - Date.now())), 'the signer (which key it signs as)')
          break
        } catch (e) {
          if (Date.now() + 500 >= end) throw new Error(`the signer (which key it signs as) did not answer within ${Math.round(budget / 1000)} s. Open the signer app (Clave) — or tap its notification, which arrives blank — and try again; the saved session is intact`)
        }
      }
      this.state = 'connected'; this.phase = undefined; this.lastError = undefined; this.autoApprovalSuspected = false; this.pending = undefined
      return true
    } catch (e) { await this.dropSigner(); this.failed(e); return false }
  }

  /** Starts a client-initiated connection: returns the link for the user's signer; the session completes in the background. */
  startNostrConnect(perms: string[]): { uri: string; expiresInSeconds: number } {
    if (this.state === 'connecting' && this.pending && this.pending.until > this.now()) {
      return { uri: this.pending.uri, expiresInSeconds: Math.round((this.pending.until - this.now()) / 1000) }
    }
    const sk = this.clientKey()
    const clientSecret = bytesToHex(sk)
    const uri = createNostrConnectURI({
      clientPubkey: getPublicKey(sk), relays: this.cfg.signing.signerRelays, secret: randomBytes(16).toString('hex'), perms, name: 'nostrclaw',
    })
    this.state = 'connecting'
    this.phase = 'waiting-for-approval'
    this.lastError = undefined
    this.pending = { uri, until: this.now() + CONNECT_WINDOW_MS }
    void (async () => {
      try {
        const signer = await BunkerSigner.fromURI(sk, uri, this.params(), AbortSignal.timeout(CONNECT_WINDOW_MS))
        await this.established(signer, clientSecret)
      } catch (e) { await this.dropSigner(); this.failed(e) }
    })()
    return { uri, expiresInSeconds: CONNECT_WINDOW_MS / 1000 }
  }

  /** Connects to a bunker:// URI the user provides (NIP-05 style addresses are not accepted: they would mean an HTTP lookup chosen by the caller). */
  async connectBunker(input: string): Promise<void> {
    const text = input.trim()
    if (!text.startsWith('bunker://')) throw new Error('expected a bunker://… URI')
    let url: URL
    try { url = new URL(text) } catch { throw new Error('not a valid bunker:// URI') }
    const pubkey = url.hostname || url.pathname.replace(/^\/+/, '')
    if (!/^[0-9a-f]{64}$/i.test(pubkey)) throw new Error('the bunker:// URI has no valid signer public key')
    const relays = url.searchParams.getAll('relay').map((r) => normalizeRelayUrl(r))
    if (!relays.length) throw new Error('the bunker:// URI lists no relay')
    for (const r of relays) assertPublicHost(r, this.cfg)
    const secret = url.searchParams.get('secret')
    const sk = this.clientKey()
    this.state = 'connecting'
    this.lastError = undefined
    try {
      const signer = BunkerSigner.fromBunker(sk, { pubkey: pubkey.toLowerCase(), relays, secret }, this.params())
      await withTimeout(signer.connect({ name: 'nostrclaw' }), CONNECT_WINDOW_MS, 'the signer (connect)')
      await this.established(signer, bytesToHex(sk))
    } catch (e) { await this.dropSigner(); this.failed(e); throw asError(e) }
  }

  // ---- using it ----
  /** Asks the signer to sign. Returns the signed event and how long the signer took (that time is how a human decision is told from an automatic one). */
  async sign(template: EventTemplate, timeoutMs: number): Promise<{ event: VerifiedEvent; ms: number }> {
    if (this.state !== 'connected' || !this.signer) throw new Error('no signer is connected')
    const t0 = Date.now()
    const event = await withTimeout(this.signer.signEvent(template), timeoutMs, 'the signer')
    return { event, ms: Date.now() - t0 }
  }

  private async dropSigner(): Promise<void> {
    try { await this.signer?.close() } catch { /* already closed */ }
    this.signer = undefined
  }

  /** Closes the session and forgets everything saved (app key included). */
  async disconnect(): Promise<void> {
    await this.dropSigner()
    this.state = 'disconnected'
    this.userPubkey = this.signerPubkey = this.authUrl = this.lastError = this.pending = undefined
    this.relays = []
    this.autoApprovalSuspected = false
    try { fs.rmSync(this.file, { force: true }) } catch { /* nothing to remove */ }
  }

  async close(): Promise<void> {
    await this.dropSigner()
    this.pool?.close(this.relays)
    this.pool = undefined
  }
}
