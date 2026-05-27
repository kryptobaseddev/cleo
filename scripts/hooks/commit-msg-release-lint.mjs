#!/usr/bin/env node
/**
 * commit-msg-release-lint — enforce that release commits cite a T-prefixed task
 * ID so post-release reconciliation (T1411) can stamp those tasks done.
 *
 * Triggered by `simple-git-hooks` on every commit-msg event. Exits 0 quickly
 * for non-release commits (perf-critical: runs on every commit).
 *
 * Rules:
 *   - Subject matches /^(chore|feat)\(release\):/  → release commit
 *   - Release commit body MUST contain at least one `T\d+` reference
 *   - Bypass:
 *       CLEO_OWNER_OVERRIDE=1
 *       CLEO_OWNER_OVERRIDE_REASON="<reason>"
 *     Bypasses are appended to .cleo/audit/force-bypass.jsonl
 *
 * Exit codes:
 *   0 — commit allowed
 *   1 — release commit lacks T<digits>+ reference (or override missing reason)
 *   2 — usage error (no msg file argument)
 *
 * @task T1410
 * @epic T1407
 * @see ADR-051 (audit-trail conventions)
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

const msgFile = process.argv[2];
if (!msgFile) {
  console.error('commit-msg-release-lint: missing message file argument');
  process.exit(2);
}

const message = readFileSync(msgFile, 'utf8');
const subject = message.split('\n')[0] ?? '';
const isReleaseCommit = /^(chore|feat)\(release\):/.test(subject);

// Fast-path: not a release commit, allow immediately.
if (!isReleaseCommit) {
  process.exit(0);
}

const hasTaskId = /\bT\d+\b/.test(message);
const override = process.env.CLEO_OWNER_OVERRIDE === '1';
const overrideReason = process.env.CLEO_OWNER_OVERRIDE_REASON?.trim();

if (hasTaskId) {
  process.exit(0);
}

if (override && overrideReason) {
  const auditPath = '.cleo/audit/force-bypass.jsonl';
  mkdirSync(dirname(auditPath), { recursive: true });
  appendFileSync(
    auditPath,
    `${JSON.stringify({
      hook: 'commit-msg-release-lint',
      timestamp: new Date().toISOString(),
      reason: overrideReason,
      subject,
    })}\n`,
  );
  console.warn(
    `commit-msg-release-lint: BYPASSED (reason: ${overrideReason}) — appended to ${auditPath}`,
  );
  process.exit(0);
}

console.error(`
commit-msg-release-lint: release commit subject "${subject}" lacks any T<digit>+ task reference.

Release commits MUST cite at least one T-prefixed task ID in the body so post-release reconciliation
can stamp those tasks done. Add a line like:

    Refs: T1234, T5678

To bypass for emergencies (audited):

    CLEO_OWNER_OVERRIDE=1 CLEO_OWNER_OVERRIDE_REASON="hotfix incident NNN" git commit ...
`);
process.exit(1);
