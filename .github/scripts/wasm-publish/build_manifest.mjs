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

import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const JS_NAME = "instcombine_driver.js";
const WASM_NAME = "instcombine_driver.wasm";
const TAG_RE = /^llvmorg-(\d+)\.(\d+)\.(\d+)(?:-rc(\d+))?$/;
const COMMIT_RE = /^main-(\d{6})-([0-9a-fA-F]{12})$/;
const METADATA_NAME = "metadata.json";

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

async function readMetadata(dirPath) {
  try {
    const text = await readFile(path.join(dirPath, METADATA_NAME), "utf8");
    const parsed = JSON.parse(text);
    if (
      typeof parsed?.sourceRepoUrl !== "string" ||
      typeof parsed?.sourceRef !== "string" ||
      typeof parsed?.resolvedSha !== "string" ||
      (parsed?.sourceKind !== "branch" && parsed?.sourceKind !== "commit")
    ) {
      throw new Error("metadata.json missing required fields");
    }
    return parsed;
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

// First commit that touched the directory — best-effort timestamp for the
// release entry. Falls back to "now" if git isn't available or the dir isn't
// tracked yet (e.g. brand-new build that hasn't been committed yet).
function dirAddedAt(rootPath, dir) {
  const res = spawnSync("git", [
    "-C", rootPath,
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
  if (!ka || !kb) {
    return new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime();
  }
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

export async function buildManifest({
  owner,
  repo,
  branch = "wasm-pkgs",
  root = ".",
  out,
}) {
  const resolvedRoot = path.resolve(root);
  const resolvedOut = path.resolve(out ?? path.join(resolvedRoot, "manifest.json"));
  const entries = await readdir(resolvedRoot, { withFileTypes: true });
  const tagReleases = [];
  const commitReleases = [];

  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (ent.name.startsWith(".")) continue;
    const meta = classify(ent.name);
    const dirPath = path.join(resolvedRoot, ent.name);
    try {
      await stat(path.join(dirPath, JS_NAME));
      await stat(path.join(dirPath, WASM_NAME));
    } catch {
      console.log(`skip ${ent.name}: missing ${JS_NAME} or ${WASM_NAME}`);
      continue;
    }
    const publishedAt = dirAddedAt(resolvedRoot, ent.name) ?? new Date().toISOString();
    const metadata = await readMetadata(dirPath);
    const releaseKind =
      metadata?.sourceKind === "commit" ? "commit" :
      meta?.kind ?? (metadata?.sourceKind === "branch" ? "tag" : null);
    if (!releaseKind) {
      console.log(`skip ${ent.name}: unrecognized directory shape and no metadata.json`);
      continue;
    }
    const sortKey =
      releaseKind === "tag"
        ? (meta?.kind === "tag" ? meta.sortKey : null)
        : (meta?.kind === "commit" ? meta.sortKey : { yymmdd: publishedAt.slice(2, 10).replace(/-/g, ""), sha: ent.name });
    const release = {
      tag: ent.name,
      name: ent.name,
      slug: ent.name,
      kind: releaseKind,
      publishedAt,
      prerelease: meta?.prerelease ?? false,
      bundled: false,
      jsAsset: `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${ent.name}/${JS_NAME}`,
      wasmAsset: `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${ent.name}/${WASM_NAME}`,
      ...(metadata ? {
        sourceRepoUrl: metadata.sourceRepoUrl,
        sourceRef: metadata.sourceRef,
      } : {}),
      _sortKey: sortKey,
    };
    if (releaseKind === "tag") tagReleases.push(release);
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

  await writeFile(resolvedOut, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`wrote ${resolvedOut}`);
  console.log(`  ${tagReleases.length} tag release(s), ${commitReleases.length} commit snapshot(s)`);
  console.log(`  defaultTag = ${defaultTag ?? "(none)"}`);
  return manifest;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const owner = required(args.owner, "--owner");
  const repo = required(args.repo, "--repo");
  const branch = args.branch ?? "wasm-pkgs";
  const root = path.resolve(args.root ?? ".");
  const outPath = path.resolve(args.out ?? path.join(root, "manifest.json"));
  await buildManifest({
    owner,
    repo,
    branch,
    root,
    out: outPath,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.stack ?? err.message ?? String(err));
    process.exit(1);
  });
}
