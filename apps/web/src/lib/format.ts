/** Small formatting and clipboard helpers shared by the screens. */

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** "482913" -> "482 913" */
export function groupCode(code: string): string {
  return code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}

export function shareUrl(id: string, editKey?: string): string {
  const base = `${window.location.origin}/${id}`;
  return editKey ? `${base}?key=${encodeURIComponent(editKey)}` : base;
}

export function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // `navigator.clipboard` only exists on https and localhost; a plain-http server needs this.
    return copyWithSelection(text);
  }
}

function copyWithSelection(text: string): boolean {
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  // A modal dialog pulls focus back from anything outside it, which would drop the selection.
  const host = previous?.closest<HTMLElement>('[role="dialog"]') ?? document.body;
  const area = document.createElement("textarea");
  area.value = text;
  // Read-only keeps the on-screen keyboard down on phones; 16px stops iOS from zooming in.
  area.setAttribute("readonly", "");
  area.setAttribute("aria-hidden", "true");
  area.style.cssText =
    "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;font-size:16px;pointer-events:none";
  host.append(area);
  area.focus({ preventScroll: true });
  area.select();
  // iOS Safari ignores select() on a textarea.
  area.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  area.remove();
  previous?.focus({ preventScroll: true });
  return ok;
}

export function triggerDownload(url: string, filename?: string): void {
  const link = document.createElement("a");
  link.href = url;
  if (filename) link.download = filename;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  triggerDownload(url, filename);
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function firstLines(text: string, lines = 6): string {
  const parts = text.split("\n");
  return parts.slice(0, lines).join("\n");
}

/** Last path segment. */
export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1) || path;
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\.|$)/i;

/**
 * A file name every desktop can save: Windows refuses <>:"/\|?* and control characters, names
 * that end in a dot or a space, and device names such as CON or NUL (with any extension).
 */
export function safeFileName(name: string, fallback = "file.txt"): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it removes
  let safe = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/, "");
  if (!safe.trim()) return fallback;
  if (WINDOWS_RESERVED.test(safe)) safe = `_${safe}`;
  return safe;
}

/** `safeFileName` for each folder and the file of a path inside an archive. */
export function safeFilePath(path: string, fallback = "file.txt"): string {
  const parts = path
    .split(/[\\/]+/)
    .filter((part) => part && part !== "." && part !== "..")
    .map((part) => safeFileName(part, "_"));
  return parts.join("/") || fallback;
}

export function parentDir(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}

export function clampIndex(value: number, length: number): number {
  return Math.min(length - 1, Math.max(0, value));
}
