---
id: t11947-t11951-m7-agent-tool-catalog
tasks: [T11947, T11948, T11949, T11950, T11951]
kind: feat
summary: M7 agent-tool catalog — 5 new built-in harness tools (memory / mcp / run_skill / cron-todo / vision-media)
---

Adds five new agent-tool families to the harness `AgentToolRegistry`, each in its own
file under `packages/core/src/tools/` and registered via `registerBuiltinAgentTools`.
Every family CONSUMES an existing subsystem (no new store, no new loader, no raw
provider client):

- **T11947 — memory** (`memory_search` / `memory_observe` / `memory_fetch` /
  `memory_timeline`): delegate to the existing BRAIN ops (`memory/engine-compat.ts`).
  Always available daemon-OFF.
- **T11948 — native MCP client (fan-in)**: connect-time `initialize` → `tools/list`
  → register each remote tool as a live-only proxy `AgentToolDescriptor`; stdio/sse/http
  via an `McpTransport` seam, no external MCP SDK. Replaces the external mcp-tool dep
  for the host-loop path.
- **T11949 — `run_skill`**: bridges the existing SKILL.md loader (`skills/discovery.ts`
  `findSkill` + `dispatchExplicit`) to the loop; surfaces only invocable skills.
- **T11950 — cron/todo** (`todo_add` / `todo_list` / `cron_schedule`): `todo_*` delegate
  to the task store ops; `cron_schedule` is registered but gated unavailable until a
  schedule store ships (follow-up T11962 under T11679) — no schema invented.
- **T11951 — vision/media** (`vision_analyze` / `image_generate` / `text_to_speech`):
  the first occupants of the `media` toolset; every model call routes through the E9
  chokepoint (`resolveLLMForSystem` / `ModelRunner`) exactly like `browser_vision`
  (Gate-13). Hidden unless egress is allowed AND a multimodal model is advertised.
