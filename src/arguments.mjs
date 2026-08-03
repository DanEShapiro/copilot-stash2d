export function tokenizeArguments(input) {
  const tokens = [];
  let token = "";
  let quote = null;
  let escaping = false;
  let started = false;

  const value = String(input ?? "");
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (escaping) {
      token += character;
      escaping = false;
      started = true;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      const next = value[index + 1];
      if (next === "\\" || next === quote || (!quote && next && /\s/.test(next))) {
        escaping = true;
      } else {
        token += character;
      }
      started = true;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        token += character;
      }
      started = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      started = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (started) {
        tokens.push(token);
        token = "";
        started = false;
      }
      continue;
    }
    token += character;
    started = true;
  }

  if (escaping) {
    token += "\\";
  }
  if (quote) {
    throw new Error(`Unterminated ${quote} quote in command arguments.`);
  }
  if (started) {
    tokens.push(token);
  }
  return tokens;
}

export function parseSaveArguments(input) {
  const tokens = tokenizeArguments(input);
  let outputDirectory;
  let title;
  const positional = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--output") {
      outputDirectory = tokens[index + 1];
      if (!outputDirectory) {
        throw new Error("--output requires a directory path.");
      }
      index += 1;
    } else if (token === "--title") {
      title = tokens[index + 1];
      if (!title) {
        throw new Error("--title requires a value.");
      }
      index += 1;
    } else {
      positional.push(token);
    }
  }

  if (!title && positional.length > 0) {
    title = positional.join(" ");
  }

  return { outputDirectory, title };
}

export function parseApplyArguments(input) {
  const tokens = tokenizeArguments(input);
  return tokens.length === 0 ? undefined : tokens.join(" ");
}
