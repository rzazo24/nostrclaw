import { describe, expect, it } from 'vitest'
import { coverage, eventsPerHour } from '../src/compare.js'
import { ev, key } from './helpers.js'

const NOW = 1_800_000_000
const k = key()
const note = (t: number, text = String(t)) => ev(k, 1, text, t)

describe('eventsPerHour', () => {
  it('a complete sample divides by the whole window', () => {
    expect(eventsPerHour([note(NOW - 10), note(NOW - 20), note(NOW - 30)], false, NOW - 3600, NOW)).toBe(3)
    expect(eventsPerHour([], false, NOW - 7200, NOW)).toBe(0)
  })
  it('a truncated sample uses the span it really returned, so a busy relay is not read as quiet nor absurdly fast', () => {
    const newest300 = Array.from({ length: 300 }, (_, i) => note(NOW - i)) // 300 events in 299 s
    expect(eventsPerHour(newest300, true, NOW - 86400, NOW)).toBeCloseTo((299 / 299) * 3600, 0)
    expect(eventsPerHour([note(NOW)], true, NOW - 3600, NOW)).toBeUndefined()
  })
  it('ignores ephemeral kinds', () => {
    expect(eventsPerHour([ev(k, 20001, 'x', NOW - 1), note(NOW - 2)], false, NOW - 3600, NOW)).toBe(1)
  })
})

describe('coverage', () => {
  it('counts how many of the reference events each relay holds', () => {
    const [a, b, c, d] = [note(NOW - 1), note(NOW - 2), note(NOW - 3), note(NOW - 4)]
    const r = coverage([a, b, c, d], new Map([['wss://x', new Set([a.id, b.id, c.id])], ['wss://y', new Set([a.id])], ['wss://z', new Set<string>()]]))
    expect(r.map((x) => [x.relay, x.found, x.checked])).toEqual([['wss://x', 3, 4], ['wss://y', 1, 4], ['wss://z', 0, 4]])
    expect(r[0]!.fraction).toBe(0.75); expect(r[2]!.fraction).toBe(0)
  })
  it('marks a failed lookup as incomplete instead of reporting 0 %, and an unfinished one too', () => {
    const a = note(NOW - 1)
    const r = coverage([a], new Map([['wss://down', undefined], ['wss://slow', new Set<string>()]]), new Map([['wss://slow', false]]))
    expect(r[0]).toMatchObject({ found: 0, incomplete: true }); expect(r[0]!.fraction).toBeUndefined()
    expect(r[1]).toMatchObject({ fraction: 0, incomplete: true })
  })
  it('ignores ephemeral events and an empty reference', () => {
    expect(coverage([ev(k, 20001, 'x', NOW)], new Map([['wss://x', new Set<string>()]]))[0]).toMatchObject({ checked: 0 })
    expect(coverage([], new Map([['wss://x', new Set<string>()]]))[0]!.fraction).toBeUndefined()
  })
})
