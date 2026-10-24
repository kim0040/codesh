import type { MessageKey, TFunction } from "@codesh/i18n";
import { Dialog, DialogContent, KbdGroup } from "@codesh/ui";
import { Fragment } from "react";
import { useT } from "../../lib/i18n";
import { setShortcutsOpen, useOverlays } from "../../lib/overlays";
import { PLATFORM } from "../../lib/platform";
import { chordKeys, chordsFor, SHORTCUTS, type ShortcutId } from "../../lib/shortcuts";

/** One line of the sheet: what it does, and the shortcuts (several ids share one line). */
interface Row {
  ids: readonly ShortcutId[];
  label?: MessageKey;
  /** Not a binding of ours: the browser's Esc then Tab way out of a text field. */
  keys?: readonly string[];
}

const GROUPS: { title: MessageKey; rows: Row[] }[] = [
  {
    title: "shortcuts.group.general",
    rows: [
      { ids: ["palette"] },
      { ids: ["shortcuts"] },
      { ids: ["share"] },
      { ids: ["settings"] },
      { ids: ["comments"] },
      { ids: ["history"] },
    ],
  },
  {
    title: "shortcuts.group.editing",
    rows: [
      { ids: ["find"] },
      { ids: ["findNext"] },
      { ids: ["replace"] },
      { ids: ["copyAll"] },
      { ids: ["format"] },
      { ids: ["selectNext"] },
      { ids: ["selectMatches"] },
      { ids: ["addCursorAbove", "addCursorBelow"], label: "shortcuts.item.addCursor" },
      { ids: ["addCursorClick"] },
      { ids: ["rectangleSelect"] },
      { ids: ["moveLineUp", "moveLineDown"] },
      { ids: ["copyLineDown"] },
      { ids: ["deleteLine"] },
      { ids: ["toggleComment"] },
      { ids: ["indentMore", "indentLess"] },
      { ids: ["fold", "unfold"] },
      { ids: ["undo"] },
      { ids: ["redo"] },
    ],
  },
  {
    title: "shortcuts.group.navigation",
    rows: [
      { ids: ["goToLine"] },
      { ids: ["wordLeft", "wordRight"] },
      { ids: ["lineStart", "lineEnd"] },
      { ids: ["docStart", "docEnd"] },
      { ids: ["deleteWordBack"] },
      { ids: [], label: "shortcuts.item.leaveEditor", keys: ["Esc", "Tab"] },
    ],
  },
];

const MOUSE_WORDS: Record<string, MessageKey> = {
  click: "shortcuts.key.click",
  drag: "shortcuts.key.drag",
};

/** The key combinations of a row on this OS: each id's chords, one group of key caps each. */
function combosOf(row: Row, t: TFunction): string[][] {
  if (row.keys) return [[...row.keys]];
  return row.ids.flatMap((id) =>
    chordsFor(id).map((chord) =>
      chordKeys(chord).map((key) => (MOUSE_WORDS[key] ? t(MOUSE_WORDS[key]) : key)),
    ),
  );
}

/** What differs on this device, said once instead of being hidden in a tooltip. */
function notesFor(): MessageKey[] {
  const notes: MessageKey[] = [];
  if (PLATFORM === "mac") {
    notes.push("shortcuts.note.mac", "shortcuts.note.macClick");
    // iPadOS identifies as a Mac; only the touch screen tells them apart.
    if (typeof navigator !== "undefined" && navigator.maxTouchPoints > 1) {
      notes.push("shortcuts.note.ipad");
    }
  } else {
    notes.push(PLATFORM === "windows" ? "shortcuts.note.windows" : "shortcuts.note.linux");
    notes.push("shortcuts.note.firefox", "shortcuts.note.keymaps");
  }
  notes.push("shortcuts.note.ime");
  return notes;
}

export function ShortcutSheet() {
  const t = useT();
  const { shortcuts } = useOverlays();
  return (
    <Dialog open={shortcuts} onOpenChange={setShortcutsOpen}>
      <DialogContent title={t("shortcuts.title")} closeLabel={t("common.close")} size="md">
        <div className="flex flex-col gap-5" data-testid="shortcut-sheet">
          {GROUPS.map((group) => (
            <section key={group.title} aria-labelledby={`sc-${group.title}`}>
              <h3 id={`sc-${group.title}`} className="mb-2 text-caption font-medium text-fg-3">
                {t(group.title)}
              </h3>
              <ul className="flex flex-col divide-y divide-line">
                {group.rows.map((row) => {
                  const id = row.ids[0];
                  const label = row.label ?? (id ? SHORTCUTS[id].label : "shortcuts.title");
                  return (
                    <li
                      key={label}
                      data-testid={`shortcut-${id ?? "leave"}`}
                      className="flex items-center justify-between gap-4 py-2"
                    >
                      <span className="min-w-0 text-body-sm text-fg">{t(label)}</span>
                      <span className="flex shrink-0 flex-wrap items-center justify-end gap-x-1 gap-y-1">
                        {combosOf(row, t).map((keys, index) => (
                          <Fragment key={keys.join("+")}>
                            {index > 0 ? (
                              <span aria-hidden="true" className="text-caption text-fg-3">
                                /
                              </span>
                            ) : null}
                            <KbdGroup keys={keys} />
                          </Fragment>
                        ))}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
          <section aria-labelledby="sc-notes">
            <h3 id="sc-notes" className="mb-2 text-caption font-medium text-fg-3">
              {t("shortcuts.notes.title")}
            </h3>
            <ul className="flex flex-col gap-2 text-body-sm text-fg-2" data-testid="shortcut-notes">
              {notesFor().map((note) => (
                <li key={note}>{t(note)}</li>
              ))}
            </ul>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
