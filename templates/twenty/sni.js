// Makes every outbound TLS connection this process opens send SNI.
//
// The managed Redis lane puts many databases behind one TLS port and picks yours out of the
// handshake's server_name. A client that omits it completes the handshake and is then dropped with
// no error on either side, which for a BullMQ client configured with `maxRetriesPerRequest: null`
// (Twenty's own setting, and BullMQ's requirement) is an await that never returns.
//
// Node only sends SNI when the caller passes `servername`, and both Redis clients Twenty builds
// hand a `rediss://` URL to their library and pass no TLS options at all:
// `RedisClientService` does `new IORedis(redisUrl, { maxRetriesPerRequest: null })` and the
// cache-storage factory does `createClient({ url: redisUrl })`. Neither exposes a knob for it, so
// this is preloaded with `NODE_OPTIONS=--require /insta-sni.js` instead, set in the manifest on
// both the server and the worker.
//
// Measured before and after on the deployed container, with Twenty's own clients: without this,
// ioredis emits `connect` then `close` and no error; with it, `PING` answers `PONG`.
//
// It only fills in a blank. A caller that already set `servername` is left alone, and an IP
// literal is skipped because SNI may not carry one.
const tls = require('tls');
const net = require('net');

const connect = tls.connect;
tls.connect = function (...args) {
  const o = args.find((a) => a && typeof a === 'object' && !Buffer.isBuffer(a));
  if (o && !o.servername && o.host && !net.isIP(o.host)) o.servername = o.host;
  return connect.apply(this, args);
};
