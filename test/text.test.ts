import { describe, expect, it } from 'vitest'
import { clusterTexts, normalizeText, repeated } from '../src/text.js'
import { ev, key } from './helpers.js'

const NOW = 1_800_000_000
const post = (k: ReturnType<typeof key>, text: string, i = 0) => ev(k, 1, text, NOW - i)

describe('normalizeText', () => {
  it('ignores case, punctuation, emoji, numbers and links', () => {
    expect(normalizeText('Buy NOW!!! 🔥🔥 https://spam.example/x?id=42  (50% off)')).toBe('buy now <url> # off')
    expect(normalizeText('  Hola,   ¿qué tal?  ')).toBe('hola qué tal')
  })
  it('removes hidden characters before comparing (so they cannot be used to dodge the match)', () => {
    expect(normalizeText('fr​ee b‮itcoin')).toBe(normalizeText('free bitcoin'))
  })
})

describe('clusterTexts', () => {
  it('groups exact copies from different keys', () => {
    const c = clusterTexts([post(key(), 'Azul'), post(key(), 'azul'), post(key(), 'AZUL!'), post(key(), 'verde')])
    const azul = c.find((x) => x.key === 'azul')!
    expect(azul).toMatchObject({ events: 3 }); expect(azul.authors.size).toBe(3); expect(azul.near).toBe(false)
    expect(c).toHaveLength(2)
  })
  it('groups templated spam where only a number or a link changes', () => {
    const [a, b, c] = [key(), key(), key()]
    const cl = clusterTexts([post(a, 'Win 100 sats now! https://x.example/a1'), post(b, 'Win 250 sats now! https://y.example/b2'), post(c, 'win 7 sats now https://z.example')])
    expect(cl).toHaveLength(1); expect(cl[0]!.authors.size).toBe(3)
  })
  it('groups near-copies (a word swapped) when the text is long enough, but never merges different short texts', () => {
    const [a, b] = [key(), key()]
    const near = clusterTexts([post(a, 'join my free group for daily bitcoin signals today'), post(b, 'join my free group for daily bitcoin signals now')])
    expect(near).toHaveLength(1); expect(near[0]!.near).toBe(true)
    expect(clusterTexts([post(a, 'gm'), post(b, 'gn')])).toHaveLength(2)
    expect(clusterTexts([post(a, 'the weather is nice today'), post(b, 'my cat sleeps all day long')])).toHaveLength(2)
  })
  it('ignores empty and punctuation-only texts', () => {
    expect(clusterTexts([post(key(), ''), post(key(), '!!!'), post(key(), '🔥🔥')])).toEqual([])
  })
  it('repeated(): the same text from two keys, or three times from one; not a single post', () => {
    const a = key()
    const cl = clusterTexts([post(a, 'one'), post(key(), 'two'), post(key(), 'two'), post(a, 'three'), post(a, 'three'), post(a, 'three'), post(key(), 'alone')])
    expect(repeated(cl).map((c) => c.key).sort()).toEqual(['three', 'two'])
  })
  it('keeps third-party text out of the way: the sample is cleaned and bounded', () => {
    const c = clusterTexts([post(key(), 'x‮' + 'y'.repeat(300))])
    expect(c[0]!.sample).not.toContain('‮'); expect(c[0]!.sample.length).toBeLessThan(110)
  })
})
