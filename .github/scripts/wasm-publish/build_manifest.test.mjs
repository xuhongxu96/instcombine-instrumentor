import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildManifest as runBuildManifest } from "./build_manifest.mjs";

async function makeRoot() {
  return mkdtemp(path.join(os.tmpdir(), "wasm-manifest-test-"));
}

async function writeBundle(root, dir, extra = {}) {
  const full = path.join(root, dir);
  await mkdir(full, { recursive: true });
  await writeFile(path.join(full, "instcombine_driver.js"), "// js\n");
  await writeFile(path.join(full, "instcombine_driver.wasm"), "wasm\n");
  if (extra.metadata) {
    await writeFile(path.join(full, "metadata.json"), JSON.stringify(extra.metadata, null, 2) + "\n");
  }
}

async function generateManifest(root, branch = "wasm-pkgs") {
  await runBuildManifest({
    owner: "octo",
    repo: "instcombine",
    branch,
    root,
  });
  return JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
}

test("legacy directory without metadata keeps fallback classification", async () => {
  const root = await makeRoot();
  await writeBundle(root, "llvmorg-22.1.6");

  const manifest = await generateManifest(root);
  assert.equal(manifest.defaultTag, "llvmorg-22.1.6");
  assert.equal(manifest.releases.length, 1);
  assert.deepEqual(manifest.releases[0], {
    tag: "llvmorg-22.1.6",
    name: "llvmorg-22.1.6",
    slug: "llvmorg-22.1.6",
    kind: "tag",
    publishedAt: manifest.releases[0].publishedAt,
    prerelease: false,
    bundled: false,
    jsAsset: "https://raw.githubusercontent.com/octo/instcombine/wasm-pkgs/llvmorg-22.1.6/instcombine_driver.js",
    wasmAsset: "https://raw.githubusercontent.com/octo/instcombine/wasm-pkgs/llvmorg-22.1.6/instcombine_driver.wasm",
  });
});

test("custom artifact directory publishes source metadata", async () => {
  const root = await makeRoot();
  await writeBundle(root, "branch-fix-173706-0123456789ab", {
    metadata: {
      sourceRepoUrl: "https://github.com/xhx/fork-llvm",
      sourceRef: "xhx/fix-173706",
      resolvedSha: "0123456789abcdef0123456789abcdef01234567",
      sourceKind: "branch",
    },
  });

  const manifest = await generateManifest(root, "wasm-artifacts-xhx-fork-llvm");
  assert.equal(manifest.defaultTag, "branch-fix-173706-0123456789ab");
  assert.equal(manifest.releases[0].kind, "tag");
  assert.equal(manifest.releases[0].sourceRepoUrl, "https://github.com/xhx/fork-llvm");
  assert.equal(manifest.releases[0].sourceRef, "xhx/fix-173706");
  assert.equal(
    manifest.releases[0].jsAsset,
    "https://raw.githubusercontent.com/octo/instcombine/wasm-artifacts-xhx-fork-llvm/branch-fix-173706-0123456789ab/instcombine_driver.js",
  );
});

test("mixed contents keep custom branch metadata and commit grouping", async () => {
  const root = await makeRoot();
  await writeBundle(root, "llvmorg-22.1.6");
  await writeBundle(root, "commit-260522-cdb098e33919", {
    metadata: {
      sourceRepoUrl: "https://github.com/xuhongxu96/llvm-project",
      sourceRef: "cdb098e3391952879e187b5f62e79bff29a49f3f",
      resolvedSha: "cdb098e3391952879e187b5f62e79bff29a49f3f",
      sourceKind: "commit",
    },
  });

  const manifest = await generateManifest(root, "wasm-artifacts-xuhongxu96-llvm-project");
  assert.equal(manifest.releases.length, 2);
  assert.equal(manifest.releases[0].tag, "llvmorg-22.1.6");
  assert.equal(manifest.releases[0].kind, "tag");
  assert.equal(manifest.releases[1].tag, "commit-260522-cdb098e33919");
  assert.equal(manifest.releases[1].kind, "commit");
  assert.equal(manifest.releases[1].sourceRef, "cdb098e3391952879e187b5f62e79bff29a49f3f");
});
