const TREE_PREFIX = "/tree/";
const COMMIT_PREFIX = "/commit/";
const COMMITS_PREFIX = "/commits/";
const HEX_RE = /^[0-9a-fA-F]{7,40}$/;

function parseRepoRefPath(path, prefix, expectedPattern) {
  const idx = path.indexOf(prefix);
  if (idx <= 0) return null;

  const repoPath = path.slice(1, idx);
  const ref = decodeURIComponent(path.slice(idx + prefix.length));
  const parts = repoPath.split("/");
  if (parts.length !== 2 || !ref) {
    throw new Error(expectedPattern);
  }

  const [owner, repo] = parts;
  return {
    owner,
    repo,
    sourceRepoUrl: `https://github.com/${owner}/${repo}`,
    llvmRemote: `https://github.com/${owner}/${repo}.git`,
    sourceKind: HEX_RE.test(ref) ? "commit" : "branch",
    sourceRef: ref,
  };
}

export function sanitizeBranchComponent(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "") || "x";
}

export function parseGitHubSourceUrl(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`invalid URL: ${input}`);
  }
  if (url.protocol !== "https:") throw new Error("only https:// GitHub URLs are supported");
  if (url.hostname !== "github.com") throw new Error("only github.com URLs are supported");

  const path = url.pathname.replace(/\/+$/, "");
  const treeParsed = parseRepoRefPath(
    path,
    TREE_PREFIX,
    "expected https://github.com/<owner>/<repo>/tree/<branch-or-sha>",
  );
  if (treeParsed) return treeParsed;

  const commitParsed = parseRepoRefPath(
    path,
    COMMIT_PREFIX,
    "expected https://github.com/<owner>/<repo>/commit/<branch-or-sha>",
  );
  if (commitParsed) return commitParsed;

  const commitsParsed = parseRepoRefPath(
    path,
    COMMITS_PREFIX,
    "expected https://github.com/<owner>/<repo>/commits/<branch-or-sha>",
  );
  if (commitsParsed) return commitsParsed;

  throw new Error(
    "unsupported GitHub URL; expected /tree/<branch-or-sha>, /commit/<branch-or-sha>, or /commits/<branch-or-sha>",
  );
}

export function artifactBranchName(owner, repo) {
  return `wasm-artifacts-${sanitizeBranchComponent(owner)}-${sanitizeBranchComponent(repo)}`;
}

export function publishDirectory({ sourceKind, sourceRef, resolvedSha, committedAt }) {
  const sha12 = resolvedSha.slice(0, 12).toLowerCase();
  if (sourceKind === "branch") {
    return `branch-${sanitizeBranchComponent(sourceRef)}-${sha12}`;
  }
  const date = new Date(committedAt);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`invalid commit date: ${committedAt}`);
  }
  const yymmdd = [
    date.getUTCFullYear().toString().slice(-2),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("");
  return `commit-${yymmdd}-${sha12}`;
}

export function buildMetadata(parsed, resolvedSha, committedAt) {
  const sourceRef = parsed.sourceKind === "branch" ? parsed.sourceRef : resolvedSha;
  return {
    sourceRepoUrl: parsed.sourceRepoUrl,
    sourceRef,
    resolvedSha,
    sourceKind: parsed.sourceKind,
    committedAt,
  };
}
