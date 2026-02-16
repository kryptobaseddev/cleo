/**
 * Metrics module - token tracking, compliance aggregation, A/B testing, OpenTelemetry.
 *
 * @task T4454
 * @epic T4454
 */

// Enums
export {
  Severity,
  ManifestIntegrity,
  InstructionStability,
  SessionDegradation,
  AgentReliability,
  MetricCategory,
  MetricSource,
  AggregationPeriod,
  isValidEnumValue,
} from './enums.js';

// Common utilities
export {
  ensureMetricsDir,
  getCompliancePath,
  getViolationsPath,
  getSessionsMetricsPath,
  isoTimestamp,
  isoDate,
  readJsonlFile,
  getComplianceSummaryBase,
} from './common.js';
export type { ComplianceSummary } from './common.js';

// Token estimation
export {
  estimateTokens,
  estimateTokensFromFile,
  logTokenEvent,
  trackFileRead,
  trackManifestQuery,
  trackSkillInjection,
  trackPromptBuild,
  trackSpawnOutput,
  trackSpawnComplete,
  startTokenSession,
  endTokenSession,
  getTokenSummary,
  compareManifestVsFull,
  getTrackingStatus,
} from './token-estimation.js';
export type { TokenEventType, TokenEvent, TokenSessionSummary } from './token-estimation.js';

// OTel integration
export {
  isOtelEnabled,
  getOtelSetupCommands,
  parseTokenMetrics,
  getSessionTokens,
  recordSessionStart,
  recordSessionEnd,
  compareSessions,
  getTokenStats,
} from './otel-integration.js';
export type { OtelCaptureMode, OtelTokenDataPoint, AggregatedTokens } from './otel-integration.js';

// Metrics aggregation
export {
  syncMetricsToGlobal,
  getProjectComplianceSummary,
  getGlobalComplianceSummary,
  getComplianceTrend,
  getSkillReliability,
  logSessionMetrics,
  getSessionMetricsSummary,
} from './aggregation.js';

// A/B testing
export {
  startABTest,
  endABTest,
  logABEvent,
  getABTestResults,
  listABTests,
  compareABTest,
  getABTestStats,
} from './ab-test.js';
export type { ABVariant, ABEventType, ABTestSummary } from './ab-test.js';
