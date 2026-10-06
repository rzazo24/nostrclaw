# nostrclaw

*Leer en español: [README.es.md](README.es.md)*

An [MCP](https://modelcontextprotocol.io) server that lets Claude **analyse a Nostr relay**: is it healthy, what does it advertise, what is going through it, and which keys look suspicious. It is **read-only**. Publishing and signing with a remote signer ([NIP-46](https://github.com/nostr-protocol/nips/blob/master/46.md)) is designed but deliberately **not enabled yet**: see [docs/signing-design.md](docs/signing-design.md).

Written in TypeScript on the official MCP SDK and `nostr-tools`. It runs locally over stdio (Claude Code, Claude Desktop) and talks to the relays you allow, nothing else.

## Quick start

```bash
git clone https://github.com/rzazo24/nostrclaw && cd nostrclaw
npm install && npm run build

# Claude Code
claude mcp add nostrclaw -e NOSTRCLAW_RELAYS=wss://relay.hivescope.xyz -- node "$PWD/dist/index.js"
```

Claude Desktop (`claude_desktop_config.json`):

```json
{ "mcpServers": { "nostrclaw": {
  "command": "node", "args": ["/absolute/path/to/nostrclaw/dist/index.js"],
  "env": { "NOSTRCLAW_RELAYS": "wss://relay.hivescope.xyz" }
} } }
```

Then ask Claude things like *“Audit my relay”*, *“What is the traffic of the last 24 hours made of?”* or *“Look at this key: npub1…”*. The `audit_relay` prompt walks through a full review.

## Tools

| Tool | What it does |
|---|---|
| `nostrclaw_status` | How the server is configured (allowed relays, limits) and that it is read-only |
| `relay_overview` | Reachability and latency (HTTP and WebSocket), NIP-11 document (NIPs, limits, policies) and, if the relay publishes them, its public statistics |
| `recent_events` | Newest events, filterable by kind, author and age; content cleaned and truncated; signatures verified |
| `count_events` | NIP-45 `COUNT` without downloading anything, with a clear message if unsupported |
| `activity_report` | Analysis of a sample: counts by kind, events per hour, top authors, the same text from several keys, bursts from one key, share of single-event authors, and a short list of signals |
| `author_report` | One key: profile (kind 0), follows, relay list, activity on this relay |

## Safety model

An assistant reading a public network is exposed to text written by strangers, so the design assumes **everything from the network is hostile**:

- **Read-only.** No tool publishes, signs, deletes or changes anything. Every tool declares `readOnlyHint`.
- **Untrusted text is fenced.** Event content, profile fields and the relay's own description are returned only under an `untrusted` key, with a note telling the model to treat it as data and never follow instructions found in it. Signals and statistics never contain third-party text.
- **Hidden characters are removed** from everything third-party (zero-width, bidirectional overrides, control and Unicode “tag” characters) and long text is truncated.
- **Relay allowlist.** Tools only talk to the relays in `NOSTRCLAW_RELAYS`, so a prompt cannot make this process connect elsewhere. Local and private addresses are refused unless `NOSTRCLAW_ALLOW_PRIVATE=1`, HTTP redirects are not followed and responses are size-limited.
- **Signatures are verified**; events with a bad signature are dropped and counted.
- **Bounded output**: limits on events per call, sample sizes and timeouts.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `NOSTRCLAW_RELAYS` | `wss://relay.hivescope.xyz` | Comma-separated relays the tools may use; the first is the default |
| `NOSTRCLAW_ALLOW_PRIVATE` | off | `1` allows localhost / private-network relays (development) |
| `NOSTRCLAW_TIMEOUT_MS` | `8000` | Per-request timeout (500–60000) |
| `NOSTRCLAW_MAX_EVENTS` | `500` | Most events any single call may fetch (1–2000) |

## Development

```bash
npm test                    # builds, then unit tests (safety, analysis, tools with a pretend network)
RELAY_BIN=/path/to/nostr-relay-khatru npm test   # …plus end-to-end tests against a real relay and over real stdio
```

Without `RELAY_BIN` the end-to-end tests are skipped (a sibling checkout of [nostr-relay-khatru](https://github.com/rzazo24/nostr-relay-khatru) is picked up automatically). CI builds that relay and runs everything.

| File | What it does |
|---|---|
| `src/server.ts` | The tools and the `audit_relay` prompt |
| `src/analysis.ts` | The analysis: pure functions over events (no network) |
| `src/safety.ts` | Relay allowlist, private-address guard, cleaning of third-party text |
| `src/nostr/client.ts` | Minimal read-only Nostr client (REQ, COUNT, NIP-11, `/stats.json`) |
| `src/config.ts`, `src/index.ts` | Configuration and the stdio entry point |

## Roadmap

1. **0.1 (now)**: read-only analysis.
2. **0.2**: NIP-46 signing — connect to a remote signer (Clave, nsec.app, a bunker), draft events, publish only after explicit human confirmation. Design and threat model in [docs/signing-design.md](docs/signing-design.md).
3. Later: more analysis (multi-relay comparison, follow-graph / web-of-trust signals).

## License

MIT
