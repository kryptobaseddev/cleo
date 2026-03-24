/**
 * SKILL.md validator
 *
 * Validates skill files against the Agent Skills standard.
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import matter from "gray-matter";

/**
 * A single validation issue found during SKILL.md validation.
 *
 * @example
 * ```typescript
 * const issue: ValidationIssue = {
 *   level: "error",
 *   field: "name",
 *   message: "Missing required field: name",
 * };
 * ```
 *
 * @public
 */
export interface ValidationIssue {
  /** Severity: `"error"` causes validation failure, `"warning"` does not. */
  level: "error" | "warning";
  /** The field or section that triggered the issue. */
  field: string;
  /** Human-readable description of the issue. */
  message: string;
}

/**
 * Result of validating a SKILL.md file against the Agent Skills standard.
 *
 * @example
 * ```typescript
 * const result = await validateSkill("/path/to/SKILL.md");
 * if (!result.valid) {
 *   for (const issue of result.issues) {
 *     console.log(`[${issue.level}] ${issue.field}: ${issue.message}`);
 *   }
 * }
 * ```
 *
 * @public
 */
export interface ValidationResult {
  /** Whether the skill passed validation (no error-level issues). */
  valid: boolean;
  /** All issues found during validation. */
  issues: ValidationIssue[];
  /** Parsed frontmatter metadata, or `null` if parsing failed. */
  metadata: Record<string, unknown> | null;
}

const RESERVED_NAMES = [
  "anthropic", "claude", "google", "openai", "microsoft",
  "cursor", "windsurf", "codex", "gemini", "copilot",
];

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const WARN_BODY_LINES = 500;
const WARN_DESCRIPTION_LENGTH = 50;

/**
 * Validate a SKILL.md file against the Agent Skills standard.
 *
 * @remarks
 * Checks for required frontmatter fields (`name`, `description`), validates
 * naming conventions, enforces length limits, checks for reserved names,
 * and warns about long skill bodies.
 *
 * @param filePath - Absolute path to the SKILL.md file to validate
 * @returns Validation result with issues and parsed metadata
 *
 * @example
 * ```typescript
 * const result = await validateSkill("/path/to/SKILL.md");
 * console.log(result.valid ? "Valid" : `${result.issues.length} issues found`);
 * ```
 *
 * @public
 */
export async function validateSkill(filePath: string): Promise<ValidationResult> {
  const issues: ValidationIssue[] = [];

  if (!existsSync(filePath)) {
    return {
      valid: false,
      issues: [{ level: "error", field: "file", message: "File does not exist" }],
      metadata: null,
    };
  }

  const content = await readFile(filePath, "utf-8");

  // Check for frontmatter
  if (!content.startsWith("---")) {
    issues.push({
      level: "error",
      field: "frontmatter",
      message: "Missing YAML frontmatter (file must start with ---)",
    });
    return { valid: false, issues, metadata: null };
  }

  let data: Record<string, unknown>;
  let body: string;

  try {
    const parsed = matter(content);
    data = parsed.data as Record<string, unknown>;
    body = parsed.content;
  } catch (err) {
    issues.push({
      level: "error",
      field: "frontmatter",
      message: `Invalid YAML frontmatter: ${err instanceof Error ? err.message : String(err)}`,
    });
    return { valid: false, issues, metadata: null };
  }

  // Required: name
  if (!data.name) {
    issues.push({ level: "error", field: "name", message: "Missing required field: name" });
  } else {
    const name = String(data.name);

    if (name.length > MAX_NAME_LENGTH) {
      issues.push({
        level: "error",
        field: "name",
        message: `Name too long (${name.length} chars, max ${MAX_NAME_LENGTH})`,
      });
    }

    if (!NAME_PATTERN.test(name)) {
      issues.push({
        level: "error",
        field: "name",
        message: "Name must be lowercase letters, numbers, and hyphens only",
      });
    }

    if (RESERVED_NAMES.includes(name.toLowerCase())) {
      issues.push({
        level: "error",
        field: "name",
        message: `Name "${name}" is reserved`,
      });
    }

    if (/<[^>]+>/.test(name)) {
      issues.push({
        level: "error",
        field: "name",
        message: "Name must not contain XML/HTML tags",
      });
    }
  }

  // Required: description
  if (!data.description) {
    issues.push({ level: "error", field: "description", message: "Missing required field: description" });
  } else {
    const desc = String(data.description);

    if (desc.length > MAX_DESCRIPTION_LENGTH) {
      issues.push({
        level: "error",
        field: "description",
        message: `Description too long (${desc.length} chars, max ${MAX_DESCRIPTION_LENGTH})`,
      });
    }

    if (desc.length < WARN_DESCRIPTION_LENGTH) {
      issues.push({
        level: "warning",
        field: "description",
        message: `Description is short (${desc.length} chars). Consider adding more detail.`,
      });
    }

    if (/<[^>]+>/.test(desc)) {
      issues.push({
        level: "error",
        field: "description",
        message: "Description must not contain XML/HTML tags",
      });
    }
  }

  // Body checks
  const bodyLines = body.trim().split("\n").length;
  if (bodyLines > WARN_BODY_LINES) {
    issues.push({
      level: "warning",
      field: "body",
      message: `Body is long (${bodyLines} lines). Consider splitting into multiple skills.`,
    });
  }

  if (!body.trim()) {
    issues.push({
      level: "warning",
      field: "body",
      message: "Empty skill body. Add instructions for the AI agent.",
    });
  }

  const hasErrors = issues.some((i) => i.level === "error");

  return {
    valid: !hasErrors,
    issues,
    metadata: data,
  };
}
