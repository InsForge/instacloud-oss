#!/usr/bin/env node
// Registry lint: the four rules from the design doc, enforced in CI.
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { FIXED_REF_RE, checkFixedRef, MANAGED_TYPES, BARE_TYPES } from "./manifest-refs.mjs";
import { DEPLOY_BUTTON_ASSET, findDeployButtons } from "./publish-lib.mjs";
import { ARCHITECTURES } from "./build-targets.mjs";
import { checkServiceRuntime, checkTypedFields } from "./service-runtime.mjs";
import { checkDockerfilePin, checkUpstreamFrom } from "./dockerfile-pin.mjs";
import { validateCompanionRef } from "./companions.mjs";

// Template dirs live beside this script's parent (templates/<code>/): runs from any cwd.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const NON_TEMPLATE = new Set(["scripts", "node_modules"]);
let failures = 0;
const codes = new Set();

// rule 4: index.json is CI-generated: a committed copy is rejected (AGENTS.md)
if (existsSync(join(root, "index.json"))) { failures++; console.error("✗ index.json: never commit it: CI generates it"); }

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
// BARE_TYPES comes from manifest-refs.mjs, which already needs it: one definition, not two.
const TYPES = ["web", "worker", ...BARE_TYPES];
// Every key a service may carry. spec and volumeGib stay listed because the sizing checks below refuse them by name.
const SERVICE_KEYS = ["type", "image", "build", "port", "healthcheck", "volume", "volumeGib", "spec", "alwaysOn", "command", "mountPath", "env", "pgVersion", "public"];
// The platform's HEALTHCHECK_RE, as in src/templates/manifest.ts: one slash, no scheme or host.
const HEALTHCHECK_RE = /^\/(?!\/)[A-Za-z0-9\-._~!$&'()*+,;=:@%/?]*$/;
// Images this repo builds for itself; templates-build-images derives their tag from `version:`.
const SELF_IMAGE_PREFIX = "ghcr.io/insforge/insta-oss/templates/";
const dirs = readdirSync(root).filter((d) => !NON_TEMPLATE.has(d) && statSync(join(root, d)).isDirectory());
for (const dir of dirs) {
  const before = failures;
  const file = join(root, dir, "insta.template.yaml");
  if (!existsSync(file)) { err(dir, "missing insta.template.yaml"); continue; }
  let m;
  try { m = yaml.load(readFileSync(file, "utf8")); } catch (e) { err(dir, `yaml parse: ${e.message}`); continue; }
  const draft = m?.meta?.draft === true;

  // rule 3: mandatory fields (version must be semver)
  for (const f of ["code", "version", "maintainer"]) if (!m?.[f]) err(dir, `missing ${f}`);
  if (m?.version && !SEMVER_RE.test(String(m.version))) err(dir, `version '${m.version}' is not semver`);
  if (!m?.meta?.category) err(dir, "missing meta.category");
  // Whether the platform lists the category needs the network, so check-categories asks that.
  if (m?.meta?.category === "other") err(dir, "meta.category: other is for community templates, propose a category instead (AGENTS.md)");
  if (!m?.upstream?.pinned) err(dir, "missing upstream.pinned");

  // The version is written twice when we build the image ourselves, and the two must agree. Drafts
  // included: this is internal consistency, not publishing readiness, and a draft that drifts is a
  // published drift the day it ships. Templates that deploy an upstream image (n8n) have no
  // Dockerfile and nothing to compare.
  if (existsSync(join(root, dir, "Dockerfile"))) {
    const dockerfile = readFileSync(join(root, dir, "Dockerfile"), "utf8");
    const drift = checkDockerfilePin(m?.upstream ?? {}, dockerfile);
    if (drift) err(dir, drift.error);
    // And where the image is built ON the upstream's own, the FROM has to name the pinned tag
    // outright. Whether that tag still resolves to the digest beside it is a question only the
    // registry can answer, so check-upstreams asks it and this stays offline.
    const stale = checkUpstreamFrom(m?.upstream ?? {}, dockerfile);
    if (stale) err(dir, stale.error);
  }

  // Which CPU architectures the deployable image is published for. Mandatory, drafts included:
  // the image workflow derives its buildx `platforms` from this, the catalog serves it, and the
  // deploy path refuses a template this box cannot run before it creates anything. A template
  // without it would build for a guessed platform list and then tell users nothing, which is the
  // state that made six templates undeployable on arm64 while the installer accepted aarch64.
  const arches = m?.meta?.architectures;
  if (arches === undefined) {
    err(dir, `missing meta.architectures: declare the architectures the image is published for, `
      + `e.g. [amd64, arm64]. Verify with 'docker buildx build --platform linux/arm64 templates/${dir}'`);
  } else if (!Array.isArray(arches) || arches.length === 0) {
    err(dir, "meta.architectures must be a non-empty array of architecture names");
  } else {
    for (const a of arches) if (!ARCHITECTURES.includes(a)) err(dir, `meta.architectures carries '${a}', not one of ${ARCHITECTURES.join(", ")}`);
    if (new Set(arches).size !== arches.length) err(dir, "meta.architectures lists the same architecture twice");
  }
  if (m?.code && m.code !== dir) err(dir, `code '${m.code}' != folder name`);
  if (m?.code) { if (codes.has(m.code)) err(dir, "duplicate code"); codes.add(m.code); }

  // Every publishable template ships its own logo, so a contributed template needs one PR, not two.
  // `meta.logo: none` is the explicit opt-out for an upstream with no mark (consumers show a
  // monogram): a declaration that gets reviewed, unlike a silently missing file.
  if (!draft && m?.meta?.logo !== "none" && !["logo.svg", "logo.png"].some((f) => existsSync(join(root, dir, f)))) {
    err(dir, "missing logo.svg (or logo.png): add one, or declare meta.logo: none if upstream has no mark");
  }
  // A declared path must resolve, so the catalog can never publish a reference to a missing file
  const logoRef = m?.meta?.logo;
  if (logoRef && logoRef !== "none" && !existsSync(join(root, dir, String(logoRef).replace(/^\.\//, "")))) {
    err(dir, `meta.logo points at ${logoRef}, which does not exist`);
  }

  // README images: publish.mjs rewrites relative targets into absolute CDN URLs pinned to the
  // commit, so a missing or escaping asset would only surface as a broken image on the gallery.
  // Catch it here instead.
  const readme = join(root, dir, "README.md");
  if (existsSync(readme)) {
    const text = readFileSync(readme, "utf8");
    // The manifest is where the version lives. A copy in prose has nothing keeping it true:
    // `check-upstreams --apply` moves the manifest and the Dockerfile and reads no README, so a
    // bump used to ship with the page still naming the version before it. A warning rather than
    // an error, because a short pin like `0.1.0` can legitimately be some other number here.
    const pinned = String(m?.upstream?.pinned ?? "");
    if (pinned && new RegExp(`(?<![0-9A-Za-z._-])${pinned.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![0-9A-Za-z._-])`).test(text)) {
      console.warn(`~ ${dir}: README names the pinned version ${pinned}; a bump moves the manifest and not this page, so leave the version out and name the image or package alone`);
    }
    const targets = [
      ...text.matchAll(/!\[[^\]]*\]\(([^)\s]+)/g),
      ...text.matchAll(/<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi),
    ].map((mt) => mt[1]);
    for (const t of targets) {
      if (/^([a-z][a-z0-9+.-]*:|\/\/|\/|#)/i.test(t)) continue; // absolute, left alone at publish
      const rel = t.replace(/^\.\//, "").split(/[?#]/)[0];
      if (!rel) continue;
      if (rel.split("/").includes("..")) {
        err(dir, `README image '${t}' points outside the template directory; keep assets beside the manifest`);
      } else if (!existsSync(join(root, dir, rel))) {
        err(dir, `README image '${t}' does not exist in the template directory`);
      }
    }

    // The one-click deploy button. publish.mjs strips it on the way to the catalog, so a wrong
    // link never surfaces on the gallery where someone would notice it: this is the only place it
    // gets checked. AGENTS.md tells a contributor to start by copying the nearest template, which
    // makes a carried-over <code> in the href the likeliest mistake in this block.
    // The button, checked through publish's OWN matcher rather than a second one written here.
    // A looser test passes a README carrying something publish will never strip: a fenced sample
    // satisfying the requirement while GitHub shows no button at all, or a neighbouring filename
    // validated as if it were the button. One matcher, so the two cannot drift.
    const expected = `https://instacloud.com/templates/${dir}`;
    const buttons = findDeployButtons(text);
    if (buttons.length) {
      if (draft) {
        err(dir, `README carries the deploy button, but the template is a draft: ${expected} does not exist until it publishes`);
      }
      if (!existsSync(join(root, "..", DEPLOY_BUTTON_ASSET))) {
        err(dir, `README references ${DEPLOY_BUTTON_ASSET}, which is not in this repository`);
      }
      for (const href of buttons) {
        if (href !== expected) err(dir, `deploy button links '${href}', expected '${expected}'`);
      }
    } else if (!draft) {
      // AGENTS.md says every publishable template carries the button, so enforce it the way the
      // logo rule is enforced. Two different mistakes get two different messages: writing it in a
      // form publish cannot strip is not the same as not writing it, and telling someone to "add"
      // one they already wrote would only get a second copy.
      err(dir, text.includes(DEPLOY_BUTTON_ASSET)
        ? `README mentions ${DEPLOY_BUTTON_ASSET}, but not as a button publish would strip: it has to be `
          + `a linked image alone on its line, outside any code fence, indented at most three spaces, `
          + `with the asset last in the URL. `
          + `Expected [![Deploy on InstaCloud](<cdn>/${DEPLOY_BUTTON_ASSET})](${expected})`
        : `README is missing the deploy button: add it under the title as [![Deploy on InstaCloud](<cdn>/${DEPLOY_BUTTON_ASSET})](${expected}), see assets/README.md`);
    }
  }

  const declared = new Set();
  for (const [name, svc] of Object.entries(m?.services ?? {})) {
    for (const group of ["required", "optional"]) for (const k of Object.keys(svc.env?.[group] ?? {})) declared.add(k);
    // The platform is the authority; this check exists so a typo fails on the pull request instead
    // of asynchronously, mid-run, on every by-code deploy after merge. Runs before the managed-type
    // check below, because the platform checks every service.
    for (const [k, value] of Object.entries(svc.env?.fixed ?? {})) {
      for (const mt of String(value).matchAll(FIXED_REF_RE)) {
        const verdict = checkFixedRef(mt[1], {
          at: `${name}: env.fixed.${k}`, envName: k, services: m?.services ?? {}, generated: m?.generated ?? {},
        });
        if (verdict.error) err(dir, verdict.error);
      }
    }
    // Also before the managed-type check: the platform refuses these on EVERY service type, so a
    // lint that ran them only for compute would green-light a manifest publish then rejects.
    if (svc.spec !== undefined) {
      err(dir, `${name}: compute size is the platform's to choose — remove spec`);
    }
    if (svc.volume !== undefined && svc.volume !== true) {
      err(dir, `${name}: the volume size is the platform's to choose — declare 'volume: true'`);
    }
    // The platform refuses a service key it does not know. A misspelt key used to be silent on both sides.
    for (const key of Object.keys(svc)) {
      if (!SERVICE_KEYS.includes(key)) err(dir, `${name}: ${key} is not a template field, the platform refuses it`);
    }
    if (!TYPES.includes(svc.type)) {
      err(dir, `${name}: type must be one of ${TYPES.join(", ")} (got '${svc.type}')`);
      continue;
    }
    // pgVersion is postgres only and public is storage only, the per-type rule add() applies on the platform.
    const typed = checkTypedFields(name, svc);
    for (const e of typed.errors) err(dir, e);
    for (const w of typed.warnings) console.warn(`~ ${dir}: ${w}`);
    // A managed service is the platform's: it owns the image, port, sizing and credentials.
    if (BARE_TYPES.includes(svc.type)) {
      // storage parses locally but is refused at deploy, redis, mysql and mongodb are skipped by the catalog.
      if (svc.type === "storage") {
        console.warn(`~ ${dir}: ${name} declares a storage service, cloud-only today: the self-hosted runtime parses it but refuses to deploy a template with a bucket`);
      } else if (svc.type !== "postgres") {
        console.warn(`~ ${dir}: ${name} declares a ${svc.type} service, cloud-only today: the self-hosted runtime only parses web, worker, postgres and storage and skips this template until it gains support`);
      }
      // spec is not in this list: the shared check above already refuses it on every service type,
      // so it can never reach this loop first, and repeating it here would just double the message
      // for one violation.
      // volume IS still in this list despite that same shared check above: that check lets
      // `volume: true` through, since that is the only valid shape on a deployable service, but a
      // managed type may carry no volume key at all. This loop is the only place that catches
      // `volume: true` here. A SIZED volume on a managed type still trips both checks: two lines
      // for one violation, on purpose, not by accident.
      // env is refused outright here, even though the platform's own parser tolerates an exact
      // empty shell. That tolerance is a storage round-trip concern: a NORMALIZED stored manifest
      // always carries an env record, and it must still parse on every by-code deploy. This linter
      // only ever sees hand-authored files, where an empty env shell is noise no author writes.
      for (const field of ["image", "build", "port", "healthcheck", "volume", "volumeGib", "alwaysOn", "command", "mountPath", "env"]) {
        if (svc[field] !== undefined) err(dir, `${name}: a ${svc.type} service is platform-managed and carries no ${field}, declare it bare`);
      }
      continue;
    }
    // rule 1: image must be pinned (tag or digest), never latest/tagless
    if (!svc.image && !svc.build) err(dir, `${name}: needs image or build`);
    // the platform parser refuses both (image is what deploys; the Dockerfile is wired by convention)
    if (svc.image && svc.build) err(dir, `${name}: image and build are mutually exclusive: drop build:, keep image:`);
    if (svc.image && !draft) {
      const ref = String(svc.image);
      if (!/[@:]/.test(ref.split("/").pop()) || /:latest$/.test(ref)) err(dir, `${name}: image must pin a tag or digest (got '${ref}')`);
      // An image we build ourselves is tagged from `version:` by templates-build-images, while
      // this line is typed by hand. Drift means publishing a manifest that points at a tag no
      // build ever pushed, which surfaces as publish.mjs polling for ten minutes and failing, or
      // worse as a deploy pulling a stale version that does exist.
      const self = ref.startsWith(SELF_IMAGE_PREFIX) ? ref.slice(SELF_IMAGE_PREFIX.length) : null;
      if (self && !self.includes("@")) {
        const [imageCode, tag] = [self.split(":")[0], self.split(":")[1]];
        if (imageCode === dir) {
          if (tag !== String(m.version)) err(dir, `${name}: image tag '${tag}' != version '${m.version}': the build tags from version:, so nothing would push '${tag}'`);
        } else {
          // A companion image: a SECOND image this template runs as another service, built by a
          // sibling template directory here (openmuse runs openmuse-browser's Chromium worker, the
          // way upstream's blueprint splits the API from its browser). A template directory builds
          // exactly one image, so the only way to get a second is to reference a sibling's. Allowed,
          // but the sibling has to exist, ship a Dockerfile so the image workflow actually publishes
          // its tag, and carry the version this names, or the reference is a typo from copying
          // another template, or a pin that only fails at publish or deploy.
          const e = validateCompanionRef({ imageCode, tag }, root);
          if (e) err(dir, `${name}: ${e}`);
        }
      }
    }
    if (svc.build && !existsSync(join(root, dir, svc.build.replace(/^\.\//, "")))) err(dir, `${name}: build file ${svc.build} not found`);
    // Optional on a web service, but a declared key must be a path (null and empty are refused).
    if (svc.type === "web" && svc.healthcheck !== undefined && !(typeof svc.healthcheck === "string" && HEALTHCHECK_RE.test(svc.healthcheck))) {
      err(dir, `${name}: healthcheck must be a path starting with / (one slash, no '//host' or scheme), or leave it out`);
    }
    // A worker is portless (insta-platform#490): the platform runs it as its own port-0 service, so
    // nothing is routed to it and nothing probes it. The server refuses these three shapes; say so here.
    if (svc.type === "worker") {
      if (svc.port !== undefined) err(dir, `${name}: a worker has no routed port, remove port (or declare type: web to serve HTTP)`);
      if (svc.healthcheck !== undefined) err(dir, `${name}: a worker has no HTTP endpoint to probe, remove healthcheck (its health is the machine's state)`);
      if (svc.alwaysOn === false) err(dir, `${name}: a worker cannot scale to zero, nothing is routed to it so nothing would wake it: remove alwaysOn or set it true`);
    }
    // Same message the platform uses. Catches the shape only: a misspelled key is the unknown-key check above.
    if (svc.alwaysOn !== undefined && typeof svc.alwaysOn !== "boolean") {
      err(dir, `${name}: alwaysOn must be a boolean`);
    }
    const runtime = checkServiceRuntime(name, svc);
    for (const e of runtime.errors) err(dir, e);
    for (const w of runtime.warnings) console.warn(`~ ${dir}: ${w}`);
    // rule 2: required vars need description (unless generated)
    for (const [k, spec] of Object.entries(svc.env?.required ?? {})) {
      if (!spec?.generate && !spec?.description) err(dir, `required var ${k} needs a description`);
    }
    // generated refs must be declared
    for (const [k, ref] of Object.entries(svc.env?.generated ?? {})) {
      const key = String(ref).replace(/^\$\{(.+)\}$/, "$1");
      if (!(m.generated ?? {})[key]) err(dir, `env.generated.${k} references undeclared '${key}'`);
    }
  }
  // Each managed datastore is born with its own volume at the deployer's plan cap, so a template
  // declaring several of them costs several volumes. A warning, not a failure: legitimate but worth
  // a second look on the pull request.
  // MANAGED_TYPES has no storage: a bucket has no volume, so it stays out of this count.
  const managedCount = Object.values(m?.services ?? {}).filter((s) => MANAGED_TYPES.includes(s?.type)).length;
  if (managedCount > 2) console.warn(`~ ${dir}: declares ${managedCount} managed datastores, each born with its own plan-cap volume`);
  // constraints may only name declared required/optional variables (platform parser rule)
  (m?.constraints ?? []).forEach((c, i) => {
    for (const kind of ["oneOf", "allOf"]) {
      if (c?.[kind] === undefined) continue;
      if (!Array.isArray(c[kind])) { err(dir, `constraints[${i}].${kind} must be an array of variable names`); continue; }
      for (const n of c[kind]) if (!declared.has(n)) err(dir, `constraints[${i}].${kind} references undeclared variable '${n}'`);
    }
    if (!c?.oneOf && !c?.allOf) err(dir, `constraints[${i}] must carry oneOf or allOf`);
  });
  if (failures > before) continue; // already reported ✗ for this template: no misleading ✓ after it
  if (draft) console.log(`~ ${dir}: draft (index-excluded), relaxed checks`);
  else console.log(`✓ ${dir}`);
}

function err(dir, msg) { failures++; console.error(`✗ ${dir}: ${msg}`); }
process.exit(failures ? 1 : 0);
