// Comparing what several relays hold, from samples taken at the same moment. Pure functions: the tools fetch, this decides.
//
// The one trap: each relay returns its NEWEST N events, so a busy relay's sample reaches back only minutes while a quiet one's reaches back days.
// Comparing those directly says "relay A has less" when it simply has not been asked about the same period. So the comparison is made only inside the
// window every truncated sample really covers.
import type { Event } from 'nostr-tools'

export interface RelaySample {
  relay: string
  events: Event[]
  /** The sample stopped at its limit: the relay probably has older events inside the requested window that we did not get. */
  truncated: boolean
}

export interface RelayOverlap {
  relay: string
  /** Events of this relay inside the common window. */
  inWindow: number
  /** Of those, how many were also seen on at least one other compared relay. */
  alsoElsewhere: number
  /** Seen only on this relay. */
  onlyHere: number
  /** alsoElsewhere / inWindow (0..1), undefined when there is nothing to compare. */
  sharedFraction?: number
  /** inWindow per hour of the common window. */
  eventsPerHour?: number
}

export interface Comparison {
  /** Start of the window used for every relay, unix seconds (later than requested when a sample was truncated). */
  windowStart: number
  windowHours: number
  /** True when the window had to be shortened because a sample was truncated. */
  shortened: boolean
  perRelay: RelayOverlap[]
  /** Distinct events seen on all the compared relays together, and how many of them are on every one. */
  distinctEvents: number
  onEveryRelay: number
}

/** Is this kind stored by relays? Ephemeral events (20000-29999) are only relayed, so they say nothing about what a relay holds. */
export const isStoredKind = (k: number): boolean => k < 20000 || k >= 30000

export function compareSamples(samples: RelaySample[], requestedSince: number, now: number): Comparison {
  let since = requestedSince
  for (const s of samples) {
    const stored = s.events.filter((e) => isStoredKind(e.kind))
    if (s.truncated && stored.length) since = Math.max(since, Math.min(...stored.map((e) => e.created_at)))
  }
  const idsByRelay = new Map<string, Set<string>>()
  for (const s of samples) idsByRelay.set(s.relay, new Set(s.events.filter((e) => isStoredKind(e.kind) && e.created_at >= since).map((e) => e.id)))
  const seenOn = new Map<string, number>()
  for (const ids of idsByRelay.values()) for (const id of ids) seenOn.set(id, (seenOn.get(id) ?? 0) + 1)
  const hours = Math.max((now - since) / 3600, 1 / 3600)
  const perRelay = samples.map((s): RelayOverlap => {
    const mine = idsByRelay.get(s.relay)!
    let elsewhere = 0
    for (const id of mine) if ((seenOn.get(id) ?? 0) > 1) elsewhere++
    return {
      relay: s.relay, inWindow: mine.size, alsoElsewhere: elsewhere, onlyHere: mine.size - elsewhere,
      sharedFraction: samples.length > 1 && mine.size ? elsewhere / mine.size : undefined,
      eventsPerHour: Math.round((mine.size / hours) * 10) / 10,
    }
  })
  return {
    windowStart: since, windowHours: Math.round(hours * 100) / 100, shortened: since > requestedSince, perRelay,
    distinctEvents: seenOn.size, onEveryRelay: [...seenOn.values()].filter((n) => n === samples.length).length,
  }
}
