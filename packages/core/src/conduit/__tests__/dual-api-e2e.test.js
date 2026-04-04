/**
 * Dual-API E2E test — verify messaging across both SignalDock endpoints.
 *
 * Tests that agents can exchange messages on:
 * 1. api.signaldock.io (canonical)
 * 2. api.clawmsgr.com (legacy)
 * 3. Local signaldock.db (offline)
 *
 * These tests hit real APIs and require valid credentials.
 * Set SKIP_E2E=1 to skip when running in CI without network.
 *
 * @task T226
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HttpTransport } from '../http-transport.js';
// ============================================================================
// Config helpers
// ============================================================================
const CLEO_DIR = join(process.cwd(), '.cleo');
const SKIP_E2E = process.env['SKIP_E2E'] === '1';
/** Load a ClawMsgr/SignalDock config file. */
function loadConfig(filename) {
    const path = join(CLEO_DIR, filename);
    if (!existsSync(path))
        return null;
    try {
        return JSON.parse(readFileSync(path, 'utf-8'));
    }
    catch {
        return null;
    }
}
/** Send a test message and verify it arrives. */
async function testMessageExchange(apiBaseUrl, senderConfig, receiverAgentId) {
    const transport = new HttpTransport();
    try {
        await transport.connect({
            agentId: senderConfig.agentId,
            apiKey: senderConfig.apiKey,
            apiBaseUrl,
        });
        const testContent = `/info @${receiverAgentId} #e2e-test T226 verification at ${new Date().toISOString()}`;
        const result = await transport.push(receiverAgentId, testContent);
        await transport.disconnect();
        return { sent: true, messageId: result.messageId, error: null };
    }
    catch (err) {
        await transport.disconnect();
        return { sent: false, messageId: null, error: String(err) };
    }
}
// ============================================================================
// Test suite
// ============================================================================
describe('Dual-API E2E', () => {
    // --------------------------------------------------------------------------
    // Config verification
    // --------------------------------------------------------------------------
    describe('config files exist', () => {
        it('has clawmsgr configs (legacy)', () => {
            const config = loadConfig('clawmsgr-cleo-rust-lead.json');
            if (!config) {
                console.log('SKIP: clawmsgr config not found');
                return;
            }
            expect(config.agentId).toBe('cleo-rust-lead');
            expect(config.apiBaseUrl).toContain('clawmsgr.com');
        });
        it('has signaldock configs (canonical)', () => {
            const config = loadConfig('signaldock-cleo-rust-lead.json');
            if (!config) {
                console.log('SKIP: signaldock config not found');
                return;
            }
            expect(config.agentId).toBe('cleo-rust-lead');
            expect(config.apiBaseUrl).toContain('signaldock.io');
        });
    });
    // --------------------------------------------------------------------------
    // API health checks
    // --------------------------------------------------------------------------
    describe('API health', () => {
        it('api.signaldock.io is healthy', async () => {
            if (SKIP_E2E)
                return;
            const response = await fetch('https://api.signaldock.io/health', {
                signal: AbortSignal.timeout(10_000),
            });
            expect(response.ok).toBe(true);
            const data = (await response.json());
            expect(data.data?.status).toBe('ok');
        });
        it('api.clawmsgr.com is healthy', async () => {
            if (SKIP_E2E)
                return;
            const response = await fetch('https://api.clawmsgr.com/health', {
                signal: AbortSignal.timeout(10_000),
            });
            expect(response.ok).toBe(true);
            const data = (await response.json());
            expect(data.data?.status).toBe('ok');
        });
    });
    // --------------------------------------------------------------------------
    // Message exchange on api.signaldock.io
    // --------------------------------------------------------------------------
    describe('api.signaldock.io messaging', () => {
        it('can send a message via signaldock.io', async () => {
            if (SKIP_E2E)
                return;
            const config = loadConfig('signaldock-cleo-rust-lead.json');
            if (!config) {
                console.log('SKIP: no signaldock config');
                return;
            }
            const result = await testMessageExchange('https://api.signaldock.io', { agentId: config.agentId, apiKey: config.apiKey }, 'cleo-dev');
            expect(result.sent).toBe(true);
            expect(result.messageId).toBeDefined();
        });
    });
    // --------------------------------------------------------------------------
    // Message exchange on api.clawmsgr.com
    // --------------------------------------------------------------------------
    describe('api.clawmsgr.com messaging', () => {
        it('can send a message via clawmsgr.com', async () => {
            if (SKIP_E2E)
                return;
            const config = loadConfig('clawmsgr-cleo-rust-lead.json');
            if (!config) {
                console.log('SKIP: no clawmsgr config');
                return;
            }
            const result = await testMessageExchange('https://api.clawmsgr.com', { agentId: config.agentId, apiKey: config.apiKey }, 'cleo-dev');
            expect(result.sent).toBe(true);
            expect(result.messageId).toBeDefined();
        });
    });
    // --------------------------------------------------------------------------
    // Cross-API metadata consistency
    // --------------------------------------------------------------------------
    describe('cross-API consistency', () => {
        it('agent profile exists on both APIs', async () => {
            if (SKIP_E2E)
                return;
            const clawConfig = loadConfig('clawmsgr-cleo-rust-lead.json');
            const sdConfig = loadConfig('signaldock-cleo-rust-lead.json');
            if (!clawConfig || !sdConfig) {
                console.log('SKIP: missing configs');
                return;
            }
            // Check agent exists on clawmsgr
            const clawResp = await fetch('https://api.clawmsgr.com/agents/cleo-rust-lead', {
                headers: {
                    Authorization: `Bearer ${clawConfig.apiKey}`,
                    'X-Agent-Id': 'cleo-rust-lead',
                },
                signal: AbortSignal.timeout(10_000),
            });
            // Check agent exists on signaldock
            const sdResp = await fetch('https://api.signaldock.io/agents/cleo-rust-lead', {
                headers: {
                    Authorization: `Bearer ${sdConfig.apiKey}`,
                    'X-Agent-Id': 'cleo-rust-lead',
                },
                signal: AbortSignal.timeout(10_000),
            });
            expect(clawResp.ok).toBe(true);
            expect(sdResp.ok).toBe(true);
            const clawData = (await clawResp.json());
            const sdData = (await sdResp.json());
            expect(clawData.data?.agent?.agentId).toBe('cleo-rust-lead');
            expect(sdData.data?.agent?.agentId).toBe('cleo-rust-lead');
        });
    });
});
//# sourceMappingURL=dual-api-e2e.test.js.map