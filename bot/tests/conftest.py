import sys
from pathlib import Path

# Make the package importable when tests run from the repository root.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest

pytest_plugins = ("pytest_asyncio",)


def pytest_configure(config):
    config.addinivalue_line("markers", "asyncio: mark an async test")
