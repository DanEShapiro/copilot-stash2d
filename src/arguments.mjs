function tokenizeArgumentDetails(input) {
  const tokens = [];
  let token = "";
  let quote = null;
  let escaping = false;
  let started = false;
  let quoted = false;

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
      const afterNext = value[index + 2];
      const closesQuotedWindowsPath =
        quote === '"' &&
        next === quote &&
        (!afterNext || /\s/.test(afterNext));
      if (closesQuotedWindowsPath) {
        token += character;
      } else if (next === quote || (!quote && next && /\s/.test(next))) {
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
      quoted = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (started) {
        tokens.push({ value: token, quoted });
        token = "";
        started = false;
        quoted = false;
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
    tokens.push({ value: token, quoted });
  }
  return tokens;
}

export function tokenizeArguments(input) {
  return tokenizeArgumentDetails(input).map((token) => token.value);
}

export function parseSaveArguments(input) {
  const tokens = tokenizeArgumentDetails(input);
  let outputDirectory;
  let title;
  const positional = [];
  const seenOptions = new Set();

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index].value;
    if (token === "--output") {
      if (seenOptions.has(token)) {
        throw new Error("--output may only be specified once.");
      }
      const valueToken = tokens[index + 1];
      outputDirectory = valueToken?.value;
      if (
        !outputDirectory ||
        (!valueToken.quoted && outputDirectory.startsWith("--"))
      ) {
        throw new Error("--output requires a directory path.");
      }
      seenOptions.add(token);
      index += 1;
    } else if (token === "--title") {
      if (seenOptions.has(token)) {
        throw new Error("--title may only be specified once.");
      }
      const valueToken = tokens[index + 1];
      title = valueToken?.value;
      if (!title || (!valueToken.quoted && title.startsWith("--"))) {
        throw new Error("--title requires a value.");
      }
      seenOptions.add(token);
      index += 1;
    } else {
      if (!tokens[index].quoted && token.startsWith("--")) {
        throw new Error(`Unknown option: ${token}`);
      }
      positional.push(token);
    }
  }

  if (!title && positional.length > 0) {
    title = positional.join(" ");
  }

  return { outputDirectory, title };
}

export function parseApplyArguments(input) {
  const tokens = tokenizeArgumentDetails(input);
  return tokens.length === 0
    ? undefined
    : tokens.map((token) => token.value).join(" ");
}
