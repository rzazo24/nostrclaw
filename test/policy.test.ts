import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { Audit } from '../src/signing/audit.js'
import { checkDraft, loadPolicy } from '../src/signing/policy.js'
import { cfg } from './helpers.js'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nostrclaw-policy-'))
const withDir = (dir: string, relays = ['wss://relay.example.com']) => cfg({ relays, signing: { enabled: true, signerRelays: relays, configDir: dir, stateDir: dir } })

describe('config for signing', () => {
  it('is off by default and defaults the signer relays to Clave\'s relay plus the first relay', () => {
    const c = loadConfig({ NOSTRCLAW_RELAYS: 'wss://relay.example.com' })
    expect(c.signing.enabled).toBe(false)
    expect(c.signing.signerRelays).toEqual(['wss://relay.powr.build', 'wss://relay.example.com'])
    expect(c.signing.configDir).toMatch(/\.config[\\/]nostrclaw$/)
    expect(c.signing.stateDir).toMatch(/\.local[\\/]state[\\/]nostrclaw$/)
  })
  it('reads the switches and rejects bad signer relays', () => {
    const c = loadConfig({ NOSTRCLAW_ENABLE_SIGNING: '1', NOSTRCLAW_SIGNER_RELAYS: 'wss://a.example.com/, wss://b.example.com', NOSTRCLAW_CONFIG_DIR: '/x/c', NOSTRCLAW_STATE_DIR: '/x/s' })
    expect(c.signing).toEqual({ enabled: true, signerRelays: ['wss://a.example.com', 'wss://b.example.com'], configDir: '/x/c', stateDir: '/x/s' })
    expect(() => loadConfig({ NOSTRCLAW_SIGNER_RELAYS: 'https://nope.example.com' })).toThrow(/wss/)
  })
})

describe('policy file', () => {
  it('uses conservative defaults when there is no file', () => {
    const p = loadPolicy(withDir(tmp()))
    expect(p).toMatchObject({ allowedKinds: [1, 7], maxEventsPerHour: 5, maxContentChars: 1000, minHumanApprovalMs: 2000, publishRelays: ['wss://relay.example.com'] })
  })
  it('reads the user\'s file and adds their own blocked patterns to the built-in ones', () => {
    const dir = tmp()
    fs.writeFileSync(path.join(dir, 'policy.json'), JSON.stringify({ allowedKinds: [1], maxEventsPerHour: 2, blockedPatterns: ['forbidden word'], minHumanApprovalMs: 500 }))
    const p = loadPolicy(withDir(dir))
    expect(p).toMatchObject({ allowedKinds: [1], maxEventsPerHour: 2, minHumanApprovalMs: 500 })
    expect(checkDraft(p, { kind: 1, content: 'this has a Forbidden Word inside', tags: [] })).toMatch(/blocked pattern/)
  })
  it('fails closed: an invalid file stops the server with a message naming the file and the field', () => {
    const dir = tmp()
    const write = (o: unknown) => fs.writeFileSync(path.join(dir, 'policy.json'), typeof o === 'string' ? o : JSON.stringify(o))
    write('{ not json'); expect(() => loadPolicy(withDir(dir))).toThrow(/policy\.json.*not valid JSON/)
    write({ allowedKinds: 'all' }); expect(() => loadPolicy(withDir(dir))).toThrow(/allowedKinds/)
    write({ maxEventsPerHour: 0 }); expect(() => loadPolicy(withDir(dir))).toThrow(/maxEventsPerHour/)
    write({ surprise: true }); expect(() => loadPolicy(withDir(dir))).toThrow(/policy\.json/) // unknown keys are refused, not ignored
    write({ blockedPatterns: ['('] }); expect(() => loadPolicy(withDir(dir))).toThrow(/regular expression/)
    write({ publishRelays: ['wss://elsewhere.example.net'] }); expect(() => loadPolicy(withDir(dir))).toThrow(/not in NOSTRCLAW_RELAYS/)
  })
})

describe('checkDraft: relay lists (kinds 10002 and 10050)', () => {
  const p = () => ({ ...loadPolicy(cfg({ signing: { enabled: true, signerRelays: [], configDir: '/nonexistent/c', stateDir: '/nonexistent/s' } })), allowedKinds: [1, 7, 5, 10002, 10050] })
  const r = (n: number) => `wss://relay${n}.example.net`
  it('is refused unless the policy lists the kind', () => {
    const off = loadPolicy(cfg({ signing: { enabled: true, signerRelays: [], configDir: '/nonexistent/c', stateDir: '/nonexistent/s' } }))
    expect(checkDraft(off, { kind: 10002, content: '', tags: [['r', r(1)]] })).toMatch(/kind 10002 is not allowed/)
    expect(checkDraft(off, { kind: 10050, content: '', tags: [['relay', r(1)]] })).toMatch(/kind 10050 is not allowed/)
  })
  it('accepts the right tag for each list, with read/write markers only on NIP-65', () => {
    expect(checkDraft(p(), { kind: 10002, content: '', tags: [['r', r(1)], ['r', r(2), 'read'], ['r', r(3), 'write']] })).toBeNull()
    expect(checkDraft(p(), { kind: 10050, content: '', tags: [['relay', r(1)], ['relay', r(2)]] })).toBeNull()
    expect(checkDraft(p(), { kind: 10050, content: '', tags: [['r', r(1)]] })).toMatch(/only \["relay"/)
    expect(checkDraft(p(), { kind: 10002, content: '', tags: [['relay', r(1)]] })).toMatch(/only \["r"/)
    expect(checkDraft(p(), { kind: 10050, content: '', tags: [['relay', r(1), 'read']] })).toMatch(/only \["relay"/)
    expect(checkDraft(p(), { kind: 10002, content: '', tags: [['r', r(1), 'sideways']] })).toMatch(/read or write/)
  })
  it('allows only wss:// relays, 1 to 10, each once, with no content', () => {
    for (const bad of ['ws://relay.example.net', 'https://relay.example.net', 'wss://', 'wss://has space.example.net', 'relay.example.net']) {
      expect(checkDraft(p(), { kind: 10002, content: '', tags: [['r', bad]] }), bad).toMatch(/only \["r"/)
    }
    expect(checkDraft(p(), { kind: 10002, content: '', tags: [] })).toMatch(/between 1 and 10/)
    expect(checkDraft(p(), { kind: 10002, content: '', tags: Array.from({ length: 11 }, (_, i) => ['r', r(i)]) })).toMatch(/between 1 and 10/)
    expect(checkDraft(p(), { kind: 10002, content: '', tags: [['r', r(1)], ['r', r(1)]] })).toMatch(/each relay once/)
    expect(checkDraft(p(), { kind: 10002, content: 'hello', tags: [['r', r(1)]] })).toMatch(/no content/)
  })
})

describe('checkDraft: deletions (kind 5)', () => {
  const p = () => loadPolicy(cfg({ signing: { enabled: true, signerRelays: [], configDir: '/nonexistent/c', stateDir: '/nonexistent/s' } }))
  const allowing = () => ({ ...p(), allowedKinds: [1, 7, 5] })
  const id = (n: string) => n.repeat(64)
  it('is refused unless the policy lists kind 5', () => {
    expect(checkDraft(p(), { kind: 5, content: '', tags: [['e', id('a')]] })).toMatch(/kind 5 is not allowed/)
    expect(checkDraft(allowing(), { kind: 5, content: 'test note', tags: [['e', id('a')], ['k', '1']] })).toBeNull()
  })
  it('names between 1 and 5 events, with only e and k tags', () => {
    expect(checkDraft(allowing(), { kind: 5, content: '', tags: [] })).toMatch(/between 1 and 5 events/)
    expect(checkDraft(allowing(), { kind: 5, content: '', tags: ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => ['e', id(n)]) })).toMatch(/between 1 and 5/)
    expect(checkDraft(allowing(), { kind: 5, content: '', tags: [['e', id('a')], ['p', id('b')]] })).toMatch(/only e tags/)
    expect(checkDraft(allowing(), { kind: 5, content: '', tags: [['e', 'not-hex']] })).toMatch(/only e tags/)
    expect(checkDraft(allowing(), { kind: 5, content: '', tags: [['e', id('a'), 'wss://relay.example', 'root']] })).toMatch(/only e tags/)
    expect(checkDraft(allowing(), { kind: 5, content: '', tags: [['e', id('a')], ['k', 'text']] })).toMatch(/only e tags/)
  })
  it('keeps the reason short and subject to the blocked patterns', () => {
    expect(checkDraft(allowing(), { kind: 5, content: 'x'.repeat(201), tags: [['e', id('a')]] })).toMatch(/at most 200/)
    expect(checkDraft(allowing(), { kind: 5, content: 'oops nsec1' + 'q'.repeat(30), tags: [['e', id('a')]] })).toMatch(/blocked pattern/)
  })
})

describe('checkDraft', () => {
  const p = () => loadPolicy(withDir(tmp()))
  it('allows an ordinary note and a reaction', () => {
    expect(checkDraft(p(), { kind: 1, content: 'hello nostr', tags: [] })).toBeNull()
    expect(checkDraft(p(), { kind: 7, content: '+', tags: [['e', 'a'.repeat(64)], ['p', 'b'.repeat(64)]] })).toBeNull()
  })
  it('refuses kinds that are not allowed (profile, lists, deletions...)', () => {
    for (const kind of [0, 3, 5, 10002, 4, 22242]) expect(checkDraft(p(), { kind, content: 'x', tags: [] }), String(kind)).toMatch(/not allowed by the policy/)
  })
  it('enforces length, tag count and empty notes', () => {
    expect(checkDraft(p(), { kind: 1, content: 'x'.repeat(1001), tags: [] })).toMatch(/1001 characters/)
    expect(checkDraft(p(), { kind: 1, content: 'x', tags: Array.from({ length: 21 }, () => ['t', 'a']) })).toMatch(/21 tags/)
    expect(checkDraft(p(), { kind: 1, content: '   ', tags: [] })).toMatch(/empty/)
  })
  it('refuses anything that looks like a secret, in content or tags', () => {
    for (const bad of ['my key nsec1' + 'q'.repeat(58), 'ncryptsec1' + 'q'.repeat(40), 'connect: bunker://abc?relay=wss://x', 'nostrconnect://abc?secret=1', 'token secret=abc']) {
      expect(checkDraft(p(), { kind: 1, content: bad, tags: [] }), bad).toMatch(/blocked pattern/)
    }
    expect(checkDraft(p(), { kind: 1, content: 'hi', tags: [['t', 'secret=oops']] })).toMatch(/blocked pattern/)
    expect(checkDraft(p(), { kind: 1, content: 'I like the word nsec and bunkers', tags: [] })).toBeNull() // only real-looking secrets
  })
})

describe('audit log', () => {
  it('writes private JSON lines, counts signature requests in the last hour and survives a restart', () => {
    const dir = tmp()
    let now = 1_000_000_000_000
    const a = new Audit(dir, () => now)
    a.log({ step: 'draft', draftId: 'd_1', kind: 1, contentHash: 'h' })
    a.log({ step: 'sign-requested', draftId: 'd_1' })
    now += 30 * 60_000
    a.log({ step: 'sign-requested', draftId: 'd_2' })
    expect(a.signRequestsLastHour()).toBe(2)
    const file = path.join(dir, 'audit.jsonl')
    expect((fs.statSync(file).mode & 0o777).toString(8)).toBe('600')
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    expect(lines.map((l) => l.step)).toEqual(['draft', 'sign-requested', 'sign-requested'])
    expect(JSON.stringify(lines)).not.toMatch(/content"/) // hashes only
    now += 40 * 60_000 // the first request is now more than an hour old
    expect(a.signRequestsLastHour()).toBe(1)
    expect(new Audit(dir, () => now).signRequestsLastHour()).toBe(1) // a new process picks up the last hour
    fs.appendFileSync(file, 'garbage line\n')
    expect(new Audit(dir, () => now).signRequestsLastHour()).toBe(1) // damaged lines are skipped
  })
})
