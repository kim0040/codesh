import { Dialog, DialogContent, KbdGroup } from "@codesh/ui";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { api } from "../../lib/api";
import { type Command, matchCommand, useCommands } from "../../lib/commands";
import { useT } from "../../lib/i18n";
import { openTemplates, setPaletteOpen, useOverlays } from "../../lib/overlays";

const MAX_RESULTS = 40;

/** ⌘K: every action the open screen registered, plus my shares and the pages of the app. */
export function CommandPalette() {
  const { palette } = useOverlays();
  const t = useT();
  return (
    <Dialog open={palette} onOpenChange={setPaletteOpen}>
      <DialogContent
        title={t("palette.label")}
        hideTitle
        closeLabel={t("common.close")}
        size="lg"
        className="top-[10dvh] bottom-auto m-0 mx-auto"
      >
        {palette ? <PaletteBody /> : null}
      </DialogContent>
    </Dialog>
  );
}

function PaletteBody() {
  const t = useT();
  const navigate = useNavigate();
  const registered = useCommands();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);

  const shares = useQuery({
    queryKey: ["shares"],
    queryFn: ({ signal }) => api.listShares(signal),
  });

  const commands = useMemo<Command[]>(() => {
    const go = (to: string) => () => void navigate({ to });
    const base: Command[] = [
      { id: "nav.home", label: t("nav.home"), group: t("palette.group.go"), run: go("/") },
      { id: "nav.me", label: t("nav.myShares"), group: t("palette.group.go"), run: go("/me") },
      { id: "nav.new", label: t("share.new"), group: t("palette.group.go"), run: go("/new") },
      {
        id: "nav.template",
        label: t("palette.newFromTemplate"),
        group: t("palette.group.go"),
        keywords: t("template.title"),
        run: openTemplates,
      },
    ];
    const shareItems: Command[] = (shares.data ?? []).slice(0, 12).map((share) => ({
      id: `share.${share.id}`,
      label: share.title || t("common.untitled"),
      group: t("palette.group.shares"),
      keywords: `${share.id} ${share.language}`,
      run: () => void navigate({ to: "/$id", params: { id: share.id } }),
    }));
    return [...registered, ...base, ...shareItems];
  }, [registered, shares.data, navigate, t]);

  const results = useMemo(
    () => commands.filter((command) => matchCommand(command, query)).slice(0, MAX_RESULTS),
    [commands, query],
  );

  useEffect(() => {
    listRef.current?.children[active]?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const run = (command: Command | undefined) => {
    if (!command) return;
    setPaletteOpen(false);
    // Let the dialog release focus first so the command can move it somewhere else.
    window.setTimeout(command.run, 0);
  };

  let lastGroup = "";
  return (
    <div className="-mx-1 flex flex-col gap-2">
      <div className="flex items-center gap-2 rounded-md border border-line-control bg-panel px-3 focus-within:border-accent-text">
        <Search aria-hidden="true" className="size-4 shrink-0 text-fg-3" />
        <input
          // biome-ignore lint/a11y/noAutofocus: the palette exists to be typed into
          autoFocus
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={results[active] ? `${listId}-${active}` : undefined}
          aria-label={t("palette.label")}
          placeholder={t("palette.placeholder")}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            // Enter that finishes a Korean (IME) syllable is not a choice yet.
            if (event.nativeEvent.isComposing) return;
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActive((index) => Math.min(results.length - 1, index + 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActive((index) => Math.max(0, index - 1));
            } else if (event.key === "Enter") {
              event.preventDefault();
              run(results[active]);
            }
          }}
          className="h-10 min-w-0 flex-1 bg-transparent text-body-sm outline-none placeholder:text-fg-3 coarse:text-base"
        />
      </div>
      <div
        ref={listRef}
        id={listId}
        role="listbox"
        aria-label={t("palette.label")}
        className="max-h-[50dvh] overflow-y-auto"
      >
        {results.map((command, index) => {
          const header = command.group !== lastGroup;
          lastGroup = command.group;
          return (
            <div key={command.id} role="presentation">
              {header ? (
                <div className="px-2 pt-2 pb-1 text-caption text-fg-3">{command.group}</div>
              ) : null}
              <div
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === active}
                tabIndex={-1}
                onMouseMove={() => setActive(index)}
                onClick={() => run(command)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") run(command);
                }}
                className="flex min-h-9 cursor-default items-center gap-3 rounded-md px-2 py-1.5 text-body-sm aria-selected:bg-fill-hover coarse:min-h-11 [&_svg]:size-4 [&_svg]:text-fg-3"
              >
                {command.icon}
                <span className="min-w-0 flex-1 truncate">{command.label}</span>
                {command.shortcut ? <KbdGroup keys={command.shortcut} /> : null}
              </div>
            </div>
          );
        })}
      </div>
      {results.length === 0 ? (
        <p role="status" className="px-2 py-6 text-center text-body-sm text-fg-3">
          {t("palette.empty")}
        </p>
      ) : null}
    </div>
  );
}
