# Railway Functions

Serverless functions for event-driven workloads (Beta feature).

## Overview

Railway Functions provide serverless execution for:
- HTTP endpoints
- Event triggers
- Scheduled tasks
- Background processing

## Creating Functions

### Via CLI

```bash
railway functions new my-function
```

### Function Structure

```
my-function/
├── function.toml          # Function configuration
├── handler.js             # Function code
└── package.json           # Dependencies
```

### Handler Code

```javascript
// handler.js
module.exports = async (event, context) => {
  const { method, path, body, query } = event;
  
  return {
    statusCode: 200,
    body: JSON.stringify({
      message: "Hello from Railway Functions",
      path,
      method
    })
  };
};
```

## Configuration

### function.toml

```toml
name = "my-function"
runtime = "nodejs18"

[trigger]
type = "http"
path = "/api/hello"
methods = ["GET", "POST"]

[resources]
memory = "512MB"
timeout = "30s"
```

### Environment Variables

```toml
[env]
DATABASE_URL = "${{Postgres.DATABASE_URL}}"
API_KEY = "${{shared.API_KEY}}"
```

## Deployment

### Deploy Function

```bash
railway functions push
```

### List Functions

```bash
railway functions list
```

## Triggers

### HTTP Trigger

```toml
[trigger]
type = "http"
path = "/webhook"
methods = ["POST"]
```

### Event Trigger

```toml
[trigger]
type = "event"
event = "deployment.success"
```

### Schedule Trigger

```toml
[trigger]
type = "schedule"
cron = "0 9 * * *"
```

## Use Cases

### 1. Webhook Handler

```javascript
module.exports = async (event) => {
  const { body } = event;
  
  // Process webhook payload
  await processWebhook(body);
  
  return { statusCode: 200 };
};
```

### 2. Image Processing

```javascript
const sharp = require('sharp');

module.exports = async (event) => {
  const { imageUrl } = event.body;
  
  const processed = await sharp(imageUrl)
    .resize(800, 600)
    .toBuffer();
  
  await uploadToS3(processed);
  
  return { statusCode: 200 };
};
```

### 3. Notification Service

```javascript
module.exports = async (event) => {
  const { userId, message } = event.body;
  
  await sendNotification(userId, message);
  
  return { statusCode: 200 };
};
```

## Limitations

- **Beta feature** - API may change
- **Cold starts** - First invocation may have latency
- **Execution timeout** - Configurable, default 30s
- **Memory limits** - Configurable, default 512MB

## Next Steps

- [10-cron.md](10-cron.md) - Scheduled jobs
- [13-troubleshooting.md](13-troubleshooting.md) - Function debugging
