/**
 * TemplateManifest data table — single source of truth for every template
 * shipped by CLEO.
 *
 * This array is consumed by {@link ./registry.ts | the registry} and by the
 * CLI verbs (`cleo init --workflows`, `cleo upgrade`, the scaffold sweeper)
 * to decide what to install, where, and how.
 *
 * Placeholder declarations are currently empty (`[]`) on every entry —
 * placeholder enumeration is deferred to T9879. The `updateStrategy` defaults
 * to `overwrite-on-bump` until per-template policy is settled in later tasks
 * of Saga T9855.
 *
 * @task T9877
 * @epic T9874
 * @saga T9855
 */

import type { TemplateManifestEntry } from '@cleocode/contracts';

/**
 * Every template CLEO ships, with its monorepo-relative `sourcePath`, the
 * consumer-project-relative `installPath`, and its substitution + reconciliation
 * policy.
 *
 * Sorted by `kind` then `id` for stable diffs across PRs.
 */
export const TEMPLATE_MANIFEST_ENTRIES: readonly TemplateManifestEntry[] = [
  // ── workflow ──────────────────────────────────────────────────────────────
  {
    id: 'release-fanout',
    kind: 'workflow',
    sourcePath: 'packages/core/templates/workflows/release-fanout.yml.tmpl',
    installPath: '.github/workflows/release-fanout.yml',
    substitution: 'regex-tmpl',
    placeholders: [],
    updateStrategy: 'overwrite-on-bump',
  },
  {
    id: 'release-prepare',
    kind: 'workflow',
    sourcePath: 'packages/core/templates/workflows/release-prepare.yml.tmpl',
    installPath: '.github/workflows/release-prepare.yml',
    substitution: 'regex-tmpl',
    placeholders: [],
    updateStrategy: 'overwrite-on-bump',
  },
  {
    id: 'release-publish',
    kind: 'workflow',
    sourcePath: 'packages/core/templates/workflows/release-publish.yml.tmpl',
    installPath: '.github/workflows/release-publish.yml',
    substitution: 'regex-tmpl',
    placeholders: [],
    updateStrategy: 'overwrite-on-bump',
  },
  {
    id: 'release-rollback',
    kind: 'workflow',
    sourcePath: 'packages/core/templates/workflows/release-rollback.yml.tmpl',
    installPath: '.github/workflows/release-rollback.yml',
    substitution: 'regex-tmpl',
    placeholders: [],
    updateStrategy: 'overwrite-on-bump',
  },

  // ── config ────────────────────────────────────────────────────────────────
  {
    id: 'agent-registry',
    kind: 'config',
    sourcePath: 'packages/core/templates/agent-registry.json',
    installPath: '.cleo/agent-registry.json',
    substitution: 'static',
    placeholders: [],
    updateStrategy: 'immutable',
  },
  {
    id: 'cleo-config',
    kind: 'config',
    sourcePath: 'packages/core/templates/config.template.json',
    installPath: '.cleo/config.json',
    substitution: 'json-merge',
    placeholders: [],
    updateStrategy: 'manifest-merge',
  },
  {
    id: 'cleo-gitignore',
    kind: 'config',
    sourcePath: 'packages/core/templates/cleo-gitignore',
    installPath: '.cleo/.gitignore',
    substitution: 'static',
    placeholders: [],
    updateStrategy: 'overwrite-on-bump',
  },
  {
    id: 'git-hook-commit-msg',
    kind: 'config',
    sourcePath: 'packages/core/templates/git-hooks/commit-msg',
    installPath: '.git/hooks/commit-msg',
    substitution: 'static',
    placeholders: [],
    updateStrategy: 'overwrite-on-bump',
  },
  {
    id: 'git-hook-pre-commit',
    kind: 'config',
    sourcePath: 'packages/core/templates/git-hooks/pre-commit',
    installPath: '.git/hooks/pre-commit',
    substitution: 'static',
    placeholders: [],
    updateStrategy: 'overwrite-on-bump',
  },
  {
    id: 'git-hook-pre-push',
    kind: 'config',
    sourcePath: 'packages/core/templates/git-hooks/pre-push',
    installPath: '.git/hooks/pre-push',
    substitution: 'static',
    placeholders: [],
    updateStrategy: 'overwrite-on-bump',
  },
  {
    id: 'git-hook-pre-push-t1595-extension',
    kind: 'config',
    sourcePath: 'packages/core/templates/git-hooks/pre-push.t1595-extension.sh',
    installPath: '.git/hooks/pre-push.t1595-extension.sh',
    substitution: 'static',
    placeholders: [],
    updateStrategy: 'overwrite-on-bump',
  },
  {
    id: 'global-config',
    kind: 'config',
    sourcePath: 'packages/core/templates/global-config.template.json',
    installPath: 'config.json',
    substitution: 'json-merge',
    placeholders: [],
    updateStrategy: 'manifest-merge',
  },
  {
    id: 'issue-bug-report',
    kind: 'config',
    sourcePath: 'packages/core/templates/github/ISSUE_TEMPLATE/bug_report.yml',
    installPath: '.github/ISSUE_TEMPLATE/bug_report.yml',
    substitution: 'static',
    placeholders: [],
    updateStrategy: 'diff-prompt',
  },
  {
    id: 'issue-config',
    kind: 'config',
    sourcePath: 'packages/core/templates/github/ISSUE_TEMPLATE/config.yml',
    installPath: '.github/ISSUE_TEMPLATE/config.yml',
    substitution: 'static',
    placeholders: [],
    updateStrategy: 'diff-prompt',
  },
  {
    id: 'issue-feature-request',
    kind: 'config',
    sourcePath: 'packages/core/templates/github/ISSUE_TEMPLATE/feature_request.yml',
    installPath: '.github/ISSUE_TEMPLATE/feature_request.yml',
    substitution: 'static',
    placeholders: [],
    updateStrategy: 'diff-prompt',
  },
  {
    id: 'issue-help-question',
    kind: 'config',
    sourcePath: 'packages/core/templates/github/ISSUE_TEMPLATE/help_question.yml',
    installPath: '.github/ISSUE_TEMPLATE/help_question.yml',
    substitution: 'static',
    placeholders: [],
    updateStrategy: 'diff-prompt',
  },
  {
    id: 'issue-template-bug-report-legacy',
    kind: 'config',
    sourcePath: 'packages/core/templates/issue-templates/bug_report.yml',
    installPath: '.github/ISSUE_TEMPLATE/bug_report.yml',
    substitution: 'static',
    placeholders: [],
    updateStrategy: 'diff-prompt',
  },
  {
    id: 'issue-template-config-legacy',
    kind: 'config',
    sourcePath: 'packages/core/templates/issue-templates/config.yml',
    installPath: '.github/ISSUE_TEMPLATE/config.yml',
    substitution: 'static',
    placeholders: [],
    updateStrategy: 'diff-prompt',
  },
  {
    id: 'issue-template-feature-request-legacy',
    kind: 'config',
    sourcePath: 'packages/core/templates/issue-templates/feature_request.yml',
    installPath: '.github/ISSUE_TEMPLATE/feature_request.yml',
    substitution: 'static',
    placeholders: [],
    updateStrategy: 'diff-prompt',
  },
  {
    id: 'issue-template-help-question-legacy',
    kind: 'config',
    sourcePath: 'packages/core/templates/issue-templates/help_question.yml',
    installPath: '.github/ISSUE_TEMPLATE/help_question.yml',
    substitution: 'static',
    placeholders: [],
    updateStrategy: 'diff-prompt',
  },
  {
    id: 'skillsmp-example',
    kind: 'config',
    sourcePath: 'packages/core/templates/skillsmp.json.example',
    installPath: '.cleo/skillsmp.json',
    substitution: 'static',
    placeholders: [],
    updateStrategy: 'immutable',
  },
  {
    id: 'worktreeinclude',
    kind: 'config',
    sourcePath: 'packages/core/templates/worktreeinclude',
    installPath: '.worktreeinclude',
    substitution: 'static',
    placeholders: [],
    updateStrategy: 'diff-prompt',
  },

  // ── agent ─────────────────────────────────────────────────────────────────
  {
    id: 'project-code-worker',
    kind: 'agent',
    sourcePath: 'packages/agents/templates/project-code-worker.cant',
    installPath: '.cleo/cant/agents/project-code-worker.cant',
    substitution: 'static',
    placeholders: [],
    updateStrategy: 'diff-prompt',
  },
  {
    id: 'project-dev-lead',
    kind: 'agent',
    sourcePath: 'packages/agents/templates/project-dev-lead.cant',
    installPath: '.cleo/cant/agents/project-dev-lead.cant',
    substitution: 'static',
    placeholders: [],
    updateStrategy: 'diff-prompt',
  },
  {
    id: 'project-docs-worker',
    kind: 'agent',
    sourcePath: 'packages/agents/templates/project-docs-worker.cant',
    installPath: '.cleo/cant/agents/project-docs-worker.cant',
    substitution: 'static',
    placeholders: [],
    updateStrategy: 'diff-prompt',
  },
  {
    id: 'project-orchestrator',
    kind: 'agent',
    sourcePath: 'packages/agents/templates/project-orchestrator.cant',
    installPath: '.cleo/cant/agents/project-orchestrator.cant',
    substitution: 'static',
    placeholders: [],
    updateStrategy: 'diff-prompt',
  },
  {
    id: 'project-security-worker',
    kind: 'agent',
    sourcePath: 'packages/agents/templates/project-security-worker.cant',
    installPath: '.cleo/cant/agents/project-security-worker.cant',
    substitution: 'static',
    placeholders: [],
    updateStrategy: 'diff-prompt',
  },

  // ── skill ─────────────────────────────────────────────────────────────────
  {
    id: 'contribution-init',
    kind: 'skill',
    sourcePath: 'packages/skills/skills/ct-contribution/templates/contribution-init.json',
    installPath: '.cleo/skills/ct-contribution/contribution-init.json',
    substitution: 'static',
    placeholders: [],
    updateStrategy: 'overwrite-on-bump',
  },

  // ── provider ──────────────────────────────────────────────────────────────
  {
    id: 'provider-claude-code-manifest',
    kind: 'provider',
    sourcePath: 'packages/adapters/src/providers/claude-code/manifest.json',
    installPath: '.cleo/providers/claude-code/manifest.json',
    substitution: 'static',
    placeholders: [],
    updateStrategy: 'overwrite-on-bump',
  },
  {
    id: 'provider-claude-code-orchestrator-cmd',
    kind: 'provider',
    sourcePath: 'packages/adapters/src/providers/claude-code/commands/orchestrator.md',
    installPath: '.claude/commands/orchestrator.md',
    substitution: 'static',
    placeholders: [],
    updateStrategy: 'overwrite-on-bump',
  },
  {
    id: 'provider-codex-manifest',
    kind: 'provider',
    sourcePath: 'packages/adapters/src/providers/codex/manifest.json',
    installPath: '.cleo/providers/codex/manifest.json',
    substitution: 'static',
    placeholders: [],
    updateStrategy: 'overwrite-on-bump',
  },
  {
    id: 'provider-cursor-manifest',
    kind: 'provider',
    sourcePath: 'packages/adapters/src/providers/cursor/manifest.json',
    installPath: '.cleo/providers/cursor/manifest.json',
    substitution: 'static',
    placeholders: [],
    updateStrategy: 'overwrite-on-bump',
  },
  {
    id: 'provider-gemini-cli-manifest',
    kind: 'provider',
    sourcePath: 'packages/adapters/src/providers/gemini-cli/manifest.json',
    installPath: '.cleo/providers/gemini-cli/manifest.json',
    substitution: 'static',
    placeholders: [],
    updateStrategy: 'overwrite-on-bump',
  },
  {
    id: 'provider-kimi-manifest',
    kind: 'provider',
    sourcePath: 'packages/adapters/src/providers/kimi/manifest.json',
    installPath: '.cleo/providers/kimi/manifest.json',
    substitution: 'static',
    placeholders: [],
    updateStrategy: 'overwrite-on-bump',
  },
  {
    id: 'provider-openai-sdk-manifest',
    kind: 'provider',
    sourcePath: 'packages/adapters/src/providers/openai-sdk/manifest.json',
    installPath: '.cleo/providers/openai-sdk/manifest.json',
    substitution: 'static',
    placeholders: [],
    updateStrategy: 'overwrite-on-bump',
  },
  {
    id: 'provider-opencode-manifest',
    kind: 'provider',
    sourcePath: 'packages/adapters/src/providers/opencode/manifest.json',
    installPath: '.cleo/providers/opencode/manifest.json',
    substitution: 'static',
    placeholders: [],
    updateStrategy: 'overwrite-on-bump',
  },
  {
    id: 'provider-pi-manifest',
    kind: 'provider',
    sourcePath: 'packages/adapters/src/providers/pi/manifest.json',
    installPath: '.cleo/providers/pi/manifest.json',
    substitution: 'static',
    placeholders: [],
    updateStrategy: 'overwrite-on-bump',
  },

  // ── doc ───────────────────────────────────────────────────────────────────
  {
    id: 'cleo-injection',
    kind: 'doc',
    sourcePath: 'packages/core/templates/CLEO-INJECTION.md',
    installPath: 'templates/CLEO-INJECTION.md',
    substitution: 'static',
    placeholders: [],
    updateStrategy: 'overwrite-on-bump',
  },
  {
    id: 'handoff-redirect-stub',
    kind: 'doc',
    sourcePath: 'packages/core/templates/HANDOFF-REDIRECT-STUB.md',
    installPath: '.cleo/agent-outputs/NEXT-SESSION-HANDOFF.md',
    substitution: 'static',
    placeholders: [],
    updateStrategy: 'overwrite-on-bump',
  },
] as const;
