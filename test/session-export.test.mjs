import assert from "node:assert/strict";
import test from "node:test";
import {
  renderExternalReferences,
  renderSessionMarkdown,
} from "../src/session-export.mjs";

function renderUserReferenceMarkdown(events) {
  return renderExternalReferences(events).messageMarkdown;
}

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

test("external reference discovery uses only user-authored content", () => {
  const markdown = renderUserReferenceMarkdown([
    {
      type: "user.message",
      data: { content: "Keep `/tmp/user.txt`." },
    },
    {
      type: "assistant.message",
      data: { content: "Internal `/usr/lib/python/internal.py`." },
    },
    {
      type: "tool.execution_start",
      data: { arguments: { path: "/tmp/tool.txt" } },
    },
    {
      type: "tool.execution_complete",
      data: {
        result: {
          content: "Traceback in /usr/lib/python/site-packages/runtime.py",
        },
      },
    },
  ]);

  assert.match(markdown, /user\.txt/);
  assert.doesNotMatch(markdown, /tool\.txt/);
  assert.doesNotMatch(markdown, /python/);
});

test("external reference discovery preserves user-provided content", () => {
  const markdown = renderUserReferenceMarkdown([
    {
      type: "user.message",
      data: {
        content: [
          "# Include `/tmp/heading.txt` in the archive",
          "```sh",
          "cat /tmp/pasted-code.txt",
          "```",
          "PS C:\\src> Get-Content C:\\Users\\me\\notes.txt",
        ].join("\n"),
      },
    },
  ]);

  assert.match(markdown, /\/tmp\/heading\.txt/);
  assert.match(markdown, /\/tmp\/pasted-code\.txt/);
  assert.match(markdown, /Users\\me\\notes\.txt/);
});

test("external reference discovery preserves complete user messages", () => {
  const markdown = renderUserReferenceMarkdown([
    {
      type: "user.message",
      data: {
        content: [
          '<skill-context name="example">',
          "Base directory: C:\\host\\skill",
          "</skill-context>",
          "Keep `C:\\Users\\me\\notes.txt`.",
        ].join("\n"),
      },
    },
  ]);

  assert.match(markdown, /host\\skill/);
  assert.match(markdown, /Users\\me\\notes\.txt/);
});

test("external references preserve structured attachment paths", () => {
  const references = renderExternalReferences([
    {
      type: "user.message",
      data: {
        content: "Review the attachment.",
        attachments: [{ type: "file", path: "\\\\server\\share\\folder" }],
      },
    },
  ]);

  assert.deepEqual(references.attachmentReferences, [
    { path: "\\\\server\\share\\folder", source: "attachment" },
  ]);
});
