import type { MessageKey } from "@codesh/i18n";
import { Dialog, DialogContent, KbdGroup } from "@codesh/ui";
import { useT } from "../../lib/i18n";
import { setShortcutsOpen, useOverlays } from "../../lib/overlays";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
export const MOD = isMac ? "⌘" : "Ctrl";
const ALT = isMac ? "⌥" : "Alt";

interface Shortcut {
  label: MessageKey;
  keys: readonly string[];
}

const GROUPS: { title: MessageKey; items: Shortcut[] }[] = [
  {
    title: "shortcuts.group.general",
    items: [
      { label: "shortcuts.item.palette", keys: [MOD, "K"] },
      { label: "shortcuts.item.shortcuts", keys: ["?"] },
      { label: "shortcuts.item.share", keys: [MOD, ALT, "S"] },
      { label: "shortcuts.item.settings", keys: [MOD, ","] },
      { label: "shortcuts.item.comment", keys: [MOD, ALT, "M"] },
      { label: "shortcuts.item.history", keys: [MOD, ALT, "H"] },
    ],
  },
  {
    title: "shortcuts.group.editing",
    items: [
      { label: "shortcuts.item.find", keys: [MOD, "F"] },
      { label: "shortcuts.item.copyAll", keys: [MOD, ALT, "C"] },
      { label: "shortcuts.item.format", keys: ["Shift", ALT, "F"] },
      { label: "shortcuts.item.undo", keys: [MOD, "Z"] },
      { label: "shortcuts.item.moveLine", keys: [ALT, "↑ / ↓"] },
      { label: "shortcuts.item.leaveEditor", keys: ["Esc", "Tab"] },
    ],
  },
];

export function ShortcutSheet() {
  const t = useT();
  const { shortcuts } = useOverlays();
  return (
    <Dialog open={shortcuts} onOpenChange={setShortcutsOpen}>
      <DialogContent title={t("shortcuts.title")} closeLabel={t("common.close")} size="md">
        <div className="flex flex-col gap-5">
          {GROUPS.map((group) => (
            <section key={group.title} aria-labelledby={`sc-${group.title}`}>
              <h3 id={`sc-${group.title}`} className="mb-2 text-caption font-medium text-fg-3">
                {t(group.title)}
              </h3>
              <ul className="flex flex-col divide-y divide-line">
                {group.items.map((item) => (
                  <li key={item.label} className="flex items-center justify-between gap-4 py-2">
                    <span className="min-w-0 text-body-sm text-fg">{t(item.label)}</span>
                    <KbdGroup keys={item.keys} className="shrink-0" />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
