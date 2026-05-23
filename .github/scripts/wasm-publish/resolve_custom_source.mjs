#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  artifactBranchName,
  buildMetadata,
  parseGitHubSourceUrl,
  publishDirectory,
} from "./resolve_custom_source_lib.mjs";

const args = parseArgs(process.argv.slice(2));
const llvmSourceUrl = required(args["llvm-source-url"], "--llvm-source-url");
const outDir = path.resolve(args["out-dir"] ?? process.env.RUNNER_TEMP ?? "/tmp");
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq !== -1) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[a.slice(2)] = "true";
    else {
      out[a.slice(2)] = next;
      i++;
    }
  }
  return out;
}

function required(value, name) {
  if (value === undefined || value === "" || value === "true") {
    throw new Error(`${name} is required`);
  }
  return value;
}

async function gh(pathname) {
  const res = await fetch(`https://api.github.com/${pathname}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "instcombine-instrumentor-wasm-custom-publish",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub API ${pathname} -> HTTP ${res.status}`);
  }
  return res.json();
}

async function resolveParsedSource(parsed) {
  const base = `repos/${parsed.owner}/${parsed.repo}`;
  if (parsed.sourceKind === "branch") {
    const branch = await gh(`${base}/branches/${encodeURIComponent(parsed.sourceRef)}`);
    const resolvedSha = branch?.commit?.sha;
    if (!resolvedSha) throw new Error(`branch ${parsed.sourceRef} did not resolve to a commit SHA`);
    const commit = await gh(`${base}/commits/${resolvedSha}`);
    return {
      resolvedSha,
      committedAt: commit?.commit?.committer?.date ?? commit?.commit?.author?.date,
    };
  }
  const commit = await gh(`${base}/commits/${encodeURIComponent(parsed.sourceRef)}`);
  return {
    resolvedSha: commit?.sha,
    committedAt: commit?.commit?.committer?.date ?? commit?.commit?.author?.date,
  };
}

async function main() {
  const parsed = parseGitHubSourceUrl(llvmSourceUrl);
  const { resolvedSha, committedAt } = await resolveParsedSource(parsed);
  if (!resolvedSha || !committedAt) {
    throw new Error("failed to resolve commit metadata from GitHub");
  }

  const targetBranch = artifactBranchName(parsed.owner, parsed.repo);
  const metadata = buildMetadata(parsed, resolvedSha, committedAt);
  const publishDir = publishDirectory({
    sourceKind: metadata.sourceKind,
    sourceRef: metadata.sourceRef,
    resolvedSha,
    committedAt,
  });

  await mkdir(outDir, { recursive: true });
  const metadataFile = path.join(outDir, "metadata.json");
  const refsFile = path.join(outDir, "refs.tsv");
  await writeFile(metadataFile, JSON.stringify(metadata, null, 2) + "\n");
  await writeFile(refsFile, `${publishDir}\t${resolvedSha}\n`);

  const outputs = {
    llvm_remote: parsed.llvmRemote,
    source_repo_url: parsed.sourceRepoUrl,
    source_ref: metadata.sourceRef,
    source_kind: metadata.sourceKind,
    resolved_sha: resolvedSha,
    target_branch: targetBranch,
    publish_dir: publishDir,
    metadata_file: metadataFile,
    refs_file: refsFile,
    display_name: publishDir,
  };

  const sink = process.env.GITHUB_OUTPUT;
  if (sink) {
    const lines = Object.entries(outputs).map(([k, v]) => `${k}=${v}`);
    await writeFile(sink, lines.join("\n") + "\n", { flag: "a" });
  } else {
    for (const [k, v] of Object.entries(outputs)) console.log(`${k}=${v}`);
  }
}

main().catch((err) => {
  console.error(err.stack ?? err.message ?? String(err));
  process.exit(1);
});
