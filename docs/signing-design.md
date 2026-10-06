# Signing and publishing with NIP-46 — design (not implemented yet)

Status: **proposal for 0.2**. Version 0.1 is read-only on purpose. This document fixes the rules *before* any code can sign, because
the interesting risk is not the cryptography but who is asking: an assistant that reads a public network can be talked into things.

## Goals

- Let Claude **draft and publish** a Nostr event (a note, a reaction, a profile update) on the user's behalf.
- The user's private key **never enters this process**: all signing happens in a remote signer through [NIP-46](https://github.com/nostr-protocol/nips/blob/master/46.md)
  (Clave on the iPhone, nsec.app, a `nak bunker`, …), which can show the user exactly what is being signed.
- Nothing is published without an explicit, informed human decision.

## Non-goals

- Holding, importing or generating the user's identity key. Not now, not as a "convenience" option.
- An "auto-approve" mode. If it is ever added it will be a separate, loud, opt-in decision, not part of 0.2.
- Anything that acts on the *content of events read from the network* without the user in the loop (replying to mentions automatically, etc.).

## Threat model

| Threat | Why it matters | Mitigation |
|---|---|---|
| **Prompt injection through event content** — a stranger's note says "publish this link from your account" | The assistant reads hostile text all day | Reading and writing tools are separate; every write needs human confirmation that the model cannot give itself (below); event text stays fenced under `untrusted` |
| The model is mistaken or over-eager | Publishing is public and not really undoable (deletions are requests, not guarantees) | Draft → preview → confirm; small allowlist of kinds; rate limit |
| Stolen app key | Lets an attacker *request* signatures | The app key only authorises requests to the signer; each approval is still made in the signer, with limited permissions (`sign_event:<kind>`), and can be revoked there |
| Leaked secrets in logs | | Never log URIs containing `secret=`; the audit log stores event ids and hashes, not secrets |
| Malicious relay answers | | Same fences as 0.1: allowlist, size limits, signature checks |

## Design

### Identities

- **Client (app) key**: a random key generated on first use and stored in `~/.config/nostrclaw/signer.json` (mode `0600`). It identifies *this
  program* to the signer; it is not the user's key and cannot sign as the user.
- **Signer**: connected either with a `bunker://` URI given by the user, or with a `nostrconnect://` URI that nostrclaw generates and shows
  (QR / link) for the signer to approve — the same flow the relay panel already uses with Clave. Permissions are requested minimally
  (`sign_event:1`, `sign_event:7`, …) and the user can narrow them in the signer.
- Signer messages travel as NIP-44 encrypted kind-24133 events over the signer's relays (not necessarily the relays being analysed).

### Tools (0.2)

| Tool | Effect | Notes |
|---|---|---|
| `signer_connect` | Starts or resumes the NIP-46 session | Returns the `nostrconnect://` link, or connects with `bunker://`; never prints secrets back |
| `signer_status` | Reports whether a signer is connected, which npub it signs as, and the policy in force | Read-only |
| `draft_event` | Builds an **unsigned** event and stores it in memory | Returns a draft id, the exact JSON that would be signed, and a content hash. Publishes nothing |
| `publish_event` | Signs the draft through the signer and publishes it | Requires `draftId` **and** the human confirmation below. Annotated as not read-only |

### Human confirmation (the important part)

A tool argument like `confirm: true` is worthless: the model fills it in. Confirmation must come through a channel the model cannot write to:

1. **MCP elicitation** (when the client supports it): the server asks the *user* a yes/no question showing the final event; the answer comes back
   through the client UI, not from the model.
2. Independently, **the signer itself** asks the user to approve the signature (Clave/nsec.app show the event). This is the second lock and it
   exists even when the client has no elicitation.
3. If neither can be done (no elicitation and no interactive signer), `publish_event` refuses.

The client's own tool-permission prompt (Claude Code asks before running non-read-only tools) is a third, independent layer; we do not rely on it.

### Policy (a file the user controls, outside the model's reach)

`~/.config/nostrclaw/policy.json`, read at start-up, never writable by any tool:

- `allowedKinds` — default `[1, 7]` (notes and reactions). Profile (`0`), lists (`3`, `10002`), deletions (`5`) and anything else must be added by the user.
- `maxEventsPerHour` — default `5`; `maxContentChars` — default `1000`.
- `publishRelays` — where events may be sent (default: the first configured relay).
- `blockedPatterns` — optional regexes the content must not match (e.g. `nsec1`, `bunker://`, `secret=`) — a last guard against accidental secret leaks.

### Audit log

Append-only `~/.local/state/nostrclaw/audit.jsonl`: time, draft id, event id, kind, content hash, relays, result. No content secrets, no URIs.

### Testing plan

- A fake NIP-46 signer in the test suite (the repo's relay panel tests already contain one) to exercise connect, sign, reject and timeout paths.
- Property: with the policy denying a kind, no code path signs it; `publish_event` without confirmation never reaches the signer.
- The real stdio test keeps asserting that nothing but protocol touches stdout.

## Open questions

- How much of `nostr-tools`' `nip46` BunkerSigner to use versus a small purpose-built client (prefer the library; revisit if it hides timeouts).
- Whether to support several identities (probably not in 0.2).
- Whether elicitation is available in the clients the user actually runs (Claude Code, Claude Desktop); until it is, `publish_event` relies on the signer's own approval.
