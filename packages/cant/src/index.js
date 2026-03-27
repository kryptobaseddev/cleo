"use strict";
// WASM loader
Object.defineProperty(exports, "__esModule", { value: true });
exports.isWasmAvailable = exports.initWasm = exports.parseCANTMessage = exports.initCantParser = void 0;
// Parser
var parse_1 = require("./parse");
Object.defineProperty(exports, "initCantParser", { enumerable: true, get: function () { return parse_1.initCantParser; } });
Object.defineProperty(exports, "parseCANTMessage", { enumerable: true, get: function () { return parse_1.parseCANTMessage; } });
// WASM loader
var wasm_loader_1 = require("./wasm-loader");
Object.defineProperty(exports, "initWasm", { enumerable: true, get: function () { return wasm_loader_1.initWasm; } });
Object.defineProperty(exports, "isWasmAvailable", { enumerable: true, get: function () { return wasm_loader_1.isWasmAvailable; } });
//# sourceMappingURL=index.js.map