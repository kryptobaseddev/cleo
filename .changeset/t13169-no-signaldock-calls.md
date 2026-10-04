---
id: t13169-no-signaldock-calls
tasks: [T13169]
kind: fix
summary: No CLEO code path calls a SignalDock host any more (SignalDock is retired), and cleo conduit peek no longer acks the messages it shows
---

SignalDock (api.signaldock.io) is retired and its servers are being deleted. Agent rows registered before the retirement still carry its URL, because the `api_base_url` column defaults to it and CLEO never rebuilds a table to change a default. CLEO therefore stops trusting the stored URL.

- Every agent cloud-messaging request now goes through one gate, `conduitFetch` (`@cleocode/core/conduit`). It refuses a SignalDock host, or any subdomain of one, before any network I/O, with `E_SIGNALDOCK_RETIRED`.
- The HTTP and SSE transports refuse a SignalDock endpoint when they connect, and the conduit factory never treats one as cloud-backed.
- The runtime's poller fallback and heartbeat use the gate. `createRuntime` starts no heartbeat or key rotation for a SignalDock agent.
- `cleo agent start`, `stop`, `stop-all`, `signin`, `rotate-key` and `claim-code`, and `cleo conduit status`, `peek` and `send`, all use the gate:
  - best-effort status pings skip SignalDock silently;
  - `rotate-key`, `claim-code`, `conduit peek` and `conduit send` fail with `E_SIGNALDOCK_RETIRED`;
  - `conduit status` reports the agent disconnected, with the reason.
- `cleo agent register` defaults `--api-url` to `local` and refuses a SignalDock URL. `cleo agent install` records `local`. `claim-code` no longer invents a signaldock.io claim URL.
- Local messaging through the project conduit store is unchanged. No data, row or table is removed.

`cleo conduit peek` was documented as reading without consuming, but it acked every message it returned, so the recipient's own poll never saw them. Peek now only reads: a second peek, and the recipient, still see every message.
