import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { envFromClaudeJson, formatReport, runDoctor, type Check } from '../src/doctor.js'
import type { NostrApi } from '../src/nostr/client.js'

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p))
const R1 = 'wss://relay.example.com', R2 = 'wss://other.example.org'

function api(over: Partial<NostrApi> = {}): NostrApi {
  return {
    async query() { return { events: [], eose: true, notices: [], invalid: 0, ms: 12 } },
    async count() { return { count: 1, ms: 1 } },
    async publish() { return { ok: true, reason: '', ms: 1 } },
    async nip11() { return { doc: { name: 'x', supported_nips: [1, 11, 45], limitation: {} }, ms: 8 } },
    async publicStats() { return null },
    ...over,
  }
}
const dirs = () => ({ NOSTRCLAW_CONFIG_DIR: tmp('doc-config-'), NOSTRCLAW_STATE_DIR: tmp('doc-state-') })
const find = (checks: Check[], re: RegExp) => checks.find((c) => re.test(c.title))
const SECRET = 'ab'.repeat(32)

describe('doctor: configuration and relays', () => {
  it('a healthy read-only set-up has no warnings or problems and says signing is off', async () => {
    const r = await runDoctor({ NOSTRCLAW_RELAYS: `${R1},${R2}`, ...dirs() }, { api: api() })
    expect(r.summary).toMatchObject({ warn: 0, fail: 0 })
    expect(find(r.checks, /Signing is off/)?.fix).toMatch(/NOSTRCLAW_ENABLE_SIGNING=1/)
    expect(r.checks.filter((c) => /reachable/.test(c.title))).toHaveLength(2)
  })
  it('an invalid setting stops at once and names it', async () => {
    const r = await runDoctor({ NOSTRCLAW_TIMEOUT_MS: 'abc' }, { api: api() })
    expect(r.summary.fail).toBe(1)
    expect(find(r.checks, /Configuration is invalid/)?.detail).toMatch(/NOSTRCLAW_TIMEOUT_MS.*abc/)
    expect(r.checks.some((c) => /reachable/.test(c.title))).toBe(false)
  })
  it('a Node that is too old is a problem', async () => {
    expect((await runDoctor({}, { api: api(), nodeVersion: '18.19.0' })).checks[0]).toMatchObject({ level: 'fail', fix: expect.stringMatching(/Node\.js/) })
  })
  it('a private address is refused unless explicitly allowed', async () => {
    const env = { NOSTRCLAW_RELAYS: 'ws://127.0.0.1:7777', ...dirs() }
    const bad = await runDoctor(env, { api: api() })
    expect(find(bad.checks, /not allowed/)).toMatchObject({ level: 'fail', fix: expect.stringMatching(/ALLOW_PRIVATE/) })
    expect((await runDoctor({ ...env, NOSTRCLAW_ALLOW_PRIVATE: '1' }, { api: api() })).summary.fail).toBe(0)
  })
  it('a relay that does not answer is a problem; one without NIP-11 is only information', async () => {
    const r = await runDoctor({ NOSTRCLAW_RELAYS: `${R1},${R2}`, ...dirs() }, {
      api: api({
        async query(url) { if (url === R1) throw new Error('could not talk to relay: connection refused'); return { events: [], eose: true, notices: [], invalid: 0, ms: 5 } },
        async nip11(url) { if (url === R2) throw new Error('404'); return { doc: {}, ms: 3 } },
      }),
    })
    expect(find(r.checks, new RegExp(`${R1}.*does not answer`))).toMatchObject({ level: 'fail', detail: expect.stringMatching(/connection refused/) })
    expect(find(r.checks, new RegExp(`${R2}.*no NIP-11`))?.level).toBe('info')
    expect(find(r.checks, new RegExp(`${R2}: reachable`))?.level).toBe('ok')
  })
  it('a relay that needs authentication is a warning for reading; payment only matters for relays you publish to', async () => {
    const d = dirs()
    fs.writeFileSync(path.join(d.NOSTRCLAW_CONFIG_DIR, 'policy.json'), JSON.stringify({ publishRelays: [R2] }))
    const r = await runDoctor({ NOSTRCLAW_RELAYS: `${R1},${R2}`, NOSTRCLAW_ENABLE_SIGNING: '1', ...d }, {
      api: api({ async nip11() { return { doc: { limitation: { auth_required: true, payment_required: true } }, ms: 4 } } }),
    })
    expect(find(r.checks, new RegExp(`${R1}: reachable but limited`))?.detail).toMatch(/NIP-42/)
    expect(find(r.checks, new RegExp(`${R1}: reachable but limited`))?.detail).not.toMatch(/payment/)
    expect(find(r.checks, new RegExp(`${R2}: reachable but limited`))?.detail).toMatch(/writes need payment/)
  })
})

describe('doctor: signing set-up', () => {
  const signing = (d: ReturnType<typeof dirs>) => ({ NOSTRCLAW_RELAYS: R1, NOSTRCLAW_ENABLE_SIGNING: '1', ...d })

  it('no policy.json is information (defaults), a valid one is summarised, an invalid one is a problem that says why and where', async () => {
    const d = dirs()
    expect(find((await runDoctor(signing(d), { api: api() })).checks, /No policy\.json/)?.level).toBe('info')
    fs.writeFileSync(path.join(d.NOSTRCLAW_CONFIG_DIR, 'policy.json'), JSON.stringify({ maxEventsPerHour: 7 }), { mode: 0o600 })
    expect(find((await runDoctor(signing(d), { api: api() })).checks, /policy\.json is valid/)?.detail).toMatch(/7 signatures\/hour/)
    fs.writeFileSync(path.join(d.NOSTRCLAW_CONFIG_DIR, 'policy.json'), JSON.stringify({ publishRelays: ['wss://elsewhere.example.net'] }))
    const bad = await runDoctor(signing(d), { api: api() })
    expect(find(bad.checks, /policy\.json is invalid/)).toMatchObject({ level: 'fail', detail: expect.stringMatching(/not in NOSTRCLAW_RELAYS/) })
    expect(bad.summary.fail).toBeGreaterThan(0)
  })

  it('the saved session is summarised without secrets; wrong permissions and a missing powr relay are warnings', async () => {
    const d = dirs()
    const file = path.join(d.NOSTRCLAW_CONFIG_DIR, 'signer.json')
    fs.writeFileSync(file, JSON.stringify({ clientSecret: SECRET, signerPubkey: 'cd'.repeat(32), relays: [R1] }), { mode: 0o644 })
    fs.chmodSync(file, 0o644)
    const r = await runDoctor(signing(d), { api: api() })
    expect(find(r.checks, /Saved signer session/)?.level).toBe('ok')
    expect(find(r.checks, /signer\.json is readable by other users \(mode 644\)/)?.fix).toBe(`chmod 600 ${file}`)
    expect(find(r.checks, /does not use wss:\/\/relay\.powr\.build/)?.level).toBe('warn')
    expect(JSON.stringify(r) + formatReport(r)).not.toContain(SECRET) // the app key is never printed
  })

  it('a damaged session file is a problem with the fix', async () => {
    const d = dirs()
    fs.writeFileSync(path.join(d.NOSTRCLAW_CONFIG_DIR, 'signer.json'), JSON.stringify({ clientSecret: 'nope' }), { mode: 0o600 })
    expect(find((await runDoctor(signing(d), { api: api() })).checks, /signer\.json is damaged/)).toMatchObject({ level: 'fail', fix: expect.stringMatching(/delete .*signer\.json/) })
  })

  it('an open config folder is a warning with the chmod to fix it', async () => {
    const d = dirs(); fs.chmodSync(d.NOSTRCLAW_CONFIG_DIR, 0o755)
    expect(find((await runDoctor(signing(d), { api: api() })).checks, /Config folder .* open to other users/)?.fix).toMatch(/chmod 700/)
  })

  it('reports the last hour from the audit log, counting only', async () => {
    const d = dirs()
    const now = Date.now()
    fs.writeFileSync(path.join(d.NOSTRCLAW_STATE_DIR, 'audit.jsonl'), [
      { t: now - 1000, step: 'sign-requested' }, { t: now - 900, step: 'signed' }, { t: now - 500, step: 'sign-requested' }, { t: now - 2 * 3600_000, step: 'signed' },
    ].map((e) => JSON.stringify(e)).join('\n') + '\n')
    expect(find((await runDoctor(signing(d), { api: api() })).checks, /State folder/)?.detail).toMatch(/1 signature\(s\) made, 2 requested/)
  })

  it('suggests --check-signer when there is a saved session, and does not contact the signer without it', async () => {
    const d = dirs()
    fs.writeFileSync(path.join(d.NOSTRCLAW_CONFIG_DIR, 'signer.json'), JSON.stringify({ clientSecret: SECRET, signerPubkey: 'cd'.repeat(32), relays: ['wss://relay.powr.build', R1] }), { mode: 0o600 })
    const r = await runDoctor(signing(d), { api: api() })
    expect(find(r.checks, /Signer not contacted/)?.fix).toMatch(/--check-signer/)
    expect(r.summary).toMatchObject({ warn: 0, fail: 0 })
  })
})

describe('doctor: reading the Claude Code registration', () => {
  const file = path.join(tmp('doc-claude-'), 'claude.json')
  fs.writeFileSync(file, JSON.stringify({
    mcpServers: { nostrclaw: { env: { NOSTRCLAW_RELAYS: R1, OTHER_SECRET: 'x' } } },
    projects: { '/some/project': { mcpServers: { 'nostrclaw-sign': { env: { NOSTRCLAW_ENABLE_SIGNING: '1', NOSTRCLAW_RELAYS: `${R1},${R2}`, API_TOKEN: 'secret' } } } } },
  }))
  it('takes only the NOSTRCLAW_* settings of the named server, global or in any project', () => {
    expect(envFromClaudeJson(file, 'nostrclaw')).toEqual({ NOSTRCLAW_RELAYS: R1 })
    expect(envFromClaudeJson(file, 'nostrclaw-sign', '/elsewhere')).toEqual({ NOSTRCLAW_ENABLE_SIGNING: '1', NOSTRCLAW_RELAYS: `${R1},${R2}` })
  })
  it('says clearly when the server or the file is not there', () => {
    expect(() => envFromClaudeJson(file, 'nope')).toThrow(/no MCP server named "nope"/)
    expect(() => envFromClaudeJson('/nonexistent/claude.json', 'x')).toThrow(/could not read/)
  })
})

describe('doctor: the command line', () => {
  const cli = path.resolve('dist/index.js')
  it('--help and --version work, an unknown argument is refused', () => {
    expect(execFileSync('node', [cli, '--version']).toString().trim()).toMatch(/^\d+\.\d+\.\d+$/)
    expect(execFileSync('node', [cli, 'doctor', '--help']).toString()).toMatch(/--check-signer/)
    const bad = spawnSync('node', [cli, '--wat'])
    expect(bad.status).toBe(2); expect(bad.stderr.toString()).toMatch(/unknown argument/)
  })
  it('exits 2 with a clear message for an unknown registered server, and prints JSON on request', () => {
    const none = spawnSync('node', [cli, 'doctor', '--claude', 'nope', '--claude-file', '/nonexistent.json'])
    expect(none.status).toBe(2); expect(none.stderr.toString()).toMatch(/could not read/)
    const d = dirs()
    const json = spawnSync('node', [cli, 'doctor', '--json'], { env: { ...process.env, NOSTRCLAW_RELAYS: 'ws://127.0.0.1:1', NOSTRCLAW_ALLOW_PRIVATE: '1', ...d } })
    expect(json.status).toBe(1) // the relay is not there: a problem, so a failing exit code
    expect(JSON.parse(json.stdout.toString()).summary.fail).toBeGreaterThan(0)
  })
})
