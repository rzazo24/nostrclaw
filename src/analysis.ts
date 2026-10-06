// The analysis itself: pure functions over a list of events, so they are easy to test and have no network in them.
// Everything that comes from an event (content, names, tags) is cleaned before it leaves this module.
import type { Event } from 'nostr-tools'
import { cleanText } from './safety.js'
import { burstOf } from './bursts.js'
import { clusterTexts, repeated } from './text.js'

export const KIND_NAMES: Record<number, string> = {
  0: 'profile', 1: 'note', 3: 'follow list', 4: 'direct message (legacy)', 5: 'deletion', 6: 'repost', 7: 'reaction', 13: 'seal', 14: 'direct message',
  16: 'generic repost', 40: 'channel', 42: 'channel message', 1059: 'gift wrap', 1063: 'file metadata', 1984: 'report', 9734: 'zap request', 9735: 'zap',
  10000: 'mute list', 10002: 'relay list', 10050: 'DM relay list', 22242: 'relay auth', 24133: 'remote signing', 27235: 'HTTP auth',
  30000: 'people list', 30023: 'long-form article', 30078: 'app data',
}
export const kindName = (k: number): string =>
  KIND_NAMES[k] ?? (k >= 20000 && k < 30000 ? 'ephemeral' : k >= 10000 && k < 20000 ? 'replaceable' : k >= 30000 && k < 40000 ? 'addressable' : 'other')

const iso = (unix: number) => new Date(unix * 1000).toISOString()
const short = (pk: string) => `${pk.slice(0, 8)}…`
const median = (xs: number[]) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2 }

export interface EventView {
  id: string
  pubkey: string
  kind: number
  kindName: string
  createdAt: string
  ageMinutes: number
  contentLength: number
  content: string
  tags: string[][]
}

/** An event as shown to the assistant: cleaned, truncated, with only the first tags. */
export function viewEvent(e: Event, now: number, maxContent: number): EventView {
  return {
    id: e.id, pubkey: e.pubkey, kind: e.kind, kindName: kindName(e.kind), createdAt: iso(e.created_at),
    ageMinutes: Math.max(0, Math.round((now - e.created_at) / 60)),
    contentLength: [...e.content].length,
    content: cleanText(e.content, maxContent),
    tags: e.tags.slice(0, 8).map((t) => t.slice(0, 4).map((v) => cleanText(v, 80))),
  }
}

export interface Signal { kind: 'duplicate-text' | 'burst' | 'throwaway-keys' | 'single-kind'; detail: string }

export interface ActivityReport {
  sample: { events: number; authors: number; from: string; to: string; spanHours: number }
  byKind: { kind: number; name: string; count: number; percent: number }[]
  perHour: { hour: string; count: number }[]
  topAuthors: { pubkey: string; events: number; kinds: Record<string, number>; first: string; last: string }[]
  content: { empty: number; medianLength: number; withLinks: number }
  repeatedText: { text: string; events: number; authors: number; nearCopies: boolean }[]
  bursts: { pubkey: string; events: number; withinSeconds: number }[]
  authorsWithOneEvent: { count: number; percent: number }
  signals: Signal[]
}

const LINK = /https?:\/\/|www\./i

/** Builds the report for a set of events. `topN` bounds every list in it. */
export function buildReport(events: Event[], opts: { topN?: number; burstWindowSeconds?: number; burstMinEvents?: number; kindsFiltered?: boolean } = {}): ActivityReport {
  const topN = opts.topN ?? 10, window = opts.burstWindowSeconds ?? 60, burstMin = opts.burstMinEvents ?? 5
  const empty: ActivityReport = {
    sample: { events: 0, authors: 0, from: '', to: '', spanHours: 0 }, byKind: [], perHour: [], topAuthors: [],
    content: { empty: 0, medianLength: 0, withLinks: 0 }, repeatedText: [], bursts: [], authorsWithOneEvent: { count: 0, percent: 0 }, signals: [],
  }
  if (!events.length) return empty

  const times = events.map((e) => e.created_at)
  const from = Math.min(...times), to = Math.max(...times)
  const byAuthor = new Map<string, Event[]>()
  const kinds = new Map<number, number>()
  const hours = new Map<number, number>()
  for (const e of events) {
    byAuthor.set(e.pubkey, [...(byAuthor.get(e.pubkey) ?? []), e])
    kinds.set(e.kind, (kinds.get(e.kind) ?? 0) + 1)
    const h = Math.floor(e.created_at / 3600) * 3600
    hours.set(h, (hours.get(h) ?? 0) + 1)
  }

  const textual = events.filter((e) => e.kind === 1 || e.kind === 30023 || e.kind === 42)
  const lengths = textual.map((e) => [...e.content].length)

  // the same text (or a near-copy) from several keys, or many times from one: the classic spam / bot signature
  const repeatedText = repeated(clusterTexts(textual))
    .map((c) => ({ text: c.sample, events: c.events, authors: c.authors.size, nearCopies: c.near }))
    .sort((a, b) => b.authors - a.authors || b.events - a.events)
    .slice(0, topN)

  // many events from one key in a short window
  const bursts: ActivityReport['bursts'] = []
  for (const [pk, list] of byAuthor) {
    const b = burstOf(list.map((e) => e.created_at), window)
    if (b.events >= burstMin) bursts.push({ pubkey: pk, events: b.events, withinSeconds: b.seconds })
  }
  bursts.sort((a, b) => b.events - a.events)

  const single = [...byAuthor.values()].filter((l) => l.length === 1).length
  const report: ActivityReport = {
    sample: { events: events.length, authors: byAuthor.size, from: iso(from), to: iso(to), spanHours: Math.round(((to - from) / 3600) * 10) / 10 },
    byKind: [...kinds.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([kind, count]) => ({ kind, name: kindName(kind), count, percent: Math.round((count / events.length) * 1000) / 10 })),
    perHour: [...hours.entries()].sort((a, b) => a[0] - b[0]).map(([h, count]) => ({ hour: iso(h), count })),
    topAuthors: [...byAuthor.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, topN).map(([pubkey, list]) => {
      const t = list.map((e) => e.created_at)
      const ks: Record<string, number> = {}
      for (const e of list) ks[`${e.kind} ${kindName(e.kind)}`] = (ks[`${e.kind} ${kindName(e.kind)}`] ?? 0) + 1
      return { pubkey, events: list.length, kinds: ks, first: iso(Math.min(...t)), last: iso(Math.max(...t)) }
    }),
    content: { empty: textual.filter((e) => !e.content.trim()).length, medianLength: median(lengths), withLinks: textual.filter((e) => LINK.test(e.content)).length },
    repeatedText,
    bursts: bursts.slice(0, topN),
    authorsWithOneEvent: { count: single, percent: Math.round((single / byAuthor.size) * 1000) / 10 },
    signals: [],
  }

  for (const r of repeatedText.slice(0, 3)) {
    // no third-party text in a signal: the text itself is in `repeatedText`, which callers keep under "untrusted"
    report.signals.push({ kind: 'duplicate-text', detail: `an identical text of ${[...r.text].length} characters appears in ${r.events} events from ${r.authors} different key(s) (see repeatedText)` })
  }
  for (const b of bursts.slice(0, 3)) {
    report.signals.push({ kind: 'burst', detail: `${short(b.pubkey)} published ${b.events} events within ${b.withinSeconds} s` })
  }
  if (byAuthor.size >= 5 && single / byAuthor.size >= 0.7) {
    report.signals.push({ kind: 'throwaway-keys', detail: `${single} of ${byAuthor.size} authors (${report.authorsWithOneEvent.percent}%) have a single event in this sample: typical of throw-away keys or a short window` })
  }
  if (kinds.size === 1 && events.length >= 20 && !opts.kindsFiltered) { // pointless to point out when the caller asked for a single kind
    report.signals.push({ kind: 'single-kind', detail: `all ${events.length} events are kind ${[...kinds.keys()][0]} (${kindName([...kinds.keys()][0]!)})` })
  }
  return report
}

export interface Profile { name?: string; displayName?: string; about?: string; nip05?: string; lud16?: string; website?: string; picture?: string }

/** Pulls the usual fields out of a kind-0 event; anything unparseable gives an empty profile. */
export function parseProfile(e: Event | undefined): Profile {
  if (!e) return {}
  let o: Record<string, unknown>
  try { o = JSON.parse(e.content) } catch { return {} }
  if (o === null || typeof o !== 'object') return {}
  const s = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? cleanText(v, max) : undefined)
  return {
    name: s(o.name, 60), displayName: s(o.display_name ?? o.displayName, 60), about: s(o.about, 300), nip05: s(o.nip05, 100),
    lud16: s(o.lud16, 100), website: s(o.website, 120), picture: s(o.picture, 160),
  }
}
