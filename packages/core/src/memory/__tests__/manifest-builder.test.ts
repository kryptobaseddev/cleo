/**
 * Unit tests for {@link buildManifestEntryFromShorthand} — the core SDK helper
 * that the `cleo manifest append` CLI, Studio, and VS Code extension all share
 * so their shorthand → `pipeline_manifest` entries come out identical and
 * always pass the `pipelineManifestAppend` validator.
 *
 * @task T1187-followup · v2026.4.113
 */

import { describe, expect, it } from 'vitest';
import {
  buildManifestEntryFromShorthand,
  DEFAULT_MANIFEST_ENTRY_TYPE,
} from '../manifest-builder.js';

const FROZEN = new Date('2026-04-22T20:03:09.000Z');

describe('buildManifestEntryFromShorthand', () => {
  it('fills every validator-required field from the three-flag shorthand', () => {
    const entry = buildManifestEntryFromShorthand(
      {
        task: 'T1187',
        type: 'implementation',
        content: 'Shipped tree viz overhaul and MANIFEST.jsonl purge',
      },
      FROZEN,
    );

    // Every required ManifestEntry field present
    expect(entry.id).toMatch(/^T1187-implementation-\d{14}$/);
    expect(entry.file).toContain('.cleo/agent-outputs/T1187-implementation-');
    expect(entry.file).toMatch(/\.md$/);
    expect(entry.title).toBe('Shipped tree viz overhaul and MANIFEST.jsonl purge');
    expect(entry.date).toBe('2026-04-22');
    expect(entry.status).toBe('completed');
    expect(entry.agent_type).toBe('implementation');
    expect(entry.topics).toEqual(['T1187', 'implementation']);
    expect(entry.key_findings).toEqual(['Shipped tree viz overhaul and MANIFEST.jsonl purge']);
    expect(entry.actionable).toBe(false);
    expect(entry.needs_followup).toEqual([]);
    expect(entry.linked_tasks).toEqual(['T1187']);
  });

  it('defaults agent_type to DEFAULT_MANIFEST_ENTRY_TYPE when omitted', () => {
    const entry = buildManifestEntryFromShorthand({ task: 'T999' }, FROZEN);
    expect(entry.agent_type).toBe(DEFAULT_MANIFEST_ENTRY_TYPE);
    expect(entry.topics).toEqual(['T999', DEFAULT_MANIFEST_ENTRY_TYPE]);
  });

  it('truncates a long content first-line to 120 chars for the title', () => {
    const longLine = 'x'.repeat(250);
    const entry = buildManifestEntryFromShorthand(
      { task: 'T1', type: 'research', content: longLine },
      FROZEN,
    );
    expect(entry.title.length).toBe(120);
    expect(entry.title).toBe(longLine.slice(0, 120));
  });

  it('uses only the first line of content for the title', () => {
    const entry = buildManifestEntryFromShorthand(
      { task: 'T1', type: 'research', content: 'line one\nline two\nline three' },
      FROZEN,
    );
    expect(entry.title).toBe('line one');
    expect(entry.key_findings).toEqual(['line one\nline two\nline three']);
  });

  it('honours explicit title override', () => {
    const entry = buildManifestEntryFromShorthand(
      {
        task: 'T1',
        type: 'research',
        content: 'first line fallback',
        title: 'Explicit override title',
      },
      FROZEN,
    );
    expect(entry.title).toBe('Explicit override title');
  });

  it('accepts status overrides partial + blocked', () => {
    expect(buildManifestEntryFromShorthand({ task: 'T1', status: 'partial' }, FROZEN).status).toBe(
      'partial',
    );
    expect(buildManifestEntryFromShorthand({ task: 'T1', status: 'blocked' }, FROZEN).status).toBe(
      'blocked',
    );
  });

  it('generates a non-task-prefixed id when task is omitted', () => {
    const entry = buildManifestEntryFromShorthand({ type: 'misc' }, FROZEN);
    expect(entry.id).toMatch(/^manifest-\d{14}$/);
    expect(entry.linked_tasks).toEqual([]);
    expect(entry.topics).toEqual(['misc']);
  });

  it('merges extraTopics + extraLinkedTasks uniquely', () => {
    const entry = buildManifestEntryFromShorthand(
      {
        task: 'T1',
        type: 'research',
        extraTopics: ['security', 'T1', 'research'], // T1 + research duplicate defaults
        extraLinkedTasks: ['T2', 'T3'],
      },
      FROZEN,
    );
    expect(entry.topics).toEqual(['T1', 'research', 'security']);
    expect(entry.linked_tasks).toEqual(['T1', 'T2', 'T3']);
  });

  it('honours optional ExtendedManifestEntry fields', () => {
    const entry = buildManifestEntryFromShorthand(
      {
        task: 'T1',
        type: 'research',
        confidence: 0.85,
        fileChecksum: 'sha256:abc123',
        durationSeconds: 120,
      },
      FROZEN,
    );
    expect(entry.confidence).toBe(0.85);
    expect(entry.file_checksum).toBe('sha256:abc123');
    expect(entry.duration_seconds).toBe(120);
  });

  it('omits optional fields when not supplied', () => {
    const entry = buildManifestEntryFromShorthand({ task: 'T1', type: 'research' }, FROZEN);
    expect(entry.confidence).toBeUndefined();
    expect(entry.file_checksum).toBeUndefined();
    expect(entry.duration_seconds).toBeUndefined();
  });

  it('stamps date and id deterministically from the injected clock', () => {
    const entry = buildManifestEntryFromShorthand(
      { task: 'T1', type: 'research' },
      new Date('2026-01-15T09:00:00.000Z'),
    );
    expect(entry.date).toBe('2026-01-15');
    expect(entry.id).toMatch(/^T1-research-20260115090000$/);
  });

  it('output shape satisfies every validator-required field', () => {
    // Mirrors the hard checks in pipelineManifestAppend so any future regression
    // that drops a required field fails here first.
    const entry = buildManifestEntryFromShorthand(
      { task: 'T1', type: 'research', content: 'demo' },
      FROZEN,
    );
    const required = [
      'id',
      'file',
      'title',
      'date',
      'status',
      'agent_type',
      'topics',
      'actionable',
    ] as const;
    for (const field of required) {
      expect(entry[field]).toBeDefined();
    }
  });
});
