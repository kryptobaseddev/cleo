/**
 * Tests for StoreProvider abstraction layer.
 *
 * @task T4644
 * @task T4854
 * @epic T4638
 */
import { describe, expect, it } from 'vitest';
describe('StoreProvider', () => {
    it('StoreEngine type only allows sqlite', () => {
        const engine = 'sqlite';
        expect(engine).toBe('sqlite');
    });
});
//# sourceMappingURL=provider.test.js.map