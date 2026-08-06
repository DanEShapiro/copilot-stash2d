import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  copySessionArtifacts,
  remainingSessionTreeBudget,
} from "../src/session-files.mjs";
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
  assert.deepEqual(result.usage, {
    entries: 6,
    directories: 3,
    bytes: 18,
  });
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

test("reserves Session.md and the SessionFiles root from traversal limits", () => {
  assert.deepEqual(
    remainingSessionTreeBudget({
      entries: 2,
      directories: 1,
      bytes: 6,
    }, {
      missingPlanUsage: {
        entries: 2,
        directories: 1,
        bytes: 10,
      },
      reservedUsage: {
        entries: 3,
        directories: 1,
        bytes: 20,
      },
    }),
    {
      entries: 5993,
      directories: 997,
      bytes: 1073741788,
    },
  );
});

test("reports unavailable public workspace paths", async (t) => {
  const directory = await temporaryDirectory(t);
  assert.deepEqual(await copySessionArtifacts(undefined, directory), {
    entries: [],
    unavailable: true,
    hasPlan: false,
    usage: { entries: 0, directories: 0, bytes: 0 },
  });
});

test("counts empty session artifact directories", async (t) => {
  const directory = await temporaryDirectory(t);
  const workspace = path.join(directory, "workspace");
  const archive = path.join(directory, "archive");
  await mkdir(path.join(workspace, "files"), { recursive: true });
  await mkdir(archive, { mode: 0o700 });

  const result = await copySessionArtifacts(workspace, archive);

  assert.deepEqual(result.usage, {
    entries: 1,
    directories: 1,
    bytes: 0,
  });
});

test("rejects session artifact depth that would exceed archive depth", async (t) => {
  const directory = await temporaryDirectory(t);
  const workspace = path.join(directory, "workspace");
  const archive = path.join(directory, "archive");
  let nested = path.join(workspace, "files");
  for (let depth = 0; depth < 63; depth += 1) {
    nested = path.join(nested, "d");
  }
  await writeText(path.join(nested, "file.txt"), "deep");
  await mkdir(archive, { mode: 0o700 });

  await assert.rejects(
    copySessionArtifacts(workspace, archive),
    /safety depth limit of 63/,
  );
});
