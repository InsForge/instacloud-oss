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
"""Holds the routed port from the first second of the container's life.

The compute deploy gives a container about half a minute to accept a connection on its declared
port before it calls the start a failure, and Superset's first boot spends minutes applying
Alembic migrations before gunicorn binds anything. So this answers instead, with a 503, which is
not a lie about readiness: the health gate reads 503 as not-ready and keeps polling until the
real server has taken the port over.

entrypoint.sh signals this process just before it execs gunicorn.
"""

import os
import signal
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BODY = b"superset is still starting\n"


class Starting(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _reply(self, with_body: bool) -> None:
        self.send_response(503)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(BODY)))
        self.send_header("Retry-After", "10")
        self.end_headers()
        if with_body:
            self.wfile.write(BODY)

    def do_GET(self) -> None:
        self._reply(True)

    def do_HEAD(self) -> None:
        self._reply(False)

    def do_POST(self) -> None:
        self._reply(True)

    def log_message(self, *args: object) -> None:
        """Every probe would otherwise print a line, drowning the migration output."""


def main() -> None:
    ThreadingHTTPServer.allow_reuse_address = True
    server = ThreadingHTTPServer(
        ("0.0.0.0", int(os.environ.get("SUPERSET_PORT", "8088"))), Starting
    )
    # serve_forever runs off the main thread because shutdown() blocks until the serving loop has
    # acknowledged it: called from a signal handler on the serving thread itself it would deadlock.
    threading.Thread(target=server.serve_forever, daemon=True).start()
    print("boot-listener: holding the port while superset starts", flush=True)

    stop = threading.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stop.set())
    stop.wait()

    # Drain rather than exiting on the spot, so an in-flight 503 finishes writing and the socket is
    # released before gunicorn tries to bind it.
    server.shutdown()
    server.server_close()
    print("boot-listener: released the port", flush=True)


if __name__ == "__main__":
    main()
