#!/usr/bin/env node
// Checks this repo against the platform's template categories, the one list the console and the
// marketing gallery read too. Network, so it is not part of `npm run lint`, which stays offline.
//
//   npm run check-categories             every manifest's meta.category, and the UI snapshot
//   npm run check-categories -- --write  refresh the UI snapshot from the platform first
//
// INSTA_PLATFORM_URL picks the platform, as for publish; production when unset. Exit 1 on any
// problem, and on a platform that does not answer the list: unable to check is not a pass.
import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { categoryProblems, readCategories } from "./categories.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SNAPSHOT = join(root, "..", "ui", "src", "lib", "template-categories.json");
const api = (process.env.INSTA_PLATFORM_URL ?? "https://api.instacloud.com").replace(/\/+$/, "");

const res = await fetch(`${api}/template-categories`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
const listed = res.ok ? readCategories(await res.json()) : null;
if (!listed) {
  console.error(`✗ ${api}/template-categories did not answer the category list (HTTP ${res.status})`);
  process.exit(1);
}

if (process.argv.includes("--write")) {
  writeFileSync(SNAPSHOT, JSON.stringify({ categories: listed }, null, 2) + "\n");
  console.log(`wrote ${listed.length} categories to ui/src/lib/template-categories.json`);
}

const manifests = readdirSync(root)
  .filter((dir) => existsSync(join(root, dir, "insta.template.yaml")))
  .map((dir) => ({ dir, category: yaml.load(readFileSync(join(root, dir, "insta.template.yaml"), "utf8"))?.meta?.category }));
const problems = categoryProblems(listed, manifests, JSON.parse(readFileSync(SNAPSHOT, "utf8")));
for (const p of problems) console.error(`✗ ${p}`);
if (problems.length) process.exit(1);
console.log(`✓ ${manifests.length} templates and the UI snapshot match the platform's ${listed.length} categories`);
