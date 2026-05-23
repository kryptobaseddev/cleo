/**
 * `cliColorize` — `ColorStyle` → ANSI escape adapter for the core formatters.
 *
 * Passed as the `colorize` option to {@link formatTree} and {@link formatWaves}
 * so that all ANSI concerns stay centralised here while the core formatters
 * remain presentation-agnostic.
 *
 * When ANSI is disabled (e.g. `NO_COLOR` is set, or stdout is not a TTY),
 * the ANSI constants exported by `./colors.ts` are empty strings, so this
 * function effectively returns `text` unchanged — output is identical to
 * the plain-text modes used by core formatter tests.
 *
 * Originally inlined inside `packages/cleo/src/cli/renderers/system.ts`;
 * extracted here when the system renderers migrated to `@cleocode/core/render`
 * (T10131 — B6).
 *
 * @task T10131
 */

import type { ColorStyle } from '../formatters/index.js';
import { BLUE, BOLD, CYAN, DIM, GREEN, MAGENTA, NC, RED, YELLOW } from './colors.js';

/**
 * Wrap `text` with the ANSI escape code for `style`, followed by a reset.
 *
 * @param text  - The text to colorize.
 * @param style - A {@link ColorStyle} token produced by the core formatter.
 */
export function cliColorize(text: string, style: ColorStyle): string {
  switch (style) {
    case 'bold':
      return `${BOLD}${text}${NC}`;
    case 'dim':
      return `${DIM}${text}${NC}`;
    case 'red':
      return `${RED}${text}${NC}`;
    case 'green':
      return `${GREEN}${text}${NC}`;
    case 'yellow':
      return `${YELLOW}${text}${NC}`;
    case 'blue':
      return `${BLUE}${text}${NC}`;
    case 'magenta':
      return `${MAGENTA}${text}${NC}`;
    case 'cyan':
      return `${CYAN}${text}${NC}`;
    case 'reset':
      return `${NC}${text}`;
    default:
      return text;
  }
}
