# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

`nostrclaw`: a TypeScript MCP server (stdio) that lets an assistant analyse a Nostr relay. **Version 0.x is read-only.** The plan for
signing/publishing with NIP-46 is in `docs/signing-design.md`; do not implement signing without following it (human confirmation through a channel the
model cannot write to, a user-owned policy file, no private key in this process).

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
- **Every tool is read-only** and declares `readOnlyHint: true`; the catalogue test enforces it. A tool that writes needs its own design review.
- **Relays are an allowlist** (`NOSTRCLAW_RELAYS`), the private-address guard applies to the default relay too, redirects are not followed.
- Verify signatures on every event fetched; keep output bounded.

## Layout

`src/server.ts` tools · `src/analysis.ts` pure analysis (no network) · `src/safety.ts` allowlist and text cleaning · `src/nostr/client.ts` the only network code ·
`test/` unit tests with a fake `NostrApi` (`tools.test.ts`) and end-to-end tests with the real relay (`e2e.test.ts`, `relay-harness.ts`).
