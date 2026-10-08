#
# Licensed to the Apache Software Foundation (ASF) under one or more
# contributor license agreements.  See the NOTICE file distributed with
# this work for additional information regarding copyright ownership.
# The ASF licenses this file to You under the Apache License, Version 2.0
# (the "License"); you may not use this file except in compliance with
# the License.  You may obtain a copy of the License at
#
#    http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
#
"""Superset's local configuration for the InstaCloud template.

The image puts /app/pythonpath on PYTHONPATH and superset/config.py imports `superset_config`
from there at the end of its own module, so everything set here wins over the defaults.

Only two things are decided here. 6.0.0 has no environment variable for either: the
`SUPERSET__SQLALCHEMY_DATABASE_URI` override exists on master but not in this release, and
ENABLE_PROXY_FIX has never had one.
"""

import os
from urllib.parse import urlsplit, urlunsplit


def _metadata_uri() -> str:
    """The managed postgres bound as DATABASE_URL, as a SQLAlchemy URL.

    Falls back to the SQLite file under SUPERSET_HOME, which is what superset/config.py would
    have chosen anyway, so a deploy with no database service still starts rather than crashing
    on a KeyError.
    """
    raw = os.environ.get("DATABASE_URL", "").strip()
    if not raw:
        data_dir = os.environ.get("SUPERSET_HOME", "/data")
        return f"sqlite:///{os.path.join(data_dir, 'superset.db')}?check_same_thread=false"
    parts = urlsplit(raw)
    # libpq accepts `postgres://`; SQLAlchemy 2 rejects it, and naming the driver keeps the
    # choice out of the "whichever DBAPI imports first" lottery.
    scheme = parts.scheme
    if scheme in ("postgres", "postgresql"):
        scheme = "postgresql+psycopg2"
    return urlunsplit((scheme, parts.netloc, parts.path, parts.query, parts.fragment))


SQLALCHEMY_DATABASE_URI = _metadata_uri()

# A pooled connection to a managed database outlives the lane's idea of the connection, and this
# service is allowed to stop and wake. Checking the connection before handing it out costs one
# round trip and turns a stale-socket 500 into a reconnect. Precaution, not a measured fix.
SQLALCHEMY_ENGINE_OPTIONS = {"pool_pre_ping": True}

# The platform terminates TLS in front of the container and forwards the original scheme and host
# in X-Forwarded-*. Without this, every absolute URL Flask builds (the post-login redirect, the
# links in an exported chart) would name http:// and the container's own port.
ENABLE_PROXY_FIX = True
