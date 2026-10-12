// A web-of-trust style score for keys, from what the relays hold about who follows whom and who interacts with whom. Pure functions.
//
// What it is NOT: a verdict, an identity check, or manipulation-proof. Anyone can create keys that follow each other: measured on real accounts
// (2026-10-12), counting followers, "established" followers and engagers rated 13 of 15 spam accounts "some" — bot rings inflate exactly those. So
// the LEVEL now comes only from the trusted keys' network (who the trusted keys are, who they follow, and how many of those follow or MUTE this key);
// the rest only fine-tunes the number. "unknown" means "nothing in the trusted keys' network vouches for it", never "bad". Same rules as Quill.
import type { Event } from 'nostr-tools'

export type TrustLevel = 'established' | 'some' | 'unknown'

export interface TrustFacts {
  /** Distinct keys whose (newest seen) follow list includes this one. A lower bound: relays hold partial data. */
  followers: number
  /** Of those, how many are themselves followed by at least `ESTABLISHED_FOLLOWERS` keys. */
  establishedFollowers: number
  /** 0 = it IS a trusted key, 1 = a trusted key follows it, undefined = neither / no trusted keys given. */
  seedDistance?: 0 | 1
  /** How many of the keys the trusted keys follow ("the network") follow it. */
  networkFollowers: number
  /** How many keys of the network have it in their (public, newest) mute list. */
  mutedByNetwork: number
  /** Distinct OTHER keys that replied to, reacted to, reposted or mentioned it. */
  engagers: number
  /** Unix time of the oldest event seen from it (only the newest few hundred are read, so this is the oldest of those). */
  oldestSeen?: number
  hasProfile: boolean
  now: number
}

export const ESTABLISHED_FOLLOWERS = 3
export const DAY = 86400

/** The weights, in one place so the documentation and the tests can quote them. Quill uses the same (src/data/trust.ts there): change both or neither. */
export const TRUST_WEIGHTS = {
  isTrusted: 60, followedByTrusted: 40,
  network1: 25, network3: 32, network10: 40,
  followers1: 2, followers5: 5, followers20: 8,
  established1: 4, established5: 8, established15: 12,
  engagers1: 4, engagers3: 8,
  seenOver7Days: 4, seenOver30Days: 8, hasProfile: 4,
  mutedBy1: -15, mutedBy3: -30, mutedBy5: -50,
} as const

export interface TrustScore { score: number; level: TrustLevel; reasons: string[] }

export function scoreTrust(f: TrustFacts): TrustScore {
  const W = TRUST_WEIGHTS
  const reasons: string[] = []
  let score = 0
  const add = (points: number, why: string) => { score += points; reasons.push(`${points >= 0 ? '+' : ''}${points} ${why}`) }
  if (f.seedDistance === 0) add(W.isTrusted, 'is one of the trusted keys you gave')
  else if (f.seedDistance === 1) add(W.followedByTrusted, 'a trusted key follows it')
  const k = f.networkFollowers
  const kWhy = `${k} key${k === 1 ? '' : 's'} that a trusted key follows ${k === 1 ? 'follows' : 'follow'} it`
  if (k >= 10) add(W.network10, kWhy); else if (k >= 3) add(W.network3, kWhy); else if (k >= 1) add(W.network1, kWhy)
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
  const m = f.mutedByNetwork
  const mWhy = `muted by ${m} key${m === 1 ? '' : 's'} that a trusted key follows`
  if (m >= 5) add(W.mutedBy5, mWhy); else if (m >= 3) add(W.mutedBy3, mWhy); else if (m >= 1) add(W.mutedBy1, mWhy)
  score = Math.max(0, Math.min(100, score))
  let level: TrustLevel = f.seedDistance !== undefined || k >= 3 ? 'established' : k >= 1 ? 'some' : 'unknown'
  if (m >= 5) level = 'unknown'; else if (m >= 3) level = level === 'established' ? 'some' : 'unknown'
  return { score, level, reasons }
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
