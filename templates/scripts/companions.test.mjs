// Companion images: the rules that let one template run a second image built by a sibling directory.
// Two guards have to hold, and both had no coverage when the pattern was added: lint must refuse a
// reference to a sibling that is not actually buildable (no image would ever carry the tag), and
// version-guard must still require a bump from a draft whose image a publishable template deploys.
import { describe, it, expect } from "vitest";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { companionRefs, referencedCompanionCodes, validateCompanionRef, SELF_IMAGE_PREFIX } from "./companions.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const svc = (image) => ({ type: "web", image });

describe("companionRefs", () => {
  it("ignores the template's own image, an upstream image, and a digest pin", () => {
    const m = { services: {
      self: svc(`${SELF_IMAGE_PREFIX}openmuse:0.1.0`),
      upstream: svc("docker.io/n8nio/n8n:2.36.5"),
      digest: svc(`${SELF_IMAGE_PREFIX}openmuse-browser:0.1.0@sha256:abc`),
    } };
    expect(companionRefs(m, "openmuse")).toEqual([]);
  });

  it("finds a sibling template's image, with its tag", () => {
    const m = { services: { browser: svc(`${SELF_IMAGE_PREFIX}openmuse-browser:0.1.0`) } };
    expect(companionRefs(m, "openmuse")).toEqual([{ imageCode: "openmuse-browser", tag: "0.1.0" }]);
  });
});

describe("referencedCompanionCodes", () => {
  it("counts a reference from a publishable template, not from a draft", () => {
    const templates = [
      { code: "openmuse", manifest: { meta: {}, services: { browser: svc(`${SELF_IMAGE_PREFIX}openmuse-browser:0.1.0`) } } },
      { code: "sketch", manifest: { meta: { draft: true }, services: { helper: svc(`${SELF_IMAGE_PREFIX}sketch-helper:0.1.0`) } } },
    ];
    const set = referencedCompanionCodes(templates);
    expect(set.has("openmuse-browser")).toBe(true);
    expect(set.has("sketch-helper")).toBe(false);
  });
});

describe("validateCompanionRef, against the real registry", () => {
  it("accepts a sibling that exists, ships a Dockerfile, and matches version", () => {
    expect(validateCompanionRef({ imageCode: "openmuse-browser", tag: "0.1.0" }, root)).toBeNull();
  });

  it("rejects a sibling that does not exist", () => {
    expect(validateCompanionRef({ imageCode: "does-not-exist", tag: "1.0.0" }, root)).toMatch(/no template in this repo builds/);
  });

  it("rejects a sibling with no Dockerfile, which publishes no image to reference", () => {
    // n8n references an upstream image and ships no Dockerfile, so nothing ever pushes templates/n8n.
    expect(validateCompanionRef({ imageCode: "n8n", tag: "1.3.2" }, root)).toMatch(/no Dockerfile/);
  });

  it("rejects a tag that is not the sibling's version", () => {
    expect(validateCompanionRef({ imageCode: "openmuse-browser", tag: "9.9.9" }, root)).toMatch(/!= openmuse-browser's version/);
  });
});
