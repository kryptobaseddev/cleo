# Provider-Agnostic Task Reconciliation Specification

**Version**: 2026.3.19
**Status**: APPROVED

---

## 1. Overview

Provider-agnostic task reconciliation system for syncing external issue/task systems (Linear, Jira, GitHub Issues, GitLab, etc.) with CLEO as SSoT. Provider adapters normalize their native formats into `ExternalTask[]`, and the reconciliation engine handles diffing, creating, updating, and linking.

## 2. Architecture

```
External issue tracker (any format)
  -> Provider adapter (implements ExternalTaskProvider)
    -> ExternalTask[] (normalized, provider-agnostic)
      -> ReconciliationEngine (in @cleocode/core)
        -> CLEO core task operations (addTask, completeTask, updateTask)
        -> external_task_links table (DB-backed link tracking)
```

## 3. Key Contract: ExternalTaskProvider

```typescript
interface ExternalTaskProvider {
  getExternalTasks(projectDir: string): Promise<ExternalTask[]>;
  pushTaskState?(tasks: Task[], projectDir: string): Promise<void>;
}
```

## 4. Normalized Type: ExternalTask

```typescript
interface ExternalTask {
  externalId: string;        // Provider-assigned ID
  title: string;             // Human-readable title
  status: 'pending' | 'active' | 'completed' | 'removed';
  description?: string;
  priority?: 'critical' | 'high' | 'medium' | 'low';
  type?: 'epic' | 'task' | 'subtask';
  labels?: string[];
  url?: string;              // Link back to external system
  parentExternalId?: string; // Hierarchy support
  providerMeta?: Record<string, unknown>;
}
```

## 5. External Task Links (DB-backed)

Links between CLEO tasks and external tasks are stored in the `external_task_links` table in tasks.db:

```typescript
interface ExternalTaskLink {
  id: string;                // UUID
  taskId: string;            // FK to tasks.id
  providerId: string;        // e.g. 'linear', 'jira', 'github'
  externalId: string;        // Provider-assigned ID
  externalUrl?: string;      // URL for human navigation
  externalTitle?: string;    // Title at last sync
  linkType: 'created' | 'matched' | 'manual';
  syncDirection: 'inbound' | 'outbound' | 'bidirectional';
  metadata?: Record<string, unknown>;
  linkedAt: string;          // ISO 8601
  lastSyncAt?: string;       // ISO 8601
}
```

## 6. Conflict Resolution

Configurable via `ConflictPolicy`: `'cleo-wins'` (default), `'provider-wins'`, `'latest-wins'`, `'report-only'`.

## 7. Consumer API

```typescript
import { Cleo } from '@cleocode/core';

const cleo = await Cleo.init('./project');

// Reconcile external tasks
const result = await cleo.sync.reconcile({
  externalTasks: normalizedTasks,
  providerId: 'linear',
  dryRun: false,
});

// Query links
const links = await cleo.sync.getLinks('linear');
const taskLinks = await cleo.sync.getTaskLinks('T123');

// Cleanup
await cleo.sync.removeProviderLinks('linear');
```

## 8. References

- `packages/contracts/src/task-sync.ts` — Type contracts
- `packages/core/src/reconciliation/` — Engine and link store
- `packages/core/src/store/tasks-schema.ts` — `external_task_links` table
