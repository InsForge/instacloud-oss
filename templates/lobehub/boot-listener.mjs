// Holds the routed port from the first second of the container's life.
//
// The compute deploy gives a container about 31 seconds to accept a connection on its declared
// port, and LobeHub spends longer than that on a fresh database: upstream's launcher runs the
// whole Drizzle migration folder before the Next.js server binds anything. So this answers in the
// meantime, with a 503, which is not a lie about readiness: the health gate reads 503 as not-ready
// and keeps polling until the real server has taken the port over.
//
// entrypoint.sh signals this process once the migrations are done, just before it execs upstream's
// own launcher.
import { createServer } from 'node:http';

const server = createServer((_req, res) => {
  res.writeHead(503, { 'content-type': 'text/plain', 'retry-after': '10' });
  res.end('lobehub is still migrating its database\n');
});

server.listen(Number(process.env.PORT ?? 3210), '0.0.0.0', () => {
  console.log('boot-listener: holding the port while lobehub migrates');
});

// Close rather than exit on the spot, so an in-flight 503 finishes writing. closeAllConnections
// drops the keep-alive sockets a health prober leaves behind, which would otherwise hold the port
// past the moment the real server tries to bind it.
process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
  server.closeAllConnections?.();
  // Nothing may hold this port once the handover starts.
  setTimeout(() => process.exit(0), 2000).unref();
});
