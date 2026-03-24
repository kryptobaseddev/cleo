import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  isMVILevel,
  MVI_LEVELS,
  isRegisteredErrorCode,
  LAFSFlagError,
  resolveFieldExtraction,
  extractFieldFromResult,
  extractFieldFromEnvelope,
  applyFieldFilter,
} from "../src/index.js";
import type { LAFSEnvelope, MVILevel } from "../src/index.js";

function loadEnvelope(path: string): LAFSEnvelope {
  return JSON.parse(readFileSync(path, "utf8")) as LAFSEnvelope;
}

describe("isMVILevel", () => {
  it("returns true for each valid level", () => {
    for (const level of ["minimal", "standard", "full", "custom"]) {
      expect(isMVILevel(level)).toBe(true);
    }
  });

  it("MVI_LEVELS set contains all four levels", () => {
    expect(MVI_LEVELS.size).toBe(4);
    expect(MVI_LEVELS.has("minimal")).toBe(true);
    expect(MVI_LEVELS.has("standard")).toBe(true);
    expect(MVI_LEVELS.has("full")).toBe(true);
    expect(MVI_LEVELS.has("custom")).toBe(true);
  });

  it("returns false for unknown strings, null, undefined, numbers", () => {
    expect(isMVILevel("verbose")).toBe(false);
    expect(isMVILevel("")).toBe(false);
    expect(isMVILevel(null)).toBe(false);
    expect(isMVILevel(undefined)).toBe(false);
    expect(isMVILevel(42)).toBe(false);
  });
});

describe("resolveFieldExtraction", () => {
  it("defaults to mvi:'standard', mviSource:'default', expectsCustomMvi:false", () => {
    const result = resolveFieldExtraction({});
    expect(result.mvi).toBe("standard");
    expect(result.mviSource).toBe("default");
    expect(result.expectsCustomMvi).toBe(false);
    expect(result.field).toBeUndefined();
    expect(result.fields).toBeUndefined();
  });

  it("fieldFlag sets field, mvi defaults to standard", () => {
    const result = resolveFieldExtraction({ fieldFlag: "title" });
    expect(result.field).toBe("title");
    expect(result.mvi).toBe("standard");
    expect(result.expectsCustomMvi).toBe(false);
  });

  it("fieldsFlag string → parsed comma-separated array, expectsCustomMvi:true", () => {
    const result = resolveFieldExtraction({ fieldsFlag: "id,title,status" });
    expect(result.fields).toEqual(["id", "title", "status"]);
    expect(result.expectsCustomMvi).toBe(true);
  });

  it("fieldsFlag array → trimmed and filtered", () => {
    const result = resolveFieldExtraction({ fieldsFlag: ["  title  ", "", "id"] });
    expect(result.fields).toEqual(["title", "id"]);
    expect(result.expectsCustomMvi).toBe(true);
  });

  it("fieldsFlag: ['   '] → fields: undefined (whitespace-only entry)", () => {
    const result = resolveFieldExtraction({ fieldsFlag: ["   "] });
    expect(result.fields).toBeUndefined();
    expect(result.expectsCustomMvi).toBe(false);
  });

  it("fieldsFlag: ',' → fields: undefined (empty after parse)", () => {
    const result = resolveFieldExtraction({ fieldsFlag: "," });
    expect(result.fields).toBeUndefined();
    expect(result.expectsCustomMvi).toBe(false);
  });

  it("fieldsFlag: '  ,  ' → fields: undefined (whitespace only)", () => {
    const result = resolveFieldExtraction({ fieldsFlag: "  ,  " });
    expect(result.fields).toBeUndefined();
    expect(result.expectsCustomMvi).toBe(false);
  });

  it("fieldsFlag: [] → fields: undefined (empty array)", () => {
    const result = resolveFieldExtraction({ fieldsFlag: [] });
    expect(result.fields).toBeUndefined();
    expect(result.expectsCustomMvi).toBe(false);
  });

  it("fieldFlag: '' → field: undefined (falsy treated as absent)", () => {
    const result = resolveFieldExtraction({ fieldFlag: "" });
    expect(result.field).toBeUndefined();
  });

  it("valid mviFlag sets mvi + mviSource:'flag'", () => {
    const result = resolveFieldExtraction({ mviFlag: "minimal" });
    expect(result.mvi).toBe("minimal");
    expect(result.mviSource).toBe("flag");
  });

  it("invalid mviFlag → falls back to standard, mviSource:'default'", () => {
    const result = resolveFieldExtraction({ mviFlag: "verbose" });
    expect(result.mvi).toBe("standard");
    expect(result.mviSource).toBe("default");
  });

  it("mviFlag:'custom' → falls back to standard (not client-requestable)", () => {
    const result = resolveFieldExtraction({ mviFlag: "custom" });
    expect(result.mvi).toBe("standard");
    expect(result.mviSource).toBe("default");
  });

  it("fieldFlag + fieldsFlag → throws LAFSFlagError with code E_FIELD_CONFLICT", () => {
    expect(() =>
      resolveFieldExtraction({ fieldFlag: "title", fieldsFlag: "id,title" }),
    ).toThrow(LAFSFlagError);

    try {
      resolveFieldExtraction({ fieldFlag: "title", fieldsFlag: "id,title" });
    } catch (err) {
      const flagErr = err as LAFSFlagError;
      expect(flagErr.code).toBe("E_FIELD_CONFLICT");
    }
  });

  it("E_FIELD_CONFLICT is registered", () => {
    expect(isRegisteredErrorCode("E_FIELD_CONFLICT")).toBe(true);
  });

  it("E_FIELD_CONFLICT error has LAFSError properties", () => {
    try {
      resolveFieldExtraction({ fieldFlag: "title", fieldsFlag: "id,title" });
    } catch (err) {
      const flagErr = err as LAFSFlagError;
      expect(flagErr.category).toBe("CONTRACT");
      expect(flagErr.retryable).toBe(false);
      expect(flagErr.retryAfterMs).toBeNull();
      expect(flagErr.details).toEqual({
        conflictingModes: ["single-field-extraction", "multi-field-filter"],
      });
    }
  });
});

describe("extractFieldFromResult", () => {
  it("extracts direct top-level field from flat object result", () => {
    const result = { id: "T001", title: "Example", status: "active" };
    expect(extractFieldFromResult(result, "title")).toBe("Example");
  });

  it("extracts nested entity field (result.task.title shape)", () => {
    const result = { task: { id: "T001", title: "Nested", status: "active" } };
    expect(extractFieldFromResult(result, "title")).toBe("Nested");
  });

  it("extracts from nested array first element (result.items[0].title)", () => {
    const result = { items: [{ id: "T001", title: "First" }, { id: "T002", title: "Second" }] };
    expect(extractFieldFromResult(result, "title")).toBe("First");
  });

  it("extracts from first element when result IS a direct array", () => {
    const result = [{ id: "T001", title: "Direct Array" }];
    expect(extractFieldFromResult(result, "title")).toBe("Direct Array");
  });

  it("direct array with multiple elements — returns first element's value only", () => {
    const result = [{ id: "T001", title: "First" }, { id: "T002", title: "Second" }];
    expect(extractFieldFromResult(result, "title")).toBe("First");
  });

  it("multiple wrapper keys both have field — first key (insertion order) wins", () => {
    const result = {
      primary: { title: "Primary Title" },
      secondary: { title: "Secondary Title" },
    };
    expect(extractFieldFromResult(result, "title")).toBe("Primary Title");
  });

  it("returns undefined for missing field (silent)", () => {
    const result = { id: "T001", status: "active" };
    expect(extractFieldFromResult(result, "nonexistent")).toBeUndefined();
  });

  it("returns undefined for null result", () => {
    expect(extractFieldFromResult(null, "title")).toBeUndefined();
  });

  it("returns undefined for empty direct-array result", () => {
    expect(extractFieldFromResult([], "title")).toBeUndefined();
  });
});

describe("extractFieldFromEnvelope", () => {
  it("delegates to extractFieldFromResult (same results)", () => {
    const envelope = loadEnvelope("fixtures/field-extraction-success.json");
    expect(extractFieldFromEnvelope(envelope, "title")).toBe("Example Task");
    expect(extractFieldFromEnvelope(envelope, "id")).toBe("T001");
  });

  it("returns undefined for error envelope (result is null)", () => {
    const envelope: LAFSEnvelope = {
      $schema: "https://lafs.dev/schemas/v1/envelope.schema.json",
      _meta: {
        specVersion: "1.0.0",
        schemaVersion: "1.0.0",
        timestamp: "2026-02-26T00:00:00Z",
        operation: "test",
        requestId: "req_err",
        transport: "sdk",
        strict: true,
        mvi: "standard",
        contextVersion: 0,
      },
      success: false,
      result: null,
      error: {
        code: "E_NOT_FOUND_RESOURCE",
        message: "Not found",
        category: "NOT_FOUND",
        retryable: false,
        retryAfterMs: null,
        details: {},
      },
    };
    expect(extractFieldFromEnvelope(envelope, "title")).toBeUndefined();
  });
});

describe("applyFieldFilter", () => {
  const flatEnvelope = loadEnvelope("fixtures/field-extraction-success.json");
  const arrayEnvelope = loadEnvelope("fixtures/field-extraction-array.json");
  const wrapperEnvelope = loadEnvelope("fixtures/valid-success-envelope.json");

  it("projects flat result to requested fields only", () => {
    const filtered = applyFieldFilter(flatEnvelope, ["id", "title"]);
    expect(filtered.result).toEqual({ id: "T001", title: "Example Task" });
  });

  it("projects wrapper-array result (canonical fixture: { items: [{...}] })", () => {
    const filtered = applyFieldFilter(wrapperEnvelope, ["id", "title"]);
    expect(filtered.result).toEqual({ items: [{ id: "a1", title: "Item A" }] });
  });

  it("projects wrapper-entity result ({ task: { id, title, status } })", () => {
    const envelope: LAFSEnvelope = {
      ...flatEnvelope,
      result: { task: { id: "T001", title: "Task", status: "active", description: "verbose" } },
    };
    const filtered = applyFieldFilter(envelope, ["id", "title"]);
    expect(filtered.result).toEqual({ task: { id: "T001", title: "Task" } });
  });

  it("projects direct array result (each element filtered)", () => {
    const filtered = applyFieldFilter(arrayEnvelope, ["id", "title"]);
    expect(filtered.result).toEqual([
      { id: "T001", title: "Task One" },
      { id: "T002", title: "Task Two" },
    ]);
  });

  it("wrapper with both object and array keys — both projected independently", () => {
    const envelope: LAFSEnvelope = {
      ...flatEnvelope,
      result: {
        primary: { id: "P1", title: "Primary", extra: true },
        items: [{ id: "I1", title: "Item", extra: true }],
      },
    };
    const filtered = applyFieldFilter(envelope, ["id", "title"]);
    expect(filtered.result).toEqual({
      primary: { id: "P1", title: "Primary" },
      items: [{ id: "I1", title: "Item" }],
    });
  });

  it("sets _meta.mvi to 'custom'", () => {
    const filtered = applyFieldFilter(flatEnvelope, ["id"]);
    expect(filtered._meta.mvi).toBe("custom");
  });

  it("overrides pre-existing mvi:'minimal' → 'custom'", () => {
    const envelope: LAFSEnvelope = {
      ...flatEnvelope,
      _meta: { ...flatEnvelope._meta, mvi: "minimal" },
    };
    const filtered = applyFieldFilter(envelope, ["id"]);
    expect(filtered._meta.mvi).toBe("custom");
  });

  it("does not mutate input envelope (returns new object)", () => {
    const original = loadEnvelope("fixtures/field-extraction-success.json");
    const originalMvi = original._meta.mvi;
    applyFieldFilter(original, ["id"]);
    expect(original._meta.mvi).toBe(originalMvi);
  });

  it("input result object references are not mutated after filter", () => {
    const original = loadEnvelope("fixtures/field-extraction-success.json");
    const originalResult = { ...(original.result as Record<string, unknown>) };
    applyFieldFilter(original, ["id"]);
    expect(original.result).toEqual(originalResult);
  });

  it("silently omits unknown field names", () => {
    const filtered = applyFieldFilter(flatEnvelope, ["id", "nonexistent"]);
    expect(filtered.result).toEqual({ id: "T001" });
  });

  it("empty fields array → returns unchanged", () => {
    const filtered = applyFieldFilter(flatEnvelope, []);
    expect(filtered).toBe(flatEnvelope);
  });

  it("null result → returns unchanged", () => {
    const envelope: LAFSEnvelope = { ...flatEnvelope, result: null };
    const filtered = applyFieldFilter(envelope, ["id"]);
    expect(filtered).toBe(envelope);
  });

  it("preserves structural fields ($schema, page, _extensions)", () => {
    const envelope: LAFSEnvelope = {
      ...wrapperEnvelope,
      _extensions: { lafs: { version: "1.0" } },
    };
    const filtered = applyFieldFilter(envelope, ["id"]);
    expect(filtered.$schema).toBe(envelope.$schema);
    expect(filtered.page).toEqual(envelope.page);
    expect(filtered._extensions).toEqual({ lafs: { version: "1.0" } });
  });

  it("wrapper with primitive key + array: primitive preserved, array projected", () => {
    const envelope: LAFSEnvelope = {
      ...flatEnvelope,
      result: {
        total: 100,
        items: [{ id: "T001", title: "Task", description: "verbose" }],
      },
    };
    const filtered = applyFieldFilter(envelope, ["id"]);
    expect(filtered.result).toEqual({
      total: 100,
      items: [{ id: "T001" }],
    });
  });
});

describe("integration: resolveFieldExtraction → applyFieldFilter", () => {
  it("full flow: resolution.fields feeds applyFieldFilter, expectsCustomMvi=true, mvi='custom'", () => {
    const resolution = resolveFieldExtraction({ fieldsFlag: "id,title" });
    expect(resolution.fields).toEqual(["id", "title"]);
    expect(resolution.expectsCustomMvi).toBe(true);

    const envelope = loadEnvelope("fixtures/field-extraction-success.json");
    const filtered = applyFieldFilter(envelope, resolution.fields!);
    expect(filtered.result).toEqual({ id: "T001", title: "Example Task" });
    expect(filtered._meta.mvi).toBe("custom");
  });
});
