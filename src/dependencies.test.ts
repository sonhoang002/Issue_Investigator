import test from "node:test";
import assert from "node:assert/strict";
import { resolveRelativeImport } from "./dependencies.js";

// Internal canonical repository paths; no filesystem or module loading occurs.
test("resolves the assignment examples against the importing directory", () => {
  const importer = "src/services/session.js";
  const paths = [importer, "src/shared/token.js", "src/shared/token/index.js", "database/read.js", "src/services/helpers/index.js"];
  const cases: Array<[string, string | null]> = [
    ["../shared/token", "src/shared/token.js"],
    ["../shared/token.js", "src/shared/token.js"],
    ["../../database/read", "database/read.js"],
    ["./helpers", "src/services/helpers/index.js"],
    ["./missing", null], ["../shared/Token", null],
    ["express", null], ["../../../outside", null],
  ];
  for (const [specifier, expected] of cases) {
    assert.equal(resolveRelativeImport(importer, specifier, paths), expected, specifier);
  }
});

test("requires the exact importer to be present even when a target exists", () => {
  for (const importer of ["src/missing.js", "src/MAIN.js", ""]) {
    assert.equal(resolveRelativeImport(importer, "./helper", ["src/main.js", "src/helper.js"]), null);
  }
  assert.equal(resolveRelativeImport("main.js", "./helper", []), null);
});

test("rejects package names, builtins, aliases, URLs and absolute paths", () => {
  const paths = ["main.js", "helper.js"];
  for (const specifier of ["", ".", "..", "helper.js", "express", "@scope/pkg", "node:fs", "@/helper", "/helper.js", "//host/helper.js", "C:/helper.js", "https://host/helper.js", "file:///helper.js", " ./helper", ".../helper"]) {
    assert.equal(resolveRelativeImport("main.js", specifier, paths), null, specifier);
  }
});

test("rejects backslash, NUL, queries, fragments and trailing slash before matching", () => {
  for (const tail of ["helper\\file.js", "helper\0.js", "helper.js?raw", "helper.js#part", "helpers/", "", "../"]) {
    const specifier = `./${tail}`;
    assert.equal(resolveRelativeImport("main.js", specifier, ["main.js", tail, "helpers/index.js"]), null, JSON.stringify(specifier));
  }
});

test("normalizes dots and repeated separators while allowing internal parent paths", () => {
  const importer = "src/services/main.js";
  const paths = [importer, "src/shared/helper.js", "helper.js"];
  for (const specifier of ["../shared/helper", "./../shared/./helper", "../shared//nested/../helper"]) {
    assert.equal(resolveRelativeImport(importer, specifier, paths), "src/shared/helper.js");
  }
  assert.equal(resolveRelativeImport(importer, "../../helper", paths), "helper.js");
});

test("rejects normalized repository root and escapes without clamping to a known file", () => {
  const paths = ["src/main.js", "helper.js", "index.js", ".js", "..hidden.js"];
  for (const specifier of ["../../helper", "../..", "../.", "./../..", "../../../helper"]) {
    assert.equal(resolveRelativeImport("src/main.js", specifier, paths), null, specifier);
  }
  assert.equal(resolveRelativeImport("src/main.js", "../..hidden.js", paths), "..hidden.js");
});

test("exact extensionless file wins over JS fallback and index regardless of list order", () => {
  const paths = ["main.js", "helper/index.js", "helper.js", "helper"];
  assert.equal(resolveRelativeImport("main.js", "./helper", paths), "helper");
  assert.equal(resolveRelativeImport("main.js", "./helper", [...paths].reverse()), "helper");
});

test("JS fallback wins over index and index works when it is the only candidate", () => {
  assert.equal(resolveRelativeImport("main.js", "./helper", ["main.js", "helper/index.js", "helper.js"]), "helper.js");
  assert.equal(resolveRelativeImport("main.js", "./helper", ["main.js", "helper/index.js"]), "helper/index.js");
});

test("explicit extensions allow only an exact match without replacement or fallbacks", () => {
  assert.equal(resolveRelativeImport("main.js", "./helper.ts", ["main.js", "helper.ts"]), "helper.ts");
  assert.equal(resolveRelativeImport("main.js", "./helper.js", ["main.js", "helper.ts", "helper.js.js", "helper.js/index.js"]), null);
  assert.equal(resolveRelativeImport("main.js", "./helper.", ["main.js", "helper..js", "helper./index.js"]), null);
});

test("preserves case, spaces and percent sequences without trimming or decoding", () => {
  const paths = ["main.js", "Helper.js", "helper%20name.js", "helper name.js", "helper.js "];
  assert.equal(resolveRelativeImport("main.js", "./Helper", paths), "Helper.js");
  assert.equal(resolveRelativeImport("main.js", "./helper", paths), null);
  assert.equal(resolveRelativeImport("main.js", "./helper%20name", paths), "helper%20name.js");
  assert.equal(resolveRelativeImport("main.js", "./helper name", paths), "helper name.js");
  assert.equal(resolveRelativeImport("main.js", "./helper.js ", paths), "helper.js ");
  assert.equal(resolveRelativeImport("main.js", "./helper%20name", ["main.js", "helper name.js"]), null);
});

test("returns null for absent targets without guessing extra extensions or package entrypoints", () => {
  const paths = ["main.js", "helper.ts", "helper.jsx", "helper.json", "helper/index.ts", "helper/package.json"];
  assert.equal(resolveRelativeImport("main.js", "./helper", paths), null);
  assert.equal(resolveRelativeImport("main.js", "./missing", paths), null);
});

test("preserves frozen input and remains independent across calls and duplicate entries", () => {
  const paths = ["main.js", "helper.js", "helper.js"];
  const original = [...paths];
  Object.freeze(paths);
  assert.equal(resolveRelativeImport("main.js", "./helper", paths), "helper.js");
  assert.equal(resolveRelativeImport("main.js", "./other", paths), null);
  assert.equal(resolveRelativeImport("main.js", "./helper", paths), "helper.js");
  assert.deepStrictEqual(paths, original);
});
