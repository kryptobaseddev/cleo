/**
 * Deprecation notice for the conduit messaging verbs (T13982).
 *
 * Conduit messaging is retiring (epic T13933; owner decisions D11172 and
 * D11174, mirroring agentmbx D008-D010 as D11176-D11178): agents message each
 * other over AgentMBX. Per D11174 the verbs are frozen first: they keep
 * working with unchanged output and exit codes, and only gain this warning in
 * the envelope's `meta.warnings`. They are removed in the release after this
 * one ships (T13955).
 *
 * @task T13982
 */

import { pushWarning } from '@cleocode/core/output';

/**
 * Add the conduit deprecation warning to the current command's envelope.
 *
 * @param command - The verb as typed after `cleo`, e.g. `conduit send` or
 *   `orchestrate conduit-status`.
 * @task T13982
 */
export function warnConduitDeprecated(command: string): void {
  pushWarning({
    code: 'W_DEPRECATED_COMMAND',
    message:
      `cleo ${command} is deprecated and will be removed in the next release: conduit ` +
      'messaging is retiring (T13933). Agents message each other over AgentMBX ' +
      '(mbx_* tools, or `agentmbx send`).',
    severity: 'warn',
    deprecated: `cleo ${command}`,
    replacement: 'AgentMBX (mbx_send / agentmbx send)',
    context: { task: 'T13982', epic: 'T13933' },
  });
}
