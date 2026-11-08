import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import { app } from "./app.js";

const metadata = {
  name: "demo-repo",
  full_name: "example-owner/demo-repo",
  description: null,
  default_branch: "main",
  html_url: "https://github.com/example-owner/demo-repo",
};

const candidateRequest = { issueDescription: "Login fails when token expires", ref: "main" };
const candidatePaths = ["src/auth/login.ts", "src/auth/token.ts", "src/auth/login-token.ts", "src/payments/checkout.ts", "README.md"];
const candidateTree = {
  truncated: false,
  tree: candidatePaths.map((path) => ({ path, type: "blob", mode: "100644" })),
};
const candidateOutput = {
  owner: "example-owner", repo: "demo-repo", ref: "main", candidateCount: 5,
  files: [
    { path: "src/auth/login-token.ts", score: 2, matchedTerms: ["login", "token"] },
    { path: "src/auth/login.ts", score: 1, matchedTerms: ["login"] },
    { path: "src/auth/token.ts", score: 1, matchedTerms: ["token"] },
  ],
};
const candidateSuffix = "example-owner/demo-repo/candidates";
const jsonHeaders = { "Content-Type": "application/json" };
const candidatePost = { method: "POST", headers: jsonHeaders, body: JSON.stringify(candidateRequest) };

test("candidates route composes one tree lookup with ranking and exact response fields", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => Response.json(candidateTree));
  const request = await startServer(t);
  const response = await request(candidateSuffix, candidatePost);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, candidateOutput);
  assert.match(response.contentType ?? "", /application\/json/);
  assert.equal(fetchMock.mock.callCount(), 1);
  assert.equal(fetchMock.mock.calls[0]?.arguments[0], "https://api.github.com/repos/example-owner/demo-repo/git/trees/main?recursive=1");
});

test("candidates route counts unique eligible paths before filtering and the five-result cap", async (t) => {
  const paths = ["z-login.ts", "b-login.ts", "a-login.ts", "c-login.ts", "d-login.ts", "e-login.ts", "z-login-token.ts", "unmatched.md"];
  t.mock.method(globalThis, "fetch", async () => Response.json({ truncated: false, tree: [
    ...paths.map((path) => ({ path, type: "blob", mode: "100644" })),
    { path: "a-login.ts", type: "blob", mode: "100644" },
    { path: "login-link", type: "blob", mode: "120000" },
    { path: "login-dir", type: "tree", mode: "040000" },
    { path: "login-submodule", type: "commit", mode: "160000" },
  ] }));
  const request = await startServer(t);
  const response = await request(candidateSuffix, candidatePost);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    owner: "example-owner", repo: "demo-repo", ref: "main", candidateCount: 8,
    files: [
      { path: "z-login-token.ts", score: 2, matchedTerms: ["login", "token"] },
      ...["a-login.ts", "b-login.ts", "c-login.ts", "d-login.ts"].map((path) => ({ path, score: 1, matchedTerms: ["login"] })),
    ],
  });
});

test("candidates route preserves identifier/ref spelling and encodes explicit refs once", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => Response.json({ truncated: false, tree: [] }));
  const request = await startServer(t);
  for (const [ref, encoded] of [["feature/login", "feature%2Flogin"], [" main ", "%20main%20"], ["literal%2Fref", "literal%252Fref"]]) {
    const response = await request("Example-Owner/Demo.Repo/candidates", {
      ...candidatePost, body: JSON.stringify({ ...candidateRequest, ref }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { owner: "Example-Owner", repo: "Demo.Repo", ref, candidateCount: 0, files: [] });
    assert.equal(fetchMock.mock.calls.at(-1)?.arguments[0], `https://api.github.com/repos/Example-Owner/Demo.Repo/git/trees/${encoded}?recursive=1`);
  }
  assert.equal(fetchMock.mock.callCount(), 3);
});

test("candidates route returns successful empty results for empty or skipped-only trees", async (t) => {
  let tree: unknown[] = [];
  const fetchMock = t.mock.method(globalThis, "fetch", async () => Response.json({ truncated: false, tree }));
  const request = await startServer(t);
  for (tree of [[], [{ path: "link", type: "blob", mode: "120000" }]]) {
    const response = await request(candidateSuffix, candidatePost);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { ...candidateOutput, candidateCount: 0, files: [] });
  }
  assert.equal(fetchMock.mock.callCount(), 2);
});

test("candidates route still fetches once for nonmatching or termless valid reports", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => Response.json(candidateTree));
  const request = await startServer(t);
  for (const issueDescription of ["unrelated zebra", "the and for", "a ab !"]) {
    const response = await request(candidateSuffix, { ...candidatePost, body: JSON.stringify({ ...candidateRequest, issueDescription }) });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { ...candidateOutput, files: [] });
  }
  assert.equal(fetchMock.mock.callCount(), 3);
});

test("candidates route accepts trimmed length boundaries measured in UTF-16 units", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => Response.json(candidateTree));
  const request = await startServer(t);
  for (const issueDescription of [" x ", " \t" + "x".repeat(4_000) + "\n", "🙂".repeat(2_000)]) {
    const response = await request(candidateSuffix, { ...candidatePost, body: JSON.stringify({ ...candidateRequest, issueDescription }) });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { ...candidateOutput, files: [] });
  }
  assert.equal(fetchMock.mock.callCount(), 3);
});

test("candidates route trims the report and ignores additional body fields", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json(candidateTree));
  const request = await startServer(t);
  const response = await request(candidateSuffix, {
    ...candidatePost, body: JSON.stringify({ ...candidateRequest, issueDescription: `  ${candidateRequest.issueDescription}\n`, extra: { unused: true } }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, candidateOutput);
});

test("candidates route rejects invalid repository identifiers before fetching", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => Response.json(candidateTree));
  const request = await startServer(t);
  for (const suffix of ["bad%20owner/demo-repo/candidates", "example-owner/bad%40repo/candidates", "bad%20owner/bad%40repo/candidates", "example-owner/./candidates", "example-owner/../candidates"]) {
    const response = await request(suffix, candidatePost);
    assert.equal(response.status, 400, suffix);
    assert.deepEqual(response.body, { error: "INVALID_REPOSITORY_INPUT" });
  }
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("candidates route rejects invalid JSON body shapes and fields without fetching", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => Response.json(candidateTree));
  const request = await startServer(t);
  const invalid: unknown[] = [null, [], "report", 123, false, {}, { ref: "main" }, { issueDescription: "login" }];
  for (const issueDescription of [null, [], {}, 123, false, "", " \t\n", "x".repeat(4_001), "🙂".repeat(2_000) + "x"]) invalid.push({ ...candidateRequest, issueDescription });
  for (const ref of [null, [], {}, 123, false, "", " \t\n"]) invalid.push({ ...candidateRequest, ref });
  for (const body of invalid) {
    const response = await request(candidateSuffix, { ...candidatePost, body: JSON.stringify(body) });
    assert.equal(response.status, 400, JSON.stringify(body).slice(0, 80));
    assert.deepEqual(response.body, { error: "INVALID_INVESTIGATION_INPUT" });
  }
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("candidates route rejects absent bodies and unparsed media types without fetching", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => Response.json(candidateTree));
  const request = await startServer(t);
  for (const options of [
    { method: "POST", headers: jsonHeaders },
    { method: "POST", body: candidatePost.body },
    { ...candidatePost, headers: { "Content-Type": "text/plain" } },
  ]) {
    const response = await request(candidateSuffix, options);
    assert.equal(response.status, 400);
    assert.deepEqual(response.body, { error: "INVALID_INVESTIGATION_INPUT" });
  }
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("candidates parser accepts a body of exactly 16384 bytes", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => Response.json(candidateTree));
  const request = await startServer(t);
  const base = { ...candidateRequest, padding: "" };
  const body = JSON.stringify({ ...base, padding: "x".repeat(16_384 - Buffer.byteLength(JSON.stringify(base))) });
  assert.equal(Buffer.byteLength(body), 16_384);
  const response = await request(candidateSuffix, { ...candidatePost, body });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, candidateOutput);
  assert.equal(fetchMock.mock.callCount(), 1);
});

for (const { name, options, status, errorCode } of [
  { name: "malformed JSON", options: { ...candidatePost, body: '{"issueDescription":' }, status: 400, errorCode: "INVALID_JSON" },
  { name: "oversized body", options: { ...candidatePost, body: JSON.stringify({ ...candidateRequest, padding: "x".repeat(16_384) }) }, status: 413, errorCode: "REQUEST_BODY_TOO_LARGE" },
  { name: "unsupported charset", options: { ...candidatePost, headers: { "Content-Type": "application/json; charset=bogus" } }, status: 415, errorCode: "UNSUPPORTED_BODY_ENCODING" },
  { name: "unsupported encoding", options: { ...candidatePost, headers: { ...jsonHeaders, "Content-Encoding": "bogus" } }, status: 415, errorCode: "UNSUPPORTED_BODY_ENCODING" },
  { name: "unexpected decompression error", options: { ...candidatePost, body: "not gzip", headers: { ...jsonHeaders, "Content-Encoding": "gzip" } }, status: 500, errorCode: "INTERNAL_SERVER_ERROR" },
]) {
  test(`candidates parser maps ${name} to exact JSON and recovers`, async (t) => {
    const fetchMock = t.mock.method(globalThis, "fetch", async () => Response.json(candidateTree));
    const request = await startServer(t);
    const response = await request(candidateSuffix, options);
    assert.equal(response.status, status);
    assert.match(response.contentType ?? "", /application\/json/);
    assert.equal(fetchMock.mock.callCount(), 0);
    const recovery = await request(candidateSuffix, candidatePost);
    assert.equal(recovery.status, 200);
    assert.deepEqual(recovery.body, candidateOutput);
    assert.equal(fetchMock.mock.callCount(), 1);
    assert.deepEqual(response.body, { error: errorCode });
  });
}

for (const { name, respond, status, errorCode } of [
  { name: "missing repository/ref", respond: async () => new Response(null, { status: 404 }), status: 404, errorCode: "REPOSITORY_OR_REF_NOT_FOUND" },
  { name: "upstream failure", respond: async () => new Response(null, { status: 503 }), status: 502, errorCode: "GITHUB_REQUEST_FAILED" },
  { name: "malformed tree", respond: async () => Response.json({ truncated: false, tree: [...candidateTree.tree, null] }), status: 502, errorCode: "GITHUB_REQUEST_FAILED" },
  { name: "truncated tree", respond: async () => Response.json({ ...candidateTree, truncated: true }), status: 502, errorCode: "REPOSITORY_TREE_TRUNCATED" },
  { name: "oversized tree", respond: async () => Response.json({ truncated: false, tree: Array(10_001).fill(candidateTree.tree[0]) }), status: 502, errorCode: "REPOSITORY_TREE_TOO_LARGE" },
  { name: "invalid upstream JSON", respond: async () => new Response("not JSON"), status: 502, errorCode: "GITHUB_REQUEST_FAILED" },
  { name: "network failure", respond: async (): Promise<Response> => { throw new TypeError("Synthetic network error"); }, status: 502, errorCode: "GITHUB_REQUEST_FAILED" },
]) {
  test(`candidates route maps ${name} without partial results and recovers`, async (t) => {
    let fail = true;
    const fetchMock = t.mock.method(globalThis, "fetch", async () => fail ? respond() : Response.json(candidateTree));
    const request = await startServer(t);
    const response = await request(candidateSuffix, candidatePost);
    assert.equal(response.status, status);
    assert.deepEqual(response.body, { error: errorCode });
    assert.equal(fetchMock.mock.callCount(), 1);
    fail = false;
    const recovery = await request(candidateSuffix, candidatePost);
    assert.equal(recovery.status, 200);
    assert.deepEqual(recovery.body, candidateOutput);
    assert.equal(fetchMock.mock.callCount(), 2);
  });
}

test("candidates route maps the requested ten-second deadline and recovers", async (t) => {
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
    if (signals.length > 1) return Response.json(candidateTree);
    return new Promise<Response>((_resolve, reject) => {
      const watchdog = setTimeout(() => { signal.removeEventListener("abort", onAbort); reject(new Error("Expected cancellation")); }, 1_000);
      const onAbort = () => { clearTimeout(watchdog); reject(signal.reason); };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
  });
  const request = await startServer(t);
  const response = await request(candidateSuffix, candidatePost);
  assert.equal(response.status, 502);
  assert.deepEqual(response.body, { error: "GITHUB_REQUEST_FAILED" });
  assert.equal(signals[0]!.aborted, true);
  assert.equal(signals[0]!.reason.name, "TimeoutError");
  const recovery = await request(candidateSuffix, candidatePost);
  assert.equal(recovery.status, 200);
  assert.deepEqual(recovery.body, candidateOutput);
  assert.notEqual(signals[0], signals[1]);
  assert.equal(signals[1]!.aborted, false);
});

const rootEntries = [
  { name: "README.md", path: "README.md", type: "file" },
  { name: "src", path: "src", type: "dir" },
];

const fileResponse = {
  type: "file",
  encoding: "base64",
  name: "intro.md",
  path: "docs/intro.md",
  sha: "synthetic-blob-sha",
  size: 14,
  content: "SGVsbG8sIHdvcmxkIQo=",
};
const fileOutput = {
  name: "intro.md",
  path: "docs/intro.md",
  sha: "synthetic-blob-sha",
  content: "Hello, world!\n",
};

test("file route returns four fields and decoded text for a nested query path", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => Response.json({ ...fileResponse, extra: "not returned" }));
  const request = await startServer(t);
  const response = await request("example-owner/demo-repo/file?path=docs%2Fintro.md");
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, fileOutput);
  assert.match(response.contentType ?? "", /application\/json/);
  assert.equal(fetchMock.mock.callCount(), 1);
  assert.equal(fetchMock.mock.calls[0]?.arguments[0], "https://api.github.com/repos/example-owner/demo-repo/contents/docs/intro.md");
});

test("file route supports empty source text", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ ...fileResponse, content: "", size: 0 }));
  const request = await startServer(t);
  const response = await request("example-owner/demo-repo/file?path=empty.txt");
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { ...fileOutput, content: "" });
});

test("file route decodes a query once and preserves a literal percent-encoded filename", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => Response.json(fileResponse));
  const request = await startServer(t);
  const response = await request("example-owner/demo-repo/file?path=src%2Fname%252Fpart.ts");
  assert.equal(response.status, 200);
  assert.equal(fetchMock.mock.calls[0]?.arguments[0], "https://api.github.com/repos/example-owner/demo-repo/contents/src/name%252Fpart.ts");
});

test("file route rejects invalid repository identifiers before any fetch", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => Response.json(fileResponse));
  const request = await startServer(t);
  for (const pair of ["bad%20owner/demo-repo", "example-owner/bad%40repo", "bad%20owner/bad%40repo", "example-owner/..", "example-owner/."]) {
    const response = await request(`${pair}/file?path=docs%2Fintro.md`);
    assert.equal(response.status, 400, pair);
    assert.deepEqual(response.body, { error: "INVALID_REPOSITORY_INPUT" }, pair);
    assert.equal(fetchMock.mock.callCount(), 0, pair);
  }
});

test("file route rejects missing, repeated, structured, and invalid paths without fetching", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => Response.json(fileResponse));
  const request = await startServer(t);
  for (const query of [
    "", "?path=", "?path=first&path=second", "?path[]=src", "?path[x]=src",
    "?path=%2Fsrc%2Fapp.ts", "?path=src%2F..%2Fapp.ts", "?path=src%2F%00app.ts", "?path=src%5Capp.ts",
  ]) {
    const response = await request(`example-owner/demo-repo/file${query}`);
    assert.equal(response.status, 400, query);
    assert.deepEqual(response.body, { error: "INVALID_FILE_PATH" }, query);
    assert.match(response.contentType ?? "", /application\/json/);
    assert.equal(fetchMock.mock.callCount(), 0, query);
  }
});

for (const { name, respond, status, errorCode } of [
  { name: "404", respond: async () => new Response(null, { status: 404 }), status: 404, errorCode: "FILE_NOT_FOUND" },
  { name: "503", respond: async () => new Response(null, { status: 503 }), status: 502, errorCode: "GITHUB_REQUEST_FAILED" },
  { name: "malformed file response", respond: async () => Response.json({ ...fileResponse, encoding: "none" }), status: 502, errorCode: "GITHUB_REQUEST_FAILED" },
  { name: "invalid JSON", respond: async () => new Response("{broken"), status: 502, errorCode: "GITHUB_REQUEST_FAILED" },
  { name: "network failure", respond: async (): Promise<Response> => { throw new TypeError("Simulated network failure"); }, status: 502, errorCode: "GITHUB_REQUEST_FAILED" },
]) {
  test(`file route maps ${name} to JSON and handles the next request`, async (t) => {
    let fail = true;
    t.mock.method(globalThis, "fetch", async () => fail ? respond() : Response.json(fileResponse));
    const request = await startServer(t);
    const response = await request("example-owner/demo-repo/file?path=docs%2Fintro.md");
    assert.equal(response.status, status);
    assert.deepEqual(response.body, { error: errorCode });
    assert.match(response.contentType ?? "", /application\/json/);
    fail = false;
    const recovery = await request("example-owner/demo-repo/file?path=docs%2Fintro.md");
    assert.equal(recovery.status, 200);
    assert.deepEqual(recovery.body, fileOutput);
  });
}

test("file route maps a client deadline to JSON 502 and recovers", async (t) => {
  const originalTimeout = AbortSignal.timeout;
  t.mock.method(AbortSignal, "timeout", (delay: number) => {
    assert.equal(delay, 10_000);
    return originalTimeout(20);
  });
  let fail = true;
  let observed: AbortSignal | undefined;
  t.mock.method(globalThis, "fetch", async (_input: Parameters<typeof fetch>[0], options?: Parameters<typeof fetch>[1]) => {
    if (!fail) return Response.json(fileResponse);
    assert.ok(options?.signal instanceof AbortSignal);
    const signal = options.signal;
    observed = signal;
    return new Promise<Response>((_resolve, reject) => {
      const watchdog = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        reject(new Error("Expected test deadline"));
      }, 1_000);
      const onAbort = () => { clearTimeout(watchdog); reject(signal.reason); };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
  });
  const request = await startServer(t);
  const response = await request("example-owner/demo-repo/file?path=docs%2Fintro.md");
  assert.ok(observed?.aborted);
  assert.equal(observed.reason.name, "TimeoutError");
  assert.equal(response.status, 502);
  assert.deepEqual(response.body, { error: "GITHUB_REQUEST_FAILED" });
  fail = false;
  const recovery = await request("example-owner/demo-repo/file?path=docs%2Fintro.md");
  assert.equal(recovery.status, 200);
  assert.deepEqual(recovery.body, fileOutput);
});

test("contents route returns the root array with only the three public fields", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => Response.json([
    { ...rootEntries[0], size: 120, sha: "synthetic-sha" },
    rootEntries[1],
  ]));
  const request = await startServer(t);
  const response = await request("example-owner/demo-repo/contents");
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, rootEntries);
  assert.match(response.contentType ?? "", /application\/json/);
  assert.equal(fetchMock.mock.callCount(), 1);
  assert.equal(fetchMock.mock.calls[0]?.arguments[0], "https://api.github.com/repos/example-owner/demo-repo/contents");
});

test("contents route returns an empty root array", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json([]));
  const request = await startServer(t);
  const response = await request("example-owner/demo-repo/contents");
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, []);
});

test("contents route validates all identifiers before any GitHub call", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => Response.json(rootEntries));
  const request = await startServer(t);
  for (const suffix of [
    "bad%20owner/demo-repo",
    "example-owner/bad%40repo",
    "bad%20owner/bad%40repo",
    "example-owner/.",
    "example-owner/..",
    "example-owner/%2E%2E",
    "example-owner/name%2Fpart",
  ]) {
    const response = await request(`${suffix}/contents`);
    assert.equal(response.status, 400, suffix);
    assert.deepEqual(response.body, { error: "INVALID_REPOSITORY_INPUT" }, suffix);
    assert.equal(fetchMock.mock.callCount(), 0, suffix);
  }
});

for (const { name, respond, status, errorCode } of [
  { name: "404", respond: async () => new Response(null, { status: 404 }), status: 404, errorCode: "REPOSITORY_NOT_FOUND" },
  { name: "503", respond: async () => new Response(null, { status: 503 }), status: 502, errorCode: "GITHUB_REQUEST_FAILED" },
  { name: "invalid root entries", respond: async () => Response.json([{ name: "broken" }]), status: 502, errorCode: "GITHUB_REQUEST_FAILED" },
  { name: "invalid JSON", respond: async () => new Response("{broken"), status: 502, errorCode: "GITHUB_REQUEST_FAILED" },
  { name: "network failure", respond: async (): Promise<Response> => { throw new TypeError("Simulated network failure"); }, status: 502, errorCode: "GITHUB_REQUEST_FAILED" },
]) {
  test(`contents route maps ${name} to JSON and recovers`, async (t) => {
    let fail = true;
    t.mock.method(globalThis, "fetch", async () => fail ? respond() : Response.json(rootEntries));
    const request = await startServer(t);
    const response = await request("example-owner/demo-repo/contents");
    assert.equal(response.status, status);
    assert.deepEqual(response.body, { error: errorCode });
    assert.match(response.contentType ?? "", /application\/json/);
    fail = false;
    const recovery = await request("example-owner/demo-repo/contents");
    assert.equal(recovery.status, 200);
    assert.deepEqual(recovery.body, rootEntries);
  });
}

async function startServer(t: import("node:test").TestContext) {
  const server = app.listen(0, "127.0.0.1");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  // Raw HTTP preserves dot segments; the mocked global fetch is upstream only.
  return (suffix: string, options: { method?: string; body?: string; headers?: http.OutgoingHttpHeaders } = {}) =>
    new Promise<{ status: number | undefined; body: unknown; contentType: string | undefined }>((resolve, reject) => {
      const request = http.request(
        { hostname: "127.0.0.1", port: address.port, path: `/api/repositories/${suffix}`, method: options.method ?? "GET", ...(options.headers ? { headers: options.headers } : {}) },
        (response) => {
          let text = "";
          response.setEncoding("utf8");
          response.on("error", reject);
          response.on("data", (chunk: string) => { text += chunk; });
          response.on("end", () => {
            try {
              const body: unknown = JSON.parse(text);
              resolve({ status: response.statusCode, body, contentType: response.headers["content-type"] });
            } catch (error) { reject(error); }
          });
        },
      );
      request.setTimeout(3_000, () => request.destroy(new Error("Local request timed out")));
      request.on("error", reject);
      request.end(options.body);
    });
}

test("rejects invalid identifiers without any GitHub fetch", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => Response.json(metadata));
  const request = await startServer(t);

  for (const suffix of [
    "bad%20owner/demo-repo",
    "example-owner/bad%40repo",
    "bad%20owner/bad%40repo",
    "example-owner/.",
    "example-owner/..",
    "example-owner/%2E%2E",
    "example-owner/name%2Fpart",
  ]) {
    const response = await request(suffix);
    assert.equal(response.status, 400, suffix);
    assert.deepEqual(response.body, { error: "INVALID_REPOSITORY_INPUT" }, suffix);
    assert.match(response.contentType ?? "", /application\/json/);
    assert.equal(fetchMock.mock.callCount(), 0, suffix);
  }
});

test("returns the exact five-field summary for valid dotted names", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => Response.json(metadata));
  const request = await startServer(t);
  const response = await request("example-owner/demo.repo");

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    name: "demo-repo",
    fullName: "example-owner/demo-repo",
    description: null,
    defaultBranch: "main",
    htmlUrl: "https://github.com/example-owner/demo-repo",
  });
  assert.equal(fetchMock.mock.callCount(), 1);
});

for (const { name, respond, status, errorCode } of [
  { name: "missing repository", respond: async () => new Response(null, { status: 404 }), status: 404, errorCode: "REPOSITORY_NOT_FOUND" },
  { name: "upstream failure", respond: async () => new Response(null, { status: 503 }), status: 502, errorCode: "GITHUB_REQUEST_FAILED" },
  { name: "malformed metadata", respond: async () => Response.json({}), status: 502, errorCode: "GITHUB_REQUEST_FAILED" },
]) {
  test(`returns JSON for ${name} and still handles the next request`, async (t) => {
    let fail = true;
    t.mock.method(globalThis, "fetch", async () => fail ? respond() : Response.json(metadata));
    const request = await startServer(t);
    const response = await request("example-owner/demo-repo");
    assert.equal(response.status, status);
    assert.deepEqual(response.body, { error: errorCode });
    assert.match(response.contentType ?? "", /application\/json/);

    fail = false;
    const recovery = await request("example-owner/demo-repo");
    assert.equal(recovery.status, 200);
  });
}
