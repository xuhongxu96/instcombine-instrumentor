#!/usr/bin/env node
// Regenerate `manifest.json` at the root of the `wasm-pkgs` branch by scanning
// sibling directories for `instcombine_driver.{js,wasm}` pairs. Run inside a
// checkout of the wasm-pkgs branch (the CWD or the dir passed via --root).
//
// Directory naming convention (set by wasm-publish.yml):
//   llvmorg-X.Y.Z[-rcN]        — stable / rc upstream LLVM tag (kind=tag)
//   main-<YYMMDD>-<sha12>      — scheduled LLVM main snapshot   (kind=commit)
//
// Each qualifying dir becomes a WasmRelease entry with absolute
// raw.githubusercontent.com URLs. `bundled: false` everywhere — bundling
// happens later at Pages-deploy time (see web/scripts/build-manifest.mjs).
//
// CLI:
//   node build_wasm_manifest.mjs \
//     --owner <gh-owner> --repo <gh-repo> \
//     [--branch wasm-pkgs] [--root .] [--out manifest.json]

import { readdir, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const args = parseArgs(process.argv.slice(2));
const owner = required(args.owner, "--owner");
const repo = required(args.repo, "--repo");
const branch = args.branch ?? "wasm-pkgs";
const root = path.resolve(args.root ?? ".");
const outPath = path.resolve(args.out ?? path.join(root, "manifest.json"));

const JS_NAME = "instcombine_driver.js";
const WASM_NAME = "instcombine_driver.wasm";
const TAG_RE = /^llvmorg-(\d+)\.(\d+)\.(\d+)(?:-rc(\d+))?$/;
const COMMIT_RE = /^main-(\d{6})-([0-9a-fA-F]{12})$/;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq !== -1) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        out[a.slice(2)] = "true";
      } else {
        out[a.slice(2)] = next;
        i++;
      }
    }
  }
  return out;
}

function required(value, name) {
  if (value === undefined || value === "" || value === "true") {
    console.error(`error: ${name} is required`);
    process.exit(2);
  }
  return value;
}

function rawUrl(dir, file) {
  return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${dir}/${file}`;
}

// First commit that touched the directory — best-effort timestamp for the
// release entry. Falls back to "now" if git isn't available or the dir isn't
// tracked yet (e.g. brand-new build that hasn't been committed yet).
function dirAddedAt(dir) {
  const res = spawnSync("git", [
    "-C", root,
    "log", "--diff-filter=A", "--format=%aI", "--", `${dir}/`,
  ], { encoding: "utf8" });
  if (res.status !== 0) return null;
  const lines = res.stdout.split("\n").filter(Boolean);
  return lines.length ? lines[lines.length - 1] : null;
}

function classify(name) {
  const tag = TAG_RE.exec(name);
  if (tag) {
    return {
      kind: "tag",
      sortKey: {
        major: Number(tag[1]),
        minor: Number(tag[2]),
        patch: Number(tag[3]),
        rc: tag[4] === undefined ? null : Number(tag[4]),
      },
      prerelease: tag[4] !== undefined,
    };
  }
  const commit = COMMIT_RE.exec(name);
  if (commit) {
    return {
      kind: "commit",
      sortKey: { yymmdd: commit[1], sha: commit[2] },
      prerelease: false,
    };
  }
  return null;
}

// Tag entries: newest-first by semver (stable beats its own rc).
function compareTagDesc(a, b) {
  const ka = a._sortKey, kb = b._sortKey;
  if (ka.major !== kb.major) return kb.major - ka.major;
  if (ka.minor !== kb.minor) return kb.minor - ka.minor;
  if (ka.patch !== kb.patch) return kb.patch - ka.patch;
  if (ka.rc === null && kb.rc !== null) return -1;
  if (ka.rc !== null && kb.rc === null) return 1;
  if (ka.rc !== kb.rc) return (kb.rc ?? 0) - (ka.rc ?? 0);
  return 0;
}

// Commit entries: newest-first by YYMMDD prefix (lexicographic = chronological
// since the format is zero-padded).
function compareCommitDesc(a, b) {
  if (a._sortKey.yymmdd !== b._sortKey.yymmdd) {
    return a._sortKey.yymmdd < b._sortKey.yymmdd ? 1 : -1;
  }
  return 0;
}

async function main() {
  const entries = await readdir(root, { withFileTypes: true });
  const tagReleases = [];
  const commitReleases = [];

  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (ent.name.startsWith(".")) continue;
    const meta = classify(ent.name);
    if (!meta) continue;
    const dirPath = path.join(root, ent.name);
    try {
      await stat(path.join(dirPath, JS_NAME));
      await stat(path.join(dirPath, WASM_NAME));
    } catch {
      console.log(`skip ${ent.name}: missing ${JS_NAME} or ${WASM_NAME}`);
      continue;
    }
    const publishedAt = dirAddedAt(ent.name) ?? new Date().toISOString();
    const release = {
      tag: ent.name,
      name: ent.name,
      slug: ent.name,
      kind: meta.kind,
      publishedAt,
      prerelease: meta.prerelease,
      bundled: false,
      jsAsset: rawUrl(ent.name, JS_NAME),
      wasmAsset: rawUrl(ent.name, WASM_NAME),
      _sortKey: meta.sortKey,
    };
    if (meta.kind === "tag") tagReleases.push(release);
    else commitReleases.push(release);
  }

  tagReleases.sort(compareTagDesc);
  commitReleases.sort(compareCommitDesc);

  const releases = [...tagReleases, ...commitReleases].map((r) => {
    const { _sortKey, ...rest } = r;
    return rest;
  });

  const defaultTag =
    tagReleases.find((r) => !r.prerelease)?.tag ??
    tagReleases[0]?.tag ??
    commitReleases[0]?.tag ??
    null;

  const manifest = {
    generatedAt: new Date().toISOString(),
    defaultTag,
    releases,
  };

  await writeFile(outPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`wrote ${outPath}`);
  console.log(`  ${tagReleases.length} tag release(s), ${commitReleases.length} commit snapshot(s)`);
  console.log(`  defaultTag = ${defaultTag ?? "(none)"}`);
}

main().catch((err) => {
  console.error(err.stack ?? err.message ?? String(err));
  process.exit(1);
});
