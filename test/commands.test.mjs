import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  archiveFolderName,
  pathExists,
  writeMetadata,
} from "../src/archive.mjs";
import {
  createCommands,
  sanitizeRemoteUrl,
} from "../src/commands.mjs";
import { fakeSession, temporaryDirectory, writeText } from "./helpers.mjs";

const FIXED_DATE = new Date(2026, 6, 31, 21, 36, 7);

test("removes credentials from repository remote URLs", () => {
  assert.equal(
    sanitizeRemoteUrl("https://user:token@github.com/org/repo.git"),
    "https://github.com/org/repo.git",
  );
  assert.equal(
    sanitizeRemoteUrl("git@github.com:org/repo.git"),
    "git@github.com:org/repo.git",
  );
  assert.equal(
    sanitizeRemoteUrl("ssh://git@github.com/org/repo.git"),
    "ssh://git@github.com/org/repo.git",
  );
  assert.equal(
    sanitizeRemoteUrl("ssh://alice:secret@host/repo.git"),
    "ssh://alice@host/repo.git",
  );
});

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
  assert.deepEqual(
    session.logs
      .filter((entry) => entry.options.level === "info")
      .map((entry) => entry.message),
    [
      "Copilot Stash2D save started. Wait for a saved-path confirmation or error before sending another message or running /stash2d-save again.",
      "Copilot Stash2D is reading the public session history.",
      "Copilot Stash2D is creating the archive files.",
      "Copilot Stash2D is generating the session handoff. This can take up to 3 minutes; do not send another message or rerun the command.",
      `Saved portable Copilot archive: ${archivePath}`,
    ],
  );
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

test("uses the session's current working directory after cwd changes", async (t) => {
  const directory = await temporaryDirectory(t);
  const initialDirectory = path.join(directory, "initial");
  const currentDirectory = path.join(directory, "current");
  const session = fakeSession({
    cwd: initialDirectory,
    metadataWorkingDirectory: currentDirectory,
  });
  const commands = createCommands({
    session,
    cwd: initialDirectory,
    now: () => new Date(FIXED_DATE),
  });

  await commands.save('--output "." --title "current cwd"');

  const archivePath = path.join(
    currentDirectory,
    archiveFolderName("current cwd", FIXED_DATE),
  );
  assert.equal(await pathExists(archivePath), true);
  const metadata = JSON.parse(
    await readFile(path.join(archivePath, "Metadata.json"), "utf8"),
  );
  assert.equal(metadata.workingDirectory, currentDirectory);
});

test("expands home-relative save paths", async (t) => {
  const directory = await temporaryDirectory(t);
  const homeDirectory = path.join(directory, "home");
  const session = fakeSession({ metadataWorkingDirectory: directory });
  const commands = createCommands({
    session,
    cwd: directory,
    homeDirectory,
    now: () => new Date(FIXED_DATE),
  });

  await commands.save('--output "~/stashes" --title "home path"');

  assert.equal(
    await pathExists(
      path.join(
        homeDirectory,
        "stashes",
        archiveFolderName("home path", FIXED_DATE),
      ),
    ),
    true,
  );
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
  assert.deepEqual(
    session.logs.map((entry) => entry.message),
    [
      `Copilot Stash2D is validating the archive: ${archivePath}`,
      "Copilot Stash2D is attaching 4 archive file(s).",
    ],
  );
});

test("applies home-relative archives from the current session directory", async (t) => {
  const directory = await temporaryDirectory(t);
  const homeDirectory = path.join(directory, "home");
  const currentDirectory = path.join(directory, "current");
  const archivePath = path.join(homeDirectory, "archives", "saved");
  await writeText(path.join(archivePath, "Session.md"), "session");
  await writeText(path.join(archivePath, "Handoff.md"), "handoff");
  await writeMetadata(archivePath, { formatVersion: 1 });
  const session = fakeSession({ metadataWorkingDirectory: currentDirectory });
  const commands = createCommands({
    session,
    cwd: path.join(directory, "initial"),
    homeDirectory,
  });

  await commands.apply('"~/archives/saved"');

  assert.match(session.sent[0].displayPrompt, /archives[\\/]saved/);
});

test("cancelling the apply prompt attaches no archive", async (t) => {
  const directory = await temporaryDirectory(t);
  const session = fakeSession({ inputs: [null] });
  const commands = createCommands({ session, cwd: directory });

  await commands.apply("");

  assert.match(session.logs.at(-1).message, /apply cancelled/i);
  assert.equal(session.sent.length, 0);
});

test("copies only explicitly approved external context during save", async (t) => {
  const directory = await temporaryDirectory(t);
  const externalPath = path.join(directory, "Downloads", "input.txt");
  await writeText(externalPath, "input");
  const session = fakeSession({
    elicitations: [{ action: "accept", content: { files: ["0"] } }],
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
  assert.match(
    session.elicitationRequests[0].requestedSchema.properties.files.items
      .anyOf[0].title,
    /input\.txt/,
  );
});

test("selects a small external-file subset with the multi-select chooser", async (t) => {
  const directory = await temporaryDirectory(t);
  const paths = [];
  for (let index = 0; index < 5; index += 1) {
    const filePath = path.join(directory, "Downloads", `${index}.txt`);
    await writeText(filePath, `${index}`);
    paths.push(filePath);
  }
  const session = fakeSession({
    elicitations: [{ action: "accept", content: { files: ["1", "4"] } }],
    events: [
      {
        type: "user.message",
        data: {
          content: paths.map((filePath) => `\`${filePath}\``).join(" "),
        },
      },
    ],
  });
  const commands = createCommands({
    session,
    cwd: directory,
    now: () => new Date(FIXED_DATE),
  });

  await commands.save(`--output "${directory}" --title "selected files"`);

  const contextPath = path.join(
    directory,
    archiveFolderName("selected files", FIXED_DATE),
    "Context",
  );
  assert.deepEqual((await readdir(contextPath)).sort(), [
    "001-1.txt",
    "002-4.txt",
  ]);
  assert.equal(session.elicitationRequests.length, 1);
  assert.equal(
    session.elicitationRequests[0].requestedSchema.properties.files.type,
    "array",
  );
});

test("selects a referenced directory as one grouped item", async (t) => {
  const directory = await temporaryDirectory(t);
  const source = path.join(directory, "reference");
  await writeText(path.join(source, "one.txt"), "one");
  await writeText(path.join(source, "nested", "two.txt"), "two");
  const session = fakeSession({
    elicitations: [{ action: "accept", content: { files: ["0"] } }],
    events: [
      {
        type: "user.message",
        data: { content: `Read every file in \`${source}\`.` },
      },
    ],
  });
  const commands = createCommands({
    session,
    cwd: directory,
    now: () => new Date(FIXED_DATE),
  });

  await commands.save(`--output "${directory}" --title "directory group"`);

  const archivePath = path.join(
    directory,
    archiveFolderName("directory group", FIXED_DATE),
  );
  assert.equal(
    await readFile(
      path.join(
        archivePath,
        "Context",
        "001-reference",
        "nested",
        "two.txt",
      ),
      "utf8",
    ),
    "two",
  );
  assert.match(
    session.elicitationRequests[0].requestedSchema.properties.files.items
      .anyOf[0].title,
    /2 files/,
  );
});

test("does not offer paths discovered only through tool execution", async (t) => {
  const directory = await temporaryDirectory(t);
  const internalPath = path.join(directory, "internal", "generated.txt");
  await writeText(internalPath, "internal");
  const session = fakeSession({
    events: [
      {
        type: "user.message",
        data: { content: "Investigate the build." },
      },
      {
        type: "tool.execution_start",
        data: {
          toolName: "view",
          arguments: { path: internalPath },
        },
      },
      {
        type: "tool.execution_complete",
        data: {
          success: true,
          result: { content: `Read ${internalPath}` },
        },
      },
    ],
  });
  const commands = createCommands({
    session,
    cwd: directory,
    now: () => new Date(FIXED_DATE),
  });

  await commands.save(`--output "${directory}" --title "user paths only"`);

  const archivePath = path.join(
    directory,
    archiveFolderName("user paths only", FIXED_DATE),
  );
  assert.equal(await pathExists(path.join(archivePath, "Context")), false);
  assert.equal(session.elicitationRequests.length, 0);
});

test("can cancel external context review without creating an archive", async (t) => {
  const directory = await temporaryDirectory(t);
  const externalPath = path.join(directory, "Downloads", "input.txt");
  await writeText(externalPath, "input");
  const session = fakeSession({
    elicitations: [{ action: "cancel" }],
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
    elicitations: [{ action: "cancel" }],
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

test("cancelling save title or destination prompts creates no archive", async (t) => {
  const directory = await temporaryDirectory(t);
  const titleSession = fakeSession({ inputs: [null] });
  await createCommands({ session: titleSession, cwd: directory }).save("");
  assert.match(titleSession.logs.at(-1).message, /save cancelled/i);
  assert.deepEqual(await readdir(directory), []);

  const outputSession = fakeSession({ inputs: ["prompted title", null] });
  await createCommands({ session: outputSession, cwd: directory }).save("");
  assert.match(outputSession.logs.at(-1).message, /save cancelled/i);
  assert.deepEqual(await readdir(directory), []);
});

test("uses safe defaults and skips external context without elicitation", async (t) => {
  const directory = await temporaryDirectory(t);
  const externalPath = path.join(directory, "external.txt");
  await writeText(externalPath, "external");
  const session = fakeSession({
    elicitation: false,
    metadataWorkingDirectory: directory,
    events: [
      {
        type: "user.message",
        data: { content: `Read \`${externalPath}\`.` },
      },
    ],
  });
  const commands = createCommands({
    session,
    cwd: path.join(directory, "initial"),
    now: () => new Date(FIXED_DATE),
  });

  await commands.save("");

  const archivePath = path.join(
    directory,
    archiveFolderName("session", FIXED_DATE),
  );
  assert.equal(await pathExists(archivePath), true);
  assert.equal(await pathExists(path.join(archivePath, "Context")), false);
  assert.match(
    session.logs.find(({ message }) =>
      message.includes("interactive confirmation is unavailable"),
    ).message,
    /No optional files were included/,
  );
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

test("does not start a second save while document generation is active", async (t) => {
  const directory = await temporaryDirectory(t);
  let releaseGeneration;
  let generationStarted;
  const generationGate = new Promise((resolve) => {
    releaseGeneration = resolve;
  });
  const started = new Promise((resolve) => {
    generationStarted = resolve;
  });
  const session = fakeSession({
    sendAndWait: async (message) => {
      generationStarted();
      await generationGate;
      return {
        data: {
          content:
            message.displayPrompt === "SessionState/plan.md"
              ? "# Plan"
              : "# Handoff",
        },
      };
    },
  });
  const commands = createCommands({
    session,
    cwd: directory,
    now: () => new Date(FIXED_DATE),
  });

  const firstSave = commands.save(
    `--output "${directory}" --title "single flight"`,
  );
  await started;
  await commands.save(
    `--output "${directory}" --title "duplicate flight"`,
  );
  releaseGeneration();
  await firstSave;

  assert.equal(
    session.logs.filter((entry) => /save is already running/.test(entry.message))
      .length,
    1,
  );
  assert.equal(
    await pathExists(
      path.join(directory, archiveFolderName("duplicate flight", FIXED_DATE)),
    ),
    false,
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

test("lets users select a bounded subset when apply exceeds attachment limits", async (t) => {
  const directory = await temporaryDirectory(t);
  const archivePath = path.join(directory, "archive");
  await writeText(path.join(archivePath, "Session.md"), "session");
  await writeText(path.join(archivePath, "Handoff.md"), "handoff");
  await writeMetadata(archivePath, { formatVersion: 1 });
  for (let index = 0; index < 98; index += 1) {
    await writeText(
      path.join(archivePath, "SessionFiles", `${index}.txt`),
      "content",
    );
  }
  const session = fakeSession({
    elicitations: [{ action: "accept", content: { files: ["0", "1"] } }],
  });
  const commands = createCommands({ session, cwd: directory });

  await commands.apply(`"${archivePath}"`);

  assert.equal(session.sent.length, 1);
  assert.deepEqual(
    session.sent[0].attachments.map((attachment) => attachment.displayName),
    ["Handoff.md", "Session.md", "Metadata.json", "SessionFiles/0.txt", "SessionFiles/1.txt"],
  );
});

test("applies only core files when an oversized archive is noninteractive", async (t) => {
  const directory = await temporaryDirectory(t);
  const archivePath = path.join(directory, "archive");
  await writeText(path.join(archivePath, "Session.md"), "session");
  await writeText(path.join(archivePath, "Handoff.md"), "handoff");
  await writeMetadata(archivePath, { formatVersion: 1 });
  for (let index = 0; index < 98; index += 1) {
    await writeText(
      path.join(archivePath, "SessionFiles", `${index}.txt`),
      "content",
    );
  }
  const session = fakeSession({ elicitation: false });
  const commands = createCommands({ session, cwd: directory });

  await commands.apply(`"${archivePath}"`);

  assert.deepEqual(
    session.sent[0].attachments.map((attachment) => attachment.displayName),
    ["Handoff.md", "Session.md", "Metadata.json"],
  );
  assert.match(
    session.logs.find(({ message }) =>
      message.includes("interactive confirmation is unavailable"),
    ).message,
    /No optional files were included/,
  );
});

test("saves archives with more files than the model attachment limit", async (t) => {
  const directory = await temporaryDirectory(t);
  const workspacePath = path.join(directory, "workspace");
  const outputDirectory = path.join(directory, "output");
  await writeText(path.join(workspacePath, "plan.md"), "# Existing plan");
  for (let index = 0; index < 100; index += 1) {
    await writeText(
      path.join(workspacePath, "files", `${index}.txt`),
      "content",
    );
  }
  const session = fakeSession({ workspacePath });
  const commands = createCommands({
    session,
    cwd: directory,
    now: () => new Date(FIXED_DATE),
  });

  await commands.save(
    `--output "${outputDirectory}" --title "oversized save"`,
  );

  const archivePath = path.join(
    outputDirectory,
    archiveFolderName("oversized save", FIXED_DATE),
  );
  assert.equal(
    (await readdir(path.join(archivePath, "SessionFiles"))).length,
    100,
  );
  assert.match(
    session.logs.find(({ message }) =>
      message.startsWith("Handoff generation omitted"),
    ).message,
    /optional file/,
  );
  assert.match(session.logs.at(-1).message, /Saved portable/);
});

test("rejects archive output inside the session files tree", async (t) => {
  const directory = await temporaryDirectory(t);
  const workspacePath = path.join(directory, "workspace");
  const outputDirectory = path.join(workspacePath, "files", "archives");
  await writeText(path.join(workspacePath, "files", "result.txt"), "result");
  const session = fakeSession({ workspacePath });
  const commands = createCommands({ session, cwd: directory });

  await assert.rejects(
    commands.save(
      `--output "${outputDirectory}" --title "recursive output"`,
    ),
    /output must not be inside the session files directory/,
  );
  assert.deepEqual(await readdir(outputDirectory), []);
  assert.equal(session.sent.length, 0);
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
