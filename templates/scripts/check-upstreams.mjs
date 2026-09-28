#!/usr/bin/env node
// What every template's upstream has done since we pinned it. Reads the registry directories and
// the public package/image/repo APIs, prints a line each, and changes nothing.
//
//   npm run check-upstreams            every template
//   npm run check-upstreams -- n8n pi  just these
//   npm run check-upstreams -- --json  for something else to consume
//
// Exit code is 0 unless a template could not be resolved at all, which is a reason to look rather
// than a reason to stop: being unable to tell is not the same as being behind, and neither is an
// error in this script.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { upstreamDrift, kindOf } from "./upstream-check.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const asJson = args.includes("--json");
const only = args.filter((a) => !a.startsWith("--"));

const codes = readdirSync(root)
  .filter((c) => existsSync(join(root, c, "insta.template.yaml")))
  .filter((c) => !only.length || only.includes(c))
  .sort();

const rows = [];
for (const code of codes) {
  const m = yaml.load(readFileSync(join(root, code, "insta.template.yaml"), "utf8"));
  const upstream = m?.upstream ?? {};
  const drift = await upstreamDrift(upstream);
  rows.push({ code, kind: kindOf(upstream).kind ?? null, ...(drift ?? { current: true }) });
}

if (asJson) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  const w = Math.max(...rows.map((r) => r.code.length));
  for (const r of rows) {
    const say = r.current ? "up to date"
      : r.unknown ? `unknown: ${r.unknown}`
        // A commit sha has no ordering, so it is reported as moved and never as an upgrade.
        : `${r.from} -> ${r.to}  [${r.level ?? "changed, not comparable"}]`;
    console.log(`${r.current ? "=" : r.unknown ? "?" : ">"} ${r.code.padEnd(w)}  ${String(r.kind ?? "-").padEnd(14)} ${say}`);
  }
  const moved = rows.filter((r) => r.to).length;
  const stuck = rows.filter((r) => r.unknown).length;
  console.log(`\n${rows.length} templates, ${moved} behind, ${stuck} could not be resolved`);
}

process.exit(rows.some((r) => r.unknown) ? 1 : 0);
