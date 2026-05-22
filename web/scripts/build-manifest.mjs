#!/usr/bin/env node
// Pages-time bundler/transformer. Reads the remote `wasm-pkgs/manifest.json`
// published by .github/workflows/wasm-pkgs.yml and emits a local
// `web/public/wasm/manifest.json` shaped by --bundle-mode:
//
//   remote   — copy the remote manifest verbatim; webapp fetches everything
//              at runtime from raw.githubusercontent.com. Smallest deploy.
//   hybrid   — select a small subset (newest stable tag per LLVM major up to
//              --bundle-count, plus --include-file / --include force-bundles),
//              download those into web/public/wasm/<slug>/ and rewrite their
//              entries as bundled (same-origin URLs). Everything else stays
//              remote in the same manifest.
//   bundled  — bundle every entry locally. Equivalent to today's behaviour but
//              sourced from wasm-pkgs instead of GitHub Releases.
//
// Why the three modes: raw.githubusercontent.com sends CORS-friendly headers,
// so pure-remote works in principle. Local bundling is the safety net in case
// that ever changes — the operator can flip via CI input without touching code.
//
// CLI:
//   node web/scripts/build-manifest.mjs \
//     --bundle-mode <remote|hybrid|bundled> \
//     --remote-manifest-url <url> \
//     --out-dir <path> \
//     [--bundle-count 5] [--include-commit-count 0] \
//     [--include <csv>] [--include-file <path>]

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const args = parseArgs(process.argv.slice(2));
const bundleMode = required(args["bundle-mode"], "--bundle-mode");
if (!["remote", "hybrid", "bundled"].includes(bundleMode)) {
  console.error(`error: --bundle-mode must be remote|hybrid|bundled (got "${bundleMode}")`);
  process.exit(2);
}
const remoteManifestUrl = required(args["remote-manifest-url"], "--remote-manifest-url");
const outDir = path.resolve(required(args["out-dir"], "--out-dir"));
const bundleCount = Number(args["bundle-count"] ?? 5);
const includeCommitCount = Number(args["include-commit-count"] ?? 0);
const includeTags = await loadIncludeTags(args.include, args["include-file"]);

const JS_NAME = "instcombine_driver.js";
const WASM_NAME = "instcombine_driver.wasm";
const TAG_RE = /^llvmorg-(\d+)\.(\d+)\.(\d+)(?:-rc(\d+))?$/;
const COMMIT_RE = /^main-(\d{6})-([0-9a-fA-F]{12})$/;
const HEX_SHA_RE = /^[0-9a-fA-F]{7,40}$/;

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

async function fetchRemoteManifest() {
  console.log(`fetching remote manifest: ${remoteManifestUrl}`);
  const res = await fetch(remoteManifestUrl, {
    headers: { "user-agent": "instcombine-instrumentor-pages-builder" },
  });
  if (!res.ok) throw new Error(`GET ${remoteManifestUrl} → ${res.status}`);
  return res.json();
}

async function downloadTo(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(destPath, buf);
  return buf.length;
}

// Mirrors how the operator typically lists must-bundle entries: either an
// exact tag (e.g. "llvmorg-22.1.5" / "main-260520-abc123def456") or a bare
// hex SHA prefix matched against the 12-hex suffix of any commit snapshot.
function matchInclude(release, entry) {
  if (release.tag === entry) return true;
  if (HEX_SHA_RE.test(entry)) {
    const m = COMMIT_RE.exec(release.tag);
    if (m && m[2].toLowerCase().startsWith(entry.toLowerCase())) return true;
  }
  return false;
}

function parseTagVersion(tag) {
  const m = TAG_RE.exec(tag);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    rc: m[4] === undefined ? null : Number(m[4]),
  };
}

function compareTagDesc(a, b) {
  const va = parseTagVersion(a.tag), vb = parseTagVersion(b.tag);
  if (va && vb) {
    if (va.major !== vb.major) return vb.major - va.major;
    if (va.minor !== vb.minor) return vb.minor - va.minor;
    if (va.patch !== vb.patch) return vb.patch - va.patch;
    if (va.rc === null && vb.rc !== null) return -1;
    if (va.rc !== null && vb.rc === null) return 1;
    if (va.rc !== vb.rc) return (vb.rc ?? 0) - (va.rc ?? 0);
  } else if (va) return -1;
  else if (vb) return 1;
  return new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime();
}

// Build the set of release ids to bundle locally. Returns a Set of release tags.
function pickBundles(releases) {
  const toBundle = new Set();

  // Pass 1 — force-includes (no cap, no dedupe).
  for (const entry of includeTags) {
    const matched = releases.filter((r) => matchInclude(r, entry));
    if (matched.length === 0) {
      console.warn(`include: ${entry} did not match any release (skipping)`);
      continue;
    }
    for (const r of matched) toBundle.add(r.tag);
  }

  const tagReleases = releases.filter((r) => r.kind !== "commit").sort(compareTagDesc);
  const commitReleases = releases.filter((r) => r.kind === "commit").sort((a, b) =>
    new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime(),
  );

  // Pass 2 — newest stable per major up to bundleCount.
  const seenMajors = new Set();
  const deferredTags = [];
  let autoCount = 0;
  for (const r of tagReleases) {
    if (r.prerelease) continue;
    const v = parseTagVersion(r.tag);
    if (toBundle.has(r.tag)) {
      if (v) seenMajors.add(v.major);
      continue;
    }
    if (v && !seenMajors.has(v.major)) {
      if (autoCount >= bundleCount) continue;
      toBundle.add(r.tag);
      seenMajors.add(v.major);
      autoCount++;
    } else {
      deferredTags.push(r);
    }
  }

  // Pass 3 — fill any remaining tag slots with deferred (older minor.patch
  // of an already-seen major, or unparseable tags).
  for (const r of deferredTags) {
    if (autoCount >= bundleCount) break;
    toBundle.add(r.tag);
    autoCount++;
  }

  // Pass 4 — newest commit snapshots up to includeCommitCount.
  let commitAutoCount = 0;
  for (const r of commitReleases) {
    if (toBundle.has(r.tag)) continue;
    if (commitAutoCount >= includeCommitCount) break;
    toBundle.add(r.tag);
    commitAutoCount++;
  }

  return toBundle;
}

async function emitBundle(release, dirAbs) {
  const slug = release.slug || release.tag;
  const destDir = path.join(dirAbs, slug);
  await mkdir(destDir, { recursive: true });
  console.log(`bundling ${release.tag} → ${path.relative(process.cwd(), destDir)}`);
  const jsPath = path.join(destDir, JS_NAME);
  const wasmPath = path.join(destDir, WASM_NAME);
  const [jsBytes, wasmBytes] = await Promise.all([
    downloadTo(release.jsAsset, jsPath),
    downloadTo(release.wasmAsset, wasmPath),
  ]);
  console.log(`  ${JS_NAME} ${jsBytes}B, ${WASM_NAME} ${wasmBytes}B`);
  return {
    ...release,
    slug,
    bundled: true,
    jsAsset: `${slug}/${JS_NAME}`,
    wasmAsset: `${slug}/${WASM_NAME}`,
  };
}

async function main() {
  await mkdir(outDir, { recursive: true });

  const remote = await fetchRemoteManifest();
  const releases = remote.releases ?? [];
  console.log(`remote manifest has ${releases.length} release(s); mode=${bundleMode}`);

  if (bundleMode === "remote") {
    // Pass-through: webapp will fetch each release direct from raw URL.
    const manifest = {
      generatedAt: new Date().toISOString(),
      defaultTag: remote.defaultTag ?? null,
      releases: releases.map((r) => ({ ...r, bundled: false })),
    };
    await writeFile(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    console.log(`wrote ${outDir}/manifest.json (pure remote)`);
    return;
  }

  let toBundle;
  if (bundleMode === "bundled") {
    toBundle = new Set(releases.map((r) => r.tag));
  } else {
    toBundle = pickBundles(releases);
  }

  const final = [];
  for (const r of releases) {
    if (toBundle.has(r.tag)) {
      final.push(await emitBundle(r, outDir));
    } else {
      final.push({ ...r, bundled: false });
    }
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    defaultTag: remote.defaultTag ?? null,
    releases: final,
  };
  await writeFile(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  const bundledCount = final.filter((r) => r.bundled).length;
  console.log(
    `wrote ${outDir}/manifest.json — ${bundledCount} bundled, ${final.length - bundledCount} remote, default=${manifest.defaultTag ?? "(none)"}`,
  );
}

main().catch((err) => {
  console.error(err.stack ?? err.message ?? String(err));
  process.exit(1);
});
