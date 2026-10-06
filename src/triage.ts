// Ranking the authors of a sample by how much they look like throw-away or abusive keys. It is a TRIAGE aid, not a verdict: every point of the
// score has a plain reason attached, so a human (or the assistant) can judge it. Pure functions over events; the relay lookups happen in the tool.
import type { Event } from 'nostr-tools'
import { kindName } from './analysis.js'
import { burstOf } from './bursts.js'
import { clusterTexts } from './text.js'

/** What the relay holds about an author besides the sample (profile, follow list, relay list). */
export interface AuthorFacts {
  hasProfile: boolean
  profileHasName: boolean
  hasNip05: boolean // only that the field exists: it is NOT verified (that would mean fetching a domain chosen by a stranger)
  follows: number
  hasRelayList: boolean
}

export const NO_FACTS: AuthorFacts = { hasProfile: false, profileHasName: false, hasNip05: false, follows: 0, hasRelayList: false }

export type Level = 'low' | 'medium' | 'high'

export interface AuthorTriage {
  pubkey: string
  score: number
  level: Level
  reasons: string[]
  events: number
  kinds: Record<string, number>
  first: string
  last: string
  facts: AuthorFacts
}

/** The weights, in one place so the documentation and the tests can quote them. */
export const WEIGHTS = {
  noProfile: 25, noFollows: 15, noRelayList: 5, singleEvent: 5, sharedText: 25, burst: 15, linksOnly: 10,
  hasNip05: -15, manyFollows: -10,
} as const

const iso = (unix: number) => new Date(unix * 1000).toISOString()
const LINK = /https?:\/\/|www\./i

export const levelOf = (score: number): Level => (score >= 60 ? 'high' : score >= 30 ? 'medium' : 'low')

export interface TriageInput {
  events: Event[]
  /** Facts for the authors that were looked up. Authors missing from the map were not examined. */
  facts: Map<string, AuthorFacts>
}

export interface TriageResult {
  examined: number
  notExamined: number
  byLevel: Record<Level, number>
  authors: AuthorTriage[]
}

/** Scores every author in `facts` using the whole sample (shared text and bursts need the other authors). */
export function triage({ events, facts }: TriageInput, top = 15): TriageResult {
  const byAuthor = new Map<string, Event[]>()
  for (const e of events) byAuthor.set(e.pubkey, [...(byAuthor.get(e.pubkey) ?? []), e])

  // events whose text is shared with another key (exact or near-copy)
  const textual = events.filter((e) => e.kind === 1 || e.kind === 30023 || e.kind === 42)
  const sharedIds = new Set<string>()
  for (const c of clusterTexts(textual)) if (c.authors.size >= 2) for (const id of c.eventIds) sharedIds.add(id)

  const authors: AuthorTriage[] = []
  for (const [pubkey, f] of facts) {
    const list = byAuthor.get(pubkey)
    if (!list?.length) continue
    const reasons: string[] = []
    let score = 0
    const add = (points: number, why: string) => { score += points; reasons.push(`${points > 0 ? '+' : ''}${points} ${why}`) }

    if (!f.hasProfile) add(WEIGHTS.noProfile, 'no profile (kind 0) on this relay')
    if (f.follows === 0) add(WEIGHTS.noFollows, 'no follow list on this relay')
    if (!f.hasRelayList) add(WEIGHTS.noRelayList, 'no relay list on this relay')
    if (list.length === 1) add(WEIGHTS.singleEvent, 'a single event in the window')
    const text = list.filter((e) => textual.includes(e))
    const shared = text.filter((e) => sharedIds.has(e.id))
    if (text.length && shared.length / text.length >= 0.5) add(WEIGHTS.sharedText, `${shared.length} of ${text.length} texts are also posted by other keys`)
    const b = burstOf(list.map((e) => e.created_at), 60)
    if (b.events >= 5) add(WEIGHTS.burst, `${b.events} events within ${b.seconds} s`)
    if (text.length >= 2 && !f.hasProfile && text.filter((e) => LINK.test(e.content)).length / text.length >= 0.8) add(WEIGHTS.linksOnly, 'almost every text carries a link and there is no profile')
    if (f.hasNip05) add(WEIGHTS.hasNip05, 'the profile declares a NIP-05 identifier (not verified)')
    if (f.follows >= 20) add(WEIGHTS.manyFollows, `follows ${f.follows} keys`)

    score = Math.max(0, Math.min(100, score))
    const kinds: Record<string, number> = {}
    for (const e of list) kinds[`${e.kind} ${kindName(e.kind)}`] = (kinds[`${e.kind} ${kindName(e.kind)}`] ?? 0) + 1
    const t = list.map((e) => e.created_at)
    authors.push({ pubkey, score, level: levelOf(score), reasons, events: list.length, kinds, first: iso(Math.min(...t)), last: iso(Math.max(...t)), facts: f })
  }
  authors.sort((a, b) => b.score - a.score || b.events - a.events)
  const byLevel: Record<Level, number> = { low: 0, medium: 0, high: 0 }
  for (const a of authors) byLevel[a.level]++
  return { examined: authors.length, notExamined: byAuthor.size - authors.length, byLevel, authors: authors.slice(0, top) }
}

/**
 * Which authors are worth looking up on the relay (profile, follows, relay list): a cheap first score from the sample alone, so the
 * budget goes to the ones that look odd, not just to the most talkative. Returns at most `max` pubkeys.
 */
export function pickCandidates(events: Event[], max: number): string[] {
  const byAuthor = new Map<string, Event[]>()
  for (const e of events) byAuthor.set(e.pubkey, [...(byAuthor.get(e.pubkey) ?? []), e])
  const textual = events.filter((e) => e.kind === 1 || e.kind === 30023 || e.kind === 42)
  const shared = new Set<string>()
  for (const c of clusterTexts(textual)) if (c.authors.size >= 2) for (const id of c.eventIds) shared.add(id)
  const pre = [...byAuthor.entries()].map(([pk, list]) => {
    let s = 0
    if (list.some((e) => shared.has(e.id))) s += 40
    if (burstOf(list.map((e) => e.created_at), 60).events >= 5) s += 30
    if (list.length === 1) s += 10
    return { pk, s, n: list.length }
  })
  return pre.sort((a, b) => b.s - a.s || b.n - a.n).slice(0, max).map((x) => x.pk)
}
