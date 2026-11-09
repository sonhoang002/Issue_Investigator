import test from "node:test";
import assert from "node:assert/strict";
import { customError, getRepositorySummary, listRepositoryRoot, readRepositoryFile, listRepositoryFilePaths } from "./github.js";

test("returns a valid repository summary", async (t) => {
  const metadata = {
    name: "demo-repo",
    full_name: "example-owner/demo-repo",
    description: null,
    default_branch: "main",
    html_url: "https://github.com/example-owner/demo-repo",
  };

  const fetchMock = t.mock.method(
    globalThis,
    "fetch",
    async () => new Response(JSON.stringify(metadata), { status: 200 }),
  );

  const result = await getRepositorySummary("example-owner", "demo-repo");

  assert.deepStrictEqual(result, {
    name: "demo-repo",
    fullName: "example-owner/demo-repo",
    description: null,
    defaultBranch: "main",
    htmlUrl: "https://github.com/example-owner/demo-repo",
  });

  assert.equal(fetchMock.mock.callCount(), 1);
});

test("rejects missing repositories with the not-found error", async (t) => {
  const fetchMock = t.mock.method(
    globalThis,
    "fetch",
    async () => new Response(null, { status: 404 }),
  );

  await assert.rejects(
    getRepositorySummary("example-owner", "missing-repo"),
    (error: unknown) =>
      error instanceof customError &&
      error.status === 404 &&
      error.message === "REPOSITORY_NOT_FOUND",
  );

  assert.strictEqual(fetchMock.mock.callCount(), 1);
});

const validMetadata = {
  name: "demo-repo",
  full_name: "example-owner/demo-repo",
  description: "Synthetic repository for tests",
  default_branch: "main",
  html_url: "https://github.com/example-owner/demo-repo",
};

const fileFixture = {
  type: "file",
  encoding: "base64",
  name: "intro.md",
  path: "docs/intro.md",
  sha: "synthetic-blob-sha",
  size: 14,
  content: "SGVsbG8sIHdvcmxkIQo=",
};

function matchesClientError(status: number, message: string) {
  return (error: unknown) =>
    error instanceof customError && error.status === status && error.message === message;
}

// Minimal synthetic tree fixtures; only consumed fields are required.
const treeFile = { path: "src/auth/login.ts", type: "blob", mode: "100644" };

test("tree client returns the documented file paths with one request", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => Response.json({
    truncated: false,
    url: "https://example.invalid/do-not-follow",
    tree: [
      { path: "README.md", type: "blob", mode: "100644", size: 42 },
      { path: "src", type: "tree", mode: "040000" },
      treeFile,
      { path: "scripts/check.sh", type: "blob", mode: "100755" },
      { path: "current", type: "blob", mode: "120000" },
      { path: "vendor/library", type: "commit", mode: "160000" },
      { path: "README.md", type: "blob", mode: "100644" },
    ],
  }));
  assert.deepEqual(await listRepositoryFilePaths("example-owner", "demo-repo", "main"),
    ["README.md", "src/auth/login.ts", "scripts/check.sh"]);
  assert.equal(fetchMock.mock.callCount(), 1);
});

test("tree client accepts empty trees and trees containing only skipped entry kinds", async (t) => {
  let tree: unknown[] = [];
  t.mock.method(globalThis, "fetch", async () => Response.json({ truncated: false, tree }));
  assert.deepEqual(await listRepositoryFilePaths("owner", "repo", "main"), []);
  tree = [
    { path: "src", type: "tree", mode: "040000" },
    { path: "link", type: "blob", mode: "120000" },
    { path: "vendor/library", type: "commit", mode: "160000" },
  ];
  assert.deepEqual(await listRepositoryFilePaths("owner", "repo", "main"), []);
});

test("tree client preserves path spelling, order, and exact identity without a five-file cutoff", async (t) => {
  const expected = ["z.ts", "Src/Login.ts", "src/login.ts", "docs/hello world.md", "src/登录.ts", "literal%2Fname", "archive.bin", ".config"];
  const tree = [...expected, expected[0]!, expected[1]!].map((path) => ({ ...treeFile, path }));
  t.mock.method(globalThis, "fetch", async () => Response.json({ truncated: false, tree }));
  assert.deepEqual(await listRepositoryFilePaths("owner", "repo", "main"), expected);
});

test("tree client encodes separate URL components and supplies headers and fresh signals", async (t) => {
  const requests: Array<{ url: string; options: RequestInit | undefined }> = [];
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0], options?: RequestInit) => {
    requests.push({ url: String(input), options });
    return Response.json({ truncated: false, tree: [] });
  });
  // Bypass the future route boundary to inspect component escaping only.
  await listRepositoryFilePaths("owner/space", "repo?#", "feature/login");
  await listRepositoryFilePaths("owner", "repo", " main ");
  assert.equal(requests.length, 2);
  assert.equal(requests[0]!.url, "https://api.github.com/repos/owner%2Fspace/repo%3F%23/git/trees/feature%2Flogin?recursive=1");
  assert.equal(requests[1]!.url, "https://api.github.com/repos/owner/repo/git/trees/%20main%20?recursive=1");
  for (const { options } of requests) {
    const headers = new Headers(options?.headers);
    assert.equal(headers.get("Accept"), "application/vnd.github+json");
    assert.equal(headers.get("User-Agent"), "issue-investigator");
    assert.ok(options?.signal instanceof AbortSignal);
    assert.equal(options.signal.aborted, false);
    assert.ok(options.method === undefined || options.method === "GET");
  }
  assert.notEqual(requests[0]!.options?.signal, requests[1]!.options?.signal);
});

test("tree client rejects non-string or blank refs before fetching", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => Response.json({ truncated: false, tree: [] }));
  for (const ref of [undefined, null, 1, false, [], {}, "", " \t\r\n"]) {
    await assert.rejects(listRepositoryFilePaths("owner", "repo", ref as string),
      matchesClientError(400, "INVALID_REPOSITORY_REF"));
  }
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("tree client rejects malformed envelopes instead of assuming response types", async (t) => {
  let body: unknown;
  t.mock.method(globalThis, "fetch", async () => Response.json(body));
  for (body of [null, [], "tree", 42, {}, { tree: [] }, { truncated: false },
    { truncated: "false", tree: [] }, { truncated: 0, tree: [] },
    { truncated: false, tree: null }, { truncated: false, tree: {} }]) {
    await assert.rejects(listRepositoryFilePaths("owner", "repo", "main"),
      matchesClientError(502, "GITHUB_REQUEST_FAILED"), JSON.stringify(body));
  }
});

test("tree client rejects a truncated tree even when returned entries look valid", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ truncated: true, tree: [treeFile] }));
  await assert.rejects(listRepositoryFilePaths("owner", "repo", "main"),
    matchesClientError(502, "REPOSITORY_TREE_TRUNCATED"));
});

test("tree client accepts exactly 10000 raw entries", async (t) => {
  const paths = Array.from({ length: 10_000 }, (_, i) => `src/file-${i}.ts`);
  const tree = paths.map((path) => ({ ...treeFile, path }));
  t.mock.method(globalThis, "fetch", async () => Response.json({ truncated: false, tree }));
  assert.deepEqual(await listRepositoryFilePaths("owner", "repo", "main"), paths);
});

test("tree client counts skipped and duplicate entries toward its raw limit", async (t) => {
  const tree = Array.from({ length: 10_001 }, () => ({ path: "src", type: "tree", mode: "040000" }));
  t.mock.method(globalThis, "fetch", async () => Response.json({ truncated: false, tree }));
  await assert.rejects(listRepositoryFilePaths("owner", "repo", "main"),
    matchesClientError(502, "REPOSITORY_TREE_TOO_LARGE"));
});

test("tree client checks truncation before the local entry limit", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ truncated: true, tree: Array(10_001).fill(treeFile) }));
  await assert.rejects(listRepositoryFilePaths("owner", "repo", "main"),
    matchesClientError(502, "REPOSITORY_TREE_TRUNCATED"));
});

test("tree client rejects malformed entry fields anywhere in the response", async (t) => {
  let invalid: unknown;
  t.mock.method(globalThis, "fetch", async () => Response.json({ truncated: false, tree: [treeFile, invalid] }));
  for (invalid of [null, [], "file", {}, { type: "blob", mode: "100644" },
    { ...treeFile, path: "" }, { ...treeFile, path: 42 },
    { path: "x", mode: "100644" }, { path: "x", type: "blob" },
    { ...treeFile, type: 1 }, { ...treeFile, mode: 100644 }]) {
    await assert.rejects(listRepositoryFilePaths("owner", "repo", "main"),
      matchesClientError(502, "GITHUB_REQUEST_FAILED"), JSON.stringify(invalid));
  }
});

test("tree client rejects unknown modes and every inconsistent known type/mode pair", async (t) => {
  let entry = treeFile;
  t.mock.method(globalThis, "fetch", async () => Response.json({ truncated: false, tree: [treeFile, entry] }));
  const allowed = new Set(["blob:100644", "blob:100755", "blob:120000", "tree:040000", "commit:160000"]);
  for (const type of ["blob", "tree", "commit", "file", "unknown"]) {
    for (const mode of ["100644", "100755", "120000", "040000", "160000", "000000"]) {
      if (allowed.has(`${type}:${mode}`)) continue;
      entry = { path: "invalid", type, mode };
      await assert.rejects(listRepositoryFilePaths("owner", "repo", "main"),
        matchesClientError(502, "GITHUB_REQUEST_FAILED"), `${type}:${mode}`);
    }
  }
});

test("tree client validates paths for included files and skipped entry kinds alike", async (t) => {
  let entry = treeFile;
  t.mock.method(globalThis, "fetch", async () => Response.json({ truncated: false, tree: [treeFile, entry] }));
  for (const [type, mode] of [["blob", "100644"], ["blob", "100755"], ["blob", "120000"], ["tree", "040000"], ["commit", "160000"]] as const) {
    for (const path of ["", "/src/x", "src/", "src//x", ".", "..", "src/./x", "src/../x", "src\\x", "src/nu\0ll"]) {
      entry = { path, type, mode };
      await assert.rejects(listRepositoryFilePaths("owner", "repo", "main"),
        matchesClientError(502, "GITHUB_REQUEST_FAILED"), JSON.stringify(entry));
    }
  }
});

test("tree client maps upstream 404 to repository-or-ref not found", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 404 }));
  await assert.rejects(listRepositoryFilePaths("owner", "repo", "main"),
    matchesClientError(404, "REPOSITORY_OR_REF_NOT_FOUND"));
  assert.equal(fetchMock.mock.callCount(), 1);
});

test("tree client maps other unsuccessful statuses to the generic error without retries", async (t) => {
  let status = 503;
  const fetchMock = t.mock.method(globalThis, "fetch", async () => new Response(null, { status }));
  for (status of [403, 409, 422, 429, 503]) {
    await assert.rejects(listRepositoryFilePaths("owner", "repo", "main"), matchesClientError(502, "GITHUB_REQUEST_FAILED"));
  }
  assert.equal(fetchMock.mock.callCount(), 5);
});

test("tree client maps invalid JSON to the generic error", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("{not json", { status: 200 }));
  await assert.rejects(listRepositoryFilePaths("owner", "repo", "main"), matchesClientError(502, "GITHUB_REQUEST_FAILED"));
});

test("tree client maps network failures and recovers on a later independent call", async (t) => {
  let fail = true;
  const fetchMock = t.mock.method(globalThis, "fetch", async () => {
    if (fail) throw new TypeError("Synthetic network failure");
    return Response.json({ truncated: false, tree: [treeFile] });
  });
  await assert.rejects(listRepositoryFilePaths("owner", "repo", "main"), matchesClientError(502, "GITHUB_REQUEST_FAILED"));
  fail = false;
  assert.deepEqual(await listRepositoryFilePaths("owner", "repo", "main"), [treeFile.path]);
  assert.equal(fetchMock.mock.callCount(), 2);
});

test("tree client requests a ten-second deadline, maps cancellation, and recovers with a fresh signal", async (t) => {
  const originalTimeout = AbortSignal.timeout;
  const timeoutMock = t.mock.method(AbortSignal, "timeout", (delay: number) => {
    assert.equal(delay, 10_000);
    return originalTimeout(20);
  });
  const signals: AbortSignal[] = [];
  t.mock.method(globalThis, "fetch", async (_input: Parameters<typeof fetch>[0], options?: RequestInit) => {
    assert.ok(options?.signal instanceof AbortSignal);
    const signal = options.signal;
    signals.push(signal);
    if (signals.length > 1) return Response.json({ truncated: false, tree: [treeFile] });
    return new Promise<Response>((_resolve, reject) => {
      const watchdog = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        reject(new Error("Expected test signal to abort"));
      }, 1_000);
      const onAbort = () => { clearTimeout(watchdog); reject(signal.reason); };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
  });
  await assert.rejects(listRepositoryFilePaths("owner", "repo", "main"), matchesClientError(502, "GITHUB_REQUEST_FAILED"));
  assert.equal(signals[0]!.aborted, true);
  assert.equal(signals[0]!.reason.name, "TimeoutError");
  assert.deepEqual(await listRepositoryFilePaths("owner", "repo", "main"), [treeFile.path]);
  assert.notEqual(signals[0], signals[1]);
  assert.equal(signals[1]!.aborted, false);
  assert.equal(timeoutMock.mock.callCount(), 2);
});

test("file reader encodes optional ref values and preserves output, headers, and fresh signals", async (t) => {
  const requests: Array<{ url: string; options: RequestInit | undefined }> = [];
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0], options?: RequestInit) => {
    requests.push({ url: String(input), options });
    return Response.json({ ...fileFixture, extra: "excluded" });
  });
  const cases = [
    ["feature/login", "feature%2Flogin"],
    ["v1.2.3", "v1.2.3"],
    ["a".repeat(40), "a".repeat(40)],
    [" main ", "%20main%20"],
    ["literal%2Fname", "literal%252Fname"],
    ["feature&other=value#part?", "feature%26other%3Dvalue%23part%3F"],
    ["功能/登录", "%E5%8A%9F%E8%83%BD%2F%E7%99%BB%E5%BD%95"],
  ] as const;
  for (const [ref, encoded] of cases) {
    assert.deepEqual(await readRepositoryFile("example-owner", "demo-repo", "docs/intro.md", ref), {
      name: "intro.md", path: "docs/intro.md", sha: "synthetic-blob-sha", content: "Hello, world!\n",
    });
    const last = requests.at(-1)!;
    assert.equal(last.url, `https://api.github.com/repos/example-owner/demo-repo/contents/docs/intro.md?ref=${encoded}`);
    const headers = new Headers(last.options?.headers);
    assert.equal(headers.get("Accept"), "application/vnd.github+json");
    assert.equal(headers.get("User-Agent"), "issue-investigator");
    assert.ok(last.options?.signal instanceof AbortSignal);
    assert.equal(last.options.signal.aborted, false);
  }
  assert.equal(requests.length, cases.length);
  assert.equal(new Set(requests.map(({ options }) => options?.signal)).size, cases.length);
});

test("file reader treats omitted and explicit undefined refs identically", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => Response.json(fileFixture));
  const omitted = await readRepositoryFile("example-owner", "demo-repo", "docs/intro.md");
  const explicit = await readRepositoryFile("example-owner", "demo-repo", "docs/intro.md", undefined);
  assert.deepEqual(explicit, omitted);
  assert.equal(fetchMock.mock.callCount(), 2);
  for (const call of fetchMock.mock.calls) {
    assert.equal(call.arguments[0], "https://api.github.com/repos/example-owner/demo-repo/contents/docs/intro.md");
  }
});

test("file reader rejects supplied invalid refs before fetching and accepts a later valid ref", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => Response.json(fileFixture));
  for (const ref of [null, [], {}, 123, false, "", " \t\r\n"]) {
    await assert.rejects(readRepositoryFile("owner", "repo", "docs/intro.md", ref as string),
      matchesClientError(400, "INVALID_REPOSITORY_REF"));
  }
  assert.equal(fetchMock.mock.callCount(), 0);
  assert.equal((await readRepositoryFile("owner", "repo", "docs/intro.md", "feature/login")).content, "Hello, world!\n");
  assert.equal(fetchMock.mock.callCount(), 1);
});

test("file reader retains path rejection when a valid ref is supplied", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => Response.json(fileFixture));
  for (const path of ["", "../intro.md", "docs//intro.md", "docs\\intro.md", "docs/nu\0ll"]) {
    await assert.rejects(readRepositoryFile("owner", "repo", path, "feature/login"), matchesClientError(400, "INVALID_FILE_PATH"));
  }
  assert.equal(fetchMock.mock.callCount(), 0);
});

for (const { name, respond, status, message } of [
  { name: "404", respond: async () => new Response(null, { status: 404 }), status: 404, message: "FILE_NOT_FOUND" },
  { name: "503", respond: async () => new Response(null, { status: 503 }), status: 502, message: "GITHUB_REQUEST_FAILED" },
  { name: "invalid JSON", respond: async () => new Response("not JSON"), status: 502, message: "GITHUB_REQUEST_FAILED" },
  { name: "network failure", respond: async (): Promise<Response> => { throw new TypeError("Synthetic network failure"); }, status: 502, message: "GITHUB_REQUEST_FAILED" },
]) {
  test(`file reader with ref preserves ${name} error mapping without retrying`, async (t) => {
    const fetchMock = t.mock.method(globalThis, "fetch", respond);
    await assert.rejects(readRepositoryFile("owner", "repo", "docs/intro.md", "feature/login"), matchesClientError(status, message));
    assert.equal(fetchMock.mock.callCount(), 1);
  });
}

test("file reader with ref still validates file data, Base64, UTF-8, and decoded size", async (t) => {
  let body: unknown;
  t.mock.method(globalThis, "fetch", async () => Response.json(body));
  for (body of [
    {}, { ...fileFixture, content: "!!!!" },
    { ...fileFixture, content: Buffer.from([0xff]).toString("base64"), size: 1 },
    { ...fileFixture, size: fileFixture.size + 1 },
    { ...fileFixture, type: "dir" },
  ]) {
    await assert.rejects(readRepositoryFile("owner", "repo", "docs/intro.md", "main"), matchesClientError(502, "GITHUB_REQUEST_FAILED"));
  }
});

test("file reader with ref retains its requested deadline and recovers with a fresh signal", async (t) => {
  const originalTimeout = AbortSignal.timeout;
  t.mock.method(AbortSignal, "timeout", (delay: number) => {
    assert.equal(delay, 10_000);
    return originalTimeout(20);
  });
  const signals: AbortSignal[] = [];
  t.mock.method(globalThis, "fetch", async (_input: Parameters<typeof fetch>[0], options?: RequestInit) => {
    assert.ok(options?.signal instanceof AbortSignal);
    const signal = options.signal;
    signals.push(signal);
    if (signals.length > 1) return Response.json(fileFixture);
    return new Promise<Response>((_resolve, reject) => {
      const watchdog = setTimeout(() => { signal.removeEventListener("abort", onAbort); reject(new Error("Expected cancellation")); }, 1_000);
      const onAbort = () => { clearTimeout(watchdog); reject(signal.reason); };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
  });
  await assert.rejects(readRepositoryFile("owner", "repo", "docs/intro.md", "feature/login"), matchesClientError(502, "GITHUB_REQUEST_FAILED"));
  assert.equal(signals[0]!.aborted, true);
  assert.equal(signals[0]!.reason.name, "TimeoutError");
  assert.equal((await readRepositoryFile("owner", "repo", "docs/intro.md", "feature/login")).content, "Hello, world!\n");
  assert.notEqual(signals[0], signals[1]);
  assert.equal(signals[1]!.aborted, false);
});

test("file reader decodes source and returns exactly four public fields", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => Response.json({
    ...fileFixture,
    download_url: "https://example.invalid/must-not-be-followed",
    extra: "unrelated metadata",
  }));

  assert.deepEqual(await readRepositoryFile("example-owner", "demo-repo", "docs/intro.md"), {
    name: "intro.md",
    path: "docs/intro.md",
    sha: "synthetic-blob-sha",
    content: "Hello, world!\n",
  });
  assert.equal(fetchMock.mock.callCount(), 1);
});

test("file reader accepts Base64 formatting whitespace and preserves UTF-8 source whitespace", async (t) => {
  const text = "  Héllo 🌍\n\n";
  const encoded = Buffer.from(text, "utf8").toString("base64");
  t.mock.method(globalThis, "fetch", async () => Response.json({
    ...fileFixture,
    size: Buffer.byteLength(text, "utf8"),
    content: ` \t${encoded.replace(/(.{8})/g, "$1\r\n\t")}\n`,
  }));
  const result = await readRepositoryFile("example-owner", "demo-repo", "docs/intro.md");
  assert.equal(result.content, text);
});

test("file reader accepts empty files", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ ...fileFixture, size: 0, content: "" }));
  const result = await readRepositoryFile("example-owner", "demo-repo", "empty.txt");
  assert.equal(result.content, "");
});

test("file reader accepts the 100000-byte boundary", async (t) => {
  const text = "a".repeat(100_000);
  t.mock.method(globalThis, "fetch", async () => Response.json({
    ...fileFixture, size: 100_000, content: Buffer.from(text).toString("base64"),
  }));
  const result = await readRepositoryFile("example-owner", "demo-repo", "large.txt");
  assert.equal(result.content, text);
});

test("file reader uses the absolute GitHub URL with separately encoded path segments", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => Response.json(fileFixture));
  await readRepositoryFile("owner/name", "repo?name", "src/my file#1.ts");
  await readRepositoryFile("example-owner", "demo-repo", "docs/intro.md");
  const first = fetchMock.mock.calls[0];
  const second = fetchMock.mock.calls[1];
  assert.ok(first);
  assert.ok(second);
  assert.equal(first.arguments[0], "https://api.github.com/repos/owner%2Fname/repo%3Fname/contents/src/my%20file%231.ts");
  const options = first.arguments[1];
  const headers = new Headers(options?.headers);
  assert.equal(headers.get("accept"), "application/vnd.github+json");
  assert.equal(headers.get("user-agent"), "issue-investigator");
  assert.ok(options?.signal instanceof AbortSignal);
  assert.equal(options.signal.aborted, false);
  assert.notEqual(options.signal, second.arguments[1]?.signal);
  assert.equal(fetchMock.mock.callCount(), 2);
});

test("file reader rejects an empty path with 400 and no fetch", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => Response.json(fileFixture));
  await assert.rejects(readRepositoryFile("example-owner", "demo-repo", ""), matchesClientError(400, "INVALID_FILE_PATH"));
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("file reader rejects a non-string path with 400 and no fetch", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => Response.json(fileFixture));
  // Simulate an untyped runtime caller; this cast is test input, not validation.
  await assert.rejects(readRepositoryFile("example-owner", "demo-repo", 123 as unknown as string), matchesClientError(400, "INVALID_FILE_PATH"));
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("file reader rejects invalid segments before fetching", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => Response.json(fileFixture));
  for (const path of ["/src/app.ts", "src//app.ts", "src/", ".", "..", "../secret", "src/./app.ts", "src/../app.ts", "src\\app.ts", "src/\0app.ts"]) {
    await assert.rejects(readRepositoryFile("example-owner", "demo-repo", path), matchesClientError(400, "INVALID_FILE_PATH"));
    assert.equal(fetchMock.mock.callCount(), 0, path);
  }
});

test("file reader rejects malformed or unsupported upstream file objects", async (t) => {
  let payload: unknown;
  t.mock.method(globalThis, "fetch", async () => Response.json(payload));
  for (payload of [
    null, [], {},
    { ...fileFixture, type: "dir" },
    { ...fileFixture, encoding: "none" },
    { ...fileFixture, name: 123 },
    { ...fileFixture, path: null },
    { ...fileFixture, sha: false },
    { ...fileFixture, content: [] },
    { ...fileFixture, size: "14" },
    { ...fileFixture, size: -1 },
    { ...fileFixture, size: 1.5 },
    { ...fileFixture, size: 100_001 },
  ]) {
    await assert.rejects(readRepositoryFile("example-owner", "demo-repo", "docs/intro.md"), matchesClientError(502, "GITHUB_REQUEST_FAILED"));
  }
});

test("file reader rejects corrupted or noncanonical Base64", async (t) => {
  let content = "";
  t.mock.method(globalThis, "fetch", async () => Response.json({ ...fileFixture, content }));
  for (content of ["!!!!", "SGVsbG8", "SGVsbG8=garbage", "SGVsbG8==="]) {
    await assert.rejects(readRepositoryFile("example-owner", "demo-repo", "docs/intro.md"), matchesClientError(502, "GITHUB_REQUEST_FAILED"));
  }
});

test("file reader rejects non-UTF-8 bytes", async (t) => {
  const bytes = Buffer.from([0xc3, 0x28]);
  t.mock.method(globalThis, "fetch", async () => Response.json({ ...fileFixture, size: bytes.length, content: bytes.toString("base64") }));
  await assert.rejects(readRepositoryFile("example-owner", "demo-repo", "binary.bin"), matchesClientError(502, "GITHUB_REQUEST_FAILED"));
});

test("file reader rejects decoded bytes that differ from the declared size", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ ...fileFixture, size: 13 }));
  await assert.rejects(readRepositoryFile("example-owner", "demo-repo", "docs/intro.md"), matchesClientError(502, "GITHUB_REQUEST_FAILED"));
});

test("file reader rejects oversized decoded bytes even if the reported size is within the cap", async (t) => {
  const content = Buffer.from("a".repeat(100_001)).toString("base64");
  t.mock.method(globalThis, "fetch", async () => Response.json({ ...fileFixture, size: 100_000, content }));
  await assert.rejects(readRepositoryFile("example-owner", "demo-repo", "oversized.txt"), matchesClientError(502, "GITHUB_REQUEST_FAILED"));
});

for (const { name, respond, status, message } of [
  { name: "404", respond: async () => new Response(null, { status: 404 }), status: 404, message: "FILE_NOT_FOUND" },
  { name: "503", respond: async () => new Response(null, { status: 503 }), status: 502, message: "GITHUB_REQUEST_FAILED" },
  { name: "invalid JSON", respond: async () => new Response("{broken"), status: 502, message: "GITHUB_REQUEST_FAILED" },
  { name: "network failure", respond: async (): Promise<Response> => { throw new TypeError("Simulated network failure"); }, status: 502, message: "GITHUB_REQUEST_FAILED" },
]) {
  test(`file reader maps ${name} to the specified error`, async (t) => {
    const fetchMock = t.mock.method(globalThis, "fetch", respond);
    await assert.rejects(readRepositoryFile("example-owner", "demo-repo", "docs/intro.md"), matchesClientError(status, message));
    assert.equal(fetchMock.mock.callCount(), 1);
  });
}

test("file reader requests a ten-second deadline and maps signal cancellation", async (t) => {
  const originalTimeout = AbortSignal.timeout;
  t.mock.method(AbortSignal, "timeout", (delay: number) => {
    assert.equal(delay, 10_000);
    return originalTimeout(20);
  });
  let observed: AbortSignal | undefined;
  t.mock.method(globalThis, "fetch", async (_input: Parameters<typeof fetch>[0], options?: Parameters<typeof fetch>[1]) => {
    assert.ok(options?.signal instanceof AbortSignal);
    const signal = options.signal;
    observed = signal;
    return new Promise<Response>((_resolve, reject) => {
      const watchdog = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        reject(new Error("Expected test signal to abort"));
      }, 1_000);
      const onAbort = () => { clearTimeout(watchdog); reject(signal.reason); };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
  });
  await assert.rejects(readRepositoryFile("example-owner", "demo-repo", "docs/intro.md"), matchesClientError(502, "GITHUB_REQUEST_FAILED"));
  assert.ok(observed?.aborted);
  assert.equal(observed.reason.name, "TimeoutError");
});

test("root listing preserves order and accepts every supported entry type", async (t) => {
  const entries = [
    { name: "src", path: "src", type: "dir" },
    { name: "README.md", path: "README.md", type: "file" },
    { name: "link", path: "link", type: "symlink" },
    { name: "vendor", path: "vendor", type: "submodule" },
  ];
  const fetchMock = t.mock.method(globalThis, "fetch", async () => Response.json(entries));

  assert.deepEqual(await listRepositoryRoot("example-owner", "demo-repo"), entries);
  assert.equal(fetchMock.mock.callCount(), 1);
});

test("root listing returns only name, path, and type from each upstream entry", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json([
    { name: "README.md", path: "README.md", type: "file", size: 120, sha: "synthetic-sha" },
    { name: "src", path: "src", type: "dir", url: "https://api.github.com/synthetic" },
  ]));

  assert.deepEqual(await listRepositoryRoot("example-owner", "demo-repo"), [
    { name: "README.md", path: "README.md", type: "file" },
    { name: "src", path: "src", type: "dir" },
  ]);
});

test("root listing accepts an empty directory", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json([]));
  assert.deepEqual(await listRepositoryRoot("example-owner", "demo-repo"), []);
});

test("root listing encodes the root URL and retains headers and fresh signals", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => Response.json([]));
  // Synthetic direct-client arguments exercise escaping, not route acceptance.
  await listRepositoryRoot("owner/name", "repo?name#part");
  await listRepositoryRoot("example-owner", "demo-repo");

  const first = fetchMock.mock.calls[0];
  const second = fetchMock.mock.calls[1];
  assert.ok(first);
  assert.ok(second);
  assert.equal(first.arguments[0], "https://api.github.com/repos/owner%2Fname/repo%3Fname%23part/contents");
  const options = first.arguments[1];
  assert.ok(options?.signal instanceof AbortSignal);
  assert.equal(options.signal.aborted, false);
  assert.notEqual(options.signal, second.arguments[1]?.signal);
  const headers = new Headers(options.headers);
  assert.equal(headers.get("accept"), "application/vnd.github+json");
  assert.equal(headers.get("user-agent"), "issue-investigator");
  assert.equal(fetchMock.mock.callCount(), 2);
});

const rootFailureCases: Array<{
  name: string;
  respond: () => Promise<Response>;
  status: number;
  message: string;
}> = [
  { name: "404", respond: async () => new Response(null, { status: 404 }), status: 404, message: "REPOSITORY_NOT_FOUND" },
  { name: "503", respond: async () => new Response(null, { status: 503 }), status: 502, message: "GITHUB_REQUEST_FAILED" },
  { name: "invalid JSON", respond: async () => new Response("{broken"), status: 502, message: "GITHUB_REQUEST_FAILED" },
  { name: "network failure", respond: async () => { throw new TypeError("Simulated network failure"); }, status: 502, message: "GITHUB_REQUEST_FAILED" },
];

for (const { name, respond, status, message } of rootFailureCases) {
  test(`root listing maps ${name} to the specified client error`, async (t) => {
    const fetchMock = t.mock.method(globalThis, "fetch", respond);
    await assert.rejects(
      listRepositoryRoot("example-owner", "demo-repo"),
      (error: unknown) => error instanceof customError && error.status === status && error.message === message,
    );
    assert.equal(fetchMock.mock.callCount(), 1);
  });
}

const malformedRoots: Array<{ name: string; data: unknown }> = [
  { name: "null response", data: null },
  { name: "object response", data: { entries: [] } },
  { name: "string response", data: "not an array" },
  { name: "null entry", data: [null] },
  { name: "missing path", data: [{ name: "src", type: "dir" }] },
  { name: "non-string name", data: [{ name: 123, path: "src", type: "dir" }] },
  { name: "non-string path", data: [{ name: "src", path: 123, type: "dir" }] },
  { name: "unknown type", data: [{ name: "src", path: "src", type: "unknown" }] },
  { name: "mixed valid and invalid entries", data: [{ name: "src", path: "src", type: "dir" }, { name: "broken", path: "broken" }] },
];

for (const { name, data } of malformedRoots) {
  test(`root listing rejects ${name} without filtering malformed data`, async (t) => {
    t.mock.method(globalThis, "fetch", async () => Response.json(data));
    await assert.rejects(
      listRepositoryRoot("example-owner", "demo-repo"),
      (error: unknown) => error instanceof customError && error.status === 502 && error.message === "GITHUB_REQUEST_FAILED",
    );
  });
}

test("root listing requests a ten-second deadline and maps signal cancellation to 502", async (t) => {
  const originalTimeout = AbortSignal.timeout;
  const timeoutMock = t.mock.method(AbortSignal, "timeout", (delay: number) => {
    assert.equal(delay, 10_000);
    // Deliver the deadline early; the metadata test separately checks real elapsed time.
    return originalTimeout(20);
  });
  let observedSignal: AbortSignal | undefined;
  t.mock.method(globalThis, "fetch", async (
    _input: Parameters<typeof fetch>[0],
    options?: Parameters<typeof fetch>[1],
  ) => {
    assert.ok(options?.signal instanceof AbortSignal);
    const signal = options.signal;
    observedSignal = signal;
    return new Promise<Response>((_resolve, reject) => {
      const watchdog = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        reject(new Error("Expected test signal to abort"));
      }, 1_000);
      const onAbort = () => { clearTimeout(watchdog); reject(signal.reason); };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
  });

  await assert.rejects(
    listRepositoryRoot("example-owner", "demo-repo"),
    (error: unknown) => error instanceof customError && error.status === 502 && error.message === "GITHUB_REQUEST_FAILED",
  );
  assert.ok(observedSignal?.aborted);
  assert.equal(observedSignal.reason.name, "TimeoutError");
  assert.equal(timeoutMock.mock.callCount(), 1);
});

test("supports a string description", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json(validMetadata));

  assert.deepEqual(await getRepositorySummary("example-owner", "demo-repo"), {
    name: "demo-repo",
    fullName: "example-owner/demo-repo",
    description: "Synthetic repository for tests",
    defaultBranch: "main",
    htmlUrl: "https://github.com/example-owner/demo-repo",
  });
});

test("encodes path components and supplies headers and a fresh abort signal", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () =>
    Response.json(validMetadata),
  );

  // Deliberately bypass the HTTP input guard to inspect client URL construction.
  await getRepositorySummary("owner/name", "repo?name#part");
  await getRepositorySummary("example-owner", "demo-repo");

  const firstCall = fetchMock.mock.calls[0];
  const secondCall = fetchMock.mock.calls[1];
  assert.ok(firstCall);
  assert.ok(secondCall);
  assert.equal(
    firstCall.arguments[0],
    "https://api.github.com/repos/owner%2Fname/repo%3Fname%23part",
  );
  const options = firstCall.arguments[1];
  const headers = new Headers(options?.headers);
  assert.equal(headers.get("accept"), "application/vnd.github+json");
  assert.equal(headers.get("user-agent"), "issue-investigator");
  assert.ok(options?.signal instanceof AbortSignal);
  assert.equal(options.signal.aborted, false);
  assert.notEqual(options.signal, secondCall.arguments[1]?.signal);
  assert.equal(fetchMock.mock.callCount(), 2);
});

const failureCases: Array<{ name: string; respond: () => Promise<Response> }> =
  [
    {
      name: "upstream 503",
      respond: async () => new Response(null, { status: 503 }),
    },
    { name: "invalid metadata", respond: async () => Response.json({}) },
    { name: "invalid JSON", respond: async () => new Response("{broken") },
    {
      name: "network failure",
      respond: async () => {
        throw new TypeError("Simulated network failure");
      },
    },
  ];

for (const { name, respond } of failureCases) {
  test(`maps ${name} to the generic client error`, async (t) => {
    const fetchMock = t.mock.method(globalThis, "fetch", respond);

    await assert.rejects(
      getRepositorySummary("example-owner", "demo-repo"),
      (error: unknown) =>
        error instanceof customError &&
        error.status === 502 &&
        error.message === "GITHUB_REQUEST_FAILED",
    );
    assert.equal(fetchMock.mock.callCount(), 1);
  });
}

test(
  "cancels a stalled fetch near ten seconds and recovers with a fresh signal",
  { timeout: 15_000 },
  async (t) => {
    let timedSignal: AbortSignal | undefined;
    let recovered = false;
    const fetchMock = t.mock.method(
      globalThis,
      "fetch",
      async (
        _input: Parameters<typeof fetch>[0],
        options?: Parameters<typeof fetch>[1],
      ) => {
        assert.ok(options?.signal instanceof AbortSignal);
        if (recovered) {
          assert.notEqual(options.signal, timedSignal);
          assert.equal(options.signal.aborted, false);
          return Response.json(validMetadata);
        }
        const signal = options.signal;
        timedSignal = signal;
        return new Promise<Response>((_resolve, reject) => {
          const watchdog = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            reject(new Error("Abort signal did not fire within 13 seconds"));
          }, 13_000);
          const onAbort = () => {
            clearTimeout(watchdog);
            reject(signal.reason);
          };
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        });
      },
    );

    const started = performance.now();
    await assert.rejects(
      getRepositorySummary("example-owner", "demo-repo"),
      (error: unknown) =>
        error instanceof customError &&
        error.status === 502 &&
        error.message === "GITHUB_REQUEST_FAILED",
    );
    const elapsed = performance.now() - started;
    assert.ok(timedSignal?.aborted);
    assert.equal(timedSignal.reason.name, "TimeoutError");
    assert.ok(
      elapsed >= 9_500 && elapsed < 13_000,
      `Unexpected deadline: ${elapsed}ms`,
    );

    recovered = true;
    const summary = await getRepositorySummary("example-owner", "demo-repo");
    assert.equal(summary.fullName, "example-owner/demo-repo");
    assert.equal(fetchMock.mock.callCount(), 2);
  },
);
