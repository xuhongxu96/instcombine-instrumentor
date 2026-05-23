import test from "node:test";
import assert from "node:assert/strict";
import {
  artifactBranchName,
  buildMetadata,
  parseGitHubSourceUrl,
  publishDirectory,
  sanitizeBranchComponent,
} from "./resolve_custom_source_lib.mjs";

for (const prefix of ["tree", "commit"]) {
  test(`parses branch ${prefix} URLs`, () => {
    const parsed = parseGitHubSourceUrl(`https://github.com/xhx/fork-llvm/${prefix}/xhx/fix-173706`);
    assert.deepEqual(parsed, {
      owner: "xhx",
      repo: "fork-llvm",
      sourceRepoUrl: "https://github.com/xhx/fork-llvm",
      llvmRemote: "https://github.com/xhx/fork-llvm.git",
      sourceKind: "branch",
      sourceRef: "xhx/fix-173706",
    });
  });

  test(`treats ${prefix} hex refs as commits`, () => {
    const parsed = parseGitHubSourceUrl(
      `https://github.com/xuhongxu96/llvm-project/${prefix}/cdb098e3391952879e187b5f62e79bff29a49f3f`,
    );
    assert.deepEqual(parsed, {
      owner: "xuhongxu96",
      repo: "llvm-project",
      sourceRepoUrl: "https://github.com/xuhongxu96/llvm-project",
      llvmRemote: "https://github.com/xuhongxu96/llvm-project.git",
      sourceKind: "commit",
      sourceRef: "cdb098e3391952879e187b5f62e79bff29a49f3f",
    });
  });
}

test("rejects unsupported hosts and paths", () => {
  assert.throws(
    () => parseGitHubSourceUrl("https://example.com/x/y/tree/main"),
    /only github\.com URLs are supported/,
  );
  assert.throws(
    () => parseGitHubSourceUrl("https://github.com/x/y/blob/main/foo.cpp"),
    /unsupported GitHub URL/,
  );
});

test("sanitizes artifact-branch components", () => {
  assert.equal(sanitizeBranchComponent("Org///LLVM Project"), "org-llvm-project");
  assert.equal(artifactBranchName("Xuhongxu96", "llvm/project"), "wasm-artifacts-xuhongxu96-llvm-project");
});

test("computes immutable publish directories and metadata", () => {
  const parsed = parseGitHubSourceUrl("https://github.com/xhx/fork-llvm/tree/xhx/fix-173706");
  const meta = buildMetadata(parsed, "0123456789abcdef0123456789abcdef01234567", "2026-05-22T06:07:08Z");
  assert.deepEqual(meta, {
    sourceRepoUrl: "https://github.com/xhx/fork-llvm",
    sourceRef: "xhx/fix-173706",
    resolvedSha: "0123456789abcdef0123456789abcdef01234567",
    sourceKind: "branch",
    committedAt: "2026-05-22T06:07:08Z",
  });
  assert.equal(
    publishDirectory(meta),
    "branch-xhx-fix-173706-0123456789ab",
  );

  assert.equal(
    publishDirectory({
      sourceKind: "commit",
      sourceRef: "0123456789abcdef0123456789abcdef01234567",
      resolvedSha: "0123456789abcdef0123456789abcdef01234567",
      committedAt: "2026-05-22T06:07:08Z",
    }),
    "commit-260522-0123456789ab",
  );
});
