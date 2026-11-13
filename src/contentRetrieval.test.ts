import test from "node:test";
import assert from "node:assert/strict";
import { rankFileContents, type SourceFile } from "./contentRetrieval.js";

// Synthetic behavior checks; these do not measure repository relevance.
test("content matches can outrank a filename match with exact result fields", () => {
  assert.deepStrictEqual(rankFileContents("login token", [
    { path: "src/login.ts", content: "render form" },
    { path: "src/session.ts", content: "login token token" },
    { path: "src/cart.ts", content: "calculate total" },
  ]), [
    { path: "src/session.ts", score: 2, matchedTerms: ["login", "token"] },
    { path: "src/login.ts", score: 1, matchedTerms: ["login"] },
  ]);
});

test("normalizes punctuation and case, preserving term order and numeric terms", () => {
  assert.deepStrictEqual(rankFileContents("TOKEN-login!123 ab 12", [
    { path: "Src/LOGIN.ts", content: "123 TOKEN" },
  ]), [{ path: "Src/LOGIN.ts", score: 3, matchedTerms: ["token", "login", "123"] }]);
});

test("removes exactly the existing stop words", () => {
  assert.deepStrictEqual(rankFileContents("THE and for with when this that from then not", [
    { path: "sample.ts", content: "the and for with when this that from then not" },
  ]), [{ path: "sample.ts", score: 2, matchedTerms: ["then", "not"] }]);
});

test("counts distinct terms once across repetitions and both searchable fields", () => {
  assert.deepStrictEqual(rankFileContents("token TOKEN login token", [
    { path: "login-token.ts", content: "login token token LOGIN" },
  ]), [{ path: "login-token.ts", score: 2, matchedTerms: ["token", "login"] }]);
});

test("matches substrings in content and path without stemming", () => {
  assert.deepStrictEqual(rankFileContents("auth login scoring", [
    { path: "src/auth/handler.ts", content: "loginHandler score" },
  ]), [{ path: "src/auth/handler.ts", score: 2, matchedTerms: ["auth", "login"] }]);
});

test("deduplicates separate objects by exact path and keeps first content", () => {
  assert.deepStrictEqual(rankFileContents("login token", [
    { path: "session.ts", content: "login" },
    { path: "session.ts", content: "login token" },
    { path: "Session.ts", content: "token" },
  ]), [
    { path: "Session.ts", score: 1, matchedTerms: ["token"] },
    { path: "session.ts", score: 1, matchedTerms: ["login"] },
  ]);
});

test("first duplicate wins even when it has no matches", () => {
  assert.deepStrictEqual(rankFileContents("token", [
    { path: "session.ts", content: "unrelated" },
    { path: "session.ts", content: "token" },
  ]), []);
});

test("sorts scores before original JavaScript path order and returns more than five", () => {
  const paths = ["z.ts", "a.ts", "_a.ts", "Z.ts", "A.ts", "b.ts", "c.ts"];
  const files = paths.map((path) => ({ path, content: path === "z.ts" ? "token login" : "token" }));
  const ranked = rankFileContents("token login", files);
  assert.deepStrictEqual(ranked.map((file) => file.path), ["z.ts", "A.ts", "Z.ts", "_a.ts", "a.ts", "b.ts", "c.ts"]);
  assert.deepStrictEqual(ranked.map((file) => file.score), [2, 1, 1, 1, 1, 1, 1]);
});

test("empty or unusable descriptions, empty pools, and unmatched content return empty", () => {
  const files = [{ path: "sample.ts", content: "login token" }];
  for (const description of ["", " \t!", "a ab 12", "the and for with when this that from", "missing"]) {
    assert.deepStrictEqual(rankFileContents(description, files), [], description);
  }
  assert.deepStrictEqual(rankFileContents("login", []), []);
});

test("empty content can still match through its path", () => {
  assert.deepStrictEqual(rankFileContents("login", [
    { path: "login.ts", content: "" },
    { path: "sample.ts", content: "" },
  ]), [{ path: "login.ts", score: 1, matchedTerms: ["login"] }]);
});

test("preserves frozen inputs and returns independently mutable results", () => {
  const files: SourceFile[] = [
    { path: "z.ts", content: "login" },
    { path: "a.ts", content: "login token" },
  ];
  const original = structuredClone(files);
  files.forEach(Object.freeze);
  Object.freeze(files);
  const first = rankFileContents("login token", files);
  const second = rankFileContents("login token", files);
  first[0]!.matchedTerms.push("changed");
  first[0]!.path = "changed";
  first.pop();
  assert.deepStrictEqual(files, original);
  assert.deepStrictEqual(second, [
    { path: "a.ts", score: 2, matchedTerms: ["login", "token"] },
    { path: "z.ts", score: 1, matchedTerms: ["login"] },
  ]);
  assert.deepStrictEqual(rankFileContents("login token", files), second);
});
