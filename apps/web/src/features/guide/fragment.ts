/** The id a URL fragment names (with or without the leading #), or "" when it is not valid percent-encoding. */
export function fragmentId(hash: string): string {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  try {
    return decodeURIComponent(raw);
  } catch {
    return "";
  }
}
