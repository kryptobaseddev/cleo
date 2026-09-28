/**
 * T12560 — the status projection of a graph assessment: counts, one page,
 * and the complete list only on explicit request.
 *
 * @task T12560
 */

import type { GraphIndexAssessment, GraphIndexFileReport } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ASSESSMENT_FILE_PAGE_SIZE,
  parseAssessmentFilesRequest,
  projectAssessmentFiles,
} from '../assessment-projection.js';

function assessment(count: number): GraphIndexAssessment {
  const files: GraphIndexFileReport[] = Array.from({ length: count }, (_, index) => ({
    path: `src/é-${index}.ts`,
    status: index % 10 === 0 ? 'excluded' : 'analyzed',
  }));
  return { sourceRoot: '/repo', assessedRevision: null, assessedAt: '2026-09-28', files };
}

describe('projectAssessmentFiles', () => {
  it('withholds the list with its exact UTF-8 JSON size and returns the default page', () => {
    const source = assessment(45);
    const projected = projectAssessmentFiles(source);
    expect(projected.files).toBeUndefined();
    expect(projected._withheld).toEqual({
      files: Buffer.byteLength(JSON.stringify(source.files), 'utf8'),
    });
    expect(projected.fileCount).toBe(45);
    expect(projected.filesByStatus).toMatchObject({ analyzed: 40, excluded: 5, failed: 0 });
    expect(projected.filesPage).toMatchObject({
      offset: 0,
      limit: DEFAULT_ASSESSMENT_FILE_PAGE_SIZE,
      total: 45,
      returned: DEFAULT_ASSESSMENT_FILE_PAGE_SIZE,
      nextOffset: DEFAULT_ASSESSMENT_FILE_PAGE_SIZE,
    });
  });

  it('measures an empty list as `[]`', () => {
    expect(projectAssessmentFiles(assessment(0))._withheld).toEqual({ files: 2 });
  });

  it('returns the complete list for `all` or `limit: 0` without offset or filter', () => {
    const source = assessment(30);
    for (const request of [{ all: true }, { limit: 0 }]) {
      const projected = projectAssessmentFiles(source, request);
      expect(projected.files).toBe(source.files);
      expect(projected._withheld).toBeUndefined();
      expect(projected.filesPage).toBeUndefined();
    }
  });

  it('pages every remaining filtered row when `limit: 0` is combined with a filter', () => {
    const projected = projectAssessmentFiles(assessment(30), { limit: 0, status: 'excluded' });
    expect(projected.files).toBeUndefined();
    expect(projected.filesPage).toMatchObject({
      limit: null,
      status: 'excluded',
      total: 3,
      returned: 3,
      nextOffset: null,
    });
  });

  it('returns an empty page past the end', () => {
    const projected = projectAssessmentFiles(assessment(5), { offset: 50 });
    expect(projected.filesPage).toMatchObject({ offset: 50, returned: 0, nextOffset: null });
  });
});

describe('parseAssessmentFilesRequest', () => {
  it('parses counts, status and the --files flag', () => {
    expect(
      parseAssessmentFilesRequest({ files: true, limit: '5', offset: '10', fileStatus: 'failed' }),
    ).toEqual({ all: true, limit: 5, offset: 10, status: 'failed' });
    expect(parseAssessmentFilesRequest({})).toEqual({});
  });

  it.each([
    { limit: '10x' },
    { limit: '-1' },
    { offset: '1.5' },
    { fileStatus: 'stale' },
  ])('rejects %o', (flags) => {
    expect(() => parseAssessmentFilesRequest(flags)).toThrow(/must be/);
  });
});
