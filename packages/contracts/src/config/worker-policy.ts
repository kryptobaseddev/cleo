import { z } from 'zod';

/**
 * Project worker rules; command declarations remain in project-context.json.
 *
 * @remarks Unknown rules and empty instructions are rejected, never ignored.
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
    instructions: z.array(z.string().min(1).regex(/\S/)).optional(),
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
