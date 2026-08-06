import { isDirectoryLimitWarning } from "./messages.mjs";

const ROOT_SHELL_COMMANDS = new Set([
  ".",
  "az",
  "awk",
  "bash",
  "cat",
  "cd",
  "chmod",
  "chown",
  "cmd",
  "command",
  "copy",
  "cp",
  "curl",
  "del",
  "dir",
  "docker",
  "echo",
  "env",
  "exec",
  "export",
  "find",
  "findstr",
  "fish",
  "gh",
  "git",
  "grep",
  "head",
  "helm",
  "java",
  "kubectl",
  "less",
  "ls",
  "make",
  "mkdir",
  "more",
  "move",
  "mv",
  "node",
  "nohup",
  "nice",
  "npm",
  "npx",
  "perl",
  "pnpm",
  "podman",
  "powershell",
  "pwd",
  "pwsh",
  "python",
  "python3",
  "read",
  "rg",
  "rm",
  "rmdir",
  "ruby",
  "scp",
  "sed",
  "set",
  "sh",
  "ssh",
  "source",
  "sudo",
  "tail",
  "tar",
  "time",
  "timeout",
  "touch",
  "type",
  "unzip",
  "wget",
  "yarn",
  "zip",
  "zsh",
]);

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

function tokenizeShellInvocation(value) {
  const tokens = [];
  const operators = [];
  let current = "";
  let escaped = false;
  let hasOperator = false;
  let quote;
  const flush = () => {
    if (current) {
      tokens.push(current);
      current = "";
    }
  };
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      if (/[\s"'\\]/.test(value[index + 1] ?? "")) {
        escaped = true;
      } else {
        current += character;
      }
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = undefined;
      } else {
        current += character;
      }
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      flush();
      continue;
    }
    if (/[|&;<>(){}]/.test(character)) {
      flush();
      hasOperator = true;
      operators.push(character);
      continue;
    }
    current += character;
  }
  if (escaped) {
    current += "\\";
  }
  flush();
  return { tokens, hasOperator, operators };
}

function shellTokenContainsPath(token) {
  const candidate = token
    .replace(/^--?[^=]+=/, "")
    .replace(/^[`([{]+|[`)\]}]+$/g, "");
  return (
    !/^[a-z][a-z\d+.-]*:\/\//i.test(candidate) &&
    (
      /^(?:~?[\\/]|[A-Za-z]:[\\/]|\\\\|\.\.?[\\/])/.test(candidate) ||
      /[\\/]/.test(candidate)
    )
  );
}

function hasCommandAmpersand(value, allowPathList = false) {
  let quote;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }
    if (
      character === "&" &&
      (value[index - 1] === "&" || value[index + 1] === "&")
    ) {
      return true;
    }
    if (
      character === "&" &&
      value[index - 1] !== "&" &&
      value[index + 1] !== "&"
    ) {
      const tail = value.slice(index + 1).trimStart();
      const tailTokens = tokenizeShellInvocation(tail).tokens;
      if (!allowPathList) {
        return true;
      }
      if (!tail || shellTokenContainsPath(tailTokens[0] ?? "")) {
        continue;
      }
      return true;
    }
  }
  return false;
}

function looksLikeRootShellPrompt(line) {
  const match = line.match(/^\s*#\s+(.+)$/);
  if (!match) {
    return false;
  }
  const invocation = match[1];
  const unstyledInvocation = invocation
    .trim()
    .replace(/^(?:\*\*|__|~~|\*|_)+/, "")
    .replace(/(?:\*\*|__|~~|\*|_)+$/, "");
  if (
    /^(?:\[[^\]]+\]\([^)]*\))(?:\s*&\s*\[[^\]]+\]\([^)]*\))*$/.test(
      unstyledInvocation,
    )
  ) {
    return false;
  }
  if (
    /^`(?:~?[\\/]|[A-Za-z]:[\\/]|\\\\|\.\.?[\\/])[^`]+`$/.test(
      invocation.trim(),
    )
  ) {
    return false;
  }
  const parsed = tokenizeShellInvocation(invocation);
  let commandIndex = 0;
  while (/^[A-Za-z_]\w*(?:\+)?=/.test(parsed.tokens[commandIndex] ?? "")) {
    commandIndex += 1;
  }
  const hasAssignmentPrefix = commandIndex > 0;
  const assignmentHasPath = parsed.tokens
    .slice(0, commandIndex)
    .some(shellTokenContainsPath);
  const commandToken = parsed.tokens[commandIndex];
  if (!commandToken) {
    return assignmentHasPath || parsed.hasOperator;
  }
  const headingText = parsed.tokens.slice(commandIndex).join(" ");
  const commandName = pathBaseName(commandToken)
    .toLowerCase()
    .replace(/\.(?:bat|cmd|com|exe)$/, "");
  const explicitCommandPath =
    /^(?:~?[\\/]|[A-Za-z]:[\\/]|\\\\|\.\.?[\\/])/.test(commandToken);
  const executableCommandPath =
    explicitCommandPath ||
    /[\\/]/.test(commandToken);
  const knownCommand =
    ROOT_SHELL_COMMANDS.has(commandName) ||
    /^python\d*(?:\.\d+)*$/.test(commandName);
  const commandSubstitution =
    /\$\(/.test(invocation) ||
    containsBacktickCommandSubstitution(invocation);
  const argumentTokens = parsed.tokens.slice(commandIndex + 1);
  const optionArgument = argumentTokens.some((token) => token.startsWith("-"));
  const proseArguments = argumentTokens.filter(
    (token) => !token.startsWith("-") && !shellTokenContainsPath(token),
  );
  const commandIsIntent =
    !knownCommand &&
    /^(?:archive|attach|include|inspect|keep|preserve|read|reference|review|save)$/i.test(
      commandName,
    );
  const colonHeading = /^[^/\\]*:\s/.test(headingText);
  const capitalizedHeading = /^[A-Z]/.test(headingText);
  const hasProseConnector = proseArguments.some((token) =>
    /^(?:about|at|for|from|in|include|to|using|with)$/i.test(
      token.replace(/[,:;]$/, ""),
    )
  );
  const knownCommandHeading =
    knownCommand &&
    !optionArgument &&
    (
      (
        /^[A-Z][a-z]/.test(commandToken) &&
        (colonHeading || hasProseConnector)
      ) ||
      (
        colonHeading &&
        /^(?:configuration|files?|notes)$/i.test(
          proseArguments[0]?.replace(/[,:;]$/, "") ?? "",
        )
      )
    );
  const descriptiveNounHeading =
    /^(?:artifacts?|files?|output|project)$/i.test(commandName) &&
    hasProseConnector;
  const headingIntent =
    knownCommandHeading ||
    (
      !knownCommand &&
      !executableCommandPath &&
      (
        capitalizedHeading ||
        colonHeading ||
        descriptiveNounHeading
      )
    ) ||
    (
      !knownCommand &&
      /[\\/]/.test(commandToken) &&
      !explicitCommandPath &&
      proseArguments.some((token) =>
        /^(?:files?|include|notes?)$/i.test(token.replace(/[,:;]$/, ""))
      )
    ) ||
    (commandIsIntent && !executableCommandPath);
  const pathListAmpersand =
    /&/.test(invocation) &&
    (
      /["'`][^"'`]*[\\/][^"'`]*["'`]\s*&\s*["'`][^"'`]*[\\/]/.test(
        invocation,
      ) ||
      /\[[^\]]+\]\([^)]*\)\s*&\s*\[[^\]]+\]\([^)]*\)/.test(
        invocation,
      ) ||
      /&\s*(?:~?[\\/]|[A-Za-z]:[\\/]|\\\\|\.\.?[\\/])\S+\s+\w/.test(
        invocation,
      ) ||
      (
        headingIntent &&
        !knownCommand &&
        (capitalizedHeading || colonHeading || descriptiveNounHeading)
      )
    );
  const operatorSource = invocation.replace(
    /\[[^\]]+\]\([^)]*\)/g,
    "",
  );
  const operatorParse = tokenizeShellInvocation(operatorSource);
  const strongShellOperator =
    operatorParse.operators.some((operator) => /[|;<>(){}]/.test(operator)) ||
    hasCommandAmpersand(operatorSource, pathListAmpersand);
  const descriptiveIntent =
    !hasAssignmentPrefix &&
    !commandSubstitution &&
    !strongShellOperator &&
    !optionArgument &&
    headingIntent;
  if (descriptiveIntent) {
    return false;
  }
  if (
    hasAssignmentPrefix ||
    optionArgument ||
    strongShellOperator ||
    knownCommand ||
    executableCommandPath ||
    commandSubstitution
  ) {
    return true;
  }
  const pathEvidence =
    executableCommandPath ||
    parsed.tokens.some((token, index) =>
      index !== commandIndex && shellTokenContainsPath(token)
    );
  if (!pathEvidence) {
    return false;
  }
  return parsed.hasOperator || !commandIsIntent;
}

function pathBaseName(value) {
  return value.split(/[\\/]/).at(-1) ?? value;
}

function containsBacktickCommandSubstitution(value) {
  return [...value.matchAll(/`([^`]*)`/g)].some((match) => {
    if (
      /^(?:~?[\\/]|[A-Za-z]:[\\/]|\\\\|\.\.?[\\/])/.test(
        match[1].trim(),
      )
    ) {
      return false;
    }
    const parsed = tokenizeShellInvocation(match[1]);
    let commandIndex = 0;
    while (/^[A-Za-z_]\w*(?:\+)?=/.test(parsed.tokens[commandIndex] ?? "")) {
      commandIndex += 1;
    }
    const commandToken = parsed.tokens[commandIndex];
    if (!commandToken) {
      return false;
    }
    const commandName = pathBaseName(commandToken)
      .toLowerCase()
      .replace(/\.(?:bat|cmd|com|exe)$/, "");
    return (
      ROOT_SHELL_COMMANDS.has(commandName) ||
      /^python\d*(?:\.\d+)*$/.test(commandName) ||
      (
        parsed.tokens.length > commandIndex + 1 &&
        /[\\/]/.test(commandToken)
      )
    );
  });
}

function scanShellOpenQuote(value, initialQuote) {
  let quote = initialQuote;
  let escaped = false;
  for (const character of value) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = undefined;
      }
    } else if (character === '"' || character === "'" || character === "`") {
      quote = character;
    }
  }
  return quote;
}

function extractShellHeredocs(value) {
  const heredocs = [];
  let quote;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (
      character !== "<" ||
      value[index + 1] !== "<" ||
      value[index + 2] === "<"
    ) {
      continue;
    }
    index += 2;
    const stripTabs = value[index] === "-";
    if (stripTabs) {
      index += 1;
    }
    while (/\s/.test(value[index] ?? "")) {
      index += 1;
    }
    let delimiter = "";
    let delimiterQuote;
    let delimiterStarted = false;
    while (index < value.length) {
      const delimiterCharacter = value[index];
      if (delimiterQuote) {
        if (
          delimiterQuote === '"' &&
          delimiterCharacter === "\\" &&
          index + 1 < value.length
        ) {
          index += 1;
          delimiter += value[index];
          index += 1;
          continue;
        }
        if (delimiterCharacter === delimiterQuote) {
          delimiterQuote = undefined;
        } else {
          delimiter += delimiterCharacter;
        }
      } else if (delimiterCharacter === "'" || delimiterCharacter === '"') {
        delimiterStarted = true;
        delimiterQuote = delimiterCharacter;
      } else if (/[\s|&;<>]/.test(delimiterCharacter)) {
        break;
      } else if (delimiterCharacter === "\\" && index + 1 < value.length) {
        delimiterStarted = true;
        index += 1;
        delimiter += value[index];
      } else if (!delimiterQuote) {
        delimiterStarted = true;
        delimiter += delimiterCharacter;
      }
      index += 1;
    }
    if (delimiterStarted) {
      heredocs.push({ delimiter, stripTabs });
    }
  }
  return heredocs;
}

function updateShellCompoundClosers(value, closers, initialQuote) {
  const command = unquotedShellCommand(value, initialQuote).trim();
  for (const match of command.matchAll(/\b(?:then|do|fi|done)\b|[(){}]/g)) {
    const token = match[0];
    if (token === closers.at(-1)) {
      closers.pop();
    } else if (token === "then") {
      closers.push("fi");
    } else if (token === "do") {
      closers.push("done");
    } else if (token === "{") {
      closers.push("}");
    } else if (token === "(") {
      closers.push(")");
    }
  }
}

function unquotedShellCommand(value, initialQuote) {
  let output = "";
  let quote = initialQuote;
  let escaped = false;
  for (const character of value) {
    if (escaped) {
      output += " ";
      escaped = false;
    } else if (character === "\\" && quote !== "'") {
      output += " ";
      escaped = true;
    } else if (quote) {
      output += " ";
      if (character === quote) {
        quote = undefined;
      }
    } else if (character === '"' || character === "'" || character === "`") {
      output += " ";
      quote = character;
    } else {
      output += character;
    }
  }
  return output;
}

function hasShellLineContinuation(value, openQuote) {
  return (
    Boolean(openQuote) ||
    /(?:\\|\^|\||&&|\bthen|\bdo|[({])\s*$/.test(value) ||
    /\$\([^)]*$/.test(value)
  );
}

function sanitizeUserReferenceContent(content) {
  const output = [];
  let shellContinuation = false;
  let shellOpenQuote;
  const shellHeredocs = [];
  const shellCompoundClosers = [];
  for (const line of stripFencedBlocks(
    content.replace(/<skill-context\b[^>]*>[\s\S]*?<\/skill-context>/gi, ""),
  ).split(/\r?\n/)) {
    if (shellHeredocs.length > 0) {
      const heredoc = shellHeredocs[0];
      let bodyLine = line.replace(/^\s*>\s?/, "");
      if (heredoc.stripTabs) {
        bodyLine = bodyLine.replace(/^\t+/, "");
      }
      if (bodyLine === heredoc.delimiter) {
        shellHeredocs.shift();
      }
      continue;
    }
    if (
      (shellContinuation || shellOpenQuote) &&
      /^\s*>\s?/.test(line)
    ) {
      const continuation = line.replace(/^\s*>\s?/, "");
      shellHeredocs.push(...extractShellHeredocs(continuation));
      const initialQuote = shellOpenQuote;
      shellOpenQuote = scanShellOpenQuote(continuation, shellOpenQuote);
      updateShellCompoundClosers(
        continuation,
        shellCompoundClosers,
        initialQuote,
      );
      shellContinuation =
        shellCompoundClosers.length > 0 ||
        hasShellLineContinuation(continuation, shellOpenQuote);
      continue;
    }
    shellContinuation = false;
    shellOpenQuote = undefined;
    shellCompoundClosers.length = 0;
    const normalized = line.replace(/^\s*(?:>\s*)+/, "");
    const explicitShellPrompt =
      /^\s*(?:(?:\([^)\r\n]+\)\s+)*)(?:PS\s+\S[^>]*>|[A-Za-z]:\\[^>]*>|\$\s+|[^\s@]+@[^\s:]+:[^$#]*[$#]\s*|[^\s@]+@[^\s%]+(?:\s+\S+)*\s+[%#$]\s*|\[[^\]\r\n]+@[^\]\r\n]+\][#$]\s*|(?:ba|z)?sh-[\d.]+[#$]\s*|(?:\/|~)\s+[#%$]\s*)/i.test(
        normalized,
      );
    const rootShellPrompt = looksLikeRootShellPrompt(normalized);
    if (explicitShellPrompt || rootShellPrompt) {
      shellHeredocs.push(...extractShellHeredocs(normalized));
      shellOpenQuote = scanShellOpenQuote(normalized);
      updateShellCompoundClosers(normalized, shellCompoundClosers);
      shellContinuation =
        shellCompoundClosers.length > 0 ||
        hasShellLineContinuation(normalized, shellOpenQuote);
      continue;
    }
    if (
      /^\s*\$[\w:.-]+\s*=/.test(normalized) ||
      /^\s*File\s+["'][^"']+["'],\s+line\s+\d+/i.test(normalized) ||
      /^\s*at\s+(?:.+?\s+\()?[^()\s]+:\d+:\d+\)?\s*$/.test(normalized) ||
      /^\s*\S.*?\s+=>\s+(?:~[\\/]|\/|[A-Za-z]:[\\/]|\\\\)/.test(
        normalized,
      ) ||
      /^\s*(?:\[(?:20\d{2}-|\d{2}:?\d{2}\b|DEBUG\b|ERROR\b|INFO\b|WARN(?:ING)?\b)|(?:Add|Copy|Export|Find|Get|Import|Invoke|Move|New|Remove|Select|Set|Start|Stop|Test|Where)-[\w-]+)/i.test(
        normalized,
      ) ||
      isDirectoryLimitWarning(normalized)
    ) {
      continue;
    }
    output.push(line);
  }
  return output.join("\n");
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
