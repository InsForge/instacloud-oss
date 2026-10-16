// Companion images. A template directory builds exactly one image, so a template that needs a
// second one (a service built from source alongside the first, such as the browser worker openmuse
// runs next to its API) puts that image in its own sibling directory and references it. A service
// `image:` of the form ghcr.io/insforge/insta-oss/templates/<code>:<tag> whose <code> is NOT this
// template's own code is a companion. This module is shared by lint (which validates each reference)
// and version-guard (a draft whose image a publishable template references still owes a bump,
// because its canonical tag is built and consumed by that published template).
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";

export const SELF_IMAGE_PREFIX = "ghcr.io/insforge/insta-oss/templates/";

/** The companion image references a manifest makes, as `{ imageCode, tag }`. Excludes the template's
 *  own image (built from its own version) and any digest-pinned reference (a digest is immutable, so
 *  neither the version-bump guard nor a drift bump applies to it). */
export function companionRefs(manifest, ownCode) {
  const out = [];
  for (const svc of Object.values(manifest?.services ?? {})) {
    const ref = svc?.image;
    if (typeof ref !== "string" || !ref.startsWith(SELF_IMAGE_PREFIX)) continue;
    const self = ref.slice(SELF_IMAGE_PREFIX.length);
    if (self.includes("@")) continue; // digest-pinned: immutable, not a floating companion tag
    const imageCode = self.split(":")[0];
    const tag = self.split(":")[1];
    if (imageCode && imageCode !== ownCode) out.push({ imageCode, tag });
  }
  return out;
}

/** The set of template codes referenced as a companion by any PUBLISHABLE (non-draft) template in
 *  `templates` (`[{ code, manifest }]`). These owe a version bump even when they are themselves
 *  draft: the image workflow publishes their canonical tag and a published template deploys it, so
 *  an unbumped edit would overwrite a tag running instances already pull. A draft's own references
 *  bind no one, because a draft publishes nothing. */
export function referencedCompanionCodes(templates) {
  const referenced = new Set();
  for (const { code, manifest } of templates) {
    if (manifest?.meta?.draft === true) continue;
    for (const { imageCode } of companionRefs(manifest, code)) referenced.add(imageCode);
  }
  return referenced;
}

/** Validate one companion reference against the registry at `root`. Returns an error string, or null
 *  when the reference is sound: the sibling template exists, is buildable (ships a Dockerfile, which
 *  is what makes the image workflow publish its tag), and the tag is that sibling's version. */
export function validateCompanionRef({ imageCode, tag }, root) {
  const siblingDir = join(root, imageCode);
  const siblingManifest = join(siblingDir, "insta.template.yaml");
  if (!existsSync(siblingManifest)) return `image is ${SELF_IMAGE_PREFIX}${imageCode}, which no template in this repo builds`;
  if (!existsSync(join(siblingDir, "Dockerfile"))) {
    return `companion ${imageCode} ships no Dockerfile, so the image workflow publishes no ${SELF_IMAGE_PREFIX}${imageCode} tag to reference`;
  }
  let version;
  try { version = yaml.load(readFileSync(siblingManifest, "utf8"))?.version; } catch { version = undefined; }
  if (String(tag) !== String(version)) {
    return `companion image tag '${tag}' != ${imageCode}'s version '${version}': its build tags from version:, so nothing would push '${tag}'`;
  }
  return null;
}
