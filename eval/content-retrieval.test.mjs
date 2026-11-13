import test from "node:test";
import assert from "node:assert/strict";
import { checkBudget, exclusionReason, parseTree } from "./content-retrieval.mjs";

test("experiment pool filters use file kind, extensions and directory boundaries", () => {
  const entry = { mode: "100644", type: "blob", path: "src/TEST/example.TS" };
  assert.equal(exclusionReason(entry), null);
  assert.equal(exclusionReason({ ...entry, mode: "100755" }), null);
  for (const path of ["NODE_MODULES/a.js", "a/.venv/a.py", "a.min.JS", "a.D.TS", "data.csv", ".env", "notes.md"]) {
    assert.notEqual(exclusionReason({ ...entry, path }), null, path);
  }
  assert.equal(exclusionReason({ ...entry, path: "src/building.js" }), null);
  assert.notEqual(exclusionReason({ ...entry, mode: "120000" }), null);
  assert.notEqual(exclusionReason({ ...entry, type: "commit", mode: "160000" }), null);
});

test("experiment accepts exact budgets and rejects each exceeded limit", () => {
  assert.equal(checkBudget([]), 0);
  assert.equal(checkBudget(Array.from({ length: 100 }, () => ({ bytes: 20_000 }))), 2_000_000);
  assert.equal(checkBudget([{ bytes: 100_000 }]), 100_000);
  assert.throws(() => checkBudget(Array.from({ length: 101 }, () => ({ bytes: 0 }))), /file count/);
  assert.throws(() => checkBudget([{ bytes: 100_001 }]), /per-file/);
  assert.throws(() => checkBudget(Array.from({ length: 21 }, () => ({ bytes: 100_000 }))), /total byte/);
  for (const bytes of [-1, null, 1.5, NaN]) assert.throws(() => checkBudget([{ bytes }]), /Invalid blob size/);
});

test("pinned tree parser preserves paths and rejects malformed records", () => {
  const sha = "a".repeat(40);
  assert.deepStrictEqual(parseTree(`100644 blob ${sha}      10\tsrc/a b\nc.js\0`), [
    { mode: "100644", type: "blob", sha, bytes: 10, path: "src/a b\nc.js" },
  ]);
  assert.deepStrictEqual(parseTree(""), []);
  assert.equal(parseTree(`160000 commit ${sha}       -\tsubmodule\0`)[0].bytes, null);
  assert.throws(() => parseTree("unexpected"), /Unexpected git ls-tree/);
});
