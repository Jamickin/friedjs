// The version stamp has three copies; they must agree.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "../fried.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("version: fried.js VERSION === package.json version === top CHANGELOG.md entry", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
  const changelog = fs.readFileSync(path.join(ROOT, "CHANGELOG.md"), "utf8");
  // First "## [x.y.z]" heading, skipping "## [Unreleased]".
  const top = changelog.match(/^## \[(\d+\.\d+\.\d+)\]/m)?.[1];
  assert.equal(VERSION, pkg, `fried.js VERSION (${VERSION}) != package.json version (${pkg})`);
  assert.equal(top, pkg, `top CHANGELOG.md version (${top}) != package.json version (${pkg})`);
});
