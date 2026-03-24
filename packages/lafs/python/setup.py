"""Setup script for lafs package."""

import json
from pathlib import Path
from setuptools import setup, find_packages

with open("README.md", "r", encoding="utf-8") as fh:
    long_description = fh.read()


def read_lafs_version() -> str:
    """Single source of truth: root package.json version."""
    root_package_json = Path(__file__).resolve().parent.parent / "package.json"
    with root_package_json.open("r", encoding="utf-8") as fp:
        return json.load(fp)["version"]


setup(
    name="lafs",
    version=read_lafs_version(),
    author="LAFS Protocol Team",
    author_email="contact@lafs.dev",
    description="Python SDK for the LLM-Agent-First Specification (LAFS)",
    long_description=long_description,
    long_description_content_type="text/markdown",
    url="https://github.com/lafs/lafs-python",
    packages=find_packages(),
    classifiers=[
        "Development Status :: 5 - Production/Stable",
        "Intended Audience :: Developers",
        "License :: OSI Approved :: MIT License",
        "Operating System :: OS Independent",
        "Programming Language :: Python :: 3",
        "Programming Language :: Python :: 3.8",
        "Programming Language :: Python :: 3.9",
        "Programming Language :: Python :: 3.10",
        "Programming Language :: Python :: 3.11",
        "Programming Language :: Python :: 3.12",
        "Programming Language :: Python :: 3.13",
        "Programming Language :: Python :: 3.14",
        "Topic :: Software Development :: Libraries :: Python Modules",
        "Topic :: Internet :: WWW/HTTP",
    ],
    python_requires=">=3.8",
    install_requires=[
        # No external dependencies - uses only standard library
    ],
    extras_require={
        "dev": [
            "pytest>=7.0.0",
            "pytest-cov>=4.0.0",
            "black>=23.0.0",
            "mypy>=1.0.0",
        ],
    },
    keywords="lafs llm agent api protocol envelope budget",
    project_urls={
        "Bug Reports": "https://github.com/kryptobaseddev/lafs/issues",
        "Source": "https://github.com/kryptobaseddev/lafs",
        "Documentation": "https://codluv.gitbook.io/lafs/",
        "Homepage": "https://codluv.gitbook.io/lafs/",
    },
)
