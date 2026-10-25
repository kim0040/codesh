let warned = false;

/** Prefer the current name, without changing the namespace used by a rolling deployment. */
export function renamedEnv(
  env: Record<string, string | undefined>,
  name: string,
  warn: (message: string) => void = console.warn,
): string | undefined {
  // legacy codesh name (1.0.x); remove in 2.0
  const legacy = name.replace(/^GACHIPAD_/, "CODESH_");
  if (env[name] !== undefined) return env[name];
  if (env[legacy] !== undefined && !warned) {
    warned = true;
    warn("Legacy product environment settings are deprecated; use GACHIPAD_ names");
  }
  return env[legacy];
}
