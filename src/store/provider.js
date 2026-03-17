/**
 * Store provider abstraction layer.
 *
 * Defines the StoreProvider interface backed by SQLite (ADR-006).
 * CLI and MCP engine use StoreProvider for all data access.
 *
 * @epic T4454
 * @task W1-T6
 */
import { getAccessor } from './data-accessor.js';
/**
 * Create high-level domain operation methods that delegate to core modules.
 * An accessor is created once and passed to every core call, ensuring that
 * the SQLite storage engine is used consistently.
 *
 * @task T4656
 * @epic T4654
 */
async function createDomainOps(cwd, accessor) {
    const { addTask } = await import('../core/tasks/add.js');
    const { completeTask } = await import('../core/tasks/complete.js');
    const { updateTask } = await import('../core/tasks/update.js');
    const { showTask } = await import('../core/tasks/show.js');
    const { deleteTask } = await import('../core/tasks/delete.js');
    const { findTasks } = await import('../core/tasks/find.js');
    const { listTasks } = await import('../core/tasks/list.js');
    const { archiveTasks } = await import('../core/tasks/archive.js');
    const labels = await import('../core/tasks/labels.js');
    const relates = await import('../core/tasks/relates.js');
    const { analyzeTaskPriority } = await import('../core/tasks/analyze.js');
    const sessions = await import('../core/sessions/index.js');
    const taskWork = await import('../core/task-work/index.js');
    // Resolve accessor once; all domain ops share the same instance.
    const acc = accessor ?? (await getAccessor(cwd));
    return {
        addTask: (options) => addTask(options, cwd, acc),
        completeTask: (options) => completeTask(options, cwd, acc),
        richUpdateTask: (options) => updateTask(options, cwd, acc),
        showTask: (taskId) => showTask(taskId, cwd, acc),
        richDeleteTask: (options) => deleteTask(options, cwd, acc),
        richFindTasks: (options) => findTasks(options, cwd, acc),
        richListTasks: (options) => listTasks(options, cwd, acc),
        richArchiveTasks: (options) => archiveTasks(options, cwd, acc),
        listLabels: () => labels.listLabels(cwd, acc),
        showLabelTasks: (label) => labels.showLabelTasks(label, cwd, acc),
        getLabelStats: () => labels.getLabelStats(cwd, acc),
        suggestRelated: (taskId, opts) => relates.suggestRelated(taskId, { ...opts, cwd }, acc),
        addRelation: (from, to, type, reason) => relates.addRelation(from, to, type, reason, cwd, acc),
        discoverRelated: (taskId) => relates.discoverRelated(taskId, cwd, acc),
        listRelations: (taskId) => relates.listRelations(taskId, cwd, acc),
        analyzeTaskPriority: (opts) => analyzeTaskPriority({ ...opts, cwd }, acc),
        startSession: (options) => sessions.startSession(options, cwd, acc),
        richEndSession: (options) => sessions.endSession(options, cwd, acc),
        sessionStatus: () => sessions.sessionStatus(cwd, acc),
        resumeSession: (sessionId) => sessions.resumeSession(sessionId, cwd, acc),
        richListSessions: (options) => sessions.listSessions(options, cwd, acc),
        gcSessions: (maxAgeHours) => sessions.gcSessions(maxAgeHours, cwd, acc),
        currentTask: () => taskWork.currentTask(cwd, acc),
        startTask: (taskId) => taskWork.startTask(taskId, cwd, acc),
        stopTask: () => taskWork.stopTask(cwd, acc),
        getWorkHistory: () => taskWork.getWorkHistory(cwd, acc),
    };
}
/**
 * Create a store provider. Always creates SQLite provider (ADR-006).
 * @task T4647
 */
export async function createStoreProvider(_engine, cwd) {
    return createSqliteProvider(cwd);
}
/**
 * Create a pure SQLite store provider.
 * @task T4647
 */
async function createSqliteProvider(cwd) {
    const sqliteStore = await import('./task-store.js');
    const sessionStore = await import('./session-store.js');
    const { closeDb } = await import('./sqlite.js');
    const domainOps = await createDomainOps(cwd);
    return {
        engine: 'sqlite',
        createTask: (task) => sqliteStore.createTask(task, cwd),
        getTask: (taskId) => sqliteStore.getTask(taskId, cwd),
        updateTask: (taskId, updates) => sqliteStore.updateTask(taskId, updates, cwd),
        deleteTask: (taskId) => sqliteStore.deleteTask(taskId, cwd),
        listTasks: (filters) => sqliteStore.listTasks(filters, cwd),
        findTasks: (query, limit) => sqliteStore.findTasks(query, limit, cwd),
        archiveTask: (taskId, reason) => sqliteStore.archiveTask(taskId, reason, cwd),
        createSession: (session) => sessionStore.createSession(session, cwd),
        getSession: (sessionId) => sessionStore.getSession(sessionId, cwd),
        updateSession: (sessionId, updates) => sessionStore.updateSession(sessionId, updates, cwd),
        listSessions: (filters) => sessionStore.listSessions(filters, cwd),
        endSession: (sessionId, note) => sessionStore.endSession(sessionId, note, cwd),
        startTaskOnSession: (sessionId, taskId) => sessionStore.startTask(sessionId, taskId, cwd),
        getCurrentTaskForSession: (sessionId) => sessionStore.getCurrentTask(sessionId, cwd),
        stopTaskOnSession: (sessionId) => sessionStore.stopTask(sessionId, cwd),
        close: async () => closeDb(),
        ...domainOps,
    };
}
//# sourceMappingURL=provider.js.map