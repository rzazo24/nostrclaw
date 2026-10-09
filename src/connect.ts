// `nostrclaw connect-bunker`: pairs with the user's signer through a bunker:// address typed in a terminal. The address carries a secret, so it is read
// WITHOUT echo (or from a pipe) and never printed, logged or passed through the assistant: it does not go through an MCP tool call. The new session replaces the
// saved one only when the signer has answered, and the old one is copied aside first.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { nip19 } from 'nostr-tools'
import { loadConfig, type Config } from './config.js'
import { envFromClaudeJson } from './doctor.js'
import { SignerManager } from './signing/signer.js'

export const BACKUP_NAME = 'signer.json.bak-before-bunker'

/** The NOSTRCLAW_* settings the same way `doctor` finds them: from a registered Claude Code server (--claude <name>) and/or this shell. */
export function settingsFromArgs(args: string[], who: string): Record<string, string | undefined> {
  const value = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined }
  const name = value('--claude')
  if (args.includes('--claude') && !name) throw new Error(`${who}: --claude needs the name of the registered server, e.g. nostrclaw-sign`)
  let env: Record<string, string | undefined> = {}
  if (name) env = envFromClaudeJson(value('--claude-file') ?? path.join(os.homedir(), '.claude.json'), name)
  for (const [k, v] of Object.entries(process.env)) if (k.startsWith('NOSTRCLAW_')) env[k] = v // the shell can override what the registration says
  return env
}

/** One line from the terminal, typed or pasted without being shown (a pipe is read as it is). Ctrl-C and Esc give up. */
export function readHiddenLine(input: NodeJS.ReadStream, output: { write(s: string): unknown }, prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!input.isTTY) {
      let data = ''
      input.setEncoding('utf8')
      input.on('data', (c) => { data += c })
      input.on('end', () => resolve(data.split(/\r?\n/)[0]?.trim() ?? ''))
      input.on('error', reject)
      return
    }
    output.write(prompt)
    let line = ''
    const done = (fn: () => void) => { input.setRawMode?.(false); input.pause(); input.removeListener('data', onData); output.write('\n'); fn() }
    const onData = (chunk: Buffer | string) => {
      for (const ch of String(chunk)) {
        if (ch === '\u0003' || ch === '\u001b') return done(() => reject(new Error('cancelled')))
        if (ch === '\r' || ch === '\n') return done(() => resolve(line.trim()))
        if (ch === '\u007f' || ch === '\b') line = line.slice(0, -1)
        else if (ch >= ' ') line += ch
      }
    }
    input.setRawMode?.(true)
    input.setEncoding('utf8')
    input.resume()
    input.on('data', onData)
  })
}

/** Whatever the library or the relay said, minus anything that looks like the address or its secret. */
export const redact = (text: string): string => text.replace(/bunker:\/\/\S*/gi, '[bunker address]').replace(/secret=[^\s&"']*/gi, 'secret=[hidden]')

export interface ConnectDeps {
  readUri?: () => Promise<string>
  out?: (s: string) => void
  err?: (s: string) => void
  manager?: (cfg: Config) => SignerManager
  env?: Record<string, string | undefined>
}

export async function runConnectBunker(args: string[], deps: ConnectDeps = {}): Promise<number> {
  const out = deps.out ?? ((s) => console.log(s)), err = deps.err ?? ((s) => console.error(s))
  let cfg: Config
  try { cfg = loadConfig(deps.env ?? settingsFromArgs(args, 'nostrclaw connect-bunker')) } catch (e) { err(`nostrclaw connect-bunker: ${redact(e instanceof Error ? e.message : String(e))}`); return 2 }
  if (!cfg.signing.enabled) { err('nostrclaw connect-bunker: signing is not enabled in these settings (NOSTRCLAW_ENABLE_SIGNING=1). Use --claude <name> with the server registered with signing, e.g. --claude nostrclaw-sign.'); return 2 }
  let uri: string
  try { uri = await (deps.readUri ?? (() => readHiddenLine(process.stdin, process.stderr, 'Paste the bunker:// address from your signer (it is not shown), then press Enter: ')))() } catch (e) { err(`nostrclaw connect-bunker: ${redact(e instanceof Error ? e.message : String(e))}`); return 2 }
  if (!/^bunker:\/\//i.test(uri)) { err('nostrclaw connect-bunker: that is not a bunker:// address (nothing was changed).'); return 2 }

  const file = path.join(cfg.signing.configDir, 'signer.json'), backup = path.join(cfg.signing.configDir, BACKUP_NAME)
  const hadSession = fs.existsSync(file)
  const manager = (deps.manager ?? ((c) => new SignerManager(c)))(cfg)
  try {
    if (hadSession) fs.copyFileSync(file, backup)
    if (hadSession) fs.chmodSync(backup, 0o600)
    await manager.connectBunker(uri, { freshKey: true })
    const who = manager.userPubkey ? nip19.npubEncode(manager.userPubkey) : 'unknown'
    out(`Connected through your bunker address. The signer signs as ${who}.`)
    out(`Session saved in ${file}${hadSession ? ` (the previous one is copied to ${BACKUP_NAME})` : ''}.`)
    out('Restart Claude Code so nostrclaw-sign loads it, then use signer_connect: it resumes this session (no link to scan).')
    return 0
  } catch (e) {
    err(`nostrclaw connect-bunker: could not connect: ${redact(e instanceof Error ? e.message : String(e))}`)
    err(hadSession ? 'The saved session was not changed.' : 'Nothing was saved.')
    err('Keep the signer app open on screen while this runs, and copy a fresh address from it (they are often single-use).')
    return 1
  } finally { await manager.close() }
}
