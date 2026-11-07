import test from "node:test";
import assert from "node:assert/strict";
import { rankFilePaths, type RankedFile } from "./retrieval.js";

// Synthetic contract cases, not a benchmark of real issue relevance.
test("ranks the documented login/token example with exact output fields", () => {
  const result: RankedFile[] = rankFilePaths("Login fails when token expires", [
    "src/auth/login.ts",
    "src/auth/token.ts",
    "src/auth/login-token.ts",
    "src/payments/checkout.ts",
    "README.md",
  ]);

  assert.deepStrictEqual(result, [
    { path: "src/auth/login-token.ts", score: 2, matchedTerms: ["login", "token"] },
    { path: "src/auth/login.ts", score: 1, matchedTerms: ["login"] },
    { path: "src/auth/token.ts", score: 1, matchedTerms: ["token"] },
  ]);
});

test("normalizes case and splits punctuation, whitespace, and non-ASCII characters", () => {
  assert.deepStrictEqual(
    rankFilePaths("LOGIN-token\tERROR!café", ["Src/LOGIN_TOKEN_ERROR_CAF.ts"]),
    [{ path: "Src/LOGIN_TOKEN_ERROR_CAF.ts", score: 4, matchedTerms: ["login", "token", "error", "caf"] }],
  );
});

test("retains three-character and numeric terms while dropping shorter terms", () => {
  assert.deepStrictEqual(
    rankFilePaths("a ab 12 abc 123", ["src/a-ab-12-abc-123.ts"]),
    [{ path: "src/a-ab-12-abc-123.ts", score: 2, matchedTerms: ["abc", "123"] }],
  );
});

test("removes exactly the specified stop words without expanding the list", () => {
  assert.deepStrictEqual(
    rankFilePaths("THE and for with when this that from then not", [
      "the-and-for-with-when-this-that-from.ts",
      "then-not.ts",
    ]),
    [{ path: "then-not.ts", score: 2, matchedTerms: ["then", "not"] }],
  );
});

test("counts each normalized report term once despite repeated words or occurrences", () => {
  assert.deepStrictEqual(
    rankFilePaths("LOGIN login token TOKEN login", ["login-login/token-token.ts"]),
    [{ path: "login-login/token-token.ts", score: 2, matchedTerms: ["login", "token"] }],
  );
});

test("keeps matched terms in report order instead of path or alphabetical order", () => {
  assert.deepStrictEqual(
    rankFilePaths("token login expires", ["expires-login-token.ts"]),
    [{ path: "expires-login-token.ts", score: 3, matchedTerms: ["token", "login", "expires"] }],
  );
});

test("matches substrings in the full path and removes nonmatching candidates", () => {
  assert.deepStrictEqual(
    rankFilePaths("auth login", ["src/auth/loginHandler.ts", "docs/intro.md"]),
    [{ path: "src/auth/loginHandler.ts", score: 2, matchedTerms: ["auth", "login"] }],
  );
});

test("deduplicates exact paths while preserving case-distinct original spellings", () => {
  assert.deepStrictEqual(
    rankFilePaths("login", ["src/Login.ts", "src/login.ts", "src/Login.ts", "src/login.ts"]),
    [
      { path: "src/Login.ts", score: 1, matchedTerms: ["login"] },
      { path: "src/login.ts", score: 1, matchedTerms: ["login"] },
    ],
  );
});

test("breaks equal scores using original JavaScript string order", () => {
  assert.deepStrictEqual(
    rankFilePaths("token", ["token/z.ts", "token/a.ts", "token/_a.ts", "token/Z.ts", "token/A.ts"])
      .map((file) => file.path),
    ["token/A.ts", "token/Z.ts", "token/_a.ts", "token/a.ts", "token/z.ts"],
  );
});

test("sorts by score before applying the five-unique-file limit", () => {
  assert.deepStrictEqual(
    rankFilePaths("login token", [
      "z-login.ts", "e-login.ts", "d-login.ts", "c-login.ts",
      "b-login.ts", "a-login.ts", "z-login-token.ts", "z-login-token.ts",
    ]),
    [
      { path: "z-login-token.ts", score: 2, matchedTerms: ["login", "token"] },
      { path: "a-login.ts", score: 1, matchedTerms: ["login"] },
      { path: "b-login.ts", score: 1, matchedTerms: ["login"] },
      { path: "c-login.ts", score: 1, matchedTerms: ["login"] },
      { path: "d-login.ts", score: 1, matchedTerms: ["login"] },
    ],
  );
});

test("returns an empty array for empty, unusable, or unmatched input", () => {
  const cases: Array<[string, string[]]> = [
    ["", ["login.ts"]],
    [" \t\n!!!", ["login.ts"]],
    ["a ab 12", ["a-ab-12.ts"]],
    ["the and for with when this that from", ["the-and.ts"]],
    ["login", []],
    ["login", ["README.md", ""]],
  ];
  for (const [description, paths] of cases) {
    assert.deepStrictEqual(rankFilePaths(description, paths), [], description);
  }
});

test("does not mutate the supplied paths while deduplicating or sorting", () => {
  const paths = ["z-login.ts", "A-login.ts", "z-login.ts", "README.md"];
  const original = [...paths];
  Object.freeze(paths);

  assert.deepStrictEqual(rankFilePaths("login", paths), [
    { path: "A-login.ts", score: 1, matchedTerms: ["login"] },
    { path: "z-login.ts", score: 1, matchedTerms: ["login"] },
  ]);
  assert.deepStrictEqual(paths, original);
});

test("returns independent results across candidates and repeated calls", () => {
  const paths = ["login.ts", "login-token.ts"];
  const expected = [
    { path: "login-token.ts", score: 2, matchedTerms: ["login", "token"] },
    { path: "login.ts", score: 1, matchedTerms: ["login"] },
  ];
  const first = rankFilePaths("login token", paths);
  const second = rankFilePaths("login token", paths);
  assert.deepStrictEqual(first, expected);
  assert.deepStrictEqual(second, expected);
  first[0]!.matchedTerms.push("changed");
  first[0]!.path = "changed";
  first.pop();

  assert.deepStrictEqual(second, expected);
  assert.deepStrictEqual(rankFilePaths("login token", paths), expected);
});
