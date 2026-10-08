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
"""Prints the metadata database's current Alembic revision, or `none`.

entrypoint.sh reads this on either side of `superset db upgrade` and only runs `superset init`
when the two differ. `superset db current` would answer the same question, but it builds the
whole Flask app to do it, which is twenty seconds this has to spend twice on a boot where the
answer is usually "nothing changed".

Never fails: an unreachable or empty database is reported as `none`, which makes the caller treat
the boot as a first one and do the full setup.
"""

import sys

from sqlalchemy import create_engine, text

import superset_config  # same module superset/config.py imports, same URL


def main() -> None:
    try:
        engine = create_engine(superset_config.SQLALCHEMY_DATABASE_URI)
        with engine.connect() as conn:
            row = conn.execute(text("SELECT version_num FROM alembic_version")).scalar()
        print(row or "none")
    except Exception as exc:  # noqa: BLE001 - any failure means "treat this as a fresh database"
        print(f"db-revision: {type(exc).__name__}: {exc}", file=sys.stderr)
        print("none")


if __name__ == "__main__":
    main()
