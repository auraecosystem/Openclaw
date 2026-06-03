import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

type MemoryIndexFileOps = {
  copyFile: typeof fs.copyFile;
  rename: typeof fs.rename;
  rm: typeof fs.rm;
  unlink: typeof fs.unlink;
  wait: (ms: number) => Promise<void>;
};

type MemoryIndexFileOptions = {
  fileOps?: MemoryIndexFileOps;
  maxRenameAttempts?: number;
  renameRetryDelayMs?: number;
  maxRemoveAttempts?: number;
  removeRetryDelayMs?: number;
};

type ResolvedMemoryIndexFileOptions = Required<MemoryIndexFileOptions>;

const defaultFileOps: MemoryIndexFileOps = {
  copyFile: fs.copyFile,
  rename: fs.rename,
  rm: fs.rm,
  unlink: fs.unlink,
  wait: sleep,
};

const transientFileErrorCodes = new Set(["EBUSY", "EPERM", "EACCES"]);
const defaultMaxRenameAttempts = 6;
const defaultRenameRetryDelayMs = 25;
const defaultMaxRemoveAttempts = 10;
const defaultRemoveRetryDelayMs = 50;

function isTransientFileError(err: unknown): boolean {
  return transientFileErrorCodes.has((err as NodeJS.ErrnoException).code ?? "");
}

function isFileErrorCode(err: unknown, code: string): boolean {
  return (err as NodeJS.ErrnoException).code === code;
}

function resolveMemoryIndexFileOptions(
  options: MemoryIndexFileOptions = {},
): ResolvedMemoryIndexFileOptions {
  return {
    fileOps: options.fileOps ?? defaultFileOps,
    maxRenameAttempts: Math.max(1, options.maxRenameAttempts ?? defaultMaxRenameAttempts),
    renameRetryDelayMs: options.renameRetryDelayMs ?? defaultRenameRetryDelayMs,
    maxRemoveAttempts: Math.max(1, options.maxRemoveAttempts ?? defaultMaxRemoveAttempts),
    removeRetryDelayMs: options.removeRetryDelayMs ?? defaultRemoveRetryDelayMs,
  };
}

async function renameWithRetry(
  source: string,
  target: string,
  options: ResolvedMemoryIndexFileOptions,
): Promise<void> {
  for (let attempt = 1; attempt <= options.maxRenameAttempts; attempt++) {
    try {
      await options.fileOps.rename(source, target);
      return;
    } catch (err) {
      if (isFileErrorCode(err, "ENOENT")) {
        return;
      }
      if (!isTransientFileError(err) || attempt === options.maxRenameAttempts) {
        if (isFileErrorCode(err, "EPERM")) {
          await options.fileOps.copyFile(source, target);
          await options.fileOps.unlink(source);
          return;
        }
        throw err;
      }
      await options.fileOps.wait(options.renameRetryDelayMs * attempt);
    }
  }
  throw new Error("rename retry loop exited unexpectedly");
}

export async function moveMemoryIndexFiles(
  sourceBase: string,
  targetBase: string,
  options: MemoryIndexFileOptions = {},
): Promise<void> {
  const resolvedOptions = resolveMemoryIndexFileOptions(options);
  const suffixes = ["", "-wal", "-shm"];
  for (const suffix of suffixes) {
    const source = `${sourceBase}${suffix}`;
    const target = `${targetBase}${suffix}`;
    await renameWithRetry(source, target, resolvedOptions);
  }
}

async function rmWithRetry(path: string, options: ResolvedMemoryIndexFileOptions): Promise<void> {
  for (let attempt = 1; attempt <= options.maxRemoveAttempts; attempt++) {
    try {
      await options.fileOps.rm(path, { force: true });
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      if (!isTransientFileError(err) || attempt === options.maxRemoveAttempts) {
        throw err;
      }
      await options.fileOps.wait(options.removeRetryDelayMs * attempt);
    }
  }
  throw new Error("rm retry loop exited unexpectedly");
}

export async function removeMemoryIndexFiles(
  basePath: string,
  options: MemoryIndexFileOptions = {},
): Promise<void> {
  const resolvedOptions = resolveMemoryIndexFileOptions(options);
  const suffixes = ["", "-wal", "-shm"];
  for (const suffix of suffixes) {
    await rmWithRetry(`${basePath}${suffix}`, resolvedOptions);
  }
}

async function swapMemoryIndexFiles(targetPath: string, tempPath: string): Promise<void> {
  const backupPath = `${targetPath}.backup-${randomUUID()}`;
  await moveMemoryIndexFiles(targetPath, backupPath);
  try {
    await moveMemoryIndexFiles(tempPath, targetPath);
  } catch (err) {
    await moveMemoryIndexFiles(backupPath, targetPath);
    throw err;
  }
  await removeMemoryIndexFiles(backupPath);
}

export async function runMemoryAtomicReindex<T>(params: {
  targetPath: string;
  tempPath: string;
  build: () => Promise<T>;
  beforeTempCleanup?: () => Promise<void> | void;
  fileOptions?: MemoryIndexFileOptions;
}): Promise<T> {
  try {
    const result = await params.build();
    await swapMemoryIndexFiles(params.targetPath, params.tempPath);
    return result;
  } catch (err) {
    try {
      await params.beforeTempCleanup?.();
      await removeMemoryIndexFiles(params.tempPath, params.fileOptions);
    } catch (cleanupErr) {
      const aggregateErr = new AggregateError(
        [err, cleanupErr],
        "memory atomic reindex failed and temp cleanup failed",
        { cause: cleanupErr },
      );
      throw aggregateErr;
    }
    throw err;
  }
}
