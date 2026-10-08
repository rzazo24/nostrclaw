import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from 'nostr-tools'
import type { Config } from '../src/config.js'
import { createServer } from '../src/server.js'
import type { SigningContext } from '../src/signing/tools.js'
import type { NostrApi } from '../src/nostr/client.js'

export const cfg = (over: Partial<Config> = {}): Config => ({
  relays: ['wss://relay.example.com'], allowPrivate: false, timeoutMs: 2000, maxEvents: 500,
  signing: { enabled: false, signerRelays: ['wss://relay.powr.build', 'wss://relay.example.com'], configDir: '/nonexistent/config', stateDir: '/nonexistent/state' },
  ...over,
})

export function key() {
  const sk = generateSecretKey()
  return { sk, pk: getPublicKey(sk) }
}

export function ev(k: { sk: Uint8Array }, kind: number, content: string, created_at: number, tags: string[][] = []): Event {
  return finalizeEvent({ kind, content, created_at, tags }, k.sk)
}

/** An MCP client connected to a server in the same process. */
export type Elicit = (message: string) => { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> }

/** `elicit` makes the client support (and answer) the server's questions to the user, as Claude Code's UI would. */
export async function connect(c: Config, api?: NostrApi, clock?: () => number, elicit?: Elicit, signing?: SigningContext) {
  const server = createServer(c, api, clock, signing)
  const [a, b] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0' }, elicit ? { capabilities: { elicitation: {} } } : undefined)
  if (elicit) client.setRequestHandler(ElicitRequestSchema, async (req) => elicit((req.params as { message: string }).message))
  await Promise.all([server.connect(a), client.connect(b)])
  return { client, close: async () => { await client.close(); await server.close() } }
}

export type Tool = Awaited<ReturnType<typeof connect>>['client']
export async function call(client: Tool, name: string, args: Record<string, unknown> = {}) {
  const r = await client.callTool({ name, arguments: args })
  const text = (r.content as { type: string; text: string }[])[0]!.text
  return { isError: !!r.isError, text, json: r.isError ? null : JSON.parse(text) }
}
