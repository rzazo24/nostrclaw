import { describe, expect, it } from 'vitest'
import { buildReport, kindName, parseProfile, viewEvent } from '../src/analysis.js'
import { ev, key } from './helpers.js'

const NOW = 1_800_000_000

describe('kindName', () => {
  it('names common kinds and the ranges', () => {
    expect(kindName(1)).toBe('note'); expect(kindName(7)).toBe('reaction'); expect(kindName(20001)).toBe('ephemeral')
    expect(kindName(10042)).toBe('replaceable'); expect(kindName(30999)).toBe('addressable'); expect(kindName(555)).toBe('other')
  })
})

describe('viewEvent', () => {
  it('cleans and truncates content and only keeps a few short tags', () => {
    const a = key()
    const v = viewEvent(ev(a, 1, 'hello‮ world ' + 'x'.repeat(500), NOW - 600, Array.from({ length: 20 }, (_, i) => ['t', `tag${i}`, 'z'.repeat(300)])), NOW, 50)
    expect(v.content).not.toContain('‮')
    expect(v.content.startsWith('hello world')).toBe(true)
    expect(v.content).toMatch(/… \[\+\d+ chars\]$/)
    expect(v.tags).toHaveLength(8)
    expect(v.tags[0]![2]!.length).toBeLessThanOrEqual(100)
    expect(v.ageMinutes).toBe(10)
    expect(v.kindName).toBe('note')
  })
})

describe('buildReport', () => {
  it('handles an empty sample', () => {
    const r = buildReport([])
    expect(r.sample.events).toBe(0); expect(r.signals).toEqual([])
  })

  it('counts kinds, authors and per-hour activity', () => {
    const a = key(), b = key()
    const events = [ev(a, 1, 'one', NOW), ev(a, 1, 'two', NOW - 10), ev(b, 7, '+', NOW - 3700), ev(b, 1, 'three', NOW - 7300)]
    const r = buildReport(events)
    expect(r.sample).toMatchObject({ events: 4, authors: 2 })
    expect(r.byKind[0]).toMatchObject({ kind: 1, count: 3, percent: 75 })
    expect(r.byKind[1]).toMatchObject({ kind: 7, name: 'reaction' })
    expect(r.perHour.reduce((s, h) => s + h.count, 0)).toBe(4)
    expect(r.topAuthors[0]).toMatchObject({ pubkey: a.pk, events: 2 })
  })

  it('flags the same text posted by several keys, without echoing the text in the signal', () => {
    const keys = [key(), key(), key(), key()]
    const events = keys.map((k, i) => ev(k, 1, 'Azul', NOW - i)).concat([ev(key(), 1, 'something else', NOW)])
    const r = buildReport(events)
    expect(r.repeatedText[0]).toMatchObject({ text: 'azul', events: 4, authors: 4 })
    const s = r.signals.find((x) => x.kind === 'duplicate-text')!
    expect(s.detail).toMatch(/4 events from 4 different key/)
    expect(s.detail.toLowerCase()).not.toContain('azul') // third-party text stays out of signals
  })

  it('flags a burst from one key', () => {
    const a = key()
    const events = Array.from({ length: 12 }, (_, i) => ev(a, 1, `spam ${i}`, NOW - i * 2))
    const r = buildReport(events)
    expect(r.bursts[0]).toMatchObject({ pubkey: a.pk, events: 12 })
    expect(r.signals.some((s) => s.kind === 'burst' && s.detail.includes(a.pk.slice(0, 8)))).toBe(true)
  })

  it('points out a single-kind sample, unless the caller filtered by kind', () => {
    const events = Array.from({ length: 25 }, (_, i) => ev(key(), 7, '+', NOW - i))
    expect(buildReport(events).signals.some((s) => s.kind === 'single-kind')).toBe(true)
    expect(buildReport(events, { kindsFiltered: true }).signals.some((s) => s.kind === 'single-kind')).toBe(false)
  })

  it('does not flag a calm account as a burst', () => {
    const a = key()
    const r = buildReport(Array.from({ length: 12 }, (_, i) => ev(a, 1, `note ${i}`, NOW - i * 600)))
    expect(r.bursts).toEqual([])
  })

  it('notices a crowd of single-event authors', () => {
    const events = Array.from({ length: 10 }, (_, i) => ev(key(), 1, `hi ${i}`, NOW - i))
    const r = buildReport(events)
    expect(r.authorsWithOneEvent).toEqual({ count: 10, percent: 100 })
    expect(r.signals.some((s) => s.kind === 'throwaway-keys')).toBe(true)
  })

  it('measures links and empty content on text kinds only', () => {
    const a = key()
    const r = buildReport([ev(a, 1, 'see https://example.com', NOW), ev(a, 1, '', NOW - 1), ev(a, 7, '+', NOW - 2)])
    expect(r.content).toMatchObject({ empty: 1, withLinks: 1 })
  })
})

describe('parseProfile', () => {
  it('extracts the usual fields, cleaned and bounded', () => {
    const a = key()
    const p = parseProfile(ev(a, 0, JSON.stringify({ name: 'Al​ice', display_name: 'Alice', about: 'x'.repeat(1000), nip05: 'alice@example.com', extra: 'ignored' }), NOW))
    expect(p.name).toBe('Alice'); expect(p.displayName).toBe('Alice'); expect(p.nip05).toBe('alice@example.com')
    expect(p.about!.length).toBeLessThan(330)
    expect((p as Record<string, unknown>).extra).toBeUndefined()
  })
  it('tolerates garbage', () => {
    const a = key()
    expect(parseProfile(ev(a, 0, 'not json', NOW))).toEqual({})
    expect(parseProfile(ev(a, 0, '"a string"', NOW))).toEqual({})
    expect(parseProfile(undefined)).toEqual({})
  })
})
