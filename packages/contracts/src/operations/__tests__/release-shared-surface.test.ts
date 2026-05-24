/**
 * T10483 — release command/template shared-surface contract.
 *
 * These tests pin the taxonomy needed by T10468/T10476: shipped CLEO release
 * commands, cleocode dogfood workflow templates, and the command↔template seams
 * that are shared public surfaces. They also protect deterministic
 * changesets-first release planning and the no-LLM blocking path invariant.
 */

import { describe, expect, it } from 'vitest';
import {
  RELEASE_SHARED_COMMAND_SURFACES,
  RELEASE_SHARED_SURFACE_CONTRACT,
  RELEASE_SHARED_TEMPLATE_SURFACES,
} from '../release.js';

describe('release shared-surface contract (T10483)', () => {
  it('classifies release surfaces across shipped consumer, dogfood, and shared categories', () => {
    const audiences = new Set([
      ...RELEASE_SHARED_COMMAND_SURFACES.map((surface) => surface.audience),
      ...RELEASE_SHARED_TEMPLATE_SURFACES.map((surface) => surface.audience),
    ]);

    expect(audiences).toEqual(
      new Set(['shipped-consumer-tooling', 'cleocode-dogfood-workflow', 'shared-surface']),
    );
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
