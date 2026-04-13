# @cleocode/nexus

CLEO project registry and code intelligence — unified nexus package.

## Overview

`@cleocode/nexus` provides tree-sitter powered code analysis and project registry services for the CLEO ecosystem. It enables symbol extraction, structural outlines, codebase search, and single-symbol unfold across multiple languages.

## Features

- **Code Analysis** — Tree-sitter powered AST analysis for symbol extraction and structural outlines
- **Multi-language Support** — JavaScript, TypeScript, Python, Go, Rust, Java, C, C++, Ruby
- **Smart Search** — Codebase search with relevance ranking
- **Schema** — Drizzle SQLite schema for the persistent code symbol index

## Installation

```bash
npm install @cleocode/nexus
```

```bash
pnpm add @cleocode/nexus
```

## Usage

```typescript
import { detectLanguage, parseFile, smartSearch } from '@cleocode/nexus';

// Detect language from file extension
const lang = detectLanguage('src/index.ts');

// Parse a file into an AST
const result = await parseFile('src/index.ts');

// Search the codebase
const matches = await smartSearch({ query: 'authentication', dir: './src' });
```

## License

MIT — see [LICENSE](./LICENSE)
