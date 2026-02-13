import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { FileWatcherService } from '../services/file-watcher.js';

export function setupWebSocket(app: FastifyInstance, fileWatcher: FileWatcherService) {
  app.get('/api/events', { websocket: true }, (socket: WebSocket) => {
    console.log('WebSocket client connected');

    fileWatcher.addClient(socket);

    socket.send(JSON.stringify({
      event: 'connected',
      data: { timestamp: new Date().toISOString() }
    }));

    socket.on('message', (message: Buffer) => {
      try {
        const data = JSON.parse(message.toString());

        if (data.type === 'ping') {
          socket.send(JSON.stringify({
            event: 'pong',
            data: { timestamp: new Date().toISOString() }
          }));
        }
      } catch {
        // Ignore malformed messages
      }
    });

    socket.on('close', () => {
      console.log('WebSocket client disconnected');
    });
  });
}
