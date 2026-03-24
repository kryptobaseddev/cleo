# LAFS Protocol Python SDK

A complete Python implementation of the LLM-Agent-First Specification (LAFS).

## Installation

```bash
pip install lafs
```

Or install from source:

```bash
cd python
pip install -e .
```

## Quick Start

```python
from lafs import LAFSClient

# Create client
client = LAFSClient("https://api.example.com")

# Discover capabilities
discovery = client.discover()
print(f"Service: {discovery.service['name']}")
print(f"Supports budgets: {discovery.supports_budget()}")

# Make API call
response = client.call("tasks.list")
print(response.result)

# Call with budget constraints
response = client.call_with_budget(
    "tasks.list",
    max_tokens=1000,
    max_items=10
)
```

## Features

- **Envelope Validation**: Create and validate LAFS-compliant response envelopes
- **Token Budgeting**: Enforce token budgets to prevent context overflow
- **Service Discovery**: Auto-discover LAFS capabilities via well-known endpoint
- **Error Handling**: Structured error responses with retry semantics

## API Reference

### LAFSClient

Main client for interacting with LAFS-compliant APIs.

### Envelope

Represents a LAFS response envelope with success/error handling.

### TokenEstimator

Estimates token counts for LAFS responses using the normative algorithm.

### BudgetEnforcer

Enforces token budget constraints on responses.

## License

MIT License
