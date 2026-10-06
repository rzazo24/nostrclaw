import { describe, expect, it } from 'vitest'
import { levelOf, NO_FACTS, pickCandidates, triage, WEIGHTS, type AuthorFacts } from '../src/triage.js'
import { ev, key } from './helpers.js'

const NOW = 1_800_000_000
const known: AuthorFacts = { hasProfile: true, profileHasName: true, hasNip05: true, follows: 80, hasRelayList: true }

describe('triage', () => {
  it('puts a copy-pasting burst of bare keys above an established account, and explains why', () => {
    const spammer = key(), friend = key(), mule = key()
    const events = [
      ...Array.from({ length: 6 }, (_, i) => ev(spammer, 1, `Free sats https://x.example/${i}`, NOW - i * 3)),
      ev(mule, 1, 'Free sats https://y.example/q', NOW - 40),
      ev(friend, 1, 'Had a lovely morning reading about relays', NOW - 100), ev(friend, 1, 'And now a walk by the river', NOW - 5000),
    ]
    const facts = new Map([[spammer.pk, NO_FACTS], [mule.pk, NO_FACTS], [friend.pk, known]])
    const r = triage({ events, facts })
    expect(r.authors.map((a) => a.pubkey)).toEqual([spammer.pk, mule.pk]) // the established account has no behaviour signal: counted as quiet, not listed
    expect(r.quiet.count).toBe(1)
    const s = r.authors[0]!
    expect(s.level).toBe('high')
    expect(s.score).toBe(WEIGHTS.noProfile + WEIGHTS.noFollows + WEIGHTS.noRelayList + WEIGHTS.sharedText + WEIGHTS.burst + WEIGHTS.linksOnly)
    expect(s.reasons.join(' | ')).toMatch(/no profile.*no follow list.*no relay list.*also posted by other keys.*within.*link/)
    expect(s.behaviour).toBe(WEIGHTS.sharedText + WEIGHTS.burst + WEIGHTS.linksOnly)
  })

  it('missing data alone never flags anyone: a bare newcomer is only counted as quiet', () => {
    const keys = Array.from({ length: 5 }, () => key())
    const events = keys.map((k, i) => ev(k, i % 2 ? 30078 : 1, `hello number ${['one', 'two', 'three', 'four', 'five'][i]}, anyone here?`, NOW - i * 500))
    const r = triage({ events, facts: new Map(keys.map((k) => [k.pk, NO_FACTS])) })
    expect(r.authors).toEqual([])
    expect(r.byLevel).toEqual({ low: 0, medium: 0, high: 0 })
    expect(r.quiet.count).toBe(5)
    expect(r.quiet.byKind).toEqual({ '1 note': 3, '30078 app data': 2 })
    expect(r.quiet.note).toMatch(/not treated as evidence/)
  })
  it('missing data does add to the score of a key that also behaves badly', () => {
    const a = key(), b = key()
    const r = triage({ events: [ev(a, 1, 'free coins at my site today', NOW), ev(b, 1, 'free coins at my site today', NOW - 1)], facts: new Map([[a.pk, NO_FACTS], [b.pk, known]]) })
    expect(r.authors.map((x) => x.pubkey)).toEqual([a.pk, b.pk])
    expect(r.authors[0]!.score).toBeGreaterThan(r.authors[1]!.score)
  })

  it('counts levels and authors that were not examined', () => {
    const [a, b, c] = [key(), key(), key()]
    const events = [ev(a, 1, 'a', NOW), ev(b, 1, 'b', NOW), ev(c, 1, 'c', NOW)]
    const r = triage({ events, facts: new Map([[a.pk, NO_FACTS], [b.pk, known]]) })
    expect(r).toMatchObject({ examined: 2, notExamined: 1 })
    expect(r.quiet.count).toBe(2)
  })

  it('never puts third-party text in the reasons', () => {
    const a = key(), b = key()
    const events = [ev(a, 1, 'SECRET-PHRASE-ONE buy now', NOW), ev(b, 1, 'secret-phrase-one buy now', NOW - 1)]
    const r = triage({ events, facts: new Map([[a.pk, NO_FACTS], [b.pk, NO_FACTS]]) })
    expect(JSON.stringify(r.authors.map((x) => x.reasons)).toLowerCase()).not.toContain('secret-phrase')
  })

  it('levelOf thresholds', () => { expect([0, 29, 30, 59, 60, 100].map(levelOf)).toEqual(['low', 'low', 'medium', 'medium', 'high', 'high']) })
})

describe('pickCandidates', () => {
  it('spends the lookup budget on the odd ones first, not just the most talkative', () => {
    const talkative = key(), copier = key(), plain = key()
    const events = [
      ...Array.from({ length: 4 }, (_, i) => ev(talkative, 1, `distinct thought number ${['alpha', 'beta', 'gamma', 'delta'][i]} about nothing`, NOW - i * 1000)),
      ev(copier, 1, 'visit my site for free coins today', NOW), ev(plain, 1, 'visit my site for free coins today', NOW - 1),
    ]
    expect(pickCandidates(events, 2)).toEqual(expect.arrayContaining([copier.pk, plain.pk]))
    expect(pickCandidates(events, 2)).not.toContain(talkative.pk)
    expect(pickCandidates(events, 10)).toHaveLength(3)
  })
})
