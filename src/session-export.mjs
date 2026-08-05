const SKIPPED_EVENT_TYPES = new Set([
  "assistant.message_delta",
  "assistant.message_start",
  "assistant.reasoning_delta",
  "assistant.streaming_delta",
  "assistant.tool_call_delta",
  "assistant.turn_start",
  "assistant.turn_end",
  "assistant.usage",
  "session.idle",
  "tool.execution_partial_result",
  "tool.execution_progress",
]);

function heading(event, label) {
  const timestamp = event.timestamp ? ` — ${event.timestamp}` : "";
  return `## ${label}${timestamp}`;
}

function json(value) {
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

function attachmentSummary(attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return "";
  }
  return `\n\n### Attachments\n\n${json(attachments)}`;
}

function stripFencedBlocks(content) {
  const output = [];
  let fence;
  for (const line of content.split(/\r?\n/)) {
    const prefix = line.match(/^\s*(?:>\s*)*/)?.[0] ?? "";
    const quoteDepth = (prefix.match(/>/g) ?? []).length;
    const fenceLine = line.slice(prefix.length);
    if (fence && quoteDepth < fence.quoteDepth) {
      fence = undefined;
    }
    if (!fence) {
      const match = fenceLine.match(/^\s*(`{3,}|~{3,})/);
      if (match) {
        fence = {
          character: match[1][0],
          length: match[1].length,
          quoteDepth,
        };
      } else {
        output.push(line);
      }
      continue;
    }
    const closingMatch = fenceLine.match(/^\s*(`{3,}|~{3,})\s*$/);
    if (
      closingMatch &&
      quoteDepth === fence.quoteDepth &&
      closingMatch[1][0] === fence.character &&
      closingMatch[1].length >= fence.length
    ) {
      fence = undefined;
    }
  }
  return output.join("\n");
}

function sanitizeUserReferenceContent(content) {
  return stripFencedBlocks(
    content.replace(/<skill-context\b[^>]*>[\s\S]*?<\/skill-context>/gi, ""),
  )
    .split(/\r?\n/)
    .filter((line) => {
      const normalized = line.replace(/^\s*(?:>\s*)+/, "");
      return (
        !/^\s*\$[\w:.-]+\s*=/.test(normalized) &&
        !/^\s*(?:PS\s+\S[^>]*>|[A-Za-z]:\\[^>]*>|\$\s+|[^\s@]+@[^\s:]+:[^$#]*[$#]\s+)/.test(
          normalized,
        ) &&
        !/^\s*#\s+\S/.test(normalized) &&
        !/^\s*File\s+["'][^"']+["'],\s+line\s+\d+/i.test(normalized) &&
        !/^\s*at\s+(?:.+?\s+\()?[^()\s]+:\d+:\d+\)?\s*$/.test(
          normalized,
        ) &&
        !/^\s*\S.*?\s+=>\s+(?:~[\\/]|\/|[A-Za-z]:[\\/]|\\\\)/.test(
          normalized,
        ) &&
        !/^\s*(?:\[(?:20\d{2}-|\d{2}:?\d{2}\b|DEBUG\b|ERROR\b|INFO\b|WARN(?:ING)?\b)|(?:Add|Copy|Export|Find|Get|Import|Invoke|Move|New|Remove|Select|Set|Start|Stop|Test|Where)-[\w-]+)/i.test(
          normalized,
        ) &&
        !isDirectoryLimitWarning(normalized)
      );
    })
    .join("\n");
}

export function renderExternalReferences(events) {
  const sections = [];
  const attachmentPaths = new Set();
  for (const event of events) {
    if (event.ephemeral || event.agentId) {
      continue;
    }
    const data = event.data ?? {};
    if (event.type === "user.message") {
      sections.push(sanitizeUserReferenceContent(data.content ?? ""));
      for (const attachment of data.attachments ?? []) {
        if (typeof attachment?.path === "string" && attachment.path) {
          attachmentPaths.add(attachment.path);
        }
      }
    }
  }
  return {
    messageMarkdown: sections.join("\n\n"),
    attachmentReferences: [...attachmentPaths].map((attachmentPath) => ({
      path: attachmentPath,
      source: "attachment",
    })),
  };
}

export function renderSessionMarkdown(events) {
  const sections = [
    "# Copilot Session",
    "Exported from the public GitHub Copilot CLI session event API by Copilot Stash2D.",
  ];

  for (const event of events) {
    if (
      event.ephemeral ||
      event.agentId ||
      SKIPPED_EVENT_TYPES.has(event.type)
    ) {
      continue;
    }
    const data = event.data ?? {};
    switch (event.type) {
      case "user.message":
        sections.push(
          `${heading(event, "User")}\n\n${data.content ?? ""}${attachmentSummary(data.attachments)}`,
        );
        break;
      case "assistant.message":
        sections.push(
          `${heading(event, "Assistant")}\n\n${data.content ?? ""}${
            data.toolRequests?.length
              ? `\n\n### Tool requests\n\n${json(data.toolRequests)}`
              : ""
          }`,
        );
        break;
      case "tool.execution_start":
        sections.push(
          `${heading(event, `Tool started: ${data.toolName ?? "unknown"}`)}\n\n${json(data.arguments ?? {})}`,
        );
        break;
      case "tool.execution_complete": {
        const result =
          data.result?.detailedContent ??
          data.result?.content ??
          data.error?.message ??
          "";
        sections.push(
          `${heading(event, `Tool ${data.success ? "completed" : "failed"}`)}\n\n${result}`,
        );
        break;
      }
      case "system.notification":
        sections.push(
          `${heading(event, "System notification")}\n\n${data.content ?? ""}`,
        );
        break;
      case "session.info":
      case "session.warning":
      case "session.error":
        sections.push(
          `${heading(event, event.type.replace("session.", "Session "))}\n\n${data.message ?? json(data)}`,
        );
        break;
      case "subagent.started":
      case "subagent.completed":
      case "subagent.failed":
        sections.push(
          `${heading(event, event.type.replace(".", " "))}\n\n${json(data)}`,
        );
        break;
      default:
        break;
    }
  }

  return `${sections.join("\n\n")}\n`;
}
import { isDirectoryLimitWarning } from "./messages.mjs";
