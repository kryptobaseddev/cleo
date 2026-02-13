import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { CLIExecutor } from '../../lib/executor.js';

const executor = new CLIExecutor('cleo');
const CLEO_HOME = path.join(os.homedir(), '.cleo');

export interface ProjectRegistryEntry {
  hash: string;
  name: string;
  path: string;
  registeredAt: string;
  lastSeen: string;
  healthStatus?: string;
  healthLastCheck?: string;
  permissions?: string;
  taskCount?: number;
  labels?: string[];
  lastSync?: string;
}

export interface GlobalStats {
  totalProjects: number;
  totalTasks: number;
  pendingTasks: number;
  activeTasks: number;
  blockedTasks: number;
  completedTasks: number;
  archivedTasks: number;
  orphanedTasks: number;
  staleTasks: number;
}

export class DataService {
  /**
   * Get all registered projects from ~/.cleo/projects-registry.json
   */
  async getAllProjects(): Promise<ProjectRegistryEntry[]> {
    try {
      const registryPath = path.join(CLEO_HOME, 'projects-registry.json');
      const data = await fs.readFile(registryPath, 'utf-8');
      const registry = JSON.parse(data);
      
      return Object.values(registry.projects || {}).map((p: any) => ({
        hash: p.hash,
        name: p.name,
        path: p.path,
        registeredAt: p.registeredAt,
        lastSeen: p.lastSeen,
        healthStatus: p.healthStatus || 'unknown',
        healthLastCheck: p.healthLastCheck,
        permissions: p.permissions || 'read',
        taskCount: p.taskCount,
        labels: p.labels || [],
        lastSync: p.lastSync
      }));
    } catch (error) {
      console.error('Failed to read projects registry:', error);
      return [];
    }
  }

  /**
   * Get top N active projects by task count
   */
  async getTopActiveProjects(limit: number = 3): Promise<ProjectRegistryEntry[]> {
    const projects = await this.getAllProjects();
    
    // Sort by taskCount (descending), then by lastSeen (descending)
    return projects
      .filter((p: ProjectRegistryEntry) => (p.taskCount || 0) > 0)
      .sort((a: ProjectRegistryEntry, b: ProjectRegistryEntry) => {
        const countDiff = (b.taskCount || 0) - (a.taskCount || 0);
        if (countDiff !== 0) return countDiff;
        return new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime();
      })
      .slice(0, limit);
  }

  /**
   * Get global stats across all projects using Nexus
   */
  async getGlobalStats(): Promise<GlobalStats> {
    const projects = await this.getAllProjects();
    
    // Aggregate stats from all projects
    let totalTasks = 0;
    let pendingTasks = 0;
    let activeTasks = 0;
    let blockedTasks = 0;
    let completedTasks = 0;
    
    for (const project of projects) {
      if (project.taskCount) {
        totalTasks += project.taskCount;
      }
      
      // Try to get detailed stats for each project
      try {
        const stats = await this.getProjectStats(project.path);
        if (stats?.current_state) {
          pendingTasks += stats.current_state.pending || 0;
          activeTasks += stats.current_state.in_progress || 0;
          completedTasks += stats.current_state.completed || 0;
        }
      } catch (e) {
        // Skip projects we can't read
      }
    }
    
    return {
      totalProjects: projects.length,
      totalTasks,
      pendingTasks,
      activeTasks,
      blockedTasks,
      completedTasks,
      archivedTasks: 0, // TODO: Sum from all projects
      orphanedTasks: 0, // TODO: Calculate
      staleTasks: 0     // TODO: Calculate
    };
  }

  /**
   * Search tasks across all projects using nexus search
   */
  async searchTasks(query: string, options: { project?: string; limit?: number; status?: string } = {}): Promise<any[]> {
    try {
      const flags: Record<string, unknown> = { format: 'json' };
      if (options.project) flags.project = options.project;
      if (options.limit) flags.limit = options.limit;
      if (options.status) flags.status = options.status;

      // Get projects list to enrich results
      const projects = await this.getAllProjects();
      const projectMap = new Map(projects.map(p => [p.name, p]));
      const hashMap = new Map(projects.map(p => [p.hash, p]));

      const result = await executor.execute({
        domain: 'nexus',
        operation: 'search',
        args: [query],
        flags
      });

      if (result.success && result.data) {
        const data = result.data as any;
        const results = data.results || data || [];
        
        // Enrich results with project info
        return results.map((r: any) => {
          // Nexus search returns _project field
          const projectNameFromResult = r._project || r.projectName || r.project;
          
          // Try to find project by various fields
          let project = null;
          if (projectNameFromResult) {
            project = projectMap.get(projectNameFromResult);
          } else if (options.project) {
            project = projectMap.get(options.project);
          }
          
          // If still no project, try to match by task ID prefix or path
          if (!project && r.path) {
            project = projects.find(p => r.path.startsWith(p.path));
          }
          
          return {
            ...r,
            projectName: project?.name || projectNameFromResult || options.project || 'Unknown',
            projectHash: project?.hash || r.projectHash,
            projectPath: project?.path || r.path
          };
        });
      }
      return [];
    } catch (error) {
      console.error('Search error:', error);
      return [];
    }
  }

  /**
   * Discover related tasks across projects
   */
  async discoverRelated(taskId: string, options: { method?: string; limit?: number } = {}): Promise<any[]> {
    try {
      const flags: Record<string, unknown> = { format: 'json' };
      if (options.method) flags.method = options.method;
      if (options.limit) flags.limit = options.limit;

      const result = await executor.execute({
        domain: 'nexus',
        operation: 'discover',
        args: [taskId],
        flags
      });

      if (result.success && result.data) {
        const data = result.data as any;
        return Array.isArray(data) ? data : (data.results || []);
      }
      return [];
    } catch (error) {
      console.error('Discover error:', error);
      return [];
    }
  }

  /**
   * Get Nexus dependencies for a task
   */
  async getNexusDeps(taskId: string, reverse: boolean = false): Promise<any> {
    try {
      const flags: Record<string, unknown> = { format: 'json' };
      if (reverse) flags.reverse = true;

      const result = await executor.execute({
        domain: 'nexus',
        operation: 'deps',
        args: [taskId],
        flags
      });

      return result.success ? result.data : null;
    } catch (error) {
      console.error('Nexus deps error:', error);
      return null;
    }
  }

  /**
   * Get detailed stats for a specific project
   */
  async getProjectStats(projectPath: string): Promise<any> {
    try {
      const result = await executor.execute({
        domain: 'system',
        operation: 'stats',
        flags: { format: 'json' },
        cwd: projectPath
      });

      return result.success ? result.data : null;
    } catch (error) {
      console.error('Failed to get project stats:', error);
      return null;
    }
  }

  /**
   * Get all tasks from a project with pagination
   */
  async getProjectTasks(projectPath: string, options: { limit?: number; offset?: number } = {}): Promise<{ tasks: any[]; total: number; hasMore: boolean }> {
    try {
      const flags: Record<string, unknown> = { format: 'json' };
      if (options.limit) flags.limit = options.limit;
      if (options.offset) flags.offset = options.offset;

      const result = await executor.execute({
        domain: 'tasks',
        operation: 'list',
        flags,
        cwd: projectPath
      });

      if (result.success && result.data) {
        const data = result.data as any;
        const tasks = Array.isArray(data) ? data : (data.tasks || []);
        const total = data.total || tasks.length;
        const hasMore = options.offset !== undefined && options.limit !== undefined 
          ? (options.offset + tasks.length) < total 
          : false;
        
        return { tasks, total, hasMore };
      }
      return { tasks: [], total: 0, hasMore: false };
    } catch (error) {
      console.error('Failed to get project tasks:', error);
      return { tasks: [], total: 0, hasMore: false };
    }
  }

  /**
   * Get task hierarchy (epics, tasks, subtasks)
   */
  async getTaskHierarchy(projectPath: string): Promise<any> {
    try {
      const { tasks } = await this.getProjectTasks(projectPath);
      
      // Build hierarchy
      const epics = tasks.filter((t: any) => t.type === 'epic');
      const regularTasks = tasks.filter((t: any) => t.type === 'task');
      const subtasks = tasks.filter((t: any) => t.type === 'subtask');

      // Group by parent
      const hierarchy = epics.map((epic: any) => ({
        ...epic,
        children: regularTasks
          .filter((t: any) => t.parentId === epic.id)
          .map((task: any) => ({
            ...task,
            children: subtasks.filter((s: any) => s.parentId === task.id)
          }))
      }));

      // Add orphaned tasks (no parent)
      const orphaned = regularTasks.filter((t: any) => !t.parentId);

      return {
        epics: hierarchy,
        orphaned,
        stats: {
          total: tasks.length,
          epics: epics.length,
          tasks: regularTasks.length,
          subtasks: subtasks.length,
          orphaned: orphaned.length
        }
      };
    } catch (error) {
      console.error('Failed to get task hierarchy:', error);
      return { epics: [], orphaned: [], stats: {} };
    }
  }

  /**
   * Get orphans (tasks without parents when they should have one)
   */
  async getOrphans(projectPath: string): Promise<any[]> {
    const { tasks } = await this.getProjectTasks(projectPath);
    
    // Tasks that claim to have a parent but parent doesn't exist
    const orphans = tasks.filter((task: any) => {
      if (!task.parentId) return false;
      return !tasks.some((t: any) => t.id === task.parentId);
    });

    return orphans;
  }

  /**
   * Get stale tasks (inactive for X days)
   */
  async getStaleTasks(projectPath: string, days: number = 30): Promise<any[]> {
    const { tasks } = await this.getProjectTasks(projectPath);
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);

    return tasks.filter((task: any) => {
      if (task.status === 'completed' || task.status === 'done') return false;
      const updatedAt = task.updatedAt ? new Date(task.updatedAt) : null;
      return updatedAt && updatedAt < cutoff;
    });
  }

  /**
   * Get task details
   */
  async getTaskDetails(projectPath: string, taskId: string): Promise<any> {
    try {
      const result = await executor.execute({
        domain: 'tasks',
        operation: 'show',
        args: [taskId],
        flags: { format: 'json' },
        cwd: projectPath
      });

      return result.success ? result.data : null;
    } catch (error) {
      console.error('Failed to get task details:', error);
      return null;
    }
  }

  /**
   * Get task dependencies
   */
  async getTaskDependencies(projectPath: string, taskId: string): Promise<any> {
    try {
      const result = await executor.execute({
        domain: 'tasks',
        operation: 'deps',
        args: [taskId],
        flags: { format: 'json' },
        cwd: projectPath
      });

      return result.success ? result.data : null;
    } catch (error) {
      console.error('Failed to get task dependencies:', error);
      return null;
    }
  }
}

export const dataService = new DataService();
