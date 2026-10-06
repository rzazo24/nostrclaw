// A web-of-trust style score for keys, from what the relays hold about who follows whom and who interacts with whom. Pure functions.
//
// What it is NOT: a verdict, an identity check, or manipulation-proof. Anyone can create keys that follow each other; the points that are hardest
// to fake (being followed by keys that are themselves followed, and being close to keys the user trusts) weigh most. "unknown" means "nothing
// vouches for this key on these relays", never "bad".
import type { Event } from 'nostr-tools'

export type TrustLevel = 'established' | 'some' | 'unknown'

export interface TrustFacts {
  /** Distinct keys whose (newest seen) follow list includes this one. A lower bound: relays hold partial data. */
  followers: number
  /** Of those, how many are themselves followed by at least `ESTABLISHED_FOLLOWERS` keys. */
  establishedFollowers: number
  /** 0 = it IS a trusted key, 1 = a trusted key follows it, 2 = followed by someone a trusted key follows, undefined = none / no trusted keys given. */
  seedDistance?: 0 | 1 | 2
  /** Distinct OTHER keys that replied to, reacted to, reposted or mentioned it. */
  engagers: number
  /** Unix time of the oldest event seen from it (only the newest few hundred are read, so this is the oldest of those). */
  oldestSeen?: number
  hasProfile: boolean
  now: number
}

export const ESTABLISHED_FOLLOWERS = 3
export const DAY = 86400

/** The weights, in one place so the documentation and the tests can quote them. */
export const TRUST_WEIGHTS = {
  isTrusted: 60, followedByTrusted: 40, followedByFollowedByTrusted: 20,
  followers1: 5, followers5: 10, followers20: 15,
  established1: 5, established5: 10, established15: 15,
  engagers1: 5, engagers3: 10,
  seenOver7Days: 5, seenOver30Days: 10, hasProfile: 5,
} as const

export interface TrustScore { score: number; level: TrustLevel; reasons: string[] }

export function scoreTrust(f: TrustFacts): TrustScore {
  const W = TRUST_WEIGHTS
  const reasons: string[] = []
  let score = 0
  const add = (points: number, why: string) => { score += points; reasons.push(`+${points} ${why}`) }

  if (f.seedDistance === 0) add(W.isTrusted, 'is one of the trusted keys you gave')
  else if (f.seedDistance === 1) add(W.followedByTrusted, 'a trusted key follows it')
  else if (f.seedDistance === 2) add(W.followedByFollowedByTrusted, 'followed by someone a trusted key follows')

  if (f.followers >= 20) add(W.followers20, `followed by ${f.followers} keys on these relays`)
  else if (f.followers >= 5) add(W.followers5, `followed by ${f.followers} keys on these relays`)
  else if (f.followers >= 1) add(W.followers1, `followed by ${f.followers} key${f.followers > 1 ? 's' : ''} on these relays`)

  if (f.establishedFollowers >= 15) add(W.established15, `${f.establishedFollowers} of its followers are themselves followed by ${ESTABLISHED_FOLLOWERS}+ keys`)
  else if (f.establishedFollowers >= 5) add(W.established5, `${f.establishedFollowers} of its followers are themselves followed by ${ESTABLISHED_FOLLOWERS}+ keys`)
  else if (f.establishedFollowers >= 1) add(W.established1, `${f.establishedFollowers} of its followers is itself followed by ${ESTABLISHED_FOLLOWERS}+ keys`)

  if (f.engagers >= 3) add(W.engagers3, `${f.engagers} different keys replied, reacted or mentioned it`)
  else if (f.engagers >= 1) add(W.engagers1, `${f.engagers} other key replied, reacted or mentioned it`)

  const ageDays = f.oldestSeen === undefined ? undefined : (f.now - f.oldestSeen) / DAY
  if (ageDays !== undefined && ageDays >= 30) add(W.seenOver30Days, `seen on these relays for over 30 days (${Math.floor(ageDays)} d)`)
  else if (ageDays !== undefined && ageDays >= 7) add(W.seenOver7Days, `seen on these relays for over a week (${Math.floor(ageDays)} d)`)

  if (f.hasProfile) add(W.hasProfile, 'has a profile (kind 0) on these relays')

  score = Math.min(100, score)
  return { score, level: score >= 60 ? 'established' : score >= 25 ? 'some' : 'unknown', reasons }
}

/** The newest event per author (replaceable kinds: only the latest list counts). */
export function newestPerAuthor(events: Event[]): Map<string, Event> {
  const out = new Map<string, Event>()
  for (const e of events) {
    const cur = out.get(e.pubkey)
    if (!cur || e.created_at > cur.created_at || (e.created_at === cur.created_at && e.id < cur.id)) out.set(e.pubkey, e)
  }
  return out
}

const followed = (e: Event): string[] => e.tags.filter((t) => t[0] === 'p' && /^[0-9a-f]{64}$/i.test(t[1] ?? '')).map((t) => t[1]!.toLowerCase())

/** For each target, the set of keys whose newest follow list (kind 3) includes it. Self-follows do not count. */
export function followersOf(events: Event[], targets: string[]): Map<string, Set<string>> {
  const out = new Map(targets.map((t) => [t, new Set<string>()]))
  for (const [author, e] of newestPerAuthor(events.filter((x) => x.kind === 3))) {
    for (const p of followed(e)) if (p !== author) out.get(p)?.add(author)
  }
  return out
}

/** Keys followed by any of the seeds, from the seeds' newest follow lists. */
export function followedBySeeds(events: Event[], seeds: string[]): Set<string> {
  const out = new Set<string>()
  const lists = newestPerAuthor(events.filter((e) => e.kind === 3 && seeds.includes(e.pubkey)))
  for (const e of lists.values()) for (const p of followed(e)) out.add(p)
  return out
}

/** Other keys that interacted with `target`: replies, reactions, reposts or mentions (any event with a `p` tag naming it). */
export function engagersOf(events: Event[], target: string): number {
  const who = new Set<string>()
  for (const e of events) if (e.pubkey !== target && [1, 6, 7, 16].includes(e.kind) && e.tags.some((t) => t[0] === 'p' && t[1]?.toLowerCase() === target)) who.add(e.pubkey)
  return who.size
}
