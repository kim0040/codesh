import type { KeyBinding } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import type { Platform } from "../../../lib/platform";
import { SHORTCUTS, type ShortcutId } from "../../../lib/shortcuts";
import { appKeymap, baseKeymap, cmKeyName, sublimeKeymap, undoKeymap } from "./keymaps";

const PLATFORMS: Platform[] = ["mac", "windows", "other"];
const CM_PLATFORM = { mac: "mac", windows: "win", other: "linux" } as const;

/** Modifier-sorted, platform-resolved spelling: "Shift-Mod-k" and "Mod-Shift-k" compare equal. */
function canonical(name: string, platform: Platform): string {
  const parts = name.split(/-(?!$)/);
  let key = parts.pop() ?? "";
  const mods = new Set<string>();
  for (const part of parts) {
    const mod = part.toLowerCase();
    if (mod === "mod") mods.add(platform === "mac" ? "meta" : "ctrl");
    else if (mod === "cmd" || mod === "meta") mods.add("meta");
    else if (mod === "ctrl" || mod === "control") mods.add("ctrl");
    else if (mod === "alt" || mod === "option") mods.add("alt");
    else if (mod === "shift") mods.add("shift");
  }
  if (key.length === 1 && key !== key.toLowerCase()) {
    mods.add("shift");
    key = key.toLowerCase();
  }
  return [...[...mods].sort(), key].join("-");
}

function boundKeys(platform: Platform, bindings: readonly KeyBinding[]): Set<string> {
  const bound = new Set<string>();
  for (const binding of bindings) {
    // CodeMirror reads the platform's own property first and `key` otherwise.
    const name = binding[CM_PLATFORM[platform]] || binding.key;
    if (!name) continue;
    bound.add(canonical(name, platform));
    if (binding.shift) bound.add(canonical(`Shift-${name}`, platform));
  }
  return bound;
}

const CODEMIRROR_IDS = (Object.keys(SHORTCUTS) as ShortcutId[]).filter(
  (id) => SHORTCUTS[id].handler === "codemirror",
);

describe("editor key maps", () => {
  for (const platform of PLATFORMS) {
    it(`binds every shortcut the sheet shows on ${platform}`, () => {
      const bound = boundKeys(platform, [...undoKeymap, ...baseKeymap]);
      for (const id of CODEMIRROR_IDS) {
        for (const chord of SHORTCUTS[id].chords[platform]) {
          const name = canonical(cmKeyName(chord), platform);
          expect(bound.has(name), `${id} on ${platform}: ${name}`).toBe(true);
        }
      }
    });
  }

  it("keeps Windows-only and Mac-only bindings on their platform", () => {
    expect(boundKeys("mac", appKeymap).has("alt-ctrl-k")).toBe(false);
    expect(boundKeys("windows", appKeymap).has("alt-ctrl-k")).toBe(true);
    expect(boundKeys("other", appKeymap).has("alt-ctrl-k")).toBe(true);
    expect(boundKeys("mac", appKeymap).has("ctrl-g")).toBe(true);
    expect(boundKeys("windows", appKeymap).has("ctrl-g")).toBe(false);
  });

  it("does not bind Option+letter on a Mac, where it types characters", () => {
    const optionOnly = [
      ...boundKeys("mac", [...undoKeymap, ...baseKeymap, ...sublimeKeymap]),
    ].filter((name) => /^alt-[a-z]$/.test(name));
    expect(optionOnly).toEqual([]);
  });

  it("does not let a window-level shortcut shadow an editor binding", () => {
    for (const platform of PLATFORMS) {
      const bound = boundKeys(platform, [...undoKeymap, ...baseKeymap, ...sublimeKeymap]);
      for (const id of Object.keys(SHORTCUTS) as ShortcutId[]) {
        if (SHORTCUTS[id].handler !== "window") continue;
        for (const chord of SHORTCUTS[id].chords[platform]) {
          if (chord.key) continue;
          const name = canonical(cmKeyName(chord), platform);
          expect(bound.has(name), `${id} on ${platform} collides with ${name}`).toBe(false);
        }
      }
    }
  });
});
