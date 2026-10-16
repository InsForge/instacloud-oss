#!/usr/bin/env node
// Publish manifests to the platform registry: PUT /admin/templates/:code (staff bearer, upsert).
// Auth: login-per-run via INSTA_BOT_EMAIL/INSTA_BOT_PASSWORD (preferred: sessions expire when
// idle), else a static INSTA_PLATFORM_STAFF_TOKEN. INSTA_PLATFORM_URL is always required.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, resolve as resolvePath, sep } from "node:path";
import yaml from "js-yaml";
import { ghcrGateMessage, ghcrRetryVerdict, parseGhcrRef, rewriteReadme, stripDeployBadge } from "./publish-lib.mjs";

const url = process.env.INSTA_PLATFORM_URL?.replace(/\/+$/, "");
if (!url) fail("INSTA_PLATFORM_URL must be set");
const dirs = process.argv.slice(2);
if (!dirs.length) fail("usage: publish.mjs <template-dir> [<template-dir> ...]");
const token = await staffToken();

// Ghcr gate polling knobs: templates-build-images runs on the same push, so the canonical
// tag usually lands a minute or two after publish starts.
const GHCR_ATTEMPTS = Number(process.env.GHCR_CHECK_ATTEMPTS ?? 15);
const GHCR_DELAY_MS = Number(process.env.GHCR_CHECK_DELAY_MS ?? 40_000);

// The repo whose raw/jsDelivr URLs published READMEs and logos point at. Consulted only when
// GITHUB_REPOSITORY is absent: the supported local-publish path. ONE constant, because the repo
// rename had to fix this slug in two places and the sweep missed both. `||` not `??`: an
// explicitly exported GITHUB_REPOSITORY="" is empty, not nullish, and would otherwise build
// `cdn.jsdelivr.net/gh/@<sha>/…`, a broken URL with no error.
const DEFAULT_REPO = "InsForge/instacloud-oss";

// Mint a fresh session when bot credentials exist; fall back to a static token.
async function staffToken() {
  const { INSTA_BOT_EMAIL: email, INSTA_BOT_PASSWORD: password, INSTA_PLATFORM_STAFF_TOKEN: staticToken } = process.env;
  if (email && password) {
    const res = await fetch(`${url}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) fail(`bot login failed with HTTP ${res.status}. ${(await res.text()).slice(0, 300)}`);
    console.log("logged in via bot credentials");
    return (await res.json()).accessToken;
  }
  if (staticToken) return staticToken;
  return fail("set INSTA_BOT_EMAIL + INSTA_BOT_PASSWORD (preferred) or INSTA_PLATFORM_STAFF_TOKEN");
}

let failures = 0;
for (const dir of dirs) {
  const code = basename(dir.replace(/\/+$/, ""));
  const text = readFileSync(join(dir, "insta.template.yaml"), "utf8");
  const m = yaml.load(text);
  if (m?.code !== code) { failures++; console.error(`✗ ${code}: manifest code '${m?.code}' != folder name`); continue; }
  // A draft used to be `continue`, which withdrew nothing: the catalog kept serving whatever was
  // published last, and someone had to remember to flip `published` by hand. deepseek-hermes was
  // withdrawn that way. So a draft now DELISTS, but only if the catalog is actually serving it:
  // the GET is the discriminator, because 9router/n8n/openclaw are drafts that were never
  // published, and PUTting them would create rows for half-finished manifests the catalog
  // validates on receipt.
  let delisting = false;
  if (m?.meta?.draft === true) {
    const live = await fetch(`${url}/templates/${code}`); // public read; 404 = nothing to withdraw
    if (!live.ok) { console.log(`~ ${code}: draft, not in the catalog`); continue; }
    delisting = true;
  }
  // Never publish a manifest whose ghcr image doesn't exist yet (merge can outrun the build).
  // Not asserted when withdrawing: taking a template down must not depend on an image being
  // pullable, and a retired template's tag is exactly the one nobody is rebuilding.
  if (!delisting) {
    try { await assertGhcrImages(m); }
    catch (e) { failures++; console.error(`✗ ${code}: ${e.message}`); continue; }
  }
  // Body: manifest is the raw YAML text (the catalog parses and normalizes it), plus the two
  // things a manifest cannot carry itself. readme is a file, and logoUrl has to be absolute
  // because a relative ./logo.svg means nothing to the catalog. Unknown fields are ignored by
  // older catalog versions, so sending them is safe before the receiving side ships.
  let body;
  try {
    body = JSON.stringify({
      manifest: text, readme: readmeOf(dir), logoUrl: logoUrlOf(dir, m),
      ...(delisting ? { published: false } : {}),
    });
  }
  catch (e) { failures++; console.error(`✗ ${code}: ${e.message}`); continue; }
  const res = await fetch(`${url}/admin/templates/${code}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body,
  });
  if (res.ok) { console.log(`✓ ${code}: ${delisting ? "delisted" : `published ${m.code}@${m.version}`}`); }
  else { failures++; console.error(`✗ ${code}: HTTP ${res.status}. ${(await res.text()).slice(0, 500)}`); }
}
process.exit(failures ? 1 : 0);

function readmeOf(dir) {
  const p = join(dir, "README.md");
  if (!existsSync(p)) return undefined;
  // stripDeployBadge runs OUTSIDE absolutizeReadme because that one returns the text unchanged
  // when there is no commit to pin to, and the button has to come out either way.
  return absolutizeReadme(stripDeployBadge(readFileSync(p, "utf8")), dir);
}

function absolutizeReadme(text, dir) {
  const repo = process.env.GITHUB_REPOSITORY || DEFAULT_REPO;
  const sha = process.env.GITHUB_SHA ?? gitHead();
  if (!sha) return text; // no commit to pin to: publish the text unchanged rather than guess
  const root = repoRoot();
  // Repo-relative terms throughout, so this works whether the caller passed `templates/hermes`
  // or an absolute path.
  const dirInRepo = relative(root, resolvePath(dir)).split(sep).join("/");
  const isDirectory = (p) => {
    try { return statSync(join(root, p)).isDirectory(); } catch { return false; }
  };
  return rewriteReadme(text, { dirInRepo, repo, sha, isDirectory });
}

// The logo is served from jsDelivr's CDN, pinned to the commit being published: immutable for
// that version, cached at the edge, and no anonymous GitHub rate limit on a gallery that loads
// several logos per view. Requires the repo to be public, which is why the registry lives here.
// GITHUB_SHA on a push to main is the merge commit; locally it falls back to the checked-out HEAD.
function logoUrlOf(dir, m) {
  const declared = m?.meta?.logo;
  if (!declared || declared === "none") return undefined;
  const file = String(declared).replace(/^\.\//, "");
  if (!existsSync(join(dir, file))) return undefined;
  const repo = process.env.GITHUB_REPOSITORY || DEFAULT_REPO;
  const sha = process.env.GITHUB_SHA ?? gitHead();
  if (!sha) return undefined;
  return `https://cdn.jsdelivr.net/gh/${repo}@${sha}/${dir.replace(/^\.\//, "")}/${file}`;
}

function gitHead() {
  try { return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(); }
  catch { return undefined; }
}

function repoRoot() {
  try { return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim(); }
  catch { return process.cwd(); }
}

// Gate: every ghcr image a manifest references must be ANONYMOUSLY pullable before the PUT.
//
// Anonymous is the whole point. A template deploy pulls with no credentials, and a new ghcr package
// is private by default, so a gate that authenticated with GHCR_TOKEN would happily green-light an
// image nobody else can fetch: the catalog entry would publish and every deploy of it would fail on
// the pull, until someone remembered to flip the package public. So the probe runs exactly as the
// puller does. GHCR_TOKEN is still used, but only afterwards, to tell "private" apart from
// "not built yet" in the failure message.
async function assertGhcrImages(m) {
  for (const [name, svc] of Object.entries(m.services ?? {})) {
    const parsed = parseGhcrRef(svc?.image);
    if (!parsed) continue; // not a ghcr image: an upstream public registry, nothing for us to gate
    const { repo, tag } = parsed;
    const anon = await ghcrManifestStatus(repo, tag, { authenticated: false });
    if (anon === 0) continue;

    // Classify, so the operator is told which of the two problems they have.
    const auth = process.env.GHCR_TOKEN ? await ghcrManifestStatus(repo, tag, { authenticated: true, attempts: 1 }) : null;
    throw new Error(ghcrGateMessage({ name, ref: String(svc.image), anon, auth }));
  }
}

// 0 when the manifest resolves, else the last HTTP status seen. Polling exists for publish
// propagation (404 while the image build finishes); 401/403 returns at once only when the
// authenticated probe proves it is a visibility verdict, which will not self-heal.
async function ghcrManifestStatus(repo, tag, { authenticated, attempts = GHCR_ATTEMPTS }) {
  const label = authenticated ? "authenticated" : "anonymous";
  let last = 0;
  for (let i = 1; i <= attempts; i++) {
    const token = await ghcrPullToken(repo, authenticated);
    if (typeof token === "number") last = token; // the token endpoint itself refused
    else {
      const res = await fetch(`https://ghcr.io/v2/${repo}/manifests/${encodeURIComponent(tag)}`, {
        method: "HEAD",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.oci.image.index.v1+json,application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.docker.distribution.manifest.v2+json",
        },
      });
      if (res.ok) return 0;
      last = res.status;
    }
    if (last === 401 || last === 403) {
      // Not necessarily a visibility verdict: an anonymous caller gets 403 for a
      // package that has not been pushed yet too. Ask the authenticated probe
      // before spending the verdict, or a still-building image reads as private
      // and the whole retry budget goes unused.
      const auth =
        !authenticated && process.env.GHCR_TOKEN
          ? await ghcrManifestStatus(repo, tag, { authenticated: true, attempts: 1 })
          : null;
      if (ghcrRetryVerdict({ anon: last, auth }) === "fatal") return last;
    }
    if (i < attempts) {
      console.log(`  … ${repo}:${tag} not ${label}ly pullable yet (HTTP ${last}): retry ${i}/${attempts - 1} in ${GHCR_DELAY_MS / 1000}s`);
      await new Promise((r) => setTimeout(r, GHCR_DELAY_MS));
    }
  }
  return last;
}

// A pull token, or the HTTP status when the token endpoint refuses (which is what a private package
// looks like to an anonymous caller). Anonymous requests carry no credentials at all, deliberately.
async function ghcrPullToken(repo, authenticated) {
  const headers = {};
  if (authenticated && process.env.GHCR_TOKEN) {
    headers.authorization = `Basic ${Buffer.from(`x-token:${process.env.GHCR_TOKEN}`).toString("base64")}`;
  }
  const res = await fetch(`https://ghcr.io/token?service=ghcr.io&scope=repository:${repo}:pull`, { headers });
  if (!res.ok) return res.status;
  return (await res.json()).token;
}

function fail(msg) { console.error(`error: ${msg}`); process.exit(1); }
