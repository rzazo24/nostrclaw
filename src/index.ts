#!/usr/bin/env node
// Entry point. With no arguments it serves MCP over stdio (what Claude Code and Claude Desktop use): stdout carries the protocol, so everything we want to
// say goes to stderr. `nostrclaw doctor` is a command-line check and prints to stdout.
import os from 'node:os'
import path from 'node:path'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { loadConfig, VERSION } from './config.js'
import { envFromClaudeJson, formatReport, runDoctor } from './doctor.js'
import { createServer } from './server.js'

const USAGE = `nostrclaw ${VERSION}

  nostrclaw                      serve MCP over stdio (what Claude Code launches)
  nostrclaw doctor [options]     check the set-up and say what is wrong and how to fix it (read-only: never signs or publishes)
  nostrclaw --version

doctor options:
  --claude <name>       read the NOSTRCLAW_* settings of the MCP server registered in Claude Code as <name> (from ~/.claude.json),
                        e.g. --claude nostrclaw-sign; without it the settings come from this shell's environment
  --claude-file <path>  use another Claude Code config file
  --check-signer        also resume the saved session and ping the signer (open Clave on screen first; nothing is signed)
  --json                machine-readable output
`

async function doctor(args: string[]): Promise<number> {
  const flag = (n: string) => args.includes(n)
  const value = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined }
  if (flag('--help') || flag('-h')) { console.log(USAGE); return 0 }
  const name = value('--claude')
  if (flag('--claude') && !name) { console.error('nostrclaw doctor: --claude needs the name of the registered server, e.g. nostrclaw-sign'); return 2 }
  let env: Record<string, string | undefined> = {}
  if (name) {
    const file = value('--claude-file') ?? path.join(os.homedir(), '.claude.json')
    try { env = envFromClaudeJson(file, name) } catch (e) { console.error(`nostrclaw doctor: ${e instanceof Error ? e.message : String(e)}`); return 2 }
  }
  for (const [k, v] of Object.entries(process.env)) if (k.startsWith('NOSTRCLAW_')) env[k] = v // the shell can override what the registration says
  const report = await runDoctor(env, { checkSigner: flag('--check-signer') })
  console.log(flag('--json') ? JSON.stringify(report, null, 2) : formatReport(report, !!process.stdout.isTTY))
  return report.summary.fail > 0 ? 1 : 0
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args[0] === 'doctor') { process.exit(await doctor(args.slice(1))) }
  if (args[0] === '--version' || args[0] === '-v') { console.log(VERSION); return }
  if (args[0] === '--help' || args[0] === '-h') { console.log(USAGE); return }
  if (args.length) { console.error(`nostrclaw: unknown argument "${args[0]}"\n\n${USAGE}`); process.exit(2) }
  const cfg = loadConfig()
  const server = createServer(cfg)
  await server.connect(new StdioServerTransport())
  console.error(`nostrclaw ${VERSION} ready (${cfg.signing.enabled ? 'signing ENABLED' : 'read-only'}) — relays: ${cfg.relays.join(', ')}`)
}

main().catch((e) => {
  console.error(`nostrclaw: ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
})
