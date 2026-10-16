#!/usr/bin/env node
// Prototype executor: insta.template.yaml -> existing insta CLI pipeline.
// Steps (per design doc): parse manifest -> create services -> run generators
// -> resolve cross-service refs -> write variables -> deploy (stamp
// template@version attribution) -> poll healthy -> report URL.
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import yaml from "js-yaml";
import { valueSource } from "./variables-lib.mjs";
import { FIXED_REF_RE, checkFixedRef } from "./manifest-refs.mjs";
import { waitUntilUp } from "./health-lib.mjs";

const args = process.argv.slice(2);
const dir = resolve(args[0] ?? ".");
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const branch = flag("--branch");
const sets = Object.fromEntries(
  args.flatMap((a, i) => (a === "--set" ? [args[i + 1].split(/=(.*)/s).slice(0, 2)] : [])),
);
// Values that must never reach stdout/stderr: caller-supplied --set inputs and everything a
// generator mints. Manifest `fixed` values are public (they live in the repo) and stay readable.
// Declared before the first fail(): every print path runs through redact().
const secretValues = new Set(Object.values(sets).filter(Boolean));
if (!branch) fail("usage: deploy.mjs <template-dir> --branch <b> [--set K=V ...]");

// [1/8] parse manifest
const manifest = yaml.load(readFileSync(join(dir, "insta.template.yaml"), "utf8"));
const services = Object.entries(manifest.services ?? {});
if (!services.length) fail("manifest has no services");
step(1, `parsed ${manifest.code}@${manifest.version}: ${services.length} service(s)`);

// [2/8] run generators (declare-once, reference-many: Dokploy style)
const generated = {};
for (const [name, spec] of Object.entries(manifest.generated ?? {})) {
  generated[name] = genValue(spec);
}
step(2, `generated ${Object.keys(generated).length} value(s)`);

// [3/8] create services
// Deliberately WITHOUT --image. The platform deploys the image the moment a compute service names
// one (services.ts, since insta-platform 9966f46 "services add --image runs the image at
// creation", 2026-07-20), which here is two steps before the variables exist, so any template
// whose entrypoint requires one crash-loops on that first boot.
//
// This script was written a MONTH AFTER that platform change (28fa4b3, 2026-08-21) and carried
// --image from its first line, so `npm run deploy -- claude-code` has never once worked. Verified
// against main: 0.5.0 with ACCESS_PASSWORD fails identically, "never answered on port 7681 ...
// exit code 1". It went unnoticed because the real deploy paths use the platform's own executor,
// which creates the service with NO image and deploys as a later step, and the only template run
// through here since (n8n) boots from an upstream image needing no variable.
//
// Step 6 owns the deploy now, after step 5 has written the variables, and passes the same --image.
for (const [name, svc] of services) {
  const cmd = ["services", "add", "compute", name, "--branch", branch, "--port", String(svc.port ?? 8080)];
  // `services add` cannot ask for the platform's size, so a dev deploy takes the smallest
  // allowance. The real executor picks the real one.
  if (svc.volume) cmd.push("--volume", "1");
  try {
    insta(cmd);
  } catch (e) {
    if (!String(e.stderr ?? e).includes("already exists")) throw e;
    log(`   service ${name} already exists: idempotent, continuing`);
  }
}
step(3, "services created");

// [4/8] resolve cross-service refs (all services now have addresses)
// `services add` assigns the domain, so every address is known BEFORE anything deploys — the same
// ordering the platform uses, where computeAppUrl derives the URL from the allocated app name
// rather than looking one up after the fact.
const listRaw = insta(["services", "list", "--branch", branch, "--json"]);
// Slice from the first `[`: an update-available banner on stdout would otherwise fail the parse.
const addr = new Map(
  JSON.parse(listRaw.slice(listRaw.indexOf("[")))
    .filter((s) => s.domain)
    .map((s) => [s.name, { url: `https://${s.domain}`, host: s.domain }]),
);
step(4, `resolved addresses for ${addr.size} service(s)`);

// [5/8] assemble + write variables
const deploymentId = randomUUID();
for (const [name, svc] of services) {
  const env = Object.fromEntries(
    Object.entries(svc.env?.fixed ?? {}).map(([k, v]) => [k, resolveFixed(String(v), `${name}: env.fixed.${k}`, k)]),
  );
  for (const [k, ref] of Object.entries(svc.env?.generated ?? {})) {
    const key = String(ref).replace(/^\$\{(.+)\}$/, "$1");
    if (!(key in generated)) fail(`env.generated.${k} references undeclared generator '${key}'`);
    env[k] = generated[key];
  }
  // valueSource carries the platform's order (provided -> generate -> default). Required and
  // optional differ only in what happens when nothing resolves: the first stops the run, the
  // second stays unset.
  for (const [group, required] of [["required", true], ["optional", false]]) {
    for (const [k, spec] of Object.entries(svc.env?.[group] ?? {})) {
      const source = valueSource(spec, sets[k]);
      if (source === "provided") env[k] = sets[k];
      else if (source === "generate") env[k] = genValue(spec.generate);
      else if (source === "default") env[k] = String(spec.default);
      else if (required) fail(`required variable ${k} missing: pass --set ${k}=...  (${spec?.description ?? ""})`);
    }
  }
  // attribution stamp (design doc: template@version + deployment_id, recorded
  // on the service; platform field pending: prototype stamps via env)
  env.TEMPLATE_CODE = manifest.code;
  env.TEMPLATE_VERSION = manifest.version;
  env.TEMPLATE_DEPLOYMENT_ID = deploymentId;
  for (const [k, v] of Object.entries(env)) insta(["secrets", "set", k, String(v), "--branch", branch]);
  log(`   ${name}: wrote ${Object.keys(env).length} variables (incl. attribution stamp)`);
}
step(5, `variables written: deployment_id ${deploymentId}`);

// [6/8] deploy (build path when Dockerfile declared, else image pull)
const urls = {};
for (const [name, svc] of services) {
  // build-type: insta deploy <dir> ... (remote build); image-type: insta deploy ... --image <ref>
  const cmd = ["deploy", ...(svc.build ? [dir] : []), "--branch", branch, "--group", name, "--port", String(svc.port ?? 8080)];
  if (!svc.build) cmd.push("--image", svc.image);
  const out = insta(cmd);
  const m = out.match(/->\s+(https:\/\/\S+)/);
  urls[name] = m?.[1];
}
step(6, "deployed");

// [7/8] poll until healthy (auth-gated services answer 401: that counts)
for (const [name, svc] of services) {
  const url = urls[name];
  if (!url) fail(`no URL captured for ${name}`);
  // The daemon's deploy returns before the port binds, so a path-less service waits for any answer.
  const { up, status } = await waitUntilUp(url, svc.healthcheck);
  if (!up) fail(`${name} not healthy within 180s (last status ${status})`);
  log(`   ${name}: healthy (HTTP ${status})`);
}
step(7, "health checks passed");

// [8/8] report
step(8, "done\n");
for (const [name] of services) log(`  ${name}: ${urls[name]}`);
// Every required variable the caller did NOT supply got its value from somewhere the caller cannot
// see, so name each one and where to read it back. Every service, not just the first: a template
// can generate a credential on any of them, and this used to read `services[0]` while claiming to
// name each one. Keyed on the spec rather than only on `generate:`, so a `default:` is reported
// too. Deduped because the bundle `insta run` injects is per-branch, not per-service, so one line
// answers a name however many services declare it.
const reported = new Set();
for (const [, svc] of services) {
  for (const [k, spec] of Object.entries(svc.env?.required ?? {})) {
    const source = valueSource(spec, sets[k]);
    if (source === "provided" || source === null || reported.has(k)) continue;
    reported.add(k);
    const label = source === "generate" ? "generated" : "template default";
    log(`  ${k} (${label}): insta run --branch ${branch} -- printenv ${k}`);
  }
}
log(`  attribution: ${manifest.code}@${manifest.version}  deployment ${deploymentId}`);

// helpers
// Replace every known secret value with ***: the backstop for anything that reaches a stream.
function redact(text) {
  let out = String(text);
  for (const v of secretValues) if (v && v.length >= 4) out = out.split(v).join("***");
  return out;
}
// `secrets set KEY VALUE` echoes as `secrets set KEY=***`: the key is the useful half.
function displayArgs(cmdArgs) {
  const shown = cmdArgs[0] === "secrets" && cmdArgs[1] === "set" && cmdArgs.length > 3
    ? ["secrets", "set", `${cmdArgs[2]}=***`, ...cmdArgs.slice(4)]
    : cmdArgs;
  return shown.map((a) => {
    const safe = redact(a);
    return safe.length > 60 ? safe.slice(0, 57) + "..." : safe;
  });
}
function insta(cmdArgs) {
  log(`   $ insta ${displayArgs(cmdArgs).join(" ")}`);
  try {
    return execFileSync("insta", cmdArgs, {
      encoding: "utf8",
      cwd: process.env.INSTA_LINK_DIR ?? process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    // execFileSync stamps the whole command line: values included: into message/stderr/stdout.
    // Scrub before the error escapes to a handler, a rethrow, or an unhandled stack trace.
    e.message = redact(e.message);
    if (e.stderr) e.stderr = redact(e.stderr);
    if (e.stdout) e.stdout = redact(e.stdout);
    throw e;
  }
}
// An unresolvable ref FAILS here rather than being written through: a literal `${...}` reaching the
// app is the worse outcome, because n8n would boot fine and hand out webhook links nobody can call.
function resolveFixed(value, at, envName) {
  return value.replace(FIXED_REF_RE, (_whole, inner) => {
    const v = checkFixedRef(inner, { at, envName, services: manifest.services ?? {}, generated: manifest.generated ?? {} });
    if (v.error) fail(v.error);
    const a = addr.get(v.service);
    // Reachable only if the platform allocated no domain for a service the rule considers valid.
    if (!a) fail(`${at}: service '${v.service}' has no address allocated`);
    return a[v.prop];
  });
}
function genValue(spec) {
  const m = String(spec).match(/^secret:(\d+)$/);
  if (!m) fail(`unknown generator '${spec}'`);
  const value = randomBytes(Number(m[1])).toString("base64url").slice(0, Number(m[1]));
  secretValues.add(value);
  return value;
}
function step(n, msg) { console.log(redact(`[${n}/8] ${msg}`)); }
function log(msg) { console.log(redact(msg)); }
function fail(msg) { console.error(redact(`error: ${msg}`)); process.exit(1); }
