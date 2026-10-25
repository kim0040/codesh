/** The product version compiled into the build (root package.json), for the footer. */
export function buildVersion(): string {
  const value: unknown = import.meta.env.VITE_APP_VERSION;
  return typeof value === "string" && value ? value : "0.0.0";
}
