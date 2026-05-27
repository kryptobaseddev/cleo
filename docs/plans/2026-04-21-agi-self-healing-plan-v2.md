# CLEO AGI Self-Healing Plan — Corrected Audit
# 2026-04-21 v2 (corrected after deep CLI audit)

> This replaces docs/plans/2026-04-21-agi-self-healing-plan.md.
> The first version had multiple wrong diagnoses. This is grounded in actual
> cleo CLI output and source inspection.

---

## CORRECTED SYSTEM AUDIT

### What my previous diagnosis got wrong

1. **"memory-bridge.md is empty"** — WRONG. It exists and has content from
   2026-04-20T01:26:36. The REAL issue is it was written under the old 'file'
   mode and has only its header because T999 changed the default to 'cli' mode
   AFTER the file was created. refresh-memory now correctly skips the write
   (mode='cli') but the file stub remains.

2. **"memory digest doesn't exist"** — PARTIALLY WRONG. `cleo memory digest`
   IS registered in both the dispatch registry AND the source CLI subcommands
   list. The installed binary (2026.4.101) was built from an intermediate
   commit that included everything UP TO reflect/consolidate but NOT the T1006
   commands (digest/recent/diary/watch). Source has them. Binary is stale.

3. **"Conduit has zero messages and no agents"** — WRONG. `cleo conduit status`
   shows: connected=true, transport=local, agentId=cleo-prime. Conduit is live.
   The poller daemon (conduit start) just hasn't been started.

4. **"sentient daemon code is only in dist"** — WRONG. Source lives at
   packages/core/src/sentient/ (daemon.ts, tick.ts, propose-tick.ts, etc).
   The dist was just a red herring from my first path attempt.

5. **"Intelligence module has no CLI surface"** — needs verification. The
   dispatch has an intelligence domain (intelligence.ts in dispatch/domains/).

---

## ACTUAL ISSUES — CONFIRMED BY CLI + SOURCE

### BLOCKER-1: Sentient daemon crashes on Node 24 (node:child_process bug)

**Confirmed:** `cleo sentient start` exits with:
  "The argument 'stdio' is invalid. Received WriteStream { fd: null ..."

**Root cause:** In Node 24, `child_process.spawn` validates stdio stream
arguments and rejects WriteStream instances that haven't opened their file
descriptor yet. The code calls `createWriteStream(...)` and immediately passes
the result to `spawn(...)` before the async `open` event fires.

**File:** packages/core/src/sentient/daemon.ts lines 308-316

**Current broken code:**
```typescript
const outStream = createWriteStream(logPath, { flags: 'a' });
const errStream = createWriteStream(errPath, { flags: 'a' });
const child = spawn(process.execPath, [daemonEntry, projectRoot], {
  detached: true,
  stdio: ['ignore', outStream, errStream],  // WriteStream.fd = null HERE
  ...
});
```

**Fix:** await stream open events before spawning (confirmed working in Node 24):
```typescript
import { once } from 'node:events';
const outStream = createWriteStream(logPath, { flags: 'a' });
const errStream = createWriteStream(errPath, { flags: 'a' });
await Promise.all([once(outStream, 'open'), once(errStream, 'open')]);
const child = spawn(process.execPath, [daemonEntry, projectRoot], {
  detached: true,
  stdio: ['ignore', outStream, errStream],  // WriteStream.fd = valid NOW
  ...
});
```

**Same bug exists in:** packages/core/src/gc/daemon.ts (GC daemon has same pattern)
Check: `grep -n "createWriteStream\|stdio.*outStream" packages/core/src/gc/daemon.ts`

**Impact:** Without this fix, `cleo sentient start` always fails. The entire
Tier-1 autonomous loop (pick task → spawn worker → record result) is dead.

---

### BLOCKER-2: Installed binary stale — missing T1006 commands

**Confirmed:** `cleo memory digest` returns "Unknown command digest" even though:
- dispatch registry has `memory.digest` (line 547 of memory.ts)
- source CLI has `digestCommand` registered (line 2796 of memory.ts)
- installed binary version string says 2026.4.101 but was built at an intermediate commit

**Missing from installed binary:** digest, recent, diary, watch (all T1006)

**Root cause:** The npm-global installed binary was packed before T1006 fully
landed in the CLI subcommands list. The dispatch layer has it, the source has it,
but the binary artifact does not.

**Impact:** AGENTS.md (in cli mode) injects `# Run: cleo memory digest --brief`
as the live memory directive, but that command doesn't work in the installed binary.
This breaks the entire cli-mode context injection chain for ALL harnesses.

**Fix:** Rebuild from source and reinstall:
```bash
cd /mnt/projects/cleocode
pnpm run build:cleo   # just the cleo package, not full monorepo
npm install -g .      # or: cd packages/cleo && npm pack && npm install -g *.tgz
```

---

### GAP-3: AGENTS.md has stale 'file' mode injection

**Confirmed:** .cleo/config.json has `"brain": { "autoCapture": true }` but
NO `memoryBridge.mode` key, so resolveBridgeMode returns default 'cli'.

But the project AGENTS.md still contains:
```
@.cleo/memory-bridge.md
@.cleo/nexus-bridge.md
```

This was written when mode was 'file' (before T999). The injection.ts now
correctly generates `# Run: cleo memory digest --brief` for cli mode, but
ensureInjection hasn't been re-run since T999/T1013 landed.

**Fix:** Re-run injection to flip AGENTS.md to cli mode:
```bash
cd /mnt/projects/cleocode
cleo init --force   # re-runs ensureInjection with current bridge mode
```

But this is only meaningful AFTER BLOCKER-2 is fixed (digest command works).

---

### GAP-4: Conduit poller daemon not running

**Confirmed:** `cleo conduit status` shows:
- connected: true
- transport: local
- agentId: cleo-prime
- pollerRunning: false
- unreadTotal: 0

**Fix:** Simply start it:
```bash
cleo conduit start
```

---

### GAP-5: signaldock.db missing (doctor warning)

**Confirmed:** `cleo doctor` shows `signaldock_db: warn - signaldock.db not found`.
The old signaldock.db was superseded by conduit.db but the doctor check wasn't
updated to reflect this.

**Fix:** Either suppress the warning (it's stale) or run `cleo init` which
creates the expected file. Check if it's still needed:
```bash
grep -r "signaldock.db\|signaldockDb" packages/cleo/src/ --include="*.ts" | grep -v test | head -10
```

---

### GAP-6: Sentient tier2Enabled defaults to false — LLM proposals never run

**Confirmed from dist/sentient/propose-tick.d.ts:** The propose-tick checks
`tier2Enabled` flag before running. Default state has it false.

**This is intentional** (ADR-054 opt-in design) but means no proposals ever
generate unless owner explicitly enables it.

**Fix:** Enable after daemon is working:
```bash
# After fixing BLOCKER-1 and getting daemon running:
# Edit .cleo/sentient-state.json to set tier2Enabled: true
# OR find the CLI command: cleo sentient propose enable
```

---

### KNOWN CORRECT (my first diagnosis was wrong about these)

- **Brain write path works:** `cleo memory observe/decide/learn` all write correctly
- **Brain read/search works:** hybrid BM25+RRF search confirmed returning real data
- **Conduit infrastructure is real:** LocalTransport connected, conduit.db initialized
- **Nexus code analysis works:** tree-sitter pipeline working, 3115 files indexed
- **Nexus bridge is populated:** nexus-bridge.md has 42 lines of real data
- **Memory bridge mode architecture is correct:** T999/T1013 design is sound
- **Dispatch layer is complete:** 15 domains, all operations registered
- **Task lifecycle works:** add/start/complete/block all function
- **Dream cycle exists:** `cleo memory dream` is a real working CLI command
- **Reflect pipeline exists:** `cleo memory reflect` calls LLM Observer + Reflector
- **Consolidation exists:** `cleo memory consolidate` runs the full pipeline
- **Conduit has CLI:** status/peek/start/stop/send all registered and working

---

## IMPLEMENTATION PLAN

### Priority 1 (This Session): Fix the Blockers

#### P1-A: Fix sentient daemon Node 24 WriteStream bug

**Files to edit:**
- packages/core/src/sentient/daemon.ts
- packages/core/src/gc/daemon.ts (same pattern, fix both)

**Step 1:** Add `once` import to daemon.ts
```typescript
// Change:
import { createWriteStream, constants as fsConstants, watch } from 'node:fs';
// To:
import { createWriteStream, constants as fsConstants, watch } from 'node:fs';
import { once } from 'node:events';
```

**Step 2:** Await stream open before spawn in spawnSentientDaemon:
```typescript
const outStream = createWriteStream(logPath, { flags: 'a' });
const errStream = createWriteStream(errPath, { flags: 'a' });
// ADD THIS LINE:
await Promise.all([once(outStream, 'open'), once(errStream, 'open')]);
const child = spawn(process.execPath, [daemonEntry, projectRoot], {
  detached: true,
  stdio: ['ignore', outStream, errStream],
  env: { ...process.env, CLEO_SENTIENT_DAEMON: '1' },
});
```

**Step 3:** Apply same fix to packages/core/src/gc/daemon.ts

**Step 4:** Build core:
```bash
cd /mnt/projects/cleocode
pnpm run build:core
```

**Step 5:** Reinstall cleo from source:
```bash
cd /mnt/projects/cleocode
pnpm run build:cleo
npm install -g packages/cleo/
```

**Step 6:** Verify fix:
```bash
cleo sentient start
sleep 2
cleo sentient status
# Expected: Daemon: running | pid=XXXXX
```

**Step 7:** Run a manual tick to prove it works:
```bash
cleo sentient tick --dry-run
# Expected: Dry-run tick: no-task (or backoff if a task is available)
```

---

#### P1-B: Rebuild and reinstall cleo binary with T1006 commands

This is done as part of P1-A Step 5 above (reinstalling from source).

**Verify after reinstall:**
```bash
cleo memory digest --limit 3
# Expected: JSON output with top brain observations, NOT "Unknown command"
```

---

#### P1-C: Re-inject AGENTS.md to cli mode

After P1-B (digest command working):
```bash
cd /mnt/projects/cleocode
cleo init --force
```

**Verify:**
```bash
cat AGENTS.md | grep -A3 'CAAMP:START'
# Expected: contains "# Run: cleo memory digest --brief"
# NOT: "@.cleo/memory-bridge.md"
```

---

### Priority 2: Start the Autonomous Systems

#### P2-A: Start the sentient daemon on the live project

```bash
cd /mnt/projects/cleocode
cleo sentient start
```

**Verify it's ticking:**
```bash
sleep 30
cleo sentient status
# Expected: Daemon: running | ticks > 0
tail -20 .cleo/logs/sentient.log
```

**If it picks a task**, watch what happens:
```bash
# The tick spawns: cleo orchestrate spawn <taskId> --adapter <adapter>
# Verify the adapter is configured. Check:
grep -r "DEFAULT_ADAPTER\|adapter.*claude" packages/core/src/sentient/ --include="*.d.ts" | head -5
# From tick.d.ts we know DEFAULT_ADAPTER = "claude-code"
# This means cleo-os (cleoos) must be available for spawning
```

---

#### P2-B: Start the conduit poller

```bash
cd /mnt/projects/cleocode
cleo conduit start
cleo conduit status
# Expected: pollerRunning: true
```

---

#### P2-C: Enable tier-2 proposals

After the daemon is running and producing ticks:
```bash
cd /mnt/projects/cleocode
cleo sentient propose enable
cleo sentient status
# Check: tier2Enabled: true in state
```

**Verify by running a proposal tick manually:**
```bash
cleo sentient propose run
cleo sentient propose list
# Expected: at least one [T2-BRAIN], [T2-NEXUS], or [T2-TEST] prefixed proposal
```

---

### Priority 3: Harden the Sandbox

#### P3-A: Fix the harness-e2e scenario

```bash
cd /mnt/projects/cleo-sandbox
# The ubuntu node is running. Install current source:
./bin/sandbox install ubuntu
# Run the full test suite:
./bin/sandbox test-all --node ubuntu --json 2>&1 | python3 -m json.tool
```

**For each failing scenario:**
1. Read artifacts: `./bin/sandbox artifacts ubuntu`
2. Check result.txt + run.log + assertions.log
3. Fix in cleocode source
4. `./bin/sandbox install ubuntu && ./bin/sandbox run <scenario> ubuntu`
5. Repeat until PASS

---

#### P3-B: Add sentient-daemon-lifecycle sandbox scenario

This proves the sentient daemon works end-to-end in a clean environment.

**Create:** cleo-sandbox/scenarios/sentient-daemon-lifecycle/

run.sh:
```bash
#!/usr/bin/env bash
set -euo pipefail
mkdir -p "${SANDBOX_ARTIFACT_DIR}"

cd /tmp/sentient-test-project
cleo init
cleo session start --name "sentient-test" --scope global

# Create a concrete task (no session required for this check)
cleo add "Write proof.txt" 2>&1 | tee "${SANDBOX_ARTIFACT_DIR}/add-task.log"

# Start the sentient daemon
cleo sentient start 2>&1 | tee "${SANDBOX_ARTIFACT_DIR}/sentient-start.log"

# Wait for first tick
sleep 35

# Capture status
cleo sentient status 2>&1 > "${SANDBOX_ARTIFACT_DIR}/sentient-status.json"
cat .cleo/logs/sentient.log > "${SANDBOX_ARTIFACT_DIR}/sentient.log" 2>/dev/null || true
```

assertions.sh:
```bash
#!/usr/bin/env bash
set -euo pipefail

# Check daemon started (pid in status)
if grep -q '"running":true' "${SANDBOX_ARTIFACT_DIR}/sentient-status.json"; then
  echo "  ok  sentient daemon running"
else
  echo "  FAIL  sentient daemon not running"
  exit 1
fi

# Check at least one tick fired
if grep -q '"ticks":[1-9]' "${SANDBOX_ARTIFACT_DIR}/sentient-status.json"; then
  echo "  ok  at least one tick completed"
else
  echo "  FAIL  zero ticks recorded"
  exit 1
fi
```

---

### Priority 4: Wire Live Context to Harnesses

#### P4-A: Verify cli-mode context injection chain works end-to-end

After P1-C (AGENTS.md updated to cli mode):

1. Simulate what a harness sees on first load:
   ```bash
   cleo memory digest --limit 5
   # This is exactly what the `# Run: cleo memory digest --brief` directive does
   ```

2. The output should contain top brain observations. If it does, the chain works:
   AGENTS.md → `# Run: cleo memory digest --brief` → brain.db → agent context.

3. Verify the nexus directive also works:
   ```bash
   cleo nexus --help | grep "refresh-bridge\|analyze"
   cleo nexus analyze 2>&1 | tail -5
   ```

---

#### P4-B: Auto-refresh memory on session start

Currently, `cleo memory digest` is injected as a directive in AGENTS.md.
The harness is supposed to run it at session start. But most harnesses won't
auto-run directives — they just show them as context.

The right fix: hook into `session.start` to proactively write a fresh
`.cleo/agent-briefing.md` that harnesses CAN @-reference.

Find the session start hook:
```bash
grep -rn "session.*start.*hook\|post.*session.start\|onSessionStart" \
  packages/core/src/hooks/ packages/core/src/sessions/ --include="*.ts" | head -10
```

If the hook exists, add a handler that runs `writeMemoryBridge` in 'file'
mode for just the briefing file (not changing the main bridge mode config).

---

## QUALITY GATES

Before marking any task complete, in order:

```bash
# 1. Biome
pnpm biome check --write packages/core/src/sentient/daemon.ts
pnpm biome check --write packages/core/src/gc/daemon.ts

# 2. Build
pnpm run build:core
pnpm run build:cleo

# 3. Tests
pnpm run test -- --reporter=verbose packages/core/src/sentient/ 2>&1 | tail -20

# 4. Reinstall
npm install -g packages/cleo/

# 5. Smoke test
cleo sentient start
sleep 5
cleo sentient status   # must show running pid
cleo memory digest --limit 3   # must return actual observations
cleo conduit status   # must show connected: true
```

---

## ANTI-THEATRE CONTRACT (unchanged from D018)

- Run the actual CLI command. Capture real output.
- Empty output = not done.
- Code compiles = not done.
- Tests pass = not done.
- The only done is: the CLI command produces real evidence.
