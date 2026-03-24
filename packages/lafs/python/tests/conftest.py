# conftest.py for pytest configuration
import sys
import os

# Add the parent directory to the path so we can import lafs
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
