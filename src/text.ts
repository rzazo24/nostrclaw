// Finding the same message posted again and again: exact copies, and near-copies (a changed number, an added emoji, a swapped word).
// Pure functions: no network. Third-party text only leaves here already cleaned and truncated.
import type { Event } from 'nostr-tools'
import { cleanText } from './safety.js'

const URL_RE = /https?:\/\/\S+|www\.\S+/gi

/** A comparison form of a text: lower case, links and numbers collapsed, punctuation and emoji dropped, spaces squeezed. */
export function normalizeText(s: string): string {
  return cleanText(s, 5000)
    .toLowerCase()
    .replace(URL_RE, ' <url> ')
    .replace(/\p{N}+/gu, '#')
    .replace(/[^\p{L}\p{M}#<>\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const tokenSet = (norm: string): Set<string> => new Set(norm.split(' ').filter(Boolean))

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter++
  return inter / (a.size + b.size - inter)
}

export interface TextCluster {
  /** Normalised text of the first member. */
  key: string
  /** A cleaned, truncated original of the first member (third-party text: keep it under "untrusted"). */
  sample: string
  events: number
  authors: Set<string>
  /** True when some members are not identical to the others (a near-copy was merged in). */
  near: boolean
  eventIds: string[]
}

export interface ClusterOptions {
  /** Texts with at least this many words can be merged with similar ones; shorter ones only match exactly. */
  minTokensForFuzzy?: number
  /** Word-overlap (Jaccard) needed to call two texts near-copies. */
  threshold?: number
  /** Most events looked at (the comparison is quadratic in the number of distinct texts). */
  maxEvents?: number
}

/** Groups events with the same or almost the same text. Empty and link-less one-character texts are ignored. */
export function clusterTexts(events: Event[], opts: ClusterOptions = {}): TextCluster[] {
  const minTokens = opts.minTokensForFuzzy ?? 4, threshold = opts.threshold ?? 0.8, maxEvents = opts.maxEvents ?? 1500
  const clusters: (TextCluster & { tokens: Set<string> })[] = []
  const exact = new Map<string, number>()
  for (const e of events.slice(0, maxEvents)) {
    const norm = normalizeText(e.content)
    if (norm.length < 1) continue
    let idx = exact.get(norm)
    if (idx === undefined) {
      const tokens = tokenSet(norm)
      if (tokens.size >= minTokens) {
        idx = clusters.findIndex((c) => c.tokens.size >= minTokens && jaccard(c.tokens, tokens) >= threshold)
        if (idx < 0) idx = undefined
        else exact.set(norm, idx) // remember this variant
      }
      if (idx === undefined) {
        clusters.push({ key: norm, sample: cleanText(e.content, 80), events: 0, authors: new Set(), near: false, eventIds: [], tokens })
        idx = clusters.length - 1
        exact.set(norm, idx)
      } else if (norm !== clusters[idx]!.key) clusters[idx]!.near = true
    }
    const c = clusters[idx]!
    c.events++; c.authors.add(e.pubkey); c.eventIds.push(e.id)
  }
  return clusters.map(({ tokens: _t, ...c }) => c)
}

/** Clusters that look like copying: the same text from at least two keys, or at least three times from one. */
export const repeated = (clusters: TextCluster[]): TextCluster[] => clusters.filter((c) => c.authors.size >= 2 || c.events >= 3)
