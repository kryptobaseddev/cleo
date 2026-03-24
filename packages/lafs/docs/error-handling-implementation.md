# Error Handling Implementation Guide

**Version:** 1.1.0  
**Purpose:** Complete code examples for handling LAFS errors programmatically

---

## E_FORMAT_CONFLICT Implementation

### TypeScript/JavaScript

```typescript
import { LAFSFlagError } from '@cleocode/lafs';

/**
 * Detect and report E_FORMAT_CONFLICT error
 * 
 * This error occurs when an agent attempts to generate both JSON and 
 * human-readable output simultaneously.
 */

interface OutputFormatFlags {
  human?: boolean;
  json?: boolean;
}

/**
 * Check for format conflict and throw E_FORMAT_CONFLICT
 * 
 * @param flags - Output format flags
 * @throws {LAFSFlagError} E_FORMAT_CONFLICT when both flags are true
 * 
 * @example
 * ```typescript
 * // This will throw
 * checkFormatConflict({ human: true, json: true });
 * // Throws: LAFSFlagError: E_FORMAT_CONFLICT
 * 
 * // This will pass
 * checkFormatConflict({ human: true });
 * checkFormatConflict({ json: true });
 * ```
 */
function checkFormatConflict(flags: OutputFormatFlags): void {
  if (flags.human && flags.json) {
    throw new LAFSFlagError(
      'E_FORMAT_CONFLICT',
      'Cannot use --human and --json flags simultaneously'
    );
  }
}

/**
 * Resolve output format with conflict detection
 * 
 * @param flags - Output format flags
 * @returns Resolved format ('json' | 'human')
 * @throws {LAFSFlagError} E_FORMAT_CONFLICT when both flags are true
 */
function resolveOutputFormat(flags: OutputFormatFlags): 'json' | 'human' {
  // Check for conflict first
  checkFormatConflict(flags);

  if (flags.human) return 'human';
  if (flags.json) return 'json';
  
  // Default to JSON for machine readability
  return 'json';
}

/**
 * Complete error envelope for E_FORMAT_CONFLICT
 */
function createFormatConflictError(requestId: string) {
  return {
    $schema: 'https://lafs.dev/schemas/v1/envelope.schema.json',
    _meta: {
      specVersion: '1.1.0',
      operation: 'agent.output',
      requestId,
      mvi: 'minimal'
    },
    success: false,
    result: null,
    error: {
      code: 'E_FORMAT_CONFLICT',
      message: 'Cannot generate both JSON and human-readable output simultaneously',
      category: 'VALIDATION',
      retryable: false,
      details: {
        conflictingFlags: ['--human', '--json'],
        resolution: 'Use either --human OR --json, not both'
      }
    }
  };
}

// CLI Implementation
import { parseArgs } from 'util';

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      human: { type: 'boolean' },
      json: { type: 'boolean' }
    }
  });

  try {
    const format = resolveOutputFormat({
      human: values.human,
      json: values.json
    });
    
    console.log(`Output format: ${format}`);
    // Continue processing...
    
  } catch (error) {
    if (error instanceof LAFSFlagError && error.code === 'E_FORMAT_CONFLICT') {
      // Output error as LAFS envelope
      const errorEnvelope = createFormatConflictError('req_cli_001');
      
      if (values.json) {
        console.error(JSON.stringify(errorEnvelope, null, 2));
      } else {
        console.error(`Error: ${error.message}`);
        console.error('Usage: agent --json OR agent --human');
      }
      
      process.exit(1);
    }
    throw error;
  }
}

// Agent Implementation
class LAFSAgent {
  async processRequest(
    request: unknown,
    options: { human?: boolean; json?: boolean }
  ) {
    // Detect format conflict
    if (options.human && options.json) {
      return createFormatConflictError(this.generateRequestId());
    }

    // Process normally...
    return {
      success: true,
      result: { /* data */ },
      _meta: { /* metadata */ }
    };
  }

  private generateRequestId(): string {
    return `req_${Date.now()}`;
  }
}
```

### Python Implementation

```python
import sys
from typing import Optional, Dict, Any

class LAFSFlagError(Exception):
    """LAFS flag/option error"""
    def __init__(self, code: str, message: str):
        self.code = code
        self.message = message
        super().__init__(message)

def check_format_conflict(human: bool = False, json: bool = False) -> None:
    """
    Check for E_FORMAT_CONFLICT error
    
    Raises:
        LAFSFlagError: When both human and json are True
    """
    if human and json:
        raise LAFSFlagError(
            "E_FORMAT_CONFLICT",
            "Cannot use --human and --json flags simultaneously"
        )

def resolve_output_format(human: bool = False, json: bool = False) -> str:
    """Resolve format with conflict detection"""
    check_format_conflict(human, json)
    
    if human:
        return "human"
    if json:
        return "json"
    
    return "json"

def create_format_conflict_error(request_id: str) -> Dict[str, Any]:
    """Create E_FORMAT_CONFLICT error envelope"""
    return {
        "$schema": "https://lafs.dev/schemas/v1/envelope.schema.json",
        "_meta": {
            "specVersion": "1.1.0",
            "operation": "agent.output",
            "requestId": request_id,
            "mvi": "minimal"
        },
        "success": False,
        "result": None,
        "error": {
            "code": "E_FORMAT_CONFLICT",
            "message": "Cannot generate both JSON and human-readable output simultaneously",
            "category": "VALIDATION",
            "retryable": False,
            "details": {
                "conflictingFlags": ["--human", "--json"],
                "resolution": "Use either --human OR --json, not both"
            }
        }
    }

# CLI Implementation
if __name__ == "__main__":
    import argparse
    
    parser = argparse.ArgumentParser()
    parser.add_argument("--human", action="store_true")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    
    try:
        format_type = resolve_output_format(args.human, args.json)
        print(f"Output format: {format_type}")
    except LAFSFlagError as e:
        if e.code == "E_FORMAT_CONFLICT":
            error_envelope = create_format_conflict_error("req_cli_001")
            
            if args.json:
                print(json.dumps(error_envelope, indent=2), file=sys.stderr)
            else:
                print(f"Error: {e.message}", file=sys.stderr)
                print("Usage: agent --json OR agent --human", file=sys.stderr)
            
            sys.exit(1)
        raise
```

---

## Error Registry Usage

### Working with Error Codes

```typescript
import { 
  ErrorRegistry, 
  LAFS_ERRORS,
  type ErrorCategory 
} from '@cleocode/lafs';

const registry = new ErrorRegistry();

// Register custom error
registry.register({
  code: 'E_CUSTOM_BUSINESS_LOGIC',
  category: 'VALIDATION',
  retryable: false,
  description: 'Business rule violation'
});

// Lookup error
const errorInfo = registry.get('E_NOT_FOUND_RESOURCE');
console.log(errorInfo);
// {
//   code: 'E_NOT_FOUND_RESOURCE',
//   category: 'NOT_FOUND',
//   retryable: false,
//   description: '...'
// }

// Check if error is retryable
const shouldRetry = registry.isRetryable('E_RATE_LIMIT_EXCEEDED');
console.log(shouldRetry); // true

// Get retry delay
const delay = registry.getRetryDelay('E_RATE_LIMIT_EXCEEDED');
console.log(delay); // 60000 (60 seconds)
```

### Error Handling Middleware

```typescript
import { Request, Response, NextFunction } from 'express';
import { ErrorRegistry } from '@cleocode/lafs';

const errorRegistry = new ErrorRegistry();

function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction
) {
  // Log error
  console.error('Error:', err);

  // Check if it's a known LAFS error
  if (err instanceof LAFSFlagError) {
    const errorInfo = errorRegistry.get(err.code);
    
    return res.status(400).json({
      success: false,
      error: {
        code: err.code,
        message: err.message,
        category: errorInfo?.category || 'INTERNAL',
        retryable: errorInfo?.retryable ?? false
      }
    });
  }

  // Unknown error
  res.status(500).json({
    success: false,
    error: {
      code: 'E_INTERNAL_ERROR',
      message: 'Internal server error',
      category: 'INTERNAL',
      retryable: false
    }
  });
}

app.use(errorHandler);
```

---

## Complete Error Handling Example

```typescript
import { 
  createEnvelope,
  ErrorRegistry,
  LAFSFlagError 
} from '@cleocode/lafs';

class RobustLAFSAgent {
  private errorRegistry = new ErrorRegistry();

  async execute<T>(
    operation: string,
    fn: () => Promise<T>,
    options: {
      humanOutput?: boolean;
      jsonOutput?: boolean;
      requestId?: string;
    } = {}
  ) {
    const requestId = options.requestId || this.generateRequestId();

    try {
      // Check format conflict
      if (options.humanOutput && options.jsonOutput) {
        return this.createErrorResponse(
          'E_FORMAT_CONFLICT',
          'Cannot generate both JSON and human-readable output',
          requestId
        );
      }

      // Execute operation
      const result = await fn();
      
      return createEnvelope({
        success: true,
        result,
        meta: { operation, requestId }
      });

    } catch (error) {
      // Handle different error types
      if (error instanceof LAFSFlagError) {
        return this.createErrorResponse(
          error.code,
          error.message,
          requestId
        );
      }

      if (error.code && this.errorRegistry.has(error.code)) {
        const errorInfo = this.errorRegistry.get(error.code);
        return this.createErrorResponse(
          error.code,
          error.message,
          requestId,
          errorInfo.category
        );
      }

      // Unknown error
      return this.createErrorResponse(
        'E_INTERNAL_ERROR',
        error instanceof Error ? error.message : 'Unknown error',
        requestId,
        'INTERNAL'
      );
    }
  }

  private createErrorResponse(
    code: string,
    message: string,
    requestId: string,
    category?: string
  ) {
    const errorInfo = this.errorRegistry.get(code);
    
    return createEnvelope({
      success: false,
      error: {
        code,
        message,
        category: (category || errorInfo?.category || 'INTERNAL') as any,
        retryable: errorInfo?.retryable ?? false
      },
      meta: { operation: 'agent.execute', requestId }
    });
  }

  private generateRequestId(): string {
    return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}
```

---

## Testing Error Scenarios

```typescript
import { describe, it, expect } from 'vitest';
import { LAFSFlagError } from '@cleocode/lafs';

describe('E_FORMAT_CONFLICT', () => {
  it('should throw when both flags are true', () => {
    expect(() => {
      checkFormatConflict({ human: true, json: true });
    }).toThrow(LAFSFlagError);

    try {
      checkFormatConflict({ human: true, json: true });
    } catch (error) {
      expect(error).toBeInstanceOf(LAFSFlagError);
      expect(error.code).toBe('E_FORMAT_CONFLICT');
      expect(error.message).toContain('Cannot use');
    }
  });

  it('should not throw with single flag', () => {
    expect(() => {
      checkFormatConflict({ human: true });
    }).not.toThrow();

    expect(() => {
      checkFormatConflict({ json: true });
    }).not.toThrow();
  });

  it('should not throw with no flags', () => {
    expect(() => {
      checkFormatConflict({});
    }).not.toThrow();
  });
});

describe('Error Envelope Creation', () => {
  it('should create valid E_FORMAT_CONFLICT envelope', () => {
    const envelope = createFormatConflictError('req_test');
    
    expect(envelope.success).toBe(false);
    expect(envelope.error.code).toBe('E_FORMAT_CONFLICT');
    expect(envelope.error.category).toBe('VALIDATION');
    expect(envelope.error.retryable).toBe(false);
  });
});
```

---

*Error Handling Guide v1.1.0*
