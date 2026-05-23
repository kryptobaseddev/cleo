---
id: t10179-executor-probe
tasks: [T10179]
kind: feat
summary: "Executor npm-pack probe (SAGA T10176)"
---

chore(T10179): Executor npm-pack probe (SAGA T10176)

Reusable probe at scripts/probes/tools-in-core-probe.mjs that validates whether the
lafs+cant tools-in-core pattern survives a clean npm-pack + tmpfs install + node require
flow. Result documented at research/t10179-executor-probe.

Verdict: release-equivalent (pnpm-pack) flow PASSES end-to-end; raw npm-pack mode fails
with EUNSUPPORTEDPROTOCOL because npm does not rewrite workspace:* markers. This is
expected since the real release pipeline uses pnpm publish — production consumers
receive correctly-rewritten manifests (verified via npm view @cleocode/cant@latest).
Pattern is safe to extend to new domains under SAGA T10176.
