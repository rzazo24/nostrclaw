import { describe, expect, it } from 'vitest'
import { loadConfig, normalizeRelayUrl } from '../src/config.js'
import { assertPublicHost, cleanText, resolveRelay, toHexPubkey } from '../src/safety.js'
import { cfg } from './helpers.js'

describe('config', () => {
  it('defaults to the hivescope relay, read-only limits and public hosts only', () => {
    const c = loadConfig({})
    expect(c.relays).toEqual(['wss://relay.hivescope.xyz'])
    expect(c.allowPrivate).toBe(false)
    expect(c.timeoutMs).toBe(8000)
  })
  it('reads and normalises the relay list, removing duplicates', () => {
    expect(loadConfig({ NOSTRCLAW_RELAYS: 'wss://A.example.com/, wss://a.example.com ,wss://b.example.com' }).relays).toEqual(['wss://a.example.com', 'wss://b.example.com'])
  })
  it('rejects bad values naming the variable', () => {
    expect(() => loadConfig({ NOSTRCLAW_TIMEOUT_MS: '5' })).toThrow(/NOSTRCLAW_TIMEOUT_MS/)
    expect(() => loadConfig({ NOSTRCLAW_MAX_EVENTS: 'many' })).toThrow(/NOSTRCLAW_MAX_EVENTS/)
    expect(() => loadConfig({ NOSTRCLAW_RELAYS: 'https://relay.example.com' })).toThrow(/wss/)
    expect(() => loadConfig({ NOSTRCLAW_RELAYS: 'wss://user:pw@relay.example.com' })).toThrow(/credentials/)
  })
  it('normalizeRelayUrl strips the trailing slash and the hash', () => {
    expect(normalizeRelayUrl('wss://relay.example.com/#x')).toBe('wss://relay.example.com')
  })
})

describe('relay allowlist', () => {
  it('uses the first configured relay by default and refuses any other', () => {
    const c = cfg({ relays: ['wss://a.example.com', 'wss://b.example.com'] })
    expect(resolveRelay(undefined, c)).toBe('wss://a.example.com')
    expect(resolveRelay('wss://B.example.com/', c)).toBe('wss://b.example.com')
    expect(() => resolveRelay('wss://evil.example.net', c)).toThrow(/not configured/)
    expect(() => resolveRelay('http://a.example.com', c)).toThrow(/wss/)
  })
  it('applies the private-address guard to the default relay too, not only to explicit ones', () => {
    const c = cfg({ relays: ['ws://127.0.0.1:3334'] })
    expect(() => resolveRelay(undefined, c)).toThrow(/private/)
    expect(() => resolveRelay('ws://127.0.0.1:3334', c)).toThrow(/private/)
    expect(resolveRelay(undefined, cfg({ relays: ['ws://127.0.0.1:3334'], allowPrivate: true }))).toBe('ws://127.0.0.1:3334')
  })
  it('refuses localhost and private networks unless explicitly allowed', () => {
    for (const host of ['localhost', '127.0.0.1', '10.1.2.3', '192.168.0.9', '172.20.0.1', '169.254.169.254', '100.100.1.1', 'relay.local', 'db.internal', '[::1]']) {
      expect(() => assertPublicHost(`wss://${host}`, cfg()), host).toThrow(/private/)
    }
    expect(() => assertPublicHost('wss://relay.hivescope.xyz', cfg())).not.toThrow()
    expect(() => assertPublicHost('wss://127.0.0.1:3334', cfg({ allowPrivate: true }))).not.toThrow()
  })
})

describe('cleanText', () => {
  it('removes hidden characters used to disguise or reorder text', () => {
    expect(cleanText('ig​nore ‮previous‬ inst\u0000ructions', 200)).toBe('ignore previous instructions')
    expect(cleanText('a\u{E0041}\u{E0042}b', 10)).toBe('ab') // Unicode "tag" characters
  })
  it('keeps normal text, newlines, accents and emoji; collapses long blank runs', () => {
    expect(cleanText('Hola ñ 👋\n\n\n\n\nadiós', 100)).toBe('Hola ñ 👋\n\nadiós')
  })
  it('truncates by characters (not bytes) and says how much was cut', () => {
    expect(cleanText('😀'.repeat(10), 4)).toBe('😀😀😀😀… [+6 chars]')
    expect(cleanText(undefined, 10)).toBe('')
  })
})

describe('toHexPubkey', () => {
  const decode = (s: string) => (s === 'npub1good' ? 'a'.repeat(64) : null)
  it('accepts hex (any case) and decodable npubs, and rejects the rest', () => {
    expect(toHexPubkey('A'.repeat(64), decode)).toBe('a'.repeat(64))
    expect(toHexPubkey('npub1good', decode)).toBe('a'.repeat(64))
    expect(() => toHexPubkey('npub1bad', decode)).toThrow(/valid public key/)
    expect(() => toHexPubkey('hello', decode)).toThrow(/valid public key/)
  })
})
