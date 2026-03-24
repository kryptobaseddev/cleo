"""Tests for LAFS client module."""

import pytest
import json
from unittest.mock import patch, MagicMock
import urllib.request
import urllib.error

from lafs.client import (
    LAFSClient,
    DiscoveryDocument,
    LAFSError,
    LAFSConnectionError,
)
from lafs.envelope import Envelope, LAFSValidationError


class TestDiscoveryDocument:
    """Test DiscoveryDocument class."""

    def test_from_dict(self):
        data = {
            "$schema": "https://lafs.dev/schemas/v1/discovery.schema.json",
            "lafs_version": "1.0.0",
            "service": {"name": "test-service", "version": "1.0.0"},
            "capabilities": {
                "protocol": {"versions_supported": ["1.0.0"]},
                "features": {
                    "mvi_levels": ["minimal", "standard"],
                    "pagination_modes": ["cursor", "offset"],
                    "strict_mode": True,
                    "budgets": {"supported": True, "types": ["token"]},
                },
            },
            "endpoints": {
                "base_url": "https://api.example.com",
                "envelope_endpoint": "/v1/lafs",
            },
        }

        doc = DiscoveryDocument.from_dict(data)

        assert doc.lafs_version == "1.0.0"
        assert doc.service["name"] == "test-service"
        assert doc.supports_budget() is True
        assert doc.supports_strict_mode() is True
        assert doc.supports_mvi_level("standard") is True
        assert doc.supports_mvi_level("full") is False

    def test_capability_checks(self):
        doc = DiscoveryDocument(
            schema="",
            lafs_version="1.0.0",
            service={},
            capabilities={
                "features": {
                    "context_ledger": True,
                    "field_selection": False,
                    "expansion": True,
                }
            },
            endpoints={},
        )

        assert doc.supports_context_ledger() is True
        assert doc.supports_field_selection() is False
        assert doc.supports_expansion() is True

    def test_get_endpoint_url(self):
        doc = DiscoveryDocument(
            schema="",
            lafs_version="1.0.0",
            service={},
            capabilities={},
            endpoints={
                "base_url": "https://api.example.com",
                "envelope_endpoint": "/v1/lafs",
                "operations": {
                    "tasks.list": "/v1/tasks",
                    "tasks.get": "/v1/tasks/{id}",
                },
            },
        )

        assert doc.get_endpoint_url() == "https://api.example.com/v1/lafs"
        assert doc.get_endpoint_url("tasks.list") == "https://api.example.com/v1/tasks"
        assert (
            doc.get_endpoint_url("tasks.get") == "https://api.example.com/v1/tasks/{id}"
        )

    def test_to_dict(self):
        doc = DiscoveryDocument(
            schema="https://lafs.dev/schemas/v1/discovery.schema.json",
            lafs_version="1.0.0",
            service={"name": "test"},
            capabilities={},
            endpoints={},
            caching={"ttl_seconds": 3600},
            security={"auth_required": True},
        )

        data = doc.to_dict()

        assert data["$schema"] == doc.schema
        assert data["lafs_version"] == "1.0.0"
        assert data["caching"]["ttl_seconds"] == 3600


class TestLAFSClient:
    """Test LAFSClient class."""

    def test_client_initialization(self):
        client = LAFSClient(
            base_url="https://api.example.com", api_key="test-key", timeout=60.0
        )

        assert client.base_url == "https://api.example.com"
        assert client.api_key == "test-key"
        assert client.timeout == 60.0

    def test_client_default_values(self):
        client = LAFSClient(base_url="https://api.example.com")

        assert client.api_key is None
        assert client.timeout == 30.0
        assert client.verify_ssl is True

    @patch("urllib.request.urlopen")
    def test_discover_success(self, mock_urlopen):
        # Mock successful discovery response
        mock_response = MagicMock()
        discovery_data = {
            "$schema": "https://lafs.dev/schemas/v1/discovery.schema.json",
            "lafs_version": "1.0.0",
            "service": {"name": "test-service", "version": "1.0.0"},
            "capabilities": {
                "protocol": {"versions_supported": ["1.0.0"]},
                "features": {"mvi_levels": ["standard"]},
            },
            "endpoints": {
                "base_url": "https://api.example.com",
                "envelope_endpoint": "/v1/lafs",
                "operations": {
                    "tasks.list": "/v1/tasks",
                    "tasks.get": "/v1/tasks/{id}",
                },
            },
        }
        mock_response.read.return_value = json.dumps(discovery_data).encode()
        mock_urlopen.return_value.__enter__.return_value = mock_response

        client = LAFSClient(base_url="https://api.example.com")
        discovery = client.discover()

        assert discovery.lafs_version == "1.0.0"
        assert discovery.service["name"] == "test-service"
        assert client._discovery is discovery

    @patch("urllib.request.urlopen")
    def test_discover_connection_error(self, mock_urlopen):
        mock_urlopen.side_effect = urllib.error.URLError("Connection refused")

        client = LAFSClient(base_url="https://api.example.com")

        with pytest.raises(LAFSConnectionError) as exc_info:
            client.discover()

        assert "Connection failed" in str(exc_info.value)

    @patch("urllib.request.urlopen")
    def test_call_success(self, mock_urlopen):
        # Mock successful API response
        mock_response = MagicMock()
        response_data = {
            "$schema": "https://lafs.dev/schemas/v1/envelope.schema.json",
            "_meta": {
                "specVersion": "1.0.0",
                "schemaVersion": "1.0.0",
                "timestamp": "2026-01-01T00:00:00Z",
                "operation": "tasks.list",
                "requestId": "req_001",
                "transport": "http",
                "strict": True,
                "mvi": "standard",
                "contextVersion": 0,
            },
            "success": True,
            "result": {"tasks": [{"id": "1", "name": "Task 1"}]},
        }
        mock_response.read.return_value = json.dumps(response_data).encode()
        mock_urlopen.return_value.__enter__.return_value = mock_response

        client = LAFSClient(base_url="https://api.example.com")
        # Set discovery to avoid auto-discovery
        client._discovery = DiscoveryDocument(
            schema="",
            lafs_version="1.0.0",
            service={},
            capabilities={},
            endpoints={
                "base_url": "https://api.example.com",
                "envelope_endpoint": "/v1/lafs",
                "operations": {"tasks.list": "/v1/tasks"},
            },
        )
        envelope = client.call("tasks.list")

        assert envelope.success is True
        assert envelope.result["tasks"][0]["name"] == "Task 1"

    @patch("urllib.request.urlopen")
    def test_call_error_response(self, mock_urlopen):
        # Mock error response
        mock_response = MagicMock()
        response_data = {
            "$schema": "https://lafs.dev/schemas/v1/envelope.schema.json",
            "_meta": {
                "specVersion": "1.0.0",
                "schemaVersion": "1.0.0",
                "timestamp": "2026-01-01T00:00:00Z",
                "operation": "tasks.get",
                "requestId": "req_002",
                "transport": "http",
                "strict": True,
                "mvi": "standard",
                "contextVersion": 0,
            },
            "success": False,
            "error": {
                "code": "E_NOT_FOUND",
                "message": "Task not found",
                "category": "NOT_FOUND",
                "retryable": False,
                "retryAfterMs": None,
                "details": {"taskId": "999"},
            },
        }
        mock_response.read.return_value = json.dumps(response_data).encode()
        mock_urlopen.return_value.__enter__.return_value = mock_response

        client = LAFSClient(base_url="https://api.example.com")
        # Set discovery to avoid auto-discovery
        client._discovery = DiscoveryDocument(
            schema="",
            lafs_version="1.0.0",
            service={},
            capabilities={},
            endpoints={
                "base_url": "https://api.example.com",
                "envelope_endpoint": "/v1/lafs",
                "operations": {"tasks.get": "/v1/tasks/{id}"},
            },
        )

        with pytest.raises(LAFSError) as exc_info:
            client.call("tasks.get", params={"id": "999"})

        assert "[E_NOT_FOUND]" in str(exc_info.value)
        assert "Task not found" in str(exc_info.value)

    @patch("urllib.request.urlopen")
    def test_call_with_budget(self, mock_urlopen):
        mock_response = MagicMock()
        response_data = {
            "$schema": "https://lafs.dev/schemas/v1/envelope.schema.json",
            "_meta": {
                "specVersion": "1.0.0",
                "schemaVersion": "1.0.0",
                "timestamp": "2026-01-01T00:00:00Z",
                "operation": "tasks.list",
                "requestId": "req_003",
                "transport": "http",
                "strict": True,
                "mvi": "standard",
                "contextVersion": 0,
            },
            "success": True,
            "result": {"tasks": []},
        }
        mock_response.read.return_value = json.dumps(response_data).encode()
        mock_urlopen.return_value.__enter__.return_value = mock_response

        client = LAFSClient(base_url="https://api.example.com")
        # Set discovery to avoid auto-discovery
        client._discovery = DiscoveryDocument(
            schema="",
            lafs_version="1.0.0",
            service={},
            capabilities={},
            endpoints={
                "base_url": "https://api.example.com",
                "envelope_endpoint": "/v1/lafs",
                "operations": {"tasks.list": "/v1/tasks"},
            },
        )
        envelope = client.call("tasks.list", budget={"maxTokens": 100, "maxItems": 10})

        assert envelope.success is True

    @patch("urllib.request.urlopen")
    def test_call_with_budget_convenience(self, mock_urlopen):
        mock_response = MagicMock()
        response_data = {
            "$schema": "https://lafs.dev/schemas/v1/envelope.schema.json",
            "_meta": {
                "specVersion": "1.0.0",
                "schemaVersion": "1.0.0",
                "timestamp": "2026-01-01T00:00:00Z",
                "operation": "tasks.list",
                "requestId": "req_004",
                "transport": "http",
                "strict": True,
                "mvi": "standard",
                "contextVersion": 0,
            },
            "success": True,
            "result": {"tasks": []},
        }
        mock_response.read.return_value = json.dumps(response_data).encode()
        mock_urlopen.return_value.__enter__.return_value = mock_response

        client = LAFSClient(base_url="https://api.example.com")
        # Set discovery to avoid auto-discovery
        client._discovery = DiscoveryDocument(
            schema="",
            lafs_version="1.0.0",
            service={},
            capabilities={},
            endpoints={
                "base_url": "https://api.example.com",
                "envelope_endpoint": "/v1/lafs",
                "operations": {"tasks.list": "/v1/tasks"},
            },
        )
        envelope = client.call_with_budget(
            "tasks.list", max_tokens=100, max_items=10, max_bytes=1024
        )

        assert envelope.success is True

    @patch("urllib.request.urlopen")
    def test_call_invalid_envelope(self, mock_urlopen):
        # Mock invalid envelope response (missing required fields)
        mock_response = MagicMock()
        response_data = {"success": True}  # Missing required fields
        mock_response.read.return_value = json.dumps(response_data).encode()
        mock_urlopen.return_value.__enter__.return_value = mock_response

        client = LAFSClient(base_url="https://api.example.com")
        # Set discovery to avoid auto-discovery
        client._discovery = DiscoveryDocument(
            schema="",
            lafs_version="1.0.0",
            service={},
            capabilities={},
            endpoints={
                "base_url": "https://api.example.com",
                "envelope_endpoint": "/v1/lafs",
                "operations": {"tasks.list": "/v1/tasks"},
            },
        )

        with pytest.raises(LAFSValidationError) as exc_info:
            client.call("tasks.list")

        assert "Invalid response envelope" in str(exc_info.value)

    @patch("urllib.request.urlopen")
    def test_query_context(self, mock_urlopen):
        mock_response = MagicMock()
        response_data = {
            "$schema": "https://lafs.dev/schemas/v1/envelope.schema.json",
            "_meta": {
                "specVersion": "1.0.0",
                "schemaVersion": "1.0.0",
                "timestamp": "2026-01-01T00:00:00Z",
                "operation": "context.query",
                "requestId": "req_005",
                "transport": "http",
                "strict": True,
                "mvi": "standard",
                "contextVersion": 42,
            },
            "success": True,
            "result": {
                "ledgerId": "workflow_abc",
                "mode": "full",
                "version": 42,
                "entries": [],
            },
            "page": {"mode": "offset", "limit": 50, "offset": 0, "hasMore": False},
        }
        mock_response.read.return_value = json.dumps(response_data).encode()
        mock_urlopen.return_value.__enter__.return_value = mock_response

        client = LAFSClient(base_url="https://api.example.com")
        # Set discovery to avoid auto-discovery
        client._discovery = DiscoveryDocument(
            schema="",
            lafs_version="1.0.0",
            service={},
            capabilities={},
            endpoints={
                "base_url": "https://api.example.com",
                "envelope_endpoint": "/v1/lafs",
                "operations": {"context.query": "/v1/context"},
            },
        )
        envelope = client.query_context("workflow_abc", mode="full", limit=50)

        assert envelope.success is True
        assert envelope.result["ledgerId"] == "workflow_abc"

    @patch("urllib.request.urlopen")
    def test_http_error(self, mock_urlopen):
        # Mock HTTP error
        mock_error = urllib.error.HTTPError(
            url="https://api.example.com/v1/lafs",
            code=401,
            msg="Unauthorized",
            hdrs={},
            fp=None,
        )
        mock_urlopen.side_effect = mock_error

        client = LAFSClient(base_url="https://api.example.com")

        with pytest.raises(LAFSError) as exc_info:
            client.call("tasks.list")

        assert exc_info.value.status_code == 401


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
