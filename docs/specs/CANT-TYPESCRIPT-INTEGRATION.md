# CANT TypeScript Integration Guide

**Using @cleocode/cant in TypeScript Applications**

## Installation

```bash
npm install @cleocode/cant
# or
pnpm add @cleocode/cant
```

## Quick Start

```typescript
import { initCantParser, parseCANTMessage } from '@cleocode/cant';

// Initialize (loads WASM if available)
await initCantParser();

// Parse a CANT message
const result = parseCANTMessage('/done @all T1234 #shipped');

console.log(result.directive);     // 'done'
console.log(result.directive_type); // 'actionable'
console.log(result.addresses);     // ['all']
console.log(result.task_refs);     // ['T1234']
console.log(result.tags);          // ['shipped']
```

## API Reference

### `initCantParser(): Promise<void>`

Initializes the CANT parser. Must be called before using `parseCANTMessage`.

```typescript
await initCantParser();
```

### `parseCANTMessage(content: string): ParsedCANTMessage`

Parses a CANT message and returns structured data.

```typescript
interface ParsedCANTMessage {
  directive?: string;           // e.g., 'done', 'action', 'info'
  directive_type: 'actionable' | 'routing' | 'informational';
  addresses: string[];          // Without @ prefix
  task_refs: string[];          // e.g., ['T1234']
  tags: string[];               // Without # prefix
  header_raw: string;           // First line of message
  body: string;                 // Remaining content
}
```

## Examples

### Parse Actionable Directives

```typescript
const msg = parseCANTMessage('/claim T5678');
// msg.directive = 'claim'
// msg.directive_type = 'actionable'
// msg.task_refs = ['T5678']
```

### Parse Routing Directives

```typescript
const msg = parseCANTMessage('/action @cleo-core @signaldock-dev');
// msg.directive = 'action'
// msg.directive_type = 'routing'
// msg.addresses = ['cleo-core', 'signaldock-dev']
```

### Parse Complex Messages

```typescript
const content = `/done @cleoos-opus-orchestrator @all T1234 #shipped #phase-B

## NEXUS Router Shipped

Added assignee field to tasks table.
@versionguard-opencode check T5678.`;

const result = parseCANTMessage(content);
// result.directive = 'done'
// result.addresses = ['cleoos-opus-orchestrator', 'all', 'versionguard-opencode']
// result.task_refs = ['T1234', 'T5678']
// result.tags = ['shipped', 'phase-B']
```

## WASM vs JavaScript

The parser automatically uses WASM if available, falling back to a JavaScript implementation if not.

### WASM Mode (Recommended)
- Full BNF grammar compliance
- Better performance
- 47 unit tests backing

### JavaScript Fallback
- Basic regex-based parsing
- Good for environments where WASM isn't available
- Sufficient for most use cases

## Error Handling

```typescript
try {
  const result = parseCANTMessage(content);
  // Use result
} catch (error) {
  console.error('Failed to parse message:', error);
  // Fallback to treating as plain text
}
```

## Integration with Conduit

```typescript
import { ConduitMessage } from '@cleocode/contracts';
import { parseCANTMessage } from '@cleocode/cant';

function processConduitMessage(msg: ConduitMessage) {
  const cant = parseCANTMessage(msg.content);
  
  if (cant.directive_type === 'actionable') {
    // Route to CQRS operation
    return executeOperation(cant.directive!, cant.task_refs);
  }
  
  if (cant.directive_type === 'routing') {
    // Forward to appropriate agent
    return forwardToAgents(cant.addresses, msg);
  }
  
  // Informational - just log/display
  console.log('Info:', cant.body);
}
```

## Building WASM Locally

If you need to build the WASM module from source:

```bash
cd packages/cant
npm run build:wasm
```

This requires:
- wasm-pack installed
- Rust toolchain

## Testing

```bash
cd packages/cant
npm test
```

## License

MIT - See LICENSE file
