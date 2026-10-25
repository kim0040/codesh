/**
 * Files from a drop, with folders expanded. Browsers hide folder contents behind
 * `webkitGetAsEntry`; each file gets `gachipadPath` so uploads keep their relative path.
 */

interface FsEntry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  fullPath: string;
  file?(success: (file: File) => void, failure: (error: unknown) => void): void;
  createReader?(): {
    readEntries(success: (entries: FsEntry[]) => void, failure: (error: unknown) => void): void;
  };
}

const JUNK_NAME = /^(\.DS_Store|Thumbs\.db|desktop\.ini|\.localized|\._.*|~\$.*)$/i;
const JUNK_FOLDER = /(^|\/)(__MACOSX|\.Spotlight-V100|\.Trashes|\$RECYCLE\.BIN)(\/|$)/i;

/**
 * Files a file manager adds on its own (Finder's .DS_Store and ._ copies, Explorer's Thumbs.db and
 * desktop.ini, Office lock files). They would only show up as unreadable "binary" skips.
 */
export function isJunkFile(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return JUNK_NAME.test(name) || JUNK_FOLDER.test(path);
}

async function readAll(entry: FsEntry): Promise<File[]> {
  if (entry.isFile && entry.file) {
    if (isJunkFile(entry.fullPath)) return [];
    const file = await new Promise<File>((resolve, reject) => entry.file?.(resolve, reject));
    (file as File & { gachipadPath?: string }).gachipadPath = entry.fullPath.replace(/^\//, "");
    return [file];
  }
  if (entry.isDirectory && entry.createReader) {
    const reader = entry.createReader();
    const files: File[] = [];
    // readEntries returns batches until it returns an empty one.
    for (;;) {
      const batch = await new Promise<FsEntry[]>((resolve, reject) =>
        reader.readEntries(resolve, reject),
      );
      if (batch.length === 0) break;
      for (const child of batch) files.push(...(await readAll(child)));
    }
    return files;
  }
  return [];
}

export async function collectDroppedFiles(transfer: DataTransfer): Promise<File[]> {
  const entries: FsEntry[] = [];
  for (const item of Array.from(transfer.items ?? [])) {
    if (item.kind !== "file") continue;
    const entry = (
      item as DataTransferItem & { webkitGetAsEntry?: () => FsEntry | null }
    ).webkitGetAsEntry?.();
    if (entry) entries.push(entry);
  }
  if (entries.length === 0) return Array.from(transfer.files);
  const nested = await Promise.all(entries.map(readAll));
  return nested.flat();
}
