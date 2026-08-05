import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, rm } from "node:fs/promises";
import path from "node:path";

export class SourceFileChangedError extends Error {
  constructor(filePath) {
    super(`Source file changed while it was being copied: ${filePath}`);
    this.code = "SOURCE_CHANGED";
  }
}

export class SourceFileCopyError extends Error {
  constructor(filePath, cause) {
    super(`Source file could not be copied: ${filePath}. ${cause.message}`, {
      cause,
    });
    this.code = cause.code ?? "SOURCE_COPY_FAILED";
  }
}

export class DestinationFileCopyError extends Error {
  constructor(filePath, cause) {
    super(`Archive destination could not be written: ${filePath}. ${cause.message}`, {
      cause,
    });
    this.code = cause.code ?? "DESTINATION_COPY_FAILED";
  }
}

function sameIdentity(info, expected) {
  return (
    (expected.device === undefined || info.dev === expected.device) &&
    (expected.inode === undefined || info.ino === expected.inode) &&
    (expected.byteSize === undefined || info.size === expected.byteSize) &&
    (expected.mtimeMs === undefined || info.mtimeMs === expected.mtimeMs)
  );
}

export function fileIdentity(info) {
  return {
    device: info.dev,
    inode: info.ino,
    byteSize: info.size,
    mtimeMs: info.mtimeMs,
  };
}

export async function assertNoLinkedPathComponents(
  filePath,
  { getLinkInfo = lstat, checkedPaths = new Set() } = {},
) {
  const absolutePath = path.resolve(filePath);
  const root = path.parse(absolutePath).root;
  const relative = absolutePath.slice(root.length);
  let currentPath = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    currentPath = path.join(currentPath, segment);
    const key =
      process.platform === "win32"
        ? currentPath.toLowerCase()
        : currentPath;
    if (checkedPaths.has(key)) {
      continue;
    }
    const info = await getLinkInfo(currentPath);
    if (info.isSymbolicLink()) {
      const error = new Error(
        `Linked path components are not supported: ${currentPath}`,
      );
      error.code = "SYMLINK";
      throw error;
    }
    checkedPaths.add(key);
  }
}

export async function copyVerifiedFile(
  sourcePath,
  destinationPath,
  expectedIdentity,
  {
    beforeCopy = async () => {},
    openFile = open,
    removeFile = rm,
  } = {},
) {
  await beforeCopy(sourcePath, destinationPath);
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  let sourceHandle;
  let destinationHandle;
  let destinationCreated = false;
  let completed = false;
  let copyComplete = false;
  let failure;
  try {
    try {
      sourceHandle = await openFile(
        sourcePath,
        fsConstants.O_RDONLY | noFollow,
      );
    } catch (error) {
      throw new SourceFileCopyError(sourcePath, error);
    }
    const beforeInfo = await sourceHandle.stat();
    if (!beforeInfo.isFile() || !sameIdentity(beforeInfo, expectedIdentity)) {
      throw new SourceFileChangedError(sourcePath);
    }

    try {
      await mkdir(path.dirname(destinationPath), { recursive: true });
      destinationHandle = await openFile(
        destinationPath,
        fsConstants.O_WRONLY |
          fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          noFollow,
        0o600,
      );
      destinationCreated = true;
    } catch (error) {
      throw new DestinationFileCopyError(destinationPath, error);
    }
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let remaining = expectedIdentity.byteSize;
    while (remaining > 0) {
      let bytesRead;
      try {
        ({ bytesRead } = await sourceHandle.read(
          buffer,
          0,
          Math.min(buffer.length, remaining),
          null,
        ));
      } catch (error) {
        throw new SourceFileCopyError(sourcePath, error);
      }
      if (bytesRead === 0) {
        throw new SourceFileChangedError(sourcePath);
      }
      let written = 0;
      while (written < bytesRead) {
        let result;
        try {
          result = await destinationHandle.write(
            buffer,
            written,
            bytesRead - written,
            null,
          );
        } catch (error) {
          throw new DestinationFileCopyError(destinationPath, error);
        }
        written += result.bytesWritten;
      }
      remaining -= bytesRead;
    }
    let extra;
    try {
      extra = await sourceHandle.read(buffer, 0, 1, null);
    } catch (error) {
      throw new SourceFileCopyError(sourcePath, error);
    }
    if (extra.bytesRead !== 0) {
      throw new SourceFileChangedError(sourcePath);
    }
    const afterInfo = await sourceHandle.stat();
    if (!sameIdentity(afterInfo, fileIdentity(beforeInfo))) {
      throw new SourceFileChangedError(sourcePath);
    }
    copyComplete = true;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    if (destinationHandle) {
      try {
        await destinationHandle.close();
        completed = copyComplete;
      } catch (error) {
        failure = new DestinationFileCopyError(destinationPath, error);
      }
    }
    if (sourceHandle) {
      try {
        await sourceHandle.close();
      } catch (error) {
        failure ??= new SourceFileCopyError(sourcePath, error);
      }
    }
    if (destinationCreated && !completed) {
      try {
        await removeFile(destinationPath, { force: true });
      } catch (error) {
        failure = new DestinationFileCopyError(destinationPath, error);
      }
    }
    if (failure) {
      throw failure;
    }
  }
}

export async function readVerifiedFile(
  sourcePath,
  expectedIdentity,
  maxBytes,
  { openFile = open } = {},
) {
  if (expectedIdentity.byteSize > maxBytes) {
    throw new Error(
      `${sourcePath} is ${expectedIdentity.byteSize} bytes; the safety limit is ${maxBytes}.`,
    );
  }
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  let handle;
  try {
    try {
      handle = await openFile(sourcePath, fsConstants.O_RDONLY | noFollow);
    } catch (error) {
      throw new SourceFileCopyError(sourcePath, error);
    }
    const beforeInfo = await handle.stat();
    if (!beforeInfo.isFile() || !sameIdentity(beforeInfo, expectedIdentity)) {
      throw new SourceFileChangedError(sourcePath);
    }
    const content = Buffer.allocUnsafe(expectedIdentity.byteSize);
    let offset = 0;
    while (offset < content.length) {
      const { bytesRead } = await handle.read(
        content,
        offset,
        content.length - offset,
        null,
      );
      if (bytesRead === 0) {
        throw new SourceFileChangedError(sourcePath);
      }
      offset += bytesRead;
    }
    const extra = Buffer.allocUnsafe(1);
    if ((await handle.read(extra, 0, 1, null)).bytesRead !== 0) {
      throw new SourceFileChangedError(sourcePath);
    }
    const afterInfo = await handle.stat();
    if (!sameIdentity(afterInfo, fileIdentity(beforeInfo))) {
      throw new SourceFileChangedError(sourcePath);
    }
    return content;
  } finally {
    await handle?.close();
  }
}
