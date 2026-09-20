/**
 * Marker damage repair — the regression suite for T12051.
 *
 * The defect these tests lock shut: a CAAMP marker that loses a single
 * character stops matching the strict block pattern, so `inject()` concluded
 * the file had no block and **prepended a second one**. The referenced protocol
 * text was then loaded into every agent's context twice, `cleo doctor` reported
 * "markers unbalanced", and its prescribed fix (`cleo upgrade`) re-ran
 * `inject()` — which could only add a third.
 *
 * Observed in the wild on `~/.agents/AGENTS.md`, which had accumulated three
 * blocks (one well-formed, two with a lost leading `<`) from two separate
 * single-byte losses. `EXACT_OBSERVED_CORRUPTION` below is that file byte for
 * byte.
 *
 * @task T12051
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  dedupeFile,
  inject,
  normalizeMarkers,
  parseBlocks,
  reconcile,
  removeInjection,
  repairContent,
} from '../../src/index.js';

const REF = '@~/.cleo/templates/CLEO-INJECTION.md';
const START = '<!-- CAAMP:START -->';
const END = '<!-- CAAMP:END -->';

/** The user's `~/.agents/AGENTS.md`, reproduced exactly (230 bytes). */
const EXACT_OBSERVED_CORRUPTION = [
  `${START}`,
  REF,
  `${END}`,
  '',
  '!-- CAAMP:START -->',
  REF,
  `${END}`,
  '',
  '!-- CAAMP:START -->',
  REF,
  `${END}`,
].join('\n');

/** Count well-formed and damaged opening markers separately. */
function markerCensus(content: string): { canonical: number; damaged: number; ends: number } {
  return {
    canonical: (content.match(/<!-- CAAMP:START -->/g) ?? []).length,
    damaged: (content.match(/(?<!<)!-- CAAMP:START -->/g) ?? []).length,
    ends: (content.match(/<!-- CAAMP:END -->/g) ?? []).length,
  };
}

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'caamp-repair-'));
  file = join(dir, 'AGENTS.md');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
});

describe('normalizeMarkers — damage classes', () => {
  it.each([
    ['leading < lost (the observed damage)', '!-- CAAMP:START -->'],
    ['trailing > lost', '<!-- CAAMP:START --'],
    ['! lost', '<-- CAAMP:START -->'],
    ['spaces collapsed', '<!--CAAMP:START-->'],
    ['extra spaces', '<!--   CAAMP:START   -->'],
    ['case folded', '<!-- caamp:start -->'],
  ])('heals %s', (_label, damaged) => {
    const { content, repaired } = normalizeMarkers(`${damaged}\n${REF}\n${END}\n`);
    expect(repaired).toBe(1);
    expect(content).toContain(START);
    expect(parseBlocks(content)).toHaveLength(1);
  });

  it('reports 0 repairs for already-canonical content and leaves it byte-identical', () => {
    const healthy = `${START}\n${REF}\n${END}\n`;
    const { content, repaired } = normalizeMarkers(healthy);
    expect(repaired).toBe(0);
    expect(content).toBe(healthy);
  });

  it('does NOT treat a bare CAAMP:START line as a damaged marker', () => {
    // Losing one delimiter cannot strip every one of them, and accepting the
    // bare token rewrote documentation that merely mentioned CAAMP — silently
    // swallowing the body of the fence it appeared in.
    const fence = ['```', 'CAAMP:START', 'example body', '```', ''].join('\n');
    const { content, repaired } = normalizeMarkers(fence);
    expect(repaired).toBe(0);
    expect(content).toBe(fence);
  });

  it('does NOT rewrite prose that merely mentions a marker', () => {
    // Whole-line anchoring is what keeps documentation safe.
    const prose = `Some notes.\nThe ${START} marker is written by CAAMP.\nMore notes.\n`;
    const { content, repaired } = normalizeMarkers(prose);
    expect(repaired).toBe(0);
    expect(content).toBe(prose);
  });
});

describe('inject — the duplication ratchet is closed', () => {
  it('repairs a damaged marker in place instead of prepending a second block', async () => {
    await writeFile(file, `!-- CAAMP:START -->\n${REF}\n${END}\n`, 'utf-8');

    const action = await inject(file, REF);
    const after = await readFile(file, 'utf-8');

    expect(action).toBe('repaired');
    expect(markerCensus(after)).toEqual({ canonical: 1, damaged: 0, ends: 1 });
    expect(parseBlocks(after)).toHaveLength(1);
  });

  it('converges the exact observed 3-block corruption to a single block', async () => {
    await writeFile(file, EXACT_OBSERVED_CORRUPTION, 'utf-8');
    expect(markerCensus(EXACT_OBSERVED_CORRUPTION)).toEqual({
      canonical: 1,
      damaged: 2,
      ends: 3,
    });

    await inject(file, REF);
    const after = await readFile(file, 'utf-8');

    expect(markerCensus(after)).toEqual({ canonical: 1, damaged: 0, ends: 1 });
    expect(parseBlocks(after)).toHaveLength(1);
    expect(parseBlocks(after)[0]?.content).toBe(REF);
  });

  it('never accumulates blocks no matter how many times damage recurs', async () => {
    // Before the fix this loop produced one extra block per iteration.
    await inject(file, REF);

    for (let round = 0; round < 5; round += 1) {
      const current = await readFile(file, 'utf-8');
      await writeFile(file, current.replace(START, '!-- CAAMP:START -->'), 'utf-8');
      await inject(file, REF);

      const after = await readFile(file, 'utf-8');
      expect(parseBlocks(after)).toHaveLength(1);
      expect(markerCensus(after).damaged).toBe(0);
    }
  });

  it('is idempotent once healed — a second inject makes no write', async () => {
    await writeFile(file, EXACT_OBSERVED_CORRUPTION, 'utf-8');
    await inject(file, REF);
    const healed = await readFile(file, 'utf-8');

    expect(await inject(file, REF)).toBe('intact');
    expect(await readFile(file, 'utf-8')).toBe(healed);
  });

  it('preserves user content outside the markers', async () => {
    const prose = '# My project notes\n\nSomething important.\n';
    await writeFile(file, `${START}\nold-ref\n${END}\n\n${prose}`, 'utf-8');

    await inject(file, REF);
    const after = await readFile(file, 'utf-8');

    expect(after).toContain('# My project notes');
    expect(after).toContain('Something important.');
    expect(parseBlocks(after)).toHaveLength(1);
  });

  it('replaces the block in place rather than walking it to the top of the file', async () => {
    const heading = '# Team conventions\n';
    await writeFile(file, `${heading}\n${START}\nold-ref\n${END}\n`, 'utf-8');

    await inject(file, REF);
    const after = await readFile(file, 'utf-8');

    expect(after.indexOf(heading)).toBeLessThan(after.indexOf(START));
  });

  it('still prepends when the file genuinely has no CAAMP block', async () => {
    await writeFile(file, '# Just prose\n', 'utf-8');
    expect(await inject(file, REF)).toBe('added');

    const after = await readFile(file, 'utf-8');
    expect(parseBlocks(after)).toHaveLength(1);
    expect(after.indexOf(START)).toBeLessThan(after.indexOf('# Just prose'));
  });

  it('consolidates several well-formed duplicate blocks into one', async () => {
    await writeFile(file, `${START}\n${REF}\n${END}\n\n${START}\n${REF}\n${END}\n`, 'utf-8');
    expect(await inject(file, REF)).toBe('consolidated');
    expect(parseBlocks(await readFile(file, 'utf-8'))).toHaveLength(1);
  });
});

describe('inject — concurrency', () => {
  it('leaves exactly one well-formed block under parallel writers', async () => {
    // Every project on the machine rewrites ~/.agents/AGENTS.md, so concurrent
    // injects into one path are the normal case, not an edge case.
    await Promise.all(Array.from({ length: 12 }, () => inject(file, REF)));

    const after = await readFile(file, 'utf-8');
    expect(markerCensus(after)).toEqual({ canonical: 1, damaged: 0, ends: 1 });
    expect(parseBlocks(after)).toHaveLength(1);
  });

  it('never leaves a partially written file', async () => {
    await inject(file, REF);
    const writers = Array.from({ length: 8 }, (_, i) => inject(file, `${REF}#${i % 2}`));
    await Promise.all(writers);

    const after = await readFile(file, 'utf-8');
    const census = markerCensus(after);
    // A torn write would show as an unbalanced or damaged marker.
    expect(census.damaged).toBe(0);
    expect(census.canonical).toBe(census.ends);
  });
});

describe('dedupeFile — heals before it counts', () => {
  it('removes duplicates hidden behind damaged markers', async () => {
    await writeFile(file, EXACT_OBSERVED_CORRUPTION, 'utf-8');

    const result = await dedupeFile(file);

    // Pre-T12051 this reported "already clean": the strict pattern saw only
    // the single well-formed block and never noticed the other two.
    expect(result.repaired).toBe(2);
    expect(result.removed).toBe(2);
    expect(result.kept).toBe(1);
    expect(result.modified).toBe(true);
    expect(parseBlocks(await readFile(file, 'utf-8'))).toHaveLength(1);
  });

  it('is a no-op on a healthy file', async () => {
    await writeFile(file, `${START}\n${REF}\n${END}\n`, 'utf-8');
    const result = await dedupeFile(file);
    expect(result).toMatchObject({ removed: 0, repaired: 0, modified: false });
  });
});

describe('removeInjection — no stateful-regex skipping', () => {
  it('removes the block on every consecutive call, not alternate ones', async () => {
    // A module-level /g RegExp used with .test() carries `lastIndex` between
    // calls, so the second file in a batch was silently skipped.
    for (let i = 0; i < 4; i += 1) {
      const target = join(dir, `AGENTS-${i}.md`);
      await writeFile(target, `${START}\n${REF}\n${END}\n\nkeep me\n`, 'utf-8');
      expect(await removeInjection(target)).toBe(true);
      expect(await readFile(target, 'utf-8')).toBe('\n\nkeep me\n');
    }
  });

  it('removes a block whose markers were damaged', async () => {
    await writeFile(file, `!-- CAAMP:START -->\n${REF}\n${END}\n\nkeep me\n`, 'utf-8');
    expect(await removeInjection(file)).toBe(true);
    expect(await readFile(file, 'utf-8')).toBe('\n\nkeep me\n');
  });
});

describe('reconcile — pure, so the rules are directly assertable', () => {
  it('reports what it found without touching the filesystem', () => {
    const result = reconcile(EXACT_OBSERVED_CORRUPTION, REF);
    expect(result.repaired).toBe(2);
    expect(result.blocksBefore).toBe(3);
    expect(parseBlocks(result.content)).toHaveLength(1);
  });

  it('retains the exact user-owned trailing bytes instead of normalizing them', () => {
    for (const suffix of ['', '\n', '\r\n\r\n\r\n', ' \t  ']) {
      const input = `${START}\n${REF}\n${END}${suffix}`;
      expect(reconcile(input, REF).content).toBe(input);
    }
    expect(reconcile('', REF).content).toBe(`${START}\n${REF}\n${END}\n`);
  });
});

describe('hardening found by adversarial review of the T12051 fix itself', () => {
  it('refuses to rewrite from a torn read (0 bytes read, non-zero on disk)', async () => {
    // Callers outside this package still rewrite instruction files with a
    // plain truncate-then-write. A read landing inside that window returns
    // empty for a file that is not empty, and reconciling from it would
    // replace every byte of the user's content with a lone block.
    const { assertNotTornRead } = await import('../../src/index.js');

    expect(() => assertNotTornRead('/x/AGENTS.md', '', 4096)).toThrow(/torn read/);
    // A genuinely empty file is fine, and so is any non-empty read.
    expect(() => assertNotTornRead('/x/AGENTS.md', '', 0)).not.toThrow();
    expect(() => assertNotTornRead('/x/AGENTS.md', 'content', 7)).not.toThrow();
  });

  it('repair collapses blocks whose bodies DIFFER, not just identical ones', async () => {
    // The health check reports "N blocks (expected 1)" and prescribes repair.
    // Deduping by identical content could not satisfy that when the bodies
    // differed, leaving an unfixable warning loop.
    const { repairContent } = await import('../../src/index.js');
    const twoDistinct = `${START}\n@AGENTS.md\n${END}\n\n${START}\n@~/.agents/AGENTS.md\n${END}\n`;

    const { content, blocksBefore } = repairContent(twoDistinct);

    expect(blocksBefore).toBe(2);
    expect(parseBlocks(content)).toHaveLength(1);
    // Neither reference is silently dropped.
    expect(parseBlocks(content)[0]?.content).toBe('@AGENTS.md\n@~/.agents/AGENTS.md');
  });

  it('repair is idempotent — a second pass changes nothing', async () => {
    const { repairContent } = await import('../../src/index.js');
    const once = repairContent(EXACT_OBSERVED_CORRUPTION).content;
    expect(repairContent(once).content).toBe(once);
  });

  it('a lock holder does not delete a guard that is no longer its own', async () => {
    // Release used to `rm` unconditionally, so a holder whose guard had been
    // reclaimed as stale would revoke the NEXT holder's lock, letting two
    // critical sections overlap.
    const { withFileLock } = await import('../../src/index.js');
    const { writeFile: wf, readFile: rf } = await import('node:fs/promises');
    const target = join(dir, 'guarded.md');
    await wf(target, 'x', 'utf-8');

    await withFileLock(target, async () => {
      // Simulate the guard being reclaimed and re-acquired by someone else.
      await wf(`${target}.lock`, 'someone-elses-token', 'utf-8');
    });

    // The foreign guard must survive our release.
    await expect(rf(`${target}.lock`, 'utf-8')).resolves.toBe('someone-elses-token');
  });

  it('releases its own guard normally', async () => {
    const { withFileLock } = await import('../../src/index.js');
    const { existsSync: ex } = await import('node:fs');
    const target = join(dir, 'normal.md');

    await withFileLock(target, async () => undefined);
    expect(ex(`${target}.lock`)).toBe(false);
  });
});

describe('T12269 byte-preserving managed boundary', () => {
  const prefix = '\uFEFF  # 用户 notes  \r\n\r\n\r\n\t';
  const between = '\r\n\r\n\r\nUser island λ  \r\n\t';
  const suffix = '  \r\n\r\n# Keep footer  \r\n \t';
  const first = `${START}\r\n@first\r\n${END}`;
  const second = `${START}\r\n@second\r\n${END}`;

  it('preserves independently specified prefix, interblock and suffix byte buffers', () => {
    const original = prefix + first + between + second + suffix;
    const result = reconcile(original, '@replacement');
    expect(Buffer.from(result.content)).toEqual(
      Buffer.from(prefix + `${START}\n@replacement\n${END}` + between + suffix),
    );
    expect(result.blocksBefore).toBe(2);
    expect(reconcile(result.content, '@replacement').content).toBe(result.content);
  });

  it.each([
    'prepend',
    'append',
  ] as const)('insertion %s preserves original BOM and whitespace', (insert) => {
    for (const original of ['  user text \r\n \t', '\r\n \t', '\uFEFF  User λ\r\n\r\n']) {
      const result = reconcile(original, '@new', insert);
      const block = parseBlocks(result.content)[0]!;
      const outside =
        result.content.slice(0, block.startIndex) + result.content.slice(block.endIndex);
      expect(
        Buffer.from(outside).includes(
          Buffer.from(original.slice(original.startsWith('\uFEFF') ? 1 : 0)),
        ),
      ).toBe(true);
      if (original.startsWith('\uFEFF')) expect(result.content.startsWith('\uFEFF')).toBe(true);
      expect(reconcile(result.content, '@new', insert).content).toBe(result.content);
    }
  });

  it('heals damaged delimiters without consuming BOM, indentation, CRLF or trailing spaces', () => {
    const original = '\uFEFF\t!-- CAAMP:START --> \r\n@first\r\n  <!-- CAAMP:END --  \r\n';
    const expected = `\uFEFF\t${START} \r\n@first\r\n  ${END}  \r\n`;
    const result = normalizeMarkers(original);
    expect(Buffer.from(result.content)).toEqual(Buffer.from(expected));
    expect(result.repaired).toBe(2);
    expect(normalizeMarkers(expected)).toEqual({ content: expected, repaired: 0 });
  });

  it('repair merges managed references while preserving every outside byte', () => {
    const result = repairContent(prefix + first + between + second + suffix);
    expect(Buffer.from(result.content)).toEqual(
      Buffer.from(prefix + `${START}\n@first\n@second\n${END}` + between + suffix),
    );
    expect(repairContent(result.content).content).toBe(result.content);
  });

  it.each([
    `${START}\nuser content without an end`,
    `user content\n${END}`,
    `${START}\nkeep ambiguous\n${START}\n@nested\n${END}\n${END}`,
  ])('refuses ambiguous marker ownership without a write: %s', async (ambiguous) => {
    await writeFile(file, prefix + ambiguous + suffix);
    const before = await readFile(file);
    expect(() => reconcile(prefix + ambiguous + suffix, '@new')).toThrow(
      /ambiguous.*CAAMP|CAAMP.*ambiguous/i,
    );
    expect(() => repairContent(prefix + ambiguous + suffix)).toThrow(
      /ambiguous.*CAAMP|CAAMP.*ambiguous/i,
    );
    await expect(inject(file, '@new')).rejects.toThrow(/ambiguous.*CAAMP|CAAMP.*ambiguous/i);
    expect(await readFile(file)).toEqual(before);
  });
});

describe('T12269 removal and deduplication own only marker spans', () => {
  const prefix = '\uFEFF \t\r\nUser prefix  \r\n\r\n\r\n';
  const gap = '\r\n\r\n\r\nUser island  \t\r\n';
  const suffix = ' \t\r\nUser suffix  \r\n\r\n \t';
  const block = `${START}\r\n@same\r\n${END}`;

  it('removes complete regions while retaining all prefix, gap and suffix bytes', async () => {
    await writeFile(file, prefix + block + gap + block + suffix);
    expect(await removeInjection(file)).toBe(true);
    expect(await readFile(file)).toEqual(Buffer.from(prefix + gap + suffix));
    expect(await removeInjection(file)).toBe(false);
    expect(await readFile(file)).toEqual(Buffer.from(prefix + gap + suffix));
  });

  it('preserves whitespace-only outside content as a real file', async () => {
    const before = '\uFEFF\t\r\n';
    const after = '  \r\n\r\n\t';
    await writeFile(file, before + block + after);
    expect(await removeInjection(file)).toBe(true);
    expect(await readFile(file)).toEqual(Buffer.from(before + after));
  });

  it('dedupes by existing last-occurrence policy without changing any user bytes', async () => {
    await writeFile(file, prefix + block + gap + block + suffix);
    const result = await dedupeFile(file);
    expect(result).toMatchObject({ removed: 1, kept: 1, modified: true });
    const expected = Buffer.from(prefix + gap + block + suffix);
    expect(await readFile(file)).toEqual(expected);
    expect(await dedupeFile(file)).toMatchObject({ removed: 0, kept: 1, modified: false });
    expect(await readFile(file)).toEqual(expected);
  });

  it.each([
    `${START}\nunterminated user bytes`,
    `unmatched end\n${END}`,
    `${START}\nouter user bytes\n${START}\ninner\n${END}\n${END}`,
  ])('rejects ambiguous removal and dedupe before changing disk: %s', async (ambiguous) => {
    const expected = Buffer.from(prefix + ambiguous + suffix);
    await writeFile(file, expected);
    await expect(removeInjection(file)).rejects.toThrow(/Ambiguous CAAMP/);
    expect(await readFile(file)).toEqual(expected);
    await expect(dedupeFile(file)).rejects.toThrow(/Ambiguous CAAMP/);
    expect(await readFile(file)).toEqual(expected);
  });

  it('does not create a file when desired content contains nested managed markers', async () => {
    await expect(inject(file, `${START}\nambiguous\n${END}`)).rejects.toThrow(/Ambiguous CAAMP/);
    await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
