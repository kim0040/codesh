import { contrastRatio, PARTICIPANT_COLORS, rgbToHex } from "@codesh/highlight";
import { type CSSProperties, type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { cx } from "../src/index.js";
import { Label, Row, Section, ThemePair } from "./lib.js";

/** Chromium resolves `light-dark()` and `color-mix()` to rgb()/color(srgb …); turn that into #rrggbb. */
function cssColorToHex(value: string): string | null {
  const rgb = /^rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)/.exec(value);
  if (rgb) return rgbToHex([Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]);
  const srgb = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(value);
  if (srgb) return rgbToHex([Number(srgb[1]) * 255, Number(srgb[2]) * 255, Number(srgb[3]) * 255]);
  return null;
}

/** Text sample showing `fg` on `bg` with the measured WCAG ratio next to it. */
function Pair({ name, fg, bg, min = 4.5 }: { name: string; fg: string; bg: string; min?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [ratio, setRatio] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const style = getComputedStyle(el);
    const a = cssColorToHex(style.color);
    const b = cssColorToHex(style.backgroundColor);
    setRatio(a && b ? contrastRatio(a, b) : null);
  });
  return (
    <div
      ref={ref}
      className="flex items-center justify-between gap-3 rounded-md border border-line px-3 py-2 text-body-sm"
      style={{ color: `var(--${fg})`, backgroundColor: `var(--${bg})` }}
    >
      <span className="min-w-0 truncate">
        {name} <span className="opacity-90">가나다 Aa</span>
      </span>
      <span
        className={cx(
          "shrink-0 font-mono text-caption tabular-nums",
          ratio !== null && ratio < min && "underline",
        )}
      >
        {ratio === null ? "…" : ratio.toFixed(2)}
      </span>
    </div>
  );
}

function Swatch({ name, varName }: { name: string; varName: string }) {
  return (
    <div className="flex flex-col gap-1">
      <div
        className="h-12 rounded-md border border-line-strong"
        style={{ backgroundColor: `var(--${varName})` }}
      />
      <span className="truncate text-caption text-fg-3">{name}</span>
    </div>
  );
}

function ColorTokens() {
  const statuses = ["accent", "success", "warning", "danger", "info"] as const;
  return (
    <>
      <Label>Surfaces</Label>
      <div className="grid grid-cols-4 gap-2">
        {["bg", "panel", "raised", "overlay"].map((n) => (
          <Swatch key={n} name={n} varName={n} />
        ))}
      </div>
      <Label>Borders</Label>
      <div className="grid grid-cols-3 gap-2">
        {["border", "border-strong", "border-control"].map((n) => (
          <Swatch key={n} name={n} varName={n} />
        ))}
      </div>
      <Label>Text on panel (≥ 4.5)</Label>
      <div className="flex flex-col gap-1.5">
        <Pair name="fg" fg="fg" bg="panel" />
        <Pair name="fg-2" fg="fg-2" bg="panel" />
        <Pair name="fg-3" fg="fg-3" bg="panel" />
        <Pair name="accent-text" fg="accent-text" bg="panel" />
      </div>
      <Label>Filled actions: label on fill, and every state (≥ 4.5)</Label>
      <div className="flex flex-col gap-1.5">
        {statuses.map((s) => (
          <div key={s} className="grid grid-cols-3 gap-1.5">
            <Pair name={s} fg={`${s}-fg`} bg={s} />
            <Pair name="hover" fg={`${s}-fg`} bg={`${s}-hover`} />
            <Pair name="active" fg={`${s}-fg`} bg={`${s}-active`} />
          </div>
        ))}
      </div>
      <Label>Status text on its soft tint, and on panel (≥ 4.5)</Label>
      <div className="flex flex-col gap-1.5">
        {statuses.map((s) => (
          <div key={s} className="grid grid-cols-2 gap-1.5">
            <Pair name={`${s}-text`} fg={`${s}-text`} bg={`${s}-soft`} />
            <Pair name={`${s}-text`} fg={`${s}-text`} bg="panel" />
          </div>
        ))}
      </div>
      <Label>Focus ring and control border on panel (≥ 3)</Label>
      <div className="grid grid-cols-2 gap-1.5">
        <Pair name="focus" fg="focus" bg="panel" min={3} />
        <Pair name="border-control" fg="border-control" bg="panel" min={3} />
      </div>
    </>
  );
}

function ShapeTokens() {
  return (
    <>
      <Label>Radii: concentric (outer = inner + padding)</Label>
      <Row className="items-end gap-4">
        {(["xs", "sm", "md", "lg", "xl"] as const).map((r) => (
          <div
            key={r}
            className="flex size-14 items-center justify-center border border-line-strong bg-raised text-caption text-fg-2"
            style={{ borderRadius: `var(--rad-${r})` }}
          >
            {r}
          </div>
        ))}
        <div className="rounded-xl border border-line bg-overlay p-1">
          <div className="rounded-lg border border-line bg-raised p-1">
            <div className="rounded-md bg-accent px-3 py-1.5 text-label text-accent-fg">nested</div>
          </div>
        </div>
      </Row>
      <Label>Elevation 1–4</Label>
      <Row className="gap-4">
        {[1, 2, 3, 4].map((n) => (
          <div
            key={n}
            className="flex size-16 items-center justify-center rounded-lg border border-line bg-raised text-caption text-fg-2"
            style={{ boxShadow: `var(--edge), var(--elev-${n})` }}
          >
            {n}
          </div>
        ))}
      </Row>
      <Label>Spacing scale (4px base)</Label>
      <div className="flex flex-col gap-1">
        {["1", "2", "3", "4", "6", "8", "12", "16"].map((n) => (
          <div key={n} className="flex items-center gap-3 text-caption text-fg-3">
            <span className="w-20 shrink-0 whitespace-nowrap font-mono">space-{n}</span>
            <span className="h-2 rounded-sm bg-accent" style={{ width: `var(--space-${n})` }} />
          </div>
        ))}
      </div>
      <Label>Motion: hover the boxes (durations collapse under reduced motion)</Label>
      <Row className="gap-3">
        {["instant", "fast", "normal", "slow"].map((d) => (
          <button
            key={d}
            type="button"
            className="group h-10 w-24 overflow-hidden rounded-md border border-line-strong bg-raised text-caption text-fg-2"
          >
            <span
              className="block h-full w-full bg-accent-soft text-accent-text transition-transform ease-out group-hover:translate-x-[60%]"
              style={{ transitionDuration: `var(--duration-${d})` }}
            >
              <span className="flex h-full items-center justify-center">{d}</span>
            </span>
          </button>
        ))}
      </Row>
    </>
  );
}

function ParticipantTokens() {
  return (
    <>
      <Label>Chip label on colour (≥ 4.5) · cursor bar on panel (≥ 3)</Label>
      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
        {PARTICIPANT_COLORS.map((_, i) => {
          const slot = i + 1;
          return (
            <div key={slot} className="flex items-stretch gap-2">
              <span
                aria-hidden="true"
                className="w-0.5 shrink-0 rounded-full"
                style={{ backgroundColor: `var(--participant-${slot})` }}
              />
              <span
                className="rounded-sm px-1.5 py-0.5 text-caption font-medium"
                style={{
                  backgroundColor: `var(--participant-${slot})`,
                  color: `var(--participant-${slot}-fg)`,
                }}
              >
                {
                  [
                    "김현민",
                    "Ada",
                    "박서연",
                    "Grace",
                    "이도윤",
                    "Linus",
                    "정하늘",
                    "Mary",
                    "최민준",
                    "Ken",
                    "한지우",
                    "Dennis",
                  ][i]
                }
              </span>
            </div>
          );
        })}
      </div>
    </>
  );
}

function TypeSpecimen() {
  const sizes: [string, string, CSSProperties?][] = [
    ["text-hero", "함께 보고, 함께 고쳐요"],
    ["text-display", "같은 네트워크에서 바로 코드 공유"],
    ["text-heading", "공유를 만들어 볼까요?"],
    ["text-title", "6자리 코드로 들어와요"],
    ["text-title-sm", "근처 공유 · Nearby shares"],
    ["text-body", "같은 네트워크라면 링크를 복사할 필요 없이 코드만 입력하면 돼요."],
    ["text-body-sm", "편집 이력은 소유자만 볼 수 있고, 참여자에게는 현재 문서만 전달돼요."],
    ["text-label", "공유 이름 · Share name"],
    ["text-caption", "방금 전 · 3 participants · 12ms"],
  ];
  return (
    <div className="flex flex-col gap-4">
      {sizes.map(([cls, sample]) => (
        <div key={cls} className="grid gap-1 sm:grid-cols-[8rem_1fr] sm:items-baseline sm:gap-4">
          <span className="font-mono text-caption text-fg-3">{cls}</span>
          <p className={cx(cls, "min-w-0 font-semibold text-fg")}>{sample}</p>
        </div>
      ))}
      <div className="grid gap-1 sm:grid-cols-[8rem_1fr] sm:gap-4">
        <span className="font-mono text-caption text-fg-3">tabular-nums</span>
        <div className="flex gap-6 text-body-sm">
          <span className="tabular-nums">1,111 → 0.00ms</span>
          <span>1,111 → 0.00ms</span>
        </div>
      </div>
      <div className="grid gap-1 sm:grid-cols-[8rem_1fr] sm:gap-4">
        <span className="font-mono text-caption text-fg-3">font-mono</span>
        <div className="font-mono text-code text-fg-2">
          <p>const answer = items.filter((x) =&gt; x !== null); {"// 주석"}</p>
          <p className="italic">{"// italic is a real face, never synthesized"}</p>
        </div>
      </div>
    </div>
  );
}

export function TokensView(): ReactNode {
  return (
    <div className="flex flex-col gap-12">
      <Section
        id="color"
        title="Colour tokens"
        note="Ratios are measured in the browser from the rendered colours of each pair."
      >
        <ThemePair>
          <ColorTokens />
        </ThemePair>
      </Section>
      <Section id="participants" title="Participant palette (12)">
        <ThemePair>
          <ParticipantTokens />
        </ThemePair>
      </Section>
      <Section id="shape" title="Radius · elevation · spacing · motion">
        <ThemePair>
          <ShapeTokens />
        </ThemePair>
      </Section>
      <Section
        id="type"
        title="Type scale"
        note="Pretendard Variable for UI, JetBrains Mono for code. Hangul wraps by word, line-heights are generous for Hangul density."
      >
        <ThemePair>
          <TypeSpecimen />
        </ThemePair>
      </Section>
    </div>
  );
}
