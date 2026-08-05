import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "copilot-stash2d-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

export async function writeText(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

export function fakeSession(overrides = {}) {
  const logs = [];
  const sent = [];
  const inputRequests = [];
  const elicitationRequests = [];
  const inputs = [...(overrides.inputs ?? [])];
  const elicitations = [...(overrides.elicitations ?? [])];

  return {
    logs,
    sent,
    inputRequests,
    elicitationRequests,
    workspacePath: overrides.workspacePath,
    rpc: {
      metadata: {
        snapshot: async () => ({
          workingDirectory: overrides.metadataWorkingDirectory,
        }),
      },
    },
    capabilities: {
      ui: { elicitation: overrides.elicitation ?? true },
    },
    ui: {
      elicitation: async (params) => {
        elicitationRequests.push(params);
        return elicitations.shift() ?? { action: "cancel" };
      },
      input: async (message, options) => {
        inputRequests.push({ message, options });
        return inputs.shift() ?? null;
      },
    },
    log: async (message, options) => {
      logs.push({ message, options });
    },
    getEvents: async () =>
      overrides.events ?? [
        {
          type: "session.start",
          parentId: null,
          timestamp: "2026-07-31T20:00:00.000Z",
          data: { cwd: overrides.cwd ?? process.cwd() },
        },
      ],
    sendAndWait: async (message) => {
      sent.push(message);
      if (overrides.sendAndWait) {
        return overrides.sendAndWait(message);
      }
      return {
        data: {
          content:
            message.displayPrompt === "SessionState/plan.md"
              ? overrides.plan ??
                "# Plan\n\n## Remaining Steps\n\n1. Continue the archived work.\n"
              : overrides.handoff ??
                "# Handoff\n\n## Goal\nContinue the archived work.\n",
        },
      };
    },
    send: async (message) => {
      if (overrides.sendError) {
        throw overrides.sendError;
      }
      sent.push(message);
      return "message-id";
    },
  };
}
