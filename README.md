# nostrclaw

*Leer en español: [README.es.md](README.es.md)*

An [MCP](https://modelcontextprotocol.io) server that lets Claude **analyse a Nostr relay**: is it healthy, what does it advertise, what is going through it, and which keys look suspicious. By default it is **read-only**. Optionally (off until you enable it) Claude can also **draft and publish notes and reactions** through a remote signer ([NIP-46](https://github.com/nostr-protocol/nips/blob/master/46.md): Clave, nsec.app, a bunker) — your private key never reaches this program and every publication needs your explicit confirmation. See [Publishing](#publishing-optional-nip-46) and [docs/signing-design.md](docs/signing-design.md).

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
| `account_triage` | Lists the authors of a window whose *behaviour* looks like spam (text shared with other keys — near-copies included —, bursts, link-only posting), each point with a stated reason. Short greetings ("Azul", "gm") don't count as copying, and "high" needs two behaviour signals. Missing profile/follows/relay list on this relay adds to the score but never flags a key on its own; keys with no behaviour signal are only counted. A triage aid, not a verdict |
| `event_engagement` | One event: replies, reactions, reposts and zaps, counted from the events that reference it (up to 500; NIP-45 COUNT with tag filters answers a silent 0 on khatru+sqlite, so it is not used), reaction breakdown and distinct reactors |
| `compare_relays` | Several configured relays side by side: NIP-11 (software, NIPs, limits), latency, activity, and how much of what each holds is also on the others (mirror vs source). Compared only inside the window every sample really covers, so a busy relay is not penalised for returning only its newest events; a relay that fails is reported and the rest still compared |
| `event_locations` | For up to 20 event ids, which configured relays hold each (kind and age only, no content) |

The two comparison tools need at least two relays in `NOSTRCLAW_RELAYS` (comma-separated).

`recent_events`, `count_events` and `activity_report` also accept a `tags` filter (`{"e": [id]}`, `{"p": [pubkey]}`, `{"t": ["bitcoin"]}`).

## Publishing (optional, NIP-46)

Off by default. Enable it with `NOSTRCLAW_ENABLE_SIGNING=1` and five more tools appear:

| Tool | What it does |
|---|---|
| `signer_connect` | Resumes the saved session, or returns a `nostrconnect://` link (and Clave's universal link) for you to open in your signer. `bunker` connects to a `bunker://` URI instead |
| `signer_status` | Connection state, which npub it signs as, the policy in force, signatures requested in the last hour |
| `signer_disconnect` | Closes the session and deletes the saved app key |
| `draft_event` | Prepares an **unsigned** event and checks it against your policy. Publishes nothing |
| `publish_event` | Takes a draft id, **asks you to confirm**, has your signer sign it and sends it to your relays |

How it stays under your control:

- **Your key never leaves your signer.** nostrclaw holds only an app key that identifies it to the signer, saved with mode `0600`.
- **A human decides, through a channel the model cannot write to.** If your client supports it, `publish_event` asks *you* (MCP elicitation) showing the exact event, who signs it and where it goes; without an explicit yes nothing is signed. Your signer then asks for its own approval.
- **Use manual approval in the signer** (Clave: *low trust*). If the signer approves by itself, anything that can read the app key saved on your machine — including an assistant with a shell — could ask it for signatures with no prompt; nostrclaw warns when it sees that.
- **“Always allow” is detected.** Without elicitation, the signer's approval is the lock — so it is verified: a signature that comes back faster than a person could decide (default 2 s) is **discarded and never published**, and further publishing is refused until you fix the signer and reconnect.
- **Policy you own** (`~/.config/nostrclaw/policy.json`, no tool can write it): allowed kinds (default notes `1` and reactions `7` only), publications per hour (default 5), maximum length, relays, and blocked patterns (anything that looks like an `nsec1…`, `bunker://`, `secret=`…). An invalid file stops the server.
- **The model cannot alter or replay anything:** `publish_event` takes only a draft id; the signed event is checked against the draft and goes only to the relays, never back into the conversation.
- **Audit log** (`~/.local/state/nostrclaw/audit.jsonl`): every step with ids and hashes, never content or secrets.

Quick start with Clave on the iPhone:

```bash
claude mcp add nostrclaw -e NOSTRCLAW_ENABLE_SIGNING=1 -e NOSTRCLAW_RELAYS=wss://relay.hivescope.xyz -- node "$PWD/dist/index.js"
```

Then ask Claude to *“connect my signer”*, open the link it gives you in Clave and approve (**do not choose “always allow”**), and ask it to *“draft a note saying …”*. The connection link lists `wss://relay.powr.build` as well as your relay, because Clave only receives background requests through that one.

## Safety model

An assistant reading a public network is exposed to text written by strangers, so the design assumes **everything from the network is hostile**:

- **Read-only by default.** The analysis tools publish, sign, delete or change nothing and declare `readOnlyHint`. Writing exists only behind `NOSTRCLAW_ENABLE_SIGNING=1` and the rules above.
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
| `NOSTRCLAW_ENABLE_SIGNING` | off | `1` enables the signing tools (see Publishing) |
| `NOSTRCLAW_SIGNER_RELAYS` | `wss://relay.powr.build` + the first relay | Relays used to talk to the signer |
| `NOSTRCLAW_CONFIG_DIR` | `~/.config/nostrclaw` | `policy.json` and the saved signer session |
| `NOSTRCLAW_STATE_DIR` | `~/.local/state/nostrclaw` | `audit.jsonl` |

## Development

```bash
npm test                    # builds, then unit tests (safety, analysis, tools with a pretend network)
RELAY_BIN=/path/to/nostr-relay-khatru npm test   # …plus end-to-end tests against a real relay and over real stdio
```

The signing tests run a pretend NIP-46 signer (`test/fake-signer.ts`) through the real relay. Without `RELAY_BIN` the end-to-end tests are skipped (a sibling checkout of [nostr-relay-khatru](https://github.com/rzazo24/nostr-relay-khatru) is picked up automatically). CI builds that relay and runs everything.

| File | What it does |
|---|---|
| `src/server.ts` | The tools and the `audit_relay` prompt |
| `src/analysis.ts` | The analysis: pure functions over events (no network) |
| `src/safety.ts` | Relay allowlist, private-address guard, cleaning of third-party text |
| `src/nostr/client.ts` | Minimal read-only Nostr client (REQ, COUNT, NIP-11, `/stats.json`) |
| `src/signing/` | Publishing: `policy.ts` (your policy file), `signer.ts` (NIP-46 session), `tools.ts` (the five tools), `audit.ts` |
| `src/config.ts`, `src/index.ts` | Configuration and the stdio entry point |

## Roadmap

1. **0.1**: read-only analysis.
2. **0.2 (now)**: NIP-46 signing, opt-in — connect to a remote signer, draft events, publish only after explicit human confirmation. Design and threat model in [docs/signing-design.md](docs/signing-design.md).
3. Later: more analysis (multi-relay comparison, follow-graph / web-of-trust signals).

## License

MIT
