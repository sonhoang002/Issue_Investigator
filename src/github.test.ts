import test from "node:test";
import assert from "node:assert/strict";
import { customError, getRepositorySummary, listRepositoryRoot, readRepositoryFile } from "./github.js";

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
