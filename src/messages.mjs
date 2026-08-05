export function directoryLimitWarning(
  directoryPath,
  { maxFiles, maxDirectories, maxEntries },
) {
  return `Referenced directory ${directoryPath} exceeds the discovery safety limit of ${maxFiles} files, ${maxDirectories} directories, or ${maxEntries} inspected entries and was skipped.`;
}

export function isDirectoryLimitWarning(line) {
  return /^(?:>\s*)?Referenced directory .+ exceeds the discovery safety limit of \d+ files, \d+ directories, or \d+ inspected entries and was skipped\.\s*$/.test(
    line,
  );
}
