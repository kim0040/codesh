import { createStore, useStore } from "./store";

/** Which app-wide overlays are open. Anything can open them; AppShell renders them. */
interface OverlayState {
  palette: boolean;
  shortcuts: boolean;
  templates: boolean;
}

const overlays = createStore<OverlayState>({ palette: false, shortcuts: false, templates: false });

export const openPalette = () => overlays.set((s) => ({ ...s, palette: true }));
export const openShortcuts = () => overlays.set((s) => ({ ...s, shortcuts: true }));
export const openTemplates = () => overlays.set((s) => ({ ...s, templates: true }));
export const setPaletteOpen = (palette: boolean) => overlays.set((s) => ({ ...s, palette }));
export const setShortcutsOpen = (shortcuts: boolean) => overlays.set((s) => ({ ...s, shortcuts }));
export const setTemplatesOpen = (templates: boolean) => overlays.set((s) => ({ ...s, templates }));
export const useOverlays = () => useStore(overlays);
