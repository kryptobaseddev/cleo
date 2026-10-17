---
id: goal-tick-provider-env
tasks: [T13884]
kind: feat
summary: the Stop dispatcher passes CLEO_HOOK_PROVIDER (claude-code or codex) to the goal tick
---

`cleo hook stop --provider <p>` now spawns the goal tick with
`CLEO_HOOK_PROVIDER=<p>` added to the inherited environment, so `cleo-goal tick`
can tell which harness's Stop it is answering. The name is exported as
`GOAL_TICK_PROVIDER_ENV` from `@cleocode/contracts/goal-runtime.js`.
