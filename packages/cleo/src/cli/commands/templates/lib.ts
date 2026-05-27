/**
 * Internal helpers shared by `cleo templates {install, upgrade, diff}`.
 *
 * Wraps the CORE registry's `resolveSourcePathAbsolute` with filesystem
 * reads, project-root resolution, and a deliberately minimal substitution
 * pipeline (currently identity — full `regex-tmpl` substitution is deferred
 * to a follow-up task per the T9886 brief).
 *
 * @task T9886
 * @saga T9855
 * @epic T9874
 * @adr 076
 */

import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { TemplateManifestEntry } from '@cleocode/contracts';
import { getProjectRoot } from '@cleocode/core';
import { resolveSourcePathAbsolute } from '@cleocode/core/templates/registry';

/**
 * Resolve `--project <root>` to an absolute path.
 *
 * Relative inputs are resolved against `cwd`; when no input is given we fall
 * back to `getProjectRoot()` (the canonical SSoT — see ADR-068 §Project Roots).
 *
 * @internal
 */
export function resolveProjectRoot(raw: string | undefined): string {
  if (typeof raw === 'string' && raw.length > 0) {
    return isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
  }
  return getProjectRoot();
}

/**
 * Read a template's source file off disk, returning its raw bytes as UTF-8.
 *
 * @internal
 */
export function readTemplateSource(entry: TemplateManifestEntry): string {
  const sourceAbsolute = resolveSourcePathAbsolute(entry);
  return readFileSync(sourceAbsolute, 'utf8');
}

/**
 * Apply placeholder substitution to a template body.
 *
 * Per the T9886 brief, full `regex-tmpl` resolution is deferred — `static`
 * substitution copies the file byte-for-byte, every other strategy currently
 * passes through as identity. The signature is shaped so the eventual
 * placeholder pipeline can land without breaking call sites.
 *
 * @internal
 */
export function applySubstitution(
  entry: TemplateManifestEntry,
  source: string,
): { rendered: string; substituted: boolean } {
  if (entry.substitution === 'static') {
    return { rendered: source, substituted: false };
  }
  // TODO(T9886-followup): wire placeholders through project-context / config.
  return { rendered: source, substituted: false };
}
