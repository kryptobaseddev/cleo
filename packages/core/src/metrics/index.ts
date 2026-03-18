/**
 * Metrics module - token tracking, compliance aggregation, A/B testing, OpenTelemetry.
 *
 * @task T4454
 * @epic T4454
 */

export type { ABEventType, ABTestSummary, ABVariant } from './ab-test.js';
// A/B testing
export {
  compareABTest,
  endABTest,
  getABTestResults,
  getABTestStats,
  listABTests,
  logABEvent,
  startABTest,
} from './ab-test.js';
// Metrics aggregation
export {
  getComplianceTrend,
  getGlobalComplianceSummary,
  getProjectComplianceSummary,
  getSessionMetricsSummary,
  getSkillReliability,
  logSessionMetrics,
  syncMetricsToGlobal,
} from './aggregation.js';
export type { ComplianceSummary } from './common.js';
// Common utilities
export {
  ensureMetricsDir,
  getCompliancePath,
  getComplianceSummaryBase,
  getSessionsMetricsPath,
  getViolationsPath,
  isoDate,
  isoTimestamp,
  readJsonlFile,
} from './common.js';
// Enums
export {
  AgentReliability,
  AggregationPeriod,
  InstructionStability,
  isValidEnumValue,
  ManifestIntegrity,
  MetricCategory,
  MetricSource,
  SessionDegradation,
  Severity,
} from './enums.js';
export type { AggregatedTokens, OtelCaptureMode, OtelTokenDataPoint } from './otel-integration.js';
// OTel integration
export {
  compareSessions,
  getOtelSetupCommands,
  getSessionTokens,
  getTokenStats,
  isOtelEnabled,
  parseTokenMetrics,
  recordSessionEnd,
  recordSessionStart,
} from './otel-integration.js';
export type { TokenEvent, TokenEventType, TokenSessionSummary } from './token-estimation.js';
// Token estimation
export {
  compareManifestVsFull,
  endTokenSession,
  estimateTokens,
  estimateTokensFromFile,
  getTokenSummary,
  getTrackingStatus,
  logTokenEvent,
  startTokenSession,
  trackFileRead,
  trackManifestQuery,
  trackPromptBuild,
  trackSkillInjection,
  trackSpawnComplete,
  trackSpawnOutput,
} from './token-estimation.js';
