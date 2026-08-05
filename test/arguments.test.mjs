import assert from "node:assert/strict";
import test from "node:test";
import {
  parseApplyArguments,
  parseSaveArguments,
  tokenizeArguments,
} from "../src/arguments.mjs";

test("tokenizes quoted paths and escaped quotes", () => {
  assert.deepEqual(
    tokenizeArguments('"C:\\My Files\\session.md" "A \\"title\\""'),
    ["C:\\My Files\\session.md", 'A "title"'],
  );
});

test("preserves Windows UNC paths", () => {
  assert.deepEqual(
    tokenizeArguments('"\\\\server\\share\\archive folder"'),
    ["\\\\server\\share\\archive folder"],
  );
});

test("preserves quoted Windows paths ending in a separator", () => {
  assert.deepEqual(tokenizeArguments('"C:\\Temp\\"'), ["C:\\Temp\\"]);
  assert.deepEqual(
    tokenizeArguments('"\\\\server\\share\\"'),
    ["\\\\server\\share\\"],
  );
});

test("supports unquoted escaped spaces on POSIX", () => {
  assert.deepEqual(
    parseSaveArguments("--output /tmp/archive\\ folder --title work"),
    { outputDirectory: "/tmp/archive folder", title: "work" },
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

test("rejects missing and duplicate save option values", () => {
  assert.throws(
    () => parseSaveArguments("--output --title work"),
    /--output requires a directory path/,
  );
  assert.throws(
    () => parseSaveArguments("--title --output /tmp"),
    /--title requires a value/,
  );
  assert.throws(
    () => parseSaveArguments("--output /tmp --output /var/tmp"),
    /--output may only be specified once/,
  );
  assert.throws(
    () => parseSaveArguments("--title one --title two"),
    /--title may only be specified once/,
  );
});

test("allows quoted option-like save values", () => {
  assert.deepEqual(parseSaveArguments('--title "--output"'), {
    outputDirectory: undefined,
    title: "--output",
  });
  assert.deepEqual(parseSaveArguments('--output "--title"'), {
    outputDirectory: "--title",
    title: undefined,
  });
});

test("rejects unknown options and unquoted option-like values", () => {
  assert.throws(
    () => parseSaveArguments("--ouptut /tmp --title work"),
    /Unknown option: --ouptut/,
  );
  assert.throws(
    () => parseSaveArguments("--title --bogus"),
    /--title requires a value/,
  );
  assert.throws(
    () => parseSaveArguments("--output --bogus --title work"),
    /--output requires a directory path/,
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
