# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

`nostrclaw`: a TypeScript MCP server (stdio) that lets an assistant analyse a Nostr relay. It is **read-only by default**; publishing with NIP-46 exists
but only behind `NOSTRCLAW_ENABLE_SIGNING=1` (`src/signing/`, rules in `docs/signing-design.md`).

## Commands

```bash
npm run build        # tsc -p tsconfig.build.json -> dist/
npm run typecheck
npm test             # builds first (pretest), then vitest
RELAY_BIN=../nostr-relay-khatru/nostr-relay-khatru npm test   # includes the end-to-end tests (real relay, real stdio); skipped without a binary
```

## Rules that must not be broken

- **stdout is the protocol.** Never `console.log` in server code; use `console.error`. The stdio test fails if anything else reaches stdout.
- **Everything from the network is hostile.** Third-party text (event content, profile fields, relay descriptions) goes through `cleanText` and is returned
  only under an `untrusted` key. Signals and statistics must not contain third-party text (tests check this).
- **The analysis tools are read-only** and declare `readOnlyHint: true`; the catalogue test enforces it. Tools that write live only in `src/signing/` and are
  registered only when signing is enabled. **Signing rules** (tests in `test/signing.test.ts` guard each): the user's key is never in this process; a human decision
  comes through MCP elicitation (a channel the model cannot write to) or, without it, a signer that took human time (a too-fast signature is discarded and never
  published); `publish_event` takes only a draft id; the signed event never goes back into tool output; `policy.json` is user-owned and read-only to every tool,
  and an invalid one stops the server; no secrets or content in the audit log. Do not add an auto-approve mode. `nostrclaw doctor` (src/doctor.ts) is read-only and must stay so: it never signs, never publishes, never prints the app key; `--check-signer` only resumes and pings. Known limit: a model with a shell can read the saved
  app key, so only the signer's manual approval protects against it (docs/signing-design.md, "Known limitation").
- **Relays are an allowlist** (`NOSTRCLAW_RELAYS`), the private-address guard applies to the default relay too, redirects are not followed.
- Verify signatures on every event fetched; keep output bounded.

## Layout

`src/signing/` (policy, NIP-46 session, tools, audit) · `src/server.ts` tools · `src/analysis.ts` pure analysis (no network) · `src/safety.ts` allowlist and text cleaning · `src/nostr/client.ts` the only network code ·
`test/` unit tests with a fake `NostrApi` (`tools.test.ts`) and end-to-end tests with the real relay (`e2e.test.ts`, `relay-harness.ts`).
