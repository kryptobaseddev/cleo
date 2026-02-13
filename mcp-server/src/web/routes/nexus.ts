import type { FastifyInstance } from 'fastify';
import { dataService } from '../services/data-service.js';

export async function nexusRoutes(app: FastifyInstance) {
  // GET /api/nexus/overview - Real global overview
  app.get('/overview', async () => {
    try {
      const [projects, stats, topProjects] = await Promise.all([
        dataService.getAllProjects(),
        dataService.getGlobalStats(),
        dataService.getTopActiveProjects(3)
      ]);

      // Calculate health metrics
      const healthErrors = projects.filter(p => p.healthStatus === 'error').length;
      const healthWarnings = projects.filter(p => p.healthStatus === 'warning').length;
      const healthHealthy = projects.filter(p => p.healthStatus === 'healthy').length;

      // Calculate total labels across all projects
      const allLabels = new Set<string>();
      projects.forEach(p => {
        p.labels?.forEach(l => allLabels.add(l));
      });

      // Aggregate all tasks from top projects with details
      const topProjectsWithDetails = await Promise.all(
        topProjects.map(async (project) => {
          try {
            const stats = await dataService.getProjectStats(project.path);
            return {
              hash: project.hash,
              name: project.name,
              path: project.path,
              healthStatus: project.healthStatus,
              taskCount: project.taskCount || 0,
              labels: project.labels || [],
              stats: stats?.current_state || {},
              completionMetrics: stats?.completion_metrics || {}
            };
          } catch {
            return {
              hash: project.hash,
              name: project.name,
              path: project.path,
              healthStatus: project.healthStatus,
              taskCount: project.taskCount || 0,
              labels: project.labels || [],
              stats: {},
              completionMetrics: {}
            };
          }
        })
      );

      return {
        version: '0.88.0',
        schemaVersion: '2.0.0',
        status: healthErrors > 0 ? 'degraded' : healthWarnings > 0 ? 'warning' : 'operational',
        timestamp: new Date().toISOString(),
        projects: {
          total: projects.length,
          registered: projects.length,
          healthy: healthHealthy,
          errors: healthErrors,
          warnings: healthWarnings,
          topActive: topProjectsWithDetails
        },
        stats,
        labels: {
          totalUnique: allLabels.size,
          all: Array.from(allLabels).slice(0, 50) // Top 50 labels
        },
        projectsList: projects.map(p => ({
          hash: p.hash,
          name: p.name,
          path: p.path,
          healthStatus: p.healthStatus || 'unknown',
          healthLastCheck: p.healthLastCheck,
          permissions: p.permissions || 'read',
          taskCount: p.taskCount || 0,
          labels: p.labels || [],
          lastSeen: p.lastSeen,
          lastSync: p.lastSync
        }))
      };
    } catch (error) {
      console.error('Nexus overview error:', error);
      return {
        version: '0.88.0',
        status: 'error',
        error: String(error),
        projects: { total: 0, registered: 0, errors: 0, warnings: 0, topActive: [] },
        stats: await dataService.getGlobalStats(),
        labels: { totalUnique: 0, all: [] },
        projectsList: []
      };
    }
  });

  // GET /api/nexus/projects - All registered projects with stats
  app.get('/projects', async () => {
    try {
      const projects = await dataService.getAllProjects();
      
      // Enhance with stats for each project
      const enhancedProjects = await Promise.all(
        projects.map(async (project) => {
          try {
            const stats = await dataService.getProjectStats(project.path);
            return {
              ...project,
              stats: stats?.current_state || null,
              completionMetrics: stats?.completion_metrics || null
            };
          } catch {
            return project;
          }
        })
      );

      return { projects: enhancedProjects };
    } catch (error) {
      console.error('Failed to get projects:', error);
      return { projects: [], error: String(error) };
    }
  });

  // GET /api/nexus/search?q=term&project=x&limit=20&status=active - Search across all projects
  app.get('/search', async (request) => {
    const { q, project, limit = '20', status } = request.query as { 
      q?: string; 
      project?: string;
      limit?: string;
      status?: string;
    };
    
    if (!q) {
      return { query: '', results: [], total: 0 };
    }

    try {
      // Get all projects to enrich results with project names
      const projects = await dataService.getAllProjects();
      const projectMap = new Map(projects.map((p: any) => [p.name, p]));
      
      let results = await dataService.searchTasks(q, { 
        project, 
        limit: parseInt(limit),
        status: status && status !== 'all' ? status : undefined
      });
      
      // Enrich results with project information
      const enrichedResults = results.map((result: any) => {
        const projectName = result.projectName || project || 'Unknown';
        const projectInfo = projectMap.get(projectName);
        
        return {
          ...result,
          projectName,
          projectHash: projectInfo?.hash,
          projectPath: projectInfo?.path
        };
      });
      
      return { 
        query: q, 
        results: enrichedResults,
        total: enrichedResults.length,
        filters: { project, status }
      };
    } catch (error) {
      console.error('Search error:', error);
      return { query: q, results: [], total: 0, error: String(error) };
    }
  });

  // GET /api/nexus/discover/:taskId?method=auto&limit=10 - Discover related tasks
  app.get('/discover/:taskId', async (request) => {
    const { taskId } = request.params as { taskId: string };
    const { method = 'auto', limit = '10' } = request.query as {
      method?: string;
      limit?: string;
    };

    try {
      const results = await dataService.discoverRelated(taskId, {
        method,
        limit: parseInt(limit)
      });
      return { taskId, method, results };
    } catch (error) {
      console.error('Discover error:', error);
      return { taskId, method, results: [], error: String(error) };
    }
  });

  // GET /api/nexus/deps/:taskId?reverse=false - Get cross-project dependencies
  app.get('/deps/:taskId', async (request) => {
    const { taskId } = request.params as { taskId: string };
    const { reverse = 'false' } = request.query as { reverse?: string };

    try {
      const deps = await dataService.getNexusDeps(taskId, reverse === 'true');
      return { taskId, reverse: reverse === 'true', dependencies: deps };
    } catch (error) {
      console.error('Nexus deps error:', error);
      return { taskId, reverse: reverse === 'true', dependencies: null, error: String(error) };
    }
  });

  // GET /api/nexus/stats - Global statistics
  app.get('/stats', async () => {
    try {
      const stats = await dataService.getGlobalStats();
      return stats;
    } catch (error) {
      console.error('Stats error:', error);
      return { error: String(error) };
    }
  });

  // GET /api/nexus/graph - Global relationship graph
  app.get('/graph', async () => {
    try {
      const projects = await dataService.getAllProjects();
      
      // Build nodes and edges for all projects
      const nodes: any[] = [];
      const edges: any[] = [];
      
      for (const project of projects) {
        try {
          const { tasks } = await dataService.getProjectTasks(project.path);
          
          // Add project node
          nodes.push({
            id: `project:${project.hash}`,
            type: 'project',
            label: project.name,
            hash: project.hash,
            healthStatus: project.healthStatus
          });
          
          // Add task nodes
          tasks.forEach((task: any) => {
            nodes.push({
              id: `${project.hash}:${task.id}`,
              nodeType: 'task',
              label: task.title || task.id,
              taskId: task.id,
              projectHash: project.hash,
              status: task.status,
              priority: task.priority,
              taskType: task.type
            });
            
            // Add parent relationship
            if (task.parentId) {
              edges.push({
                from: `${project.hash}:${task.parentId}`,
                to: `${project.hash}:${task.id}`,
                type: 'parent'
              });
            }
            
            // Add dependency relationships
            if (task.dependsOn) {
              task.dependsOn.forEach((depId: string) => {
                edges.push({
                  from: `${project.hash}:${depId}`,
                  to: `${project.hash}:${task.id}`,
                  type: 'depends'
                });
              });
            }
          });
        } catch (e) {
          // Skip projects we can't read
        }
      }
      
      return { nodes, edges };
    } catch (error) {
      console.error('Graph error:', error);
      return { nodes: [], edges: [], error: String(error) };
    }
  });
}
