/**
 * Section CRDT merge engine — the pure core of the CleoDocs re-architecture
 * write path (T13355 · spec `cleodocs-rearch-design` §2 option b · D11165).
 *
 * Every document section is one Loro document (root `LoroText` named
 * `content`), persisted as opaque snapshot bytes in the local-only
 * `section_crdt_states` table. This module is the ONLY production importer of
 * `llmtxt/crdt-primitives` (the llmtxt WASM-backed Loro primitives); the
 * store orchestration in `section-write-path.ts` composes these functions
 * with the canonical `conduit-doc-history.ts` accessors.
 *
 * Merge composition (spike finding, T13353): the WASM `crdt_merge_updates`
 * is LOSSY in llmtxt@2026.5.15 — it returns an empty-doc snapshot for any
 * input (kryptobaseddev/llmtxt#17, tracked in T13356). All merging here
 * therefore composes updates via sequential {@link mergeSectionUpdates}
 * (`crdt_apply_update`), which Loro makes idempotent and convergent:
 * applying each peer's incremental update in turn yields every edit with an
 * order-independent final text. `crdt_merge_updates` must NOT be used in the
 * production path until the upstream fix lands.
 *
 * @module
 * @task T13355
 * @epic T13340
 * @saga T13339
 */

import {
  crdt_apply_update,
  crdt_get_text,
  crdt_make_incremental_update,
  crdt_make_state,
} from 'llmtxt/crdt-primitives';

/** The preamble section's id (the H1 + text before the first `## `). */
export const PREAMBLE_SECTION_ID = 's0';

/**
 * Heading-anchored section ids for a split document (T13584).
 *
 * The preamble is {@link PREAMBLE_SECTION_ID}; each `## ` section is
 * `h-<slug of its heading>`, with `~2`, `~3`, … on repeated headings. Ids are
 * a pure function of the text, so every device derives the same id with no
 * coordination, and inserting or removing a section leaves every other
 * section's id — and so its CRDT state and per-section approvals — in place.
 * Renaming a heading gives the section a new identity, by design.
 *
 * @param sections - Sections from {@link splitDocIntoSections}.
 * @returns One id per section, in document order.
 */
export function sectionIds(sections: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return sections.map((text) => {
    if (!text.startsWith('## ')) return PREAMBLE_SECTION_ID;
    const heading = (text.split('\n', 1)[0] ?? '').slice(3);
    const slug = heading
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '');
    const base = `h-${slug}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}~${n}`;
  });
}

/**
 * Split a markdown document into sections deterministically: the H1 +
 * preamble (everything before the first `## ` heading) is section 0; each
 * `## ` heading starts a new section that runs (with its nested `###`
 * blocks) to the next `## ` or EOF. Concatenating the sections with
 * {@link joinSections} reproduces the input byte-for-byte, so the split is
 * lossless and order-stable.
 *
 * @param markdown - The full document text.
 * @returns The sections in document order.
 */
export function splitDocIntoSections(markdown: string): string[] {
  const lines = markdown.split('\n');
  const sections: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line.startsWith('## ') && current.length > 0) {
      sections.push(current.join('\n'));
      current = [];
    }
    current.push(line);
  }
  sections.push(current.join('\n'));
  return sections;
}

/**
 * The inverse of {@link splitDocIntoSections}.
 *
 * @param sections - Sections in document order.
 * @returns The reassembled document text.
 */
export function joinSections(sections: readonly string[]): string {
  return sections.join('\n');
}

/**
 * Seed a section Loro state from full text (a new or re-based section).
 *
 * @param text - The section's full text.
 * @returns A Loro snapshot encoding the section.
 */
export function seedSectionState(text: string): Buffer {
  return crdt_make_state(text);
}

/**
 * Express one local edit as an incremental Loro update against a base
 * state. The bundled primitives are append-shaped: the edit is the text to
 * append to the base section (callers compute it as the tail of the new
 * text when the old text is a prefix of it).
 *
 * @param base - The base section snapshot the edit was authored against.
 * @param appended - The text the edit appends to the base.
 * @returns The incremental update (the delta only, not a full snapshot).
 */
export function makeSectionEditUpdate(base: Buffer, appended: string): Buffer {
  return crdt_make_incremental_update(base, appended);
}

/**
 * Merge incremental section updates onto a base snapshot by sequential
 * `crdt_apply_update`. This is the production merge composition: Loro import
 * is idempotent and convergent, so the result carries every applied edit and
 * is independent of update order. Do NOT replace this with
 * `crdt_merge_updates` — that WASM export is lossy in llmtxt@2026.5.15
 * (T13353 spike, T13356, kryptobaseddev/llmtxt#17).
 *
 * @param base - The base section snapshot.
 * @param updates - Peer incremental updates, in any order.
 * @returns The merged section snapshot.
 */
export function mergeSectionUpdates(base: Buffer, updates: readonly Buffer[]): Buffer {
  let state = base;
  for (const update of updates) {
    state = crdt_apply_update(state, update);
  }
  return state;
}

/**
 * Extract the plain text of a section snapshot.
 *
 * @param state - A Loro snapshot from {@link seedSectionState} or {@link mergeSectionUpdates}.
 * @returns The section's current text.
 */
export function sectionStateText(state: Buffer): string {
  return crdt_get_text(state);
}

/**
 * Apply one section's new text to its stored snapshot.
 *
 * `baseText` is the section text the incoming edit was AUTHORED AGAINST —
 * the caller's concurrency reference (T13674). A base-less write passes the
 * previous head's section text (single-writer assumption: the writer read
 * the head and edited it). A write carrying a declared base passes the base
 * version's section text, so a writer whose fetch predates a concurrent
 * landing is recognized as stale instead of being mistaken for a
 * single writer replacing the head.
 *
 * While the stored state equals the base text it holds no unlanded edit
 * relative to what the writer saw, and any difference the writer authored
 * is an ordinary edit — which the append-shaped primitives cannot express,
 * so the section is re-seeded from the input and projects EXACTLY
 * (mid-text replaces and deletions apply verbatim, never a fabricated
 * concatenation — T13589). When the stored state differs from the base
 * text, another writer's edit landed after the caller's fetch (T13674):
 *
 *   - an incoming edit that is a pure APPEND relative to the common base
 *     (`nextText` extends `baseText`) composes onto the stored state, so
 *     both tails survive — this is never a fabrication;
 *   - any NON-append incoming edit (a replace or delete relative to the
 *     base) CANNOT be expressed with append-only primitives without
 *     inventing text, so the function reports `conflicted: true` and keeps
 *     the stored state untouched. The write path lands the incoming edit as
 *     its own append-only version row, keeps the stored projection as the
 *     head, and records the conflict on the head — both versions preserved,
 *     nothing fabricated.
 *
 * Semantics:
 *
 *   - `stored === null` (first write of the section): seed a fresh state
 *     from the new text.
 *   - The stored text equals the new text: no-op (`changed: false`).
 *   - `baseText === null` (no base text available for this section — no
 *     head/base yet, or the reference version's blob is not resolvable
 *     locally): the single-writer assumption; re-seed from the new text
 *     (exact).
 *   - The stored text equals `baseText` (single writer against the
 *     reference): re-seed from the new text — the input projects exactly,
 *     deletions included.
 *   - The stored text differs from `baseText` and the incoming text equals
 *     `baseText`: the writer authored nothing new; no-op.
 *   - The stored text differs from `baseText` and the incoming text
 *     extends `baseText` (append): compose the incoming tail onto the
 *     stored state; both edits survive, `conflicted: false`.
 *   - The stored text differs from `baseText` and the incoming edit is a
 *     non-append relative to `baseText`: `conflicted: true`, stored state
 *     kept — the write path records the conflict and lands both versions.
 *
 * @param stored - The section's stored snapshot, or `null` when none exists.
 * @param nextText - The section's new full text.
 * @param baseText - The section's text in the version the incoming edit was
 *   authored against (previous head for base-less writes, declared base
 *   otherwise), or `null` when no reference text is available.
 * @returns The resulting snapshot, whether it changed, and whether the edit
 *   is a non-append concurrent edit the caller must record as a conflict.
 * @task T13674 (the baseText reference; T13589/T13595 for the merge shapes)
 */
export function applySectionTextEdit(
  stored: Buffer | null,
  nextText: string,
  baseText: string | null,
): { snapshot: Buffer; changed: boolean; conflicted: boolean } {
  if (stored === null) {
    return { snapshot: seedSectionState(nextText), changed: true, conflicted: false };
  }
  const current = sectionStateText(stored);
  if (current === nextText) {
    return { snapshot: stored, changed: false, conflicted: false };
  }
  if (baseText === null || current === baseText) {
    // Single-writer edit: project the input EXACTLY. The primitives can only
    // append, so a re-seed is the honest encoding of a replace/delete — it
    // never fabricates a concatenation no writer authored (T13589).
    return { snapshot: seedSectionState(nextText), changed: true, conflicted: false };
  }
  if (nextText === baseText) {
    // The writer authored nothing beyond the base; the stored (concurrent)
    // edit stands.
    return { snapshot: stored, changed: false, conflicted: false };
  }
  if (nextText.startsWith(baseText)) {
    // Concurrent append-append: compose the incoming tail onto the stored
    // state. Both tails survive and nothing is fabricated (T13585).
    const update = makeSectionEditUpdate(stored, nextText.slice(baseText.length));
    return { snapshot: mergeSectionUpdates(stored, [update]), changed: true, conflicted: false };
  }
  // Non-append concurrent edit (replace/delete relative to the base): not
  // expressible with append-only primitives without inventing text — keep
  // the stored state and let the write path record the conflict, landing
  // the incoming edit as its own version row (T13595).
  return { snapshot: stored, changed: false, conflicted: true };
}

/** One step of a {@link planSectionMerge} plan, in output order. */
export type SectionMergeStep =
  /** Apply `text` onto section `id`'s stored state via {@link applySectionTextEdit}. */
  | {
      readonly kind: 'apply';
      readonly id: string;
      readonly text: string;
      /** The section's text in the version the edit was authored against. */
      readonly referenceText: string | null;
      /** The section's landed head text (seeds a missing local state). */
      readonly headText: string | null;
    }
  /** Keep the landed head section verbatim (the incoming edit left it alone). */
  | { readonly kind: 'keep'; readonly id: string; readonly text: string };

/** Output of {@link planSectionMerge}. */
export interface SectionMergePlan {
  /** Steps in merged-document order. */
  readonly steps: readonly SectionMergeStep[];
  /** Section ids (or a duplicate-heading family id) the incoming edit could not land. */
  readonly conflicts: readonly string[];
}

/** First line removed: what a heading rename leaves unchanged. */
function sectionBody(text: string): string {
  const nl = text.indexOf('\n');
  return nl < 0 ? '' : text.slice(nl);
}

/** The `~N`-free id shared by every section with the same heading. */
function headingFamily(id: string): string {
  return id.replace(/~\d+$/, '');
}

/**
 * Plan a three-way, section-level merge of an incoming document against the
 * version it was authored from (`reference`) and the landed head (`head`)
 * (T13584, T13835, T13836).
 *
 * The incoming list alone cannot say what a concurrent writer did, so:
 *
 *   - a head section the reference lacks (a concurrent insert) is kept at its
 *     head position, never dropped;
 *   - a reference section the head lacks was deleted or renamed concurrently:
 *     an untouched incoming copy is dropped; an incoming APPEND lands on the
 *     renamed section when exactly one new head section has the same body;
 *     anything else is a conflict and the head stands;
 *   - a section the incoming edit deleted is dropped only if the head still
 *     holds the reference text; a concurrently edited one is kept as a
 *     conflict;
 *   - when the head and the reference disagree on how many sections share a
 *     heading, the `~N` occurrence ids no longer name the same sections, so
 *     the head's sections of that heading are kept and an incoming change to
 *     them is a conflict on the family id.
 *
 * With `reference` equal to `head` (a single writer) every rule above is
 * inert and the plan applies the incoming sections in order.
 *
 * @param reference - Sections of the version the edit was authored against,
 *   or `null` when unknown.
 * @param head - Sections of the landed head, or `null` when unknown.
 * @param incoming - Sections of the incoming document.
 * @returns The ordered steps and the conflicted ids.
 */
export function planSectionMerge(
  reference: readonly string[] | null,
  head: readonly string[] | null,
  incoming: readonly string[],
): SectionMergePlan {
  const toMap = (texts: readonly string[]): Map<string, string> => {
    const ids = sectionIds(texts);
    return new Map(texts.map((text, i) => [ids[i] ?? '', text]));
  };
  const ref = toMap(reference ?? []);
  const inc = toMap(incoming);
  if (head === null) {
    return {
      steps: [...inc].map(([id, text]) => ({
        kind: 'apply' as const,
        id,
        text,
        referenceText: ref.get(id) ?? null,
        headText: null,
      })),
      conflicts: [],
    };
  }
  const hd = toMap(head);
  const familyTexts = (map: Map<string, string>, family: string): string[] =>
    [...map].filter(([id]) => headingFamily(id) === family).map(([, text]) => text);
  const ambiguous = new Set<string>();
  for (const id of [...ref.keys(), ...hd.keys()]) {
    const family = headingFamily(id);
    const r = familyTexts(ref, family).length;
    const h = familyTexts(hd, family).length;
    if (r !== h && Math.max(r, h) > 1) ambiguous.add(family);
  }

  const steps: SectionMergeStep[] = [];
  const conflicts = new Set<string>();
  const emitted = new Set<string>();
  for (const [id, text] of inc) {
    const family = headingFamily(id);
    if (ambiguous.has(family)) {
      const touched =
        familyTexts(inc, family).join('\u0000') !== familyTexts(ref, family).join('\u0000');
      if (touched) conflicts.add(family);
      continue;
    }
    const referenceText = ref.get(id);
    const headText = hd.get(id);
    if (referenceText !== undefined && headText === undefined) {
      if (text === referenceText) continue;
      const renamed = [...hd].filter(
        ([hid, htext]) =>
          !ref.has(hid) && !inc.has(hid) && sectionBody(htext) === sectionBody(referenceText),
      );
      const target = renamed.length === 1 ? renamed[0] : undefined;
      if (target !== undefined && text.startsWith(referenceText)) {
        const [rid, rtext] = target;
        steps.push({
          kind: 'apply',
          id: rid,
          text: rtext + text.slice(referenceText.length),
          referenceText: rtext,
          headText: rtext,
        });
        emitted.add(rid);
      } else {
        conflicts.add(id);
      }
      continue;
    }
    if (referenceText === undefined && headText !== undefined && headText !== text) {
      // Both sides added a section under the same heading.
      conflicts.add(id);
      continue;
    }
    steps.push({
      kind: 'apply',
      id,
      text,
      referenceText: referenceText ?? null,
      headText: headText ?? null,
    });
    emitted.add(id);
  }

  // Head sections the incoming edit did not account for, at their head position.
  const headIds = [...hd.keys()];
  for (const [index, id] of headIds.entries()) {
    if (emitted.has(id)) continue;
    const text = hd.get(id) ?? '';
    const referenceText = ref.get(id);
    if (!ambiguous.has(headingFamily(id)) && referenceText !== undefined) {
      // The incoming edit deleted it: honoured unless the head changed it since.
      if (inc.has(id) || text === referenceText) continue;
      conflicts.add(id);
    }
    const before = headIds
      .slice(0, index)
      .reverse()
      .find((hid) => emitted.has(hid));
    const at = before === undefined ? 0 : steps.findIndex((s) => s.id === before) + 1;
    steps.splice(at, 0, { kind: 'keep', id, text });
    emitted.add(id);
  }
  return { steps, conflicts: [...conflicts] };
}
