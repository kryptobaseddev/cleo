/**
 * VS Code extension entry point for the CANT DSL language support.
 *
 * Starts a Language Server Protocol client connected to the `cant-lsp`
 * binary via stdio transport. The binary is located either adjacent to
 * the extension or on the system PATH.
 */

import * as path from 'path';
import * as vscode from 'vscode';
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
} from 'vscode-languageclient/node';

let client: LanguageClient | undefined;

/**
 * Activates the extension. Called by VS Code when a `.cant` file is opened.
 */
export function activate(context: vscode.ExtensionContext): void {
  // Look for the cant-lsp binary:
  // 1. Next to the extension (bundled)
  // 2. In the workspace configuration
  // 3. On the system PATH
  const config = vscode.workspace.getConfiguration('cant');
  const configPath = config.get<string>('lspPath');

  const serverPath =
    configPath ||
    context.asAbsolutePath(
      process.platform === 'win32' ? 'cant-lsp.exe' : 'cant-lsp'
    );

  const serverOptions: ServerOptions = {
    run: {
      command: serverPath,
      transport: TransportKind.stdio,
    },
    debug: {
      command: serverPath,
      transport: TransportKind.stdio,
    },
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: 'file', language: 'cant' }],
    synchronize: {
      fileEvents: vscode.workspace.createFileSystemWatcher('**/*.cant'),
    },
  };

  client = new LanguageClient(
    'cant-lsp',
    'CANT Language Server',
    serverOptions,
    clientOptions
  );

  client.start();
}

/**
 * Deactivates the extension. Called by VS Code when the extension is unloaded.
 */
export function deactivate(): Thenable<void> | undefined {
  if (!client) {
    return undefined;
  }
  return client.stop();
}
