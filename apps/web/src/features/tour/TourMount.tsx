import { type ComponentType, useCallback, useEffect, useRef, useState } from "react";
import { useOverlays } from "../../lib/overlays";
import { usePrefs } from "../../lib/prefs";
import { useEditor } from "../editor/context";
import { modalIsOpen, useModalOpen } from "./modal-open";
import { tourSeen, useTourRequests } from "./seen";
import { availableSteps } from "./steps";
import type { TourProps } from "./Tour";

/** The editor settles for a moment before the tour comes in. */
const AUTO_DELAY_MS = 700;
/** The settings sheet is still sliding out for 260ms after Replay is pressed. */
const REPLAY_DELAY_MS = 320;

/**
 * Decides when the tour runs and loads its code only then: the first editor visit of a browser
 * (once the device question is answered and no dialog is open), or Settings > Replay tutorial.
 * Its code loads only then; the service worker still precaches the chunk so it works offline.
 */
export function TourMount() {
  const ctx = useEditor();
  const overlays = useOverlays();
  const prefs = usePrefs();
  const requests = useTourRequests();
  const [seen, setSeen] = useState(tourSeen);
  const [running, setRunning] = useState(false);
  const [runKey, setRunKey] = useState(0);
  const [replay, setReplay] = useState(false);
  // The code could not be fetched (offline, blocked): do not try again in a loop.
  const [failed, setFailed] = useState(false);
  const [Tour, setTour] = useState<ComponentType<TourProps> | null>(null);
  const handled = useRef(requests);

  // Any modal dialog counts, including the ones a feature owns (file naming, delete), not only the
  // panels and overlays the app keeps in its stores. Followed only while the tour could start.
  const modal = useModalOpen(running || replay || !seen);
  const blocked =
    ctx.panel.name !== null ||
    overlays.palette ||
    overlays.shortcuts ||
    overlays.templates ||
    modal;
  const asking = prefs.offlineCopy === "undecided";
  const readOnly = ctx.readOnly;

  // Fewer than two places to point at is not a tour.
  const begin = useCallback(() => {
    if (availableSteps(readOnly).length < 2) return;
    setRunKey((key) => key + 1);
    setRunning(true);
  }, [readOnly]);

  useEffect(() => {
    if (requests === handled.current) return;
    handled.current = requests;
    setReplay(true);
  }, [requests]);

  useEffect(() => {
    if (running || failed || blocked || !(replay || (!seen && !asking))) return;
    const timer = window.setTimeout(
      () => {
        // A dialog opened inside the delay and the state has not caught up yet.
        if (modalIsOpen()) return;
        setReplay(false);
        begin();
      },
      replay ? REPLAY_DELAY_MS : AUTO_DELAY_MS,
    );
    return () => window.clearTimeout(timer);
  }, [running, failed, blocked, replay, seen, asking, begin]);

  // Another dialog took over: the tour steps aside (and comes back later if it was never finished).
  useEffect(() => {
    if (running && blocked) setRunning(false);
  }, [running, blocked]);

  useEffect(() => {
    if (!running || Tour) return;
    let live = true;
    import("./Tour")
      .then((module) => live && setTour(() => module.default))
      .catch(() => {
        if (!live) return;
        setFailed(true);
        setRunning(false);
      });
    return () => {
      live = false;
    };
  }, [running, Tour]);

  const finish = useCallback(() => setSeen(true), []);
  const exited = useCallback(() => setRunning(false), []);

  return running && Tour ? <Tour key={runKey} onFinish={finish} onExited={exited} /> : null;
}
