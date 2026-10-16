#!/usr/bin/env node
// What every template's upstream has done since we pinned it. Reads the registry directories and
// the public package/image/repo APIs, prints a line each, and changes nothing.
//
//   npm run check-upstreams             every template
//   npm run check-upstreams -- n8n pi   just these
//   npm run check-upstreams -- --json   for something else to consume
//   npm run check-upstreams -- --apply  write the bumps, which is a diff to read, not a release
//
// `--apply` edits files and stops. It opens nothing and pushes nothing, so what it leaves behind is
// a working tree to read, and `npm run lint` plus `npm run version-guard` are the gates that say
// whether it is sound. A template it cannot patch confidently is left alone with its reason.
//
// Exit code is 0 unless a template could not be resolved at all, which is a reason to look rather
// than a reason to stop: being unable to tell is not the same as being behind, and neither is an
// error in this script.
import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { upstreamDrift, kindOf } from "./upstream-check.mjs";
import { applyBump } from "./bump-plan.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const asJson = args.includes("--json");
const apply = args.includes("--apply");
const only = args.filter((a) => !a.startsWith("--"));

const registry = readdirSync(root).filter((c) => existsSync(join(root, c, "insta.template.yaml")));
// A typo used to read as a filter that matched nothing, so `-- n88n` printed a clean report over
// zero templates and exited 0, which looks exactly like a check that ran and found nothing wrong.
const unknown = only.filter((c) => !registry.includes(c));
if (unknown.length) {
  console.error(`no such template: ${unknown.join(", ")}`);
  process.exit(2);
}
const codes = registry.filter((c) => !only.length || only.includes(c)).sort();

const rows = [];
for (const code of codes) {
  const manifestPath = join(root, code, "insta.template.yaml");
  const dockerfilePath = join(root, code, "Dockerfile");
  const manifest = readFileSync(manifestPath, "utf8");
  const upstream = yaml.load(manifest)?.upstream ?? {};
  const drift = await upstreamDrift(upstream);
  const row = { code, kind: kindOf(upstream).kind ?? null, ...(drift ?? { current: true }) };

  if (apply && drift && !drift.unknown) {
    const dockerfile = existsSync(dockerfilePath) ? readFileSync(dockerfilePath, "utf8") : undefined;
    // Refused, not failed. An edit that no longer matches its files is the one case where doing
    // nothing IS the correct edit, and the reason belongs beside the move it declined rather than
    // ending the run and leaving whatever was already written behind.
    const done = applyBump({ manifest, dockerfile, drift });
    if (done.refused) {
      row.refused = done.refused;
    } else {
      writeFileSync(manifestPath, done.files.manifest);
      if (done.files.dockerfile !== undefined) writeFileSync(dockerfilePath, done.files.dockerfile);
      row.applied = done.version;
    }
  }
  rows.push(row);
}

if (asJson) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  const w = Math.max(...rows.map((r) => r.code.length));
  for (const r of rows) {
    const say = r.current ? "up to date"
      : r.refused ? `not patched: ${r.refused}`
        : r.unknown ? `unknown: ${r.unknown}`
        // A commit sha has no ordering, so it is reported as moved and never as an upgrade.
        : `${r.from} -> ${r.to}  [${r.level ?? "changed, not comparable"}]${r.applied ? `  template v${r.applied.from} -> v${r.applied.to}` : ""}`;
    console.log(`${r.current ? "=" : r.unknown ? "?" : ">"} ${r.code.padEnd(w)}  ${String(r.kind ?? "-").padEnd(14)} ${say}`);
  }
  const moved = rows.filter((r) => r.to).length;
  const stuck = rows.filter((r) => r.unknown).length;
  const done = rows.filter((r) => r.applied).length;
  console.log(`\n${rows.length} templates, ${moved} behind, ${stuck} could not be resolved${apply ? `, ${done} patched` : ""}`);
}

process.exit(rows.some((r) => r.unknown) ? 1 : 0);
