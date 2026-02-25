# Scheduled Jobs (Cron)

Railway cron jobs run services on a schedule using standard cron expressions.

## When to Use Cron

**Good use cases:**
- Periodic data processing
- Scheduled reports
- Cleanup tasks
- Backup operations
- Monitoring checks
- ETL jobs

**Not suitable for:**
- Real-time processing
- User-triggered actions
- Long-running continuous tasks
- Jobs requiring sub-minute precision

## Cron Expression Format

Standard 5-field cron format:
```
* * * * *
│ │ │ │ │
│ │ │ │ └─── Day of week (0-7, 0/7 = Sunday)
│ │ │ └───── Month (1-12)
│ │ └─────── Day of month (1-31)
│ └───────── Hour (0-23)
└─────────── Minute (0-59)
```

### Common Patterns

| Expression | Meaning |
|------------|---------|
| `0 * * * *` | Every hour at minute 0 |
| `0 0 * * *` | Daily at midnight |
| `0 0 * * 0` | Weekly on Sunday at midnight |
| `0 0 1 * *` | Monthly on 1st at midnight |
| `*/5 * * * *` | Every 5 minutes |
| `0 9 * * 1-5` | Weekdays at 9 AM |
| `0 */6 * * *` | Every 6 hours |

### Special Characters

| Char | Meaning | Example |
|------|---------|---------|
| `*` | Any value | `* * * * *` = every minute |
| `,` | List | `0 0,12 * * *` = midnight and noon |
| `-` | Range | `0 9-17 * * 1-5` = 9-5 weekdays |
| `/` | Step | `*/15 * * * *` = every 15 minutes |

## Creating Cron Services

### Via Environment Config

```json
{
  "services": {
    "nightly-cleanup": {
      "deploy": {
        "cronSchedule": "0 2 * * *"
      }
    }
  }
}
```

### Via CLI

Currently, cron schedules must be set via environment configuration or dashboard.

## Cron Service Structure

### One-Shot Jobs

Job exits after completing work:

```javascript
// cleanup-job.js
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function cleanup() {
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  
  const deleted = await prisma.session.deleteMany({
    where: {
      createdAt: {
        lt: thirtyDaysAgo
      }
    }
  });
  
  console.log(`Deleted ${deleted.count} old sessions`);
  process.exit(0);
}

cleanup().catch(err => {
  console.error('Cleanup failed:', err);
  process.exit(1);
});
```

### Continuous with Cron Trigger

Service runs continuously, cron triggers specific action:

```python
# monitor.py
import os
import time
from datetime import datetime

def check_system_health():
    # Run health checks
    print(f"[{datetime.now()}] Running health checks...")
    # ... health check logic
    return True

if __name__ == "__main__":
    # For cron-triggered runs
    if os.environ.get('CRON_TRIGGER') == 'true':
        check_system_health()
        exit(0)
    
    # For continuous monitoring
    while True:
        check_system_health()
        time.sleep(60)  # Check every minute
```

**Cron config:**
```json
{
  "services": {
    "monitor": {
      "variables": {
        "CRON_TRIGGER": {"value": "true"}
      },
      "deploy": {
        "cronSchedule": "0 */6 * * *"
      }
    }
  }
}
```

## Use Cases

### 1. Database Cleanup

**Schedule:** Daily at 2 AM

```json
{
  "services": {
    "cleanup": {
      "source": {
        "repo": "myorg/backend",
        "branch": "main"
      },
      "build": {
        "buildCommand": "npm install"
      },
      "deploy": {
        "startCommand": "node jobs/cleanup.js",
        "cronSchedule": "0 2 * * *"
      }
    }
  }
}
```

### 2. Daily Report Generation

**Schedule:** Weekdays at 9 AM

```json
{
  "services": {
    "reports": {
      "source": {
        "repo": "myorg/backend"
      },
      "variables": {
        "DATABASE_URL": {"value": "${{Postgres.DATABASE_URL}}"}
      },
      "deploy": {
        "startCommand": "python jobs/generate_reports.py",
        "cronSchedule": "0 9 * * 1-5"
      }
    }
  }
}
```

### 3. Hourly Data Sync

**Schedule:** Every hour

```json
{
  "services": {
    "sync": {
      "source": {
        "repo": "myorg/integrations"
      },
      "variables": {
        "API_KEY": {"value": "secret", "encrypted": true}
      },
      "deploy": {
        "startCommand": "node jobs/sync-external-api.js",
        "cronSchedule": "0 * * * *"
      }
    }
  }
}
```

### 4. Weekly Backup

**Schedule:** Sundays at midnight

```json
{
  "services": {
    "backup": {
      "volumes": {
        "backups": {
          "mountPath": "/backups"
        }
      },
      "variables": {
        "DATABASE_URL": {"value": "${{Postgres.DATABASE_URL}}"},
        "BACKUP_DIR": {"value": "/backups"}
      },
      "deploy": {
        "startCommand": "bash scripts/backup-db.sh",
        "cronSchedule": "0 0 * * 0"
      }
    }
  }
}
```

**backup-db.sh:**
```bash
#!/bin/bash
DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="$BACKUP_DIR/backup_$DATE.sql"

pg_dump "$DATABASE_URL" > "$BACKUP_FILE"
gzip "$BACKUP_FILE"

echo "Backup complete: $BACKUP_FILE.gz"
```

## Monitoring Cron Jobs

### View Execution History

```bash
# List deployments
railway deployment list --service my-cron-job

# View logs
railway logs --service my-cron-job --lines 100
```

### Success/Failure Handling

**Exit codes matter:**
- `0` = Success
- Non-zero = Failure

**Notification on failure:**
```javascript
// In your job
async function main() {
  try {
    await runJob();
    console.log('Job completed successfully');
    process.exit(0);
  } catch (error) {
    console.error('Job failed:', error);
    await sendAlert(error); // Send to Slack/email
    process.exit(1);
  }
}
```

## Best Practices

### 1. Idempotency

Cron jobs should be safe to run multiple times:

```python
# Good - checks before acting
def process_orders():
    orders = get_pending_orders()
    for order in orders:
        if not order.processed:
            process_order(order)
            mark_processed(order)

# Bad - might process twice
def process_orders():
    orders = get_orders()
    for order in orders:
        process_order(order)  # No check!
```

### 2. Timeouts

Prevent hanging jobs:

```json
{
  "services": {
    "job": {
      "deploy": {
        "healthcheck": {
          "enabled": false  # Don't use for one-shot jobs
        }
      }
    }
  }
}
```

**In code:**
```javascript
// Set timeout
const TIMEOUT = 5 * 60 * 1000; // 5 minutes
setTimeout(() => {
  console.error('Job timeout');
  process.exit(1);
}, TIMEOUT);
```

### 3. Logging

Always log start, end, and key events:

```javascript
console.log(`[${new Date().toISOString()}] Job starting`);
console.log(`[${new Date().toISOString()}] Processing ${items.length} items`);
console.log(`[${new Date().toISOString()}] Job completed: ${results.success} success, ${results.failed} failed`);
```

### 4. Resource Limits

Consider resource usage:
- Don't schedule too many concurrent jobs
- Memory-intensive jobs may need limits
- CPU usage affects billing

### 5. Error Recovery

```python
import time
from datetime import datetime

def run_with_retry(func, max_retries=3):
    for attempt in range(max_retries):
        try:
            return func()
        except Exception as e:
            print(f"Attempt {attempt + 1} failed: {e}")
            if attempt < max_retries - 1:
                time.sleep(5 * (attempt + 1))  # Exponential backoff
            else:
                raise

# Use it
try:
    result = run_with_retry(process_data)
    print(f"Success: {result}")
except Exception as e:
    print(f"Failed after retries: {e}")
    exit(1)
```

## Troubleshooting

### Job Not Running

**Check:**
1. Cron expression is valid
2. Service has cronSchedule configured
3. No overlapping executions blocking
4. Check deployment list for last run

**Debug:**
```bash
# Check last deployment
railway deployment list --service my-job --limit 5

# View logs
railway logs --service my-job --lines 200
```

### Job Running Too Often

**Common mistakes:**
- `* * * * *` = every minute (probably too frequent)
- `*/1 * * * *` = every minute
- `0 0 * * *` = daily at midnight

**Verify expression:**
```bash
# Use online cron parser
echo "0 2 * * *" | python3 -c "
import sys
import croniter
from datetime import datetime

cron = sys.stdin.read().strip()
itr = croniter.croniter(cron, datetime.now())
print('Next 5 runs:')
for _ in range(5):
    print(itr.get_next(datetime))
"
```

### Job Failing Silently

**Ensure proper logging:**
```javascript
// Always log to stdout/stderr
console.log = (...args) => {
  process.stdout.write(`[${new Date().toISOString()}] ${args.join(' ')}\n`);
};

console.error = (...args) => {
  process.stderr.write(`[${new Date().toISOString()}] ERROR: ${args.join(' ')}\n`);
};
```

### Long-Running Jobs

**Issue:** Job exceeds cron interval

**Solution:**
1. Extend interval
2. Implement locking to prevent overlap
3. Break into smaller jobs

```python
# Simple lock implementation
import redis
import os

redis_client = redis.from_url(os.environ['REDIS_URL'])

def with_lock(job_name, func):
    lock_key = f"cron_lock:{job_name}"
    
    # Try to acquire lock (expires in 1 hour)
    acquired = redis_client.set(lock_key, "1", nx=True, ex=3600)
    
    if not acquired:
        print(f"Job {job_name} already running, skipping")
        return
    
    try:
        func()
    finally:
        redis_client.delete(lock_key)
```

## Summary

| Aspect | Details |
|--------|---------|
| **Format** | Standard 5-field cron |
| **Precision** | Minute-level |
| **Concurrency** | No overlapping by default |
| **Timeout** | Service-level limits apply |
| **Monitoring** | Via deployment logs |
| **Cost** | Billed for execution time |

**Golden rule:** Cron jobs should be simple, idempotent, and well-logged. For complex workflows, consider using a job queue instead.
