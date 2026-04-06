import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createEnvelope,
  emitDeprecationWarnings,
  getDeprecationRegistry,
  type LAFSEnvelope,
} from "../src/index.js";

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("deprecation registry", () => {
  it("contains sunset-date metadata", () => {
    const registry = getDeprecationRegistry();
    expect(registry.length).toBeGreaterThan(0);
    expect(registry.every((entry) => Boolean(entry.removeBy))).toBe(true);
  });

  it("emits warning for deprecated boolean mvi usage", () => {
    const legacyEnvelope = {
      $schema: "https://lafs.dev/schemas/v1/envelope.schema.json",
      _meta: {
        specVersion: "1.0.0",
        schemaVersion: "1.0.0",
        timestamp: new Date().toISOString(),
        operation: "legacy.mvi",
        requestId: "req_legacy_mvi",
        transport: "sdk",
        strict: true,
        mvi: true,
        contextVersion: 0,
      },
      success: true,
      result: { ok: true },
    } as unknown as LAFSEnvelope;

    const warned = emitDeprecationWarnings(legacyEnvelope);
    const warnings = warned._meta.warnings ?? [];
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]?.code).toBe("W_DEPRECATED_META_MVI_BOOLEAN");
    expect(warnings[0]?.removeBy).toBe("2.0.0");
  });

  it("preserves existing warnings while appending new ones", () => {
    const base = createEnvelope({
      success: true,
      result: { ok: true },
      meta: {
        operation: "legacy.append",
        requestId: "req_append",
        warnings: [{ code: "W_EXISTING", message: "existing warning" }],
      },
    });

    const legacy = {
      ...base,
      _meta: {
        ...base._meta,
        mvi: true,
      },
    } as unknown as LAFSEnvelope;

    const warned = emitDeprecationWarnings(legacy);
    expect(warned._meta.warnings?.some((w) => w.code === "W_EXISTING")).toBe(true);
    expect(warned._meta.warnings?.some((w) => w.code === "W_DEPRECATED_META_MVI_BOOLEAN")).toBe(
      true,
    );
  });
});

describe("migration manifest parsing", () => {
  it("parses 1.0.0-to-1.1.0 migration manifest with warnings change", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(PKG_ROOT, "migrations/1.0.0-to-1.1.0.json"), "utf8"),
    ) as {
      from: string;
      to: string;
      changes: Array<{ path: string; type: string }>;
    };

    expect(manifest.from).toBe("1.0.0");
    expect(manifest.to).toBe("1.1.0");
    expect(
      manifest.changes.some(
        (change) => change.path === "_meta.warnings" && change.type === "add_optional_field",
      ),
    ).toBe(true);
  });
});
