import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  archiveFolderName,
  pathExists,
  writeMetadata,
} from "../src/archive.mjs";
import { createCommands } from "../src/commands.mjs";
import { fakeSession, temporaryDirectory, writeText } from "./helpers.mjs";

const FIXED_DATE = new Date(2026, 6, 31, 21, 36, 7);

test("saves a complete portable archive directly from public events", async (t) => {
  const directory = await temporaryDirectory(t);
  const workspace = path.join(directory, "workspace");
  await writeText(path.join(workspace, "plan.md"), "# Existing plan");
  await writeText(path.join(workspace, "files", "result.txt"), "result");
  const events = [
    {
      type: "session.start",
      parentId: null,
      timestamp: "2026-07-31T20:00:00.000Z",
      data: { cwd: directory },
    },
  ];
  const session = fakeSession({
    workspacePath: workspace,
    cwd: directory,
    events,
    inputs: ["portable work"],
  });
  const commands = createCommands({
    session,
    cwd: directory,
    now: () => new Date(FIXED_DATE),
  });

  await commands.save(`--output "${directory}"`);
  assert.match(session.inputRequests[0].message, /Name this Copilot session archive/);

  const archivePath = path.join(
    directory,
    archiveFolderName("portable work", FIXED_DATE),
  );
  assert.match(
    await readFile(path.join(archivePath, "Session.md"), "utf8"),
    /# Copilot Session/,
  );
  assert.equal(
    await pathExists(path.join(archivePath, "SessionEvents.json")),
    false,
  );
  assert.match(
    await readFile(path.join(archivePath, "Handoff.md"), "utf8"),
    /# Handoff/,
  );
  assert.equal(
    await readFile(path.join(archivePath, "SessionState", "plan.md"), "utf8"),
    "# Existing plan",
  );
  assert.equal(
    await readFile(path.join(archivePath, "SessionFiles", "result.txt"), "utf8"),
    "result",
  );
  const metadata = JSON.parse(
    await readFile(path.join(archivePath, "Metadata.json"), "utf8"),
  );
  assert.equal(metadata.formatVersion, 1);
  assert.equal(metadata.title, "portable work");
  assert.equal("sessionId" in metadata, false);
  assert.equal(metadata.sessionSource, "public-session-events");
});

test("uses one timestamp for the archive name and metadata", async (t) => {
  const directory = await temporaryDirectory(t);
  const first = new Date(2026, 6, 31, 21, 36, 7);
  const second = new Date(2026, 6, 31, 21, 40, 0);
  let calls = 0;
  const session = fakeSession();
  const commands = createCommands({
    session,
    cwd: directory,
    now: () => (calls++ === 0 ? first : second),
  });

  await commands.save(`--output "${directory}" --title "timestamped"`);

  const archivePath = path.join(
    directory,
    archiveFolderName("timestamped", first),
  );
  const metadata = JSON.parse(
    await readFile(path.join(archivePath, "Metadata.json"), "utf8"),
  );
  assert.equal(metadata.createdAt, first.toISOString());
  assert.equal(calls, 1);
});

test("uses the generated event transcript to create a plan when none exists", async (t) => {
  const directory = await temporaryDirectory(t);
  const session = fakeSession({
    cwd: directory,
    events: [
      {
        id: "user",
        type: "user.message",
        timestamp: "2026-08-01T20:00:00.000Z",
        data: {
          content:
            "Implement the weather API. The client is implemented; tests remain.",
        },
      },
    ],
  });
  const commands = createCommands({
    session,
    cwd: directory,
    now: () => new Date(FIXED_DATE),
  });

  await commands.save(`--output "${directory}" --title "weather API"`);

  const archivePath = path.join(
    directory,
    archiveFolderName("weather API", FIXED_DATE),
  );
  assert.match(
    await readFile(path.join(archivePath, "SessionState", "plan.md"), "utf8"),
    /Remaining Steps/,
  );
  assert.deepEqual(
    session.sent[0].attachments.map((attachment) => attachment.displayName),
    ["Session.md"],
  );
});

test("applies an edited archive to a new session as public file context", async (t) => {
  const directory = await temporaryDirectory(t);
  const archivePath = path.join(directory, "archive");
  await writeText(path.join(archivePath, "Session.md"), "edited session");
  await writeText(path.join(archivePath, "Handoff.md"), "edited handoff");
  await writeText(path.join(archivePath, "SessionFiles", "notes.md"), "notes");
  await writeMetadata(archivePath, {
    formatVersion: 1,
    title: "edited archive",
  });
  const session = fakeSession();
  const commands = createCommands({ session, cwd: directory });

  await commands.apply(`"${archivePath}"`);

  assert.equal(session.sent.length, 1);
  assert.match(session.sent[0].prompt, /new session/);
  assert.deepEqual(
    session.sent[0].attachments.map((attachment) => attachment.displayName),
    ["Handoff.md", "Session.md", "Metadata.json", "SessionFiles/notes.md"],
  );
  assert.ok(
    session.sent[0].attachments.every(
      (attachment) => attachment.type === "file",
    ),
  );
});

test("copies only explicitly approved external context during save", async (t) => {
  const directory = await temporaryDirectory(t);
  const externalPath = path.join(directory, "Downloads", "input.txt");
  await writeText(externalPath, "input");
  const session = fakeSession({
    selections: ["Include this file"],
    events: [
      {
        id: "user",
        type: "user.message",
        timestamp: "2026-08-01T20:00:00.000Z",
        data: { content: `Read \`${externalPath}\`.` },
      },
    ],
  });
  const commands = createCommands({
    session,
    cwd: directory,
    now: () => new Date(FIXED_DATE),
  });

  await commands.save(
    `--output "${directory}" --title "external context"`,
  );

  const archivePath = path.join(
    directory,
    archiveFolderName("external context", FIXED_DATE),
  );
  assert.equal(
    await readFile(
      path.join(archivePath, "Context", "001-input.txt"),
      "utf8",
    ),
    "input",
  );
});

test("can cancel external context review without creating an archive", async (t) => {
  const directory = await temporaryDirectory(t);
  const externalPath = path.join(directory, "Downloads", "input.txt");
  await writeText(externalPath, "input");
  const session = fakeSession({
    selections: ["Cancel save"],
    events: [
      {
        id: "user",
        type: "user.message",
        timestamp: "2026-08-01T20:00:00.000Z",
        data: { content: `Read \`${externalPath}\`.` },
      },
    ],
  });
  const commands = createCommands({
    session,
    cwd: directory,
    now: () => new Date(FIXED_DATE),
  });

  await commands.save(`--output "${directory}" --title "cancelled"`);

  assert.match(session.logs.at(-1).message, /save cancelled/i);
  assert.equal(
    await pathExists(
      path.join(directory, archiveFolderName("cancelled", FIXED_DATE)),
    ),
    false,
  );
});

test("cancelling does not create a new output directory", async (t) => {
  const directory = await temporaryDirectory(t);
  const outputDirectory = path.join(directory, "brand-new");
  const externalPath = path.join(directory, "Downloads", "input.txt");
  await writeText(externalPath, "input");
  const session = fakeSession({
    selections: ["Cancel save"],
    events: [
      {
        id: "user",
        type: "user.message",
        timestamp: "2026-08-01T20:00:00.000Z",
        data: { content: `Read \`${externalPath}\`.` },
      },
    ],
  });
  const commands = createCommands({
    session,
    cwd: directory,
    now: () => new Date(FIXED_DATE),
  });

  await commands.save(`--output "${outputDirectory}" --title "cancelled"`);

  assert.match(session.logs.at(-1).message, /save cancelled/i);
  assert.equal(await pathExists(outputDirectory), false);
});

test("reports a friendly error for a duplicate archive destination", async (t) => {
  const directory = await temporaryDirectory(t);
  const session = fakeSession();
  const commands = createCommands({
    session,
    cwd: directory,
    now: () => new Date(FIXED_DATE),
  });

  await commands.save(`--output "${directory}" --title "duplicate"`);

  await assert.rejects(
    commands.save(`--output "${directory}" --title "duplicate"`),
    /Archive destination already exists/,
  );
});

test("reports public attachment API failures explicitly", async (t) => {
  const directory = await temporaryDirectory(t);
  const archivePath = path.join(directory, "archive");
  await writeText(path.join(archivePath, "Session.md"), "session");
  await writeText(path.join(archivePath, "Handoff.md"), "handoff");
  await writeMetadata(archivePath, { formatVersion: 1 });
  const session = fakeSession({
    sendError: new Error("attachments unsupported"),
  });
  const commands = createCommands({ session, cwd: directory });

  await assert.rejects(
    commands.apply(`"${archivePath}"`),
    /public Copilot extension attachment API.*attachments unsupported/,
  );
});

test("does not create a success-shaped archive when handoff generation fails", async (t) => {
  const directory = await temporaryDirectory(t);
  const session = fakeSession({ handoff: "" });
  const commands = createCommands({
    session,
    cwd: directory,
    now: () => new Date(FIXED_DATE),
  });

  await assert.rejects(
    commands.save(`--output "${directory}" --title "failed"`),
    /did not return content/,
  );
  assert.deepEqual((await readdir(directory)).sort(), []);
});

test("preserves the original save error when cleanup also fails", async (t) => {
  const directory = await temporaryDirectory(t);
  const session = fakeSession({ handoff: "" });
  const commands = createCommands({
    session,
    cwd: directory,
    cleanupArchive: async () => {
      throw new Error("cleanup denied");
    },
  });

  await assert.rejects(
    commands.save(`--output "${directory}" --title "failed cleanup"`),
    /did not return content/,
  );
  assert.match(session.logs.at(-1).message, /cleanup denied/);
  assert.equal(session.logs.at(-1).options.level, "warning");
});
