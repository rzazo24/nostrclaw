import { describe, expect, it } from 'vitest'
import { behaviourOf, judge, REVIEW } from '../src/review.js'
import { ev, key } from './helpers.js'

const NOW = 1_800_000_000
const k = key()
const unknown = { score: 0, level: 'unknown' as const }
const established = { score: 80, level: 'established' as const }

describe('behaviourOf', () => {
  it('measures links, repeated distinctive text (near-copies included) and bursts, ignoring short greetings', () => {
    const spam = Array.from({ length: 12 }, (_, i) => ev(k, 1, `Join my free group for daily signals today https://t.example/${i}`, NOW - i * 3))
    const greetings = [ev(k, 1, 'gm', NOW - 500), ev(k, 1, 'gm', NOW - 600), ev(k, 1, 'gm', NOW - 700)]
    const b = behaviourOf([...spam, ...greetings])
    expect(b).toMatchObject({ events: 15, notes: 15, maxRepeats: 12, burstEvents: 12 })
    expect(b.linkFraction).toBeCloseTo(12 / 15)
  })
  it('a person with varied notes shows nothing', () => {
    const b = behaviourOf(['good morning everyone', 'reading about relays tonight', 'what a lovely sunset today', 'anyone tried the new client'].map((t, i) => ev(k, 1, t, NOW - i * 4000)))
    expect(b).toMatchObject({ maxRepeats: 0, burstEvents: 1, linkFraction: 0 })
  })
  it('handles a key with no events', () => {
    expect(behaviourOf([])).toEqual({ events: 0, notes: 0, linkFraction: 0, maxRepeats: 0, burstEvents: 0 })
  })
})

describe('judge', () => {
  const base = { events: 20, notes: 20, linkFraction: 0, maxRepeats: 0, burstEvents: 1 }
  it('templated promotion with links is a likely bot, even when the network somewhat vouches for it', () => {
    const j = judge({ ...base, notes: 100, events: 100, linkFraction: 0.67, maxRepeats: 31 }, { score: 55, level: 'some' })
    expect(j.verdict).toBe('likely-bot'); expect(j.reasons.join(' ')).toMatch(/same text 31 times.*67%.*link/)
  })
  it('a repeated text alone is suspicious in a small account, but a likely bot in a big or link-heavy one', () => {
    expect(judge({ ...base, notes: 4, events: 4, maxRepeats: REVIEW.repeats }, unknown).verdict).toBe('suspicious')
    expect(judge({ ...base, notes: 30, events: 30, maxRepeats: 3 }, unknown).verdict).toBe('likely-bot')
    expect(judge({ ...base, notes: 4, events: 4, maxRepeats: 10 }, unknown).verdict).toBe('likely-bot')
  })
  it('links with few notes do not count, and many links with no repetition are only suspicious', () => {
    expect(judge({ ...base, notes: 3, events: 3, linkFraction: 1 }, unknown).verdict).toBe('unknown')
    expect(judge({ ...base, notes: 20, linkFraction: 0.9 }, unknown).verdict).toBe('suspicious')
  })
  it('a burst is suspicious on its own', () => {
    expect(judge({ ...base, burstEvents: 15 }, unknown)).toMatchObject({ verdict: 'suspicious', reasons: ['15 events within a minute'] })
  })
  it('established needs trust AND a clean behaviour; trust never cancels a bot signal', () => {
    expect(judge(base, established).verdict).toBe('established')
    expect(judge({ ...base, maxRepeats: 12, linkFraction: 0.8 }, established).verdict).toBe('likely-bot')
    expect(judge(base, unknown).verdict).toBe('unknown')
  })
})
