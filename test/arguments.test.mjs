import assert from "node:assert/strict";
import test from "node:test";
import {
  parseApplyArguments,
  parseSaveArguments,
  tokenizeArguments,
} from "../src/arguments.mjs";

test("tokenizes quoted paths and escaped quotes", () => {
  assert.deepEqual(
    tokenizeArguments('"C:\\\\My Files\\\\session.md" "A \\"title\\""'),
    ["C:\\My Files\\session.md", 'A "title"'],
  );
});

test("rejects unterminated quotes", () => {
  assert.throws(
    () => tokenizeArguments('"unfinished'),
    /Unterminated " quote/,
  );
});

test("parses direct and flagged save arguments", () => {
  assert.deepEqual(
    parseSaveArguments('"Useful work"'),
    { outputDirectory: undefined, title: "Useful work" },
  );
  assert.deepEqual(
    parseSaveArguments('--title "Useful work" --output "/tmp/stashes"'),
    { outputDirectory: "/tmp/stashes", title: "Useful work" },
  );
});

test("treats non-Markdown positional input as a guided title", () => {
  assert.deepEqual(parseSaveArguments("Useful work"), {
    outputDirectory: undefined,
    title: "Useful work",
  });
});

test("parses apply paths", () => {
  assert.equal(
    parseApplyArguments('"/tmp/archive folder"'),
    "/tmp/archive folder",
  );
});
