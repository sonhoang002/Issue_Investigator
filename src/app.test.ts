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
