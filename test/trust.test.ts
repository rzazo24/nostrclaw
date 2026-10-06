import { describe, expect, it } from 'vitest'
import { engagersOf, followedBySeeds, followersOf, newestPerAuthor, scoreTrust, TRUST_WEIGHTS as W, type TrustFacts } from '../src/trust.js'
import { ev, key } from './helpers.js'

const NOW = 1_800_000_000
const base: TrustFacts = { followers: 0, establishedFollowers: 0, engagers: 0, hasProfile: false, now: NOW }
const follows = (k: ReturnType<typeof key>, who: string[], t = NOW - 100) => ev(k, 3, '', t, who.map((p) => ['p', p]))

describe('scoreTrust', () => {
  it('a key nothing vouches for is "unknown" with a score of 0', () => {
    expect(scoreTrust(base)).toEqual({ score: 0, level: 'unknown', reasons: [] })
  })
  it('closeness to a trusted key weighs most, and every point has its reason', () => {
    const r = scoreTrust({ ...base, seedDistance: 1, followers: 6, establishedFollowers: 2, engagers: 4, oldestSeen: NOW - 40 * 86400, hasProfile: true })
    expect(r.score).toBe(W.followedByTrusted + W.followers5 + W.established1 + W.engagers3 + W.seenOver30Days + W.hasProfile)
    expect(r.level).toBe('established')
    expect(r.reasons).toHaveLength(6); expect(r.reasons[0]).toMatch(/^\+40 a trusted key follows it/)
  })
  it('followers that are not themselves followed barely count: a ring of throw-away keys stays "unknown"', () => {
    const r = scoreTrust({ ...base, followers: 30, establishedFollowers: 0 })
    expect(r.score).toBe(W.followers20); expect(r.level).toBe('unknown')
  })
  it('is capped at 100 and the levels have thresholds', () => {
    expect(scoreTrust({ ...base, seedDistance: 0, followers: 99, establishedFollowers: 99, engagers: 99, oldestSeen: 0, hasProfile: true }).score).toBe(100)
    expect(scoreTrust({ ...base, followers: 5, engagers: 1, establishedFollowers: 1, hasProfile: true }).level).toBe('some') // 10+5+5+5 = 25
    expect(scoreTrust({ ...base, followers: 5 }).level).toBe('unknown')
  })
  it('a week of presence is worth less than a month', () => {
    expect(scoreTrust({ ...base, oldestSeen: NOW - 8 * 86400 }).score).toBe(W.seenOver7Days)
    expect(scoreTrust({ ...base, oldestSeen: NOW - 2 * 86400 }).score).toBe(0)
  })
})

describe('graph helpers', () => {
  it('followersOf uses only each author\'s NEWEST follow list (an old one that included the key no longer counts) and ignores self-follows', () => {
    const [target, a, b, c] = [key(), key(), key(), key()]
    const events = [follows(a, [target.pk], NOW - 1000), follows(a, [], NOW - 10), follows(b, [target.pk]), follows(c, [target.pk, c.pk]), follows(target, [target.pk])]
    expect([...followersOf(events, [target.pk]).get(target.pk)!].sort()).toEqual([b.pk, c.pk].sort())
  })
  it('newestPerAuthor breaks ties by lower id', () => {
    const k = key(), x = ev(k, 3, 'a', NOW), y = ev(k, 3, 'b', NOW)
    expect(newestPerAuthor([x, y]).get(k.pk)!.id).toBe([x.id, y.id].sort()[0])
  })
  it('followedBySeeds reads only the seeds\' lists', () => {
    const [seed, other, t1, t2] = [key(), key(), key(), key()]
    const set = followedBySeeds([follows(seed, [t1.pk]), follows(other, [t2.pk])], [seed.pk])
    expect([...set]).toEqual([t1.pk])
  })
  it('engagersOf counts distinct OTHER keys that replied, reacted, reposted or mentioned it', () => {
    const [t, a, b] = [key(), key(), key()]
    const events = [ev(a, 7, '+', NOW, [['p', t.pk]]), ev(a, 1, 'again', NOW, [['p', t.pk]]), ev(b, 6, '', NOW, [['p', t.pk]]), ev(t, 1, 'me', NOW, [['p', t.pk]]), ev(b, 4, 'dm', NOW, [['p', t.pk]])]
    expect(engagersOf(events, t.pk)).toBe(2) // not itself, not kind 4
  })
})
