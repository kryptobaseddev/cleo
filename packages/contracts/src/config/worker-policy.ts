import { z } from 'zod';

/**
 * Project worker rules; command declarations remain in project-context.json.
 *
 * @remarks At most 16 single-line instructions, each at most 512 characters;
 * control characters and leading headings are rejected, never rendered.
 * @example
 * ```typescript
 * const policy = projectWorkerPolicySchema.parse({
 *   verification: { full: 'ci', local: 'single-file' },
 * });
 * ```
 * @public
 */
export const projectWorkerPolicySchema = z
  .object({
    verification: z
      .object({
        full: z.enum(['local', 'ci']),
        local: z.enum(['single-file', 'affected']),
      })
      .strict()
      .optional(),
    instructions: z
      .array(
        z
          .string()
          .min(1)
          .max(512)
          .regex(/\S/)
          .regex(
            /^(?!\s*#)[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+$/u,
            'Instructions must be single-line text without control characters or a leading #',
          ),
      )
      .max(16)
      .optional(),
  })
  .strict();

/**
 * Project-specific spawn rules, subordinate to explicit owner instructions.
 * `verification.full` places build, full tests, lint and typecheck locally or
 * in required CI; `verification.local` scopes checks during iteration.
 * Placement never waives evidence or independent review.
 *
 * @remarks An absent policy preserves existing spawn behavior.
 * @example
 * ```typescript
 * const policy: ProjectWorkerPolicy = { instructions: ['Follow AGENTS.md'] };
 * ```
 * @public
 */
export type ProjectWorkerPolicy = z.infer<typeof projectWorkerPolicySchema>;
