#!/usr/bin/env node
// Build web/public/wasm/manifest.json from this repo's GitHub Releases.
//
// Bundling policy (qualifying = has both `instcombine_driver.js` and
// `instcombine_driver.wasm` as assets):
//   1. Force-include: any release whose tag appears in `--include-file` (or
//      `--include <comma list>`) is bundled regardless of cap, dedupe, or
//      prerelease flag. Use this to keep specific older minor.patch or
//      prerelease versions selectable.
//   2. Per-major newest: walk qualifying stable releases newest-first by
//      semver, bundle the first one for each LLVM major version (the highest
//      minor.patch wins).
//   3. Fill remaining slots up to `--bundle-count` with the next-newest
//      stable releases (older minor.patch of already-bundled majors), in the
//      same newest-major-first / newest-minor-first order as step 2.
// The cap from `--bundle-count` applies to auto-selected entries (steps 2+3);
// force-included entries are extra and never displaced. Everything else
// (releases not selected by any of the three passes) is dropped from the
// manifest entirely.
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
//     [--bundle-count 50] [--include <tag,tag>] [--include-file <path>] \
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

  // Newest-first by tag semver (llvmorg-X.Y.Z[-rcN]); falls back to publish
  // date for tags that don't match the pattern.
  qualifying.sort(compareReleasesNewestFirst);

  // Pass 1 — force-include any tag in the must-bundle list (no cap, no
  // prerelease filter, no dedupe).
  const toBundle = new Set();
  for (const q of qualifying) {
    if (includeTags.has(q.release.tag_name)) toBundle.add(q.release.id);
  }
  for (const t of includeTags) {
    if (!qualifying.some((q) => q.release.tag_name === t)) {
      console.warn(`include: tag ${t} not found among qualifying releases (skipping)`);
    }
  }

  // Pass 2 — per-major newest stable. Auto-picks count against bundleCount;
  // force-included entries are extra. Older minor.patches of an already-seen
  // major land in `deferred` for the fill pass.
  const seenMajors = new Set();
  const deferred = [];
  let autoCount = 0;
  for (const q of qualifying) {
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

  // Pass 3 — fill remaining auto slots with deferred entries, newest first.
  for (const q of deferred) {
    if (autoCount >= bundleCount) break;
    toBundle.add(q.release.id);
    autoCount++;
  }

  const releases = [];
  for (const q of qualifying) {
    const tag = q.release.tag_name;
    const slug = slugify(tag);
    const isBundled = toBundle.has(q.release.id);
    if (!isBundled) {
      // Cross-origin fetches of GitHub release assets fail CORS (the public
      // download URL and the api.github.com asset URL both redirect to
      // release-assets.githubusercontent.com, which omits
      // Access-Control-Allow-Origin). Without a same-origin proxy the worker
      // can't load these in-browser, so we drop them from the manifest rather
      // than show a dropdown entry that would error at load time.
      console.log(`skip ${tag}: not bundled (older minor.patch, prerelease, or beyond bundle cap)`);
      continue;
    }
    const dir = path.join(outDir, slug);
    await mkdir(dir, { recursive: true });
    const jsPath = path.join(dir, JS_NAME);
    const wasmPath = path.join(dir, WASM_NAME);
    console.log(`bundling ${tag} → ${path.relative(process.cwd(), dir)}`);
    const [jsBytes, wasmBytes] = await Promise.all([
      downloadAsset(q.jsAsset, jsPath),
      downloadAsset(q.wasmAsset, wasmPath),
    ]);
    console.log(`  ${JS_NAME} ${jsBytes}B, ${WASM_NAME} ${wasmBytes}B`);
    releases.push({
      tag,
      name: q.release.name || tag,
      slug,
      publishedAt: q.release.published_at,
      prerelease: q.release.prerelease,
      bundled: true,
      jsAsset: `${slug}/${JS_NAME}`,
      wasmAsset: `${slug}/${WASM_NAME}`,
    });
  }

  const defaultTag =
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
