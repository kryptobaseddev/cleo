/**
 * Contract extraction and matching for NEXUS.
 *
 * @task T1065 — Contract Registry
 */

export { extractGrpcContracts } from './grpc-extractor.js';
export { extractHttpContracts } from './http-extractor.js';
export { matchContracts } from './matcher.js';
export { extractTopicContracts } from './topic-extractor.js';
