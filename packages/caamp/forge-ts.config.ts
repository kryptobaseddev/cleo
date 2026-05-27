import { type ForgeConfig, Visibility } from "@forge-ts/core";

/**
 * forge-ts configuration for `@cleocode/caamp`.
 *
 * Strategy:
 * - Enforce the API-layer rules that keep the generated API reference
 *   accurate (summary/param/returns/example/class-member-doc/interface-member-doc).
 * - Keep `require-remarks` on but as a warning so narrative drift surfaces
 *   in the check report without blocking doc regeneration.
 * - Turn off the consumer-layer release-tag rule (and the W011 @since
 *   rider it triggers) because CAAMP does not yet commit to the release
 *   tag taxonomy across every internal export. It will be re-enabled in a
 *   follow-up once the @public/@beta/@internal audit lands.
 * - Turn off `require-see` (W005) and `require-default-value` (E014) as
 *   warnings: they are nice to have but would drown the signal from the
 *   real coverage gates.
 *
 * Generator targets:
 * - Single-file markdown API reference at
 *   `docs/generated/api-reference.md` (the canonical forge-ts location).
 * - `llms.txt` + `llms-full.txt` for agent consumption.
 * - `SKILL.md` skill package scaffolding.
 *
 * The stale hand-maintained `docs/API-REFERENCE.md` has been retired and
 * replaced with a pointer to `docs/generated/api-reference.md`.
 */
export default {
  rootDir: ".",
  outDir: "./docs/generated",
  enforce: {
    enabled: true,
    minVisibility: Visibility.Public,
    strict: false,
    rules: {
      // API Layer — load-bearing for the generated API reference.
      "require-summary": "error",
      "require-param": "error",
      "require-returns": "error",
      "require-example": "error",
      "require-package-doc": "warn",
      "require-class-member-doc": "error",
      "require-interface-member-doc": "error",
      // Dev Layer — narrative quality.
      "require-remarks": "warn",
      "require-default-value": "off",
      "require-see": "off",
      "require-tsdoc-syntax": "warn",
      "require-fresh-examples": "warn",
      // Consumer Layer — release discipline (paused pending audit).
      "require-release-tag": "off",
      "require-since": "off",
      "require-fresh-guides": "off",
      "require-guide-coverage": "off",
    },
  },
  gen: {
    enabled: true,
    formats: ["markdown"],
    llmsTxt: true,
    readmeSync: false,
  },
  guards: {
    tsconfig: { enabled: true },
    biome: { enabled: false },
    packageJson: { enabled: false },
  },
} satisfies Partial<ForgeConfig>;
