/**
 * T10483 — release command/template shared-surface contract.
 *
 * These tests pin the taxonomy needed by T10468/T10476: shipped CLEO release
 * commands, cleocode dogfood workflow templates, and the command↔template seams
 * that are shared public surfaces. They also protect deterministic
 * changesets-first release planning and the no-LLM blocking path invariant.
 */

import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  RELEASE_SHARED_COMMAND_SURFACES,
  RELEASE_SHARED_SURFACE_CONTRACT,
  RELEASE_SHARED_TEMPLATE_SURFACES,
} from '../release.js';

/** Repository root, resolved from this file (`packages/contracts/src/operations/__tests__`). */
const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
/** The shipped workflow-template directory the contract claims to cover. */
const WORKFLOW_TEMPLATE_DIR = fileURLToPath(
  new URL('../../../../core/templates/workflows/', import.meta.url),
);

describe('release shared-surface contract (T10483)', () => {
  it('classifies shipped release surfaces as consumer tooling or shared, never dogfood', () => {
    const audiences = new Set<string>([
      ...RELEASE_SHARED_COMMAND_SURFACES.map((surface) => surface.audience),
      ...RELEASE_SHARED_TEMPLATE_SURFACES.map((surface) => surface.audience),
    ]);

    // Dogfood-only owner CI lives in the cleocode repo's .github/workflows and
    // is never shipped, so no shipped command or template may carry it.
    expect(audiences).toEqual(new Set(['shipped-consumer-tooling', 'shared-surface']));
  });

  it('pins every command to its registered dispatch gateway/operation', () => {
    const byCommand = new Map(
      RELEASE_SHARED_COMMAND_SURFACES.map((surface) => [
        surface.command,
        `${surface.gateway}:${surface.operation}`,
      ]),
    );

    expect(byCommand).toEqual(
      new Map([
        ['cleo release plan', 'mutate:release.plan'],
        ['cleo release open', 'mutate:release.open'],
        ['cleo release reconcile', 'mutate:release.reconcile'],
        ['cleo release rollback', 'mutate:pipeline.release.rollback'],
      ]),
    );
  });

  it('covers each shipped release workflow template on disk exactly once', () => {
    // Compare against the real template directory, not a restated list, so a
    // template added or removed without updating the contract fails here.
    const onDisk = readdirSync(WORKFLOW_TEMPLATE_DIR)
      .filter((name) => name.endsWith('.yml.tmpl'))
      .map((name) => name.replace(/\.tmpl$/, ''))
      .sort();
    const rendered = RELEASE_SHARED_TEMPLATE_SURFACES.map((surface) => surface.renderedWorkflow);

    expect(onDisk.length).toBeGreaterThan(0);
    expect([...rendered].sort()).toEqual(onDisk);
    for (const surface of RELEASE_SHARED_TEMPLATE_SURFACES) {
      expect(existsSync(`${REPO_ROOT}${surface.template}`), surface.template).toBe(true);
      expect(surface.template.endsWith(`/${surface.renderedWorkflow}.tmpl`)).toBe(true);
    }
  });

  it('pins deterministic changesets-first planning as local and network-free', () => {
    const plan = RELEASE_SHARED_COMMAND_SURFACES.find(
      (surface) =>
        surface.command === RELEASE_SHARED_SURFACE_CONTRACT.invariants.deterministicPlanningCommand,
    );

    expect(plan).toBeDefined();
    expect(plan?.operation).toBe('release.plan');
    expect(plan?.deterministic).toBe(true);
    expect(plan?.mayCallNetwork).toBe(false);
    expect(plan?.changesetRequired).toBe(true);
  });

  it('forbids LLM-first blocking paths on every release command and workflow template', () => {
    expect(RELEASE_SHARED_SURFACE_CONTRACT.invariants.llmBlockingPathAllowed).toBe(false);

    for (const surface of RELEASE_SHARED_COMMAND_SURFACES) {
      expect(surface.llmBlockingPath).toBe(false);
    }
    for (const surface of RELEASE_SHARED_TEMPLATE_SURFACES) {
      expect(surface.llmBlockingPath).toBe(false);
    }
  });

  it('keeps public workflow templates attached to a shipped owner command', () => {
    const commands = new Set(RELEASE_SHARED_COMMAND_SURFACES.map((surface) => surface.command));

    for (const template of RELEASE_SHARED_TEMPLATE_SURFACES) {
      expect(template.template).toMatch(
        /^packages\/core\/templates\/workflows\/release-.+\.yml\.tmpl$/,
      );
      expect(template.renderSnapshotRequired).toBe(true);
      if (template.stability === 'public-contract') {
        expect(commands.has(template.owningCommand), template.owningCommand).toBe(true);
        expect(template.audience).toBe('shared-surface');
        expect(template.consumesReleasePlan).toBe(true);
      }
    }
  });
});
