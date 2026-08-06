import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  ARCHIVE_FORMAT_VERSION,
  copyArchiveSnapshotFiles,
  createArchiveDirectory,
  inspectArchive,
  listFilesRecursively,
  MAX_ARCHIVE_BYTES,
  MAX_ARCHIVE_DIRECTORIES,
  MAX_ARCHIVE_ENTRIES,
  pathExists,
  removeIncompleteArchive,
  validateArchive,
  writeHandoff,
  writeMetadata,
} from "./archive.mjs";
import {
  parseApplyArguments,
  parseSaveArguments,
} from "./arguments.mjs";
import {
  copyExternalContextFiles,
  discoverExternalContextFiles,
} from "./context-files.mjs";
import { APPLY_PROMPT, HANDOFF_PROMPT, PLAN_PROMPT } from "./prompts.mjs";
import {
  renderExternalReferences,
  renderSessionMarkdown,
} from "./session-export.mjs";
import { copySessionArtifacts } from "./session-files.mjs";
import { PLUGIN_VERSION } from "./version.mjs";
import {
  assertNoLinkedPathComponents,
} from "./secure-files.mjs";

const execFileAsync = promisify(execFile);
const MAX_ATTACHMENT_FILES = 100;
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const MAX_CHOOSER_ITEMS = 1000;
const MAX_GENERATED_FILE_BYTES = 1024 * 1024;
const MISSING_PLAN_USAGE = Object.freeze({
  entries: 2,
  directories: 1,
  bytes: MAX_GENERATED_FILE_BYTES,
});

function requiredArchiveUsage(transcriptBytes) {
  return {
    entries: 3,
    directories: 1,
    bytes: transcriptBytes + (2 * MAX_GENERATED_FILE_BYTES),
  };
}

async function requireDirectory(directoryPath) {
  let info;
  try {
    info = await stat(directoryPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`Archive directory does not exist: ${directoryPath}`);
    }
    throw error;
  }
  if (!info.isDirectory()) {
    throw new Error(`Archive path is not a directory: ${directoryPath}`);
  }
}

async function inputIfAvailable(session, message, options) {
  if (!session.capabilities?.ui?.elicitation) {
    return undefined;
  }
  return session.ui.input(message, options);
}

async function sessionSnapshot(session) {
  try {
    const events = await session.getEvents();
    const start = events.find(
      (event) => event.type === "session.start" && !event.agentId,
    );
    return { context: start?.data ?? {}, events };
  } catch (error) {
    throw new Error(
      `Copilot Stash2D could not export the public session event history. ${error.message}`,
    );
  }
}

async function currentWorkingDirectory(session, fallback) {
  try {
    const snapshot = await session.rpc?.metadata?.snapshot?.();
    if (snapshot?.workingDirectory) {
      return snapshot.workingDirectory;
    }
  } catch {
    // Older SDK versions may not expose metadata snapshots.
  }
  return fallback;
}

function expandHomePath(filePath, homeDirectory) {
  if (filePath === "~") {
    return homeDirectory;
  }
  if (filePath.startsWith("~/") || filePath.startsWith("~\\")) {
    return path.join(homeDirectory, filePath.slice(2));
  }
  return filePath;
}

export async function userDownloadsDirectory({
  homeDirectory = os.homedir(),
  platform = process.platform,
  env = process.env,
  readText = readFile,
} = {}) {
  const fallback = path.join(homeDirectory, "Downloads");
  if (platform !== "linux") {
    return fallback;
  }

  const configDirectory =
    env.XDG_CONFIG_HOME || path.join(homeDirectory, ".config");
  try {
    const config = await readText(
      path.join(configDirectory, "user-dirs.dirs"),
      "utf8",
    );
    const match = config.match(
      /^XDG_DOWNLOAD_DIR=(?:"([^"]*)"|'([^']*)'|(\S+))\s*$/m,
    );
    const configured = match?.[1] ?? match?.[2] ?? match?.[3];
    if (!configured) {
      return fallback;
    }
    const expanded = configured
      .replaceAll("${HOME}", homeDirectory)
      .replaceAll("$HOME", homeDirectory);
    return path.isAbsolute(expanded)
      ? path.normalize(expanded)
      : path.resolve(homeDirectory, expanded);
  } catch {
    return fallback;
  }
}

async function repositoryMetadata(workingDirectory) {
  let root;
  try {
    const result = await execFileAsync(
      "git",
      ["-C", workingDirectory, "rev-parse", "--show-toplevel"],
      { timeout: 5000 },
    );
    root = result.stdout.trim() || undefined;
  } catch {
    return undefined;
  }

  async function gitValue(args) {
    try {
      const result = await execFileAsync(
        "git",
        ["-C", root, ...args],
        { timeout: 5000 },
      );
      return result.stdout.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  try {
    return {
      root,
      remote: sanitizeRemoteUrl(
        await gitValue(["remote", "get-url", "origin"]),
      ),
      branch: await gitValue(["branch", "--show-current"]),
      commit: await gitValue(["rev-parse", "HEAD"]),
    };
  } catch {
    return { root };
  }
}

export function sanitizeRemoteUrl(remote) {
  if (!remote) {
    return remote;
  }
  try {
    const parsed = new URL(remote);
    const isHttp = ["http:", "https:"].includes(parsed.protocol);
    if (!parsed.password && !(isHttp && parsed.username)) {
      return remote;
    }
    parsed.password = "";
    if (isHttp) {
      parsed.username = "";
    }
    return parsed.toString();
  } catch {
    return remote;
  }
}

async function assertOutputOutsideSessionFiles(outputDirectory, workspacePath) {
  if (!workspacePath) {
    return;
  }
  const sessionFilesPath = path.join(workspacePath, "files");
  if (!(await pathExists(sessionFilesPath))) {
    return;
  }
  const [sourceRoot, outputRoot] = await Promise.all([
    realpath(sessionFilesPath),
    realpath(outputDirectory),
  ]);
  const relative = path.relative(sourceRoot, outputRoot);
  if (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  ) {
    throw new Error(
      `Archive output must not be inside the session files directory: ${sessionFilesPath}`,
    );
  }
}

async function generateDocument(session, prompt, displayPrompt, attachments) {
  await assertAttachmentBudget(attachments, displayPrompt);
  const response = await session.sendAndWait(
    {
      prompt,
      displayPrompt,
      attachments,
    },
    180000,
  );
  const content = response?.data?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error(`Copilot did not return content for ${displayPrompt}.`);
  }
  return content;
}

async function assertAttachmentBudget(attachments, operation) {
  if (attachments.length > MAX_ATTACHMENT_FILES) {
    throw new Error(
      `${operation} requires ${attachments.length} attachments; the Stash2D safety limit is ${MAX_ATTACHMENT_FILES}. Remove nonessential session or context files and retry.`,
    );
  }
  let totalBytes = 0;
  for (const attachment of attachments) {
    totalBytes += (await stat(attachment.path)).size;
  }
  if (totalBytes > MAX_ATTACHMENT_BYTES) {
    throw new Error(
      `${operation} requires ${totalBytes} attachment bytes; the Stash2D safety limit is ${MAX_ATTACHMENT_BYTES}. Remove nonessential session or context files and retry.`,
    );
  }
}

async function attachmentBudget(attachments) {
  let bytes = 0;
  for (const attachment of attachments) {
    bytes += (await stat(attachment.path)).size;
  }
  return { files: attachments.length, bytes };
}

async function boundedAttachments(required, optional, operation) {
  await assertAttachmentBudget(required, operation);
  const usage = await attachmentBudget(required);
  const included = [];
  const omitted = [];
  let includedBytes = 0;
  for (const attachment of optional) {
    const byteSize = (await stat(attachment.path)).size;
    if (
      usage.files + included.length + 1 <= MAX_ATTACHMENT_FILES &&
      usage.bytes + includedBytes + byteSize <= MAX_ATTACHMENT_BYTES
    ) {
      included.push({ attachment, byteSize });
      includedBytes += byteSize;
    } else {
      omitted.push(attachment);
    }
  }
  return {
    attachments: [
      ...required,
      ...included.map((item) => item.attachment),
    ],
    omitted,
  };
}

function fileAttachment(archivePath, relativePath) {
  return {
    type: "file",
    path: path.join(archivePath, relativePath),
    displayName: relativePath,
  };
}

function candidateUsage(candidates) {
  return {
    files: candidates.reduce(
      (total, candidate) => total + (candidate.fileCount ?? 1),
      0,
    ),
    bytes: candidates.reduce(
      (total, candidate) => total + candidate.byteSize,
      0,
    ),
  };
}

export function remainingContextBudget({
  hasPlan,
  sessionUsage,
  transcriptBytes,
}) {
  const requiredUsage = requiredArchiveUsage(transcriptBytes);
  const planUsage = hasPlan
    ? { entries: 0, directories: 0, bytes: 0 }
    : MISSING_PLAN_USAGE;
  return {
    entries:
      MAX_ARCHIVE_ENTRIES -
      requiredUsage.entries -
      sessionUsage.entries -
      planUsage.entries,
    directories:
      MAX_ARCHIVE_DIRECTORIES -
      requiredUsage.directories -
      sessionUsage.directories -
      planUsage.directories,
    bytes:
      MAX_ARCHIVE_BYTES -
      requiredUsage.bytes -
      sessionUsage.bytes -
      planUsage.bytes,
  };
}

function assertGeneratedFileBudget(content, label, archiveBytes) {
  const byteSize = Buffer.byteLength(content);
  if (byteSize > MAX_GENERATED_FILE_BYTES) {
    throw new Error(
      `${label} exceeds the safety limit of ${MAX_GENERATED_FILE_BYTES} bytes.`,
    );
  }
  if (archiveBytes + byteSize > MAX_ARCHIVE_BYTES) {
    throw new Error(
      `${label} would exceed the archive safety limit of ${MAX_ARCHIVE_BYTES} bytes.`,
    );
  }
  return byteSize;
}

function fitsCandidateBudget(candidates, maxFiles, maxBytes) {
  const usage = candidateUsage(candidates);
  return usage.files <= maxFiles && usage.bytes <= maxBytes;
}

async function chooseFiles(
  session,
  candidates,
  {
    description = "external context",
    maxFiles = Number.POSITIVE_INFINITY,
    maxBytes = Number.POSITIVE_INFINITY,
  } = {},
) {
  if (candidates.length === 0) {
    return { approved: [], cancelled: false };
  }
  if (candidates.length > MAX_CHOOSER_ITEMS) {
    throw new Error(
      `The file chooser safety limit is ${MAX_CHOOSER_ITEMS} items; ${candidates.length} items were offered.`,
    );
  }
  if (!session.capabilities?.ui?.elicitation) {
    await session.log(
      `Found ${candidates.length} ${description} file(s), but interactive confirmation is unavailable. No optional files were included.`,
      { level: "warning" },
    );
    return { approved: [], cancelled: false };
  }

  while (true) {
    const result = await session.ui.elicitation({
      message: `Select the ${description} files and directory groups to include. Leave everything unselected to include none.`,
      requestedSchema: {
        type: "object",
        properties: {
          files: {
            type: "array",
            title: `${candidates.length} ${description} item(s)`,
            description:
              "Use the multi-select list to toggle any files or directory groups you want to preserve.",
            items: {
              anyOf: candidates.map((candidate, index) => {
                const fileCount = candidate.fileCount ?? 1;
                const size =
                  fileCount === 1
                    ? `${candidate.byteSize} bytes`
                    : `${fileCount} files, ${candidate.byteSize} bytes`;
                return {
                  const: String(index),
                  title: `${candidate.label} (${size})`,
                };
              }),
            },
            default: [],
          },
        },
        required: ["files"],
      },
    });
    if (result.action !== "accept") {
      return { approved: [], cancelled: true };
    }
    const selected = result.content?.files;
    if (!Array.isArray(selected)) {
      throw new Error("The file chooser returned an invalid selection.");
    }
    const approved = selected.map((value) => {
      const index = Number(value);
      if (!Number.isInteger(index) || !candidates[index]) {
        throw new Error("The file chooser returned an unknown item.");
      }
      return candidates[index];
    });
    if (!fitsCandidateBudget(approved, maxFiles, maxBytes)) {
      await session.log(
        `That selection exceeds the available attachment budget of ${maxFiles} file(s) and ${maxBytes} bytes. Select fewer files or directory groups.`,
        { level: "warning" },
      );
      continue;
    }
    return { approved, cancelled: false };
  }
}

async function withApplySnapshot(
  archivePath,
  sourceAttachments,
  callback,
  { onCleanupError = async () => {} } = {},
) {
  let snapshotRoot;
  try {
    snapshotRoot = await mkdtemp(
      path.join(os.tmpdir(), "copilot-stash2d-apply-"),
    );
    await chmod(snapshotRoot, 0o700);
    const snapshotPath = path.join(snapshotRoot, "archive");
    await copyArchiveSnapshotFiles(
      archivePath,
      snapshotPath,
      sourceAttachments,
    );
    await validateArchive(snapshotPath);
    const snapshotAttachments = sourceAttachments.map((attachment) => ({
      type: "file",
      path: path.join(
        snapshotPath,
        ...attachment.displayName.split("/"),
      ),
      displayName: attachment.displayName,
    }));
    return await callback(snapshotAttachments);
  } finally {
    if (snapshotRoot) {
      try {
        await rm(snapshotRoot, { recursive: true, force: true });
      } catch (cleanupError) {
        try {
          await onCleanupError(cleanupError);
        } catch {
          // Cleanup reporting must not mask a successful send or primary error.
        }
      }
    }
  }
}

function sourceAttachment(entry) {
  return {
    type: "file",
    path: entry.sourcePath,
    displayName: entry.relativePath,
    identity: entry.identity,
  };
}

function collectArchiveAttachmentGroups(archiveEntries) {
  const fileEntries = archiveEntries.filter((entry) => entry.type === "file");
  const coreNames = new Set(["Handoff.md", "Session.md", "Metadata.json"]);
  const coreAttachments = fileEntries
    .filter((entry) => coreNames.has(entry.relativePath))
    .sort(
      (left, right) =>
        ["Handoff.md", "Session.md", "Metadata.json"].indexOf(
          left.relativePath,
        ) -
        ["Handoff.md", "Session.md", "Metadata.json"].indexOf(
          right.relativePath,
        ),
    )
    .map(sourceAttachment);
  const groups = new Map();
  for (const entry of fileEntries) {
    if (coreNames.has(entry.relativePath)) {
      continue;
    }
    const segments = entry.relativePath.split("/");
    if (
      !["SessionState", "SessionFiles", "Context"].includes(segments[0])
    ) {
      continue;
    }
    const label = segments.slice(0, Math.min(2, segments.length)).join("/");
    const attachments = groups.get(label) ?? [];
    attachments.push(sourceAttachment(entry));
    groups.set(label, attachments);
  }
  const optionalCandidates = [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([label, attachments]) => ({
      label,
      fileCount: attachments.length,
      byteSize: attachments.reduce(
        (total, attachment) =>
          total + attachment.identity.byteSize,
        0,
      ),
      payload: attachments.sort((left, right) =>
        left.displayName.localeCompare(right.displayName),
      ),
    }));
  return {
    core: coreAttachments,
    optional: optionalCandidates.flatMap(
      (candidate) => candidate.payload,
    ),
    optionalCandidates,
  };
}

async function splitOversizedCandidates(candidates, maxFiles, maxBytes) {
  const selectable = [];
  for (const candidate of candidates) {
    if (selectable.length >= MAX_CHOOSER_ITEMS) {
      throw new Error(
        `Archive has more than ${MAX_CHOOSER_ITEMS} selectable optional items. Reduce or regroup the archive before applying it.`,
      );
    }
    if (
      candidate.fileCount <= maxFiles &&
      candidate.byteSize <= maxBytes
    ) {
      selectable.push(candidate);
      continue;
    }
    for (const attachment of candidate.payload) {
      if (selectable.length >= MAX_CHOOSER_ITEMS) {
        throw new Error(
          `Archive has more than ${MAX_CHOOSER_ITEMS} individually selectable optional files. Reduce or regroup the archive before applying it.`,
        );
      }
      selectable.push({
        label: attachment.displayName,
        fileCount: 1,
        byteSize: attachment.identity.byteSize,
        payload: [attachment],
      });
    }
  }
  return selectable;
}

export function createCommands({
  session,
  cwd = process.cwd(),
  homeDirectory = os.homedir(),
  now = () => new Date(),
  cleanupArchive = removeIncompleteArchive,
  resolveDownloadsDirectory = userDownloadsDirectory,
} = {}) {
  if (!session) {
    throw new Error("A Copilot session is required.");
  }
  let saveInProgress = false;

  return {
    async save(rawArguments) {
      if (saveInProgress) {
        await session.log(
          "A Copilot Stash2D save is already running. Wait for its saved-path confirmation or error before trying again.",
          { level: "warning" },
        );
        return;
      }
      saveInProgress = true;
      try {
        let { outputDirectory, title } = parseSaveArguments(rawArguments);
        await session.log(
          "Copilot Stash2D save started. Wait for a saved-path confirmation or error before sending another message or running /stash2d-save again.",
          { level: "info" },
        );
        await session.log(
          "Copilot Stash2D is reading the public session history.",
          { level: "info" },
        );
        const activeCwd = await currentWorkingDirectory(session, cwd);
        const snapshot = await sessionSnapshot(session);
        if (!title) {
          const promptedTitle = await inputIfAvailable(
            session,
            "Name this Copilot session archive",
            {
              title: "Copilot Stash2D",
              default: "session",
            },
          );
          if (promptedTitle === null) {
            await session.log(
              "Copilot Stash2D save cancelled. No archive was created.",
              { level: "info" },
            );
            return;
          }
          title = promptedTitle || "session";
        }
        if (!outputDirectory) {
          const defaultOutputDirectory = await resolveDownloadsDirectory({
            homeDirectory,
          });
          const promptedOutput = await inputIfAvailable(
            session,
            "Where should the Copilot Stash2D archive folder be created?",
            {
              title: "Copilot Stash2D",
              default: defaultOutputDirectory,
            },
          );
          if (promptedOutput === null) {
            await session.log(
              "Copilot Stash2D save cancelled. No archive was created.",
              { level: "info" },
            );
            return;
          }
          outputDirectory = promptedOutput || defaultOutputDirectory;
        }
        outputDirectory = path.resolve(
          activeCwd,
          expandHomePath(outputDirectory, homeDirectory),
        );

        const transcript = renderSessionMarkdown(snapshot.events);
        const externalReferences = renderExternalReferences(
          snapshot.events,
        );
        const candidates = await discoverExternalContextFiles(
          externalReferences.messageMarkdown,
          undefined,
          {
            attachmentReferences:
              externalReferences.attachmentReferences,
            baseDirectory: activeCwd,
            excludedRoots: [session.workspacePath],
            onWarning: (message) =>
              session.log(message, { level: "warning" }),
          },
        );
        const contextReview = await chooseFiles(
          session,
          candidates.map((candidate) => ({
            label: candidate.resolvedPath,
            fileCount: candidate.fileCount,
            byteSize: candidate.byteSize,
            payload: candidate,
          })),
        );
        if (contextReview.cancelled) {
          await session.log("Copilot Stash2D save cancelled. No archive was created.", {
            level: "info",
          });
          return;
        }
        await session.log(
          "Copilot Stash2D is creating the archive files.",
          { level: "info" },
        );
        const createdAt = now();
        await mkdir(outputDirectory, { recursive: true });
        await assertOutputOutsideSessionFiles(
          outputDirectory,
          session.workspacePath,
        );
        const archivePath = await createArchiveDirectory(
          outputDirectory,
          title,
          createdAt,
        );

        try {
          await writeFile(path.join(archivePath, "Session.md"), transcript, "utf8");
          const transcriptBytes = Buffer.byteLength(transcript);
          const sessionArtifacts = await copySessionArtifacts(
            session.workspacePath,
            archivePath,
            {
              missingPlanUsage: MISSING_PLAN_USAGE,
              reservedUsage: requiredArchiveUsage(transcriptBytes),
            },
          );
          if (sessionArtifacts.unavailable) {
            await session.log(
              "This Copilot session did not expose a public workspace path, so no plan or session files were available to archive.",
              { level: "warning" },
            );
          }
          const contextBudget = remainingContextBudget({
            hasPlan: sessionArtifacts.hasPlan,
            sessionUsage: sessionArtifacts.usage,
            transcriptBytes,
          });
          if (
            contextBudget.entries < 0 ||
            contextBudget.directories < 0 ||
            contextBudget.bytes < 0
          ) {
            throw new Error(
              "Session transcript and artifacts leave no room for the required archive files within the archive safety limits.",
            );
          }
          const externalContext = await copyExternalContextFiles(
            contextReview.approved.map((item) => item.payload),
            archivePath,
            {
              maxBytes: contextBudget.bytes,
              maxDirectories: contextBudget.directories,
              maxEntries: contextBudget.entries,
              onWarning: (message) =>
                session.log(message, { level: "warning" }),
            },
          );
          let archiveBytes =
            transcriptBytes +
            sessionArtifacts.usage.bytes +
            externalContext.reduce(
              (total, entry) => total + entry.byteSize,
              0,
            );
          const sourceAttachments = [fileAttachment(archivePath, "Session.md")];
          if (!sessionArtifacts.hasPlan) {
            await session.log(
              "Copilot Stash2D is generating a continuation plan. This can take up to 3 minutes; do not send another message or rerun the command.",
              { level: "info" },
            );
            const generatedPlan = await generateDocument(
              session,
              PLAN_PROMPT,
              "SessionState/plan.md",
              sourceAttachments,
            );
            const planContent = `${generatedPlan.trim()}\n`;
            const planBytes = assertGeneratedFileBudget(
              planContent,
              "Generated continuation plan",
              archiveBytes,
            );
            await mkdir(path.join(archivePath, "SessionState"), {
              recursive: true,
            });
            await writeFile(
              path.join(archivePath, "SessionState", "plan.md"),
              planContent,
              "utf8",
            );
            sessionArtifacts.entries.push({
              role: "generated-plan",
              archivedPath: "SessionState/plan.md",
              byteSize: planBytes,
            });
            archiveBytes += planBytes;
          }
          const additionalContext = (
            await Promise.all(
              ["SessionState", "SessionFiles", "Context"].map((relativePath) =>
                listFilesRecursively(path.join(archivePath, relativePath)),
              ),
            )
          )
            .flat()
            .map((filePath) => ({
              type: "file",
              path: filePath,
              displayName: path
                .relative(archivePath, filePath)
                .split(path.sep)
                .join("/"),
            }));
          const handoffAttachments = await boundedAttachments(
            [fileAttachment(archivePath, "Session.md")],
            additionalContext,
            "Handoff generation",
          );
          if (handoffAttachments.omitted.length > 0) {
            await session.log(
              `Handoff generation omitted ${handoffAttachments.omitted.length} optional file(s) from model attachments to stay within the ${MAX_ATTACHMENT_FILES}-file and ${MAX_ATTACHMENT_BYTES}-byte limits. The files remain preserved in the local archive.`,
              { level: "warning" },
            );
          }
          await session.log(
            "Copilot Stash2D is generating the session handoff. This can take up to 3 minutes; do not send another message or rerun the command.",
            { level: "info" },
          );
          const handoff = await generateDocument(
            session,
            HANDOFF_PROMPT,
            "Handoff.md",
            handoffAttachments.attachments,
          );
          const handoffContent = `${handoff.trim()}\n`;
          archiveBytes += assertGeneratedFileBudget(
            handoffContent,
            "Generated handoff",
            archiveBytes,
          );
          await writeHandoff(archivePath, handoff);
          const metadata = {
            formatVersion: ARCHIVE_FORMAT_VERSION,
            pluginVersion: PLUGIN_VERSION,
            title,
            createdAt: createdAt.toISOString(),
            sessionSource: "public-session-events",
            sessionEventCount: snapshot.events.length,
            workingDirectory: activeCwd,
            repository: await repositoryMetadata(activeCwd),
            sessionArtifacts: sessionArtifacts.entries,
            externalContext,
          };
          const metadataContent = `${JSON.stringify(metadata, null, 2)}\n`;
          assertGeneratedFileBudget(
            metadataContent,
            "Archive metadata",
            archiveBytes,
          );
          await writeMetadata(archivePath, metadata);
          await validateArchive(archivePath);
        } catch (error) {
          try {
            await cleanupArchive(archivePath);
          } catch (cleanupError) {
            await session.log(
              [
                `Copilot Stash2D could not remove incomplete archive: ${archivePath}`,
                cleanupError instanceof Error
                  ? cleanupError.message
                  : String(cleanupError),
              ].join("\n"),
              { level: "warning" },
            );
          }
          throw error;
        }

        await session.log(
          `Saved portable Copilot archive: ${archivePath}`,
          { level: "info" },
        );
      } finally {
        saveInProgress = false;
      }
    },

    async apply(rawArguments) {
      let archivePath = parseApplyArguments(rawArguments);
      const activeCwd = await currentWorkingDirectory(session, cwd);
      if (!archivePath) {
        const promptedArchive = await inputIfAvailable(
          session,
          "Choose a Copilot Stash2D archive folder",
          {
            title: "Apply Copilot Stash2D archive",
          },
        );
        if (promptedArchive === null) {
          await session.log(
            "Copilot Stash2D apply cancelled. No archive was attached.",
            { level: "info" },
          );
          return;
        }
        archivePath = promptedArchive;
      }
      if (!archivePath) {
        throw new Error(
          "Usage: /stash2d-apply <archive-folder>",
        );
      }
      archivePath = path.resolve(
        activeCwd,
        expandHomePath(archivePath, homeDirectory),
      );
      await session.log(
        `Copilot Stash2D is validating the archive: ${archivePath}`,
        { level: "info" },
      );
      await requireDirectory(archivePath);
      await assertNoLinkedPathComponents(archivePath);
      const inspection = await inspectArchive(archivePath);
      const groups = collectArchiveAttachmentGroups(inspection.entries);
      await assertAttachmentBudget(groups.core, "Archive apply core");
      const coreUsage = await attachmentBudget(groups.core);
      let optionalAttachments = groups.optional;
      const bounded = await boundedAttachments(
        groups.core,
        groups.optional,
        "Archive apply core",
      );
      if (bounded.omitted.length > 0) {
        const maxFiles = MAX_ATTACHMENT_FILES - coreUsage.files;
        const maxBytes = MAX_ATTACHMENT_BYTES - coreUsage.bytes;
        const selectableCandidates = await splitOversizedCandidates(
          groups.optionalCandidates,
          maxFiles,
          maxBytes,
        );
        const review = await chooseFiles(session, selectableCandidates, {
          description: "optional archive",
          maxFiles,
          maxBytes,
        });
        if (review.cancelled) {
          await session.log(
            "Copilot Stash2D apply cancelled. No archive was attached.",
            { level: "info" },
          );
          return;
        }
        optionalAttachments = review.approved.flatMap(
          (candidate) => candidate.payload,
        );
      }
      const sourceAttachments = [...groups.core, ...optionalAttachments];
      await assertAttachmentBudget(sourceAttachments, "Archive apply");
      await withApplySnapshot(
        archivePath,
        sourceAttachments,
        async (attachments) => {
          try {
            await session.log(
              `Copilot Stash2D is attaching ${attachments.length} archive file(s).`,
              { level: "info" },
            );
            await session.send({
              prompt: APPLY_PROMPT,
              displayPrompt: `Apply Copilot Stash2D archive: ${archivePath}`,
              attachments,
            });
          } catch (error) {
            throw new Error(
              `The public Copilot extension attachment API could not apply this archive. Check the Copilot CLI and plugin versions. ${error.message}`,
            );
          }
        },
        {
          onCleanupError: (error) =>
            session.log(
              `Copilot Stash2D could not remove its private apply snapshot. ${error.message}`,
              { level: "warning" },
            ),
        },
      );
    },
  };
}
