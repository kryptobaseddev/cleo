"""LAFS Token Budget Signaling implementation.

Implements Section 9.4 of the LAFS specification for token budget enforcement.
"""

from typing import Any, Dict, List, Optional, Set, Tuple
import json
import unicodedata
import sys


class LAFSBudgetExceeded(Exception):
    """Raised when an operation exceeds the declared token budget.

    This corresponds to error code E_MVI_BUDGET_EXCEEDED from the spec.
    """

    def __init__(
        self,
        message: str,
        estimated_tokens: int,
        budget: int,
        constraint: str = "maxTokens",
        details: Optional[Dict] = None,
    ):
        self.estimated_tokens = estimated_tokens
        self.budget = budget
        self.excess_tokens = estimated_tokens - budget
        self.constraint = constraint
        self.details = details or {}
        super().__init__(message)

    def to_error_dict(self) -> Dict[str, Any]:
        """Convert to LAFS error format."""
        return {
            "code": "E_MVI_BUDGET_EXCEEDED",
            "message": str(self),
            "category": "VALIDATION",
            "retryable": True,
            "retryAfterMs": None,
            "details": {
                "estimatedTokens": self.estimated_tokens,
                "budget": self.budget,
                "excessTokens": self.excess_tokens,
                "constraint": self.constraint,
                "suggestion": f"Increase maxTokens to at least {self.estimated_tokens + 100} or use pagination",
                **self.details,
            },
        }


class TokenEstimator:
    """Estimates token count for LAFS responses.

    Implements the normative token estimation algorithm from Section 9.4.6
    of the LAFS specification.
    """

    DEFAULT_RATIO = 4.0
    MAX_DEPTH = 20

    def __init__(self, ratio: float = DEFAULT_RATIO, max_depth: int = MAX_DEPTH):
        """Initialize token estimator.

        Args:
            ratio: Character-to-token ratio (default 4.0)
            max_depth: Maximum recursion depth to prevent DoS
        """
        self.ratio = ratio
        self.max_depth = max_depth

    def estimate(
        self, value: Any, depth: int = 0, _seen: Optional[Set[int]] = None
    ) -> int:
        """Estimate token count for any value.

        Implements the algorithm from LAFS Section 9.4.6.
        """
        if _seen is None:
            _seen = set()

        # Depth protection
        if depth > self.max_depth:
            return sys.maxsize  # Effectively infinity

        # Handle circular references
        if isinstance(value, (dict, list)):
            obj_id = id(value)
            if obj_id in _seen:
                return 1
            _seen = _seen | {obj_id}

        # Null values
        if value is None:
            return 1

        # Boolean values
        if isinstance(value, bool):
            return 1

        # Numeric values
        if isinstance(value, (int, float)):
            # ~1 token per 4 digits
            return max(1, (len(str(value)) + 3) // 4)

        # String values
        if isinstance(value, str):
            graphemes = self._count_graphemes(value)
            return max(1, int(graphemes / self.ratio))

        # Array values
        if isinstance(value, list):
            tokens = 2  # Opening and closing brackets
            for i, item in enumerate(value):
                tokens += self.estimate(item, depth + 1, _seen)
                if i < len(value) - 1:
                    tokens += 1  # Comma separator
            return tokens

        # Object values
        if isinstance(value, dict):
            tokens = 2  # Opening and closing braces
            items = list(value.items())
            for i, (key, val) in enumerate(items):
                # Key is always a string
                tokens += self.estimate(str(key), depth + 1, _seen)
                tokens += 2  # Colon and comma
                tokens += self.estimate(val, depth + 1, _seen)
            return tokens

        return 0

    def estimate_json(self, json_str: str) -> int:
        """Estimate token count from a JSON string."""
        try:
            value = json.loads(json_str)
            return self.estimate(value)
        except json.JSONDecodeError as e:
            raise ValueError(f"Invalid JSON: {e}")

    def _count_graphemes(self, text: str) -> int:
        """Count grapheme clusters in a string.

        Uses Unicode grapheme segmentation when available.
        Falls back to character count for ASCII strings.
        """
        # Fast path for ASCII strings
        if text.isascii():
            return len(text)

        # Use Python's unicodedata for grapheme counting
        # This is a simplified implementation - full grapheme clustering
        # would require the grapheme package, but we approximate here
        count = 0
        i = 0
        while i < len(text):
            current = text[i]
            count += 1
            i += 1
            # Absorb subsequent combining characters
            while i < len(text) and unicodedata.combining(text[i]):
                i += 1
        return count


class BudgetEnforcer:
    """Enforces token budget constraints on LAFS responses.

    Implements Section 9.4 of the LAFS specification.
    """

    def __init__(
        self,
        budget: int,
        estimator: Optional[TokenEstimator] = None,
        max_items: Optional[int] = None,
        max_bytes: Optional[int] = None,
    ):
        """Initialize budget enforcer.

        Args:
            budget: Maximum token budget
            estimator: TokenEstimator instance (creates default if None)
            max_items: Optional maximum items constraint
            max_bytes: Optional maximum bytes constraint
        """
        self.budget = budget
        self.estimator = estimator or TokenEstimator()
        self.max_items = max_items
        self.max_bytes = max_bytes

    def enforce(self, envelope: Dict[str, Any]) -> Dict[str, Any]:
        """Enforce budget constraints on an envelope.

        Returns the potentially modified envelope if within budget.
        Raises LAFSBudgetExceeded if budget cannot be met.
        """
        # Get the result from the envelope
        result = envelope.get("result")
        if result is None:
            return envelope

        # Check maxItems constraint for lists
        if self.max_items is not None and isinstance(result, list):
            if len(result) > self.max_items:
                result = result[: self.max_items]
                envelope["result"] = result
                envelope.setdefault("_meta", {}).setdefault("warnings", []).append(
                    {
                        "code": "E_MVI_BUDGET_TRUNCATED",
                        "message": f"List truncated from {len(result)} to {self.max_items} items",
                        "details": {
                            "requestedItems": self.max_items,
                            "actualItems": len(result),
                        },
                    }
                )

        # Check maxBytes constraint
        if self.max_bytes is not None:
            json_str = json.dumps(envelope)
            byte_size = len(json_str.encode("utf-8"))
            if byte_size > self.max_bytes:
                raise LAFSBudgetExceeded(
                    f"Response size {byte_size} bytes exceeds maxBytes budget of {self.max_bytes}",
                    estimated_tokens=byte_size // 4,  # Rough estimate
                    budget=self.max_bytes,
                    constraint="maxBytes",
                    details={"estimatedBytes": byte_size},
                )

        # Check token budget
        estimated = self.estimator.estimate(result)

        if estimated > self.budget:
            # Try to truncate
            truncated = self._truncate_to_budget(result, self.budget)
            truncated_estimate = self.estimator.estimate(truncated)

            if truncated_estimate <= self.budget:
                # Truncation successful
                envelope["result"] = truncated
                envelope.setdefault("_meta", {}).setdefault("warnings", []).append(
                    {
                        "code": "E_MVI_BUDGET_TRUNCATED",
                        "message": "Response truncated to fit token budget",
                        "details": {
                            "requestedBudget": self.budget,
                            "estimatedTokens": estimated,
                            "truncatedTokens": truncated_estimate,
                            "truncationStrategy": "depth_first",
                        },
                    }
                )
            else:
                # Cannot truncate enough
                raise LAFSBudgetExceeded(
                    f"Response exceeds declared token budget of {self.budget} tokens",
                    estimated_tokens=estimated,
                    budget=self.budget,
                    constraint="maxTokens",
                )

        # Add token estimate metadata
        envelope.setdefault("_meta", {})["_tokenEstimate"] = {
            "estimated": self.estimator.estimate(envelope["result"]),
            "budget": self.budget,
            "method": "character_based",
        }

        return envelope

    def _truncate_to_budget(self, value: Any, budget: int, depth: int = 0) -> Any:
        """Truncate value to fit within token budget."""
        estimate = self.estimator.estimate(value, depth)

        if estimate <= budget:
            return value

        # Handle lists - truncate items
        if isinstance(value, list):
            truncated = []
            current_budget = budget - 2  # Account for []

            for item in value:
                item_estimate = self.estimator.estimate(item, depth + 1)
                if item_estimate + 1 <= current_budget:
                    truncated.append(item)
                    current_budget -= item_estimate + 1
                else:
                    break

            return truncated

        # Handle dicts - keep essential fields only
        if isinstance(value, dict):
            essential = ["id", "name", "success", "code", "message"]
            truncated = {}
            current_budget = budget - 2  # Account for {}

            # First pass: essential fields
            for key in essential:
                if key in value:
                    val = value[key]
                    val_estimate = self.estimator.estimate(val, depth + 1)
                    key_tokens = max(1, len(key) // 4) + 2  # Key + colon + comma
                    if val_estimate + key_tokens <= current_budget:
                        truncated[key] = val
                        current_budget -= val_estimate + key_tokens

            return truncated

        # Handle strings - truncate with ellipsis
        if isinstance(value, str):
            chars_to_keep = int((budget - 2) * self.estimator.ratio)
            if len(value) > chars_to_keep:
                return value[:chars_to_keep] + "..."
            return value

        return value

    def check_budget(self, value: Any) -> Tuple[bool, int]:
        """Check if value is within budget without enforcing.

        Returns:
            Tuple of (is_within_budget, estimated_tokens)
        """
        estimated = self.estimator.estimate(value)
        return estimated <= self.budget, estimated
