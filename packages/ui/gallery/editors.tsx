import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import {
  contrastRatio,
  EDITOR_THEMES,
  type EditorTheme,
  GALLERY_LANGUAGES,
  getLanguage,
  SAMPLES,
  TOKEN_NAMES,
} from "@gachipad/highlight";
import { useEffect, useRef, useState } from "react";
import { Badge, LanguageBadge } from "../src/index.js";
import { Section } from "./lib.js";

function CodePreview({ languageId, theme }: { languageId: string; theme: EditorTheme }) {
  const host = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let view: EditorView | undefined;
    let cancelled = false;
    setReady(false);
    void (async () => {
      const support = await getLanguage(languageId)?.load();
      // Measure with the real font: line metrics change when the web font swaps in.
      await document.fonts.load('13px "JetBrains Mono Variable"');
      await document.fonts.load('italic 13px "JetBrains Mono Variable"');
      if (cancelled || !host.current) return;
      view = new EditorView({
        parent: host.current,
        state: EditorState.create({
          doc: SAMPLES[languageId] ?? "",
          extensions: [
            lineNumbers(),
            EditorState.readOnly.of(true),
            EditorView.editable.of(false),
            theme.extension,
            ...(support ? [support] : []),
          ],
        }),
      });
      setReady(true);
    })();
    return () => {
      cancelled = true;
      view?.destroy();
    };
  }, [languageId, theme]);

  return (
    <div
      ref={host}
      data-preview={ready ? "ready" : "loading"}
      className="overflow-hidden rounded-md border border-line-strong"
      style={{ minHeight: 120 }}
    />
  );
}

function TokenLegend({ theme }: { theme: EditorTheme }) {
  return (
    <ul className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3 lg:grid-cols-4">
      {TOKEN_NAMES.map((name) => {
        const color = theme.tokens[name];
        return (
          <li key={name} className="flex items-center gap-2 text-caption">
            <span
              aria-hidden="true"
              className="size-3 shrink-0 rounded-sm"
              style={{ backgroundColor: color }}
            />
            <span className="min-w-0 truncate text-fg-2">{name}</span>
            <span className="ms-auto font-mono tabular-nums text-fg-3">
              {contrastRatio(color, theme.background).toFixed(1)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export function EditorsView() {
  return (
    <div className="flex flex-col gap-12">
      {EDITOR_THEMES.map((theme) => (
        <Section
          key={theme.id}
          id={`editor-${theme.id}`}
          title={`${theme.id}`}
          note={`${theme.appearance} editor theme · ${GALLERY_LANGUAGES.length} languages · contrast ratio of each token colour against ${theme.background} on the right of the legend`}
        >
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={theme.appearance === "dark" ? "neutral" : "info"} variant="outline">
              {theme.appearance}
            </Badge>
            <span className="font-mono text-caption text-fg-3">
              bg {theme.background} · fg {theme.foreground}
            </span>
          </div>
          <TokenLegend theme={theme} />
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            {GALLERY_LANGUAGES.map((id) => {
              const entry = getLanguage(id);
              return (
                <figure key={id} className="flex min-w-0 flex-col gap-1.5 font-mono text-code">
                  <figcaption className="font-sans">
                    <LanguageBadge name={entry?.name ?? id} color={entry?.color ?? "#888888"} />
                  </figcaption>
                  <CodePreview languageId={id} theme={theme} />
                </figure>
              );
            })}
          </div>
        </Section>
      ))}
    </div>
  );
}
