# cant-lsp

A Language Server Protocol (LSP) implementation for the CANT DSL, built on
[tower-lsp](https://github.com/ebkalderon/tower-lsp). It delegates all
grammar and validation to `cant_core::validate_document`, so the LSP stays
in sync with the Rust SSoT automatically.

## Features

- **File patterns**: `.cant` files
- **Diagnostics**: real-time parse and validation errors from the 42-rule engine
- **Completions**: top-level keywords, agent properties, directive verbs, events, models
- **Hover**: documentation for directives, events, keywords, and property keys
- **Go to definition**: jump to `agent`, `skill`, or binding definitions
- **Document symbols**: outline view of agents, skills, hooks, workflows, pipelines

## Build

Requires Rust 1.88+ and Cargo.

```sh
cargo build -p cant-lsp --release
```

The binary lands at `target/release/cant-lsp`.

## Editor Setup

### VS Code

Add a `languages.ts` contribution in your extension (or a local `.vscode/settings.json`
pointing to the binary path):

```typescript
import * as vscode from "vscode";
import { LanguageClient, ServerOptions, TransportKind } from "vscode-languageclient/node";

export function activate(context: vscode.ExtensionContext) {
  const serverOptions: ServerOptions = {
    command: "/path/to/cant-lsp",
    transport: TransportKind.stdio,
  };

  const clientOptions = {
    documentSelector: [{ scheme: "file", language: "cant" }],
  };

  const client = new LanguageClient("cant-lsp", "CANT Language Server", serverOptions, clientOptions);
  context.subscriptions.push(client.start());
}
```

Also register the language in `package.json`:

```json
"contributes": {
  "languages": [
    {
      "id": "cant",
      "extensions": [".cant"],
      "configuration": "./language-configuration.json"
    }
  ]
}
```

### Neovim (nvim-lspconfig)

```lua
local lspconfig = require("lspconfig")
local configs = require("lspconfig.configs")

if not configs.cant_lsp then
  configs.cant_lsp = {
    default_config = {
      cmd = { "/path/to/cant-lsp" },
      filetypes = { "cant" },
      root_dir = lspconfig.util.root_pattern(".cleo", "AGENTS.md", ".git"),
      settings = {},
    },
  }
end

lspconfig.cant_lsp.setup({})
```

Associate `.cant` files with the `cant` filetype in your init:

```lua
vim.filetype.add({ extension = { cant = "cant" } })
```

### Zed

In your `settings.json`:

```json
{
  "lsp": {
    "cant-lsp": {
      "binary": {
        "path": "/path/to/cant-lsp"
      }
    }
  },
  "languages": {
    "CANT": {
      "language_servers": ["cant-lsp"]
    }
  }
}
```

Register the language in your Zed extension's `extension.toml`:

```toml
[grammars.cant]
repository = "https://github.com/your-org/tree-sitter-cant"
commit = "<commit>"

[[language_servers]]
name = "cant-lsp"
language = "CANT"
```

## Grammar SSoT

`cant-lsp` never contains its own grammar rules. It calls
`cant_core::validate_document` directly, so every diagnostic it emits
reflects the same 42-rule set that the Rust runtime enforces at
build/deploy time. There is no grammar drift between the editor and
production.
