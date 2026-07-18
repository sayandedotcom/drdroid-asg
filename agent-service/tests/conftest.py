import sys
from pathlib import Path

# The service modules live one level up and are imported flat (main.py imports
# `db`, `graph`, ...), matching how Vercel's Python runtime loads the entrypoint.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
