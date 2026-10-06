// Judging the people who interact with a note: what a key DOES (repeated text, links, bursts, and above all what it says to OTHER people) together with
// what the network says about it (trust). The two measure different things: a spam bot can be followed by other bots and look "somewhat trusted"; what gives
// it away is its behaviour. And "automated" is not "promotional": a bot that publishes its own periodic reports or just reacts is not the same as one that
// answers strangers with the same advert and a link. Pure functions; third-party text never appears in the reasons.
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
  /** Notes that answer someone else's note (an `e` tag plus a `p` tag naming another key): what the key says to other people. */
  repliesToOthers: number
  /** Of those, how many carry a link. */
  linkedReplies: number
  /** The most times one distinctive text was posted among those replies. */
  replyRepeats: number
  /** How many DIFFERENT people received that most repeated text (the same answer to one person is a conversation; to many strangers it is a campaign). */
  replyRepeatTargets: number
}

export function behaviourOf(events: Event[]): Behaviour {
  const notes = events.filter((e) => e.kind === 1)
  const withLinks = notes.filter((e) => LINK.test(e.content)).length
  const repeated = (es: Event[]) => clusterTexts(es).filter((c) => isDistinctive(c) && c.events >= 2)
  const repeatsOf = (es: Event[]) => Math.max(0, ...repeated(es).map((c) => c.events))
  const targetOf = (e: Event) => e.tags.find((t) => t[0] === 'p' && t[1] && t[1] !== e.pubkey)?.[1]
  const replies = notes.filter((e) => e.tags.some((t) => t[0] === 'e') && targetOf(e) !== undefined)
  const byId = new Map(replies.map((e) => [e.id, e]))
  const top = repeated(replies).sort((x, y) => y.events - x.events)[0]
  const replyRepeatTargets = top ? new Set(top.eventIds.map((id) => targetOf(byId.get(id)!))).size : 0
  return {
    events: events.length, notes: notes.length, linkFraction: notes.length ? withLinks / notes.length : 0, maxRepeats: repeatsOf(notes),
    burstEvents: events.length ? burstOf(events.map((e) => e.created_at), 60).events : 0,
    repliesToOthers: replies.length, linkedReplies: replies.filter((e) => LINK.test(e.content)).length, replyRepeats: repeatsOf(replies), replyRepeatTargets,
  }
}

export type Verdict = 'promotional-bot' | 'automated' | 'suspicious' | 'established' | 'unknown'

export interface Judgement { verdict: Verdict; reasons: string[] }

/** The thresholds, in one place so the documentation and the tests can quote them. */
export const REVIEW = { repeats: 3, bigRepeats: 10, linkFraction: 0.6, minNotesForLinks: 5, bigNotes: 10, burst: 10, promoRepeats: 5, promoTargets: 3, promoReplies: 3, promoLinkShare: 0.5 } as const

export function judge(b: Behaviour, trust: { score: number; level: 'established' | 'some' | 'unknown' }): Judgement {
  const reasons: string[] = []
  const repeats = b.maxRepeats >= REVIEW.repeats
  const links = b.notes >= REVIEW.minNotesForLinks && b.linkFraction >= REVIEW.linkFraction
  const burst = b.burstEvents >= REVIEW.burst
  const sameAdvert = b.replyRepeats >= REVIEW.promoRepeats && b.replyRepeatTargets >= REVIEW.promoTargets
  const promoReplies = sameAdvert || (b.linkedReplies >= REVIEW.promoReplies && b.linkedReplies >= b.repliesToOthers * REVIEW.promoLinkShare)

  // what it says to OTHER people decides "promotional": unsolicited, repeated, or full of links
  if (promoReplies) {
    if (sameAdvert) reasons.push(`answered ${b.replyRepeatTargets} different people with the same text, ${b.replyRepeats} times`)
    if (b.linkedReplies >= REVIEW.promoReplies) reasons.push(`${b.linkedReplies} of its ${b.repliesToOthers} answers to other people carry a link`)
    return { verdict: 'promotional-bot', reasons }
  }
  if (repeats) reasons.push(`posted the same text ${b.maxRepeats} times`)
  if (links) reasons.push(`${Math.round(b.linkFraction * 100)}% of its ${b.notes} notes carry a link`)
  if (burst) reasons.push(`${b.burstEvents} events within a minute`)
  // automated but not promotional: it repeats itself or posts in bulk, yet is not pushing the same advert at strangers
  if ((repeats && (links || b.notes >= REVIEW.bigNotes || b.maxRepeats >= REVIEW.bigRepeats)) || (burst && b.notes >= REVIEW.bigNotes)) {
    return { verdict: 'automated', reasons: [...reasons, 'it does not answer other people with the same text or links'] }
  }
  if (repeats || links || burst) return { verdict: 'suspicious', reasons }
  if (trust.level === 'established') return { verdict: 'established', reasons: [`trust ${trust.score}/100 and nothing in its behaviour stands out`] }
  return { verdict: 'unknown', reasons: ['nothing in its behaviour stands out, and nothing vouches for it either'] }
}

/** Worst first, for listing. */
export const VERDICT_ORDER: Record<Verdict, number> = { 'promotional-bot': 0, automated: 1, suspicious: 2, unknown: 3, established: 4 }
