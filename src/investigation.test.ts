import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { setImmediate } from "node:timers/promises";
import { collectRepositoryEvidence } from "./investigation.js";
import { customError } from "./github.js";

const owner = "example-owner";
const repo = "demo";
const base = "https://api.github.com/repos/example-owner/demo";
const commitSha = "1".repeat(40);
const treeSha = "2".repeat(40);

function resolution(commit = commitSha, rootTree = treeSha) {
  return Response.json({ sha: commit, commit: { tree: { sha: rootTree } } });
}

function tree(paths: string[]) {
  return Response.json({
    truncated: false,
    tree: paths.map((path) => ({ path, type: "blob", mode: "100644" })),
  });
}

function file(path: string, content = "export const login = true;") {
  return Response.json({
    name: path.split("/").at(-1),
    path,
    sha: `blob:${path}`,
    type: "file",
    encoding: "base64",
    size: Buffer.byteLength(content),
    content: Buffer.from(content).toString("base64"),
    extra: "must not leak into evidence",
  });
}

function matchesError(status: number, message: string) {
  return (error: unknown) =>
    error instanceof customError && error.status === status && error.message === message;
}

test("collector returns the exact documented evidence bundle", async (t) => {
  const urls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    urls.push(String(input));
    if (urls.length === 1) return resolution();
    return urls.length === 2
      ? tree(["src/login.ts", "README.md"])
      : file("src/login.ts");
  });
  const result = await collectRepositoryEvidence(owner, repo, "  login token\n", "main");
  assert.deepEqual(result, {
    owner, repo, ref: "main", commitSha, candidateCount: 2,
    files: [{ name: "login.ts", path: "src/login.ts", sha: "blob:src/login.ts",
      content: "export const login = true;", score: 1, matchedTerms: ["login"] }],
  });
  assert.deepEqual(urls, [
    `${base}/commits/main?per_page=1`,
    `${base}/git/trees/${treeSha}?recursive=1`,
    `${base}/contents/src/login.ts?ref=${commitSha}`,
  ]);
});

test("collector counts eligible unique paths before ranking and reads only the top three", async (t) => {
  const urls: string[] = [];
  const content = "token café\n";
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    if (urls.length === 1) return resolution();
    if (urls.length === 2) {
      return Response.json({ truncated: false, tree: [
        ...["src/z-token.ts", "src/c-login-token.ts", "src/b-login-token.ts",
          "src/a-login-token.ts", "src/d-login.ts", "README.md", "src/a-login-token.ts"]
          .map((path) => ({ path, type: "blob", mode: "100644" })),
        { path: "src", type: "tree", mode: "040000" },
        { path: "login-link", type: "blob", mode: "120000" },
      ] });
    }
    const path = new URL(url).pathname.split("/contents/")[1];
    assert.ok(path);
    return file(path, content);
  });
  const result = await collectRepositoryEvidence(owner, repo, "token login token", "main");
  assert.equal(result.candidateCount, 6);
  assert.deepEqual(result.files, ["a", "b", "c"].map((letter) => ({
    name: `${letter}-login-token.ts`, path: `src/${letter}-login-token.ts`,
    sha: `blob:src/${letter}-login-token.ts`, content,
    score: 2, matchedTerms: ["token", "login"],
  })));
  assert.deepEqual(urls, [
    `${base}/commits/main?per_page=1`,
    `${base}/git/trees/${treeSha}?recursive=1`,
    `${base}/contents/src/a-login-token.ts?ref=${commitSha}`,
    `${base}/contents/src/b-login-token.ts?ref=${commitSha}`,
    `${base}/contents/src/c-login-token.ts?ref=${commitSha}`,
  ]);
});

test("collector waits for a file body to finish before starting the next read", async (t) => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const urls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    urls.push(String(input));
    if (urls.length === 1) return resolution();
    if (urls.length === 2) return tree(["login-a.ts", "login-b.ts", "login-c.ts"]);
    if (urls.length === 3) {
      const response = file("login-a.ts");
      const readJson = response.json.bind(response);
      t.mock.method(response, "json", async () => {
        started.resolve();
        await release.promise;
        return readJson();
      });
      return response;
    }
    return file(urls.length === 4 ? "login-b.ts" : "login-c.ts");
  });
  const pending = collectRepositoryEvidence(owner, repo, "login", "main");
  try {
    await started.promise;
    await setImmediate();
    assert.equal(urls.length, 3, "later reads must wait for the first decoded file");
  } finally {
    release.resolve();
    await pending;
  }
  assert.deepEqual((await pending).files.map((entry) => entry.path),
    ["login-a.ts", "login-b.ts", "login-c.ts"]);
  assert.equal(urls.length, 5);
});

test("collector resolves original refs once and uses distinct tree and commit IDs downstream", async (t) => {
  for (const ref of [" feature/café%2F&draft#1 ", "v1.2", "a".repeat(40)]) {
    const urls: string[] = [];
    const fetchMock = t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
      urls.push(String(input));
      if (urls.length === 1) return resolution();
      return urls.length === 2 ? tree(["login-a.ts", "login-b.ts"]) : file("login.ts");
    });
    const result = await collectRepositoryEvidence(owner, repo, "login", ref);
    assert.equal(result.ref, ref);
    assert.equal(result.commitSha, commitSha);
    assert.deepEqual(urls, [
      `${base}/commits/${encodeURIComponent(ref)}?per_page=1`,
      `${base}/git/trees/${treeSha}?recursive=1`,
      `${base}/contents/login-a.ts?ref=${commitSha}`,
      `${base}/contents/login-b.ts?ref=${commitSha}`,
    ]);
    fetchMock.mock.restore();
  }
});

for (const scenario of [
  { name: "empty discovery", paths: [], description: "login" },
  { name: "no matching paths", paths: ["README.md"], description: "login" },
  { name: "no usable terms", paths: ["login.ts"], description: "the and x" },
]) {
  test(`collector returns empty evidence for ${scenario.name} without file reads`, async (t) => {
    const fetchMock = t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0]) =>
      String(input).includes("/commits/") ? resolution() : tree(scenario.paths));
    assert.deepEqual(await collectRepositoryEvidence(owner, repo, scenario.description, "main"), {
      owner, repo, ref: "main", commitSha, candidateCount: scenario.paths.length, files: [],
    });
    assert.equal(fetchMock.mock.callCount(), 2);
  });
}

test("collector rejects invalid descriptions before any network request", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => tree([]));
  for (const description of [undefined, null, 42, {}, [], "", " \t\n", "x".repeat(4001), "😀".repeat(2001)]) {
    // Deliberately bypass static typing to verify the runtime boundary.
    await assert.rejects(collectRepositoryEvidence(owner, repo, description as string, "main"),
      matchesError(400, "INVALID_INVESTIGATION_INPUT"));
  }
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("collector accepts trimmed description boundaries without padding affecting length", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0]) =>
    String(input).includes("/commits/") ? resolution() : tree([]));
  for (const description of [" x ", ` ${"x".repeat(4000)}\n`, "😀".repeat(2000)]) {
    assert.deepEqual((await collectRepositoryEvidence(owner, repo, description, "main")).files, []);
  }
  assert.equal(fetchMock.mock.callCount(), 6);
});

test("collector rejects invalid refs and validates description first", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => tree([]));
  for (const ref of [undefined, null, 42, {}, [], "", " \t\n"]) {
    await assert.rejects(collectRepositoryEvidence(owner, repo, "login", ref as string),
      matchesError(400, "INVALID_REPOSITORY_REF"));
  }
  await assert.rejects(collectRepositoryEvidence(owner, repo, "", ""),
    matchesError(400, "INVALID_INVESTIGATION_INPUT"));
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("collector preserves discovery errors without retries or file reads", async (t) => {
  const sentinel = new customError("SYNTHETIC_DISCOVERY_FAILURE", 502);
  const fetchMock = t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0]) => {
    if (String(input).includes("/commits/")) return resolution();
    throw sentinel;
  });
  await assert.rejects(collectRepositoryEvidence(owner, repo, "login", "main"),
    (error: unknown) => error === sentinel);
  assert.equal(fetchMock.mock.callCount(), 2);
});

for (const failedRead of [1, 2]) {
  test(`collector stops at file read ${failedRead} and preserves the error object`, async (t) => {
    const sentinel = new customError("FILE_NOT_FOUND", 404);
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => {
      calls++;
      if (calls === 1) return resolution();
      if (calls === 2) return tree(["login-a.ts", "login-b.ts", "login-c.ts"]);
      if (calls === failedRead + 2) throw sentinel;
      return file("login-a.ts");
    });
    await assert.rejects(collectRepositoryEvidence(owner, repo, "login", "main"),
      (error: unknown) => error === sentinel);
    await setImmediate();
    assert.equal(calls, failedRead + 2);
  });
}

test("collector propagates tree truncation and never begins file reading", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0]) =>
    String(input).includes("/commits/") ? resolution() : Response.json({ truncated: true, tree: [] }));
  await assert.rejects(collectRepositoryEvidence(owner, repo, "login", "main"),
    matchesError(502, "REPOSITORY_TREE_TRUNCATED"));
  assert.equal(fetchMock.mock.callCount(), 2);
});

test("collector rejects malformed file data then recovers on a fresh invocation", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    if (calls === 1 || calls === 4) return resolution();
    if (calls === 2 || calls === 5) return tree(["login-a.ts", "login-b.ts"]);
    if (calls === 3) return Response.json({});
    return file(calls === 6 ? "login-a.ts" : "login-b.ts", "");
  });
  await assert.rejects(collectRepositoryEvidence(owner, repo, "login", "main"),
    matchesError(502, "GITHUB_REQUEST_FAILED"));
  assert.equal(calls, 3);
  const result = await collectRepositoryEvidence(owner, repo, "login", "main");
  assert.deepEqual(result.files.map((entry) => [entry.path, entry.content]),
    [["login-a.ts", ""], ["login-b.ts", ""]]);
  assert.equal(calls, 7);
});

test("collector can collect three files at the existing decoded byte limit", async (t) => {
  const content = "é".repeat(50_000);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    if (calls === 1) return resolution();
    return calls === 2 ? tree(["login-a.ts", "login-b.ts", "login-c.ts"])
      : file(`login-${calls}.ts`, content);
  });
  const result = await collectRepositoryEvidence(owner, repo, "login", "main");
  assert.equal(result.files.length, 3);
  assert.equal(result.files.reduce((sum, entry) => sum + Buffer.byteLength(entry.content), 0), 300_000);
  assert.equal(calls, 5);
});

test("collector rejects an oversized file without requesting subsequent files", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    if (calls === 1) return resolution();
    return calls === 2 ? tree(["login-a.ts", "login-b.ts"])
      : file("login-a.ts", "x".repeat(100_001));
  });
  await assert.rejects(collectRepositoryEvidence(owner, repo, "login", "main"),
    matchesError(502, "GITHUB_REQUEST_FAILED"));
  assert.equal(calls, 3);
});

test("collector preserves resolution errors and starts no discovery or file read", async (t) => {
  const sentinel = new customError("SYNTHETIC_RESOLUTION_FAILURE", 502);
  const fetchMock = t.mock.method(globalThis, "fetch", async () => { throw sentinel; });
  await assert.rejects(collectRepositoryEvidence(owner, repo, "login", "main"),
    (error: unknown) => error === sentinel);
  assert.equal(fetchMock.mock.callCount(), 1);
  assert.equal(fetchMock.mock.calls[0]?.arguments[0], `${base}/commits/main?per_page=1`);
});

test("collector stops on malformed or missing resolution and resolves again on recovery", async (t) => {
  for (const scenario of [
    { response: () => Response.json({ sha: commitSha }), status: 502, message: "GITHUB_REQUEST_FAILED" },
    { response: () => new Response(null, { status: 404 }), status: 404, message: "REPOSITORY_OR_REF_NOT_FOUND" },
  ]) {
    let fail = true;
    const urls: string[] = [];
    const fetchMock = t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("/commits/")) return fail ? scenario.response() : resolution();
      return tree([]);
    });
    await assert.rejects(collectRepositoryEvidence(owner, repo, "login", "main"),
      matchesError(scenario.status, scenario.message));
    assert.deepEqual(urls, [`${base}/commits/main?per_page=1`]);
    fail = false;
    assert.deepEqual(await collectRepositoryEvidence(owner, repo, "login", "main"), {
      owner, repo, ref: "main", commitSha, candidateCount: 0, files: [],
    });
    assert.deepEqual(urls, [`${base}/commits/main?per_page=1`, `${base}/commits/main?per_page=1`,
      `${base}/git/trees/${treeSha}?recursive=1`]);
    fetchMock.mock.restore();
  }
});

test("collector stays on the resolved revision after a branch moves and resolves afresh next invocation", async (t) => {
  const nextCommit = "a".repeat(40);
  const nextTree = "b".repeat(40);
  let currentCommit = commitSha;
  let currentTree = treeSha;
  const urls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    urls.push(url);
    if (url === `${base}/commits/main?per_page=1`) {
      const response = resolution(currentCommit, currentTree);
      // Simulate a branch advancing immediately after resolution.
      currentCommit = nextCommit;
      currentTree = nextTree;
      return response;
    }
    if (url === `${base}/git/trees/${treeSha}?recursive=1`) return tree(["login-a.ts", "login-b.ts"]);
    if (url === `${base}/git/trees/${nextTree}?recursive=1`) return tree([]);
    if (url === `${base}/contents/login-a.ts?ref=${commitSha}`) return file("login-a.ts", "old revision A");
    if (url === `${base}/contents/login-b.ts?ref=${commitSha}`) return file("login-b.ts", "old revision B");
    throw new Error(`Unexpected request: ${url}`);
  });
  const first = await collectRepositoryEvidence(owner, repo, "login", "main");
  assert.equal(first.ref, "main");
  assert.equal(first.commitSha, commitSha);
  assert.deepEqual(first.files.map((entry) => entry.content), ["old revision A", "old revision B"]);
  assert.deepEqual(urls, [`${base}/commits/main?per_page=1`, `${base}/git/trees/${treeSha}?recursive=1`,
    `${base}/contents/login-a.ts?ref=${commitSha}`, `${base}/contents/login-b.ts?ref=${commitSha}`]);
  const second = await collectRepositoryEvidence(owner, repo, "login", "main");
  assert.deepEqual(second, { owner, repo, ref: "main", commitSha: nextCommit, candidateCount: 0, files: [] });
  assert.deepEqual(urls.slice(4), [`${base}/commits/main?per_page=1`, `${base}/git/trees/${nextTree}?recursive=1`]);
});

test("collector waits for resolution JSON before requesting its tree", async (t) => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const urls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0]) => {
    urls.push(String(input));
    if (urls.length === 1) {
      const response = resolution();
      const readJson = response.json.bind(response);
      t.mock.method(response, "json", async () => {
        started.resolve();
        await release.promise;
        return readJson();
      });
      return response;
    }
    return tree([]);
  });
  const pending = collectRepositoryEvidence(owner, repo, "login", "main");
  try {
    await started.promise;
    await setImmediate();
    assert.deepEqual(urls, [`${base}/commits/main?per_page=1`]);
  } finally {
    release.resolve();
    await pending;
  }
  assert.equal((await pending).commitSha, commitSha);
  assert.deepEqual(urls, [`${base}/commits/main?per_page=1`, `${base}/git/trees/${treeSha}?recursive=1`]);
});
