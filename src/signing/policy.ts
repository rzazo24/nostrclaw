// The publishing policy: a file the *user* owns (`<config dir>/policy.json`). No tool can write it. It is read once at start-up; an invalid
// file stops the server instead of silently falling back to something more permissive.
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { normalizeRelayUrl, type Config } from '../config.js'

/** Never allow content that looks like a secret to be published, whatever the user's own patterns are. */
export const DEFAULT_BLOCKED_PATTERNS = ['nsec1[0-9a-z]{20,}', 'ncryptsec1[0-9a-z]{20,}', 'bunker://', 'nostrconnect://', 'secret=']

const schema = z.object({
  allowedKinds: z.array(z.number().int().min(0).max(65535)).max(50).default([1, 7]),
  maxEventsPerHour: z.number().int().min(1).max(200).default(5),
  maxContentChars: z.number().int().min(1).max(20000).default(1000),
  maxTags: z.number().int().min(0).max(100).default(20),
  publishRelays: z.array(z.string()).max(10).default([]),
  blockedPatterns: z.array(z.string().min(1).max(200)).max(50).default([]),
  minHumanApprovalMs: z.number().int().min(0).max(60000).default(2000),
  signTimeoutMs: z.number().int().min(1000).max(600000).default(300000),
}).strict()

export interface Policy {
  allowedKinds: number[]
  maxEventsPerHour: number
  maxContentChars: number
  maxTags: number
  publishRelays: string[]
  blockedPatterns: RegExp[]
  minHumanApprovalMs: number
  signTimeoutMs: number
}

export interface DraftInput { kind: number; content: string; tags: string[][] }

export function policyPath(cfg: Config): string { return path.join(cfg.signing.configDir, 'policy.json') }

/** Reads the policy (defaults when the file does not exist). Throws a clear message when it is invalid. */
export function loadPolicy(cfg: Config): Policy {
  const file = policyPath(cfg)
  let raw: unknown = {}
  if (fs.existsSync(file)) {
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')) } catch (e) { throw new Error(`${file}: not valid JSON (${(e as Error).message})`) }
  }
  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    throw new Error(`${file}: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'policy'}: ${i.message}`).join('; ')}`)
  }
  const p = parsed.data
  const publishRelays = (p.publishRelays.length ? p.publishRelays : [cfg.relays[0]!]).map((r) => {
    let url: string
    try { url = normalizeRelayUrl(r) } catch (e) { throw new Error(`${file}: publishRelays: ${(e as Error).message}`) }
    if (!cfg.relays.includes(url)) throw new Error(`${file}: publishRelays: ${url} is not in NOSTRCLAW_RELAYS (${cfg.relays.join(', ')})`)
    return url
  })
  const blockedPatterns = [...DEFAULT_BLOCKED_PATTERNS, ...p.blockedPatterns].map((src) => {
    try { return new RegExp(src, 'i') } catch { throw new Error(`${file}: blockedPatterns: "${src}" is not a valid regular expression`) }
  })
  return { ...p, publishRelays: [...new Set(publishRelays)], blockedPatterns }
}

/** Why a draft may not be made, or null when the policy allows it. Pure: no clock, no state (the rate limit lives with the audit log). */
export function checkDraft(policy: Policy, d: DraftInput): string | null {
  if (!policy.allowedKinds.includes(d.kind)) return `kind ${d.kind} is not allowed by the policy (allowed: ${policy.allowedKinds.join(', ') || 'none'}). Only the user can change policy.json`
  const chars = [...d.content].length
  if (chars > policy.maxContentChars) return `content is ${chars} characters; the policy allows ${policy.maxContentChars}`
  if (d.tags.length > policy.maxTags) return `${d.tags.length} tags; the policy allows ${policy.maxTags}`
  const hay = [d.content, ...d.tags.flat()].join('\n')
  for (const re of policy.blockedPatterns) if (re.test(hay)) return 'the content matches a blocked pattern (it looks like it contains a secret or a connection string)'
  if (d.kind === 1 && !d.content.trim()) return 'a note cannot be empty'
  if (d.kind === 5) { // NIP-09 deletion request: named events only, and a short reason; whether they are the user's own is checked where the events are fetched
    if (chars > 200) return 'the reason of a deletion is at most 200 characters'
    const targets = d.tags.filter((t) => t[0] === 'e').length
    if (targets < 1 || targets > 5) return 'a deletion names between 1 and 5 events (e tags)'
    const wellFormed = (t: string[]) => t.length === 2 && ((t[0] === 'e' && /^[0-9a-f]{64}$/i.test(t[1] ?? '')) || (t[0] === 'k' && /^\d{1,5}$/.test(t[1] ?? '')))
    if (!d.tags.every(wellFormed)) return 'a deletion carries only e tags (64-character event ids) and k tags (kinds)'
  }
  if (d.kind === 10002 || d.kind === 10050) { // relay lists: where people find your notes (NIP-65) or send you private messages (NIP-17); which relays may be named is checked where the list is built
    if (d.content !== '') return 'a relay list has no content'
    const name = d.kind === 10002 ? 'r' : 'relay'
    const wss = (u: string | undefined) => typeof u === 'string' && /^wss:\/\/[^\s/]+(\/\S*)?$/.test(u) && u.length <= 200
    if (d.tags.length < 1 || d.tags.length > 10) return 'a relay list names between 1 and 10 relays'
    const ok = (t: string[]) => t[0] === name && wss(t[1]) && (t.length === 2 || (d.kind === 10002 && t.length === 3 && (t[2] === 'read' || t[2] === 'write')))
    if (!d.tags.every(ok)) return d.kind === 10002 ? 'a relay list carries only ["r", "wss://…"] tags, optionally marked read or write' : 'a DM relay list carries only ["relay", "wss://…"] tags'
    if (new Set(d.tags.map((t) => t[1])).size !== d.tags.length) return 'a relay list names each relay once'
  }
  return null
}
