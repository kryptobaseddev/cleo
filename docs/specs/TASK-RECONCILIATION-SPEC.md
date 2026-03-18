# Provider-Agnostic Task Reconciliation Specification

**Version**: 2026.3.18
**Status**: DRAFT
**Date**: 2026-03-18

---

## 1. Overview

Replaces the legacy Claude Code-specific TodoWrite integration with a provider-agnostic task reconciliation system. Any provider adapter can implement `AdapterTaskSyncProvider` to sync its external task system with CLEO as the SSoT.

## 2. Architecture

```
Provider's external task system (any format)
  → Adapter's TaskSyncProvider (provider-specific parsing)
    → ExternalTask[] (normalized, provider-agnostic)
      → ReconciliationEngine (in @cleocode/core)
        → CLEO core task operations (addTask, completeTask, updateTask)
```

## 3. Key Contract: AdapterTaskSyncProvider

```typescript
interface AdapterTaskSyncProvider {
  getExternalTasks(projectDir: string): Promise<ExternalTask[]>;
  pushTaskState?(tasks: Task[], projectDir: string): Promise<void>;
  cleanup?(projectDir: string): Promise<void>;
}
```

## 4. Normalized Type: ExternalTask

```typescript
interface ExternalTask {
  externalId: string;
  cleoTaskId: string | null;
  title: string;
  status: 'pending' | 'active' | 'completed' | 'removed';
  description?: string;
  labels?: string[];
  providerMeta?: Record<string, unknown>;
}
```

## 5. Conflict Resolution

Configurable via `ConflictPolicy`: `'cleo-wins'` (default), `'provider-wins'`, `'latest-wins'`, `'report-only'`.

## 6. Migration Path

1. Add contracts (non-breaking)
2. Implement reconciliation engine (non-breaking)
3. Implement adapter TaskSyncProviders (non-breaking)
4. Rewire dispatch + deprecate TodoWrite (internal breaking)

## 7. References

Full design document produced by task-reconciliation-architect agent.
