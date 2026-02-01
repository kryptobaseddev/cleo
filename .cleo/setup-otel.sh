#!/usr/bin/env bash
# CLEO OpenTelemetry Configuration
# Source this file or add to ~/.bashrc / ~/.zshrc

export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_METRICS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_PROTOCOL=http/json
export OTEL_EXPORTER_OTLP_ENDPOINT="file://${HOME}/.cleo/metrics/otel/"

echo "[CLEO] OpenTelemetry enabled for Claude Code token tracking"
