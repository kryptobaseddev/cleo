/**
 * Logger configuration contract for the CLEO ecosystem.
 *
 * Lives in `@cleocode/contracts` so CLI bootstrap, harness adapters, and other
 * consumer packages can wire pino without reaching into `@cleocode/core` for a
 * type definition. The implementation (`initLogger`, `getLogger`, etc.) remains
 * in `@cleocode/core/logger`.
 *
 * @task T9766
 * @epic T9752
 * @saga T9758
 */

/**
 * Configuration for the centralized pino logger.
 *
 * @remarks
 * Consumed by `@cleocode/core`'s `initLogger` factory. The CLI bootstrap reads
 * the corresponding `logging` section of `CleoConfig` and forwards it verbatim.
 *
 * @example
 * ```typescript
 * import type { LoggerConfig } from '@cleocode/contracts';
 *
 * const config: LoggerConfig = {
 *   level: 'info',
 *   filePath: 'logs/cleo.log',
 *   maxFileSize: 10 * 1024 * 1024,
 *   maxFiles: 5,
 * };
 * ```
 */
export interface LoggerConfig {
  /** Pino log level (`trace` | `debug` | `info` | `warn` | `error` | `fatal`). */
  level: string;
  /** Path to the primary log file, relative to the `.cleo` directory. */
  filePath: string;
  /** Maximum bytes per log file before pino-roll rotates to a new file. */
  maxFileSize: number;
  /** Maximum number of rotated log files to retain before pino-roll deletes oldest. */
  maxFiles: number;
}
