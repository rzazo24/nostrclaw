// Configuration, read from environment variables so it can be set in the MCP client's server entry (e.g. `claude mcp add -e ...`).
//
//   NOSTRCLAW_RELAYS          comma-separated relay URLs the tools may talk to (default: wss://relay.hivescope.xyz).
//                             The first one is the default when a tool is called without `relay`. Anything else is refused:
//                             an assistant must not be able to make this process connect to arbitrary hosts.
//   NOSTRCLAW_ALLOW_PRIVATE   "1" lets the relays be on localhost / private networks (for development and tests). Off by default.
//   NOSTRCLAW_TIMEOUT_MS      per-request timeout, default 8000 (500..60000).
//   NOSTRCLAW_MAX_EVENTS      most events any single tool call may fetch, default 500 (1..2000).

export const VERSION = '0.1.0'
export const DEFAULT_RELAY = 'wss://relay.hivescope.xyz'

export interface Config {
  relays: string[]
  allowPrivate: boolean
  timeoutMs: number
  maxEvents: number
}

function intIn(name: string, raw: string | undefined, def: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === '') return def
  const n = Number(raw)
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name}: "${raw}" is not an integer between ${min} and ${max}`)
  return n
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const rawRelays = (env.NOSTRCLAW_RELAYS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const relays = (rawRelays.length ? rawRelays : [DEFAULT_RELAY]).map(normalizeRelayUrl)
  return {
    relays: [...new Set(relays)],
    allowPrivate: env.NOSTRCLAW_ALLOW_PRIVATE === '1',
    timeoutMs: intIn('NOSTRCLAW_TIMEOUT_MS', env.NOSTRCLAW_TIMEOUT_MS, 8000, 500, 60000),
    maxEvents: intIn('NOSTRCLAW_MAX_EVENTS', env.NOSTRCLAW_MAX_EVENTS, 500, 1, 2000),
  }
}

/** ws(s) URL in a canonical form (no trailing slash, lower-case host). Throws on anything that is not ws:// or wss://. */
export function normalizeRelayUrl(input: string): string {
  let u: URL
  try { u = new URL(input.trim()) } catch { throw new Error(`"${input}" is not a valid relay URL (expected wss://host)`) }
  if (u.protocol !== 'wss:' && u.protocol !== 'ws:') throw new Error(`"${input}": relays must use wss:// (or ws:// for local development)`)
  if (u.username || u.password) throw new Error(`"${input}": credentials in a relay URL are not accepted`)
  u.hash = ''
  return u.toString().replace(/\/+$/, '')
}
