#!/usr/bin/env node
// Entry point: serves MCP over stdio (what Claude Code and Claude Desktop use). stdout carries the protocol, so everything we want to
// say goes to stderr.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { loadConfig, VERSION } from './config.js'
import { createServer } from './server.js'

async function main(): Promise<void> {
  const cfg = loadConfig()
  const server = createServer(cfg)
  await server.connect(new StdioServerTransport())
  console.error(`nostrclaw ${VERSION} ready (${cfg.signing.enabled ? 'signing ENABLED' : 'read-only'}) — relays: ${cfg.relays.join(', ')}`)
}

main().catch((e) => {
  console.error(`nostrclaw: ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
})
