"""Put the package on sys.path so `pytest rs_router/tests` works uninstalled.

rs-router has no third-party dependencies and is not pip-installed into the
coordinator venv the suite runs in, so — like running it from its own directory
with PYTHONPATH=. — this makes `from rs_router import ...` resolve when the
tests are collected from the repo root alongside the other packages.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
