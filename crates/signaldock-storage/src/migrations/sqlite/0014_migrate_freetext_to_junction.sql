-- Phase 3.5 Part 2: Migrate existing freetext capabilities/skills to junction tables.
-- Maps known freetext values to canonical registry slugs, then populates
-- agent_capabilities and agent_skills junction tables.

-- Freetext → capability slug mapping (covers all known variants)
-- Each agent's JSON array is parsed via json_each, matched to a slug,
-- and inserted into the junction table.

INSERT OR IGNORE INTO agent_capabilities (agent_id, capability_id)
SELECT a.id, c.id
FROM agents a, json_each(a.capabilities) AS je
JOIN capabilities c ON c.slug = (
    CASE LOWER(TRIM(je.value, '"'))
        WHEN 'chat' THEN 'chat'
        WHEN 'conversation' THEN 'chat'
        WHEN 'conversations' THEN 'chat'
        WHEN 'messaging' THEN 'messaging'
        WHEN 'tools' THEN 'tools'
        WHEN 'tool_use' THEN 'tools'
        WHEN 'tool-use' THEN 'tools'
        WHEN 'code' THEN 'code_generation'
        WHEN 'coding' THEN 'code_generation'
        WHEN 'code_generation' THEN 'code_generation'
        WHEN 'code-generation' THEN 'code_generation'
        WHEN 'code_gen' THEN 'code_generation'
        WHEN 'code_review' THEN 'code_review'
        WHEN 'code-review' THEN 'code_review'
        WHEN 'search' THEN 'search'
        WHEN 'web_search' THEN 'search'
        WHEN 'orchestration' THEN 'orchestration'
        WHEN 'streaming' THEN 'streaming'
        WHEN 'sse' THEN 'streaming'
        WHEN 'webhooks' THEN 'webhooks'
        WHEN 'webhook' THEN 'webhooks'
        WHEN 'file_operations' THEN 'file_operations'
        WHEN 'file_ops' THEN 'file_operations'
        WHEN 'file-operations' THEN 'file_operations'
        WHEN 'web_browsing' THEN 'web_browsing'
        WHEN 'web-browsing' THEN 'web_browsing'
        WHEN 'browsing' THEN 'web_browsing'
        WHEN 'reasoning' THEN 'reasoning'
        WHEN 'automation' THEN 'automation'
        WHEN 'testing' THEN 'testing'
        WHEN 'git' THEN 'git'
        WHEN 'deployment' THEN 'deployment'
        WHEN 'deploy' THEN 'deployment'
        WHEN 'monitoring' THEN 'monitoring'
        WHEN 'file_upload' THEN 'file_upload'
        WHEN 'file-upload' THEN 'file_upload'
        WHEN 'autonomous' THEN 'autonomous'
        ELSE LOWER(TRIM(je.value, '"'))
    END
);

INSERT OR IGNORE INTO agent_skills (agent_id, skill_id)
SELECT a.id, s.id
FROM agents a, json_each(a.skills) AS je
JOIN skills s ON s.slug = (
    CASE LOWER(TRIM(je.value, '"'))
        WHEN 'coding' THEN 'typescript'
        WHEN 'typescript' THEN 'typescript'
        WHEN 'javascript' THEN 'javascript'
        WHEN 'python' THEN 'python'
        WHEN 'rust' THEN 'rust'
        WHEN 'go' THEN 'go'
        WHEN 'java' THEN 'java'
        WHEN 'csharp' THEN 'csharp'
        WHEN 'c#' THEN 'csharp'
        WHEN 'sql' THEN 'sql'
        WHEN 'bash' THEN 'bash'
        WHEN 'shell' THEN 'bash'
        WHEN 'react' THEN 'react'
        WHEN 'nextjs' THEN 'nextjs'
        WHEN 'next.js' THEN 'nextjs'
        WHEN 'next' THEN 'nextjs'
        WHEN 'svelte' THEN 'svelte'
        WHEN 'express' THEN 'express'
        WHEN 'axum' THEN 'axum'
        WHEN 'django' THEN 'django'
        WHEN 'electron' THEN 'electron'
        WHEN 'sqlite' THEN 'sqlite'
        WHEN 'postgres' THEN 'postgres'
        WHEN 'postgresql' THEN 'postgres'
        WHEN 'redis' THEN 'redis'
        WHEN 'drizzle' THEN 'drizzle_orm'
        WHEN 'drizzle_orm' THEN 'drizzle_orm'
        WHEN 'drizzle-orm' THEN 'drizzle_orm'
        WHEN 'diesel' THEN 'diesel'
        WHEN 'api_design' THEN 'api_design'
        WHEN 'api-design' THEN 'api_design'
        WHEN 'api' THEN 'api_design'
        WHEN 'testing' THEN 'testing'
        WHEN 'devops' THEN 'devops'
        WHEN 'security' THEN 'security'
        WHEN 'architecture' THEN 'architecture'
        WHEN 'documentation' THEN 'documentation'
        WHEN 'docs' THEN 'documentation'
        WHEN 'code_review' THEN 'code_review'
        WHEN 'code-review' THEN 'code_review'
        WHEN 'debugging' THEN 'debugging'
        WHEN 'sse' THEN 'sse'
        WHEN 'webhooks' THEN 'webhooks'
        WHEN 'webhook' THEN 'webhooks'
        WHEN 'orchestration' THEN 'orchestration'
        WHEN 'task_management' THEN 'task_management'
        WHEN 'task-management' THEN 'task_management'
        WHEN 'research' THEN 'research'
        WHEN 'web_development' THEN 'web_development'
        WHEN 'web-development' THEN 'web_development'
        WHEN 'web-dev' THEN 'web_development'
        WHEN 'monorepo' THEN 'monorepo'
        WHEN 'messaging-systems' THEN 'architecture'
        ELSE LOWER(TRIM(je.value, '"'))
    END
);
