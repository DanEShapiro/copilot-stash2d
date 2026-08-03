// Extension: copilot-stash2d
// Saves and applies portable, human-readable Copilot CLI session archives.

import { joinSession } from "@github/copilot-sdk/extension";
import { createCommands } from "../../src/commands.mjs";

let commands;
const session = await joinSession({
  commands: [
    {
      name: "stash2d-save",
      description:
        "Export and archive this session without requiring /share.",
      handler: async ({ args }) => {
        await runCommand(() => commands.save(args ?? ""));
      },
    },
    {
      name: "stash2d-apply",
      description:
        "Load a portable stash2d archive into this new session.",
      handler: async ({ args }) => {
        await runCommand(() => commands.apply(args ?? ""));
      },
    },
  ],
});

commands = createCommands({ session });

async function runCommand(action) {
  try {
    await action();
  } catch (error) {
    await session.log(
      `Copilot Stash2D: ${error instanceof Error ? error.message : String(error)}`,
      { level: "error" },
    );
  }
}
