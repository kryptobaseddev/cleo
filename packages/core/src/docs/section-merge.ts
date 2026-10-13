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

/**
 * Deterministic section id for a split index. Section ids are positional
 * (`s0` is the H1 + preamble, `s1` the first `## ` block, …): stable across
 * devices for the same document shape and independent of heading text.
 * Positional ids are a known simplification — heading-anchored ids are the
 * filed follow-up (T13584).
 *
 * @param index - The section's position in {@link splitDocIntoSections}.
 * @returns The section id recorded in `sections_modified`.
 */
export function sectionId(index: number): string {
  return `s${index}`;
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
 * The caller discriminates single-writer from concurrent edits by comparing
 * the stored state against the section text of the PREVIOUS HEAD version
 * (`headText`): while the stored state equals the head's text it holds no
 * unlanded concurrent edit, and any difference the writer authored is an
 * ordinary edit — which the append-shaped primitives cannot express, so the
 * section is re-seeded from the input and projects EXACTLY (mid-text
 * replaces and deletions apply verbatim, never a fabricated concatenation —
 * T13589). When the stored state differs from the head's text it genuinely
 * carries a concurrent edit (T13595):
 *
 *   - an incoming edit that is a pure APPEND relative to the common base
 *     (`nextText` extends `headText`) composes onto the stored state, so
 *     both tails survive — this is never a fabrication;
 *   - any NON-append incoming edit (a replace or delete relative to the
 *     base) CANNOT be expressed with append-only primitives without
 *     inventing text, so the function reports `conflicted: true` and keeps
 *     the stored state untouched. The write path lands the incoming edit as
 *     its own append-only version row, keeps the stored projection as the
 *     head, and records the conflict on the head — both versions preserved,
 *     nothing fabricated.
 *
 * Stale base (T13674): when the caller names the version it edited against
 * (`baseText`) and that base differs from the head's text, the head has
 * advanced since the edit was authored and `headText` is NO LONGER the
 * writer's common base — discriminating against it would treat a concurrent
 * edit as a single-writer replace and SILENTLY DROP it. The incoming edit is
 * therefore discriminated against `baseText` instead:
 *
 *   - `nextText` equals `baseText`: the writer authored nothing; the
 *     concurrent edit stands (`changed: false`);
 *   - `nextText` extends `baseText` (append relative to the base) and the
 *     stored text also extends `baseText`: the authored tail composes onto
 *     the stored state, so BOTH the concurrent edit and the incoming edit
 *     survive (`changed: true`, `staleBaseMerged: true`);
 *   - anything else (a non-append relative to the base, or a stored state
 *     that does not extend the base): `conflicted: true`, stored state kept
 *     — the write path records the conflict and lands both versions. Never
 *     a fabricated merge.
 *
 * Semantics:
 *
 *   - `stored === null` (first write of the section): seed a fresh state
 *     from the new text.
 *   - The stored text equals the new text: no-op (`changed: false`).
 *   - `baseText` known and differing from `headText` (stale base): the
 *     three rules above; `headText` is ignored for discrimination.
 *   - `headText === null` (no head text available for this section — no
 *     head yet, or the head version's blob is not resolvable locally): the
 *     single-writer assumption; re-seed from the new text (exact).
 *   - The stored text equals `headText` (single writer): re-seed from the
 *     new text — the input projects exactly, deletions included.
 *   - The stored text differs from `headText` and the incoming text equals
 *     `headText`: the writer authored nothing new; no-op.
 *   - The stored text differs from `headText` and the incoming text extends
 *     `headText` (append): compose the incoming tail onto the stored state;
 *     both edits survive, `conflicted: false`.
 *   - The stored text differs from `headText` and the incoming edit is a
 *     non-append relative to `headText`: `conflicted: true`, stored state
 *     kept — the write path records the conflict and lands both versions.
 *
 * @param stored - The section's stored snapshot, or `null` when none exists.
 * @param nextText - The section's new full text.
 * @param headText - The section's text in the previous head version, or
 *   `null` when no head text is available.
 * @param baseText - The section's text in the version the caller edited
 *   against (T13674), or `null`/omitted when unknown. Only discriminates
 *   when it differs from `headText`.
 * @returns The resulting snapshot, whether it changed, whether the edit
 *   is a non-append concurrent edit the caller must record as a conflict,
 *   and whether a stale base was 3-way merged.
 */
export function applySectionTextEdit(
  stored: Buffer | null,
  nextText: string,
  headText: string | null,
  baseText: string | null = null,
): { snapshot: Buffer; changed: boolean; conflicted: boolean; staleBaseMerged: boolean } {
  if (stored === null) {
    return {
      snapshot: seedSectionState(nextText),
      changed: true,
      conflicted: false,
      staleBaseMerged: false,
    };
  }
  const current = sectionStateText(stored);
  if (current === nextText) {
    return { snapshot: stored, changed: false, conflicted: false, staleBaseMerged: false };
  }
  // T13674: the caller edited against `baseText` and the head has advanced
  // (the base text differs from the head's). Discriminate the incoming edit
  // against the BASE — never against the head, which would mistake a
  // concurrent edit for a single-writer replace and drop it silently.
  if (baseText !== null && baseText !== headText) {
    if (nextText === baseText) {
      // The writer authored nothing beyond the base; the stored (concurrent)
      // edit stands.
      return { snapshot: stored, changed: false, conflicted: false, staleBaseMerged: false };
    }
    if (nextText.startsWith(baseText) && current.startsWith(baseText)) {
      // Append relative to the base, stored state extends the base: compose
      // the authored tail onto the stored state. Both edits survive.
      const update = makeSectionEditUpdate(stored, nextText.slice(baseText.length));
      return {
        snapshot: mergeSectionUpdates(stored, [update]),
        changed: true,
        conflicted: false,
        staleBaseMerged: true,
      };
    }
    // Non-append relative to the base, or a stored state that does not
    // extend the base: refuse rather than fabricate. The write path records
    // the conflict and lands both versions.
    return { snapshot: stored, changed: false, conflicted: true, staleBaseMerged: false };
  }
  if (headText === null || current === headText) {
    // Single-writer edit: project the input EXACTLY. The primitives can only
    // append, so a re-seed is the honest encoding of a replace/delete — it
    // never fabricates a concatenation no writer authored (T13589).
    return {
      snapshot: seedSectionState(nextText),
      changed: true,
      conflicted: false,
      staleBaseMerged: false,
    };
  }
  if (nextText === headText) {
    // The writer authored nothing beyond the base; the stored (concurrent)
    // edit stands.
    return { snapshot: stored, changed: false, conflicted: false, staleBaseMerged: false };
  }
  if (nextText.startsWith(headText)) {
    // Concurrent append-append: compose the incoming tail onto the stored
    // state. Both tails survive and nothing is fabricated (T13585).
    const update = makeSectionEditUpdate(stored, nextText.slice(headText.length));
    return {
      snapshot: mergeSectionUpdates(stored, [update]),
      changed: true,
      conflicted: false,
      staleBaseMerged: false,
    };
  }
  // Non-append concurrent edit (replace/delete relative to the base): not
  // expressible with append-only primitives without inventing text — keep
  // the stored state and let the write path record the conflict, landing
  // the incoming edit as its own version row (T13595).
  return { snapshot: stored, changed: false, conflicted: true, staleBaseMerged: false };
}
