# T5586 Simplify Output — Remove --guided and --channel Flags

## Summary

Removed two over-engineered opt-in flags from `release ship`. Guided step-by-step output now always fires; channel is always auto-detected from branch.

---

## Changes Made

### 1. `src/cli/commands/release.ts`

**Lines removed:**

```
.option('--guided', 'Show step-by-step guided output during release')
.option('--channel <channel>', 'Override release channel (latest|beta|alpha)')
```

```
guided: opts['guided'] ?? false,
channel: opts['channel'],
```

**JSDoc comment block** updated to remove those two flags from the documented flag list.

---

### 2. `src/dispatch/domains/pipeline.ts`

**Lines removed from the `release.ship` case:**

```typescript
const guided = params?.guided as boolean | undefined;
const channel = params?.channel as string | undefined;
```

**Call to `releaseShip()`** simplified from:
```typescript
{ version, epicId, remote, dryRun, guided, channel }
```
to:
```typescript
{ version, epicId, remote, dryRun }
```

---

### 3. `src/dispatch/engines/release-engine.ts`

#### Params type — removed fields:
```typescript
guided?: boolean;
channel?: string;
```

#### Destructure — removed bindings:
```typescript
// Before
const { version, epicId, remote, dryRun = false, guided = false, channel } = params;

// After
const { version, epicId, remote, dryRun = false } = params;
```

#### `logStep` — guard removed so it always fires:
```typescript
// Before
const logStep = (...): void => {
  if (!guided) return;   // <-- removed
  if (done === undefined) { ...
```

The comment was also updated from "only when guided mode is active" to "for each release stage".

#### Channel resolution — manual override path removed:
```typescript
// Before
let resolvedChannel: string = channel ?? 'latest';
...
if (!channel) {
  const channelEnum = resolveChannelFromBranch(branchName);
  resolvedChannel = channelToDistTag(channelEnum);
}

// After
let resolvedChannel: string = 'latest';
...
const channelEnum = resolveChannelFromBranch(branchName);
resolvedChannel = channelToDistTag(channelEnum);
```

#### PR output block — `if (guided)` guard removed:
```typescript
// Before
if (guided) {
  if (prResult.mode === 'created') { ...

// After — always logs PR result
if (prResult.mode === 'created') { ...
```

---

## Confirmations

**logStep always fires:** The `if (!guided) return;` guard has been removed. `logStep` now unconditionally emits output for every call site.

**Channel is always auto-detected:** The `channel ?? 'latest'` fallback and `if (!channel)` branch have been removed. Channel is now always resolved via `resolveChannelFromBranch(branchName)` → `channelToDistTag(...)`, with `'latest'` as the fallback only when git is unavailable.

**`release.channel.show` query operation in `pipeline.ts`:** Unchanged — kept as-is per Step 4 instructions.

---

## TypeScript Result

```
npx tsc --noEmit
(no output — 0 errors)
```

## Test Result

```
Test Files  276 passed (276)
      Tests  4327 passed (4327)
   Duration  187.65s
```

0 failures.
