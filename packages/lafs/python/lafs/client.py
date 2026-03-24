"""LAFS HTTP Client implementation.

Provides a client for interacting with LAFS-compliant APIs including
discovery, envelope-based requests, and budget enforcement.
"""

from typing import Any, Dict, List, Optional, Union
from dataclasses import dataclass
import json
import urllib.request
import urllib.error
import urllib.parse
import ssl

from .envelope import Envelope, EnvelopeValidator, LAFSValidationError
from .budget import BudgetEnforcer, LAFSBudgetExceeded, TokenEstimator


class LAFSError(Exception):
    """Base exception for LAFS client errors."""

    def __init__(self, message: str, status_code: Optional[int] = None):
        self.status_code = status_code
        super().__init__(message)


class LAFSConnectionError(LAFSError):
    """Raised when connection to LAFS service fails."""

    pass


@dataclass
class DiscoveryDocument:
    """LAFS Discovery Document as defined in agent-discovery-v1.md"""

    schema: str
    lafs_version: str
    service: Dict[str, Any]
    capabilities: Dict[str, Any]
    endpoints: Dict[str, Any]
    caching: Optional[Dict[str, Any]] = None
    security: Optional[Dict[str, Any]] = None
    extensions: Optional[Dict[str, Any]] = None

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "DiscoveryDocument":
        """Parse discovery document from dictionary."""
        return cls(
            schema=data.get("$schema", ""),
            lafs_version=data.get("lafs_version", ""),
            service=data.get("service", {}),
            capabilities=data.get("capabilities", {}),
            endpoints=data.get("endpoints", {}),
            caching=data.get("caching"),
            security=data.get("security"),
            extensions=data.get("_extensions"),
        )

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary."""
        result = {
            "$schema": self.schema,
            "lafs_version": self.lafs_version,
            "service": self.service,
            "capabilities": self.capabilities,
            "endpoints": self.endpoints,
        }
        if self.caching:
            result["caching"] = self.caching
        if self.security:
            result["security"] = self.security
        if self.extensions:
            result["_extensions"] = self.extensions
        return result

    # Capability check helpers
    def supports_mvi_level(self, level: str) -> bool:
        """Check if service supports given MVI level."""
        features = self.capabilities.get("features", {})
        levels = features.get("mvi_levels", [])
        return level in levels

    def supports_pagination(self, mode: str) -> bool:
        """Check if service supports given pagination mode."""
        features = self.capabilities.get("features", {})
        modes = features.get("pagination_modes", [])
        return mode in modes

    def supports_strict_mode(self) -> bool:
        """Check if service supports strict mode."""
        features = self.capabilities.get("features", {})
        return features.get("strict_mode", False)

    def supports_context_ledger(self) -> bool:
        """Check if service supports context ledger."""
        features = self.capabilities.get("features", {})
        return features.get("context_ledger", False)

    def supports_field_selection(self) -> bool:
        """Check if service supports field selection."""
        features = self.capabilities.get("features", {})
        return features.get("field_selection", False)

    def supports_expansion(self) -> bool:
        """Check if service supports expansion."""
        features = self.capabilities.get("features", {})
        return features.get("expansion", False)

    def supports_budget(self) -> bool:
        """Check if service supports budget signaling."""
        features = self.capabilities.get("features", {})
        budgets = features.get("budgets", {})
        return budgets.get("supported", False)

    def get_endpoint_url(self, operation: Optional[str] = None) -> str:
        """Get URL for an operation or the default envelope endpoint."""
        base = self.endpoints.get("base_url", "")
        if operation and operation in self.endpoints.get("operations", {}):
            return base + self.endpoints["operations"][operation]
        return base + self.endpoints.get("envelope_endpoint", "/")


class LAFSClient:
    """HTTP client for LAFS-compliant APIs.

    Provides methods for:
    - Discovery at /.well-known/lafs.json
    - Envelope-based API calls
    - Budget enforcement
    - Error handling
    """

    def __init__(
        self,
        base_url: str,
        api_key: Optional[str] = None,
        timeout: float = 30.0,
        verify_ssl: bool = True,
    ):
        """Initialize LAFS client.

        Args:
            base_url: Base URL of the LAFS service
            api_key: Optional API key for authentication
            timeout: Request timeout in seconds
            verify_ssl: Whether to verify SSL certificates
        """
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.timeout = timeout
        self.verify_ssl = verify_ssl
        self._discovery: Optional[DiscoveryDocument] = None
        self._validator = EnvelopeValidator()
        self._estimator = TokenEstimator()

    def _make_request(
        self,
        url: str,
        method: str = "GET",
        data: Optional[Dict] = None,
        headers: Optional[Dict[str, str]] = None,
    ) -> Dict[str, Any]:
        """Make HTTP request and return JSON response."""
        req_headers = {"Accept": "application/json", "Content-Type": "application/json"}

        if self.api_key:
            req_headers["X-API-Key"] = self.api_key

        if headers:
            req_headers.update(headers)

        try:
            if data is not None:
                body = json.dumps(data).encode("utf-8")
            else:
                body = None

            req = urllib.request.Request(
                url, data=body, headers=req_headers, method=method
            )

            # SSL context
            if not self.verify_ssl:
                ssl_context = ssl.create_default_context()
                ssl_context.check_hostname = False
                ssl_context.verify_mode = ssl.CERT_NONE
            else:
                ssl_context = None

            with urllib.request.urlopen(
                req, timeout=self.timeout, context=ssl_context
            ) as response:
                response_data = response.read().decode("utf-8")
                if response_data:
                    return json.loads(response_data)
                return {}

        except urllib.error.HTTPError as e:
            try:
                error_body = e.read().decode("utf-8")
                error_data = json.loads(error_body)
                raise LAFSError(
                    f"HTTP {e.code}: {error_data.get('error', {}).get('message', e.reason)}",
                    status_code=e.code,
                )
            except (json.JSONDecodeError, AttributeError):
                raise LAFSError(f"HTTP {e.code}: {e.reason}", status_code=e.code)

        except urllib.error.URLError as e:
            raise LAFSConnectionError(f"Connection failed: {e.reason}")
        except TimeoutError:
            raise LAFSConnectionError(f"Request timed out after {self.timeout}s")

    def discover(self) -> DiscoveryDocument:
        """Discover LAFS capabilities at /.well-known/lafs.json

        Returns:
            DiscoveryDocument with service capabilities
        """
        discovery_url = f"{self.base_url}/.well-known/lafs.json"

        try:
            data = self._make_request(discovery_url)
            self._discovery = DiscoveryDocument.from_dict(data)
            return self._discovery
        except LAFSError:
            raise
        except Exception as e:
            raise LAFSConnectionError(f"Discovery failed: {e}")

    def call(
        self,
        operation: str,
        params: Optional[Dict[str, Any]] = None,
        budget: Optional[Dict[str, int]] = None,
        strict: bool = True,
        validate: bool = True,
    ) -> Envelope:
        """Make a LAFS-compliant API call.

        Args:
            operation: Operation name (e.g., "tasks.list")
            params: Request parameters
            budget: Optional budget constraints (maxTokens, maxItems, maxBytes)
            strict: Whether to use strict mode
            validate: Whether to validate the response envelope

        Returns:
            Envelope containing the response
        """
        # Get discovery if not already done
        if self._discovery is None:
            try:
                self.discover()
            except LAFSConnectionError:
                # Allow calls without discovery
                pass

        # Build request
        request_data = {"operation": operation}
        if params:
            request_data.update(params)
        if budget:
            request_data["_budget"] = budget
        if strict:
            request_data["_strict"] = True

        # Determine endpoint URL
        if self._discovery:
            url = self._discovery.get_endpoint_url(operation)
        else:
            url = (
                f"{self.base_url}/v1/lafs"
                if self.base_url.startswith("http")
                else f"http://{self.base_url}/v1/lafs"
            )

        # Make request
        response_data = self._make_request(url, method="POST", data=request_data)

        # Parse envelope
        envelope = Envelope.from_dict(response_data)

        # Validate if requested
        if validate:
            errors = self._validator.validate(envelope)
            if errors:
                raise LAFSValidationError(
                    f"Invalid response envelope: {'; '.join(errors)}",
                    code="E_VALIDATION_SCHEMA",
                )

        # Check for error response
        if not envelope.success and envelope.error:
            error = envelope.error
            raise LAFSError(
                f"[{error.get('code')}] {error.get('message')}", status_code=400
            )

        return envelope

    def call_with_budget(
        self,
        operation: str,
        params: Optional[Dict[str, Any]] = None,
        max_tokens: Optional[int] = None,
        max_items: Optional[int] = None,
        max_bytes: Optional[int] = None,
    ) -> Envelope:
        """Make API call with budget constraints.

        This is a convenience wrapper around call() that constructs
        the budget dictionary from individual constraints.
        """
        budget = {}
        if max_tokens is not None:
            budget["maxTokens"] = max_tokens
        if max_items is not None:
            budget["maxItems"] = max_items
        if max_bytes is not None:
            budget["maxBytes"] = max_bytes

        return self.call(operation, params=params, budget=budget if budget else None)

    def query_context(
        self,
        ledger_id: str,
        mode: str = "full",
        since_version: Optional[int] = None,
        limit: int = 100,
    ) -> Envelope:
        """Query context ledger.

        Args:
            ledger_id: The ledger identifier
            mode: Projection mode (full, delta, summary)
            since_version: Starting version for delta mode
            limit: Maximum entries per response
        """
        params = {"ledgerId": ledger_id, "mode": mode, "limit": limit}
        if since_version is not None:
            params["sinceVersion"] = since_version

        return self.call("context.query", params=params)

    def get_capabilities(self) -> Optional[DiscoveryDocument]:
        """Get cached discovery document."""
        return self._discovery
