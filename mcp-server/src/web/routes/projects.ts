import type { FastifyInstance } from 'fastify';
import { dataService } from '../services/data-service.js';

export async function projectRoutes(app: FastifyInstance) {
  // GET /api/projects/:hash - Project details
  app.get('/:hash', async (request, reply) => {
    const { hash } = request.params as { hash: string };

    try {
      const projects = await dataService.getAllProjects();
      const project = projects.find((p: any) => p.hash === hash);

      if (!project) {
        return reply.status(404).send({ error: 'Project not found' });
      }

      return {
        hash: project.hash,
        name: project.name,
        path: project.path,
        registeredAt: project.registeredAt,
        lastSeen: project.lastSeen,
        healthStatus: project.healthStatus || 'unknown',
        permissions: project.permissions || 'read',
        taskCount: project.taskCount || 0,
        labels: project.labels || [],
        lastSync: project.lastSync
      };
    } catch (error) {
      console.error('Project detail error:', error);
      return reply.status(500).send({ error: String(error) });
    }
  });

  // GET /api/projects/:hash/dashboard - Full project dashboard
  app.get('/:hash/dashboard', async (request, reply) => {
    const { hash } = request.params as { hash: string };

    try {
      const projects = await dataService.getAllProjects();
      const project = projects.find((p: any) => p.hash === hash);

      if (!project) {
        return reply.status(404).send({ error: 'Project not found' });
      }

      // Get comprehensive data
      const [stats, hierarchy, orphans, staleTasks] = await Promise.all([
        dataService.getProjectStats(project.path),
        dataService.getTaskHierarchy(project.path),
        dataService.getOrphans(project.path),
        dataService.getStaleTasks(project.path, 30)
      ]);

      return {
        project: {
          hash: project.hash,
          name: project.name,
          path: project.path,
          healthStatus: project.healthStatus || 'unknown',
          permissions: project.permissions || 'read',
          registeredAt: project.registeredAt,
          lastSeen: project.lastSeen,
          taskCount: project.taskCount || 0,
          labels: project.labels || [],
          lastSync: project.lastSync
        },
        stats: stats?.current_state || {},
        completionMetrics: stats?.completion_metrics || {},
        hierarchy: {
          epics: hierarchy.epics,
          orphaned: hierarchy.orphaned,
          stats: hierarchy.stats
        },
        issues: {
          orphans: orphans.length,
          staleTasks: staleTasks.length,
          orphanedDetails: orphans.slice(0, 10),
          staleDetails: staleTasks.slice(0, 10)
        }
      };
    } catch (error) {
      console.error('Project dashboard error:', error);
      return reply.status(500).send({ error: String(error) });
    }
  });

  // GET /api/projects/:hash/tasks - All tasks with filtering and pagination
  app.get('/:hash/tasks', async (request, reply) => {
    const { hash } = request.params as { hash: string };
    const { status, priority, type, search, limit = '50', offset = '0' } = request.query as { 
      status?: string; 
      priority?: string;
      type?: string;
      search?: string;
      limit?: string;
      offset?: string;
    };

    try {
      const projects = await dataService.getAllProjects();
      const project = projects.find((p: any) => p.hash === hash);

      if (!project) {
        return reply.status(404).send({ error: 'Project not found' });
      }

      // Get paginated tasks
      const limitNum = parseInt(limit) || 50;
      const offsetNum = parseInt(offset) || 0;
      
      const { tasks, total, hasMore } = await dataService.getProjectTasks(project.path, {
        limit: limitNum,
        offset: offsetNum
      });

      // Apply filters
      let filtered = tasks;
      if (status) filtered = filtered.filter((t: any) => t.status === status);
      if (priority) filtered = filtered.filter((t: any) => t.priority === priority);
      if (type) filtered = filtered.filter((t: any) => t.type === type);
      if (search) {
        const searchLower = search.toLowerCase();
        filtered = filtered.filter((t: any) => 
          t.id?.toLowerCase().includes(searchLower) ||
          t.title?.toLowerCase().includes(searchLower) ||
          t.content?.toLowerCase().includes(searchLower) ||
          t.description?.toLowerCase().includes(searchLower)
        );
      }

      return { 
        tasks: filtered,
        total,
        filtered: filtered.length,
        pagination: {
          limit: limitNum,
          offset: offsetNum,
          hasMore,
          nextOffset: hasMore ? offsetNum + limitNum : null
        },
        project: {
          hash: project.hash,
          name: project.name,
          path: project.path
        }
      };
    } catch (error) {
      console.error('Tasks error:', error);
      return reply.status(500).send({ error: String(error) });
    }
  });

  // GET /api/projects/:hash/hierarchy - Task hierarchy tree
  app.get('/:hash/hierarchy', async (request, reply) => {
    const { hash } = request.params as { hash: string };

    try {
      const projects = await dataService.getAllProjects();
      const project = projects.find((p: any) => p.hash === hash);

      if (!project) {
        return reply.status(404).send({ error: 'Project not found' });
      }

      const hierarchy = await dataService.getTaskHierarchy(project.path);
      return hierarchy;
    } catch (error) {
      console.error('Hierarchy error:', error);
      return reply.status(500).send({ error: String(error) });
    }
  });

  // GET /api/projects/:hash/tasks/:id - Single task detail with hierarchy
  app.get('/:hash/tasks/:id', async (request, reply) => {
    const { hash, id } = request.params as { hash: string; id: string };

    try {
      const projects = await dataService.getAllProjects();
      const project = projects.find((p: any) => p.hash === hash);

      if (!project) {
        return reply.status(404).send({ error: 'Project not found' });
      }

      // Get task details
      const taskDetails = await dataService.getTaskDetails(project.path, id);
      
      if (!taskDetails) {
        return reply.status(404).send({ error: 'Task not found' });
      }

      // Get all tasks for hierarchy context (without pagination)
      const { tasks: allTasks } = await dataService.getProjectTasks(project.path, { limit: 10000 });
      
      // Build hierarchy context
      const task = allTasks.find((t: any) => t.id === id);
      let hierarchyContext = null;
      
      if (task) {
        // Find parent
        const parent = task.parentId ? allTasks.find((t: any) => t.id === task.parentId) : null;
        
        // Find children
        const children = allTasks.filter((t: any) => t.parentId === id);
        
        // Find siblings (same parent)
        const siblings = task.parentId 
          ? allTasks.filter((t: any) => t.parentId === task.parentId && t.id !== id)
          : [];
        
        // Calculate cousin score (sibling boost +0.15, cousin boost +0.08)
        const cousins: any[] = [];
        if (parent?.parentId) {
          const grandparentId = parent.parentId;
          const auntsUncles = allTasks.filter((t: any) => 
            t.parentId === grandparentId && t.id !== parent.id
          );
          auntsUncles.forEach((au: any) => {
            const auChildren = allTasks.filter((t: any) => t.parentId === au.id);
            auChildren.forEach((cousin: any) => {
              cousins.push({
                ...cousin,
                score: 0.08,
                relation: 'cousin',
                path: `${grandparentId} -> ${au.id} -> ${cousin.id}`
              });
            });
          });
        }
        
        // Add scoring to siblings
        const scoredSiblings = siblings.map((s: any) => ({
          ...s,
          score: 0.15,
          relation: 'sibling',
          path: `${task.parentId} -> ${s.id}`
        }));
        
        hierarchyContext = {
          parent,
          children,
          siblings: scoredSiblings,
          cousins,
          score: {
            sibling: 0.15,
            cousin: 0.08,
            parentDecay: [0.5, 0.25]
          }
        };
      }

      // Get dependencies
      const dependencies = await dataService.getTaskDependencies(project.path, id);

      return {
        task: taskDetails,
        project: {
          hash: project.hash,
          name: project.name,
          path: project.path
        },
        hierarchy: hierarchyContext,
        dependencies,
        allTasks: allTasks.filter((t: any) => 
          // Include related tasks for context
          t.id === id ||
          t.parentId === id ||
          t.id === task?.parentId ||
          (task?.dependsOn || []).includes(t.id) ||
          (t.dependsOn || []).includes(id)
        ).slice(0, 50) // Limit to 50 related tasks
      };
    } catch (error) {
      console.error('Task detail error:', error);
      return reply.status(500).send({ error: String(error) });
    }
  });

  // GET /api/projects/:hash/orphans - Orphaned tasks
  app.get('/:hash/orphans', async (request, reply) => {
    const { hash } = request.params as { hash: string };

    try {
      const projects = await dataService.getAllProjects();
      const project = projects.find((p: any) => p.hash === hash);

      if (!project) {
        return reply.status(404).send({ error: 'Project not found' });
      }

      const orphans = await dataService.getOrphans(project.path);
      return { orphans, count: orphans.length };
    } catch (error) {
      console.error('Orphans error:', error);
      return reply.status(500).send({ error: String(error) });
    }
  });

  // GET /api/projects/:hash/stale?days=30 - Stale tasks
  app.get('/:hash/stale', async (request, reply) => {
    const { hash } = request.params as { hash: string };
    const { days = '30' } = request.query as { days?: string };

    try {
      const projects = await dataService.getAllProjects();
      const project = projects.find((p: any) => p.hash === hash);

      if (!project) {
        return reply.status(404).send({ error: 'Project not found' });
      }

      const staleTasks = await dataService.getStaleTasks(project.path, parseInt(days));
      return { 
        staleTasks, 
        count: staleTasks.length,
        threshold: `${days} days`
      };
    } catch (error) {
      console.error('Stale tasks error:', error);
      return reply.status(500).send({ error: String(error) });
    }
  });
}
