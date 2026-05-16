/**
 * Integration tests for BedrockTransport against a real AWS Bedrock endpoint.
 *
 * These tests are SKIPPED unless the `AWS_BEDROCK_TEST_KEY` env var is set.
 * Setting `AWS_BEDROCK_TEST_KEY=1` requires valid AWS credentials available
 * through the standard provider chain (env vars, ~/.aws/credentials, IAM role).
 *
 * Live integration tests are tracked as T9342 (owner-action: provide AWS CI secrets).
 *
 * @task T9317
 * @task T9342 (live integration owner-action)
 * @epic T9261 (T-LLM-CRED-CENTRALIZATION Phase 5)
 */

import { describe, expect, it } from 'vitest';
import { BedrockTransport } from '../bedrock.js';

describe.skipIf(!process.env['AWS_BEDROCK_TEST_KEY'])(
  'BedrockTransport — live integration (requires AWS_BEDROCK_TEST_KEY)',
  () => {
    const region = process.env['AWS_BEDROCK_REGION'] ?? 'us-east-1';
    const model = process.env['AWS_BEDROCK_MODEL'] ?? 'anthropic.claude-3-5-haiku-20241022-v1:0';

    it('completes a simple turn against the live Bedrock API', async () => {
      const transport = new BedrockTransport({ region });
      const response = await transport.complete({
        model,
        messages: [{ role: 'user', content: 'Say "CLEO integration test OK" and nothing else.' }],
        maxTokens: 64,
        temperature: 0,
      });

      expect(response.content).toBeTruthy();
      expect(response.usage.inputTokens).toBeGreaterThan(0);
      expect(response.usage.outputTokens).toBeGreaterThan(0);
      expect(response.stopReason).toBeDefined();
    });

    it('streams a simple turn and receives text deltas', async () => {
      const transport = new BedrockTransport({ region });
      const chunks: string[] = [];

      for await (const delta of transport.stream(
        {
          model,
          messages: [{ role: 'user', content: 'Count from 1 to 3, one number per line.' }],
          maxTokens: 64,
          temperature: 0,
        },
        {} as never,
      )) {
        if (delta.text) chunks.push(delta.text);
      }

      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks.join('')).toContain('1');
    });

    it('invokes a tool via the Converse API', async () => {
      const transport = new BedrockTransport({ region });
      const response = await transport.complete({
        model,
        messages: [{ role: 'user', content: "What's the weather in Tokyo?" }],
        maxTokens: 256,
        tools: [
          {
            name: 'get_weather',
            description: 'Returns current weather for a location',
            inputSchema: {
              type: 'object',
              properties: {
                location: { type: 'string', description: 'City name' },
              },
              required: ['location'],
            },
          },
        ],
      });

      expect(response.toolCalls).not.toBeNull();
      expect(response.toolCalls![0]!.name).toBe('get_weather');
    });
  },
);
