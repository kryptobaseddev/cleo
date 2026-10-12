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
 * Apply one section's new text to its stored snapshot, merging when the
 * stored state already carries concurrent edits.
 *
 * Semantics, per the bundled append-shaped primitives:
 *
 *   - `stored === null` (first write of the section): seed a fresh state
 *     from the new text.
 *   - The stored text equals the new text: no-op (`changed: false`), the
 *     snapshot is returned untouched.
 *   - The stored text is a strict prefix of the new text (append-only
 *     growth): the tail is expressed as an incremental edit and merged onto
 *     the stored state — concurrent edits already in the stored state
 *     survive the merge.
 *   - Otherwise (a replace, not expressible as an append): the section is
 *     re-seeded from the new text. The bundled primitives cannot express
 *     mid-text replacement; full two-way Loro editing is the upgrade path
 *     (spec §2, live collaborative editing is an explicit non-goal of v1).
 *
 * @param stored - The section's stored snapshot, or `null` when none exists.
 * @param nextText - The section's new full text.
 * @returns The resulting snapshot and whether it changed.
 */
export function applySectionTextEdit(
  stored: Buffer | null,
  nextText: string,
): { snapshot: Buffer; changed: boolean } {
  if (stored === null) {
    return { snapshot: seedSectionState(nextText), changed: true };
  }
  const current = sectionStateText(stored);
  if (current === nextText) {
    return { snapshot: stored, changed: false };
  }
  if (nextText.startsWith(current)) {
    const update = makeSectionEditUpdate(stored, nextText.slice(current.length));
    return { snapshot: mergeSectionUpdates(stored, [update]), changed: true };
  }
  return { snapshot: seedSectionState(nextText), changed: true };
}
