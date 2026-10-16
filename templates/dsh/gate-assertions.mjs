// Every property the sign-in gate in front of dsh is supposed to have, as assertions against a
// running container. The README and the QA row both say to re-test on a DSH_VERSION bump, and
// the pinned upstream is a release candidate whose transitive ranges float, so that is a
// scheduled event rather than a hypothetical. This is what to run.
//
//   ADMIN_USERNAME=... ADMIN_PASSWORD=... node gate-assertions.mjs http://127.0.0.1:8080
//   ADMIN_USERNAME=... ADMIN_PASSWORD=... node gate-assertions.mjs https://your-deployment.example.com
//
// Needs the harness actually serving behind the gate, not just the gate: a signed-in request
// answers 502 until dsh is listening, which the health check does not catch (QA.md finding 8).
// No dependencies, and it prints no secret.
import { connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";

const BASE = process.argv[2];
const USERNAME = process.env.ADMIN_USERNAME;
const PASSWORD = process.env.ADMIN_PASSWORD;
if (!BASE || !USERNAME || !PASSWORD) {
  console.error("usage: ADMIN_USERNAME=... ADMIN_PASSWORD=... node gate-assertions.mjs <base-url>");
  process.exit(2);
}
const url = new URL(BASE);
const TLS = url.protocol === "https:";
const HOST = url.hostname;
const PORT = Number(url.port || (TLS ? 443 : 80));
const AUTHORITY = url.port ? `${HOST}:${url.port}` : HOST;
const SELF = `${url.protocol}//${AUTHORITY}`;
// The gate's session cookie is `__Host-` prefixed over https, and plain on http.
const COOKIE_NAME = TLS ? "__Host-insta_gate" : "insta_gate";
const FORGED = `${COOKIE_NAME}=forged.0.0`;
const FOREIGN = "https://sibling.example.com";
// Same host and port, other scheme. A different origin, and cookies do not distinguish the two.
const OTHER_SCHEME = `${TLS ? "http" : "https"}://${AUTHORITY}`;

let passed = 0;
let failed = 0;
const check = (name, want, got) => {
  const ok = String(want) === String(got);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name} -> ${got}${ok ? "" : `   (want ${want})`}`);
  if (ok) passed++;
  else failed++;
};
// For a decision this gate owns while the answer after it is upstream's to change.
// A real status only: a probe that errors or times out must not read as "not 401".
const checkNot = (name, unwanted, got) => {
  const ok = Number.isInteger(got) && String(unwanted) !== String(got);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name} -> ${got}${ok ? "" : `   (must be a status other than ${unwanted})`}`);
  if (ok) passed++;
  else failed++;
};

// Raw sockets throughout, because an upgrade cannot be expressed with fetch.
// A plain request sends `Connection: close` and is read to the end, so an assertion about a
// header or an RPC body cannot pass or fail on where the packets happened to split. An upgrade
// has no end to wait for, so that one stops once the headers are complete.
const raw = (lines, readToEnd) =>
  new Promise((resolve) => {
    const opts = { host: HOST, port: PORT, servername: HOST, ALPNProtocols: ["http/1.1"] };
    const socket = TLS ? tlsConnect(opts, send) : netConnect(PORT, HOST, send);
    function send() { socket.write(lines.join("\r\n")) }
    let buf = "";
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ code: code ?? Number(buf.split(" ")[1]), text: buf });
    };
    socket.on("data", (d) => {
      buf += d;
      if (!readToEnd && buf.includes("\r\n\r\n")) finish();
    });
    socket.on("end", () => finish());
    socket.on("error", (e) => finish(`ERR ${e.message}`));
    setTimeout(() => finish("TIMEOUT"), 20000);
  });

const req = (method, path, headers = {}, body = "", type = "application/json") =>
  raw([`${method} ${path} HTTP/1.1`, `Host: ${AUTHORITY}`, "Connection: close",
    ...(body ? [`Content-Length: ${Buffer.byteLength(body)}`, `Content-Type: ${type}`] : []),
    ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), "", body], true);

const upgrade = (path, headers = {}, value = "websocket") =>
  raw([`GET ${path} HTTP/1.1`, `Host: ${AUTHORITY}`, `Upgrade: ${value}`, "Connection: Upgrade",
    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version: 13",
    ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), "", ""], false);

const signIn = (password) =>
  req("POST", "/_insta/sign-in", { Origin: SELF },
    new URLSearchParams({ username: USERNAME, password, next: "/" }).toString(),
    "application/x-www-form-urlencoded");

console.log("== the sign-in page ==");
check("GET / from a browser with no session", 200,
  (await req("GET", "/", { Accept: "text/html" })).code);
check("GET / from anything else with no session", 401, (await req("GET", "/")).code);
check("a wrong password", 401, (await signIn("definitely-not-it")).code);
const signedIn = await signIn(PASSWORD);
check("the right password", 303, signedIn.code);
const cookie = (signedIn.text.match(new RegExp(`set-cookie: (${COOKIE_NAME}=[^;\\r\\n]+)`, "i")) ?? [])[1];
check(`  sets ${COOKIE_NAME}`, true, cookie !== undefined);
check("  HttpOnly", true, /set-cookie:[^\r\n]*HttpOnly/i.test(signedIn.text));
check("  SameSite=Lax", true, /set-cookie:[^\r\n]*SameSite=Lax/i.test(signedIn.text));
check("  Secure over https only", TLS, /set-cookie:[^\r\n]*;\s*Secure/i.test(signedIn.text));
const COOKIE = cookie ?? "";
const page = await req("GET", "/", { Cookie: COOKIE });
check("GET / with the session", 200, page.code);
check("  not framed by another page", true, /x-frame-options: SAMEORIGIN/i.test(page.text));
check("  frame-ancestors 'self'", true, /content-security-policy:[^\r\n]*frame-ancestors 'self'/i.test(page.text));
check("GET / on a forged session", 401, (await req("GET", "/", { Cookie: FORGED })).code);

console.log("\n== the two event streams, from this deployment's own origin ==");
for (const ep of ["events.host", "events.mux"]) {
  check(`${ep} with the session`, 101, (await upgrade(`/api/${ep}`, { Cookie: COOKIE, Origin: SELF })).code);
  check(`${ep} with no Origin at all`, 101, (await upgrade(`/api/${ep}`, { Cookie: COOKIE })).code);
  check(`${ep} with no session`, 401, (await upgrade(`/api/${ep}`, { Origin: SELF })).code);
  check(`${ep} on a forged session`, 401, (await upgrade(`/api/${ep}`, { Cookie: FORGED, Origin: SELF })).code);
}

// Not scoped to the two event paths on purpose: what refuses an upgrade elsewhere is upstream,
// which has nothing to upgrade on any other path, so the gate does not name paths it would then
// have to track across an upstream rename.
console.log("\n== the session is not path-scoped, and upstream is what makes that fine ==");
checkNot("an upgrade off the event paths passes the gate", 401,
  (await upgrade("/", { Cookie: COOKIE, Origin: SELF })).code);
check("the same upgrade with no session", 401, (await upgrade("/", { Origin: SELF })).code);

console.log("\n== a handshake another page sends is refused ==");
for (const [name, origin] of [
  ["a sibling deployment", FOREIGN],
  ["a host-prefix lookalike", `https://${HOST}.example.com`],
  ["this host on another port", `http://${HOST}:3000`],
  ["this host on the other scheme", OTHER_SCHEME],
  ["an opaque origin", "null"],
]) {
  check(`${name}`, 403, (await upgrade("/api/events.host", { Cookie: COOKIE, Origin: origin })).code);
}
check("a mixed-case Upgrade header too", 403,
  (await upgrade("/api/events.host", { Cookie: COOKIE, Origin: FOREIGN }, "WebSocket")).code);

const rpc = (method, payload = {}, headers = {}) =>
  req("POST", `/api/${method}`, { Cookie: COOKIE, ...headers },
    JSON.stringify({ type: "client-request", rpcId: "1", method, payload }));

console.log("\n== CSRF: a state change another page sends is refused ==");
check("cross-origin POST", 403, (await rpc("settings.describe", {}, { Origin: FOREIGN })).code);
check("cross-origin POST claiming same-origin", 403,
  (await rpc("settings.describe", {}, { Origin: FOREIGN, "Sec-Fetch-Site": "same-origin" })).code);
check("cross-scheme POST", 403, (await rpc("settings.describe", {}, { Origin: OTHER_SCHEME })).code);
check("POST with no Origin, from a same-site page", 403,
  (await rpc("settings.describe", {}, { "Sec-Fetch-Site": "same-site" })).code);
check("same-origin POST", 200, (await rpc("settings.describe", {}, { Origin: SELF })).code);
check("POST with no Origin (curl, this script)", 200, (await rpc("settings.describe")).code);
check("a cross-origin GET is only session-gated", 200,
  (await req("GET", "/", { Cookie: COOKIE, Origin: FOREIGN })).code);

console.log("\n== the privileged plane, through the Host and Origin rewrite ==");
for (const [method, payload] of [
  ["settings.describe", {}],
  ["credentials.describe", { refs: [] }],
  ["llm.providers", {}],
  ["llm.models", {}],
]) {
  const r = await rpc(method, payload, { Origin: SELF });
  check(`${method} answers ok`, true, r.text.includes('"ok":true'));
}

console.log(`\n${failed === 0 ? "ALL PASS" : "FAILURES"}: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
