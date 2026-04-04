"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseCANTMessage = exports.initCantParser = exports.isWasmAvailable = exports.isNativeAvailable = exports.initWasm = exports.showSummary = exports.showDiff = exports.serializeCantDocument = exports.migrateMarkdown = void 0;
// Migration engine
var index_1 = require("./migrate/index");
Object.defineProperty(exports, "migrateMarkdown", { enumerable: true, get: function () { return index_1.migrateMarkdown; } });
Object.defineProperty(exports, "serializeCantDocument", { enumerable: true, get: function () { return index_1.serializeCantDocument; } });
Object.defineProperty(exports, "showDiff", { enumerable: true, get: function () { return index_1.showDiff; } });
Object.defineProperty(exports, "showSummary", { enumerable: true, get: function () { return index_1.showSummary; } });
// Native loader (replaces wasm-loader)
var native_loader_1 = require("./native-loader");
Object.defineProperty(exports, "initWasm", { enumerable: true, get: function () { return native_loader_1.initWasm; } });
Object.defineProperty(exports, "isNativeAvailable", { enumerable: true, get: function () { return native_loader_1.isNativeAvailable; } });
Object.defineProperty(exports, "isWasmAvailable", { enumerable: true, get: function () { return native_loader_1.isWasmAvailable; } });
// Parser
var parse_1 = require("./parse");
Object.defineProperty(exports, "initCantParser", { enumerable: true, get: function () { return parse_1.initCantParser; } });
Object.defineProperty(exports, "parseCANTMessage", { enumerable: true, get: function () { return parse_1.parseCANTMessage; } });
//# sourceMappingURL=index.js.map