// Offline development experiment. Never executes repository source or contacts GitHub.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rankFilePaths } from "../src/retrieval.ts";
import { rankFileContents } from "../src/contentRetrieval.ts";

export const policy = {
  version: "task13-source-pool-v1",
  extensions: [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".py", ".sql"],
  excludedDirectories: ["node_modules", "vendor", "dist", "build", "coverage", ".git", ".venv", "venv", "__pycache__"],
  excludedSuffixes: [".min.js", ".d.ts"],
  maxFiles: 100,
  maxFileBytes: 100_000,
  maxTotalBytes: 2_000_000,
};

export function exclusionReason(entry) {
  if (entry.type !== "blob" || !["100644", "100755"].includes(entry.mode)) return "not-regular-file";
  const path = entry.path.toLowerCase();
  if (path.split("/").slice(0, -1).some((segment) => policy.excludedDirectories.includes(segment))) return "excluded-directory";
  if (policy.excludedSuffixes.some((suffix) => path.endsWith(suffix))) return "excluded-suffix";
  if (!policy.extensions.includes(extname(path))) return "unsupported-extension";
  return null;
}

export function checkBudget(entries) {
  assert.ok(entries.length <= policy.maxFiles, "Source pool exceeds file count limit");
  let total = 0;
  for (const entry of entries) {
    assert.ok(Number.isSafeInteger(entry.bytes) && entry.bytes >= 0, "Invalid blob size");
    assert.ok(entry.bytes <= policy.maxFileBytes, "Source pool exceeds per-file byte limit");
    total += entry.bytes;
  }
  assert.ok(total <= policy.maxTotalBytes, "Source pool exceeds total byte limit");
  return total;
}

export function parseTree(text) {
  return text.split("\0").filter(Boolean).map((record) => {
    const match = /^(\d{6}) (blob|commit) ([a-f0-9]{40}) +([0-9]+|-)\t([\s\S]+)$/.exec(record);
    assert.ok(match, "Unexpected git ls-tree record");
    return { mode: match[1], type: match[2], sha: match[3], bytes: match[4] === "-" ? null : Number(match[4]), path: match[5] };
  });
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function runExperiment(repository, baselinePath, outputDirectory) {
  const baselineBytes = readFileSync(baselinePath);
  const baseline = JSON.parse(baselineBytes.toString("utf8").replace(/^\uFEFF/, ""));
  const commit = baseline.evidence?.commitSha;
  const description = baseline.input?.issueDescription;
  assert.equal(baseline.status, 200);
  assert.equal(typeof commit, "string");
  assert.match(commit, /^[a-f0-9]{40}$/i);
  assert.equal(typeof description, "string");
  assert.ok(description.trim().length > 0 && description.trim().length <= 4000);
  assert.equal(baseline.input.ref, commit, "This experiment requires a pinned baseline input");
  assert.equal(baseline.evidence.ref, commit);
  const repo = resolve(repository);
  // Arguments are passed directly, without a shell. Only pinned Git objects are read.
  const git = (...args) => execFileSync("git", ["-c", `safe.directory=${repo.replaceAll("\\", "/")}`, "-C", repo, ...args], {
    maxBuffer: 4_000_000, timeout: 10_000, windowsHide: true,
  });
  const started = performance.now();
  assert.equal(git("rev-parse", "--verify", `${commit}^{commit}`).toString().trim(), commit);
  const entries = parseTree(git("ls-tree", "-r", "-z", "-l", commit).toString("utf8"));
  const regular = entries.filter((entry) => entry.type === "blob" && ["100644", "100755"].includes(entry.mode));
  assert.equal(regular.length, baseline.evidence.candidateCount);
  const selected = entries.filter((entry) => exclusionReason(entry) === null);
  const totalBytes = checkBudget(selected); // All sizes checked before loading source.
  const preflightMs = performance.now() - started;
  const loadStart = performance.now();
  const files = selected.map((entry) => {
    const bytes = git("cat-file", "blob", entry.sha);
    assert.equal(bytes.length, entry.bytes);
    return { path: entry.path, content: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  });
  const loadingMs = performance.now() - loadStart;
  const project = ({ path, score, matchedTerms }) => ({ path, score, matchedTerms });
  const baselineTopThree = baseline.evidence.files.map(project);
  assert.deepStrictEqual(rankFilePaths(description, regular.map((entry) => entry.path)).slice(0, 3), baselineTopThree);
  const pathStart = performance.now();
  const samePoolPathTopThree = rankFilePaths(description, files.map((file) => file.path)).slice(0, 3);
  const pathScoringMs = performance.now() - pathStart;
  const contentStart = performance.now();
  const contentRanks = rankFileContents(description, files);
  const contentScoringMs = performance.now() - contentStart;
  const artifact = {
    recordedAtUtc: new Date().toISOString(),
    classification: "single development case; not a reproduced defect or general accuracy benchmark",
    input: { owner: baseline.evidence.owner, repo: baseline.evidence.repo, commitSha: commit, issueDescription: description },
    baselineSha256: sha256(baselineBytes),
    implementationSha256: Object.fromEntries(["../src/retrieval.ts", "../src/contentRetrieval.ts", "./content-retrieval.mjs"].map((path) => [path, sha256(readFileSync(new URL(path, import.meta.url)))])),
    policy,
    counts: { treeEntries: entries.length, regularFiles: regular.length, included: selected.length, excluded: entries.length - selected.length, positiveContentMatches: contentRanks.length, totalBytes },
    sourceManifest: selected,
    excluded: entries.filter((entry) => exclusionReason(entry) !== null).map((entry) => ({ path: entry.path, reason: exclusionReason(entry) })),
    scoring: "Distinct normalized description terms found as case-insensitive substrings in path OR content; score descending then original path ascending; no weighting or stemming",
    baselineTopThree, samePoolPathTopThree, contentTopThree: contentRanks.slice(0, 3), contentRanks,
    localTimingMs: { preflightMs, loadingMs, pathScoringMs, contentScoringMs },
    limitations: ["Local Git timing does not measure GitHub latency or request cost", "Source language/pool filters limit coverage", "Source tests and comments participate in scoring", "Lexical scores are not causal evidence or confidence"],
  };
  mkdirSync(outputDirectory, { recursive: true });
  const outputPath = resolve(outputDirectory, `content-retrieval-${randomUUID()}.json`);
  writeFileSync(outputPath, JSON.stringify(artifact, null, 2) + "\n", { flag: "wx" });
  return { outputPath, counts: artifact.counts, baselineTopThree, samePoolPathTopThree, contentTopThree: artifact.contentTopThree, localTimingMs: artifact.localTimingMs };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 5, "Usage: node --import tsx eval/content-retrieval.mjs <local-repo> <baseline.json> <output-directory>");
  console.log(JSON.stringify(runExperiment(...process.argv.slice(2)), null, 2));
}
