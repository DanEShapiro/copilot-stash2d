import assert from "node:assert/strict";
import test from "node:test";
import {
  renderExternalReferenceMarkdown,
  renderSessionMarkdown,
} from "../src/session-export.mjs";

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
  const markdown = renderExternalReferenceMarkdown([
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

test("external reference discovery ignores quoted Stash2D directory warnings", () => {
  const markdown = renderExternalReferenceMarkdown([
    {
      type: "user.message",
      data: {
        content: [
          "This appeared during my last save:",
          "",
          "Referenced directory C:\\Windows\\assembly exceeds the discovery safety limit of 200 files or 50 directories and was skipped.",
          "",
          "> Referenced directory Q:\\spocore exceeds the discovery safety limit of 200 files or 50 directories and was skipped.",
          "",
          "Keep `C:\\Users\\me\\notes.txt`.",
        ].join("\n"),
      },
    },
  ]);

  assert.doesNotMatch(markdown, /Windows\\assembly/);
  assert.doesNotMatch(markdown, /Q:\\spocore/);
  assert.match(markdown, /notes\.txt/);
});

test("external reference discovery ignores pasted code and shell transcripts", () => {
  const markdown = renderExternalReferenceMarkdown([
    {
      type: "user.message",
      data: {
        content: [
          "```powershell",
          "$roots = 'C:\\Packages'",
          "```",
          "> $searchRoots = @('C:\\Windows\\assembly')",
          "$otherRoots = @('C:\\Windows\\Microsoft.NET\\assembly')",
          "Please inspect `C:\\Users\\me\\notes.txt`.",
        ].join("\n"),
      },
    },
  ]);

  assert.doesNotMatch(markdown, /C:\\Packages/);
  assert.doesNotMatch(markdown, /Windows\\assembly/);
  assert.doesNotMatch(markdown, /Microsoft\.NET/);
  assert.match(markdown, /notes\.txt/);
});

test("external reference discovery ignores host skill context and command results", () => {
  const markdown = renderExternalReferenceMarkdown([
    {
      type: "user.message",
      data: {
        content: [
          '<skill-context name="generate-pr-description">',
          "Base directory for this skill: C:\\Users\\me\\.copilot\\skills\\generate-pr-description",
          "</skill-context>",
          "Microsoft.SharePoint.Client.dll => C:\\Windows\\Microsoft.NET\\assembly\\GAC_MSIL\\Microsoft.SharePoint.Client.dll",
          "I moved all our working files here: C:\\Users\\me\\Downloads\\work",
        ].join("\n"),
      },
    },
  ]);

  assert.doesNotMatch(markdown, /generate-pr-description/);
  assert.doesNotMatch(markdown, /Microsoft\.SharePoint\.Client\.dll/);
  assert.match(markdown, /Downloads\\work/);
});

test("external reference discovery ignores shell prompts and stack frames", () => {
  const markdown = renderExternalReferenceMarkdown([
    {
      type: "user.message",
      data: {
        content: [
          "PS C:\\src\\app> Get-Content C:\\Users\\me\\.ssh\\config",
          "C:\\src\\app> type C:\\secrets.txt",
          "$ cat /etc/shadow",
          "alice@host:/work$ cat /home/alice/token.txt",
          '  File "/home/me/app/creds.py", line 8, in load',
          "    at Object.<anonymous> (C:\\src\\app\\index.js:12:9)",
          "Please keep `C:\\Users\\me\\notes.txt`.",
        ].join("\n"),
      },
    },
  ]);

  assert.doesNotMatch(markdown, /\.ssh\\config/);
  assert.doesNotMatch(markdown, /secrets\.txt/);
  assert.doesNotMatch(markdown, /etc\/shadow/);
  assert.doesNotMatch(markdown, /token\.txt/);
  assert.doesNotMatch(markdown, /creds\.py/);
  assert.doesNotMatch(markdown, /index\.js/);
  assert.match(markdown, /notes\.txt/);
});
