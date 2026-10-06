import { describe, expect, it } from 'vitest'
import { compareSamples } from '../src/compare.js'
import { ev, key } from './helpers.js'

const NOW = 1_800_000_000
const HOUR = 3600
const k = key()
const note = (t: number, text = String(t)) => ev(k, 1, text, t)

describe('compareSamples', () => {
  it('measures how much of each relay is also on the others, and what is only there', () => {
    const [a, b, c, d] = [note(NOW - 10), note(NOW - 20), note(NOW - 30), note(NOW - 40)]
    const r = compareSamples([
      { relay: 'wss://one', events: [a, b, c], truncated: false },
      { relay: 'wss://two', events: [a, b, d], truncated: false },
    ], NOW - HOUR, NOW)
    expect(r.perRelay[0]).toMatchObject({ relay: 'wss://one', inWindow: 3, alsoElsewhere: 2, onlyHere: 1 })
    expect(r.perRelay[0]!.sharedFraction).toBeCloseTo(2 / 3)
    expect(r.perRelay[1]).toMatchObject({ inWindow: 3, alsoElsewhere: 2, onlyHere: 1 })
    expect(r).toMatchObject({ distinctEvents: 4, onEveryRelay: 2, shortened: false, windowHours: 1 })
  })

  it('shortens the window to what the busiest truncated sample really covers, so a busy relay is not compared with a quiet one unfairly', () => {
    // relay "busy" has events every 10 s but its sample stopped at the newest 5 (it reaches back only 50 s); "quiet" holds the same ones plus older ones
    const recent = Array.from({ length: 5 }, (_, i) => note(NOW - 10 * (i + 1), `r${i}`))
    const older = Array.from({ length: 4 }, (_, i) => note(NOW - 1000 - i * 100, `o${i}`))
    const r = compareSamples([
      { relay: 'wss://busy', events: recent, truncated: true },
      { relay: 'wss://quiet', events: [...recent, ...older], truncated: false },
    ], NOW - HOUR, NOW)
    expect(r.shortened).toBe(true)
    expect(r.windowStart).toBe(NOW - 50)
    expect(r.perRelay.map((x) => [x.inWindow, x.onlyHere])).toEqual([[5, 0], [5, 0]]) // the older events are outside the common window, not "only on quiet"
    expect(r.perRelay[0]!.sharedFraction).toBe(1)
  })

  it('ignores ephemeral kinds (relays do not store them) and events older than the requested window', () => {
    const eph = ev(k, 20001, 'x', NOW - 5), old = note(NOW - 5 * HOUR), fresh = note(NOW - 5)
    const r = compareSamples([{ relay: 'wss://one', events: [eph, old, fresh], truncated: false }], NOW - HOUR, NOW)
    expect(r.perRelay[0]).toMatchObject({ inWindow: 1 })
    expect(r.perRelay[0]!.sharedFraction).toBeUndefined() // nothing to compare with
  })

  it('handles an empty relay without dividing by zero', () => {
    const r = compareSamples([{ relay: 'wss://a', events: [], truncated: false }, { relay: 'wss://b', events: [note(NOW - 5)], truncated: false }], NOW - HOUR, NOW)
    expect(r.perRelay[0]).toMatchObject({ inWindow: 0, onlyHere: 0 }); expect(r.perRelay[0]!.sharedFraction).toBeUndefined()
    expect(r.perRelay[1]).toMatchObject({ inWindow: 1, onlyHere: 1, sharedFraction: 0 })
  })
})
