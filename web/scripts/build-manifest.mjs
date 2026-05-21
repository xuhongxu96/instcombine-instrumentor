#!/usr/bin/env node
// Build web/public/wasm/manifest.json from this repo's GitHub Releases.
//
// Two parallel bundling pipelines, keyed off the release tag shape:
//
//   * Tag releases — `release/llvmorg-X.Y.Z[-rcN]` from auto-release.yml or a
//     tag-based manual-release. Three-pass selection:
//       1. Force-include: any tag in `--include-file` / `--include <list>` is
//          bundled regardless of cap, dedupe, or prerelease flag.
//       2. Per-major newest: walk qualifying stable releases newest-first by
//          semver, bundle the first one for each LLVM major (highest minor
//          .patch wins).
//       3. Fill remaining slots up to `--bundle-count` with the next-newest
//          stable releases (older minor.patch of already-bundled majors) in
//          the same order. Anything not picked is dropped.
//
//   * Commit releases — `release/<YYMMDD>-<12hex>` from a SHA-based manual
//     -release. Bundle the newest `--commit-count` by publish date — they
//     don't share a cap with tag releases and never displace them. Use this
//     when releasing pre-tag LLVM snapshots; the UI puts them in their own
//     dropdown section so they don't crowd the stable-version picker.
//
// Force-includes apply to both pipelines and accept two entry shapes:
//   * Exact tag name — `release/llvmorg-22.1.5`, or `release/260520-abc123def456`
//     for a specific commit snapshot.
//   * Bare hex SHA (7-40 chars) — matched as a prefix against the 12-hex
//     suffix of any commit-snapshot release. Ergonomic when you know the
//     upstream commit but not its committer date.
// Qualifying = has both `instcombine_driver.js` and `instcombine_driver.wasm`
// as assets.
//
// We don't emit on-demand "remote" entries because GitHub release-asset URLs
// (both `github.com/.../releases/download/...` and the api.github.com asset
// URL) redirect to `release-assets.githubusercontent.com`, which doesn't set
// Access-Control-Allow-Origin — so a browser-side fetch can't load them
// without a same-origin proxy. Older minor versions of an already-bundled
// major simply don't appear in the version picker.
//
// CLI:
//   node web/scripts/build-manifest.mjs \
//     --owner <gh-owner> --repo <gh-repo> --out-dir <path> \
//     [--bundle-count 50] [--commit-count 10] \
//     [--include <tag,tag>] [--include-file <path>] \
//     [--api-base https://api.github.com]
//
// Reads GITHUB_TOKEN from env to raise the rate limit (works without it for small runs).

import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const args = parseArgs(process.argv.slice(2));
const owner = required(args.owner, "--owner");
const repo = required(args.repo, "--repo");
const outDir = path.resolve(required(args["out-dir"], "--out-dir"));
const bundleCount = Number(args["bundle-count"] ?? 50);
const commitCount = Number(args["commit-count"] ?? 10);
const apiBase = (args["api-base"] ?? "https://api.github.com").replace(/\/+$/, "");
const includeTags = await loadIncludeTags(args.include, args["include-file"]);

const JS_NAME = "instcombine_driver.js";
const WASM_NAME = "instcombine_driver.wasm";

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
        out[a.slice(2)] = true;
      } else {
        out[a.slice(2)] = next;
        i++;
      }
    }
  }
  return out;
}

function required(value, name) {
  if (value === undefined || value === "" || value === true) {
    console.error(`error: ${name} is required`);
    process.exit(2);
  }
  return value;
}

function slugify(tag) {
  return tag.replaceAll("/", "_");
}

// Parse the force-bundle list from `--include "tagA,tagB"` and/or
// `--include-file <path>`. The file format is one tag per line; blank lines
// and lines starting with `#` are ignored. Missing files are non-fatal (the
// list is just empty).
async function loadIncludeTags(inlineArg, filePathArg) {
  const out = new Set();
  if (typeof inlineArg === "string") {
    for (const t of inlineArg.split(",")) {
      const trimmed = t.trim();
      if (trimmed) out.add(trimmed);
    }
  }
  if (typeof filePathArg === "string") {
    try {
      const text = await readFile(filePathArg, "utf8");
      for (const line of text.split("\n")) {
        const trimmed = line.replace(/#.*$/, "").trim();
        if (trimmed) out.add(trimmed);
      }
    } catch (err) {
      if (err.code === "ENOENT") {
        console.log(`include-file ${filePathArg} not found — proceeding with no force-includes`);
      } else {
        throw err;
      }
    }
  }
  return out;
}

const LLVM_TAG_RE = /llvmorg-(\d+)\.(\d+)\.(\d+)(?:-rc(\d+))?/;
// Commit-snapshot tag shape produced by manual_release_tag.sh for SHA inputs:
// release/<YYMMDD>-<first-12-of-full-SHA>.
const COMMIT_TAG_RE = /^release\/(\d{6})-([0-9a-fA-F]{12})$/;

// Extract semver-ish ordering key from a tag like "release/llvmorg-22.1.6"
// or "release/llvmorg-22.1.0-rc3". Returns null if the tag doesn't match.
function parseTagVersion(tag) {
  const m = LLVM_TAG_RE.exec(tag);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    rc: m[4] === undefined ? null : Number(m[4]),
  };
}

function isCommitRelease(tag) {
  return COMMIT_TAG_RE.test(tag);
}

// Newest-first comparator: parseable tags rank ahead of unparseable ones; ties
// inside each group fall back to publish-date descending. rc releases come
// after the corresponding stable release of the same X.Y.Z.
function compareReleasesNewestFirst(a, b) {
  const va = parseTagVersion(a.release.tag_name);
  const vb = parseTagVersion(b.release.tag_name);
  if (va && vb) {
    if (va.major !== vb.major) return vb.major - va.major;
    if (va.minor !== vb.minor) return vb.minor - va.minor;
    if (va.patch !== vb.patch) return vb.patch - va.patch;
    // Stable (rc === null) is newer than any rc of the same X.Y.Z.
    if (va.rc === null && vb.rc !== null) return -1;
    if (va.rc !== null && vb.rc === null) return 1;
    if (va.rc !== vb.rc) return vb.rc - va.rc;
  } else if (va && !vb) {
    return -1;
  } else if (!va && vb) {
    return 1;
  }
  return new Date(b.release.published_at).getTime() -
    new Date(a.release.published_at).getTime();
}

async function ghFetch(url) {
  const headers = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "instcombine-instrumentor-manifest-builder",
  };
  if (process.env.GITHUB_TOKEN) {
    headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GET ${url} → ${res.status}: ${body.slice(0, 200)}`);
  }
  return res;
}

async function listReleases() {
  const out = [];
  let url = `${apiBase}/repos/${owner}/${repo}/releases?per_page=100`;
  while (url) {
    const res = await ghFetch(url);
    out.push(...(await res.json()));
    const link = res.headers.get("link") ?? "";
    const next = /<([^>]+)>;\s*rel="next"/.exec(link);
    url = next ? next[1] : null;
  }
  return out;
}

async function downloadAsset(asset, destPath) {
  const res = await ghFetch(asset.browser_download_url);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(destPath, buf);
  return buf.length;
}

async function main() {
  await mkdir(outDir, { recursive: true });

  const raw = await listReleases();
  console.log(`fetched ${raw.length} releases from ${owner}/${repo}`);

  const qualifying = [];
  for (const r of raw) {
    if (r.draft) continue;
    const assets = r.assets ?? [];
    const js = assets.find((a) => a.name === JS_NAME);
    const wasm = assets.find((a) => a.name === WASM_NAME);
    if (!js || !wasm) {
      console.log(`skip ${r.tag_name}: missing wasm assets`);
      continue;
    }
    qualifying.push({ release: r, jsAsset: js, wasmAsset: wasm });
  }

  // Split qualifying into two pipelines: commit snapshots (manual SHA-based
  // releases) and tag releases (everything else — llvmorg-X.Y.Z and any other
  // non-commit-shaped tags). They get bundled independently so a flood of
  // commit snapshots can't displace the stable per-major picks, and vice versa.
  const commitQualifying = [];
  const tagQualifying = [];
  for (const q of qualifying) {
    if (isCommitRelease(q.release.tag_name)) commitQualifying.push(q);
    else tagQualifying.push(q);
  }
  tagQualifying.sort(compareReleasesNewestFirst);
  commitQualifying.sort((a, b) =>
    new Date(b.release.published_at).getTime() -
    new Date(a.release.published_at).getTime(),
  );

  // Pass 1 — force-include any entry from the must-bundle list (no cap, no
  // prerelease filter, no dedupe). Applies to both pipelines. Entries match
  // either by exact `tag_name` (e.g. `release/llvmorg-22.1.5` or the full
  // `release/<YYMMDD>-<12hex>` commit-snapshot tag) OR — if the entry is a
  // bare 7-40 hex string — as a prefix against the 12-hex suffix of any
  // commit-snapshot release. The SHA-prefix form is the ergonomic option
  // since you usually know the upstream commit but not its committer date.
  const HEX_SHA_RE = /^[0-9a-fA-F]{7,40}$/;
  const toBundle = new Set();
  for (const t of includeTags) {
    let matched;
    if (HEX_SHA_RE.test(t)) {
      const tLower = t.toLowerCase();
      matched = qualifying.filter((q) => {
        const m = COMMIT_TAG_RE.exec(q.release.tag_name);
        return m && m[2].toLowerCase().startsWith(tLower);
      });
    } else {
      matched = qualifying.filter((q) => q.release.tag_name === t);
    }
    if (matched.length === 0) {
      console.warn(`include: ${t} did not match any qualifying release (skipping)`);
      continue;
    }
    for (const q of matched) toBundle.add(q.release.id);
  }

  // Pass 2 — per-major newest stable from tagQualifying. Auto-picks count
  // against bundleCount; force-included entries are extra. Older minor.patches
  // of an already-seen major land in `deferred` for the fill pass.
  const seenMajors = new Set();
  const deferred = [];
  let autoCount = 0;
  for (const q of tagQualifying) {
    if (q.release.prerelease) continue;
    const v = parseTagVersion(q.release.tag_name);
    if (toBundle.has(q.release.id)) {
      if (v) seenMajors.add(v.major);
      continue;
    }
    if (v && !seenMajors.has(v.major)) {
      if (autoCount >= bundleCount) continue;
      toBundle.add(q.release.id);
      seenMajors.add(v.major);
      autoCount++;
    } else {
      deferred.push(q);
    }
  }

  // Pass 3 — fill remaining tag slots with deferred entries, newest first.
  for (const q of deferred) {
    if (autoCount >= bundleCount) break;
    toBundle.add(q.release.id);
    autoCount++;
  }

  // Pass 4 — always bundle the newest `commitCount` commit snapshots by
  // publish date. Independent of bundleCount; force-included commit snapshots
  // are already in `toBundle` from Pass 1 and don't consume slots here.
  let commitAutoCount = 0;
  for (const q of commitQualifying) {
    if (toBundle.has(q.release.id)) continue;
    if (commitAutoCount >= commitCount) break;
    toBundle.add(q.release.id);
    commitAutoCount++;
  }

  // Emit tag entries first (newest-semver order), then commit entries (newest
  // publish-date order). The App.tsx dropdown groups by `kind`; this ordering
  // keeps each group internally sorted and makes the default-tag picker land
  // on the highest stable llvmorg.
  const releases = [];
  const emit = async (q, kind) => {
    const tag = q.release.tag_name;
    const slug = slugify(tag);
    const dir = path.join(outDir, slug);
    await mkdir(dir, { recursive: true });
    const jsPath = path.join(dir, JS_NAME);
    const wasmPath = path.join(dir, WASM_NAME);
    console.log(`bundling ${tag} (${kind}) → ${path.relative(process.cwd(), dir)}`);
    const [jsBytes, wasmBytes] = await Promise.all([
      downloadAsset(q.jsAsset, jsPath),
      downloadAsset(q.wasmAsset, wasmPath),
    ]);
    console.log(`  ${JS_NAME} ${jsBytes}B, ${WASM_NAME} ${wasmBytes}B`);
    releases.push({
      tag,
      name: q.release.name || tag,
      slug,
      kind,
      publishedAt: q.release.published_at,
      prerelease: q.release.prerelease,
      bundled: true,
      jsAsset: `${slug}/${JS_NAME}`,
      wasmAsset: `${slug}/${WASM_NAME}`,
    });
  };
  for (const q of tagQualifying) {
    if (!toBundle.has(q.release.id)) {
      console.log(`skip ${q.release.tag_name}: not bundled (older minor.patch, prerelease, or beyond bundle cap)`);
      continue;
    }
    await emit(q, "tag");
  }
  for (const q of commitQualifying) {
    if (!toBundle.has(q.release.id)) {
      console.log(`skip ${q.release.tag_name}: not bundled (beyond commit-count cap)`);
      continue;
    }
    await emit(q, "commit");
  }

  // Default selection prefers stable tag releases over commit snapshots.
  const defaultTag =
    releases.find((r) => r.bundled && r.kind === "tag" && !r.prerelease)?.tag ??
    releases.find((r) => r.bundled && !r.prerelease)?.tag ??
    releases[0]?.tag ??
    null;

  const manifest = {
    generatedAt: new Date().toISOString(),
    defaultTag,
    releases,
  };

  const outPath = path.join(outDir, "manifest.json");
  await writeFile(outPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`wrote ${outPath} (${releases.length} entries, default=${defaultTag ?? "(none)"})`);
}

main().catch((err) => {
  console.error(err.stack ?? err.message ?? String(err));
  process.exit(1);
});
