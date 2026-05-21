#!/usr/bin/env node
// Build web/public/wasm/manifest.json from this repo's GitHub Releases.
//
// For each release whose assets include both `instcombine_driver.js` and
// `instcombine_driver.wasm`:
//   - the newest stable (non-prerelease) release per LLVM major version is
//     downloaded into `<out-dir>/<slug>/` and recorded as a bundled entry,
//     capped at --bundle-count entries total.
//   - all other qualifying releases (older minor.patch in an already-bundled
//     major, prereleases, anything beyond the cap) are recorded as remote
//     entries pointing at the GitHub asset URL (the webapp fetches them on
//     demand).
// Releases whose assets do not include both files are filtered out entirely.
//
// CLI:
//   node web/scripts/build-manifest.mjs \
//     --owner <gh-owner> --repo <gh-repo> --out-dir <path> \
//     [--bundle-count 10] [--api-base https://api.github.com]
//
// Reads GITHUB_TOKEN from env to raise the rate limit (works without it for small runs).

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const args = parseArgs(process.argv.slice(2));
const owner = required(args.owner, "--owner");
const repo = required(args.repo, "--repo");
const outDir = path.resolve(required(args["out-dir"], "--out-dir"));
const bundleCount = Number(args["bundle-count"] ?? 10);
const apiBase = (args["api-base"] ?? "https://api.github.com").replace(/\/+$/, "");

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

  // Bundle at most one stable release per LLVM major version (newest minor.patch
  // wins, thanks to the semver sort above), capped at bundleCount entries.
  // Unparseable tags slip through the per-major dedupe (they have no major).
  const toBundle = new Set();
  const seenMajors = new Set();
  for (const q of qualifying) {
    if (q.release.prerelease) continue;
    if (toBundle.size >= bundleCount) break;
    const v = parseTagVersion(q.release.tag_name);
    if (v) {
      if (seenMajors.has(v.major)) continue;
      seenMajors.add(v.major);
    }
    toBundle.add(q.release.id);
  }

  const releases = [];
  for (const q of qualifying) {
    const tag = q.release.tag_name;
    const slug = slugify(tag);
    const isBundled = toBundle.has(q.release.id);
    if (isBundled) {
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
    } else {
      releases.push({
        tag,
        name: q.release.name || tag,
        slug,
        publishedAt: q.release.published_at,
        prerelease: q.release.prerelease,
        bundled: false,
        jsAsset: q.jsAsset.browser_download_url,
        wasmAsset: q.wasmAsset.browser_download_url,
      });
    }
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
