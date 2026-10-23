import { createContext, type ReactNode, use, useState } from "react";
import { cx } from "../src/index.js";

/** Portal target for floating UI shown inside a themed panel. */
export const PanelContainer = createContext<HTMLElement | null>(null);
export const usePanelContainer = () => use(PanelContainer);

export function ThemePanel({
  theme,
  children,
  className,
}: {
  theme: "dark" | "light";
  children: ReactNode;
  className?: string;
}) {
  const [node, setNode] = useState<HTMLElement | null>(null);
  return (
    <div
      ref={setNode}
      data-theme={theme}
      data-panel={theme}
      className={cx(
        "relative min-w-0 rounded-xl border border-line bg-panel p-4 text-fg",
        className,
      )}
    >
      <p className="mb-3 text-caption font-medium uppercase tracking-wider text-fg-3">{theme}</p>
      <PanelContainer value={node}>{children}</PanelContainer>
    </div>
  );
}

/** Renders the same children in a dark and a light panel, side by side from 48rem. */
export function ThemePair({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <ThemePanel theme="dark" className={className}>
        {children}
      </ThemePanel>
      <ThemePanel theme="light" className={className}>
        {children}
      </ThemePanel>
    </div>
  );
}

export function Section({
  id,
  title,
  note,
  children,
}: {
  id: string;
  title: string;
  note?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="flex scroll-mt-20 flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 id={`${id}-title`} className="text-title font-semibold">
          {title}
        </h2>
        {note ? <p className="max-w-prose text-body-sm text-fg-2">{note}</p> : null}
      </div>
      {children}
    </section>
  );
}

export function Row({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("flex flex-wrap items-center gap-2", className)}>{children}</div>;
}

export function Label({ children }: { children: ReactNode }) {
  return <p className="mb-1.5 mt-3 text-caption text-fg-3 first:mt-0">{children}</p>;
}
