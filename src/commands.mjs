import { mkdir, realpath, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  ARCHIVE_FORMAT_VERSION,
  createArchiveDirectory,
  listFilesRecursively,
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
import { renderSessionMarkdown } from "./session-export.mjs";
import { copySessionArtifacts } from "./session-files.mjs";
import { PLUGIN_VERSION } from "./version.mjs";

const execFileAsync = promisify(execFile);
const MAX_ATTACHMENT_FILES = 100;
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

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
    if (!parsed.username && !parsed.password) {
      return remote;
    }
    parsed.username = "";
    parsed.password = "";
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

function fileAttachment(archivePath, relativePath) {
  return {
    type: "file",
    path: path.join(archivePath, relativePath),
    displayName: relativePath,
  };
}

async function chooseExternalFiles(session, candidates) {
  if (candidates.length === 0) {
    return { approved: [], cancelled: false };
  }
  if (!session.capabilities?.ui?.elicitation) {
    await session.log(
      `Found ${candidates.length} external context file(s), but interactive confirmation is unavailable. No external files were copied.`,
      { level: "warning" },
    );
    return { approved: [], cancelled: false };
  }

  const INCLUDE = "Include this file";
  const SKIP = "Skip this file";
  const INCLUDE_ALL = "Include this and all remaining files";
  const SKIP_REMAINING = "Skip all remaining files";
  const CANCEL = "Cancel save";
  const approved = [];
  await session.log(
    [
      `Review ${candidates.length} external context file(s) before approving them:`,
      ...candidates.map(
        (candidate, index) =>
          `${index + 1}. ${candidate.resolvedPath} (${candidate.byteSize} bytes)`,
      ),
    ].join("\n"),
    { level: "info" },
  );
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const choice = await session.ui.select(
      [
        `Archive external context file ${index + 1} of ${candidates.length}?`,
        candidate.resolvedPath,
        `${candidate.byteSize} bytes`,
      ].join("\n"),
      [INCLUDE, SKIP, INCLUDE_ALL, SKIP_REMAINING, CANCEL],
    );
    if (choice === INCLUDE) {
      approved.push(candidate);
    } else if (choice === INCLUDE_ALL) {
      approved.push(...candidates.slice(index));
      break;
    } else if (choice === SKIP_REMAINING) {
      break;
    } else if (choice === CANCEL || choice === null) {
      return { approved: [], cancelled: true };
    } else if (choice !== SKIP) {
      throw new Error(`Unexpected external-file review choice: ${choice}`);
    }
  }
  return { approved, cancelled: false };
}

function attachmentIfPresent(archivePath, relativePath) {
  return pathExists(path.join(archivePath, relativePath)).then((exists) =>
    exists
      ? {
          type: "file",
          path: path.join(archivePath, relativePath),
          displayName: relativePath,
        }
      : undefined,
  );
}

async function collectArchiveAttachments(archivePath) {
  const coreAttachments = (
    await Promise.all([
      attachmentIfPresent(archivePath, "Handoff.md"),
      attachmentIfPresent(archivePath, "Session.md"),
      attachmentIfPresent(archivePath, "Metadata.json"),
    ])
  ).filter(Boolean);
  const additionalFiles = (
    await Promise.all(
      ["SessionState", "SessionFiles", "Context"].map((relativePath) =>
        listFilesRecursively(path.join(archivePath, relativePath)),
      ),
    )
  ).flat();
  return [
    ...coreAttachments,
    ...additionalFiles.map((filePath) => ({
      type: "file",
      path: filePath,
      displayName: path.relative(archivePath, filePath).split(path.sep).join("/"),
    })),
  ];
}

export function createCommands({
  session,
  cwd = process.cwd(),
  homeDirectory = os.homedir(),
  now = () => new Date(),
  cleanupArchive = removeIncompleteArchive,
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
          const promptedOutput = await inputIfAvailable(
            session,
            "Where should the Copilot Stash2D archive folder be created?",
            {
              title: "Copilot Stash2D",
              default: activeCwd,
            },
          );
          if (promptedOutput === null) {
            await session.log(
              "Copilot Stash2D save cancelled. No archive was created.",
              { level: "info" },
            );
            return;
          }
          outputDirectory = promptedOutput || activeCwd;
        }
        outputDirectory = path.resolve(
          activeCwd,
          expandHomePath(outputDirectory, homeDirectory),
        );

        const transcript = renderSessionMarkdown(snapshot.events);
        const candidates = await discoverExternalContextFiles(
          transcript,
          undefined,
          {
            baseDirectory: activeCwd,
            excludedRoots: [session.workspacePath],
            onWarning: (message) =>
              session.log(message, { level: "warning" }),
          },
        );
        const contextReview = await chooseExternalFiles(session, candidates);
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
          const sessionArtifacts = await copySessionArtifacts(
            session.workspacePath,
            archivePath,
          );
          if (sessionArtifacts.unavailable) {
            await session.log(
              "This Copilot session did not expose a public workspace path, so no plan or session files were available to archive.",
              { level: "warning" },
            );
          }
          const externalContext = await copyExternalContextFiles(
            contextReview.approved,
            archivePath,
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
              byteSize: Buffer.byteLength(planContent),
            });
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
          await session.log(
            "Copilot Stash2D is generating the session handoff. This can take up to 3 minutes; do not send another message or rerun the command.",
            { level: "info" },
          );
          const handoff = await generateDocument(
            session,
            HANDOFF_PROMPT,
            "Handoff.md",
            [
              fileAttachment(archivePath, "Session.md"),
              ...additionalContext,
            ],
          );
          await writeHandoff(archivePath, handoff);
          await writeMetadata(archivePath, {
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
          });
          await assertAttachmentBudget(
            await collectArchiveAttachments(archivePath),
            "Saved archive apply",
          );
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
      await validateArchive(archivePath);

      const attachments = await collectArchiveAttachments(archivePath);

      await assertAttachmentBudget(attachments, "Archive apply");
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
  };
}
