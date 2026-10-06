// `nostrclaw doctor`: checks that everything nostrclaw needs is in place and says what is wrong and how to fix it. Read-only: it never signs, never publishes and
// never writes anything. Secrets are never printed (the app key in the saved session is only checked for its shape).
import fs from 'node:fs'
import path from 'node:path'
import { nip19 } from 'nostr-tools'
import { loadConfig, POWR_RELAY, VERSION, type Config } from './config.js'
import { realApi, type NostrApi } from './nostr/client.js'
import { assertPublicHost, cleanText } from './safety.js'
import { Audit } from './signing/audit.js'
import { loadPolicy, policyPath } from './signing/policy.js'
import { SignerManager } from './signing/signer.js'

export type Level = 'ok' | 'warn' | 'fail' | 'info'
export interface Check { level: Level; title: string; detail?: string; fix?: string }
export interface Report { version: string; checks: Check[]; summary: { ok: number; warn: number; fail: number } }

export interface DoctorDeps {
  api?: NostrApi
  /** Also resume the saved session and ask the signer to `ping` (needs the signer app open on screen). Never signs. */
  checkSigner?: boolean
  /** Shorten the waits (tests). */
  resumeWaitMs?: number
  pingWaitMs?: number
  nodeVersion?: string
}

const msg = (e: unknown) => cleanText(e instanceof Error ? e.message : String(e), 240)
const mode = (p: string): number | null => { try { return fs.statSync(p).mode & 0o777 } catch { return null } }
const octal = (m: number) => m.toString(8).padStart(3, '0')

/** The NOSTRCLAW_* variables of a server registered in Claude Code's config file (`~/.claude.json`), so the doctor checks what Claude Code really launches. */
export function envFromClaudeJson(file: string, name: string, cwd: string = process.cwd()): Record<string, string> {
  let json: { mcpServers?: Record<string, { env?: Record<string, string> }>; projects?: Record<string, { mcpServers?: Record<string, { env?: Record<string, string> }> }> }
  try { json = JSON.parse(fs.readFileSync(file, 'utf8')) } catch (e) { throw new Error(`could not read ${file}: ${msg(e)}`) }
  const inProject = json.projects?.[cwd]?.mcpServers?.[name]
  const anyProject = Object.values(json.projects ?? {}).map((p) => p.mcpServers?.[name]).find(Boolean)
  const found = inProject ?? json.mcpServers?.[name] ?? anyProject
  if (!found) throw new Error(`no MCP server named "${name}" in ${file} (looked in the global servers and in every project)`)
  return Object.fromEntries(Object.entries(found.env ?? {}).filter(([k, v]) => k.startsWith('NOSTRCLAW_') && typeof v === 'string'))
}

export async function runDoctor(env: Record<string, string | undefined>, deps: DoctorDeps = {}): Promise<Report> {
  const checks: Check[] = []
  const add = (level: Level, title: string, detail?: string, fix?: string) => checks.push({ level, title, detail, fix })
  const api = deps.api ?? realApi
  const finish = (): Report => ({
    version: VERSION, checks,
    summary: { ok: checks.filter((c) => c.level === 'ok').length, warn: checks.filter((c) => c.level === 'warn').length, fail: checks.filter((c) => c.level === 'fail').length },
  })

  // 1) the runtime
  const node = deps.nodeVersion ?? process.versions.node
  if (Number(node.split('.')[0]) >= 20) add('ok', `Node ${node}`, 'nostrclaw needs Node 20 or newer')
  else add('fail', `Node ${node} is too old`, 'nostrclaw needs Node 20 or newer', 'install a current Node.js (https://nodejs.org)')

  // 2) the configuration (an invalid one stops the real server, so say exactly why)
  let cfg: Config
  try { cfg = loadConfig(env) } catch (e) {
    add('fail', 'Configuration is invalid', msg(e), 'fix the NOSTRCLAW_* variable named above in the MCP server\'s env')
    return finish()
  }
  add('ok', `Configuration read (nostrclaw ${VERSION})`, `relays: ${cfg.relays.join(', ')}; ${cfg.signing.enabled ? 'signing ENABLED' : 'read-only'}`)
  if (!cfg.signing.enabled) add('info', 'Signing is off', 'publishing tools are not registered; signing checks skipped', 'set NOSTRCLAW_ENABLE_SIGNING=1 to turn them on')

  // 3) each relay: allowed host, NIP-11, a real query
  const writes = new Set<string>()
  let policyError: string | undefined
  let policyRelays: string[] = []
  if (cfg.signing.enabled) {
    try { policyRelays = loadPolicy(cfg).publishRelays; policyRelays.forEach((r) => writes.add(r)) } catch (e) { policyError = msg(e) }
  }
  await Promise.all(cfg.relays.map(async (url) => {
    try { assertPublicHost(url, cfg) } catch (e) {
      add('fail', `${url}: not allowed`, msg(e), 'use a public relay, or set NOSTRCLAW_ALLOW_PRIVATE=1 for a local one'); return
    }
    const [info, probe] = await Promise.allSettled([api.nip11(url, { timeoutMs: cfg.timeoutMs }), api.query(url, { kinds: [1], limit: 1 }, { timeoutMs: cfg.timeoutMs, max: 1 })])
    if (probe.status === 'rejected') { add('fail', `${url}: does not answer queries`, msg(probe.reason), 'check the URL, your network, or try again later'); return }
    const lim = info.status === 'fulfilled' ? ((info.value.doc.limitation ?? {}) as Record<string, unknown>) : {}
    const nips = info.status === 'fulfilled' && Array.isArray(info.value.doc.supported_nips) ? (info.value.doc.supported_nips as number[]) : []
    const where = `NIP-11 ${info.status === 'fulfilled' ? `${info.value.ms} ms` : 'unavailable'}, query ${probe.value.ms} ms`
    const problems: string[] = []
    if (lim.auth_required === true) problems.push('reads need NIP-42 authentication, which nostrclaw does not do')
    if (writes.has(url) && lim.payment_required === true) problems.push('writes need payment')
    if (writes.has(url) && lim.restricted_writes === true) problems.push('writes are restricted to approved keys')
    if (problems.length) add('warn', `${url}: reachable but limited`, `${where}; ${problems.join('; ')}`, writes.has(url) ? 'remove it from publishRelays in policy.json, or expect publications to it to be refused' : 'use another relay for analysis')
    else add('ok', `${url}: reachable`, `${where}${nips.length && !nips.includes(45) ? '; no NIP-45 (count_events falls back to samples)' : ''}`)
    if (info.status === 'rejected') add('info', `${url}: no NIP-11 document`, msg(info.reason))
  }))

  if (!cfg.signing.enabled) return finish()

  // 4) the signing set-up
  const cfgDir = cfg.signing.configDir
  const dirMode = mode(cfgDir)
  if (dirMode === null) add('info', `Config folder ${cfgDir} does not exist yet`, 'it is created the first time a signer is connected')
  else if (dirMode & 0o077) add('warn', `Config folder ${cfgDir} is open to other users (mode ${octal(dirMode)})`, undefined, `chmod 700 ${cfgDir}`)
  else add('ok', `Config folder ${cfgDir}`, `mode ${octal(dirMode)}`)

  const pol = policyPath(cfg)
  if (policyError) add('fail', 'policy.json is invalid: the server will not start', policyError, `fix or delete ${pol}`)
  else if (!fs.existsSync(pol)) add('info', 'No policy.json: defaults apply', `notes and reactions only, 5 signatures per hour, publishing only to ${policyRelays.join(', ')}`, `create ${pol} to change them`)
  else {
    const p = loadPolicy(cfg)
    add('ok', 'policy.json is valid', `kinds ${p.allowedKinds.join(', ')}; ${p.maxEventsPerHour} signatures/hour; max ${p.maxContentChars} characters; publishes to ${p.publishRelays.join(', ')}`)
    const m = mode(pol)
    if (m !== null && m & 0o022) add('warn', `policy.json can be changed by other users (mode ${octal(m)})`, 'it decides what may be published', `chmod 600 ${pol}`)
  }

  const sessionFile = path.join(cfgDir, 'signer.json')
  let hasSession = false
  if (!fs.existsSync(sessionFile)) add('info', 'No saved signer session', undefined, 'ask Claude to connect your signer (signer_connect) and approve the link in Clave')
  else {
    try {
      const s = JSON.parse(fs.readFileSync(sessionFile, 'utf8')) as { clientSecret?: string; signerPubkey?: string; relays?: string[] }
      const shaped = typeof s.clientSecret === 'string' && /^[0-9a-f]{64}$/.test(s.clientSecret)
      hasSession = shaped && !!s.signerPubkey && !!s.relays?.length
      const m = mode(sessionFile)!
      if (!shaped) add('fail', 'signer.json is damaged (no valid app key)', undefined, `delete ${sessionFile} and connect the signer again`)
      else if (!hasSession) add('warn', 'signer.json holds an app key but no completed session', undefined, 'connect the signer again (signer_connect)')
      else add('ok', 'Saved signer session', `signer ${nip19.npubEncode(s.signerPubkey!).slice(0, 16)}…; talks through ${s.relays!.join(', ')}`)
      if (m & 0o077) add('warn', `signer.json is readable by other users (mode ${octal(m)})`, 'it holds the key that identifies nostrclaw to your signer', `chmod 600 ${sessionFile}`)
      if (hasSession && !s.relays!.includes(POWR_RELAY)) add('warn', `The session does not use ${POWR_RELAY}`, 'Clave only wakes in the background through that relay', 'connect again with the default NOSTRCLAW_SIGNER_RELAYS')
    } catch (e) { add('fail', 'signer.json cannot be read', msg(e), `delete ${sessionFile} and connect the signer again`) }
  }

  // 5) what happened recently (counts only: the audit log never holds content or secrets)
  const stateDir = cfg.signing.stateDir
  try {
    fs.accessSync(fs.existsSync(stateDir) ? stateDir : path.dirname(stateDir), fs.constants.W_OK)
    const audit = new Audit(stateDir)
    add('ok', `State folder ${stateDir}`, `last hour: ${audit.signedLastHour()} signature(s) made, ${audit.signRequestsLastHour()} requested`)
  } catch (e) { add('warn', `State folder ${stateDir} is not writable`, msg(e), 'the audit log and the hourly limit need it') }

  // 6) the signer itself, only when asked (it must be open on screen)
  if (deps.checkSigner) {
    if (!hasSession) add('info', 'Signer check skipped', 'there is no saved session to resume')
    else {
      const signer = new SignerManager({ ...cfg, signing: { ...cfg.signing, resumeWaitMs: deps.resumeWaitMs } })
      try {
        const t0 = Date.now()
        if (!(await signer.resume())) add('fail', 'The signer did not answer', signer.lastError, 'open Clave on screen (or tap its notification) and run the check again; the saved session is intact')
        else {
          const resumeMs = Date.now() - t0, t1 = Date.now()
          const alive = await signer.ping(deps.pingWaitMs ?? 10_000)
          if (alive) add('ok', 'The signer answered', `resumed in ${resumeMs} ms, ping ${Date.now() - t1} ms, signing as ${nip19.npubEncode(signer.userPubkey!).slice(0, 16)}…`)
          else add('warn', 'The signer resumed but did not answer a ping', 'it may have gone to the background', 'keep Clave on screen when publishing')
        }
      } finally { await signer.close() }
    }
  } else if (hasSession) add('info', 'Signer not contacted', undefined, 'run with --check-signer, with Clave open on screen, to test it')

  return finish()
}

export function formatReport(r: Report, color = false): string {
  const paint = (code: string, s: string) => (color ? `\u001b[${code}m${s}\u001b[0m` : s)
  const mark: Record<Level, string> = { ok: paint('32', '✔'), warn: paint('33', '⚠'), fail: paint('31', '✖'), info: paint('36', 'ℹ') }
  const lines = [`nostrclaw ${r.version} — doctor`, '']
  for (const c of r.checks) {
    lines.push(`${mark[c.level]} ${c.title}`)
    if (c.detail) lines.push(`    ${c.detail}`)
    if (c.fix) lines.push(`    → ${c.fix}`)
  }
  lines.push('', `${r.summary.ok} ok, ${r.summary.warn} warning(s), ${r.summary.fail} problem(s)`)
  return lines.join('\n')
}
