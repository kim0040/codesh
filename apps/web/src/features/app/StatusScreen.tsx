import { EmptyState, type EmptyStateProps } from "@gachipad/ui";

/** A full-page notice: expired, removed, not found, failed to load. */
export function StatusScreen(props: EmptyStateProps) {
  return (
    <main id="main" className="grid min-h-dvh place-items-center px-4 py-12">
      <EmptyState {...props} headingLevel={1} />
    </main>
  );
}
