// Append-only log of what happened to every draft, plus the in-memory view the rate limit needs. It never stores event content,
// connection URIs or secrets: ids, kinds, hashes, relays and outcomes only.
import fs from 'node:fs'
import path from 'node:path'

export type AuditStep = 'draft' | 'declined' | 'sign-requested' | 'signed' | 'discarded-auto-approval' | 'rejected' | 'published' | 'refused' | 'preflight-failed' | 'reconnected' | 'retried'

export interface AuditEntry {
  step: AuditStep
  draftId?: string
  eventId?: string
  kind?: number
  contentHash?: string
  relays?: Record<string, string>
  approval?: 'elicitation' | 'signer'
  signMs?: number
  detail?: string
}

type Stored = AuditEntry & { t: number }
const HOUR = 3600_000

export class Audit {
  private recent: Stored[] = []
  private readonly file: string | null

  constructor(stateDir: string | null, private now: () => number = Date.now) {
    this.file = stateDir ? path.join(stateDir, 'audit.jsonl') : null
    if (!this.file) return
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
    // pick up what was requested in the last hour, so a restart does not reset the rate limit
    try {
      const lines = fs.readFileSync(this.file, 'utf8').split('\n').slice(-2000)
      for (const l of lines) {
        try { const e = JSON.parse(l) as Stored; if (typeof e.t === 'number' && this.now() - e.t < HOUR) this.recent.push(e) } catch { /* a damaged line is skipped */ }
      }
    } catch { /* no file yet */ }
  }

  log(entry: AuditEntry): void {
    const stored: Stored = { t: this.now(), ...entry }
    this.recent.push(stored)
    if (this.recent.length > 2000) this.recent.splice(0, this.recent.length - 2000)
    if (!this.file) return
    try {
      fs.appendFileSync(this.file, JSON.stringify({ time: new Date(stored.t).toISOString(), ...stored }) + '\n', { mode: 0o600 })
    } catch (e) {
      console.error(`nostrclaw: could not write the audit log: ${(e as Error).message}`) // must not stop the flow, but must not be silent either
    }
  }

  /** How many signatures were requested in the last hour (answered or not). */
  signRequestsLastHour(): number {
    return this.recent.filter((e) => e.step === 'sign-requested' && this.now() - e.t < HOUR).length
  }

  /** How many signatures were actually made in the last hour: the number the publications-per-hour limit is about. */
  signedLastHour(): number {
    return this.recent.filter((e) => e.step === 'signed' && this.now() - e.t < HOUR).length
  }
}
