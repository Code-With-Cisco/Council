import {
  mkdir as nodeMkdir,
  rename as nodeRename,
  unlink as nodeUnlink,
  writeFile as nodeWriteFile,
} from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Narrow filesystem boundary used by the atomic writer. Tests can fail any
 * individual stage without replacing Node's filesystem module globally.
 */
export interface AtomicJsonFileSystem {
  mkdir(directory: string, options: { readonly recursive: true }): Promise<unknown>;
  writeFile(
    file: string,
    contents: string,
    options: { readonly encoding: 'utf8'; readonly flag: 'wx' },
  ): Promise<unknown>;
  rename(from: string, to: string): Promise<unknown>;
  unlink(file: string): Promise<unknown>;
}

const NODE_FILE_SYSTEM: AtomicJsonFileSystem = {
  mkdir: nodeMkdir,
  writeFile: nodeWriteFile,
  rename: nodeRename,
  unlink: nodeUnlink,
};

export interface AtomicJsonWriteOptions {
  readonly fileSystem?: AtomicJsonFileSystem | undefined;
  /** Injectable only so interruption tests can address the temporary file. */
  readonly temporaryId?: (() => string) | undefined;
}

/**
 * Writes formatted JSON through a unique file in the destination directory,
 * then atomically renames it over the target.
 *
 * A failed write or rename never truncates the previous target. Best-effort
 * cleanup removes the unused temporary file without masking the original
 * failure.
 */
export async function writeJsonAtomic(
  file: string,
  value: unknown,
  options: AtomicJsonWriteOptions = {},
): Promise<void> {
  const serialized = JSON.stringify(value, null, 2);
  if (serialized === undefined) {
    throw new TypeError('Atomic JSON value is not serializable.');
  }

  const fileSystem = options.fileSystem ?? NODE_FILE_SYSTEM;
  const temporaryId = options.temporaryId?.() ?? randomUUID();
  const temporaryFile = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${temporaryId}.tmp`,
  );

  await fileSystem.mkdir(path.dirname(file), { recursive: true });

  let temporaryCreated = false;
  try {
    await fileSystem.writeFile(temporaryFile, `${serialized}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    temporaryCreated = true;
    await fileSystem.rename(temporaryFile, file);
    temporaryCreated = false;
  } catch (error) {
    if (temporaryCreated) {
      try {
        await fileSystem.unlink(temporaryFile);
      } catch {
        // Cleanup is best effort. Preserve the write/rename failure as the cause.
      }
    }
    throw error;
  }
}
