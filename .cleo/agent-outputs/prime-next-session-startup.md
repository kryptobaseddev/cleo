# PRIME Session Startup — 2026-04-02

## Identity
You are **cleo-prime** — the PRIME Orchestrator for CleoCode. Your primary channel is **api.signaldock.io**.
Legacy ID `cleoos-opus-orchestrator` on ClawMsgr is backup only.

## First: Connect to SignalDock
```bash
# 1. Check SignalDock messages
python3 ~/.claude/skills/clawmsgr/scripts/clawmsgr-worker.py once --agent cleo-prime

# 2. Check ClawMsgr backup
python3 ~/.claude/skills/clawmsgr/scripts/clawmsgr-worker.py once --agent cleoos-opus-orchestrator

# 3. Message cleobot (SUPREME agent — operator's representative, outranks you)
curl -s -X POST "https://api.signaldock.io/messages" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(python3 -c "import json; print(json.load(open('.cleo/clawmsgr-cleoos-prime.json'))['apiKey'])")" \
  -H "X-Agent-Id: cleo-prime" \
  -d '{"content":"cleo-prime online. New session started. Requesting status update.","toAgentId":"cleobot"}'
```

## What Was Shipped This Session (T222 Progress)

### cleocode repo (pushed to GitHub: d79fbe46)
- **signaldock-storage dual-backend Diesel adapters**: All 7 repository trait impls macro-generated for both SqliteConn and PgConn
- AgentRepository::list() rewritten from raw SQL to boxed Diesel DSL
- PostgreSQL DieselStore::postgres() constructor with embedded migration runner
- FTS5 search (SQLite) / ILIKE search (PostgreSQL) with backend-specific SQL
- Type aliases: SqliteStore, PgStore, SqliteConn, PgConn
- Backward-compat module: signaldock_storage::adapters::sqlite::SqliteStore

### signaldock-core repo (committed locally: a68a3b7, NOT pushed)
- Feature-gated Store type: cfg(feature = "sqlite-backend") vs cfg(not(...))
- AppState gains sqlx_pool for 71 raw sqlx queries in route handlers
- Dockerfile supports ENABLE_SQLITE=true/false build arg
- BETTER_AUTH_DB_URL fallback for PostgreSQL deployments
- Cargo feature collision fix (sqlite/postgres names collide with sqlx features)
- 22 files changed, 697 insertions

## What's Remaining for T222

### 1. Push signaldock-core to GitHub
```bash
cd /mnt/projects/signaldock-core && git push origin main
```

### 2. Railway PostgreSQL Deployment
```bash
# Add PostgreSQL database to Railway project
railway add --database postgres

# Set environment variables
railway variables set DATABASE_URL="<postgres connection string>"
railway variables set ENABLE_SQLITE=false
railway variables set BETTER_AUTH_DB_URL="sqlite:///app/data/auth.db"

# Trigger redeploy
railway up
```

### 3. Known Limitations
- **better-auth** still uses SQLite (DieselSqliteAdapter). No PG adapter exists yet.
  For PG deploys, BETTER_AUTH_DB_URL falls back to local SQLite file.
  Follow-up: create better-auth-diesel-pg adapter.
- **71 raw sqlx queries** in route handlers use separate sqlx pool (not Diesel).
  Follow-up: migrate to Diesel DSL incrementally.
- **Cargo feature collision**: NEVER name features `sqlite` or `postgres` when sqlx dep has same.
  Use `sqlite-backend` and `cfg(not(feature = "sqlite-backend"))` for PG.

## Also Pending (not T222)
- T255: CLEO Daemon — big missing piece, no progress this session
- @cleocode/cant npm propagation issue
- CANT v2 ProseBlock parser
- Smart Explore (T147 epic)

## Hierarchy
- **cleobot** outranks cleo-prime. They are the operator's representative.
- Communicate with cleobot via signaldock.io for operator coordination.
- NEVER contact the human owner directly — escalate to cleobot.

## Rules
- SignalDock is primary. ClawMsgr is backup only.
- Database separation: each DB owns ONE domain. No cross-domain data.
- Greenfield: NO backwards compatibility.
- Local-first: everything must work offline.

## Configs
- SignalDock: `.cleo/clawmsgr-cleoos-prime.json`
- ClawMsgr backup: `.cleo/clawmsgr-cleoos-opus-orchestrator.json`
