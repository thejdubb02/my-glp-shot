"""Selftest helper: stub a name in the API the way `api.X = stub` used to.

The API was one file (api/app.py), so setting a name on it reached every caller.
Now each feature module binds its own copy of shared names (`from config import
STRIPE_API_KEY`, `from db import now_ts`), so a stub is set on every loaded API
module that has the name, the `app` re-export module included.
"""
import os
import sys

API_DIR = os.path.realpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'api'))


def patch(name, value):
    hit = False
    for mod in list(sys.modules.values()):
        path = getattr(mod, '__file__', None)
        if path and os.path.dirname(os.path.realpath(path)) == API_DIR and hasattr(mod, name):
            setattr(mod, name, value)
            hit = True
    if not hit:
        raise AttributeError(f'no API module has {name!r}')
