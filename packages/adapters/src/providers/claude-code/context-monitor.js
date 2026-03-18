/**
 * Claude Code context monitor provider.
 *
 * Implements AdapterContextMonitorProvider for Claude Code's context window
 * tracking and statusline integration.
 *
 * @task T5240
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { ClaudeCodePathProvider } from './paths.js';
/** Thresholds for context window status levels. */
const THRESHOLDS = {
    WARNING: 50,
    CAUTION: 70,
    CRITICAL: 85,
    EMERGENCY: 95,
};
function getContextStatusFromPercentage(percentage) {
    if (percentage >= THRESHOLDS.EMERGENCY)
        return 'emergency';
    if (percentage >= THRESHOLDS.CRITICAL)
        return 'critical';
    if (percentage >= THRESHOLDS.CAUTION)
        return 'caution';
    if (percentage >= THRESHOLDS.WARNING)
        return 'warning';
    return 'ok';
}
/**
 * Context monitor provider for Claude Code.
 *
 * Processes context window JSON from Claude Code and writes state files
 * for statusline display. Also provides statusline configuration
 * and setup instructions specific to Claude Code's settings.json.
 */
export class ClaudeCodeContextMonitorProvider {
    pathProvider = new ClaudeCodePathProvider();
    async processContextInput(input, cwd) {
        const typed = input;
        const contextSize = typed.context_window?.context_window_size ?? 200000;
        const usage = typed.context_window?.current_usage;
        if (!usage)
            return '-- no data';
        const inputTokens = usage.input_tokens ?? 0;
        const outputTokens = usage.output_tokens ?? 0;
        const cacheCreate = usage.cache_creation_input_tokens ?? 0;
        const totalTokens = inputTokens + outputTokens + cacheCreate;
        const percentage = Math.floor((totalTokens * 100) / contextSize);
        const status = getContextStatusFromPercentage(percentage);
        // Write state file if CLEO dir exists
        const cleoDir = cwd ? join(cwd, '.cleo') : '.cleo';
        if (existsSync(cleoDir)) {
            const stateDir = join(cleoDir, 'context-states');
            const statePath = join(stateDir, '.context-state.json');
            const state = {
                $schema: 'https://cleo-dev.com/schemas/v1/context-state.schema.json',
                version: '1.0.0',
                timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
                staleAfterMs: 5000,
                contextWindow: {
                    maxTokens: contextSize,
                    currentTokens: totalTokens,
                    percentage,
                    breakdown: {
                        inputTokens,
                        outputTokens,
                        cacheCreationTokens: cacheCreate,
                        cacheReadTokens: usage.cache_read_input_tokens ?? 0,
                    },
                },
                thresholds: {
                    warning: THRESHOLDS.WARNING,
                    caution: THRESHOLDS.CAUTION,
                    critical: THRESHOLDS.CRITICAL,
                    emergency: THRESHOLDS.EMERGENCY,
                },
                status,
                cleoSessionId: '',
            };
            try {
                await mkdir(dirname(statePath), { recursive: true });
                writeFileSync(statePath, JSON.stringify(state, null, 2));
            }
            catch {
                // Non-fatal
            }
        }
        return `${percentage}% | ${totalTokens}/${contextSize}`;
    }
    checkStatuslineIntegration() {
        const settingsPath = this.pathProvider.getSettingsPath();
        if (!settingsPath || !existsSync(settingsPath))
            return 'no_settings';
        try {
            const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
            const statusLine = settings.statusLine;
            if (!statusLine?.type)
                return 'not_configured';
            if (statusLine.type !== 'command')
                return 'custom_no_cleo';
            const cmd = statusLine.command ?? '';
            if (cmd.includes('context-monitor.sh') ||
                cmd.includes('cleo-statusline') ||
                cmd.includes('.context-state.json') ||
                cmd.includes('context-states')) {
                return 'configured';
            }
            const scriptPath = cmd.startsWith('~') ? cmd.replace('~', homedir()) : cmd;
            if (existsSync(scriptPath)) {
                try {
                    const content = readFileSync(scriptPath, 'utf-8');
                    if (content.includes('context-state.json'))
                        return 'configured';
                }
                catch {
                    /* unreadable */
                }
            }
            return 'custom_no_cleo';
        }
        catch {
            return 'no_settings';
        }
    }
    getStatuslineConfig() {
        return {
            statusLine: {
                type: 'command',
                command: join(homedir(), '.cleo', 'lib', 'session', 'context-monitor.sh'),
            },
        };
    }
    getSetupInstructions() {
        const settingsPath = this.pathProvider.getSettingsPath() ?? '~/.claude/settings.json';
        return [
            'To enable context monitoring, add to your Claude Code settings:',
            `File: ${settingsPath}`,
            '',
            JSON.stringify(this.getStatuslineConfig(), null, 2),
            '',
            'This enables real-time context window tracking in the CLI.',
        ].join('\n');
    }
}
//# sourceMappingURL=context-monitor.js.map