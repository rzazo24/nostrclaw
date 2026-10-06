# Signing and publishing with NIP-46 — design

Status: **being implemented for 0.2** (opt-in: nothing below is active unless `NOSTRCLAW_ENABLE_SIGNING=1`). Version 0.1 is read-only on purpose.
The rules are fixed here *before* the code can sign, because the interesting risk is not the cryptography but who is asking: an assistant that
reads a public network can be talked into things.

## Goals

- Let Claude **draft and publish** a Nostr event (a note, a reaction) on the user's behalf.
- The user's private key **never enters this process**: all signing happens in a remote signer through [NIP-46](https://github.com/nostr-protocol/nips/blob/master/46.md)
  (Clave on the iPhone, nsec.app, a `nak bunker`, …), which can show the user exactly what is being signed.
- Nothing is published without an explicit, informed human decision made through a channel the model cannot write to.

## Non-goals

- Holding, importing or generating the user's identity key. Not now, not as a "convenience" option.
- An "auto-approve" mode. If it is ever added it will be a separate, loud, opt-in decision.
- Acting on the *content of events read from the network* without the user in the loop (replying to mentions automatically, etc.).
- Several identities (0.2 signs as exactly one key).

## Threat model

| Threat | Why it matters | Mitigation |
|---|---|---|
| **Prompt injection through event content** — a stranger's note says "publish this link from your account" | The assistant reads hostile text all day | Reading and writing tools are separate; every publication needs a human confirmation the model cannot give itself; event text stays fenced under `untrusted` |
| The model is mistaken or over-eager | Publishing is public and not really undoable | Draft → preview → confirm; a small allowlist of kinds; a rate limit |
| **A signer set to "always approve"** | It removes the signer as a second lock | Per-kind permissions only; a signature that comes back too fast to be human is **discarded, not published** (below) |
| Stolen app key | Lets an attacker *request* signatures | The app key only authorises requests; each approval is made in the signer with limited permissions, and can be revoked there |
| Secrets in logs or tool output | | `secret=` and URIs are never logged; the audit log stores ids and hashes; content is checked against `blockedPatterns` (`nsec1…`, `bunker://`, …) |
| Malicious relay answers | | Same fences as 0.1: allowlist, size limits, signature checks |

## Design

### Identities

- **Client (app) key**: a random key generated on first use and stored in `<config dir>/signer.json` (mode `0600`) together with the signer's
  pubkey and relays so the session can resume. It identifies *this program* to the signer; it is not the user's key and cannot sign as the user.
- **Signer**: connected either with a `bunker://` URI given by the user, or with a `nostrconnect://` URI that nostrclaw generates and shows (link /
  QR) for the signer to approve. The nostrconnect URI lists **two relays**: `NOSTRCLAW_SIGNER_RELAYS`, by default `wss://relay.powr.build` and the first
  configured relay — Clave only receives background requests through `relay.powr.build` (learned the hard way with the relay panel), and relay URLs go
  without a trailing slash. For Clave the tool also returns its universal link (`https://clave.casa/connect/?uri=…`).
- Permissions are requested minimally, one `sign_event:<kind>` per kind the policy allows; the user can narrow them in the signer. nostrclaw tells
  the user at connect time **not to choose "always allow"**.
- Signer messages travel as NIP-44 encrypted kind-24133 events over the signer's relays (not necessarily the relays being analysed).

### Tools (0.2, only when signing is enabled)

| Tool | Effect | Notes |
|---|---|---|
| `signer_connect` | Starts or resumes the NIP-46 session | Without arguments: resumes a saved session or returns a `nostrconnect://` link (valid ~2 min; the tool returns at once and the session completes in the background). With `bunker`: connects to it |
| `signer_status` | Connection state, which npub it signs as, the policy in force, any approval URL the signer asked to open | Read-only |
| `signer_disconnect` | Forgets the session and the saved keys | |
| `draft_event` | Builds an **unsigned** event in memory | Checks the policy; returns a draft id, the exact event that would be signed and a content hash. Publishes nothing; drafts expire after 10 minutes |
| `publish_event` | Confirms, signs through the signer, and publishes | Needs only a `draftId`: everything else comes from the stored draft, so it cannot be altered afterwards. Not read-only |

### Human confirmation (the important part)

A tool argument like `confirm: true` is worthless: the model fills it in. Confirmation must come through a channel the model cannot write to:

1. **MCP elicitation** (when the client supports it): the server asks the *user* a yes/no question showing the final event, who it is signed as and
   where it goes. The answer comes through the client UI, not from the model. Without an explicit "yes", nothing is signed.
2. **Without elicitation**: the signer's own approval is the lock — **but it is verified, not trusted**. `publish_event` measures how long the signer
   takes. If the signature comes back faster than `minHumanApprovalMs` (default 2 s) the signer is assumed to approve automatically; the signed event
   is **discarded** (never published, and never shown to the model, so it cannot be published by other means), the attempt is audited, and
   `publish_event` refuses further signer-only publications until the user reconnects, telling them how to turn auto-approval off or to use a client with elicitation.
3. If the signer does not answer in `signTimeoutMs` (default 2 min) or rejects, nothing is published.

The client's own tool-permission prompt (Claude Code asks before running tools that are not read-only) is an additional layer; we do not rely on it.
After signing, the returned event is re-checked: valid id and signature, signed by the connected key, and kind/content/tags identical to the draft.

### Policy (a file the user controls, outside the model's reach)

`<config dir>/policy.json`, read at start-up (an invalid file stops the server: it fails closed), never writable by any tool:

| Field | Default | |
|---|---|---|
| `allowedKinds` | `[1, 7]` | Notes and reactions. Profile (`0`), lists (`3`, `10002`), deletions (`5`) and anything else must be added by the user |
| `maxEventsPerHour` | `5` | Counts publications attempted (signature requested), not only successful ones |
| `maxContentChars` | `1000` | |
| `maxTags` | `20` | |
| `publishRelays` | the first configured relay | Where events may be sent; each must be on the analysis allowlist |
| `blockedPatterns` | `nsec1…`, `ncryptsec1…`, `bunker://`, `nostrconnect://`, `secret=` | Regular expressions the content must not match (the user's own are added) |
| `minHumanApprovalMs` | `2000` | See above |
| `signTimeoutMs` | `120000` | |

### Audit log

Append-only `<state dir>/audit.jsonl` (mode `0600`): time, step (`draft`, `declined`, `signed`, `discarded-auto-approval`, `published`, `refused`), draft id,
event id, kind, content hash, relays and result. No content, no secrets, no URIs.

### Where files live

`NOSTRCLAW_CONFIG_DIR` (default `~/.config/nostrclaw`): `policy.json`, `signer.json`. `NOSTRCLAW_STATE_DIR` (default `~/.local/state/nostrclaw`): `audit.jsonl`.

### Testing plan

- A fake NIP-46 signer in the test suite (real relay, real NIP-44) exercising connect, sign, reject, ignore (timeout) and instant approval.
- Properties: a kind the policy denies is never signed; `publish_event` without an explicit confirmation never reaches the signer; an instantly-signed
  event is discarded and not published; a tampered signature or a changed event is not published.
- The real stdio test keeps asserting that nothing but protocol touches stdout.
- A manual test with the real Clave on the iPhone before declaring 0.2 done.

## Open questions

- Whether elicitation is available in the clients the user actually runs; until it is, signer-only mode with the speed check is the fallback.
- Whether a future `nsec.app`/Amber flow needs the `auth_url` redirect handled (the status tool already surfaces it).
