import chokidar from 'chokidar';
import path from 'path';
import os from 'os';
import type { WebSocket } from 'ws';

interface FileChangeEvent {
  type: 'change' | 'add' | 'unlink';
  path: string;
  timestamp: string;
}

export class FileWatcherService {
  private watcher?: chokidar.FSWatcher;
  private clients = new Set<WebSocket>();
  private cleoDir = path.join(os.homedir(), '.cleo');

  addClient(ws: WebSocket) {
    this.clients.add(ws);

    ws.on('close', () => {
      this.clients.delete(ws);
    });
  }

  start() {
    this.watcher = chokidar.watch(
      [
        path.join(this.cleoDir, '*.json'),
        path.join(this.cleoDir, '**/*.json'),
        '.cleo/*.json'
      ],
      {
        ignoreInitial: true,
        ignored: [
          '**/node_modules/**',
          '**/.git/**',
          '**/dist/**'
        ]
      }
    );

    this.watcher.on('change', (filePath) => {
      this.broadcast({
        type: 'change',
        path: filePath,
        timestamp: new Date().toISOString()
      });
    });

    this.watcher.on('add', (filePath) => {
      this.broadcast({
        type: 'add',
        path: filePath,
        timestamp: new Date().toISOString()
      });
    });

    this.watcher.on('unlink', (filePath) => {
      this.broadcast({
        type: 'unlink',
        path: filePath,
        timestamp: new Date().toISOString()
      });
    });

    console.log('File watcher started');
  }

  stop() {
    this.watcher?.close();
    console.log('File watcher stopped');
  }

  private broadcast(event: FileChangeEvent) {
    const message = JSON.stringify({
      event: 'file-change',
      data: event
    });

    this.clients.forEach((ws) => {
      if (ws.readyState === 1) { // WebSocket.OPEN
        ws.send(message);
      }
    });
  }
}
