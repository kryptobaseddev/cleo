# CI/CD Integration Guide

Integrate cleo task validation and tracking into your continuous integration and deployment pipelines.

## Overview

Integrating cleo into your CI/CD pipeline enables:

- **Pre-deployment validation**: Prevent deployments with blocked or incomplete critical tasks
- **Task integrity checks**: Validate task data structure on every commit
- **Automated reporting**: Generate task status reports and metrics
- **Quality gates**: Enforce task completion requirements before merging
- **Activity tracking**: Monitor task velocity and team productivity

## Prerequisites

### Installation Requirements

Your CI environment needs:
- Bash 4+
- jq (JSON processor)
- GNU parallel (for parallel test execution)
- Standard UNIX utilities: sha256sum/shasum, tar, date, find

### Repository Setup

1. **Check in configuration**: Commit `.cleo/config.json` to version control
2. **Include task files**: Add `.cleo/todo.json` to repository (optional)
3. **Exclude sensitive data**: Add `.cleo/.backups/` and `.cleo/todo-log.json` to `.gitignore` if needed

```bash
# Example .gitignore
.cleo/.backups/
.cleo/todo-log.json  # Optional: exclude audit logs from repo
```

## GitHub Actions

### Basic Task Validation

Validate task integrity on every push and pull request:

```yaml
# .github/workflows/task-validation.yml
name: Task Validation

on:
  push:
    branches: [main, develop]
    paths:
      - '.cleo/**'
  pull_request:
    paths:
      - '.cleo/**'

jobs:
  validate:
    runs-on: ubuntu-latest

    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Install dependencies
        run: |
          sudo apt-get update
          sudo apt-get install -y jq parallel coreutils util-linux

      - name: Install cleo
        run: |
          ./install.sh --force
          echo "$HOME/.local/bin" >> $GITHUB_PATH

      - name: Validate task files
        run: |
          if [ -f .cleo/todo.json ]; then
            cleo validate
            echo "✓ Task validation passed"
          else
            echo "No task files to validate"
          fi
```

### Pre-Deployment Quality Gates

Prevent deployments when critical tasks are blocked or incomplete:

```yaml
# .github/workflows/deploy-check.yml
name: Deployment Check

on:
  pull_request:
    branches: [main]
  workflow_dispatch:

jobs:
  check-blockers:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - name: Install cleo
        run: |
          ./install.sh --force
          echo "$HOME/.local/bin" >> $GITHUB_PATH

      - name: Check for blocked tasks
        run: |
          BLOCKED_COUNT=$(cleo list --status blocked --format json | jq '.tasks | length')

          if [ "$BLOCKED_COUNT" -gt 0 ]; then
            echo "❌ Deployment blocked: $BLOCKED_COUNT blocked tasks found"
            cleo blockers
            exit 1
          fi

          echo "✓ No blocked tasks - deployment allowed"

      - name: Check critical task completion
        run: |
          CRITICAL_PENDING=$(cleo list --priority critical --status pending,active --format json | jq '.tasks | length')

          if [ "$CRITICAL_PENDING" -gt 0 ]; then
            echo "⚠️  Warning: $CRITICAL_PENDING critical tasks still pending"
            cleo list --priority critical --status pending,active
            # Uncomment to fail on critical tasks:
            # exit 1
          else
            echo "✓ All critical tasks completed"
          fi
```

### Scheduled Task Reports

Generate and publish task reports on a schedule:

```yaml
# .github/workflows/task-report.yml
name: Weekly Task Report

on:
  schedule:
    # Run every Monday at 9 AM UTC
    - cron: '0 9 * * 1'
  workflow_dispatch:  # Allow manual trigger

jobs:
  generate-report:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - name: Install cleo
        run: |
          ./install.sh --force
          echo "$HOME/.local/bin" >> $GITHUB_PATH

      - name: Generate dashboard report
        run: |
          echo "# Task Dashboard - $(date +'%Y-%m-%d')" > report.md
          echo "" >> report.md
          cleo dash --period 7 >> report.md

      - name: Generate CSV export
        run: |
          cleo export --format csv > tasks-$(date +'%Y%m%d').csv

      - name: Upload artifacts
        uses: actions/upload-artifact@v4
        with:
          name: task-reports
          path: |
            report.md
            tasks-*.csv
          retention-days: 90

      - name: Post to Slack (optional)
        if: success()
        env:
          SLACK_WEBHOOK: ${{ secrets.SLACK_WEBHOOK_URL }}
        run: |
          SUMMARY=$(cleo dash --compact)
          curl -X POST -H 'Content-type: application/json' \
            --data "{\"text\":\"📊 Weekly Task Report\n\`\`\`\n$SUMMARY\n\`\`\`\"}" \
            $SLACK_WEBHOOK
```

### Task Metrics Tracking

Track task completion velocity over time:

```yaml
# .github/workflows/task-metrics.yml
name: Task Metrics

on:
  push:
    branches: [main]
    paths:
      - '.cleo/todo.json'

jobs:
  track-metrics:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - name: Install cleo
        run: |
          ./install.sh --force
          echo "$HOME/.local/bin" >> $GITHUB_PATH

      - name: Calculate metrics
        id: metrics
        run: |
          TOTAL=$(cleo list --format json | jq '.tasks | length')
          PENDING=$(cleo list --status pending --format json | jq '.tasks | length')
          DONE=$(cleo list --status done --format json | jq '.tasks | length')

          echo "total=$TOTAL" >> $GITHUB_OUTPUT
          echo "pending=$PENDING" >> $GITHUB_OUTPUT
          echo "done=$DONE" >> $GITHUB_OUTPUT

          if [ $TOTAL -gt 0 ]; then
            COMPLETION_RATE=$(echo "scale=2; $DONE * 100 / $TOTAL" | bc)
            echo "completion_rate=$COMPLETION_RATE" >> $GITHUB_OUTPUT
          fi

      - name: Create job summary
        run: |
          echo "## Task Metrics" >> $GITHUB_STEP_SUMMARY
          echo "" >> $GITHUB_STEP_SUMMARY
          echo "- Total Tasks: ${{ steps.metrics.outputs.total }}" >> $GITHUB_STEP_SUMMARY
          echo "- Pending: ${{ steps.metrics.outputs.pending }}" >> $GITHUB_STEP_SUMMARY
          echo "- Completed: ${{ steps.metrics.outputs.done }}" >> $GITHUB_STEP_SUMMARY
          echo "- Completion Rate: ${{ steps.metrics.outputs.completion_rate }}%" >> $GITHUB_STEP_SUMMARY
```

## GitLab CI

### Pipeline Configuration

```yaml
# .gitlab-ci.yml
stages:
  - validate
  - test
  - report
  - deploy

variables:
  CLEO_HOME: "$CI_PROJECT_DIR/.cleo-install"

before_script:
  - apt-get update -qq
  - apt-get install -y jq coreutils util-linux

# Stage 1: Validate task files
validate:tasks:
  stage: validate
  script:
    - ./install.sh --force
    - export PATH="$HOME/.local/bin:$PATH"
    - |
      if [ -f .cleo/todo.json ]; then
        cleo validate
        echo "✓ Task validation passed"
      fi
  only:
    changes:
      - .cleo/**

# Stage 2: Check for blockers
check:blockers:
  stage: test
  script:
    - ./install.sh --force
    - export PATH="$HOME/.local/bin:$PATH"
    - |
      BLOCKED_COUNT=$(cleo list --status blocked --format json | jq '.tasks | length')
      if [ "$BLOCKED_COUNT" -gt 0 ]; then
        echo "❌ Found $BLOCKED_COUNT blocked tasks"
        cleo blockers
        exit 1
      fi
      echo "✓ No blockers detected"
  only:
    - merge_requests
    - main

# Stage 3: Generate reports
report:weekly:
  stage: report
  script:
    - ./install.sh --force
    - export PATH="$HOME/.local/bin:$PATH"
    - cleo dash --period 7 > task-report.txt
    - cleo export --format csv > tasks.csv
  artifacts:
    paths:
      - task-report.txt
      - tasks.csv
    expire_in: 30 days
  only:
    - schedules

# Stage 4: Pre-deployment validation
deploy:production:
  stage: deploy
  before_script:
    - apt-get update -qq && apt-get install -y jq
    - ./install.sh --force
    - export PATH="$HOME/.local/bin:$PATH"
  script:
    # Check critical tasks
    - |
      CRITICAL=$(cleo list --priority critical --status pending,active,blocked --format json | jq '.tasks | length')
      if [ "$CRITICAL" -gt 0 ]; then
        echo "❌ Cannot deploy: $CRITICAL critical tasks incomplete"
        cleo list --priority critical --status pending,active,blocked
        exit 1
      fi
    # Proceed with deployment
    - echo "✓ Pre-deployment checks passed"
    - ./deploy.sh
  only:
    - main
  when: manual
```

### Merge Request Integration

Add task status to merge request descriptions:

```yaml
# .gitlab-ci.yml (additional job)
mr:task-status:
  stage: validate
  script:
    - ./install.sh --force
    - export PATH="$HOME/.local/bin:$PATH"
    - |
      STATUS=$(cleo dash --compact)
      echo "## Task Status" > task_status.md
      echo "" >> task_status.md
      echo "\`\`\`" >> task_status.md
      echo "$STATUS" >> task_status.md
      echo "\`\`\`" >> task_status.md
  artifacts:
    reports:
      dotenv: task_status.md
  only:
    - merge_requests
```

## Jenkins

### Jenkinsfile (Declarative Pipeline)

```groovy
// Jenkinsfile
pipeline {
    agent any

    environment {
        PATH = "$HOME/.local/bin:$PATH"
    }

    stages {
        stage('Setup') {
            steps {
                sh '''
                    # Install dependencies
                    sudo apt-get update
                    sudo apt-get install -y jq coreutils util-linux

                    # Install cleo
                    ./install.sh --force
                '''
            }
        }

        stage('Validate Tasks') {
            when {
                changeset ".cleo/**"
            }
            steps {
                sh '''
                    if [ -f .cleo/todo.json ]; then
                        cleo validate
                    fi
                '''
            }
        }

        stage('Check Blockers') {
            steps {
                script {
                    def blockedCount = sh(
                        script: "cleo list --status blocked --format json | jq '.tasks | length'",
                        returnStdout: true
                    ).trim()

                    if (blockedCount.toInteger() > 0) {
                        echo "Warning: ${blockedCount} blocked tasks found"
                        sh 'cleo blockers'

                        // Uncomment to fail build:
                        // error("Deployment blocked: ${blockedCount} blocked tasks")
                    }
                }
            }
        }

        stage('Generate Report') {
            when {
                branch 'main'
            }
            steps {
                sh '''
                    cleo dash --period 7 > task-report.txt
                    cleo export --format csv > tasks.csv
                '''

                archiveArtifacts artifacts: 'task-report.txt,tasks.csv', fingerprint: true
            }
        }

        stage('Deploy') {
            when {
                branch 'main'
            }
            steps {
                script {
                    def criticalPending = sh(
                        script: "cleo list --priority critical --status pending,active --format json | jq '.tasks | length'",
                        returnStdout: true
                    ).trim()

                    if (criticalPending.toInteger() > 0) {
                        error("Cannot deploy: ${criticalPending} critical tasks incomplete")
                    }

                    echo "✓ Pre-deployment checks passed"
                    sh './deploy.sh'
                }
            }
        }
    }

    post {
        always {
            sh 'cleo stats'
        }
        success {
            echo 'Build and task validation successful'
        }
        failure {
            echo 'Build failed - check task validation errors'
        }
    }
}
```

### Scripted Pipeline with Parallel Validation

```groovy
// Jenkinsfile (Scripted)
node {
    stage('Checkout') {
        checkout scm
    }

    stage('Install') {
        sh './install.sh --force'
    }

    stage('Parallel Checks') {
        parallel(
            'Validate Schema': {
                sh 'cleo validate'
            },
            'Check Blockers': {
                sh '''
                    BLOCKED=$(cleo list --status blocked --format json | jq '.tasks | length')
                    if [ "$BLOCKED" -gt 0 ]; then
                        echo "⚠️  $BLOCKED blocked tasks found"
                        cleo blockers
                    fi
                '''
            },
            'Critical Tasks': {
                sh '''
                    CRITICAL=$(cleo list --priority critical --status pending,active --format json | jq '.tasks | length')
                    if [ "$CRITICAL" -gt 0 ]; then
                        echo "⚠️  $CRITICAL critical tasks pending"
                    fi
                '''
            }
        )
    }
}
```

## Azure DevOps

### Pipeline YAML

```yaml
# azure-pipelines.yml
trigger:
  branches:
    include:
      - main
      - develop
  paths:
    include:
      - .cleo/**

pool:
  vmImage: 'ubuntu-latest'

variables:
  CLEO_HOME: '$(Build.SourcesDirectory)/.cleo-install'

stages:
  - stage: Validate
    displayName: 'Validate Tasks'
    jobs:
      - job: ValidateTasks
        displayName: 'Validate Task Files'
        steps:
          - script: |
              sudo apt-get update
              sudo apt-get install -y jq coreutils util-linux
            displayName: 'Install dependencies'

          - script: |
              ./install.sh --force
              echo "##vso[task.prependpath]$HOME/.local/bin"
            displayName: 'Install cleo'

          - script: |
              if [ -f .cleo/todo.json ]; then
                cleo validate
                echo "✓ Validation passed"
              fi
            displayName: 'Validate task schema'

          - script: |
              BLOCKED=$(cleo list --status blocked --format json | jq '.tasks | length')
              echo "##vso[task.setvariable variable=blockedCount]$BLOCKED"

              if [ "$BLOCKED" -gt 0 ]; then
                echo "##vso[task.logissue type=warning]Found $BLOCKED blocked tasks"
                cleo blockers
              fi
            displayName: 'Check for blockers'

  - stage: Report
    displayName: 'Generate Reports'
    condition: eq(variables['Build.SourceBranch'], 'refs/heads/main')
    jobs:
      - job: GenerateReport
        displayName: 'Generate Task Reports'
        steps:
          - script: |
              ./install.sh --force
              echo "##vso[task.prependpath]$HOME/.local/bin"
            displayName: 'Install cleo'

          - script: |
              cleo dash --period 7 > $(Build.ArtifactStagingDirectory)/task-report.txt
              cleo export --format csv > $(Build.ArtifactStagingDirectory)/tasks.csv

              # Create markdown summary
              echo "## Task Dashboard" > $(Build.ArtifactStagingDirectory)/summary.md
              echo "" >> $(Build.ArtifactStagingDirectory)/summary.md
              cleo dash --compact >> $(Build.ArtifactStagingDirectory)/summary.md
            displayName: 'Generate reports'

          - task: PublishBuildArtifacts@1
            inputs:
              PathtoPublish: '$(Build.ArtifactStagingDirectory)'
              ArtifactName: 'task-reports'
              publishLocation: 'Container'

  - stage: Deploy
    displayName: 'Deploy'
    dependsOn: Validate
    condition: and(succeeded(), eq(variables['Build.SourceBranch'], 'refs/heads/main'))
    jobs:
      - deployment: DeployProduction
        displayName: 'Deploy to Production'
        environment: 'production'
        strategy:
          runOnce:
            deploy:
              steps:
                - script: |
                    ./install.sh --force
                    echo "##vso[task.prependpath]$HOME/.local/bin"
                  displayName: 'Install cleo'

                - script: |
                    CRITICAL=$(cleo list --priority critical --status pending,active,blocked --format json | jq '.tasks | length')

                    if [ "$CRITICAL" -gt 0 ]; then
                      echo "##vso[task.logissue type=error]Cannot deploy: $CRITICAL critical tasks incomplete"
                      cleo list --priority critical --status pending,active,blocked
                      exit 1
                    fi

                    echo "✓ Pre-deployment checks passed"
                  displayName: 'Pre-deployment validation'

                - script: |
                    ./deploy.sh
                  displayName: 'Deploy application'
```

### Pull Request Validation

```yaml
# pr-validation.yml
pr:
  branches:
    include:
      - main

pool:
  vmImage: 'ubuntu-latest'

steps:
  - script: |
      sudo apt-get update && sudo apt-get install -y jq
      ./install.sh --force
      echo "##vso[task.prependpath]$HOME/.local/bin"
    displayName: 'Setup'

  - script: |
      STATUS=$(cleo dash --compact)
      echo "##vso[task.setvariable variable=TaskStatus]$STATUS"

      # Add to PR comment
      echo "### Task Status" > pr-comment.md
      echo "" >> pr-comment.md
      echo "\`\`\`" >> pr-comment.md
      echo "$STATUS" >> pr-comment.md
      echo "\`\`\`" >> pr-comment.md
    displayName: 'Get task status'

  - script: |
      BLOCKED=$(cleo list --status blocked --format json | jq '.tasks | length')
      CRITICAL=$(cleo list --priority critical --status pending,active --format json | jq '.tasks | length')

      if [ "$BLOCKED" -gt 0 ] || [ "$CRITICAL" -gt 0 ]; then
        echo "##vso[task.logissue type=warning]Review required: $BLOCKED blocked, $CRITICAL critical pending"
      fi
    displayName: 'Validate PR readiness'
```

## Common Patterns

### Preventing Merges with Blocked Tasks

Use exit codes to fail CI builds when tasks are blocked:

```bash
#!/bin/bash
# check-blockers.sh

BLOCKED_COUNT=$(cleo list --status blocked --format json | jq '.tasks | length')

if [ "$BLOCKED_COUNT" -gt 0 ]; then
    echo "❌ Merge blocked: $BLOCKED_COUNT blocked tasks found"
    echo ""
    cleo blockers
    exit 1
fi

echo "✓ No blocked tasks - merge allowed"
exit 0
```

### Automated Task Archival

Archive completed tasks automatically after successful deployments:

```bash
#!/bin/bash
# post-deploy-cleanup.sh

if [ "$DEPLOYMENT_SUCCESS" = "true" ]; then
    echo "Archiving completed tasks..."
    cleo archive --force

    # Commit updated task files
    git add .cleo/todo.json .cleo/todo-archive.json
    git commit -m "chore: Archive completed tasks after deployment"
    git push
fi
```

### Task Metrics Dashboard Integration

Export metrics to monitoring systems:

```bash
#!/bin/bash
# export-metrics.sh

# Get metrics
TOTAL=$(cleo list --format json | jq '.tasks | length')
PENDING=$(cleo list --status pending --format json | jq '.tasks | length')
BLOCKED=$(cleo list --status blocked --format json | jq '.tasks | length')
DONE=$(cleo list --status done --format json | jq '.tasks | length')

# Send to monitoring system (example: Prometheus pushgateway)
cat <<EOF | curl --data-binary @- http://pushgateway:9091/metrics/job/cleo
# HELP tasks_total Total number of tasks
# TYPE tasks_total gauge
tasks_total $TOTAL

# HELP tasks_pending Number of pending tasks
# TYPE tasks_pending gauge
tasks_pending $PENDING

# HELP tasks_blocked Number of blocked tasks
# TYPE tasks_blocked gauge
tasks_blocked $BLOCKED

# HELP tasks_done Number of completed tasks
# TYPE tasks_done gauge
tasks_done $DONE
EOF
```

### Slack/Teams Notifications

Send task status to team communication channels:

```bash
#!/bin/bash
# notify-slack.sh

WEBHOOK_URL="$SLACK_WEBHOOK_URL"
STATUS=$(cleo dash --compact)

curl -X POST -H 'Content-type: application/json' \
  --data "{
    \"text\": \"📊 Task Dashboard Update\",
    \"blocks\": [
      {
        \"type\": \"section\",
        \"text\": {
          \"type\": \"mrkdwn\",
          \"text\": \"*Task Status*\n\`\`\`\n$STATUS\n\`\`\`\"
        }
      }
    ]
  }" \
  $WEBHOOK_URL
```

## Troubleshooting

### Issue: Installation fails in CI environment

**Solution**: Use `--install-deps` flag to auto-install dependencies:

```bash
./install.sh --install-deps --force
```

Or manually install required dependencies:

```bash
# Ubuntu/Debian
sudo apt-get install -y jq coreutils util-linux

# Alpine Linux
apk add --no-cache bash jq coreutils util-linux

# macOS
brew install jq coreutils flock
```

### Issue: PATH not set correctly

**Solution**: Explicitly add to PATH in CI scripts:

```bash
./install.sh --force
export PATH="$HOME/.local/bin:$PATH"
cleo version
```

### Issue: File permissions in Docker containers

**Solution**: Run as non-root user or adjust permissions:

```dockerfile
FROM ubuntu:22.04
RUN useradd -m ciuser
USER ciuser
WORKDIR /home/ciuser
COPY --chown=ciuser:ciuser . .
RUN ./install.sh --force
```

### Issue: jq not available

**Solution**: Check dependencies before running:

```bash
./install.sh --check-deps
if [ $? -ne 0 ]; then
    echo "Installing missing dependencies..."
    ./install.sh --install-deps --force
fi
```

### Issue: Task files not found

**Solution**: Verify `.cleo/` directory exists and is committed:

```bash
if [ ! -f .cleo/todo.json ]; then
    echo "No task files found - initializing..."
    cleo init
fi
```

## Best Practices

1. **Validate Early**: Run validation checks as early as possible in the pipeline
2. **Fail Fast**: Use exit codes to stop builds immediately when critical issues are found
3. **Cache Installation**: Cache the `~/.cleo` directory to speed up builds
4. **Use JSON Format**: Parse JSON output with `jq` for robust scripting
5. **Archive Regularly**: Automate task archival after successful deployments
6. **Monitor Metrics**: Track task completion velocity over time
7. **Notify Teams**: Send task status updates to team communication channels
8. **Document Workflows**: Add task validation steps to your CI/CD documentation

## Related Documentation

- [Commands Reference](reference/command-reference.md) - Complete command documentation
- [Validation Guide](reference/troubleshooting.md) - Troubleshooting validation errors
- [Export Formats](reference/cli-output-formats.md) - JSON, CSV, and other output formats
- [Configuration](reference/configuration.md) - Configuring validation rules and behavior

## Version History

- **v0.9.0**: Initial CI/CD integration documentation with GitHub Actions, GitLab CI, Jenkins, and Azure DevOps examples
