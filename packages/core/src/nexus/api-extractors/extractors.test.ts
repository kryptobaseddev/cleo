/**
 * Tests for gRPC and Topic contract extractors.
 *
 * @task T1065
 */

import { describe, expect, it } from 'vitest';
import { extractGrpcContracts } from './grpc-extractor.js';
import { extractTopicContracts } from './topic-extractor.js';

describe('gRPC Contract Extractor', () => {
  it('should return empty array for projects without .proto files', async () => {
    const contracts = await extractGrpcContracts('test-project', '/test/project');

    expect(contracts).toBeDefined();
    expect(Array.isArray(contracts)).toBe(true);
    expect(contracts).toHaveLength(0);
  });
});

describe('Topic Contract Extractor', () => {
  it('should return empty array for projects without pub/sub patterns', async () => {
    const contracts = await extractTopicContracts('test-project', '/test/project');

    expect(contracts).toBeDefined();
    expect(Array.isArray(contracts)).toBe(true);
    expect(contracts).toHaveLength(0);
  });
});
