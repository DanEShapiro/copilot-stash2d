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

test("external reference discovery preserves Markdown links", () => {
  const markdown = renderUserReferenceMarkdown([
    {
      type: "user.message",
      data: {
        content: "[Archive this file](/tmp/link.txt)",
      },
    },
  ]);

  assert.match(markdown, /\/tmp\/link\.txt/);
});

test("external reference discovery preserves user Markdown headings", () => {
  const markdown = renderUserReferenceMarkdown([
    {
      type: "user.message",
      data: {
        content: "# Include `/tmp/heading.txt` in the archive",
      },
    },
  ]);

  assert.match(markdown, /\/tmp\/heading\.txt/);
});

test("root shell filtering preserves descriptive headings", () => {
  const markdown = renderUserReferenceMarkdown([
    {
      type: "user.message",
      data: {
        content: [
          "# Git configuration: include /tmp/git-config",
          "# Docker notes for /tmp/container.txt",
          "# archive /tmp/project for later",
          "# input/output files include C:\\outside\\report.txt",
          "# Files: include /tmp/a & /tmp/b",
          "# Archive `/tmp/c` & `/tmp/d`",
          "# archive `/tmp/e` & `/tmp/f`",
          "# input/output files include C:\\outside\\a & C:\\outside\\b",
          "# `/tmp/path-only.txt`",
          "# Build output: /tmp/build.log",
          "# Project plan at C:\\work\\plan.md",
          "# files to archive /tmp/lowercase-heading.txt",
          "# project files include /tmp/project-heading.txt",
          "# Git files to include /tmp/git-heading.txt",
          "# Read C:\\work\\input.txt for context",
          "# Cat photos from C:\\photos\\cats",
          "# files at /tmp/files-heading.txt",
          "# output in /tmp/output-heading.txt",
          "# artifacts in /tmp/artifacts-heading.txt",
          "# git configuration: include /tmp/lowercase-git-config",
          "# Include `/tmp/My Report.txt` in the archive",
          '# Files: include "/tmp/a one.txt" & "/tmp/b two.txt"',
          '# Include "/tmp/a;b.txt" in the archive',
          "# Include `/tmp/report|final.txt` in the archive",
          "# Include [the report](/tmp/report.md) in the archive",
          "# Include [the R&D report](/tmp/R&D.md) in the archive",
          "# Include /tmp/list-one & /tmp/list-two in the archive",
          "# Include [A](/tmp/link-one) & [B](/tmp/link-two)",
          "# [win](C:\\Windows\\win.ini) & [system](C:\\Windows\\system.ini)",
          "# **[styled report](/tmp/styled-report.md)**",
        ].join("\n"),
      },
    },
  ]);

  assert.match(markdown, /\/tmp\/git-config/);
  assert.match(markdown, /\/tmp\/container\.txt/);
  assert.match(markdown, /\/tmp\/project/);
  assert.match(markdown, /outside\\report\.txt/);
  assert.match(markdown, /\/tmp\/a/);
  assert.match(markdown, /\/tmp\/c/);
  assert.match(markdown, /\/tmp\/e/);
  assert.match(markdown, /outside\\a/);
  assert.match(markdown, /\/tmp\/path-only\.txt/);
  assert.match(markdown, /\/tmp\/build\.log/);
  assert.match(markdown, /work\\plan\.md/);
  assert.match(markdown, /\/tmp\/lowercase-heading\.txt/);
  assert.match(markdown, /\/tmp\/project-heading\.txt/);
  assert.match(markdown, /\/tmp\/git-heading\.txt/);
  assert.match(markdown, /work\\input\.txt/);
  assert.match(markdown, /photos\\cats/);
  assert.match(markdown, /\/tmp\/files-heading\.txt/);
  assert.match(markdown, /\/tmp\/output-heading\.txt/);
  assert.match(markdown, /\/tmp\/artifacts-heading\.txt/);
  assert.match(markdown, /\/tmp\/lowercase-git-config/);
  assert.match(markdown, /\/tmp\/My Report\.txt/);
  assert.match(markdown, /\/tmp\/a one\.txt/);
  assert.match(markdown, /\/tmp\/b two\.txt/);
  assert.match(markdown, /\/tmp\/a;b\.txt/);
  assert.match(markdown, /\/tmp\/report\|final\.txt/);
  assert.match(markdown, /\/tmp\/report\.md/);
  assert.match(markdown, /\/tmp\/R&D\.md/);
  assert.match(markdown, /\/tmp\/list-one/);
  assert.match(markdown, /\/tmp\/list-two/);
  assert.match(markdown, /\/tmp\/link-one/);
  assert.match(markdown, /\/tmp\/link-two/);
  assert.match(markdown, /Windows\\win\.ini/);
  assert.match(markdown, /Windows\\system\.ini/);
  assert.match(markdown, /\/tmp\/styled-report\.md/);
});

test("external reference discovery ignores quoted Stash2D directory warnings", () => {
  const markdown = renderUserReferenceMarkdown([
    {
      type: "user.message",
      data: {
        content: [
          "This appeared during my last save:",
          "",
          "Referenced directory C:\\Windows\\assembly exceeds the discovery safety limit of 200 files, 50 directories, or 1000 inspected entries and was skipped.",
          "",
          "> Referenced directory Q:\\spocore exceeds the discovery safety limit of 200 files, 50 directories, or 1000 inspected entries and was skipped.",
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
  const markdown = renderUserReferenceMarkdown([
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
  const markdown = renderUserReferenceMarkdown([
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
  const markdown = renderUserReferenceMarkdown([
    {
      type: "user.message",
      data: {
        content: [
          "PS C:\\src\\app> Get-Content C:\\Users\\me\\.ssh\\config",
          "> PS C:\\src\\app> Get-Content C:\\Users\\me\\.ssh\\id_rsa",
          "C:\\src\\app> type C:\\secrets.txt",
          "$ cat /etc/shadow",
          "# cat /root/token",
          "# python /home/me/token.py",
          "# sudo cat /root/admin-token",
          "# make /tmp/generated-target",
          '# cat "/root/quoted-token"',
          "# time -o /tmp/timing true",
          "# FOO=bar cat /root/assigned-token",
          '# FOO="bar baz" cat /root/quoted-assignment-token',
          '# cat --input="/root/option-token"',
          '# cat 2>"/root/redirect-token"',
          "# nice cat /root/nice-token",
          '# cat "outside/relative-token.txt"',
          '# cat --input="outside/option-relative-token.txt"',
          "# FOO= cat C:\\outside\\empty-assignment-token",
          "# FOO=bar\\ baz cat C:\\outside\\escaped-assignment-token",
          "# deploy --config C:\\outside\\operator-token && echo done",
          "# /root/path-command-token",
          "# ./relative-command-token",
          '# "../outside/quoted-command-token"',
          "# (deploy /root/group-token)",
          "# deploy $(cat /root/substitution-token)",
          "# cat `/root/backtick-token`",
          '# source "/root/source-token"',
          '# . "/root/dot-token"',
          "# powershell.exe -File C:\\outside\\script-token.ps1",
          '# CONFIG="/root/assignment-only-token"',
          '# CONFIG="/root/assignment-prefix-token" deploy',
          "# C:\\Windows\\System32\\cmd.exe /c type C:\\Windows\\path-command.ini",
          "# tools/deploy /outside/tool-command-token",
          '# echo "C:\\Windows\\echo-token.ini"',
          '# export CONFIG="C:\\Windows\\export-token.ini"',
          "# deploy `type C:\\Windows\\backtick-substitution-token.ini`",
          "# tee /root/tee-token",
          "# doas cat /root/doas-token",
          "# PowerShell.exe -File C:\\outside\\upper-script-token.ps1",
          "# CAT /root/upper-cat-token",
          '# CONFIG="/root/upper-assignment-token" PowerShell.exe',
          "# deploy `tools/read-secret /root/relative-substitution-token`",
          "# read C:\\Windows\\read-command-token.ini",
          "# deploy --include C:\\Windows\\option-intent-token.ini",
          '# echo "[archive](C:\\Windows\\link-intent-token.ini)"',
          "# cat `C:\\Windows\\backtick-intent-token.ini` save",
          "# ./archive /root/executable-intent-token",
          "# tools/archive /root/relative-executable-intent-token",
          "# C:\\tools\\inspect.exe C:\\Users\\me\\windows-intent-token.txt",
          "# echo note: /root/colon-command-token.txt",
          "# cat notes /root/notes-command-token.txt",
          "# files to archive /tmp/public.txt && cat /root/chained-token.txt",
          "# Docker save -o /tmp/docker-command-token.tar image",
          "# Git archive --output=/tmp/git-command-token.zip HEAD",
          "# podman save image -o /root/podman-command-token.tar",
          "# helm install archive /root/helm-command-token",
          "# archive --input /root/intent-option-token.txt",
          "# files to archive /tmp/public.txt & cat /root/ampersand-command-token.txt",
          "# archive /tmp/public.txt|cat /root/compact-pipe-token.txt",
          "[root@server ~]# cat /root/prefixed-command-token",
          "bash-5.2# cat /root/versioned-prompt-token",
          "# cat \\",
          "> /root/continuation-command-token",
          "# cat /root/first |",
          "> cat /root/pipeline-continuation-token",
          "# cat <<EOF",
          "> /root/heredoc-command-token.txt",
          "EOF",
          "# archive /tmp/public.txt &cat /root/compact-ampersand-token.txt",
          "# archive /tmp/background-token.txt &",
          "# cat /root/first.txt &&",
          "> cat /root/and-continuation-token.txt",
          "# cat <<PIPE | sed s/x/y/",
          "> /root/piped-heredoc-token.txt",
          "> PIPE",
          "# FOO=bar archive /root/assignment-intent-token.txt",
          "dan@macbook tmp % cat /Users/dan/.ssh/zsh-prompt-token",
          '# archive /tmp/public.txt & "/root/read-secret" /root/path-command-tail-token.txt',
          "# FOO+=bar archive /root/compound-assignment-token.txt",
          '# echo "',
          "> /root/quoted-continuation-token.txt",
          '# "',
          "# cat \\",
          "> <<NEXT",
          "> /root/continuation-heredoc-token.txt",
          "> NEXT",
          "# cat <<STRICT",
          ">   STRICT",
          "> /root/unterminated-heredoc-token.txt",
          "> STRICT",
          "(venv) root@server:/work# cat /root/venv-prompt-token.txt",
          "# archive /tmp/public.txt & /root/path-command-no-args-token",
          "root@server:/work#cat /root/no-space-prompt-token",
          "/ # cat /root/busybox-prompt-token",
          '# echo "<<EOF"',
          "# Include `/tmp/after-quoted-heredoc.txt` in the archive",
          "# cat <<'QUOTED'",
          "> /root/quoted-heredoc-token.txt",
          "> QUOTED",
          "# cat <<\\ESCAPED",
          "> /root/escaped-heredoc-token.txt",
          "> ESCAPED",
          "# if true; then",
          "> cat /root/compound-continuation-token.txt",
          "> fi",
          "# {",
          "> cat /root/brace-compound-token.txt",
          "> }",
          '# if true; then echo "',
          "> fi",
          '> "',
          "> cat /root/quoted-closer-token.txt",
          "> fi",
          "root@host:/# if true; then",
          "> echo ok",
          "> cat /root/compound-later-token.txt",
          "> fi",
          'root@host:/# cat <<E"OF"',
          "> /root/concatenated-heredoc-token.txt",
          "> EOF",
          "# Include `/tmp/after-concatenated-heredoc.txt` in the archive",
          "# cat <<''",
          "> /root/empty-heredoc-token.txt",
          "> ",
          '# cat <<"E\\"OF"',
          "> /root/escaped-quote-heredoc-token.txt",
          '> E"OF',
          "# Include `/tmp/after-escaped-heredoc.txt` in the archive",
          "# if true; then",
          "> echo ok",
          "outside transcript",
          "# cat /root/after-abandoned-compound-token.txt",
          "> Keep `/tmp/after-abandoned-compound.txt`.",
          "# if true; then while true; do",
          "> echo ok",
          "> done",
          "> cat /root/nested-compound-token.txt",
          "> fi",
          "alice@host:/work$ cat /home/alice/token.txt",
          '  File "/home/me/app/creds.py", line 8, in load',
          "    at Object.<anonymous> (C:\\src\\app\\index.js:12:9)",
          "Please keep `C:\\Users\\me\\notes.txt`.",
        ].join("\n"),
      },
    },
  ]);

  assert.doesNotMatch(markdown, /\.ssh\\config/);
  assert.doesNotMatch(markdown, /id_rsa/);
  assert.doesNotMatch(markdown, /secrets\.txt/);
  assert.doesNotMatch(markdown, /etc\/shadow/);
  assert.doesNotMatch(markdown, /root\/token/);
  assert.doesNotMatch(markdown, /token\.py/);
  assert.doesNotMatch(markdown, /admin-token/);
  assert.doesNotMatch(markdown, /generated-target/);
  assert.doesNotMatch(markdown, /quoted-token/);
  assert.doesNotMatch(markdown, /tmp\/timing/);
  assert.doesNotMatch(markdown, /assigned-token/);
  assert.doesNotMatch(markdown, /quoted-assignment-token/);
  assert.doesNotMatch(markdown, /option-token/);
  assert.doesNotMatch(markdown, /redirect-token/);
  assert.doesNotMatch(markdown, /nice-token/);
  assert.doesNotMatch(markdown, /relative-token/);
  assert.doesNotMatch(markdown, /option-relative-token/);
  assert.doesNotMatch(markdown, /empty-assignment-token/);
  assert.doesNotMatch(markdown, /escaped-assignment-token/);
  assert.doesNotMatch(markdown, /operator-token/);
  assert.doesNotMatch(markdown, /path-command-token/);
  assert.doesNotMatch(markdown, /relative-command-token/);
  assert.doesNotMatch(markdown, /quoted-command-token/);
  assert.doesNotMatch(markdown, /group-token/);
  assert.doesNotMatch(markdown, /substitution-token/);
  assert.doesNotMatch(markdown, /backtick-token/);
  assert.doesNotMatch(markdown, /source-token/);
  assert.doesNotMatch(markdown, /dot-token/);
  assert.doesNotMatch(markdown, /script-token/);
  assert.doesNotMatch(markdown, /assignment-only-token/);
  assert.doesNotMatch(markdown, /assignment-prefix-token/);
  assert.doesNotMatch(markdown, /path-command\.ini/);
  assert.doesNotMatch(markdown, /tool-command-token/);
  assert.doesNotMatch(markdown, /echo-token/);
  assert.doesNotMatch(markdown, /export-token/);
  assert.doesNotMatch(markdown, /backtick-substitution-token/);
  assert.doesNotMatch(markdown, /tee-token/);
  assert.doesNotMatch(markdown, /doas-token/);
  assert.doesNotMatch(markdown, /upper-script-token/);
  assert.doesNotMatch(markdown, /upper-cat-token/);
  assert.doesNotMatch(markdown, /upper-assignment-token/);
  assert.doesNotMatch(markdown, /relative-substitution-token/);
  assert.doesNotMatch(markdown, /read-command-token/);
  assert.doesNotMatch(markdown, /option-intent-token/);
  assert.doesNotMatch(markdown, /link-intent-token/);
  assert.doesNotMatch(markdown, /backtick-intent-token/);
  assert.doesNotMatch(markdown, /executable-intent-token/);
  assert.doesNotMatch(markdown, /relative-executable-intent-token/);
  assert.doesNotMatch(markdown, /windows-intent-token/);
  assert.doesNotMatch(markdown, /colon-command-token/);
  assert.doesNotMatch(markdown, /notes-command-token/);
  assert.doesNotMatch(markdown, /chained-token/);
  assert.doesNotMatch(markdown, /docker-command-token/);
  assert.doesNotMatch(markdown, /git-command-token/);
  assert.doesNotMatch(markdown, /podman-command-token/);
  assert.doesNotMatch(markdown, /helm-command-token/);
  assert.doesNotMatch(markdown, /intent-option-token/);
  assert.doesNotMatch(markdown, /ampersand-command-token/);
  assert.doesNotMatch(markdown, /compact-pipe-token/);
  assert.doesNotMatch(markdown, /prefixed-command-token/);
  assert.doesNotMatch(markdown, /versioned-prompt-token/);
  assert.doesNotMatch(markdown, /continuation-command-token/);
  assert.doesNotMatch(markdown, /pipeline-continuation-token/);
  assert.doesNotMatch(markdown, /heredoc-command-token/);
  assert.doesNotMatch(markdown, /compact-ampersand-token/);
  assert.doesNotMatch(markdown, /background-token/);
  assert.doesNotMatch(markdown, /and-continuation-token/);
  assert.doesNotMatch(markdown, /piped-heredoc-token/);
  assert.doesNotMatch(markdown, /assignment-intent-token/);
  assert.doesNotMatch(markdown, /zsh-prompt-token/);
  assert.doesNotMatch(markdown, /path-command-tail-token/);
  assert.doesNotMatch(markdown, /compound-assignment-token/);
  assert.doesNotMatch(markdown, /quoted-continuation-token/);
  assert.doesNotMatch(markdown, /continuation-heredoc-token/);
  assert.doesNotMatch(markdown, /unterminated-heredoc-token/);
  assert.doesNotMatch(markdown, /venv-prompt-token/);
  assert.doesNotMatch(markdown, /path-command-no-args-token/);
  assert.doesNotMatch(markdown, /no-space-prompt-token/);
  assert.doesNotMatch(markdown, /busybox-prompt-token/);
  assert.match(markdown, /after-quoted-heredoc\.txt/);
  assert.doesNotMatch(markdown, /quoted-heredoc-token/);
  assert.doesNotMatch(markdown, /escaped-heredoc-token/);
  assert.doesNotMatch(markdown, /compound-continuation-token/);
  assert.doesNotMatch(markdown, /compound-later-token/);
  assert.doesNotMatch(markdown, /concatenated-heredoc-token/);
  assert.match(markdown, /after-concatenated-heredoc\.txt/);
  assert.doesNotMatch(markdown, /empty-heredoc-token/);
  assert.doesNotMatch(markdown, /escaped-quote-heredoc-token/);
  assert.match(markdown, /after-escaped-heredoc\.txt/);
  assert.doesNotMatch(markdown, /after-abandoned-compound-token/);
  assert.match(markdown, /after-abandoned-compound\.txt/);
  assert.doesNotMatch(markdown, /nested-compound-token/);
  assert.doesNotMatch(markdown, /brace-compound-token/);
  assert.doesNotMatch(markdown, /quoted-closer-token/);
  assert.doesNotMatch(markdown, /token\.txt/);
  assert.doesNotMatch(markdown, /creds\.py/);
  assert.doesNotMatch(markdown, /index\.js/);
  assert.match(markdown, /notes\.txt/);
});

test("external references preserve structured attachment paths", () => {
  const uncPath = "\\\\server\\share\\folder";
  const references = renderExternalReferences([
    {
      type: "user.message",
      data: {
        content: '{"path":"C:\\\\not-an-attachment"}',
        attachments: [{ type: "file", path: uncPath }],
      },
    },
  ]);

  assert.deepEqual(references.attachmentReferences, [
    { path: uncPath, source: "attachment" },
  ]);
  assert.match(references.messageMarkdown, /not-an-attachment/);
  assert.doesNotMatch(references.messageMarkdown, /server/);
});

test("external reference discovery ignores tilde and unclosed fences", () => {
  const markdown = renderUserReferenceMarkdown([
    {
      type: "user.message",
      data: {
        content: [
          "~~~~powershell",
          "Get-Content C:\\secrets.txt",
          "~~~~",
          "> ~~~sh",
          "> cat /tmp/blockquoted-secret.txt",
          "> ~~~",
          "~~~not-a-close",
          "cat /tmp/still-hidden.txt",
          "~~~",
          "```sh",
          "cat /etc/shadow",
          "Please keep /tmp/also-hidden.txt",
        ].join("\n"),
      },
    },
  ]);

  assert.doesNotMatch(markdown, /secrets\.txt/);
  assert.doesNotMatch(markdown, /blockquoted-secret/);
  assert.doesNotMatch(markdown, /etc\/shadow/);
  assert.doesNotMatch(markdown, /also-hidden/);
  assert.doesNotMatch(markdown, /still-hidden/);
});

test("blockquoted fences cannot close root-level fences", () => {
  const markdown = renderUserReferenceMarkdown([
    {
      type: "user.message",
      data: {
        content: [
          "````text",
          "hidden /tmp/one.txt",
          "> ````",
          "still hidden /tmp/two.txt",
          "````",
          "Keep `/tmp/visible.txt`.",
        ].join("\n"),
      },
    },
  ]);

  assert.doesNotMatch(markdown, /one\.txt/);
  assert.doesNotMatch(markdown, /two\.txt/);
  assert.match(markdown, /visible\.txt/);
});

test("leaving a blockquote closes its unclosed fenced block", () => {
  const markdown = renderUserReferenceMarkdown([
    {
      type: "user.message",
      data: {
        content: [
          "> ```sh",
          "> cat /tmp/hidden.txt",
          "Keep `/tmp/visible.txt`.",
        ].join("\n"),
      },
    },
  ]);

  assert.doesNotMatch(markdown, /hidden\.txt/);
  assert.match(markdown, /visible\.txt/);
});

test("external reference discovery ignores cross-platform PowerShell prompts", () => {
  const markdown = renderUserReferenceMarkdown([
    {
      type: "user.message",
      data: {
        content: [
          "PS /home/me> Get-Content /etc/shadow",
          "Please keep `/tmp/notes.txt`.",
        ].join("\n"),
      },
    },
  ]);

  assert.doesNotMatch(markdown, /etc\/shadow/);
  assert.match(markdown, /notes\.txt/);
});
