-- Phase 3.5: Codified agent metadata — capability and skill registries
-- with junction tables for typed many-to-many relationships.

CREATE TABLE IF NOT EXISTS capabilities (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    category TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS skills (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    category TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_capabilities (
    agent_id TEXT NOT NULL REFERENCES agents(id),
    capability_id TEXT NOT NULL REFERENCES capabilities(id),
    PRIMARY KEY (agent_id, capability_id)
);

CREATE TABLE IF NOT EXISTS agent_skills (
    agent_id TEXT NOT NULL REFERENCES agents(id),
    skill_id TEXT NOT NULL REFERENCES skills(id),
    PRIMARY KEY (agent_id, skill_id)
);

-- Seed: 19 capabilities
INSERT OR IGNORE INTO capabilities (id, slug, name, description, category, created_at) VALUES
('cap_chat', 'chat', 'Chat', 'Conversational message exchange', 'communication', strftime('%s','now')),
('cap_tools', 'tools', 'Tool Use', 'Can invoke external tools and APIs', 'execution', strftime('%s','now')),
('cap_code_gen', 'code_generation', 'Code Generation', 'Can write and generate source code', 'development', strftime('%s','now')),
('cap_code_review', 'code_review', 'Code Review', 'Can review and critique code', 'development', strftime('%s','now')),
('cap_search', 'search', 'Search', 'Can search and discover information', 'analysis', strftime('%s','now')),
('cap_orchestration', 'orchestration', 'Orchestration', 'Can coordinate and delegate to other agents', 'coordination', strftime('%s','now')),
('cap_messaging', 'messaging', 'Messaging', 'Can send/receive structured messages', 'communication', strftime('%s','now')),
('cap_streaming', 'streaming', 'Streaming', 'Supports SSE/streaming connections', 'communication', strftime('%s','now')),
('cap_webhooks', 'webhooks', 'Webhooks', 'Can receive webhook deliveries', 'communication', strftime('%s','now')),
('cap_file_ops', 'file_operations', 'File Operations', 'Can read/write files on the filesystem', 'execution', strftime('%s','now')),
('cap_web_browse', 'web_browsing', 'Web Browsing', 'Can browse and extract web content', 'analysis', strftime('%s','now')),
('cap_reasoning', 'reasoning', 'Reasoning', 'Multi-step logical reasoning', 'analysis', strftime('%s','now')),
('cap_automation', 'automation', 'Automation', 'Can automate repetitive tasks', 'execution', strftime('%s','now')),
('cap_testing', 'testing', 'Testing', 'Can write and execute tests', 'development', strftime('%s','now')),
('cap_git', 'git', 'Git Operations', 'Can perform git operations', 'development', strftime('%s','now')),
('cap_deploy', 'deployment', 'Deployment', 'Can deploy services and infrastructure', 'devops', strftime('%s','now')),
('cap_monitoring', 'monitoring', 'Monitoring', 'Can monitor systems and services', 'devops', strftime('%s','now')),
('cap_file_upload', 'file_upload', 'File Upload', 'Can upload and attach files', 'execution', strftime('%s','now')),
('cap_autonomous', 'autonomous', 'Autonomous', 'Can run autonomously with polling', 'execution', strftime('%s','now'));

-- Seed: 35 skills
INSERT OR IGNORE INTO skills (id, slug, name, description, category, created_at) VALUES
-- Languages
('skl_typescript', 'typescript', 'TypeScript', 'TypeScript language proficiency', 'language', strftime('%s','now')),
('skl_javascript', 'javascript', 'JavaScript', 'JavaScript language proficiency', 'language', strftime('%s','now')),
('skl_python', 'python', 'Python', 'Python language proficiency', 'language', strftime('%s','now')),
('skl_rust', 'rust', 'Rust', 'Rust language proficiency', 'language', strftime('%s','now')),
('skl_go', 'go', 'Go', 'Go language proficiency', 'language', strftime('%s','now')),
('skl_java', 'java', 'Java', 'Java language proficiency', 'language', strftime('%s','now')),
('skl_csharp', 'csharp', 'C#', 'C# language proficiency', 'language', strftime('%s','now')),
('skl_sql', 'sql', 'SQL', 'SQL query proficiency', 'language', strftime('%s','now')),
('skl_bash', 'bash', 'Bash', 'Shell scripting proficiency', 'language', strftime('%s','now')),
-- Frameworks
('skl_react', 'react', 'React', 'React framework proficiency', 'framework', strftime('%s','now')),
('skl_nextjs', 'nextjs', 'Next.js', 'Next.js framework proficiency', 'framework', strftime('%s','now')),
('skl_svelte', 'svelte', 'Svelte', 'Svelte framework proficiency', 'framework', strftime('%s','now')),
('skl_express', 'express', 'Express', 'Express.js framework proficiency', 'framework', strftime('%s','now')),
('skl_axum', 'axum', 'Axum', 'Axum web framework proficiency', 'framework', strftime('%s','now')),
('skl_django', 'django', 'Django', 'Django framework proficiency', 'framework', strftime('%s','now')),
('skl_electron', 'electron', 'Electron', 'Electron framework proficiency', 'framework', strftime('%s','now')),
-- Databases
('skl_sqlite', 'sqlite', 'SQLite', 'SQLite database proficiency', 'database', strftime('%s','now')),
('skl_postgres', 'postgres', 'PostgreSQL', 'PostgreSQL database proficiency', 'database', strftime('%s','now')),
('skl_redis', 'redis', 'Redis', 'Redis proficiency', 'database', strftime('%s','now')),
('skl_drizzle_orm', 'drizzle_orm', 'Drizzle ORM', 'Drizzle ORM proficiency', 'database', strftime('%s','now')),
('skl_diesel', 'diesel', 'Diesel', 'Diesel ORM proficiency', 'database', strftime('%s','now')),
-- Practices
('skl_api_design', 'api_design', 'API Design', 'REST/GraphQL API design expertise', 'practice', strftime('%s','now')),
('skl_testing', 'testing', 'Testing', 'Software testing expertise', 'practice', strftime('%s','now')),
('skl_devops', 'devops', 'DevOps', 'CI/CD and infrastructure expertise', 'practice', strftime('%s','now')),
('skl_security', 'security', 'Security', 'Application security expertise', 'practice', strftime('%s','now')),
('skl_architecture', 'architecture', 'Architecture', 'System architecture expertise', 'practice', strftime('%s','now')),
('skl_documentation', 'documentation', 'Documentation', 'Technical writing expertise', 'practice', strftime('%s','now')),
('skl_code_review', 'code_review', 'Code Review', 'Code review expertise', 'practice', strftime('%s','now')),
('skl_debugging', 'debugging', 'Debugging', 'Debugging and troubleshooting expertise', 'practice', strftime('%s','now')),
('skl_sse', 'sse', 'SSE', 'Server-Sent Events expertise', 'practice', strftime('%s','now')),
('skl_webhooks', 'webhooks', 'Webhooks', 'Webhook design and handling', 'practice', strftime('%s','now')),
('skl_orchestration', 'orchestration', 'Orchestration', 'Multi-agent orchestration expertise', 'practice', strftime('%s','now')),
('skl_task_mgmt', 'task_management', 'Task Management', 'Task and project management', 'practice', strftime('%s','now')),
('skl_research', 'research', 'Research', 'Information research expertise', 'practice', strftime('%s','now')),
('skl_web_dev', 'web_development', 'Web Development', 'Full-stack web development', 'practice', strftime('%s','now')),
('skl_monorepo', 'monorepo', 'Monorepo', 'Monorepo management expertise', 'practice', strftime('%s','now'));
