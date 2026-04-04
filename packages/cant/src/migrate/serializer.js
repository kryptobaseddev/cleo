"use strict";
/**
 * CANT AST serializer -- generates .cant file text from structured data.
 *
 * Produces well-formatted .cant files with:
 * - YAML frontmatter (kind, version)
 * - 2-space indentation
 * - Blank lines between top-level blocks
 * - Proper quoting of string values
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.serializeCantDocument = serializeCantDocument;
exports.formatValue = formatValue;
exports.propertiesToIR = propertiesToIR;
/**
 * Serialize a CANT document IR into .cant file text.
 *
 * Produces a complete .cant file including frontmatter and body.
 * All string values are quoted, arrays use bracket notation,
 * and indentation uses 2 spaces per level.
 *
 * @param doc - The document IR to serialize
 * @returns The complete .cant file content as a string
 */
function serializeCantDocument(doc) {
    const lines = [];
    // Frontmatter
    lines.push('---');
    lines.push(`kind: ${doc.kind}`);
    lines.push(`version: ${doc.version}`);
    lines.push('---');
    lines.push('');
    // Main block
    serializeBlock(doc.block, 0, lines);
    // Ensure trailing newline
    return lines.join('\n') + '\n';
}
/**
 * Serialize a single block at the given indentation level.
 */
function serializeBlock(block, indent, lines) {
    const prefix = '  '.repeat(indent);
    // Block header
    lines.push(`${prefix}${block.type} ${block.name}:`);
    const childIndent = indent + 1;
    const childPrefix = '  '.repeat(childIndent);
    // Properties
    for (const prop of block.properties) {
        lines.push(`${childPrefix}${prop.key}: ${formatValue(prop.value)}`);
    }
    // Permissions
    if (block.permissions.length > 0) {
        lines.push(`${childPrefix}permissions:`);
        const permPrefix = '  '.repeat(childIndent + 1);
        for (const perm of block.permissions) {
            lines.push(`${permPrefix}${perm.domain}: ${perm.values.join(', ')}`);
        }
    }
    // Body lines (directives in hooks, etc.)
    if (block.bodyLines && block.bodyLines.length > 0) {
        for (const bodyLine of block.bodyLines) {
            if (bodyLine.trim() === '') {
                lines.push('');
            }
            else {
                lines.push(`${childPrefix}${bodyLine}`);
            }
        }
    }
    // Child blocks (nested hooks, pipeline steps, etc.)
    if (block.children.length > 0) {
        lines.push('');
        for (const child of block.children) {
            serializeBlock(child, childIndent, lines);
            lines.push('');
        }
    }
}
/**
 * Format a property value for .cant output.
 *
 * - Strings are double-quoted
 * - Arrays use bracket notation with quoted elements
 * - Numbers and booleans are bare
 *
 * @param value - The value to format
 * @returns Formatted string
 */
function formatValue(value) {
    if (typeof value === 'string') {
        // Don't double-quote if already quoted or is a bare keyword
        if (/^\d+$/.test(value) || value === 'true' || value === 'false') {
            return value;
        }
        return `"${value.replace(/"/g, '\\"')}"`;
    }
    if (Array.isArray(value)) {
        const elements = value.map((v) => `"${v.replace(/"/g, '\\"')}"`);
        return `[${elements.join(', ')}]`;
    }
    // number or boolean
    return String(value);
}
/**
 * Convert extracted properties to CANT property IR format.
 *
 * Maps known markdown property keys to their CANT equivalents:
 * - "model" -> model
 * - "persistence" / "persist" -> persist
 * - "prompt" -> prompt
 * - "skills" -> skills (as array)
 *
 * @param properties - Extracted markdown properties
 * @returns CANT property IR array
 */
function propertiesToIR(properties) {
    const result = [];
    for (const prop of properties) {
        const key = normalizePropertyKey(prop.key);
        const value = normalizePropertyValue(key, prop.value);
        result.push({ key, value });
    }
    return result;
}
/**
 * Normalize a markdown property key to CANT form.
 */
function normalizePropertyKey(key) {
    const keyMap = {
        model: 'model',
        persistence: 'persist',
        persist: 'persist',
        prompt: 'prompt',
        skills: 'skills',
        skill: 'skills',
        description: 'description',
        tier: 'tier',
    };
    return keyMap[key] ?? key;
}
/**
 * Normalize a property value based on the key type.
 *
 * Skills are converted to arrays, others remain strings.
 */
function normalizePropertyValue(key, value) {
    if (key === 'skills') {
        // "ct-cleo, ct-orchestrator" -> ["ct-cleo", "ct-orchestrator"]
        return value
            .split(/[,\s]+/)
            .map((v) => v.trim())
            .filter(Boolean);
    }
    return value;
}
//# sourceMappingURL=serializer.js.map