import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { copySessionArtifacts } from "../src/session-files.mjs";
import { temporaryDirectory, writeText } from "./helpers.mjs";

test("preserves plan.md and the complete session files tree", async (t) => {
  const directory = await temporaryDirectory(t);
  const workspace = path.join(directory, "workspace");
  const archive = path.join(directory, "archive");
  await writeText(path.join(workspace, "plan.md"), "# Plan");
  await writeText(path.join(workspace, "files", "diagram.txt"), "diagram");
  await writeText(
    path.join(workspace, "files", "nested", "notes.md"),
    "notes",
  );
  await writeText(path.join(workspace, "database.db"), "runtime");
  await mkdir(archive, { mode: 0o700 });

  const result = await copySessionArtifacts(workspace, archive);

  assert.equal(result.unavailable, false);
  assert.equal(result.hasPlan, true);
  assert.equal(
    await readFile(path.join(archive, "SessionState", "plan.md"), "utf8"),
    "# Plan",
  );
  assert.equal(
    await readFile(path.join(archive, "SessionFiles", "diagram.txt"), "utf8"),
    "diagram",
  );
  await assert.rejects(
    readFile(path.join(archive, "database.db"), "utf8"),
    /ENOENT/,
  );
  assert.deepEqual(
    result.entries.map(({ archivedPath }) => archivedPath).sort(),
    [
      "SessionFiles/diagram.txt",
      "SessionFiles/nested/notes.md",
      "SessionState/plan.md",
    ],
  );
});

test("reports unavailable public workspace paths", async (t) => {
  const directory = await temporaryDirectory(t);
  assert.deepEqual(await copySessionArtifacts(undefined, directory), {
    entries: [],
    unavailable: true,
    hasPlan: false,
  });
});
