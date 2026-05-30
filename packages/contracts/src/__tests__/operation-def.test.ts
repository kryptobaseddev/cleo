/**
 * Structural-equivalence tests for the dispatch operation-def contracts.
 *
 * These tests pin the field shapes of {@link OperationDef} and
 * {@link Resolution} (and the underlying identity types {@link Gateway},
 * {@link Tier}, {@link CanonicalDomain}) so accidental narrowing or
 * widening triggers a compile-time failure during `tsc -b` in the CI
 * gate.
 *
 * The compile-time assertions use the conditional-equality trick
 * (`Equals<A, B>`) so any structural drift produces a TS2322 or TS2344
 * at build time. The runtime `expect` shape sanity check below is a
 * thin smoke verification that constructible literals satisfy each
 * interface — it does NOT exercise behavior (these are pure type
 * contracts with no runtime).
 *
 * @since SG-ARCH-SOLID Saga T9831 · E-CONTRACTS-FOUNDATION T9832 · T9954 (Phase 0b)
 */

import { describe, expect, it } from 'vitest';
import type { CanonicalDomain, Gateway, Tier } from '../dispatch/identity.js';
import { CANONICAL_DOMAINS } from '../dispatch/identity.js';
import type { OperationDef, Resolution } from '../dispatch/operation-def.js';
import type { ParamDef } from '../operations/params.js';

// ─── Compile-time structural-equality helpers ───────────────────────

/** Resolve to `1` IFF `A` and `B` are mutually assignable; `2` otherwise. */
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? 1 : 2;

/** Compile-time assert that `T` resolves to `1`. */
type AssertEquals1<T extends 1> = T;

// ─── Gateway shape pin ──────────────────────────────────────────────

type _GatewayShape = 'query' | 'mutate';

type _AssertGatewayPinned = AssertEquals1<Equals<Gateway, _GatewayShape>>;

// ─── Tier shape pin ─────────────────────────────────────────────────

type _TierShape = 0 | 1 | 2;

type _AssertTierPinned = AssertEquals1<Equals<Tier, _TierShape>>;

// ─── CanonicalDomain shape pin ──────────────────────────────────────
// CanonicalDomain is derived from the runtime tuple CANONICAL_DOMAINS;
// pinning the tuple element type guards against silent drift if someone
// reorders the array but accidentally introduces a `string`-widened
// element (e.g. `... as string[]`).

type _CanonicalDomainShape = (typeof CANONICAL_DOMAINS)[number];

type _AssertCanonicalDomainPinned = AssertEquals1<Equals<CanonicalDomain, _CanonicalDomainShape>>;

// ─── OperationDef shape pin ─────────────────────────────────────────

type _OperationDefShape = {
  gateway: Gateway;
  domain: CanonicalDomain;
  operation: string;
  description: string;
  tier: Tier;
  idempotent: boolean;
  sessionRequired: boolean;
  requiredParams: string[];
  params?: ParamDef[];
};

type _AssertOperationDefPinned = AssertEquals1<Equals<OperationDef, _OperationDefShape>>;

// ─── Resolution shape pin ───────────────────────────────────────────

type _ResolutionShape = {
  domain: CanonicalDomain;
  operation: string;
  def: OperationDef;
};

type _AssertResolutionPinned = AssertEquals1<Equals<Resolution, _ResolutionShape>>;

// ─── Runtime constructibility smoke ─────────────────────────────────

describe('dispatch/operation-def contracts', () => {
  it('Gateway union covers exactly the 2 documented values', () => {
    const values: Gateway[] = ['query', 'mutate'];
    expect(values).toHaveLength(2);
  });

  it('Tier union covers exactly the 3 documented values', () => {
    const tiers: Tier[] = [0, 1, 2];
    expect(tiers).toHaveLength(3);
  });

  it('CANONICAL_DOMAINS is a non-empty readonly tuple', () => {
    expect(CANONICAL_DOMAINS.length).toBeGreaterThan(0);
    // T9954 — snapshot the current count so accidental additions/removals
    // trip this test and force an explicit human review.
    expect(CANONICAL_DOMAINS.length).toBe(23);
  });

  it('CANONICAL_DOMAINS contains the four sentinel newly-promoted domains', () => {
    // Spot-check the canonical surface: T964 conduit, T1726 sentient/release,
    // T9528 provenance, T9536 upgrade. Catches the most common drift where
    // someone deletes one and breaks SDK consumers downstream.
    expect(CANONICAL_DOMAINS).toContain('conduit');
    expect(CANONICAL_DOMAINS).toContain('sentient');
    expect(CANONICAL_DOMAINS).toContain('release');
    expect(CANONICAL_DOMAINS).toContain('provenance');
    expect(CANONICAL_DOMAINS).toContain('upgrade');
  });

  it('OperationDef is constructible with the canonical shape (no params field)', () => {
    const def: OperationDef = {
      gateway: 'query',
      domain: 'tasks',
      operation: 'show',
      description: 'tasks.show (query)',
      tier: 0,
      idempotent: true,
      sessionRequired: false,
      requiredParams: ['taskId'],
    };
    expect(def.gateway).toBe('query');
    expect(def.domain).toBe('tasks');
    expect(def.params).toBeUndefined();
  });

  it('OperationDef is constructible with the optional params field populated', () => {
    const def: OperationDef = {
      gateway: 'mutate',
      domain: 'tasks',
      operation: 'add',
      description: 'tasks.add (mutate)',
      tier: 0,
      idempotent: false,
      sessionRequired: false,
      requiredParams: ['title'],
      params: [
        {
          name: 'title',
          type: 'string',
          required: true,
          description: 'Title of the task',
        },
      ],
    };
    expect(def.params).toHaveLength(1);
    expect(def.params?.[0].name).toBe('title');
  });

  it('Resolution wraps a domain + operation + def triple', () => {
    const def: OperationDef = {
      gateway: 'query',
      domain: 'session',
      operation: 'status',
      description: 'session.status (query)',
      tier: 0,
      idempotent: true,
      sessionRequired: false,
      requiredParams: [],
    };
    const r: Resolution = {
      domain: 'session',
      operation: 'status',
      def,
    };
    expect(r.domain).toBe('session');
    expect(r.def).toBe(def);
  });

  // The five `_Assert…Pinned` aliases above will fail compilation if
  // any shape drifts. The following references prevent unused-locals
  // diagnostics from removing them.
  it('compile-time pins are wired (no-op at runtime)', () => {
    const pinned: [
      _AssertGatewayPinned,
      _AssertTierPinned,
      _AssertCanonicalDomainPinned,
      _AssertOperationDefPinned,
      _AssertResolutionPinned,
    ] = [1, 1, 1, 1, 1];
    expect(pinned).toEqual([1, 1, 1, 1, 1]);
  });
});
