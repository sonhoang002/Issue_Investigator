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
  return (suffix: string) =>
    new Promise<{ status: number | undefined; body: unknown; contentType: string | undefined }>((resolve, reject) => {
      const request = http.get(
        { hostname: "127.0.0.1", port: address.port, path: `/api/repositories/${suffix}` },
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
