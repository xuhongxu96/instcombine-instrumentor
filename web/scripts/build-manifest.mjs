#!/usr/bin/env node
// Build web/public/wasm/manifest.json from this repo's GitHub Releases.
//
// For each release whose assets include both `instcombine_driver.js` and
// `instcombine_driver.wasm`:
//   - the newest N stable (non-prerelease) releases are downloaded into
//     `<out-dir>/<slug>/` and recorded as bundled entries.
//   - all other qualifying releases are recorded as remote entries pointing at
//     the GitHub asset URL (the webapp fetches them on demand).
// Releases whose assets do not include both files are filtered out entirely.
//
// If `--bootstrap` is passed and `<out-dir>/_latest/instcombine_driver.{js,wasm}`
// exists, a synthetic "(latest build)" bundled entry is added at the top of the
// list — so the Pages site stays functional before any release/* tag is pushed.
//
// CLI:
//   node web/scripts/build-manifest.mjs \
//     --owner <gh-owner> --repo <gh-repo> --out-dir <path> \
//     [--bundle-count 10] [--bootstrap] [--api-base https://api.github.com]
//
// Reads GITHUB_TOKEN from env to raise the rate limit (works without it for small runs).

import { mkdir, writeFile, access } from "node:fs/promises";
import { constants as FS_CONST } from "node:fs";
import path from "node:path";
import process from "node:process";

const args = parseArgs(process.argv.slice(2));
const owner = required(args.owner, "--owner");
const repo = required(args.repo, "--repo");
const outDir = path.resolve(required(args["out-dir"], "--out-dir"));
const bundleCount = Number(args["bundle-count"] ?? 10);
const includeBootstrap = args.bootstrap === true || args.bootstrap === "true";
const apiBase = (args["api-base"] ?? "https://api.github.com").replace(/\/+$/, "");

const JS_NAME = "instcombine_driver.js";
const WASM_NAME = "instcombine_driver.wasm";
const BOOTSTRAP_SLUG = "_latest";

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

async function fileExists(p) {
  try {
    await access(p, FS_CONST.R_OK);
    return true;
  } catch {
    return false;
  }
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

  // Newest-first by publish date.
  qualifying.sort((a, b) =>
    new Date(b.release.published_at).getTime() - new Date(a.release.published_at).getTime(),
  );

  // Bundle only the newest N stable (non-prerelease).
  const stableQueue = qualifying.filter((q) => !q.release.prerelease);
  const toBundle = new Set(stableQueue.slice(0, bundleCount).map((q) => q.release.id));

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

  if (includeBootstrap) {
    const bootJs = path.join(outDir, BOOTSTRAP_SLUG, JS_NAME);
    const bootWasm = path.join(outDir, BOOTSTRAP_SLUG, WASM_NAME);
    if ((await fileExists(bootJs)) && (await fileExists(bootWasm))) {
      const synthetic = {
        tag: "(latest build)",
        name: "(latest build)",
        slug: BOOTSTRAP_SLUG,
        publishedAt: new Date().toISOString(),
        prerelease: false,
        bundled: true,
        jsAsset: `${BOOTSTRAP_SLUG}/${JS_NAME}`,
        wasmAsset: `${BOOTSTRAP_SLUG}/${WASM_NAME}`,
      };
      releases.unshift(synthetic);
      console.log(`added bootstrap entry (latest build) from ${BOOTSTRAP_SLUG}/`);
    } else {
      console.log(`bootstrap requested but ${BOOTSTRAP_SLUG}/ has no driver — skipping`);
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
