# @cleocode/contracts

Domain types, interfaces, and contracts for the CLEO ecosystem.

## Overview

This package contains all type definitions, interfaces, and contracts used throughout the CLEO monorepo. It is the **leaf package** in the dependency graph with **zero runtime dependencies**, serving as the foundation for type safety across all other packages.

All domain types (Task, Session, DataAccessor, etc.) are defined here. Implementation packages (`@cleocode/core`, `@cleocode/cleo`) import from here.

## Installation

```bash
npm install @cleocode/contracts
```

```bash
pnpm add @cleocode/contracts
```

```bash
yarn add @cleocode/contracts
```

## API Overview

### Core Types

#### Task Types

```typescript
import type { 
  Task, 
  TaskCreate, 
  TaskPriority, 
  TaskStatus,
  TaskType,
  TaskSize,
  EpicLifecycle,
  Phase,
  PhaseStatus,
  PhaseTransition,
  VerificationGate,
  TaskVerification,
  TaskWorkState
} from '@cleocode/contracts';
```

#### Session Types

```typescript
import type { 
  Session, 
  SessionScope, 
  SessionStartResult,
  SessionStats,
  SessionTaskWork,
  SessionView
} from '@cleocode/contracts';
```

#### Memory Types

```typescript
import type { 
  BrainEntryRef,
  BrainEntrySummary,
  ContradictionDetail,
  SupersededEntry,
  MemoryBridgeConfig,
  MemoryBridgeContent,
  BridgeDecision,
  BridgeLearning,
  BridgeObservation,
  BridgePattern,
  SessionSummary
} from '@cleocode/contracts';
```

#### Data Accessor Interface

```typescript
import type { 
  DataAccessor,
  TransactionAccessor,
  TaskQueryFilters,
  QueryTasksResult,
  TaskFieldUpdates,
  ArchiveFields,
  ArchiveFile
} from '@cleocode/contracts';
```

### Status Registry

Centralized status definitions with validation and display helpers:

```typescript
import { 
  TASK_STATUSES,
  SESSION_STATUSES,
  LIFECYCLE_STAGE_STATUSES,
  LIFECYCLE_PIPELINE_STATUSES,
  GATE_STATUSES,
  ADR_STATUSES,
  MANIFEST_STATUSES,
  isValidStatus,
  STATUS_REGISTRY,
  TASK_STATUS_SYMBOLS_ASCII,
  TASK_STATUS_SYMBOLS_UNICODE,
  PIPELINE_STATUS_ICONS,
  STAGE_STATUS_ICONS,
  TERMINAL_TASK_STATUSES,
  TERMINAL_STAGE_STATUSES,
  TERMINAL_PIPELINE_STATUSES
} from '@cleocode/contracts';

// Validate a status
const isValid = isValidStatus('task', 'in_progress');

// Get status icon
const icon = TASK_STATUS_SYMBOLS_UNICODE['completed'];
```

### Exit Codes

Standardized exit codes for CLEO operations:

```typescript
import { 
  ExitCode,
  getExitCodeName,
  isSuccessCode,
  isErrorCode,
  isRecoverableCode,
  isNoChangeCode
} from '@cleocode/contracts';

// Check exit code meaning
if (isSuccessCode(exitCode)) {
  console.log('Operation succeeded');
}
```

### Configuration Types

```typescript
import type { 
  CleoConfig,
  ConfigSource,
  LogLevel,
  LoggingConfig,
  SessionConfig,
  LifecycleConfig,
  LifecycleEnforcementMode,
  EnforcementProfile,
  SharingConfig,
  SharingMode,
  SignalDockConfig,
  SignalDockMode,
  OutputConfig,
  OutputFormat,
  DateFormat,
  BackupConfig,
  HierarchyConfig,
  ResolvedValue
} from '@cleocode/contracts';
```

### LAFS (Language-Agnostic Feedback Schema)

Standardized envelope format for API responses:

```typescript
import type { 
  LafsEnvelope,
  LafsSuccess,
  LafsError,
  LafsErrorDetail,
  LAFSPage,
  LAFSPageOffset,
  LAFSPageNone,
  LAFSMeta,
  MVILevel,
  Warning,
  LafsAlternative,
  CleoResponse,
  GatewayEnvelope,
  GatewaySuccess,
  GatewayError,
  GatewayMeta,
  ConformanceReport,
  FlagInput,
  LAFSError,
  LAFSErrorCategory,
  LAFSTransport
} from '@cleocode/contracts';

import { 
  isLafsSuccess, 
  isLafsError,
  isGatewayEnvelope 
} from '@cleocode/contracts';
```

### Provider Adapter Contracts

```typescript
import type { 
  CLEOProviderAdapter,
  AdapterHealthStatus,
  AdapterCapabilities,
  AdapterContextMonitorProvider,
  AdapterHookProvider,
  AdapterInstallProvider,
  InstallOptions,
  InstallResult,
  AdapterSpawnProvider,
  SpawnContext,
  SpawnResult,
  AdapterTransportProvider,
  AdapterPathProvider,
  AdapterTaskSyncProvider,
  ExternalTask,
  ExternalTaskStatus,
  ReconcileAction,
  ReconcileActionType,
  ReconcileOptions,
  ReconcileResult,
  SyncSessionState,
  ConflictPolicy
} from '@cleocode/contracts';
```

### Task Sync Types

Provider-agnostic reconciliation types:

```typescript
import type { 
  ExternalTask,
  ExternalTaskStatus,
  ReconcileAction,
  ReconcileActionType,
  ReconcileOptions,
  ReconcileResult,
  SyncSessionState,
  ConflictPolicy
} from '@cleocode/contracts';
```

### Archive Types

```typescript
import type { 
  ArchivedTask,
  ArchiveMetadata,
  ArchiveSummaryReport,
  ArchiveTrendsReport,
  ArchiveCycleTimesReport,
  ArchiveStatsEnvelope,
  ArchiveReportType,
  ArchiveDailyTrend,
  ArchiveMonthlyTrend,
  ArchiveLabelEntry,
  ArchivePhaseEntry,
  ArchivePriorityEntry,
  CycleTimeDistribution,
  CycleTimePercentiles
} from '@cleocode/contracts';
```

### Results Types

Dashboard and statistics results:

```typescript
import type { 
  DashboardResult,
  StatsResult,
  StatsActivityMetrics,
  StatsAllTime,
  StatsCompletionMetrics,
  StatsCurrentState,
  StatsCycleTimes,
  ContextResult,
  LogQueryResult,
  SequenceResult,
  TaskDepsResult,
  TaskAnalysisResult,
  TaskRef,
  TaskRefPriority,
  TaskSummary,
  LabelCount,
  CompleteTaskUnblocked,
  BottleneckTask,
  LeveragedTask
} from '@cleocode/contracts';
```

### Task Record Types

String-widened types for dispatch and LAFS:

```typescript
import type { 
  TaskRecord,
  MinimalTaskRecord,
  TaskRecordRelation,
  ValidationHistoryEntry
} from '@cleocode/contracts';
```

### Spawn Types

CLEO spawn system types:

```typescript
import type { 
  CLEOSpawnAdapter,
  CLEOSpawnContext,
  CLEOSpawnResult,
  CAAMPSpawnOptions,
  CAAMPSpawnResult,
  Provider,
  SpawnStatus,
  TokenResolution
} from '@cleocode/contracts';
```

### Tessera Types

Template instantiation types:

```typescript
import type { 
  TesseraTemplate,
  TesseraVariable,
  TesseraInstantiationInput
} from '@cleocode/contracts';
```

### WarpChain Types

Protocol execution chain types:

```typescript
import type { 
  WarpChain,
  WarpChainInstance,
  WarpChainExecution,
  WarpStage,
  WarpLink,
  GateContract,
  GateName,
  GateCheck,
  GateResult,
  ChainValidation,
  ChainShape,
  ProtocolType
} from '@cleocode/contracts';
```

### Operations Types (Namespace)

All operation types are namespaced under `ops` to avoid collisions:

```typescript
import { ops } from '@cleocode/contracts';

// Access operation types
const taskParams: ops.TaskQueryParams = { ... };
const createParams: ops.TaskCreateParams = { ... };
```

Available operation namespaces:
- `ops.TaskQueryParams`
- `ops.TaskCreateParams`
- `ops.TaskUpdateParams`
- `ops.TaskCompleteParams`
- `ops.SessionStartParams`
- `ops.SessionEndParams`
- `ops.MemoryObserveParams`
- `ops.MemorySearchParams`
- `ops.BrainQueryParams`
- `ops.ValidateParams`
- `ops.ReleaseParams`
- `ops.OrchestrateParams`
- `ops.ResearchParams`
- `ops.SkillsParams`
- `ops.SystemParams`
- `ops.IssuesParams`
- And more...

### Discovery Types

Provider manifest discovery:

```typescript
import type { 
  AdapterManifest,
  DetectionPattern
} from '@cleocode/contracts';
```

### Context Monitor Types

```typescript
import type { 
  AdapterContextMonitorProvider
} from '@cleocode/contracts';
```

### Hooks Types

```typescript
import type { 
  AdapterHookProvider
} from '@cleocode/contracts';
```

## Usage Examples

### Creating a Task Type

```typescript
import type { TaskCreate, TaskPriority, TaskType } from '@cleocode/contracts';

const newTask: TaskCreate = {
  title: 'Implement authentication',
  description: 'Add JWT-based auth to the API',
  priority: 'high' as TaskPriority,
  type: 'feature' as TaskType,
  size: 'medium',
  labels: ['backend', 'security']
};
```

### Using the Data Accessor Interface

```typescript
import type { DataAccessor, TaskQueryFilters } from '@cleocode/contracts';

async function fetchHighPriorityTasks(accessor: DataAccessor) {
  const filters: TaskQueryFilters = {
    priority: ['high', 'urgent'],
    status: ['pending', 'in_progress'],
    limit: 10
  };
  
  return await accessor.queryTasks(filters);
}
```

### Working with LAFS Envelopes

```typescript
import { isLafsSuccess, isLafsError, type LafsEnvelope } from '@cleocode/contracts';

function handleResponse(response: LafsEnvelope<unknown>) {
  if (isLafsSuccess(response)) {
    console.log('Success:', response.data);
  } else if (isLafsError(response)) {
    console.error('Error:', response.error.message);
  }
}
```

### Status Validation

```typescript
import { isValidStatus, TASK_STATUSES } from '@cleocode/contracts';

// Check if a status is valid
if (isValidStatus('task', 'in_progress')) {
  console.log('Valid task status');
}

// Iterate over all valid statuses
for (const status of TASK_STATUSES) {
  console.log(`Valid status: ${status}`);
}
```

## Dependencies

This package has **no runtime dependencies**. It contains only TypeScript type definitions and interfaces.

## License

MIT License - see [LICENSE](../LICENSE) for details.
