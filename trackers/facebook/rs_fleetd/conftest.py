"""Put the package on sys.path so `pytest rs_fleetd/tests` works uninstalled.

Like rs-router, rs-fleetd has no third-party dependencies; this lets the suite
collect from the tracker root without a pip install.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
