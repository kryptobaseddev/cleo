import type { FastifyInstance } from 'fastify';
import { nexusRoutes } from './nexus.js';
import { projectRoutes } from './projects.js';

export function setupRoutes(app: FastifyInstance) {
  // Health check
  app.get('/api/health', async () => {
    return {
      status: 'ok',
      version: '0.1.0',
      timestamp: new Date().toISOString()
    };
  });

  // Register routes
  app.register(nexusRoutes, { prefix: '/api/nexus' });
  app.register(projectRoutes, { prefix: '/api/projects' });
}
