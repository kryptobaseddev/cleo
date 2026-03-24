"""LAFS Envelope validation and construction.

Implements the canonical LAFS envelope as defined in Section 6 of the specification.
"""

from typing import Any, Dict, List, Optional, Union
from datetime import datetime
import json
import re


class LAFSValidationError(Exception):
    """Raised when an envelope fails LAFS validation."""

    def __init__(
        self,
        message: str,
        field: Optional[str] = None,
        code: str = "E_VALIDATION_SCHEMA",
    ):
        self.field = field
        self.code = code
        super().__init__(message)


class Envelope:
    """Represents a LAFS response envelope.

    The envelope structure follows the canonical schema defined in LAFS Section 6:
    {
      "$schema": "https://lafs.dev/schemas/v1/envelope.schema.json",
      "_meta": { ... },
      "success": true|false,
      "result": {}|null,
      "error": {}|null,
      "page": {}|null
    }
    """

    def __init__(
        self,
        success: bool,
        result: Optional[Any] = None,
        error: Optional[Dict] = None,
        page: Optional[Dict] = None,
        meta: Optional[Dict] = None,
        schema_url: str = "https://lafs.dev/schemas/v1/envelope.schema.json",
    ):
        self.success = success
        self.result = result
        self.error = error
        self.page = page
        self.schema = schema_url
        self._meta = meta or {}

    @property
    def meta(self) -> Dict[str, Any]:
        """Get envelope metadata."""
        return self._meta

    @classmethod
    def success_response(
        cls,
        result: Any,
        operation: str,
        request_id: str,
        page: Optional[Dict] = None,
        context_version: int = 0,
        strict: bool = True,
        mvi: Union[str, bool] = "standard",
        transport: str = "sdk",
    ) -> "Envelope":
        """Create a successful response envelope."""
        if isinstance(mvi, bool):
            mvi_level = "minimal" if mvi else "standard"
        else:
            mvi_level = mvi

        meta = {
            "specVersion": "1.0.0",
            "schemaVersion": "1.0.0",
            "timestamp": datetime.utcnow().isoformat() + "Z",
            "operation": operation,
            "requestId": request_id,
            "transport": transport,
            "strict": strict,
            "mvi": mvi_level,
            "contextVersion": context_version,
        }
        return cls(success=True, result=result, page=page, meta=meta)

    @classmethod
    def error_response(
        cls,
        code: str,
        message: str,
        operation: str,
        request_id: str,
        category: str = "INTERNAL",
        retryable: bool = False,
        retry_after_ms: Optional[int] = None,
        details: Optional[Dict] = None,
        context_version: int = 0,
        strict: bool = True,
        mvi: Union[str, bool] = "standard",
        transport: str = "sdk",
    ) -> "Envelope":
        """Create an error response envelope."""
        if isinstance(mvi, bool):
            mvi_level = "minimal" if mvi else "standard"
        else:
            mvi_level = mvi

        meta = {
            "specVersion": "1.0.0",
            "schemaVersion": "1.0.0",
            "timestamp": datetime.utcnow().isoformat() + "Z",
            "operation": operation,
            "requestId": request_id,
            "transport": transport,
            "strict": strict,
            "mvi": mvi_level,
            "contextVersion": context_version,
        }
        error = {
            "code": code,
            "message": message,
            "category": category,
            "retryable": retryable,
            "retryAfterMs": retry_after_ms,
            "details": details or {},
        }
        return cls(success=False, error=error, result=None, meta=meta)

    def to_dict(self) -> Dict[str, Any]:
        """Convert envelope to dictionary."""
        envelope = {
            "$schema": self.schema,
            "_meta": self._meta,
            "success": self.success,
            "result": self.result,
        }

        if self.error is not None:
            envelope["error"] = self.error
        if self.page is not None:
            envelope["page"] = self.page

        return envelope

    def to_json(self, indent: Optional[int] = None) -> str:
        """Convert envelope to JSON string."""
        return json.dumps(self.to_dict(), indent=indent)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "Envelope":
        """Parse envelope from dictionary."""
        return cls(
            schema_url=data.get("$schema", ""),
            success=data.get("success", False),
            result=data.get("result"),
            error=data.get("error"),
            page=data.get("page"),
            meta=data.get("_meta", {}),
        )

    @classmethod
    def from_json(cls, json_str: str) -> "Envelope":
        """Parse envelope from JSON string."""
        return cls.from_dict(json.loads(json_str))


class EnvelopeValidator:
    """Validates LAFS envelopes against the specification."""

    ERROR_CODE_PATTERN = re.compile(r"^E_[A-Z0-9]+_[A-Z0-9_]+$")

    VALID_CATEGORIES = {
        "VALIDATION",
        "AUTH",
        "PERMISSION",
        "NOT_FOUND",
        "CONFLICT",
        "RATE_LIMIT",
        "TRANSIENT",
        "INTERNAL",
        "CONTRACT",
        "MIGRATION",
    }

    VALID_MVI_LEVELS = {"minimal", "standard", "full", "custom"}
    VALID_TRANSPORTS = {"cli", "http", "grpc", "sdk"}

    REQUIRED_META_FIELDS = {
        "specVersion",
        "schemaVersion",
        "timestamp",
        "operation",
        "requestId",
        "transport",
        "strict",
        "mvi",
        "contextVersion",
    }

    ALLOWED_ENVELOPE_FIELDS = {
        "$schema",
        "_meta",
        "success",
        "result",
        "error",
        "page",
        "_extensions",
    }

    ALLOWED_META_FIELDS = {
        "specVersion",
        "schemaVersion",
        "timestamp",
        "operation",
        "requestId",
        "transport",
        "strict",
        "mvi",
        "contextVersion",
        "sessionId",
        "warnings",
    }

    def validate(self, envelope: Union[Envelope, Dict]) -> List[str]:
        """Validate an envelope and return list of validation errors.

        Returns empty list if envelope is valid.
        """
        errors = []

        if isinstance(envelope, Envelope):
            data = envelope.to_dict()
        else:
            data = envelope

        # Check required envelope fields
        if "$schema" not in data:
            errors.append("Missing required field: $schema")
        elif "envelope.schema.json" not in data["$schema"]:
            errors.append(f"Invalid schema URL: {data['$schema']}")

        if "_meta" not in data:
            errors.append("Missing required field: _meta")
        else:
            meta = data["_meta"]
            for field in self.REQUIRED_META_FIELDS:
                if field not in meta:
                    errors.append(f"Missing required meta field: {field}")

            unknown_meta_fields = set(meta.keys()) - self.ALLOWED_META_FIELDS
            if unknown_meta_fields:
                errors.append(
                    f"Unknown _meta field(s): {', '.join(sorted(unknown_meta_fields))}"
                )

            if "transport" in meta and meta["transport"] not in self.VALID_TRANSPORTS:
                errors.append(f"Invalid transport: {meta['transport']}")

            if "strict" in meta and not isinstance(meta["strict"], bool):
                errors.append("Meta field 'strict' must be a boolean")

            if "mvi" in meta and meta["mvi"] not in self.VALID_MVI_LEVELS:
                errors.append(f"Invalid mvi level: {meta['mvi']}")

            if "contextVersion" in meta:
                if (
                    not isinstance(meta["contextVersion"], int)
                    or meta["contextVersion"] < 0
                ):
                    errors.append(
                        "Meta field 'contextVersion' must be a non-negative integer"
                    )

        if "success" not in data:
            errors.append("Missing required field: success")
        elif not isinstance(data["success"], bool):
            errors.append("Field 'success' must be a boolean")

        if "result" not in data:
            errors.append("Missing required field: result")

        # Validate envelope invariants
        success = data.get("success")
        result = data.get("result")
        error = data.get("error")

        if success:
            if error is not None:
                errors.append("success=true implies error must be null or omitted")
        else:
            if result is not None:
                errors.append("success=false implies result must be null")
            if error is None:
                errors.append("success=false requires non-null error")

        meta = data.get("_meta", {}) if isinstance(data.get("_meta"), dict) else {}
        if meta.get("strict") is True:
            unknown_fields = set(data.keys()) - self.ALLOWED_ENVELOPE_FIELDS
            if unknown_fields:
                errors.append(
                    f"Strict mode rejects unknown top-level field(s): {', '.join(sorted(unknown_fields))}"
                )

        # Validate error structure if present
        if error is not None:
            errors.extend(self._validate_error(error))

        # Validate pagination structure if present
        page = data.get("page")
        if page is not None:
            errors.extend(self._validate_page(page))

        return errors

    def _validate_error(self, error: Dict) -> List[str]:
        """Validate error object structure."""
        errors = []

        if "code" not in error:
            errors.append("Error missing required field: code")
        elif not self.ERROR_CODE_PATTERN.match(error["code"]):
            errors.append(f"Invalid error code format: {error['code']}")

        if "message" not in error:
            errors.append("Error missing required field: message")

        if "category" not in error:
            errors.append("Error missing required field: category")

        if "category" in error:
            if error["category"] not in self.VALID_CATEGORIES:
                errors.append(f"Invalid error category: {error['category']}")

        if "retryable" not in error:
            errors.append("Error missing required field: retryable")
        elif not isinstance(error["retryable"], bool):
            errors.append("Error field 'retryable' must be a boolean")

        if "retryAfterMs" not in error:
            errors.append("Error missing required field: retryAfterMs")

        if "details" not in error:
            errors.append("Error missing required field: details")

        return errors

    def _validate_page(self, page: Dict) -> List[str]:
        """Validate page object with mode-conditional requirements."""
        errors = []

        if not isinstance(page, dict):
            errors.append("Field 'page' must be an object")
            return errors

        mode = page.get("mode")
        if mode not in {"cursor", "offset", "none"}:
            errors.append("Page field 'mode' must be one of: cursor, offset, none")
            return errors

        if mode == "cursor":
            for field in ["nextCursor", "hasMore"]:
                if field not in page:
                    errors.append(f"Cursor mode missing required field: {field}")
        elif mode == "offset":
            for field in ["limit", "offset", "hasMore"]:
                if field not in page:
                    errors.append(f"Offset mode missing required field: {field}")
        elif mode == "none":
            extra_fields = set(page.keys()) - {"mode"}
            if extra_fields:
                errors.append(
                    f"None mode must only contain mode; found extra field(s): {', '.join(sorted(extra_fields))}"
                )

        return errors

    def validate_strict(self, envelope: Union[Envelope, Dict]) -> None:
        """Validate an envelope and raise exception if invalid."""
        errors = self.validate(envelope)
        if errors:
            raise LAFSValidationError(
                f"Envelope validation failed: {'; '.join(errors)}",
                code="E_VALIDATION_SCHEMA",
            )

    def is_valid(self, envelope: Union[Envelope, Dict]) -> bool:
        """Quick check if envelope is valid."""
        return len(self.validate(envelope)) == 0
