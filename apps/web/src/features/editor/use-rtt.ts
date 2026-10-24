import { useEffect, useState } from "react";
import { rawRequest } from "../../lib/api";

const INTERVAL_MS = 5000;

/**
 * Round-trip time to the server in ms, or null while offline. The collab provider has no ping we
 * can use, so a HEAD on the cheapest API route stands in; the status bar shows it.
 */
export function useRtt(active: boolean): number | null {
  const [rtt, setRtt] = useState<number | null>(null);
  useEffect(() => {
    if (!active) {
      setRtt(null);
      return;
    }
    let cancelled = false;
    const sample = async () => {
      const started = performance.now();
      try {
        await rawRequest("HEAD", "/api/session");
        if (!cancelled) setRtt(Math.max(1, Math.round(performance.now() - started)));
      } catch {
        if (!cancelled) setRtt(null);
      }
    };
    void sample();
    const timer = window.setInterval(sample, INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [active]);
  return rtt;
}
