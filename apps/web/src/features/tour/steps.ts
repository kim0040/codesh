import type { MessageKey } from "@codesh/i18n";

export type TourAnchor = "share" | "people" | "files" | "language" | "menu";

export interface TourStep {
  /** Matches `data-tour` on the element the step points at. */
  id: TourAnchor;
  title: MessageKey;
  body: MessageKey;
  /** The viewer role cannot use what the step explains. */
  editorOnly?: boolean;
}

/** In reading order of the screen: top bar left to right, then tabs, then the status bar. */
export const TOUR_STEPS: readonly TourStep[] = [
  { id: "share", title: "tour.share.title", body: "tour.share.body" },
  { id: "people", title: "tour.people.title", body: "tour.people.body" },
  { id: "files", title: "tour.files.title", body: "tour.files.body" },
  { id: "language", title: "tour.language.title", body: "tour.language.body", editorOnly: true },
  { id: "menu", title: "tour.menu.title", body: "tour.menu.body" },
];

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The element a step points at, or null when it is not drawn (hidden at this width, not mounted). */
export function anchorOf(id: TourAnchor): HTMLElement | null {
  const element = document.querySelector<HTMLElement>(`[data-tour="${id}"]`);
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  return getComputedStyle(element).visibility === "hidden" ? null : element;
}

/** The steps that can be shown right now; the others are skipped instead of pointing at nothing. */
export function availableSteps(readOnly: boolean): TourStep[] {
  return TOUR_STEPS.filter((step) => !(readOnly && step.editorOnly) && anchorOf(step.id));
}

export function boxOf(element: Element): Box {
  const { left, top, width, height } = element.getBoundingClientRect();
  return { left, top, width, height };
}
