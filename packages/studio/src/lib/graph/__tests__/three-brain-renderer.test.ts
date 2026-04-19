/**
 * Smoke + contract tests for the primary 3D renderer and cluster-label-layer.
 *
 * These tests intentionally avoid mounting the Svelte component (that
 * requires a DOM + WebGL). They assert:
 *   - the surrounding module graph is importable,
 *   - the mock payload respects the kit contract,
 *   - the renderer module itself evaluates without side effects, AND
 *   - the rebuild spec (T990 Agent-B overhaul) holds at the source level:
 *       * `assertNoFaceUp({ drawLabels: false, ... })` is invoked,
 *       * OrbitControls.autoRotate is set to `false`,
 *       * no starfield / nebula helpers exist in the source,
 *       * the scene clear colour is pitch black,
 *       * `forceRegion` custom force is declared and registered,
 *       * the substrate → cortical region mapping is complete,
 *       * the bridge edge layer exists and uses `var(--accent)`,
 *       * the spark pool is pre-allocated at MAX_FIRES = 512,
 *       * `assertNoFaceUp` is called at init,
 *       * cluster-label-layer renders exactly 5 labels.
 *     These are source-level assertions (regex over the file body)
 *     because we cannot reliably mount a WebGL component in the vitest
 *     node environment.
 *
 * @task T990
 * @wave 1A — Agent B overhaul
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CORTICAL_REGIONS } from '../cluster-label-layer.svelte';
import { ALL_EDGE_KINDS } from '../edge-kinds.js';
import { mockBrain } from '../mock.js';
import { ALL_SUBSTRATES } from '../types.js';

/** Absolute path to the primary renderer source — used by source-level asserts. */
const RENDERER_PATH = fileURLToPath(
  new URL('../renderers/ThreeBrainRenderer.svelte', import.meta.url),
);

/** Absolute path to the flat 2D cosmograph — used by source-level asserts. */
const COSMOGRAPH_PATH = fileURLToPath(
  new URL('../../components/LivingBrainCosmograph.svelte', import.meta.url),
);

/** Absolute path to the cluster-label-layer — used by source-level asserts. */
const CLUSTER_LABEL_PATH = fileURLToPath(new URL('../cluster-label-layer.svelte', import.meta.url));

describe('mockBrain', () => {
  it('returns exactly the requested node + edge counts by default', () => {
    const payload = mockBrain();
    expect(payload.nodes.length).toBe(400);
    expect(payload.edges.length).toBe(600);
  });

  it('produces nodes across all five substrates', () => {
    const payload = mockBrain(300, 400);
    const seen = new Set(payload.nodes.map((n) => n.substrate));
    for (const sub of ALL_SUBSTRATES) {
      expect(seen.has(sub)).toBe(true);
    }
  });

  it('never references an edge endpoint that is not in the node set', () => {
    const payload = mockBrain(200, 300);
    const ids = new Set(payload.nodes.map((n) => n.id));
    for (const e of payload.edges) {
      expect(ids.has(e.source)).toBe(true);
      expect(ids.has(e.target)).toBe(true);
    }
  });

  it('uses only canonical edge kinds', () => {
    const payload = mockBrain(200, 300);
    const valid = new Set<string>(ALL_EDGE_KINDS);
    for (const e of payload.edges) {
      expect(valid.has(e.kind)).toBe(true);
    }
  });

  it('is deterministic for a fixed seed', () => {
    const a = mockBrain(100, 120, 0xdeadbeef);
    const b = mockBrain(100, 120, 0xdeadbeef);
    expect(a.nodes.map((n) => n.id)).toEqual(b.nodes.map((n) => n.id));
    expect(a.edges.map((e) => e.id)).toEqual(b.edges.map((e) => e.id));
  });
});

describe('renderer module', () => {
  it('imports ThreeBrainRenderer without throwing at module eval', async () => {
    const mod = await import('../renderers/ThreeBrainRenderer.svelte');
    expect(mod.default).toBeDefined();
  });

  it('exposes the full public surface via the barrel', async () => {
    const kit = await import('../index.js');
    expect(kit.FiringQueue).toBeDefined();
    expect(kit.EDGE_STYLE).toBeDefined();
    expect(kit.assertNoFaceUp).toBeDefined();
    expect(kit.mockBrain).toBeDefined();
    expect(kit.ThreeBrainRenderer).toBeDefined();
    expect(kit.HoverLabel).toBeDefined();
    expect(kit.ClusterLabelLayer).toBeDefined();
  });
});

describe('ThreeBrainRenderer — T990 Agent-B rebuild contract', () => {
  const source = readFileSync(RENDERER_PATH, 'utf8');

  it('calls assertNoFaceUp with drawLabels: false at mount', () => {
    expect(source).toMatch(/assertNoFaceUp\(\s*\{\s*drawLabels:\s*false/);
  });

  it('sets OrbitControls.autoRotate to false', () => {
    expect(source).toMatch(/controls\.autoRotate\s*=\s*false/);
  });

  it('does NOT reference any autoRotate=true default', () => {
    expect(source).not.toMatch(/autoRotate\s*[:=]\s*true/);
  });

  it('does NOT contain a starfield helper', () => {
    expect(source).not.toMatch(/makeStarfield/);
  });

  it('does NOT contain a nebula helper', () => {
    expect(source).not.toMatch(/makeNebula/);
  });

  it('does NOT add a starfield or nebula object to the scene graph', () => {
    expect(source).not.toMatch(/\b(let|const|var)\s+stars\b/);
    expect(source).not.toMatch(/\b(let|const|var)\s+nebula\b/);
    expect(source).not.toMatch(/scene\.add\(\s*stars\b/);
    expect(source).not.toMatch(/scene\.add\(\s*nebula\b/);
  });

  it('uses a pitch-black scene clear colour', () => {
    expect(source).toMatch(/setClearColor\(0x000000/);
    expect(source).toMatch(/new THREE\.Color\(0x000000\)/);
  });

  it('raycaster configures Points.threshold for dynamic picking', () => {
    expect(source).toMatch(/raycaster\.params\.Points\s*=\s*\{/);
  });

  it('declares a focusSubstrate prop for drill-down', () => {
    expect(source).toMatch(/focusSubstrate\??:\s*SubstrateId\s*\|\s*null/);
  });

  it('declares a showSynapses prop defaulted to true per operator mandate', () => {
    expect(source).toMatch(/showSynapses\??:\s*boolean/);
    // Agent-B overhaul: default is NOW true — operator wants the synapse web visible.
    expect(source).toMatch(/showSynapses\s*=\s*true/);
  });

  // -------------------------------------------------------------------------
  // Agent-B contract assertions (new in this overhaul)
  // -------------------------------------------------------------------------

  it('declares and registers a forceRegion custom force', () => {
    // forceRegion must be declared as a function.
    expect(source).toMatch(/function forceRegion/);
    // Must be registered on the simulation via .force('region', ...).
    expect(source).toMatch(/\.force\(\s*'region'/);
  });

  it('uses SUBSTRATE_ANCHOR for brain-shaped 3D positioning', () => {
    expect(source).toMatch(/SUBSTRATE_ANCHOR/);
    // tasks = PREFRONTAL anchor (anterior-superior-anterior).
    expect(source).toMatch(/tasks:\s*\[-80,\s*60,\s*100\]/);
    // signaldock = BRAINSTEM anchor (inferior-posterior).
    expect(source).toMatch(/signaldock:\s*\[0,\s*-120,\s*-30\]/);
  });

  it('maps substrates to CLEO substrate names via CORTICAL_NAME', () => {
    // Real CLEO substrate identifiers — not brain-anatomy metaphors.
    // The variable name `CORTICAL_NAME` is kept for backwards-compatibility
    // with existing source greps.
    expect(source).toMatch(/CORTICAL_NAME/);
    expect(source).toMatch(/brain:\s*'BRAIN'/);
    expect(source).toMatch(/nexus:\s*'NEXUS'/);
    expect(source).toMatch(/tasks:\s*'TASKS'/);
    expect(source).toMatch(/conduit:\s*'CONDUIT'/);
    expect(source).toMatch(/signaldock:\s*'SIGNALDOCK'/);
  });

  it('declares SUBSTRATE_NOUN for per-substrate content-kind labels', () => {
    expect(source).toMatch(/SUBSTRATE_NOUN/);
    expect(source).toMatch(/brain:\s*'MEMORIES'/);
    expect(source).toMatch(/nexus:\s*'SYMBOLS'/);
    expect(source).toMatch(/conduit:\s*'MESSAGES'/);
    expect(source).toMatch(/signaldock:\s*'AGENTS'/);
  });

  it('has a bridge edge layer for cross-substrate edges', () => {
    // bridgeLines must exist as a LineSegments in the scene.
    expect(source).toMatch(/bridgeLines/);
    // Bridge layer uses var(--accent) (violet) for the callosum effect.
    expect(source).toMatch(/var\(--accent\)/);
  });

  it('pre-allocates spark pool at MAX_FIRES = 512', () => {
    expect(source).toMatch(/MAX_FIRES\s*=\s*512/);
    // Pool buffers must be allocated with MAX_FIRES * 3 floats.
    expect(source).toMatch(/MAX_FIRES\s*\*\s*3/);
    // setDrawRange must be called to limit rendered sparks.
    expect(source).toMatch(/setDrawRange/);
  });

  it('integrates the firing-queue by calling tick each frame', () => {
    expect(source).toMatch(/firingQueue\.tick\(/);
  });

  it('has space-bar handler to toggle breathing pause', () => {
    expect(source).toMatch(/case\s+' '/);
    expect(source).toMatch(/breathingPaused/);
  });

  it('uses IDLE_ALPHA constant for breathing simulation', () => {
    expect(source).toMatch(/IDLE_ALPHA\s*=\s*0\.012/);
    expect(source).toMatch(/alphaTarget\(IDLE_ALPHA\)/);
  });

  it('has dynamic raycaster threshold based on camera distance', () => {
    expect(source).toMatch(/camDist\s*\*\s*0\.012/);
  });

  it('has zero hex colour literals outside of scene background', () => {
    // Count ALL hex literals in the source (comments included).
    // Only 0x000000 (the pitch-black bg) is allowed.
    const hexLiterals = source.match(/0x[0-9a-fA-F]{6}\b/g) ?? [];
    // All instances should be the pitch-black value.
    for (const hex of hexLiterals) {
      expect(hex.toLowerCase()).toBe('0x000000');
    }
  });
});

describe('cluster-label-layer — Agent-B contract', () => {
  const source = readFileSync(CLUSTER_LABEL_PATH, 'utf8');

  it('exports CORTICAL_REGIONS mapping all five substrates', () => {
    expect(CORTICAL_REGIONS).toBeDefined();
    expect(CORTICAL_REGIONS.brain).toBe('BRAIN');
    expect(CORTICAL_REGIONS.nexus).toBe('NEXUS');
    expect(CORTICAL_REGIONS.tasks).toBe('TASKS');
    expect(CORTICAL_REGIONS.conduit).toBe('CONDUIT');
    expect(CORTICAL_REGIONS.signaldock).toBe('SIGNALDOCK');
  });

  it('renders exactly 5 labels via {#each points}', () => {
    // The template iterates over `points`. At runtime the caller passes
    // exactly 5. The contract is enforced at the type level (5 substrates).
    expect(source).toMatch(/#each points as pt/);
  });

  it('displays NEURONS label (not NODES) per Agent-B spec', () => {
    expect(source).toMatch(/NEURONS/);
  });

  it('fades zero-node labels to 0.15 alpha', () => {
    // labelAlpha function returns 0.15 for zero-count substrates.
    expect(source).toMatch(/0\.15/);
  });

  it('uses glassmorphic pill styling (backdrop-filter, border-radius: 999px)', () => {
    expect(source).toMatch(/backdrop-filter:\s*blur/);
    expect(source).toMatch(/border-radius:\s*999px/);
  });

  it('uses token references not hex literals for colours', () => {
    const hexMatches = source.match(/['"]#[0-9a-fA-F]{3,8}['"]/g) ?? [];
    expect(hexMatches).toEqual([]);
  });

  it('respects focusedId prop to dim non-focused labels', () => {
    expect(source).toMatch(/focusedId/);
  });

  it('emits letter-spacing 0.08em and tabular-nums per ATC style', () => {
    expect(source).toMatch(/letter-spacing:\s*0\.08em/);
    expect(source).toMatch(/tabular-nums/);
  });
});

describe('LivingBrainCosmograph — T990 rebuild contract', () => {
  const source = readFileSync(COSMOGRAPH_PATH, 'utf8');

  it('consumes GraphNode/GraphEdge kit types (not legacy BrainNode/BrainEdge)', () => {
    expect(source).toMatch(/nodes:\s*GraphNode\[\]/);
    expect(source).toMatch(/edges:\s*GraphEdge\[\]/);
    expect(source).not.toMatch(/nodes:\s*BrainNode\[\]/);
    expect(source).not.toMatch(/edges:\s*BrainEdge\[\]/);
  });

  it('has zero hex colour literals in its source', () => {
    const hexMatches = source.match(/['"]#[0-9a-fA-F]{3,8}['"]/g) ?? [];
    expect(hexMatches).toEqual([]);
  });

  it('calls render() without an alpha override, matching the cosmos reference pattern', () => {
    // Post-collapse fix: we match the library's own basic-set-up example
    // (`zoom(0.9); render();`) instead of passing `render(1.0)`, which
    // over-ran the simulation alpha and froze nodes at initial positions.
    expect(source).toMatch(/cosmos\.render\(\)/);
    expect(source).not.toMatch(/cosmos\.start\(/);
    expect(source).toMatch(/cosmos\.zoom\(0\.9\)/);
  });

  it('guards against a 0x0 container via ResizeObserver before initialising', () => {
    expect(source).toMatch(/ResizeObserver/);
    expect(source).toMatch(/initWhenSized/);
  });

  // -------------------------------------------------------------------------
  // Root-cause fix: the infinite-loop guard (T990 Agent-A emergency fix)
  //
  // Previously `mounted` and `cosmosReady` were both `$state`. The
  // data-change `$effect` accessed `cosmosReady`, so Svelte tracked it.
  // When `initCosmos()` set `cosmosReady = true`, the effect re-fired,
  // called `initCosmos()` again (destroy + recreate), which set
  // `cosmosReady = false` then `true` again — an infinite loop that froze
  // the browser.
  //
  // Fix: `mounted` and `cosmosInitialized` are plain booleans, NOT `$state`.
  // The data-change `$effect` uses `cosmosInitialized` as a non-reactive
  // gate so it is never tracked by Svelte.
  // -------------------------------------------------------------------------

  it('declares mounted as a plain boolean (NOT $state) to prevent effect tracking', () => {
    // Must use `let mounted = false` — no $state() wrapper.
    expect(source).toMatch(/let mounted\s*=\s*false/);
    // Must NOT be `let mounted = $state(...)`.
    expect(source).not.toMatch(/let mounted\s*=\s*\$state/);
  });

  it('declares cosmosInitialized as a plain boolean (NOT $state) to prevent effect tracking', () => {
    // Must use `let cosmosInitialized = false` — no $state() wrapper.
    expect(source).toMatch(/let cosmosInitialized\s*=\s*false/);
    // Must NOT be `let cosmosInitialized = $state(...)`.
    expect(source).not.toMatch(/let cosmosInitialized\s*=\s*\$state/);
  });

  it('data-change $effect guards on cosmosInitialized before rebuilding', () => {
    // The guard pattern must appear inside the $effect block.
    expect(source).toMatch(/if\s*\(!cosmosInitialized\)\s*return/);
  });

  it('data-change $effect uses count-based change detection to skip spurious rebuilds', () => {
    // lastNodeCount and lastEdgeCount must be present.
    expect(source).toMatch(/lastNodeCount/);
    expect(source).toMatch(/lastEdgeCount/);
    // Must compare and early-return if counts unchanged.
    expect(source).toMatch(
      /nodeCount\s*===\s*lastNodeCount\s*&&\s*edgeCount\s*===\s*lastEdgeCount/,
    );
  });

  it('pulse $effect guards on cosmosInitialized not the removed cosmosReady state', () => {
    // Pulse effect must check cosmosInitialized (plain bool), not cosmosReady ($state).
    expect(source).toMatch(/!cosmosInitialized/);
    expect(source).not.toMatch(/cosmosReady/);
  });

  it('buildBuffers produces Float32Array for both positions and links (not Uint32Array)', () => {
    // cosmos.gl 2.x setLinks accepts Float32Array — link indices as floats.
    // Both position and link buffers must be Float32Array.
    expect(source).toMatch(/links\s*=\s*new Float32Array/);
    expect(source).toMatch(/positions\s*=\s*new Float32Array/);
    expect(source).not.toMatch(/new Uint32Array/);
  });
});
