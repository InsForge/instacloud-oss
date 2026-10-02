// Holds the routed port from the first second of the container's life.
//
// The compute deploy gives a container 31 seconds to accept a connection on its declared port
// ("the app container started but nothing accepted on port 3000 within 31s"), and Twenty spends
// about a minute creating its schema before it listens at all: the first deploy of this template
// failed exactly there while the app itself was fine. So this answers instead, with a 503, which
// is not a lie about readiness - the health gate reads 503 as not-ready and keeps polling until
// the real server has taken the port over.
//
// entrypoint.sh signals this process just before it starts `node dist/main`.
import { createServer } from 'node:http';

const server = createServer((_req, res) => {
  res.writeHead(503, { 'content-type': 'text/plain', 'retry-after': '10' });
  res.end('twenty is still starting\n');
});

server.listen(Number(process.env.NODE_PORT ?? 3000), '0.0.0.0', () => {
  console.log('boot-listener: holding the port while twenty starts');
});

// Close the listener rather than exiting on the spot, so an in-flight 503 finishes writing and
// the socket is released before the real server tries to bind it.
process.on('SIGTERM', () => server.close(() => process.exit(0)));
