"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseCANTMessage = parseCANTMessage;
// In a real implementation this would invoke the WASM binding
function parseCANTMessage(content) {
    return {
        directive_type: 'informational',
        addresses: [],
        task_refs: [],
        tags: [],
        header_raw: '',
        body: content,
    };
}
//# sourceMappingURL=parse.js.map