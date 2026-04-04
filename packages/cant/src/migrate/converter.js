"use strict";
/**
 * Markdown-to-CANT conversion engine.
 *
 * Converts identified markdown sections into CANT document IR.
 * Conservative by design: uncertain sections are flagged with
 * TODO comments rather than guessed.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.migrateMarkdown = migrateMarkdown;
const markdown_parser_1 = require("./markdown-parser");
const serializer_1 = require("./serializer");
/**
 * Migrate a markdown file to CANT format.
 *
 * Parses the markdown into sections, classifies each section,
 * converts recognized patterns to .cant files, and flags
 * everything else as unconverted with TODO comments.
 *
 * @param content - Raw markdown file content
 * @param inputFile - Path to the input file (for diagnostics)
 * @param options - Migration options (write, verbose, outputDir)
 * @returns Migration result with converted files and unconverted sections
 */
function migrateMarkdown(content, inputFile, options) {
    const sections = (0, markdown_parser_1.parseMarkdownSections)(content);
    const outputDir = options.outputDir ?? '.cleo/agents';
    const outputFiles = [];
    const unconverted = [];
    for (const section of sections) {
        switch (section.classification) {
            case 'agent':
                convertAgentSection(section, outputDir, outputFiles);
                break;
            case 'hook':
                convertHookSection(section, outputDir, outputFiles, unconverted);
                break;
            case 'permissions':
                // Permissions are typically embedded in agent sections.
                // Standalone permission sections are flagged as unconverted
                // since they need a parent agent context.
                unconverted.push({
                    lineStart: section.lineStart,
                    lineEnd: section.lineEnd,
                    reason: 'Standalone permissions section needs parent agent context',
                    content: formatSectionContent(section),
                });
                break;
            case 'skill':
                convertSkillSection(section, outputDir, outputFiles, unconverted);
                break;
            case 'workflow':
                convertWorkflowSection(section, outputDir, outputFiles, unconverted);
                break;
            case 'unknown':
                unconverted.push({
                    lineStart: section.lineStart,
                    lineEnd: section.lineEnd,
                    reason: 'Could not classify section for automatic conversion',
                    content: formatSectionContent(section),
                });
                break;
        }
    }
    const summary = buildSummary(outputFiles, unconverted);
    return {
        inputFile,
        outputFiles,
        unconverted,
        summary,
    };
}
/**
 * Convert an agent-classified section to a .cant file.
 */
function convertAgentSection(section, outputDir, outputFiles) {
    const identifier = (0, markdown_parser_1.headingToIdentifier)(section.heading);
    if (!identifier)
        return;
    const properties = (0, markdown_parser_1.extractProperties)(section.bodyLines);
    const cantProperties = (0, serializer_1.propertiesToIR)(properties);
    // Check for inline permissions within the agent section
    const permissions = extractInlinePermissions(section.bodyLines);
    const block = {
        type: 'agent',
        name: identifier,
        properties: cantProperties,
        permissions,
        children: [],
    };
    const doc = {
        kind: 'agent',
        version: 1,
        block,
    };
    const cantContent = (0, serializer_1.serializeCantDocument)(doc);
    const path = `${outputDir}/${identifier}.cant`;
    outputFiles.push({
        path,
        kind: 'agent',
        content: cantContent,
    });
}
/**
 * Extract permissions that appear inline within an agent body section.
 *
 * Looks for sub-sections or indented lists under "Permissions:" within
 * the body of an agent section.
 */
function extractInlinePermissions(bodyLines) {
    let inPermissions = false;
    const permissionLines = [];
    for (const line of bodyLines) {
        if (/^\*?\*?permissions?\*?\*?\s*:/i.test(line.trim())) {
            inPermissions = true;
            continue;
        }
        if (inPermissions) {
            if (/^[-*]\s+/.test(line.trim()) || /^\s+[-*]\s+/.test(line)) {
                permissionLines.push(line.trim());
            }
            else if (line.trim() === '') {
            }
            else {
                // Non-list line ends the permissions block
                inPermissions = false;
            }
        }
    }
    return (0, markdown_parser_1.extractPermissions)(permissionLines);
}
/**
 * Convert a hook-classified section to a .cant file.
 */
function convertHookSection(section, outputDir, outputFiles, unconverted) {
    const eventName = (0, markdown_parser_1.headingToEventName)(section.heading);
    if (!eventName) {
        // Cannot determine the specific event -- flag as unconverted
        unconverted.push({
            lineStart: section.lineStart,
            lineEnd: section.lineEnd,
            reason: `Hook heading "${section.heading}" does not match a known CAAMP event`,
            content: formatSectionContent(section),
        });
        return;
    }
    // Convert body to directive-like lines
    const hookBodyLines = convertHookBody(section.bodyLines);
    const identifier = eventName
        .replace(/([A-Z])/g, '-$1')
        .toLowerCase()
        .replace(/^-/, '');
    const block = {
        type: 'on',
        name: eventName,
        properties: [],
        permissions: [],
        children: [],
        bodyLines: hookBodyLines,
    };
    const doc = {
        kind: 'hook',
        version: 1,
        block,
    };
    const cantContent = (0, serializer_1.serializeCantDocument)(doc);
    const path = `${outputDir}/${identifier}.cant`;
    outputFiles.push({
        path,
        kind: 'hook',
        content: cantContent,
    });
}
/**
 * Convert hook body markdown (numbered/bulleted lists) into CANT body lines.
 *
 * Strips numbering and bullet prefixes. Preserves directive lines (/verb).
 * Wraps prose instructions as session prompts or TODO comments.
 */
function convertHookBody(bodyLines) {
    const result = [];
    for (const line of bodyLines) {
        const trimmed = line.trim();
        if (!trimmed)
            continue;
        // Strip numbered list prefix: "1. " -> ""
        const stripped = trimmed.replace(/^\d+\.\s+/, '').replace(/^[-*]\s+/, '');
        // Already a directive line
        if (stripped.startsWith('/')) {
            result.push(stripped);
            continue;
        }
        // Check for context-like references
        const contextMatch = stripped.match(/^(?:load\s+)?context\s*:\s*(.+)/i);
        if (contextMatch) {
            const items = (contextMatch[1] ?? '')
                .split(/[,\s]+/)
                .map((s) => s.trim())
                .filter(Boolean);
            result.push(`# context: [${items.join(', ')}]`);
            continue;
        }
        // Wrap as TODO comment for prose content
        result.push(`# TODO: manual conversion needed -- ${stripped}`);
    }
    return result;
}
/**
 * Convert a skill-classified section to a .cant file.
 */
function convertSkillSection(section, outputDir, outputFiles, unconverted) {
    const identifier = (0, markdown_parser_1.headingToIdentifier)(section.heading);
    if (!identifier || identifier === 'skill' || identifier === 'skills') {
        // Generic "Skills" heading -- just a list, not a skill definition
        unconverted.push({
            lineStart: section.lineStart,
            lineEnd: section.lineEnd,
            reason: 'Generic skills list cannot be converted to a skill definition',
            content: formatSectionContent(section),
        });
        return;
    }
    const properties = (0, markdown_parser_1.extractProperties)(section.bodyLines);
    const cantProperties = (0, serializer_1.propertiesToIR)(properties);
    const block = {
        type: 'skill',
        name: identifier,
        properties: cantProperties,
        permissions: [],
        children: [],
    };
    const doc = {
        kind: 'skill',
        version: 1,
        block,
    };
    const cantContent = (0, serializer_1.serializeCantDocument)(doc);
    const path = `${outputDir}/${identifier}.cant`;
    outputFiles.push({
        path,
        kind: 'skill',
        content: cantContent,
    });
}
/**
 * Convert a workflow-classified section to a .cant file.
 *
 * Workflows are the hardest to convert automatically. We attempt
 * basic pipeline conversion for numbered procedure lists, but
 * flag complex workflows as TODO.
 */
function convertWorkflowSection(section, outputDir, outputFiles, unconverted) {
    const identifier = (0, markdown_parser_1.headingToIdentifier)(section.heading);
    if (!identifier)
        return;
    // Check if the body is a simple numbered step list (deploy procedure pattern)
    const steps = extractPipelineSteps(section.bodyLines);
    if (steps.length === 0) {
        unconverted.push({
            lineStart: section.lineStart,
            lineEnd: section.lineEnd,
            reason: 'Workflow section too complex for automatic conversion',
            content: formatSectionContent(section),
        });
        return;
    }
    // Build pipeline steps as children
    const stepBlocks = steps.map((step, i) => ({
        type: 'step',
        name: step.name || `step-${i + 1}`,
        properties: step.properties,
        permissions: [],
        children: [],
    }));
    const pipelineBlock = {
        type: 'pipeline',
        name: `${identifier}-pipeline`,
        properties: [],
        permissions: [],
        children: stepBlocks,
    };
    const workflowBlock = {
        type: 'workflow',
        name: identifier,
        properties: [],
        permissions: [],
        children: [pipelineBlock],
    };
    const doc = {
        kind: 'workflow',
        version: 1,
        block: workflowBlock,
    };
    const cantContent = (0, serializer_1.serializeCantDocument)(doc);
    const path = `${outputDir}/${identifier}.cant`;
    outputFiles.push({
        path,
        kind: 'workflow',
        content: cantContent,
    });
}
/**
 * Extract pipeline steps from a numbered list of commands.
 *
 * Recognizes patterns like:
 * - `1. Run \`command here\``
 * - `2. Execute \`another command\``
 *
 * @param lines - Body lines to extract from
 * @returns Array of extracted steps, empty if content is not step-like
 */
function extractPipelineSteps(lines) {
    const steps = [];
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed)
            continue;
        // Match: "1. Run `command`" or "- Run `command`"
        const cmdMatch = trimmed.match(/^(?:\d+\.|[-*])\s+(?:run\s+)?`([^`]+)`/i);
        if (cmdMatch) {
            const fullCmd = cmdMatch[1] ?? '';
            const parts = fullCmd.split(/\s+/);
            const command = parts[0] ?? fullCmd;
            const args = parts.slice(1);
            const properties = [{ key: 'command', value: command }];
            if (args.length > 0) {
                properties.push({ key: 'args', value: args });
            }
            const stepName = deriveStepName(fullCmd);
            steps.push({ name: stepName, properties });
            continue;
        }
        // Non-command lines break the pipeline pattern
        // unless they're conditional prose (which we skip for now)
        if (/^(?:\d+\.|[-*])\s+(?:if|then|else|ask|wait)/i.test(trimmed)) {
            // Conditional step -- too complex, bail out
            // Return empty to signal the whole section should be unconverted
            return [];
        }
    }
    return steps;
}
/**
 * Derive a step name from a command string.
 *
 * "pnpm run build" -> "build"
 * "pnpm test" -> "test"
 * "gh pr diff" -> "gh-pr-diff"
 */
function deriveStepName(cmd) {
    const parts = cmd.split(/\s+/);
    // Common patterns: "pnpm run X" -> X, "npm run X" -> X
    if (parts.length >= 3 && (parts[0] === 'pnpm' || parts[0] === 'npm') && parts[1] === 'run') {
        return (parts[2] ?? 'step').replace(/[^a-z0-9-]/g, '-');
    }
    // "pnpm test" -> "test"
    if (parts.length >= 2 && (parts[0] === 'pnpm' || parts[0] === 'npm')) {
        return (parts[1] ?? 'step').replace(/[^a-z0-9-]/g, '-');
    }
    // Generic: take last meaningful segment
    const lastPart = parts[parts.length - 1] ?? 'step';
    return lastPart.replace(/[^a-z0-9-]/g, '-').replace(/^-|-$/g, '') || 'step';
}
/**
 * Format a section's content as a single string for unconverted output.
 */
function formatSectionContent(section) {
    const headingPrefix = '#'.repeat(section.level);
    const heading = `${headingPrefix} ${section.heading}`;
    return [heading, ...section.bodyLines].join('\n');
}
/**
 * Build a human-readable migration summary.
 */
function buildSummary(outputFiles, unconverted) {
    const converted = outputFiles.length;
    const remaining = unconverted.length;
    const parts = [];
    parts.push(`${converted} section(s) converted`);
    parts.push(`${remaining} section(s) left as TODO`);
    if (outputFiles.length > 0) {
        const kinds = new Map();
        for (const file of outputFiles) {
            kinds.set(file.kind, (kinds.get(file.kind) ?? 0) + 1);
        }
        const kindSummary = [...kinds.entries()].map(([kind, count]) => `${count} ${kind}`).join(', ');
        parts.push(`(${kindSummary})`);
    }
    return parts.join(', ');
}
//# sourceMappingURL=converter.js.map