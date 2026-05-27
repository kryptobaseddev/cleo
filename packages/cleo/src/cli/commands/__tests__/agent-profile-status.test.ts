/**
 * Unit tests for `computeProfileStatus` — the pure helper that
 * computes the human-readable `profile` field surfaced by the
 * `cleo agent start` LAFS envelope.
 *
 * These tests deliberately do NOT spin up the daemon, the registry,
 * or `createRuntime`. They exercise the helper directly because the
 * helper is the entire surface that decides what status string the
 * operator sees. The daemon never executes the profile, so there is
 * no daemon-side runtime behaviour worth asserting here — see the
 * block comment above `cleo agent start` in `../agent.ts` for the
 * Pi/daemon split rationale.
 *
 * @see ../agent-profile-status.ts
 * @see .cleo/adrs/ADR-035-pi-v2-v3-harness.md §D5 + Addendum
 */

import { describe, expect, it } from 'vitest';
import { computeProfileStatus, type ProfileValidation } from '../agent-profile-status.js';

describe('computeProfileStatus', () => {
  it("returns 'none' when no profile file was loaded", () => {
    expect(computeProfileStatus(null, null)).toBe('none');
  });

  it("returns 'none' even when validation is non-null but profile is null", () => {
    // Defensive branch: if a caller somehow produces a validation
    // result without a profile (impossible in current code, but the
    // helper must still resolve to 'none' rather than reporting on a
    // phantom file).
    const validation: ProfileValidation = { valid: true, errors: [] };
    expect(computeProfileStatus(null, validation)).toBe('none');
  });

  it("returns 'loaded (unvalidated)' when the profile loaded but no validator was available", () => {
    expect(computeProfileStatus('agent foo:\n  model: opus\n', null)).toBe('loaded (unvalidated)');
  });

  it("returns 'validated' when the profile loaded and the validator returned valid:true", () => {
    const validation: ProfileValidation = { valid: true, errors: [] };
    expect(computeProfileStatus('agent foo:\n', validation)).toBe('validated');
  });

  it("returns 'invalid (N errors)' with N === diagnostics count when the validator failed", () => {
    const validation: ProfileValidation = {
      valid: false,
      errors: ['unknown event "Lol"', 'invalid indentation'],
    };
    expect(computeProfileStatus('agent foo:\n', validation)).toBe('invalid (2 errors)');
  });

  it("returns 'invalid (0 errors)' when valid is false but the diagnostics list is empty", () => {
    // Edge case: parser said the doc is invalid but did not surface
    // any diagnostics. We still report it so the operator sees the
    // file is bad. The error count is the source of truth, not the
    // valid flag, for the rendered string.
    const validation: ProfileValidation = { valid: false, errors: [] };
    expect(computeProfileStatus('agent foo:\n', validation)).toBe('invalid (0 errors)');
  });

  it("returns 'invalid (1 errors)' for a single diagnostic (no English pluralisation)", () => {
    // The status string is structured for grep-ability, not natural
    // language. Operators tail logs, not paragraphs.
    const validation: ProfileValidation = { valid: false, errors: ['only one'] };
    expect(computeProfileStatus('agent foo:\n', validation)).toBe('invalid (1 errors)');
  });

  it('treats an empty profile string as a loaded file (not none)', () => {
    // An empty string is still "loaded" — the file existed on disk.
    // Whether the parser accepts an empty body is a separate concern
    // that the validator (when available) will surface.
    expect(computeProfileStatus('', null)).toBe('loaded (unvalidated)');
    const valid: ProfileValidation = { valid: true, errors: [] };
    expect(computeProfileStatus('', valid)).toBe('validated');
  });
});
