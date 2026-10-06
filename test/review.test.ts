import { describe, expect, it } from 'vitest'
import { behaviourOf, judge, REVIEW, VERDICT_ORDER, type Behaviour } from '../src/review.js'
import { ev, key } from './helpers.js'

const NOW = 1_800_000_000
const k = key()
const victim = key()
const unknown = { score: 0, level: 'unknown' as const }
const some = { score: 55, level: 'some' as const }
const established = { score: 80, level: 'established' as const }
const base: Behaviour = { events: 20, notes: 20, linkFraction: 0, maxRepeats: 0, burstEvents: 1, repliesToOthers: 0, linkedReplies: 0, replyRepeats: 0 }
const answer = (text: string, t: number) => ev(k, 1, text, t, [['e', 'ab'.repeat(32)], ['p', victim.pk]])

describe('behaviourOf', () => {
  it('measures links, repeated distinctive text (near-copies included) and bursts, ignoring short greetings', () => {
    const spam = Array.from({ length: 12 }, (_, i) => ev(k, 1, `Join my free group for daily signals today https://t.example/${i}`, NOW - i * 3))
    const greetings = [ev(k, 1, 'gm', NOW - 500), ev(k, 1, 'gm', NOW - 600), ev(k, 1, 'gm', NOW - 700)]
    const b = behaviourOf([...spam, ...greetings])
    expect(b).toMatchObject({ events: 15, notes: 15, maxRepeats: 12, burstEvents: 12, repliesToOthers: 0 })
    expect(b.linkFraction).toBeCloseTo(12 / 15)
  })
  it('counts as answers to others only the notes that answer SOMEONE ELSE, with their links and repeats', () => {
    const own = ev(k, 1, 'my own follow-up thread note', NOW - 10, [['e', 'cd'.repeat(32)], ['p', k.pk]]) // a reply to itself
    const promos = Array.from({ length: 4 }, (_, i) => answer(`Try our free signals group today https://t.example/${i}`, NOW - 100 - i * 500))
    const plain = answer('thanks for sharing this', NOW - 20)
    const b = behaviourOf([own, ...promos, plain])
    expect(b).toMatchObject({ repliesToOthers: 5, linkedReplies: 4, replyRepeats: 4 })
  })
  it('a person with varied notes shows nothing', () => {
    const b = behaviourOf(['good morning everyone', 'reading about relays tonight', 'what a lovely sunset today', 'anyone tried the new client'].map((t, i) => ev(k, 1, t, NOW - i * 4000)))
    expect(b).toMatchObject({ maxRepeats: 0, burstEvents: 1, linkFraction: 0, repliesToOthers: 0 })
  })
  it('handles a key with no events', () => {
    expect(behaviourOf([])).toEqual({ events: 0, notes: 0, linkFraction: 0, maxRepeats: 0, burstEvents: 0, repliesToOthers: 0, linkedReplies: 0, replyRepeats: 0 })
  })
})

describe('judge', () => {
  it('answering strangers with the same advert is a promotional bot, even when the network somewhat vouches for it', () => {
    const j = judge({ ...base, notes: 100, events: 100, linkFraction: 0.67, maxRepeats: 31, repliesToOthers: 90, linkedReplies: 80, replyRepeats: 31 }, some)
    expect(j.verdict).toBe('promotional-bot')
    expect(j.reasons.join(' ')).toMatch(/same text 31 times.*80 of its 90 answers to other people carry a link/)
  })
  it('a bot that publishes its own periodic reports in bulk is "automated", not promotional, and says so', () => {
    // the real case: 191 notes, a 138-event burst and a weekly leaderboard posted 4 times — none of it aimed at strangers
    const j = judge({ ...base, notes: 191, events: 200, linkFraction: 0.15, maxRepeats: 4, burstEvents: 138 }, established)
    expect(j.verdict).toBe('automated')
    expect(j.reasons.join(' ')).toMatch(/same text 4 times.*138 events within a minute.*does not answer other people/)
  })
  it('links in answers to others count only from three and only when they are at least half of the answers', () => {
    expect(judge({ ...base, repliesToOthers: 40, linkedReplies: 2 }, unknown).verdict).toBe('unknown')
    expect(judge({ ...base, repliesToOthers: 40, linkedReplies: 5 }, unknown).verdict).toBe('unknown') // a few links among many ordinary answers: a person
    expect(judge({ ...base, repliesToOthers: 6, linkedReplies: 4 }, unknown).verdict).toBe('promotional-bot')
  })
  it('the same text in answers to others is promotional from three times', () => {
    expect(judge({ ...base, repliesToOthers: 3, replyRepeats: REVIEW.promoReplies }, unknown).verdict).toBe('promotional-bot')
    expect(judge({ ...base, repliesToOthers: 3, replyRepeats: 2 }, unknown).verdict).toBe('unknown')
  })
  it('a repeated text alone is suspicious in a small account, automated in a big or link-heavy one', () => {
    expect(judge({ ...base, notes: 4, events: 4, maxRepeats: REVIEW.repeats }, unknown).verdict).toBe('suspicious')
    expect(judge({ ...base, notes: 30, events: 30, maxRepeats: 3 }, unknown).verdict).toBe('automated')
    expect(judge({ ...base, notes: 4, events: 4, maxRepeats: 10 }, unknown).verdict).toBe('automated')
  })
  it('links with few notes do not count, many links alone are only suspicious, a burst alone in a small account is suspicious', () => {
    expect(judge({ ...base, notes: 3, events: 3, linkFraction: 1 }, unknown).verdict).toBe('unknown')
    expect(judge({ ...base, notes: 20, linkFraction: 0.9 }, unknown).verdict).toBe('suspicious')
    expect(judge({ ...base, notes: 4, events: 15, burstEvents: 15 }, unknown)).toMatchObject({ verdict: 'suspicious', reasons: ['15 events within a minute'] })
  })
  it('established needs trust AND a clean behaviour; trust never cancels a bot signal', () => {
    expect(judge(base, established).verdict).toBe('established')
    expect(judge({ ...base, repliesToOthers: 9, linkedReplies: 9, replyRepeats: 9 }, established).verdict).toBe('promotional-bot')
    expect(judge(base, unknown).verdict).toBe('unknown')
  })
  it('lists the worst first', () => {
    expect(Object.entries(VERDICT_ORDER).sort((a, b) => a[1] - b[1]).map(([v]) => v)).toEqual(['promotional-bot', 'automated', 'suspicious', 'unknown', 'established'])
  })
})
