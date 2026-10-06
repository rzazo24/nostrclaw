// Comparing relays. Pure functions: the tools fetch, this decides.
//
// Lesson from the real network: each relay returns its NEWEST N events, so a busy public relay's sample spans seconds while a small one's spans
// days. Comparing the samples directly (or even over a "common window") says nothing. So overlap is measured the other way round: take the
// recent events of ONE reference relay and ask every other relay for those exact ids. That answers "did what this relay holds reach the others?"
// without needing the windows to match.
import type { Event } from 'nostr-tools'

/** Is this kind stored by relays? Ephemeral events (20000-29999) are only relayed, so they say nothing about what a relay holds. */
export const isStoredKind = (k: number): boolean => k < 20000 || k >= 30000

/**
 * Events per hour from a sample. A complete sample covers the whole window; a truncated one (the relay's newest N) only covers the span it
 * actually returned, so the rate comes from that span. Returns undefined when it cannot be known (fewer than 2 events and truncated).
 */
export function eventsPerHour(events: Event[], truncated: boolean, since: number, now: number): number | undefined {
  const stored = events.filter((e) => isStoredKind(e.kind))
  if (!truncated) return Math.round((stored.length / Math.max((now - since) / 3600, 1 / 3600)) * 10) / 10
  if (stored.length < 2) return undefined
  const ts = stored.map((e) => e.created_at)
  const span = Math.max(Math.max(...ts) - Math.min(...ts), 1)
  return Math.round(((stored.length - 1) / (span / 3600)) * 10) / 10
}

export interface Coverage {
  relay: string
  /** How many of the reference's events were looked for here. */
  checked: number
  found: number
  fraction?: number
  /** True when the lookup could not be completed (error, or the relay did not finish answering). */
  incomplete?: boolean
}

/** What share of the reference's events each other relay holds. `held` is the set of reference ids found on that relay (undefined = lookup failed). */
export function coverage(reference: Event[], held: Map<string, Set<string> | undefined>, complete: Map<string, boolean> = new Map()): Coverage[] {
  const ids = [...new Set(reference.filter((e) => isStoredKind(e.kind)).map((e) => e.id))]
  return [...held.entries()].map(([relay, set]) => {
    if (!set) return { relay, checked: ids.length, found: 0, incomplete: true }
    const found = ids.filter((id) => set.has(id)).length
    return { relay, checked: ids.length, found, fraction: ids.length ? found / ids.length : undefined, incomplete: complete.get(relay) === false || undefined }
  })
}
