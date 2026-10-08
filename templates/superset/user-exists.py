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
"""Prints `yes` when the named account is already in the metadata database, `no` otherwise.

`superset fab create-admin` is not usable as the test: handed a username that exists it prints
`Error! User already exists admin` and then **exits 0**, so the shell cannot tell the two apart.
Asking the database directly is also four seconds cheaper on a restart, because create-admin
builds the whole Flask app before it gets as far as the duplicate.

Never fails: an unreachable or unmigrated database is reported as `no`, which makes the caller
try the creation and surface the real error there.
"""

import sys

from sqlalchemy import create_engine, text

import superset_config  # same module superset/config.py imports, same URL


def main() -> None:
    username = sys.argv[1] if len(sys.argv) > 1 else ""
    try:
        engine = create_engine(superset_config.SQLALCHEMY_DATABASE_URI)
        with engine.connect() as conn:
            row = conn.execute(
                text("SELECT 1 FROM ab_user WHERE username = :u"), {"u": username}
            ).scalar()
        print("yes" if row else "no")
    except Exception as exc:  # noqa: BLE001 - any failure means "let create-admin report it"
        print(f"user-exists: {type(exc).__name__}: {exc}", file=sys.stderr)
        print("no")


if __name__ == "__main__":
    main()
