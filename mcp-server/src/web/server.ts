import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import path from 'path';
import { fileURLToPath } from 'url';

import { setupRoutes } from './routes/index.js';
import { setupWebSocket } from './websocket/events.js';
import { FileWatcherService } from './services/file-watcher.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface ServerConfig {
  port?: number;
  host?: string;
}

export async function startServer(config: ServerConfig = {}) {
  const PORT = config.port || parseInt(process.env.CLEO_WEB_PORT || '3456', 10);
  const HOST = config.host || process.env.CLEO_WEB_HOST || '127.0.0.1';

  const app = Fastify({
    logger: true
  });

  await app.register(cors, {
    origin: true,
    credentials: true
  });

  await app.register(fastifyStatic, {
    root: path.join(__dirname, '../../public'),
    prefix: '/'
  });

  await app.register(fastifyWebsocket);

  const fileWatcher = new FileWatcherService();

  setupRoutes(app);
  setupWebSocket(app, fileWatcher);

  fileWatcher.start();

  try {
    await app.listen({ port: PORT, host: HOST });
    console.log(`CLEO Nexus Web UI running at http://${HOST}:${PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  process.on('SIGTERM', async () => {
    fileWatcher.stop();
    await app.close();
  });

  process.on('SIGINT', async () => {
    fileWatcher.stop();
    await app.close();
  });

  return app;
}

// If called directly, start server
if (import.meta.url === `file://${process.argv[1]}`) {
  startServer();
}
