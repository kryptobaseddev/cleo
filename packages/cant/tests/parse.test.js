"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const parse_1 = require("../src/parse");
(0, vitest_1.describe)('CANT Parser', () => {
    (0, vitest_1.beforeAll)(async () => {
        // Initialize WASM if available
        await (0, parse_1.initCantParser)();
    });
    (0, vitest_1.describe)('parseCANTMessage', () => {
        (0, vitest_1.it)('should parse a simple directive', () => {
            const result = (0, parse_1.parseCANTMessage)('/done');
            (0, vitest_1.expect)(result.directive).toBe('done');
            (0, vitest_1.expect)(result.directive_type).toBe('actionable');
        });
        (0, vitest_1.it)('should parse addresses', () => {
            const result = (0, parse_1.parseCANTMessage)('/action @cleo-core @signaldock-dev');
            (0, vitest_1.expect)(result.directive).toBe('action');
            (0, vitest_1.expect)(result.addresses).toContain('cleo-core');
            (0, vitest_1.expect)(result.addresses).toContain('signaldock-dev');
        });
        (0, vitest_1.it)('should parse task references', () => {
            const result = (0, parse_1.parseCANTMessage)('/done T1234');
            (0, vitest_1.expect)(result.task_refs).toContain('T1234');
        });
        (0, vitest_1.it)('should parse tags', () => {
            const result = (0, parse_1.parseCANTMessage)('/done #shipped #phase-0');
            (0, vitest_1.expect)(result.tags).toContain('shipped');
            (0, vitest_1.expect)(result.tags).toContain('phase-0');
        });
        (0, vitest_1.it)('should parse full message with all elements', () => {
            const content = '/done @all T1234 #shipped\n\nTask completed successfully';
            const result = (0, parse_1.parseCANTMessage)(content);
            (0, vitest_1.expect)(result.directive).toBe('done');
            (0, vitest_1.expect)(result.directive_type).toBe('actionable');
            (0, vitest_1.expect)(result.addresses).toContain('all');
            (0, vitest_1.expect)(result.task_refs).toContain('T1234');
            (0, vitest_1.expect)(result.tags).toContain('shipped');
            (0, vitest_1.expect)(result.body).toContain('Task completed successfully');
        });
        (0, vitest_1.it)('should handle plain text without directive', () => {
            const result = (0, parse_1.parseCANTMessage)('Just a status update');
            (0, vitest_1.expect)(result.directive).toBeUndefined();
            (0, vitest_1.expect)(result.directive_type).toBe('informational');
        });
        (0, vitest_1.it)('should classify routing directives correctly', () => {
            const action = (0, parse_1.parseCANTMessage)('/action');
            (0, vitest_1.expect)(action.directive_type).toBe('routing');
            const review = (0, parse_1.parseCANTMessage)('/review');
            (0, vitest_1.expect)(review.directive_type).toBe('routing');
        });
        (0, vitest_1.it)('should classify informational directives correctly', () => {
            const info = (0, parse_1.parseCANTMessage)('/info');
            (0, vitest_1.expect)(info.directive_type).toBe('informational');
            const status = (0, parse_1.parseCANTMessage)('/status');
            (0, vitest_1.expect)(status.directive_type).toBe('informational');
        });
    });
});
//# sourceMappingURL=parse.test.js.map