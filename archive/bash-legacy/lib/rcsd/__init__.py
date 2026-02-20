"""
RCSD Pipeline - Research-Consensus-Spec-Decompose

A Python package for orchestrating multi-agent workflows using the
Anthropic Agent SDK. Implements the 4-stage RCSD Pipeline for transforming
research topics into validated specifications and atomic executable tasks.

Stages:
    1. RESEARCH - Multi-source evidence collection
    2. CONSENSUS - 5-agent adversarial validation
    3. SPEC - Structured specification generation
    4. DECOMPOSE - Atomic task generation with DAG

See: docs/specs/RCSD-PIPELINE-SPEC.md
"""

__version__ = "0.1.0"
__author__ = "CLEO Project"
__license__ = "MIT"

# Version tuple for programmatic access
VERSION = tuple(map(int, __version__.split(".")))

# Package metadata
PACKAGE_NAME = "rcsd"
SPEC_VERSION = "2.0.0"  # RCSD-PIPELINE-SPEC.md version

# Pipeline stages
STAGES = ("research", "consensus", "spec", "decompose")

# Exit codes for RCSD pipeline (30-39 per LLM-AGENT-FIRST-SPEC.md)
EXIT_CODES = {
    "SUCCESS": 0,
    "RESEARCH_FAILED": 30,
    "CONSENSUS_FAILED": 31,
    "CONSENSUS_REJECTED": 32,
    "SPEC_FAILED": 33,
    "SPEC_VALIDATION_FAILED": 34,
    "DECOMPOSE_FAILED": 35,
    "HITL_TIMEOUT": 36,
    "HITL_REJECTED": 37,
    "PIPELINE_ABORTED": 38,
    "INVALID_STAGE": 39,
}

# Public API exports
# These will be populated as modules are implemented
__all__ = [
    # Package metadata
    "__version__",
    "__author__",
    "__license__",
    "VERSION",
    "PACKAGE_NAME",
    "SPEC_VERSION",
    "STAGES",
    "EXIT_CODES",
    # Submodules (lazy imports when available)
    "models",
    "agents",
    "orchestration",
    "output",
    "validation",
    "utils",
]


def get_version() -> str:
    """Return the package version string."""
    return __version__


def get_exit_code(name: str) -> int:
    """
    Get exit code by name.

    Args:
        name: Exit code name (e.g., 'CONSENSUS_FAILED')

    Returns:
        Integer exit code

    Raises:
        KeyError: If exit code name is not defined
    """
    return EXIT_CODES[name]


# Lazy module imports to avoid circular dependencies
# Modules are imported on first access and cached in globals
_SUBMODULES = frozenset({"models", "agents", "orchestration", "output", "validation", "utils"})


def __getattr__(name: str):
    """Lazy import submodules on first access."""
    if name in _SUBMODULES:
        import importlib
        module = importlib.import_module(f".{name}", __name__)
        globals()[name] = module
        return module
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
