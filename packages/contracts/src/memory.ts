/**
 * Memory bridge types for CLEO provider adapters.
 * Defines the shape of .cleo/memory-bridge.md content for cross-provider memory sharing.
 *
 * @task T5240
 */

export interface MemoryBridgeConfig {
  maxObservations: number;
  maxLearnings: number;
  maxPatterns: number;
  maxDecisions: number;
  includeHandoff: boolean;
  includeAntiPatterns: boolean;
}

export interface MemoryBridgeContent {
  generatedAt: string;
  lastSession?: SessionSummary;
  learnings: BridgeLearning[];
  patterns: BridgePattern[];
  antiPatterns: BridgePattern[];
  decisions: BridgeDecision[];
  recentObservations: BridgeObservation[];
}

export interface SessionSummary {
  sessionId: string;
  date: string;
  tasksCompleted: string[];
  decisions: string[];
  nextSuggested: string[];
}

export interface BridgeLearning {
  id: string;
  text: string;
  confidence: number;
}

export interface BridgePattern {
  id: string;
  text: string;
  type: 'follow' | 'avoid';
}

export interface BridgeDecision {
  id: string;
  title: string;
  date: string;
}

export interface BridgeObservation {
  id: string;
  date: string;
  summary: string;
}
