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

function sanitizeUserReferenceContent(content) {
  return content
    .replace(/<skill-context\b[^>]*>[\s\S]*?<\/skill-context>/gi, "")
    .replace(/```[\s\S]*?```/g, "")
    .split(/\r?\n/)
    .filter(
      (line) =>
        !/^(?:\s*>{1,2}\s*)?\$[\w:.-]+\s*=/.test(line) &&
        !/^\s*(?:PS\s+[A-Za-z]:\\[^>]*>|[A-Za-z]:\\[^>]*>|\$\s+|[^\s@]+@[^\s:]+:[^$#]*[$#]\s+)/.test(
          line,
        ) &&
        !/^\s*File\s+["'][^"']+["'],\s+line\s+\d+/i.test(line) &&
        !/^\s*at\s+(?:.+?\s+\()?[^()\s]+:\d+:\d+\)?\s*$/.test(line) &&
        !/^\s*\S.*?\s+=>\s+(?:~[\\/]|\/|[A-Za-z]:[\\/]|\\\\)/.test(
          line,
        ) &&
        !/^\s*>{1,2}\s*(?:#|\[|(?:Add|Copy|Export|Find|Get|Import|Invoke|Move|New|Remove|Select|Set|Start|Stop|Test|Where)-[\w-]+)/i.test(
          line,
        ) &&
        !/^(?:>\s*)?Referenced directory .+ exceeds the discovery safety limit of \d+ files or \d+ directories and was skipped\.\s*$/.test(
          line,
        ),
    )
    .join("\n");
}

export function renderExternalReferenceMarkdown(events) {
  const sections = [];
  for (const event of events) {
    if (event.ephemeral || event.agentId) {
      continue;
    }
    const data = event.data ?? {};
    if (event.type === "user.message") {
      sections.push(
        `${sanitizeUserReferenceContent(data.content ?? "")}${attachmentSummary(data.attachments)}`,
      );
    }
  }
  return sections.join("\n\n");
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
