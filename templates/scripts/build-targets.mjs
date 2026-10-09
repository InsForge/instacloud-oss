#!/usr/bin/env node
// Expand a list of template codes into the image workflow's build matrix: one entry per template
// carrying its code, its canonical version tag and the buildx `platforms` string.
//
// The platforms come from the manifest's `meta.architectures` and from nowhere else. A fixed
// `platforms: linux/amd64,linux/arm64` line in the workflow says the same thing about every
// template, which is only true while every template happens to cross-build; the first one that
// pins an amd64-only upstream would then either fail the whole build or, worse, publish an index
// the catalog's own claim disagrees with. Reading it off the manifest keeps one answer per
// template, in the file that also tells a user what to expect.
//
// Usage: build-targets.mjs '["pi","hermes"]'   (the discover step's own JSON, or a bare list)
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import yaml from "js-yaml";

/** Mirrors TEMPLATE_ARCHITECTURES in src/templates/manifest.ts. The daemon is the authority; this
 *  copy exists so a typo fails on the pull request instead of at deploy time after merge. */
export const ARCHITECTURES = ["amd64", "arm64"];

const TEMPLATES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Parse the codes argument: the discover step's JSON array, or whitespace/comma-separated names. */
export function parseCodes(arg) {
  const raw = String(arg ?? "").trim();
  if (raw === "") return [];
  if (raw.startsWith("[")) {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("the codes argument must be a JSON array");
    return parsed.map((c) => String(c));
  }
  return raw.split(/[\s,]+/).filter(Boolean);
}

/** One matrix entry per code, in the order given. Throws with the template named on any problem:
 *  a build that guessed a platform list would be worse than one that stops. */
export function targetsFor(codes, root = TEMPLATES_DIR) {
  return codes.map((code) => {
    const file = join(root, code, "insta.template.yaml");
    let manifest;
    try { manifest = yaml.load(readFileSync(file, "utf8")); }
    catch (e) { throw new Error(`${code}: cannot read ${file}: ${e.message}`); }
    const version = manifest?.version;
    if (!version) throw new Error(`${code}: the manifest declares no version, which is the canonical image tag`);

    const declared = manifest?.meta?.architectures;
    if (!Array.isArray(declared) || declared.length === 0) {
      throw new Error(`${code}: meta.architectures is missing. Declare the architectures this template's `
        + `image is published for, e.g. [amd64, arm64]; it is what this build publishes and what the `
        + `catalog tells a user before they deploy`);
    }
    for (const arch of declared) {
      if (!ARCHITECTURES.includes(arch)) {
        throw new Error(`${code}: meta.architectures carries '${arch}', which is not one of ${ARCHITECTURES.join(", ")}`);
      }
    }
    if (new Set(declared).size !== declared.length) throw new Error(`${code}: meta.architectures lists the same architecture twice`);

    return { code, version: String(version), platforms: declared.map((a) => `linux/${a}`).join(",") };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(`${JSON.stringify(targetsFor(parseCodes(process.argv[2])))}\n`);
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exit(1);
  }
}
