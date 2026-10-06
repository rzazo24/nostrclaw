// Judging the people who interact with a note: what a key DOES (repeated text, links, bursts) together with what the network says about it (trust).
// The two measure different things. A spam bot can be followed by other bots and look "somewhat trusted"; what gives it away is its behaviour.
// Pure functions: the tool fetches, this decides. Third-party text never appears in the reasons.
import type { Event } from 'nostr-tools'
import { burstOf } from './bursts.js'
import { clusterTexts, isDistinctive } from './text.js'

const LINK = /https?:\/\/|www\./i

export interface Behaviour {
  /** Events looked at (the newest the relays returned for this key). */
  events: number
  /** Of those, kind-1 notes. */
  notes: number
  /** Share of the notes that carry a link (0..1). */
  linkFraction: number
  /** The most times one distinctive text (3+ words or a link) was posted by this key, near-copies included. */
  maxRepeats: number
  /** The most events inside any 60 seconds. */
  burstEvents: number
}

export function behaviourOf(events: Event[]): Behaviour {
  const notes = events.filter((e) => e.kind === 1)
  const withLinks = notes.filter((e) => LINK.test(e.content)).length
  const maxRepeats = Math.max(0, ...clusterTexts(notes).filter((c) => isDistinctive(c) && c.events >= 2).map((c) => c.events))
  return {
    events: events.length, notes: notes.length, linkFraction: notes.length ? withLinks / notes.length : 0, maxRepeats,
    burstEvents: events.length ? burstOf(events.map((e) => e.created_at), 60).events : 0,
  }
}

export type Verdict = 'likely-bot' | 'suspicious' | 'established' | 'unknown'

export interface Judgement { verdict: Verdict; reasons: string[] }

/** The thresholds, in one place so the documentation and the tests can quote them. */
export const REVIEW = { repeats: 3, bigRepeats: 10, linkFraction: 0.6, minNotesForLinks: 5, bigNotes: 10, burst: 10 } as const

export function judge(b: Behaviour, trust: { score: number; level: 'established' | 'some' | 'unknown' }): Judgement {
  const reasons: string[] = []
  const repeats = b.maxRepeats >= REVIEW.repeats
  const links = b.notes >= REVIEW.minNotesForLinks && b.linkFraction >= REVIEW.linkFraction
  const burst = b.burstEvents >= REVIEW.burst
  if (repeats) reasons.push(`posted the same text ${b.maxRepeats} times`)
  if (links) reasons.push(`${Math.round(b.linkFraction * 100)}% of its ${b.notes} notes carry a link`)
  if (burst) reasons.push(`${b.burstEvents} events within a minute`)
  if (repeats && (links || b.notes >= REVIEW.bigNotes || b.maxRepeats >= REVIEW.bigRepeats)) return { verdict: 'likely-bot', reasons }
  if (repeats || links || burst) return { verdict: 'suspicious', reasons }
  if (trust.level === 'established') return { verdict: 'established', reasons: [`trust ${trust.score}/100 and nothing in its behaviour stands out`] }
  return { verdict: 'unknown', reasons: ['nothing in its behaviour stands out, and nothing vouches for it either'] }
}

/** Worst first, for listing. */
export const VERDICT_ORDER: Record<Verdict, number> = { 'likely-bot': 0, suspicious: 1, unknown: 2, established: 3 }
