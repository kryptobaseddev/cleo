# PRIME Session Startup — 2026-03-31

## Identity
You are cleoos-opus-orchestrator (PRIME). You manage 8 agents across CleoCode and SignalDock.

## Immediate: T254 — Audit all task statuses against code
```bash
# 1. Check what's actually committed
git log --oneline -30
git -C /mnt/projects/signaldock log --oneline -15

# 2. Check uncommitted work
git status --short | wc -l
git -C /mnt/projects/signaldock status --short | wc -l

# 3. For each "done" task from session 2026-03-30, verify commit exists
# Tasks to verify: T211, T185, T191, T202, T184, T215, T229, T221, T223, T224, T225, T183, T009, T011, T092-T096, T228, T235, T239, T242, T247

# 4. For each "cancelled" task, verify it's truly a duplicate
# Cancelled: T234, T235, T236, T237, T238, T241, T243, T244, T248, T228

# 5. Check 51 uncommitted files — what needs committing?
git diff --stat HEAD
```

## Then: T234 Epic — Agent Domain Unification
Priority subtasks:
- T236: Wire `cleo agent start` to use LocalTransport
- T237: Deduplicate capabilities/skills storage  
- T238: Cross-DB write-guards
- T240: Scaffold .cant on register
- T245: Fix phantom FKs
- T246: FK on messages
- T249: E2E lifecycle test
- T251: Version bump + npm publish
- T252: Validate init/upgrade/doctor
- T253: llmtxt upgrade

## Key Facts
- signaldock.db = SSoT for agent identity (T235 decision)
- agent_credentials in tasks.db = cache for encrypted keys
- `cleo agent start` EXISTS in dev build but FAILS (transport_type column issue)
- installed CLI is v2026.3.76 on npm, dev build has 30+ more commits
- LocalTransport PROVEN working (bidirectional messaging via signaldock.db)
- SSE cloud PROVEN working (HTTP 200 through Cloudflare after fix 77abf8d)
- .cant handles config, .md handles narrative — both needed
- Architecture: Agent → Conduit → Transport (Local/SSE/HTTP) → SignalDock
- PRIME uses cleo-prime-dev credential for Conduit, cleoos-opus-orchestrator for ClawMsgr backup
- Greenfield project — NO backwards compatibility

## Agent Matrix
Planning group: 97946d67-9709-44e9-9df9-98751b765cd9
CleoCode: cleo-rust-lead, cleo-db-lead, cleo-dev, cleo-historian
SignalDock: signaldock-core-agent, signaldock-backend, signaldock-frontend, signaldock-dev

## ClawMsgr Config
/mnt/projects/cleocode/.cleo/clawmsgr-cleoos-opus-orchestrator.json

## Workspace
/mnt/projects/workspaces/cleocode-unification/

## Owner Vision: CLEO Daemon (T255)
Owner wants Docker-like pattern: `cleod` (daemon always running) + `cleo` (CLI remote control).
Any `cleo` command auto-starts daemon if not running. Daemon manages Conduit, agents, TTY tracking.
Cross-platform. PID file. Graceful timeout. Event bus instead of DB polling.
THIS DOES NOT EXIST YET — it's the next major architectural piece after T234.
Read memory: cleo-daemon-vision.md

## Agent DB Problems (T234)
cleo-db-lead found 5 critical issues: agent_id means different things, 3 disconnected agent concepts,
phantom FKs, no FK on messages, duplicate storage. T235 (SSoT decision) and T239 (spec update) are done.
T236-T253 remain. Read memory: agent-domain-audit.md

## Rules
- NEVER mark tasks done without git verification (feedback_verify_before_marking.md)
- NEVER contact human owner from agent — escalate to PRIME only
- Verify code before trusting any agent claim
- Test for REAL, not mock — actually run `cleo agent start` and prove it works
- Local-first, cloud-additive
- Provider-agnostic — no slash commands for connection
- Greenfield — no backwards compatibility needed
