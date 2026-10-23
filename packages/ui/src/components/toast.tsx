import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from "lucide-react";
import { Toast as ToastPrimitive } from "radix-ui";
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { cx } from "../lib/cx.js";
import { IconButton } from "./icon-button.js";

export type ToastTone = "neutral" | "success" | "warning" | "danger" | "info";

export interface ToastOptions {
  title: ReactNode;
  description?: ReactNode;
  tone?: ToastTone;
  /** Milliseconds before auto-dismiss; the timer pauses while the stack is hovered or focused. */
  duration?: number;
  action?: {
    label: string;
    /** Text read by screen readers when the action is not reachable by sight. */
    altText: string;
    onClick: () => void;
  };
}

interface ToastRecord extends ToastOptions {
  id: string;
  open: boolean;
}

const MAX_TOASTS = 5;
let records: ToastRecord[] = [];
let counter = 0;
const listeners = new Set<() => void>();

function publish(next: ToastRecord[]) {
  records = next;
  for (const listener of listeners) listener();
}

/** Queues a toast and returns its id. Works anywhere; a single <Toaster /> renders the queue. */
export function toast(options: ToastOptions): string {
  const id = `toast-${++counter}`;
  publish([...records, { ...options, id, open: true }].slice(-MAX_TOASTS));
  return id;
}

toast.dismiss = (id?: string) => {
  publish(records.map((r) => (id === undefined || r.id === id ? { ...r, open: false } : r)));
};

function remove(id: string) {
  publish(records.filter((r) => r.id !== id));
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const icons: Record<ToastTone, ReactNode> = {
  neutral: null,
  success: <CircleCheck className="text-success-text" />,
  warning: <TriangleAlert className="text-warning-text" />,
  danger: <CircleAlert className="text-danger-text" />,
  info: <Info className="text-info-text" />,
};

const GAP = 12;
const VISIBLE = 3;

export interface ToasterProps {
  /** Name of the notification region, e.g. "Notifications". */
  label: string;
  closeLabel: string;
  /** Pixels from the viewport edge are set in CSS; `bottom-end` is the only placement. */
  className?: string;
}

/**
 * Mount once at the app root. Toasts stack (newest in front); hovering or focusing the stack
 * spreads it out and pauses all timers. Swipe right or press Escape on a focused toast to dismiss.
 * Each toast is announced politely; use `tone: "danger"` for the ones that need attention.
 */
export function Toaster({ label, closeLabel, className }: ToasterProps) {
  const items = useSyncExternalStore(
    subscribe,
    () => records,
    () => records,
  );
  const [heights, setHeights] = useState<Record<string, number>>({});

  const setHeight = useCallback((id: string, height: number) => {
    setHeights((prev) => (prev[id] === height ? prev : { ...prev, [id]: height }));
  }, []);

  const visible = items;
  const frontId = visible[visible.length - 1]?.id;
  const frontHeight = frontId ? (heights[frontId] ?? 64) : 64;

  return (
    <ToastPrimitive.Provider label={label} swipeDirection="right" duration={5000}>
      {visible.map((item, index) => {
        const n = visible.length - 1 - index;
        const newer = visible.slice(index + 1);
        const offset = newer.reduce((sum, other) => sum + (heights[other.id] ?? 64) + GAP, 0);
        return (
          <ToastView
            key={item.id}
            item={item}
            n={n}
            offset={offset}
            frontHeight={frontHeight}
            closeLabel={closeLabel}
            onHeight={setHeight}
          />
        );
      })}
      <ToastPrimitive.Viewport
        className={cx(
          "ui-toast-viewport fixed inset-e-0 bottom-0 z-(--z-toast) m-0 h-0 w-full max-w-sm list-none p-0 outline-none",
          className,
        )}
      />
    </ToastPrimitive.Provider>
  );
}

function ToastView({
  item,
  n,
  offset,
  frontHeight,
  closeLabel,
  onHeight,
}: {
  item: ToastRecord;
  n: number;
  offset: number;
  frontHeight: number;
  closeLabel: string;
  onHeight: (id: string, height: number) => void;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const tone = item.tone ?? "neutral";

  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const measure = () => onHeight(item.id, body.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(body);
    return () => observer.disconnect();
  }, [item.id, onHeight]);

  const style = {
    "--n": n,
    "--offset": `${offset}px`,
    "--h": `${frontHeight}px`,
  } as CSSProperties;

  return (
    <ToastPrimitive.Root
      open={item.open}
      duration={item.duration}
      onOpenChange={(open) => {
        if (open) return;
        toast.dismiss(item.id);
        window.setTimeout(() => remove(item.id), 260);
      }}
      data-n={n}
      data-hidden={n >= VISIBLE || undefined}
      style={style}
      className="ui-toast overflow-hidden rounded-lg border border-line bg-overlay text-fg [box-shadow:var(--edge),var(--elev-3)]"
    >
      <div ref={bodyRef} className="ui-toast-body flex items-start gap-3 p-3 pe-2">
        {icons[tone] ? (
          <span className="mt-0.5 flex shrink-0 [&_svg]:size-4">{icons[tone]}</span>
        ) : null}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <ToastPrimitive.Title className="text-body-sm font-medium">
            {item.title}
          </ToastPrimitive.Title>
          {item.description ? (
            <ToastPrimitive.Description className="text-caption text-fg-2">
              {item.description}
            </ToastPrimitive.Description>
          ) : null}
          {item.action ? (
            <ToastPrimitive.Action
              altText={item.action.altText}
              onClick={item.action.onClick}
              className="mt-1.5 self-start rounded-sm text-label font-medium text-accent-text underline-offset-2 hover:underline"
            >
              {item.action.label}
            </ToastPrimitive.Action>
          ) : null}
        </div>
        <ToastPrimitive.Close asChild>
          <IconButton aria-label={closeLabel} size="xs">
            <X aria-hidden="true" />
          </IconButton>
        </ToastPrimitive.Close>
      </div>
    </ToastPrimitive.Root>
  );
}
