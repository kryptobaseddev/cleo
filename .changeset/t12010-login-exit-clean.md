---
id: t12010-login-exit-clean
tasks: [T12010]
kind: fix
summary: cleo login exits cleanly after OAuth success — pause stdin after paste-back read to release the event-loop hold
---

Fixes owner-reported hang: `cleo login anthropic` completed the browser OAuth flow (credential stored, selector working) but the process never exited and had to be killed hours later.

Root cause: `_headlessPkceFlow` in `packages/cleo/src/cli/commands/llm-login.ts` calls `process.stdin.resume()` to un-pause stdin so the user can paste the authorization code back. After `process.stdin.once('data', handler)` fires and the Promise resolves, `stdin` remains in flowing mode. A flowing `Readable` stream keeps the Node.js event loop alive indefinitely, preventing the process from exiting even after all application work is complete.

Fix: call `process.stdin.pause()` as the first statement inside the `once('data', ...)` handler — before `resolve` or `reject` — on every exit path (success, missing-code error, CSRF state-mismatch error). This stops the flow immediately after consuming one chunk and lets the event loop drain naturally.

Three regression tests assert that `process.stdin.pause` is invoked on the success path, the no-code-in-URL error path, and the CSRF-state-mismatch error path. The fix does not affect `--api-key-stdin` piped mode, `cleo auth login`, or interactive provider-picker prompts (which use `ReadlineWizardIO`, not raw stdin).
