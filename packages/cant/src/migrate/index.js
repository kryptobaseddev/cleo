"use strict";
/**
 * CANT migration engine -- markdown-to-CANT conversion tooling.
 *
 * Entry point for the `cant migrate` command and programmatic
 * migration of AGENTS.md files to .cant format.
 *
 * @example
 * ```typescript
 * import { migrateMarkdown, showDiff } from '@cleocode/cant/migrate';
 *
 * const result = migrateMarkdown(markdownContent, 'AGENTS.md', {
 *   write: false,
 *   verbose: false,
 * });
 *
 * console.log(showDiff(result));
 * ```
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.serializeCantDocument = exports.showSummary = exports.showDiff = exports.migrateMarkdown = void 0;
var converter_1 = require("./converter");
Object.defineProperty(exports, "migrateMarkdown", { enumerable: true, get: function () { return converter_1.migrateMarkdown; } });
var diff_1 = require("./diff");
Object.defineProperty(exports, "showDiff", { enumerable: true, get: function () { return diff_1.showDiff; } });
Object.defineProperty(exports, "showSummary", { enumerable: true, get: function () { return diff_1.showSummary; } });
var serializer_1 = require("./serializer");
Object.defineProperty(exports, "serializeCantDocument", { enumerable: true, get: function () { return serializer_1.serializeCantDocument; } });
//# sourceMappingURL=index.js.map