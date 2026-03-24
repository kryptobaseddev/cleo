"""LAFS Protocol Python SDK

A complete implementation of the LLM-Agent-First Specification for Python.

This package provides tools for interacting with LAFS-compliant APIs,
including envelope validation, token budget enforcement, and discovery.
"""

from importlib.metadata import version, PackageNotFoundError

from .envelope import Envelope, EnvelopeValidator, LAFSValidationError
from .budget import TokenEstimator, BudgetEnforcer, LAFSBudgetExceeded
from .client import LAFSClient, DiscoveryDocument, LAFSError, LAFSConnectionError

try:
    __version__ = version("lafs")
except PackageNotFoundError:
    __version__ = "0.0.0+local"
__all__ = [
    "Envelope",
    "EnvelopeValidator",
    "LAFSValidationError",
    "TokenEstimator",
    "BudgetEnforcer",
    "LAFSBudgetExceeded",
    "LAFSClient",
    "DiscoveryDocument",
    "LAFSError",
    "LAFSConnectionError",
]
