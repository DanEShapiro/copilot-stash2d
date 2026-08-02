import assert from "node:assert/strict";
import test from "node:test";
import { renderSessionMarkdown } from "../src/session-export.mjs";

test("renders main-session activity and omits subagent internals", () => {
  const events = [
    {
      id: "user",
      type: "user.message",
      timestamp: "2026-08-01T20:00:00.000Z",
      data: {
        content: "Investigate the API.",
        attachments: [
          { type: "file", path: "/tmp/input.txt", displayName: "input.txt" },
        ],
      },
    },
    {
      id: "assistant",
      type: "assistant.message",
      timestamp: "2026-08-01T20:01:00.000Z",
      data: {
        content: "I will inspect it.",
        toolRequests: [{ toolName: "view", arguments: { path: "/tmp/input.txt" } }],
      },
    },
    {
      id: "tool-start",
      type: "tool.execution_start",
      timestamp: "2026-08-01T20:02:00.000Z",
      data: {
        toolName: "view",
        toolCallId: "call",
        arguments: { path: "/tmp/input.txt" },
      },
    },
    {
      id: "tool-complete",
      type: "tool.execution_complete",
      timestamp: "2026-08-01T20:03:00.000Z",
      data: {
        toolCallId: "call",
        success: true,
        result: { content: "file contents" },
      },
    },
    {
      id: "subagent-message",
      type: "assistant.message",
      agentId: "research-agent",
      timestamp: "2026-08-01T20:04:00.000Z",
      data: { content: "internal subagent chatter", messageId: "subagent" },
    },
    {
      id: "subagent",
      type: "subagent.completed",
      timestamp: "2026-08-01T20:05:00.000Z",
      data: { agentName: "research", agentDisplayName: "Research", result: "done" },
    },
  ];

  const markdown = renderSessionMarkdown(events);
  assert.match(markdown, /Investigate the API/);
  assert.match(markdown, /input\.txt/);
  assert.match(markdown, /I will inspect it/);
  assert.match(markdown, /Tool started: view/);
  assert.match(markdown, /file contents/);
  assert.match(markdown, /subagent completed/);
  assert.doesNotMatch(markdown, /internal subagent chatter/);
});
