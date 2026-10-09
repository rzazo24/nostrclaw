// `nostrclaw connect-bunker`: the address is read without being shown, is never printed, and the saved session is replaced only when the signer answers.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { nip19 } from 'nostr-tools'
import { BACKUP_NAME, readHiddenLine, redact, runConnectBunker } from '../src/connect.js'
import { SignerManager } from '../src/signing/signer.js'
import { FakeSigner } from './fake-signer.js'
import { relayBinary, startRelay, type TestRelay } from './relay-harness.js'

const tty = (isTTY: boolean) => { const s = new PassThrough() as unknown as NodeJS.ReadStream & PassThrough; (s as { isTTY: boolean }).isTTY = isTTY; s.setRawMode = (() => s) as never; return s }
const sink = () => { const lines: string[] = []; return { lines, write: (s: string) => { lines.push(s) } } }

describe('reading the address', () => {
  it('from a pipe: the first line, trimmed', async () => {
    const s = tty(false); const p = readHiddenLine(s, sink(), 'x'); s.write('  bunker://abc?secret=1  \nsecond line\n'); s.end(); expect(await p).toBe('bunker://abc?secret=1')
  })
  it('from a terminal: typed or pasted, never echoed, backspace works, Enter ends it', async () => {
    const s = tty(true), out = sink(); const p = readHiddenLine(s, out, 'PROMPT: '); s.write('bunker://abx'); s.write('\u007f'); s.write('c?secret=ZZZ\r')
    expect(await p).toBe('bunker://abc?secret=ZZZ'); expect(out.lines.join('')).toBe('PROMPT: \n'); expect(out.lines.join('')).not.toContain('ZZZ') // nothing of what was typed was written back
  })
  it('Ctrl-C and Esc give up', async () => {
    for (const key of ['\u0003', '\u001b']) { const s = tty(true); const p = readHiddenLine(s, sink(), 'x'); s.write('bunker://half'); s.write(key); await expect(p).rejects.toThrow('cancelled') }
  })
})

describe('redact', () => {
  it('removes the address and any secret from a message', () => {
    expect(redact('failed for bunker://abc?relay=wss://x&secret=TOPSECRET now')).toBe('failed for [bunker address] now'); expect(redact('x secret=TOPSECRET&y=1')).toBe('x secret=[hidden]&y=1')
  })
})

const bin = relayBinary()
describe.skipIf(!bin)('connect-bunker (real relay + pretend signer)', () => {
  let relay: TestRelay
  const fakes: FakeSigner[] = []
  beforeAll(async () => { relay = await startRelay(bin!) })
  afterAll(async () => { await relay?.stop() })
  afterEach(async () => { await Promise.all(fakes.splice(0).map((f) => f.stop())) })

  const dirs = () => ({ config: fs.mkdtempSync(path.join(os.tmpdir(), 'nc-cb-config-')), state: fs.mkdtempSync(path.join(os.tmpdir(), 'nc-cb-state-')) })
  const envFor = (d: { config: string; state: string }, enable = '1') => ({ NOSTRCLAW_ENABLE_SIGNING: enable, NOSTRCLAW_CONFIG_DIR: d.config, NOSTRCLAW_STATE_DIR: d.state, NOSTRCLAW_RELAYS: relay.url, NOSTRCLAW_ALLOW_PRIVATE: '1' })
  const bunker = async (fake: FakeSigner, secret = 'TOPSECRET-123') => { await fake.listen([relay.url], ''); fakes.push(fake); return `bunker://${fake.signerPk}?relay=${encodeURIComponent(relay.url)}&secret=${secret}` }
  const run = async (d: ReturnType<typeof dirs>, uri: string | (() => Promise<string>), over: { identityWaitMs?: number; enable?: string } = {}) => {
    const out: string[] = [], err: string[] = []
    const code = await runConnectBunker([], { env: envFor(d, over.enable), readUri: typeof uri === 'string' ? async () => uri : uri, out: (s) => out.push(s), err: (s) => err.push(s),
      manager: (c) => new SignerManager({ ...c, signing: { ...c.signing, identityWaitMs: over.identityWaitMs ?? 5000 } }) })
    return { code, out: out.join('\n'), err: err.join('\n') }
  }
  const OLD = { clientSecret: 'a'.repeat(64), signerPubkey: 'b'.repeat(64), relays: ['wss://old.example'] }

  it('pairs, saves a NEW app key and the signer, copies the old session aside, and never prints the secret', async () => {
    const d = dirs(), fake = new FakeSigner(), uri = await bunker(fake)
    fs.writeFileSync(path.join(d.config, 'signer.json'), JSON.stringify(OLD), { mode: 0o600 })
    const r = await run(d, uri)
    expect(r.code).toBe(0); expect(r.out).toContain(nip19.npubEncode(fake.userPk)); expect(r.out + r.err).not.toContain('TOPSECRET'); expect(r.out + r.err).not.toMatch(/bunker:\/\/\S/) // no address, only the word
    const saved = JSON.parse(fs.readFileSync(path.join(d.config, 'signer.json'), 'utf8')); expect(saved.signerPubkey).toBe(fake.signerPk); expect(saved.relays).toEqual([relay.url]); expect(saved.clientSecret).not.toBe(OLD.clientSecret); expect(saved.clientSecret).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.parse(fs.readFileSync(path.join(d.config, BACKUP_NAME), 'utf8'))).toEqual(OLD); expect(fs.statSync(path.join(d.config, 'signer.json')).mode & 0o777).toBe(0o600); expect(fs.statSync(path.join(d.config, BACKUP_NAME)).mode & 0o777).toBe(0o600)
    expect(fake.seen.map((s) => s.method)).toContain('connect'); expect(fake.signRequests).toBe(0) // pairing signs nothing
  })
  it('works with no previous session (nothing to copy aside)', async () => {
    const d = dirs(), fake = new FakeSigner(), r = await run(d, await bunker(fake))
    expect(r.code).toBe(0); expect(fs.existsSync(path.join(d.config, 'signer.json'))).toBe(true); expect(fs.existsSync(path.join(d.config, BACKUP_NAME))).toBe(false)
  })
  it('the saved session can be resumed afterwards (that is what signer_connect does)', async () => {
    const d = dirs(), fake = new FakeSigner(), r = await run(d, await bunker(fake)); expect(r.code).toBe(0)
    const cfgSign = { relays: [relay.url], allowPrivate: true, timeoutMs: 5000, maxEvents: 500, signing: { enabled: true, signerRelays: [relay.url], configDir: d.config, stateDir: d.state, identityWaitMs: 4000, resumeWaitMs: 4000 } }
    const m = new SignerManager(cfgSign as never); expect(m.hasSavedSession()).toBe(true); expect(await m.resume()).toBe(true); expect(m.userPubkey).toBe(fake.userPk); await m.close()
  })
  it('a signer that does not answer changes nothing: the old session is intact, the secret stays out of the messages', async () => {
    const d = dirs(), fake = new FakeSigner({ silentAboutIdentity: true }), uri = await bunker(fake)
    const old = JSON.stringify(OLD); fs.writeFileSync(path.join(d.config, 'signer.json'), old, { mode: 0o600 })
    const r = await run(d, uri, { identityWaitMs: 900 })
    expect(r.code).toBe(1); expect(fs.readFileSync(path.join(d.config, 'signer.json'), 'utf8')).toBe(old); expect(r.err).toContain('was not changed'); expect(r.out + r.err).not.toContain('TOPSECRET')
  })
  it('refuses what is not a bunker address, a cancelled prompt, and settings without signing — and changes nothing', async () => {
    const d = dirs(); const old = JSON.stringify(OLD); fs.writeFileSync(path.join(d.config, 'signer.json'), old)
    expect((await run(d, 'nostrconnect://abc?relay=wss://x')).code).toBe(2); expect((await run(d, async () => { throw new Error('cancelled') })).code).toBe(2); expect((await run(d, 'bunker://x', { enable: '0' })).code).toBe(2)
    expect(fs.readFileSync(path.join(d.config, 'signer.json'), 'utf8')).toBe(old); expect(fs.existsSync(path.join(d.config, BACKUP_NAME))).toBe(false)
  })
})
