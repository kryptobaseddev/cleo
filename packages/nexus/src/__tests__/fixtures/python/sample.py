"""
Fixture file for the Python extractor regression tests.

Exercises every node kind: Function, Class (with __init__, method),
plus explicit imports (import, from-import, aliased, relative-style).
"""

import os
import sys
import json
from typing import List, Optional, Dict
from collections import OrderedDict
from pathlib import Path as FsPath
import re as regex

# --- Standalone functions ---

def make_id(raw: str) -> str:
    """Return a normalised identifier string."""
    return raw.strip().lower().replace(" ", "_")


def safe_parse(text: str) -> Optional[Dict]:
    """Parse JSON safely, returning None on failure."""
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return None


def resolve_path(relative: str) -> str:
    """Resolve a path relative to the current working directory."""
    return os.path.join(os.getcwd(), relative)


# --- Base class ---

class BaseRepository:
    """Abstract base for all in-memory domain repositories."""

    def __init__(self, name: str):
        """Initialise with the repository name."""
        self._name = name
        self._items: OrderedDict = OrderedDict()

    def find_all(self) -> List:
        """Return all stored items."""
        return list(self._items.values())

    def save(self, key: str, item) -> None:
        """Persist an item under key."""
        self._items[key] = item

    def delete(self, key: str) -> bool:
        """Remove an item; return True if it existed."""
        if key in self._items:
            del self._items[key]
            return True
        return False

    def count(self) -> int:
        """Return the number of stored items."""
        return len(self._items)


# --- Subclass exercising heritage ---

class UserRepository(BaseRepository):
    """Concrete repository for User domain objects."""

    def __init__(self):
        """Initialise with a fixed name."""
        super().__init__("users")
        self._email_index: Dict[str, str] = {}

    def add_user(self, user_id: str, email: str, user) -> None:
        """Add a user and index by email."""
        self.save(user_id, user)
        self._email_index[email] = user_id

    def find_by_email(self, email: str):
        """Find a user by email address."""
        uid = self._email_index.get(email)
        return self._items.get(uid) if uid else None


# --- A second class hierarchy exercising multi-inheritance ---

class Auditable:
    """Mixin that adds audit timestamps."""

    def __init__(self):
        """Set up audit fields."""
        self._created_at: Optional[str] = None
        self._updated_at: Optional[str] = None

    def mark_created(self, timestamp: str) -> None:
        """Record creation timestamp."""
        self._created_at = timestamp

    def mark_updated(self, timestamp: str) -> None:
        """Record update timestamp."""
        self._updated_at = timestamp


class AuditedRepository(BaseRepository, Auditable):
    """Repository with audit tracking (exercises multi-inheritance heritage)."""

    def __init__(self, name: str):
        """Initialise both parent classes."""
        BaseRepository.__init__(self, name)
        Auditable.__init__(self)

    def save(self, key: str, item) -> None:
        """Save with audit timestamp update."""
        super().save(key, item)
        self.mark_updated("now")


# --- Utility class ---

class PathHelper:
    """Helper for filesystem path manipulation."""

    BASE: str = "/tmp"

    def __init__(self, base: str = "/tmp"):
        """Initialise with base directory."""
        self.base = FsPath(base)

    def resolve(self, relative: str) -> str:
        """Resolve a relative path under base."""
        return str(self.base / relative)

    def exists(self, relative: str) -> bool:
        """Check whether a path exists under base."""
        return (self.base / relative).exists()

    @staticmethod
    def normalise(raw: str) -> str:
        """Normalise path separators."""
        return raw.replace("\\", "/")
