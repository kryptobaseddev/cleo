/**
 * Decision-site registry invariants and backward compatibility (T12662).
 *
 * The existing site ids and `decide.*` config keys must not change (D11159,
 * spec R10): they key the audit log and the operator's config. The site
 * modules now take them from the registry, so these tests pin the literal
 * values and prove the old constant names still resolve to them.
 *
 * @task T12662
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DECISION_RUNGS, type DecisionRung } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import {
  DECISION_CONTRADICTION_LLM_KEY,
  DECISION_CONTRADICTION_MIN_CONFIDENCE,
  DECISION_CONTRADICTION_MODE_KEY,
  DECISION_CONTRADICTION_SITE,
} from '../../memory/decision-contradiction.js';
import {
  OBSERVATION_TYPE_MIN_CONFIDENCE,
  OBSERVATION_TYPE_MODE_KEY,
  OBSERVATION_TYPE_SITE,
} from '../../memory/observation-type-decision.js';
import { OWNER_DECISION_MIN_CONFIDENCE } from '../../orchestration/classify-readiness.js';
import {
  OWNER_DECISION_MODE_KEY,
  OWNER_DECISION_SITE,
} from '../../orchestration/owner-decision-readiness.js';
import {
  DUPLICATE_DECISION_MIN_CONFIDENCE,
  DUPLICATE_DECISION_MODE_KEY,
  DUPLICATE_DECISION_SITE,
  DUPLICATE_LLM_TIER_KEY,
} from '../../tasks/duplicate-detector.js';
import {
  DECIDE_ASK_DECISION_SITE,
  DECISION_CONTRADICTION_DECISION_SITE,
  DECISION_SITES,
  DUPLICATE_DETECTION_SITE,
  getDecisionSite,
  OBSERVATION_TYPE_DECISION_SITE,
  OWNER_DECISION_DECISION_SITE,
} from '../sites/registry.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');

describe('decision-site registry (T12662)', () => {
  it('has unique ids', () => {
    const ids = DECISION_SITES.map((s) => s.id);
    expect(ids).toEqual([...new Set(ids)]);
  });

  it('names only files that exist', () => {
    const missing = DECISION_SITES.flatMap((s) =>
      s.files.filter((f) => !existsSync(join(REPO_ROOT, f))).map((f) => `${s.id}: ${f}`),
    );
    expect(missing).toEqual([]);
  });

  it('only escalates upward: every ladder rung is above the primary, in order', () => {
    const rank = (r: DecisionRung): number => DECISION_RUNGS.indexOf(r);
    for (const site of DECISION_SITES) {
      let last = rank(site.primaryRung);
      for (const rung of site.ladder) {
        expect(rank(rung), `${site.id}: ${rung} after ${site.primaryRung}`).toBeGreaterThan(last);
        last = rank(rung);
      }
    }
  });

  it('gives every mode-driven System One site a decide.sites.* mode key', () => {
    for (const site of DECISION_SITES) {
      const usesSystemOne = site.primaryRung === 'system-one' || site.ladder.includes('system-one');
      if (!usesSystemOne || site.id === DECIDE_ASK_DECISION_SITE.id) continue;
      expect(site.modeKey, site.id).toMatch(/^decide\.sites\./);
    }
  });

  it('registers the four existing sites and the debug verb', () => {
    for (const id of [
      'tasks.duplicate-detection',
      'memory.decision-contradiction',
      'memory.observation-type',
      'orchestration.owner-decision',
      'cli.decide-ask',
    ]) {
      expect(getDecisionSite(id), id).toBeDefined();
    }
  });
});

describe('the existing site ids and config keys are unchanged (D11159, R10)', () => {
  it.each([
    [DUPLICATE_DECISION_SITE, 'tasks.duplicate-detection', DUPLICATE_DETECTION_SITE.id],
    [
      DECISION_CONTRADICTION_SITE,
      'memory.decision-contradiction',
      DECISION_CONTRADICTION_DECISION_SITE.id,
    ],
    [OBSERVATION_TYPE_SITE, 'memory.observation-type', OBSERVATION_TYPE_DECISION_SITE.id],
    [OWNER_DECISION_SITE, 'orchestration.owner-decision', OWNER_DECISION_DECISION_SITE.id],
  ])('site id %s', (constant, literal, registry) => {
    expect(constant).toBe(literal);
    expect(registry).toBe(literal);
  });

  it.each([
    [DUPLICATE_DECISION_MODE_KEY, 'decide.sites.duplicateDetection'],
    [DUPLICATE_LLM_TIER_KEY, 'decide.generativeFallback.duplicateDetection'],
    [DECISION_CONTRADICTION_MODE_KEY, 'decide.sites.decisionContradiction'],
    [DECISION_CONTRADICTION_LLM_KEY, 'decide.generativeFallback.decisionContradiction'],
    [OBSERVATION_TYPE_MODE_KEY, 'decide.sites.observationType'],
    [OWNER_DECISION_MODE_KEY, 'decide.sites.ownerDecision'],
  ])('config key %s', (constant, literal) => {
    expect(constant).toBe(literal);
  });

  it('records the floors the sites actually use', () => {
    expect(DUPLICATE_DETECTION_SITE.floors['*']).toBe(DUPLICATE_DECISION_MIN_CONFIDENCE);
    expect(DECISION_CONTRADICTION_DECISION_SITE.floors['*']).toBe(
      DECISION_CONTRADICTION_MIN_CONFIDENCE,
    );
    expect(OBSERVATION_TYPE_DECISION_SITE.floors['*']).toBe(OBSERVATION_TYPE_MIN_CONFIDENCE);
    expect(OWNER_DECISION_DECISION_SITE.floors['*']).toBe(OWNER_DECISION_MIN_CONFIDENCE);
  });
});
