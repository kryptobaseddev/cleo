/**
 * CLEO Intelligence dimension — Quality Prediction and Pattern Extraction.
 *
 * Provides risk scoring, validation outcome prediction, automatic pattern
 * detection, pattern matching, and pattern storage backed by the existing
 * brain_patterns and brain_learnings tables.
 *
 * @task Wave3A
 * @epic T5149
 */

// Impact analysis
export {
  analyzeChangeImpact,
  analyzeTaskImpact,
  calculateBlastRadius,
} from './impact.js';
// Patterns
export {
  extractPatternsFromHistory,
  matchPatterns,
  storeDetectedPattern,
  updatePatternStats,
} from './patterns.js';
// Prediction
export {
  calculateTaskRisk,
  gatherLearningContext,
  predictValidationOutcome,
} from './prediction.js';
// Types
export type {
  AffectedTask,
  BlastRadius,
  BlastRadiusSeverity,
  ChangeImpact,
  ChangeType,
  DetectedPattern,
  ImpactAssessment,
  LearningContext,
  PatternExtractionOptions,
  PatternMatch,
  PatternStatsUpdate,
  RiskAssessment,
  RiskFactor,
  ValidationPrediction,
} from './types.js';
