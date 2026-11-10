import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { setImmediate } from "node:timers/promises";
import { collectRepositoryEvidence } from "./investigation.js";
import { customError } from "./github.js";

const owner = "example-owner";
const repo = "demo";
const base = "https://api.github.com/repos/example-owner/demo";

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
    return urls.length === 1
      ? tree(["src/login.ts", "README.md"])
      : file("src/login.ts");
  });
  const result = await collectRepositoryEvidence(owner, repo, "  login token\n", "main");
  assert.deepEqual(result, {
    owner, repo, ref: "main", candidateCount: 2,
    files: [{ name: "login.ts", path: "src/login.ts", sha: "blob:src/login.ts",
      content: "export const login = true;", score: 1, matchedTerms: ["login"] }],
  });
  assert.deepEqual(urls, [
    `${base}/git/trees/main?recursive=1`,
    `${base}/contents/src/login.ts?ref=main`,
  ]);
});

test("collector counts eligible unique paths before ranking and reads only the top three", async (t) => {
  const urls: string[] = [];
  const content = "token café\n";
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    if (urls.length === 1) {
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
    `${base}/git/trees/main?recursive=1`,
    `${base}/contents/src/a-login-token.ts?ref=main`,
    `${base}/contents/src/b-login-token.ts?ref=main`,
    `${base}/contents/src/c-login-token.ts?ref=main`,
  ]);
});

test("collector waits for a file body to finish before starting the next read", async (t) => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const urls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    urls.push(String(input));
    if (urls.length === 1) return tree(["login-a.ts", "login-b.ts", "login-c.ts"]);
    if (urls.length === 2) {
      const response = file("login-a.ts");
      const readJson = response.json.bind(response);
      t.mock.method(response, "json", async () => {
        started.resolve();
        await release.promise;
        return readJson();
      });
      return response;
    }
    return file(urls.length === 3 ? "login-b.ts" : "login-c.ts");
  });
  const pending = collectRepositoryEvidence(owner, repo, "login", "main");
  try {
    await started.promise;
    await setImmediate();
    assert.equal(urls.length, 2, "later reads must wait for the first decoded file");
  } finally {
    release.resolve();
    await pending;
  }
  assert.deepEqual((await pending).files.map((entry) => entry.path),
    ["login-a.ts", "login-b.ts", "login-c.ts"]);
  assert.equal(urls.length, 4);
});

test("collector preserves original refs on discovery, every read, and output", async (t) => {
  for (const ref of [" feature/café%2F&draft#1 ", "v1.2", "a".repeat(40)]) {
    const urls: string[] = [];
    const fetchMock = t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
      urls.push(String(input));
      return urls.length === 1 ? tree(["login-a.ts", "login-b.ts"]) : file("login.ts");
    });
    const result = await collectRepositoryEvidence(owner, repo, "login", ref);
    assert.equal(result.ref, ref);
    assert.deepEqual(urls, [
      `${base}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
      `${base}/contents/login-a.ts?ref=${encodeURIComponent(ref)}`,
      `${base}/contents/login-b.ts?ref=${encodeURIComponent(ref)}`,
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
    const fetchMock = t.mock.method(globalThis, "fetch", async () => tree(scenario.paths));
    assert.deepEqual(await collectRepositoryEvidence(owner, repo, scenario.description, "main"), {
      owner, repo, ref: "main", candidateCount: scenario.paths.length, files: [],
    });
    assert.equal(fetchMock.mock.callCount(), 1);
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
  const fetchMock = t.mock.method(globalThis, "fetch", async () => tree([]));
  for (const description of [" x ", ` ${"x".repeat(4000)}\n`, "😀".repeat(2000)]) {
    assert.deepEqual((await collectRepositoryEvidence(owner, repo, description, "main")).files, []);
  }
  assert.equal(fetchMock.mock.callCount(), 3);
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
  const fetchMock = t.mock.method(globalThis, "fetch", async () => { throw sentinel; });
  await assert.rejects(collectRepositoryEvidence(owner, repo, "login", "main"),
    (error: unknown) => error === sentinel);
  assert.equal(fetchMock.mock.callCount(), 1);
});

for (const failedRead of [1, 2]) {
  test(`collector stops at file read ${failedRead} and preserves the error object`, async (t) => {
    const sentinel = new customError("FILE_NOT_FOUND", 404);
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => {
      calls++;
      if (calls === 1) return tree(["login-a.ts", "login-b.ts", "login-c.ts"]);
      if (calls === failedRead + 1) throw sentinel;
      return file("login-a.ts");
    });
    await assert.rejects(collectRepositoryEvidence(owner, repo, "login", "main"),
      (error: unknown) => error === sentinel);
    await setImmediate();
    assert.equal(calls, failedRead + 1);
  });
}

test("collector propagates tree truncation and never begins file reading", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () =>
    Response.json({ truncated: true, tree: [] }));
  await assert.rejects(collectRepositoryEvidence(owner, repo, "login", "main"),
    matchesError(502, "REPOSITORY_TREE_TRUNCATED"));
  assert.equal(fetchMock.mock.callCount(), 1);
});

test("collector rejects malformed file data then recovers on a fresh invocation", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    if (calls === 1 || calls === 3) return tree(["login-a.ts", "login-b.ts"]);
    if (calls === 2) return Response.json({});
    return file(calls === 4 ? "login-a.ts" : "login-b.ts", "");
  });
  await assert.rejects(collectRepositoryEvidence(owner, repo, "login", "main"),
    matchesError(502, "GITHUB_REQUEST_FAILED"));
  assert.equal(calls, 2);
  const result = await collectRepositoryEvidence(owner, repo, "login", "main");
  assert.deepEqual(result.files.map((entry) => [entry.path, entry.content]),
    [["login-a.ts", ""], ["login-b.ts", ""]]);
  assert.equal(calls, 5);
});

test("collector can collect three files at the existing decoded byte limit", async (t) => {
  const content = "é".repeat(50_000);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return calls === 1 ? tree(["login-a.ts", "login-b.ts", "login-c.ts"])
      : file(`login-${calls}.ts`, content);
  });
  const result = await collectRepositoryEvidence(owner, repo, "login", "main");
  assert.equal(result.files.length, 3);
  assert.equal(result.files.reduce((sum, entry) => sum + Buffer.byteLength(entry.content), 0), 300_000);
  assert.equal(calls, 4);
});

test("collector rejects an oversized file without requesting subsequent files", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return calls === 1 ? tree(["login-a.ts", "login-b.ts"])
      : file("login-a.ts", "x".repeat(100_001));
  });
  await assert.rejects(collectRepositoryEvidence(owner, repo, "login", "main"),
    matchesError(502, "GITHUB_REQUEST_FAILED"));
  assert.equal(calls, 2);
});
