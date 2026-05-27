import { describe, it, expect } from "vitest";
import { TokenEstimator, estimateTokens, estimateTokensJSON } from "../src/tokenEstimator.js";
import {
  applyBudgetEnforcement,
  withBudget,
  checkBudget,
  withBudgetSync,
  wrapWithBudget,
  BUDGET_EXCEEDED_CODE,
} from "../src/budgetEnforcement.js";
import type { LAFSEnvelope, LAFSMeta, LAFSMetaWithBudget } from "../src/types.js";

describe("TokenEstimator", () => {
  const estimator = new TokenEstimator();

  describe("estimate()", () => {
    it("should estimate simple primitives", () => {
      expect(estimator.estimate(null)).toBe(1);
      expect(estimator.estimate(true)).toBe(1);
      expect(estimator.estimate(false)).toBe(1);
      expect(estimator.estimate(42)).toBe(1);
      // 3.14159 has 7 characters, so 7/4 = 2 tokens (rounded up)
      expect(estimator.estimate(3.14159)).toBeGreaterThanOrEqual(1);
      expect(estimator.estimate(3.14159)).toBeLessThanOrEqual(2);
    });

    it("should estimate strings based on grapheme count", () => {
      // Simple string: "hello" = 5 chars + 2 quotes = 7 chars / 4 = 2 tokens
      expect(estimator.estimate("hello")).toBe(2);
      
      // Longer string
      expect(estimator.estimate("This is a longer string with more characters")).toBe(12);
      
      // Empty string: "" = 2 chars / 4 = 1 token
      expect(estimator.estimate("")).toBe(1);
    });

    it("should count Unicode graphemes correctly", () => {
      // Emoji (grapheme cluster)
      expect(estimator.estimate("👋")).toBe(1); // 1 grapheme + 2 quotes = 3 chars / 4 = 1 token
      
      // Multiple emojis
      expect(estimator.estimate("👋🌍✨")).toBe(2); // 3 graphemes + 2 quotes = 5 chars / 4 = 2 tokens
      
      // CJK characters
      expect(estimator.estimate("日本語")).toBe(2); // 3 graphemes + 2 quotes = 5 chars / 4 = 2 tokens
      
      // Mixed Unicode
      expect(estimator.estimate("Hello 👋 World 🌍")).toBe(5); // 16 graphemes + 2 quotes = 18 chars / 4 = 5 tokens
      
      // Surrogate pairs (should be counted as single graphemes)
      expect(estimator.estimate("𠮷野家")).toBe(2); // 3 graphemes + 2 quotes = 5 chars / 4 = 2 tokens
    });

    it("should estimate simple objects", () => {
      const obj = { success: true };
      const estimate = estimator.estimate(obj);
      expect(estimate).toBeGreaterThan(0);
      expect(estimate).toBeLessThan(10);
    });

    it("should estimate nested objects", () => {
      const nested = {
        success: true,
        result: {
          id: 1,
          name: "test",
          nested: {
            value: 42,
          },
        },
      };
      const estimate = estimator.estimate(nested);
      expect(estimate).toBeGreaterThan(5);
      expect(estimate).toBeLessThan(50);
    });

    it("should estimate arrays", () => {
      const arr = [1, 2, 3, 4, 5];
      const estimate = estimator.estimate(arr);
      expect(estimate).toBeGreaterThan(2);
      expect(estimate).toBeLessThan(15);
    });

    it("should handle deeply nested objects", () => {
      let deep: Record<string, unknown> = { value: 1 };
      for (let i = 0; i < 10; i++) {
        deep = { nested: deep };
      }
      const estimate = estimator.estimate(deep);
      expect(estimate).toBeGreaterThan(10);
      expect(estimate).toBeLessThan(100);
    });

    it("should handle arrays with objects", () => {
      const arr = [
        { id: 1, name: "Alice" },
        { id: 2, name: "Bob" },
        { id: 3, name: "Charlie" },
      ];
      const estimate = estimator.estimate(arr);
      expect(estimate).toBeGreaterThan(5);
      expect(estimate).toBeLessThan(50);
    });

    it("should handle circular references gracefully", () => {
      const obj: Record<string, unknown> = { name: "test" };
      obj.self = obj; // Circular reference
      
      // Should not throw
      expect(() => estimator.estimate(obj)).not.toThrow();
      
      const estimate = estimator.estimate(obj);
      expect(estimate).toBeGreaterThan(0);
      expect(estimate).toBeLessThan(20);
    });

    it("should handle circular arrays", () => {
      const arr: unknown[] = [1, 2, 3];
      arr.push(arr); // Circular reference
      
      expect(() => estimator.estimate(arr)).not.toThrow();
      
      const estimate = estimator.estimate(arr);
      expect(estimate).toBeGreaterThan(2);
    });

    it("should handle complex circular structures", () => {
      const a: Record<string, unknown> = { name: "a" };
      const b: Record<string, unknown> = { name: "b", ref: a };
      a.ref = b; // Circular between a and b
      
      expect(() => estimator.estimate(a)).not.toThrow();
      expect(() => estimator.estimate(b)).not.toThrow();
    });
  });

  describe("estimateJSON()", () => {
    it("should estimate JSON strings", () => {
      const json = '{"success":true,"result":{"id":1}}';
      const estimate = estimator.estimateJSON(json);
      expect(estimate).toBeGreaterThan(5);
      expect(estimate).toBeLessThan(15);
    });

    it("should handle empty JSON", () => {
      expect(estimator.estimateJSON("{}")).toBe(1);
      expect(estimator.estimateJSON("[]")).toBe(1);
    });

    it("should handle large JSON", () => {
      const large = JSON.stringify({ items: Array(100).fill({ id: 1, name: "test" }) });
      const estimate = estimator.estimateJSON(large);
      expect(estimate).toBeGreaterThan(50);
    });
  });

  describe("safeStringify()", () => {
    it("should stringify objects with circular refs", () => {
      const obj: Record<string, unknown> = { name: "test" };
      obj.self = obj;
      
      const str = estimator.safeStringify(obj);
      expect(str).toContain("[Circular]");
      expect(() => JSON.parse(str)).not.toThrow();
    });
  });

  describe("safeCopy()", () => {
    it("should create safe copy without circular refs", () => {
      const obj: Record<string, unknown> = { name: "test", value: 42 };
      obj.self = obj;
      
      const copy = estimator.safeCopy(obj);
      expect(copy.name).toBe("test");
      expect(copy.self).toBe("[Circular]");
    });
  });

  describe("convenience functions", () => {
    it("estimateTokens should work without creating instance", () => {
      expect(estimateTokens({ test: true })).toBeGreaterThan(0);
    });

    it("estimateTokensJSON should work without creating instance", () => {
      expect(estimateTokensJSON('{"test":true}')).toBeGreaterThan(0);
    });
  });
});

describe("Budget Enforcement", () => {
  const createMockEnvelope = (result: unknown): LAFSEnvelope => ({
    $schema: "https://lafs.dev/schemas/v1/envelope.schema.json",
    _meta: {
      specVersion: "1.0.0",
      schemaVersion: "1.0.0",
      timestamp: new Date().toISOString(),
      operation: "test",
      requestId: "test-123",
      transport: "cli",
      strict: false,
      mvi: "standard",
      contextVersion: 1,
    } as LAFSMeta,
    success: true,
    result: result as Record<string, unknown> | Record<string, unknown>[] | null,
  });

  describe("checkBudget()", () => {
    it("should detect when within budget", () => {
      const envelope = createMockEnvelope({ id: 1, name: "test" });
      const check = checkBudget(envelope, 100);
      
      expect(check.exceeded).toBe(false);
      expect(check.estimated).toBeGreaterThan(0);
      expect(check.remaining).toBeGreaterThan(0);
    });

    it("should detect when budget exceeded", () => {
      const envelope = createMockEnvelope({ items: Array(1000).fill({ id: 1, data: "x".repeat(100) }) });
      const check = checkBudget(envelope, 10);
      
      expect(check.exceeded).toBe(true);
      expect(check.estimated).toBeGreaterThan(10);
      expect(check.remaining).toBe(0);
    });
  });

  describe("applyBudgetEnforcement()", () => {
    it("should add token estimate to envelope within budget", () => {
      const envelope = createMockEnvelope({ success: true, result: { id: 1 } });
      const result = applyBudgetEnforcement(envelope, 100);
      const meta = result.envelope._meta as LAFSMetaWithBudget;
      
      expect(result.withinBudget).toBe(true);
      expect(meta._tokenEstimate).toBeDefined();
      expect(meta._tokenEstimate?.estimated).toBeGreaterThan(0);
      expect(result.truncated).toBe(false);
    });

    it("should return E_MVI_BUDGET_EXCEEDED error when budget exceeded", () => {
      const envelope = createMockEnvelope({ items: Array(100).fill({ id: 1 }) });
      const result = applyBudgetEnforcement(envelope, 5);
      
      expect(result.withinBudget).toBe(false);
      expect(result.envelope.success).toBe(false);
      expect(result.envelope.error).toBeDefined();
      expect(result.envelope.error?.code).toBe(BUDGET_EXCEEDED_CODE);
      expect(result.envelope.error?.category).toBe("VALIDATION");
      expect(result.envelope.error?.retryable).toBe(false);
      expect(result.envelope.result).toBeNull();
    });

    it("should include budget details in error", () => {
      const envelope = createMockEnvelope({ items: Array(100).fill({ id: 1 }) });
      const result = applyBudgetEnforcement(envelope, 5);
      
      const error = result.envelope.error;
      expect(error?.details).toBeDefined();
      expect(error?.details.estimatedTokens).toBeGreaterThan(5);
      expect(error?.details.budgetTokens).toBe(5);
      expect(error?.details.exceededBy).toBeGreaterThan(0);
    });

    it("should truncate arrays when truncateOnExceed is enabled", () => {
      const envelope = createMockEnvelope({ items: Array(100).fill({ id: 1, name: "test" }) });
      const result = applyBudgetEnforcement(envelope, 50, { truncateOnExceed: true });
      const meta = result.envelope._meta as LAFSMetaWithBudget;
      
      expect(result.withinBudget).toBe(true);
      expect(result.truncated).toBe(true);
      expect(meta._tokenEstimate?.truncated).toBe(true);
      expect(meta._tokenEstimate?.originalEstimate).toBeDefined();
      
      const resultObj = result.envelope.result as Record<string, unknown> | null;
      expect(resultObj).not.toBeNull();
      if (resultObj) {
        const items = resultObj.items as unknown[] | undefined;
        if (items) {
          expect(items.length).toBeLessThan(100);
        }
      }
    });

    it("should truncate objects when truncateOnExceed is enabled", () => {
      const largeObj: Record<string, unknown> = {};
      for (let i = 0; i < 50; i++) {
        largeObj[`field${i}`] = { id: i, data: "x".repeat(100) };
      }
      
      const envelope = createMockEnvelope(largeObj);
      const result = applyBudgetEnforcement(envelope, 100, { truncateOnExceed: true });
      
      if (result.truncated) {
        const resultObj = result.envelope.result as Record<string, unknown>;
        expect(resultObj._truncated).toBe(true);
        expect(resultObj._truncatedFields).toBeDefined();
      }
    });

    it("should call onBudgetExceeded callback", () => {
      const callback = vi.fn();
      const envelope = createMockEnvelope({ items: Array(100).fill({ id: 1 }) });
      
      applyBudgetEnforcement(envelope, 5, { onBudgetExceeded: callback });
      
      expect(callback).toHaveBeenCalled();
      expect(callback).toHaveBeenCalledWith(expect.any(Number), 5);
    });

    it("should handle null result", () => {
      const envelope = createMockEnvelope(null);
      const result = applyBudgetEnforcement(envelope, 10);
      
      expect(result.withinBudget).toBe(true);
      expect(result.envelope.result).toBeNull();
    });

    it("should handle circular references in result", () => {
      const obj: Record<string, unknown> = { name: "test" };
      obj.self = obj;
      
      const envelope = createMockEnvelope(obj);
      expect(() => applyBudgetEnforcement(envelope, 100)).not.toThrow();
    });
  });

  describe("withBudget()", () => {
    it("should enforce budget on next() result", async () => {
      const middleware = withBudget(10);
      const envelope = createMockEnvelope({ items: Array(50).fill({ id: 1 }) });
      
      const result = await middleware(envelope, async () => envelope);
      
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(BUDGET_EXCEEDED_CODE);
    });

    it("should allow responses within budget", async () => {
      const middleware = withBudget(100);
      const envelope = createMockEnvelope({ id: 1, name: "test" });
      
      const result = await middleware(envelope, async () => envelope);
      
      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it("should work with truncateOnExceed", async () => {
      const middleware = withBudget(50, { truncateOnExceed: true });
      const envelope = createMockEnvelope({ items: Array(100).fill({ id: 1 }) });
      
      const result = await middleware(envelope, async () => envelope);
      const meta = result._meta as LAFSMetaWithBudget;
      
      expect(meta._tokenEstimate?.truncated).toBe(true);
    });
  });

  describe("withBudgetSync()", () => {
    it("should enforce budget synchronously", () => {
      const middleware = withBudgetSync(10);
      const envelope = createMockEnvelope({ items: Array(50).fill({ id: 1 }) });
      
      const result = middleware(envelope, () => envelope);
      
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(BUDGET_EXCEEDED_CODE);
    });
  });

  describe("wrapWithBudget()", () => {
    it("should wrap async handler with budget", async () => {
      const handler = async () => createMockEnvelope({ items: Array(50).fill({ id: 1 }) });
      const wrapped = wrapWithBudget(handler, 10);
      
      const result = await wrapped();
      
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(BUDGET_EXCEEDED_CODE);
    });

    it("should pass through handler arguments", async () => {
      const handler = async (id: number, name: string) => 
        createMockEnvelope({ id, name });
      const wrapped = wrapWithBudget(handler, 100);
      
      const result = await wrapped(42, "test");
      const resultObj = result.result as Record<string, unknown>;
      
      expect(resultObj.id).toBe(42);
      expect(resultObj.name).toBe("test");
    });
  });
});

describe("Token Estimation Accuracy", () => {
  const estimator = new TokenEstimator();

  // Helper to generate test payloads
  const generatePayloads = () => {
    const payloads: Array<{ name: string; value: unknown; expectedRange: [number, number] }> = [
      {
        name: "Simple envelope",
        value: { success: true, result: { id: 1 } },
        expectedRange: [5, 15],
      },
      {
        name: "Nested depth 5",
        value: (() => {
          let obj: Record<string, unknown> = { value: 1 };
          for (let i = 0; i < 5; i++) {
            obj = { nested: obj };
          }
          return obj;
        })(),
        expectedRange: [10, 30],
      },
      {
        name: "Unicode: emojis",
        value: { message: "Hello 👋 World 🌍✨" },
        expectedRange: [5, 15],
      },
      {
        name: "Unicode: CJK",
        value: { text: "日本語テスト中文测试" },
        expectedRange: [5, 15],
      },
      {
        name: "Array of 10 items",
        value: { items: Array(10).fill({ id: 1, name: "test" }) },
        expectedRange: [20, 50],
      },
      {
        name: "Mixed types",
        value: {
          string: "test",
          number: 42,
          boolean: true,
          null: null,
          array: [1, 2, 3],
          nested: { a: 1, b: 2 },
        },
        expectedRange: [15, 40],
      },
    ];
    
    return payloads;
  };

  it("should estimate 100 different JSON payloads", () => {
    const payloads = generatePayloads();
    
    // Generate additional variations to reach 100
    for (let i = 0; i < 94; i++) {
      payloads.push({
        name: `Generated payload ${i}`,
        value: {
          index: i,
          data: "x".repeat((i % 10) * 10),
          items: Array((i % 5) + 1).fill({ id: i }),
        },
        expectedRange: [5, 50],
      });
    }
    
    expect(payloads.length).toBe(100);
    
    for (const payload of payloads) {
      const estimate = estimator.estimate(payload.value);
      const json = JSON.stringify(payload.value);
      const jsonEstimate = estimator.estimateJSON(json);
      
      // Estimates should be reasonable (positive and not extreme)
      expect(estimate).toBeGreaterThan(0);
      expect(estimate).toBeLessThan(10000);
      
      // estimate() and estimateJSON() should be reasonably close (within 50%)
      // They use different algorithms so some variance is expected
      const ratio = Math.abs(estimate - jsonEstimate) / Math.max(estimate, jsonEstimate);
      expect(ratio).toBeLessThanOrEqual(0.5);
    }
  });

  it("should handle nested depth 10", () => {
    let obj: Record<string, unknown> = { value: 1 };
    for (let i = 0; i < 10; i++) {
      obj = { nested: obj };
    }
    
    const estimate = estimator.estimate(obj);
    expect(estimate).toBeGreaterThan(10);
    expect(estimate).toBeLessThan(100);
  });

  it("should handle large arrays", () => {
    const arr = Array(1000).fill({ id: 1, name: "test" });
    const estimate = estimator.estimate(arr);
    expect(estimate).toBeGreaterThan(500);
    expect(estimate).toBeLessThan(15000);
  });

  it("should handle very large objects", () => {
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < 1000; i++) {
      obj[`key${i}`] = { id: i, data: `value${i}` };
    }
    
    const estimate = estimator.estimate(obj);
    expect(estimate).toBeGreaterThan(1000);
    expect(estimate).toBeLessThan(20000);
  });
});

describe("Circular Reference Handling", () => {
  const estimator = new TokenEstimator();

  it("should handle self-referencing object", () => {
    const obj: Record<string, unknown> = { name: "test" };
    obj.self = obj;
    
    expect(() => estimator.estimate(obj)).not.toThrow();
    const estimate = estimator.estimate(obj);
    expect(estimate).toBeGreaterThan(0);
    expect(estimate).toBeLessThan(20);
  });

  it("should handle mutually referencing objects", () => {
    const a: Record<string, unknown> = { name: "a" };
    const b: Record<string, unknown> = { name: "b" };
    a.ref = b;
    b.ref = a;
    
    expect(() => estimator.estimate(a)).not.toThrow();
    expect(() => estimator.estimate(b)).not.toThrow();
  });

  it("should handle circular arrays", () => {
    const arr: unknown[] = [1, 2, 3];
    arr.push(arr);
    
    expect(() => estimator.estimate(arr)).not.toThrow();
  });

  it("should handle complex graph with cycles", () => {
    const root: Record<string, unknown> = { name: "root" };
    const child1: Record<string, unknown> = { name: "child1", parent: root };
    const child2: Record<string, unknown> = { name: "child2", parent: root };
    root.children = [child1, child2];
    child1.sibling = child2;
    child2.sibling = child1;
    
    expect(() => estimator.estimate(root)).not.toThrow();
  });
});

// Import vi for mocking
import { vi } from "vitest";
