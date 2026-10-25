/*
 * Drawings made here in CSS and SVG: no files, no external requests. Every drawing is decorative
 * (aria-hidden); the text that explains it sits next to it in the page.
 */

import type { MessageKey } from "@gachipad/i18n";
import { type CSSProperties, type ReactNode, useState } from "react";
import { useT } from "../../lib/i18n";
import { DownloadIcon, LockIcon } from "./icons";
import { SAMPLE_IDS, type SampleId, sampleLines } from "./samples";
import { lang } from "./static-data";

type TokenKind =
  | "keyword"
  | "string"
  | "comment"
  | "number"
  | "type"
  | "function"
  | "variable"
  | "property"
  | "operator";

export type CodeToken = readonly [kind: TokenKind | null, text: string];

/** A few lines of code coloured with the editor theme's own token colours. */
export function Code({
  lines,
  className,
}: {
  lines: readonly (readonly CodeToken[])[];
  className?: string;
}) {
  return (
    <pre className={`ix-code ${className ?? ""}`} aria-hidden="true">
      <code>
        {lines.map((line, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static drawing, lines never reorder
          <span className="ix-code-line" key={index}>
            {line.map(([kind, text], tokenIndex) =>
              kind ? (
                // biome-ignore lint/suspicious/noArrayIndexKey: static drawing
                <span className="tk" data-k={kind} key={tokenIndex}>
                  {text}
                </span>
              ) : (
                text
              ),
            )}
            {"\n"}
          </span>
        ))}
      </code>
    </pre>
  );
}

export function LangDot({ id }: { id: string }) {
  return <span className="ix-dot" aria-hidden="true" style={{ backgroundColor: lang(id).color }} />;
}

const CELL_COLORS = [5, 7, 3, 6, 1, 10] as const;

/** Six cells: the join code, and the six letters of the name, share one shape. */
export function Cells({
  characters,
  size = "md",
  masked = false,
}: {
  characters: string;
  size?: "sm" | "md" | "lg";
  masked?: boolean;
}) {
  return (
    <span className="ix-cells" data-size={size} aria-hidden="true">
      {[...characters].map((character, index) => {
        const slot = CELL_COLORS[index % CELL_COLORS.length] ?? 1;
        return (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed six cells
            key={index}
            className="ix-cell"
            style={
              {
                "--c": `var(--participant-${slot})`,
                "--l": `var(--participant-${slot}-fg)`,
              } as CSSProperties
            }
          >
            {masked ? "•" : character}
          </span>
        );
      })}
    </span>
  );
}

/* ── Ways in: previews ── */

export function CodeArt() {
  const t = useT();
  return (
    <div className="ix-art ix-art-code">
      <Cells characters="482913" size="lg" />
      <span className="ix-art-caption">{t("intro.art.code")}</span>
    </div>
  );
}

/**
 * A QR-like pattern at version-3 size: three finder squares, timing lines, one alignment square
 * and a fixed pseudo-random fill. It looks right and encodes nothing.
 */
export function QrArt() {
  const t = useT();
  const size = 29;
  let seed = 7;
  const modules: string[] = [];
  const inFinder = (x: number, y: number) =>
    (x < 8 && y < 8) || (x > size - 9 && y < 8) || (x < 8 && y > size - 9);
  const inAlignment = (x: number, y: number) => x >= 20 && x <= 24 && y >= 20 && y <= 24;
  const timing = (x: number, y: number) => (y === 6 || x === 6) && (x + y) % 2 === 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      seed = (seed * 48271) % 2147483647;
      const filled = y === 6 || x === 6 ? timing(x, y) : seed % 100 < 47;
      if (!inFinder(x, y) && !inAlignment(x, y) && filled) modules.push(`M${x} ${y}h1v1h-1z`);
    }
  }
  const finder = (x: number, y: number) => (
    <g transform={`translate(${x} ${y})`}>
      <path d="M0 0h7v7h-7zM1 1v5h5v-5z" fillRule="evenodd" />
      <rect x="2" y="2" width="3" height="3" />
    </g>
  );
  return (
    <div className="ix-art ix-art-qr">
      {/* biome-ignore lint/a11y/noSvgWithoutTitle: decorative drawing inside an aria-hidden stage */}
      <svg viewBox={`-2 -2 ${size + 4} ${size + 4}`} className="ix-qr" focusable="false">
        <rect x="-2" y="-2" width={size + 4} height={size + 4} fill="#ffffff" />
        <g fill="#0a0c10" shapeRendering="crispEdges">
          <path d={modules.join("")} />
          {finder(0, 0)}
          {finder(size - 7, 0)}
          {finder(0, size - 7)}
          <g transform="translate(20 20)">
            <path d="M0 0h5v5h-5zM1 1v3h3v-3z" fillRule="evenodd" />
            <rect x="2" y="2" width="1" height="1" />
          </g>
        </g>
      </svg>
      <span className="ix-art-caption">{t("intro.art.scan")}</span>
    </div>
  );
}

export function NearbyArt() {
  const t = useT();
  const rows = [
    { id: "typescript", file: "api.ts", people: 3 },
    { id: "python", file: "stats.py", people: 2 },
    { id: "go", file: "main.go", people: 1 },
  ] as const;
  return (
    <div className="ix-art ix-art-nearby">
      <span className="ix-art-title">
        <i className="ix-live" />
        {t("intro.nearby.title")}
      </span>
      <ul className="ix-rows">
        {rows.map((row, index) => (
          <li
            className="ix-row"
            data-hot={index === 0 ? "" : undefined}
            key={row.file}
            style={{ "--i": index } as CSSProperties}
          >
            <LangDot id={row.id} />
            <span className="ix-row-name">{row.file}</span>
            <span className="ix-row-meta">{lang(row.id).name}</span>
            <span className="ix-row-people">{t("intro.art.people", { count: row.people })}</span>
            <span className="ix-row-go">{t("nearby.joinAction")}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function SendArt() {
  const t = useT();
  const people = [
    { name: t("intro.demo.userA"), slot: 1 },
    { name: t("intro.demo.userB"), slot: 7 },
    { name: t("intro.art.userC"), slot: 5 },
  ] as const;
  return (
    <div className="ix-art ix-art-send">
      <ul className="ix-rows">
        {people.map((person, index) => (
          <li
            className="ix-row"
            data-hot={index === 1 ? "" : undefined}
            key={person.slot}
            style={{ "--i": index } as CSSProperties}
          >
            <span
              className="ix-avatar"
              style={
                {
                  backgroundColor: `var(--participant-${person.slot})`,
                  color: `var(--participant-${person.slot}-fg)`,
                } as CSSProperties
              }
            >
              {[...person.name][0]?.toUpperCase()}
            </span>
            <span className="ix-row-name">{person.name}</span>
          </li>
        ))}
      </ul>
      <div className="ix-toast" style={{ "--i": 4 } as CSSProperties}>
        <LangDot id="typescript" />
        <span>{t("invite.received.title", { name: t("intro.demo.userA") })}</span>
      </div>
    </div>
  );
}

export function BroadcastArt() {
  const t = useT();
  const screens: readonly (readonly [TokenKind, number][])[] = [
    [
      ["keyword", 22],
      ["function", 38],
      ["string", 30],
    ],
    [
      ["comment", 44],
      ["keyword", 18],
      ["number", 24],
    ],
    [
      ["type", 30],
      ["operator", 14],
      ["property", 36],
    ],
  ];
  return (
    <div className="ix-art ix-art-broadcast">
      <div className="ix-screens">
        {Array.from({ length: 6 }, (_, screen) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: six identical screens by design
          <div className="ix-screen" key={screen} style={{ "--i": screen } as CSSProperties}>
            <span className="ix-screen-bar" />
            {screens.map((line, row) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: static drawing
              <span className="ix-screen-line" key={row}>
                {line.map(([kind, width]) => (
                  <i key={kind} className="tk-bar" data-k={kind} style={{ width: `${width}%` }} />
                ))}
              </span>
            ))}
          </div>
        ))}
      </div>
      <span className="ix-art-caption">
        {t("intro.art.room")} · {t("intro.art.people", { count: 6 })}
      </span>
    </div>
  );
}

/* ── Feature tiles ── */

/** Pick a language to see the same few lines in its own highlighting. */
export function HighlightArt() {
  const t = useT();
  const [active, setActive] = useState<SampleId>("typescript");
  return (
    <div className="ix-fx ix-fx-highlight">
      <Code lines={sampleLines(active)} className="ix-code-swap" key={active} />
      <fieldset className="ix-chips">
        <legend className="ix-sr">{t("intro.features.highlight.pick")}</legend>
        {SAMPLE_IDS.map((id) => (
          <button
            type="button"
            className="ix-chip"
            key={id}
            aria-pressed={id === active}
            style={{ "--lc": lang(id).color } as CSSProperties}
            onClick={() => setActive(id)}
            onPointerEnter={(event) => {
              if (event.pointerType === "mouse") setActive(id);
            }}
          >
            <LangDot id={id} />
            {lang(id).name}
          </button>
        ))}
      </fieldset>
    </div>
  );
}

export function MergeArt() {
  const t = useT();
  return (
    <div className="ix-fx ix-fx-merge" aria-hidden="true">
      <pre className="ix-code">
        <code>
          <span className="ix-code-line">
            <span className="tk" data-k="keyword">
              const{" "}
            </span>
            <span className="tk" data-k="variable">
              total
            </span>
            <span className="tk" data-k="operator">
              {" "}
              ={" "}
            </span>
            <span className="tk" data-k="variable">
              price
            </span>
            <i
              className="ix-caret ix-caret-inline"
              style={
                { "--c": "var(--participant-1)", "--l": "var(--participant-1-fg)" } as CSSProperties
              }
            >
              <b className="ix-caret-name">{t("intro.demo.userA")}</b>
            </i>
            <span className="tk" data-k="operator">
              {" "}
              +{" "}
            </span>
            <span className="tk" data-k="variable">
              tax
            </span>
            <i
              className="ix-caret ix-caret-inline"
              data-who="b"
              style={
                { "--c": "var(--participant-7)", "--l": "var(--participant-7-fg)" } as CSSProperties
              }
            >
              <b className="ix-caret-name">{t("intro.demo.userB")}</b>
            </i>
            {";"}
            {"\n"}
          </span>
          <span className="ix-code-line">
            <span className="tk" data-k="keyword">
              const{" "}
            </span>
            <span className="tk" data-k="variable">
              rate
            </span>
            <span className="tk" data-k="operator">
              {" "}
              ={" "}
            </span>
            <span className="tk" data-k="number">
              0.1
            </span>
            {";"}
            {"\n"}
          </span>
          <span className="ix-code-line">
            <span className="tk" data-k="keyword">
              return{" "}
            </span>
            <span className="tk" data-k="variable">
              total
            </span>
            <span className="tk" data-k="operator">
              {" "}
              *{" "}
            </span>
            {"("}
            <span className="tk" data-k="number">
              1
            </span>
            <span className="tk" data-k="operator">
              {" "}
              -{" "}
            </span>
            <span className="tk" data-k="variable">
              rate
            </span>
            {");"}
          </span>
        </code>
      </pre>
    </div>
  );
}

export function AccessArt() {
  const t = useT();
  return (
    <div className="ix-fx ix-fx-access" aria-hidden="true">
      <span className="ix-pill">
        <LockIcon />
        {t("status.readOnly")}
      </span>
      <span className="ix-pin">
        <span className="ix-pin-label">{t("pin.label")}</span>
        <Cells characters="••••••" size="sm" masked />
      </span>
    </div>
  );
}

export function FilesArt() {
  const files = [
    { id: "typescript", file: "api.ts" },
    { id: "python", file: "stats.py" },
    { id: "go", file: "main.go" },
    { id: "sql", file: "report.sql" },
  ] as const;
  return (
    <div className="ix-fx ix-fx-files" aria-hidden="true">
      <ul className="ix-filetabs">
        {files.map((item, index) => (
          <li className="ix-filetab" data-on={index === 0 ? "" : undefined} key={item.file}>
            <LangDot id={item.id} />
            {item.file}
          </li>
        ))}
      </ul>
      <Code
        lines={[
          [
            ["keyword", "import "],
            [null, "{ db } "],
            ["keyword", "from "],
            ["string", '"./db"'],
            [null, ";"],
          ],
          [
            ["keyword", "export const "],
            ["variable", "LIMIT"],
            ["operator", " = "],
            ["number", "50"],
            [null, ";"],
          ],
        ]}
      />
    </div>
  );
}

export function HistoryArt() {
  // Bars are edits over time, coloured by who made them; the playhead sits two thirds along.
  const heights = [34, 52, 28, 64, 40, 72, 46, 58, 30, 66, 44, 80, 38, 56, 70, 42, 62, 36, 74, 50];
  return (
    <div className="ix-fx ix-fx-history" aria-hidden="true">
      {/* biome-ignore lint/a11y/noSvgWithoutTitle: decorative drawing inside an aria-hidden tile */}
      <svg
        viewBox="0 0 200 100"
        className="ix-timeline"
        preserveAspectRatio="none"
        focusable="false"
      >
        {heights.map((height, index) => (
          <rect
            // biome-ignore lint/suspicious/noArrayIndexKey: static drawing
            key={index}
            x={index * 10 + 2}
            y={90 - height}
            width="6"
            height={height}
            rx="1.5"
            fill={index % 3 === 0 ? "var(--participant-7)" : "var(--participant-1)"}
          />
        ))}
        <rect x="132" y="2" width="2.4" height="92" fill="var(--fg)" />
      </svg>
    </div>
  );
}

export function DownloadArt() {
  return (
    <div className="ix-fx ix-fx-download" aria-hidden="true">
      <ul className="ix-files">
        {["api.ts", "stats.py", "main.go"].map((file) => (
          <li className="ix-file" key={file}>
            {file}
          </li>
        ))}
      </ul>
      <span className="ix-zip">
        <DownloadIcon />
        share.zip
      </span>
    </div>
  );
}

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = isMac ? "⌘" : "Ctrl";
const ALT = isMac ? "⌥" : "Alt";

/** Same shortcuts as the app's shortcut sheet, with the same labels. */
const SHORTCUTS = [
  { label: "shortcuts.item.palette", keys: [MOD, "K"] },
  { label: "shortcuts.item.format", keys: ["Shift", ALT, "F"] },
  { label: "shortcuts.item.share", keys: [MOD, ALT, "S"] },
  { label: "shortcuts.item.history", keys: [MOD, ALT, "H"] },
] as const satisfies readonly { label: MessageKey; keys: readonly string[] }[];

export function KeysArt() {
  const t = useT();
  return (
    <dl className="ix-fx ix-fx-keys">
      {SHORTCUTS.map((item) => (
        <div className="ix-keyrow" key={item.label}>
          <dt>{t(item.label)}</dt>
          <dd>
            {item.keys.map((key) => (
              <kbd className="ix-kbd" key={key}>
                {key}
              </kbd>
            ))}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** The name, built from six cells like the join code. */
export function NameCells({ children }: { children?: ReactNode }) {
  return (
    <div className="ix-name" aria-hidden="true">
      {[..."gachipad"].map((letter, index) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed six letters
          key={index}
          className="ix-name-cell"
          style={
            {
              "--c": `var(--participant-${CELL_COLORS[index % CELL_COLORS.length]})`,
              "--l": `var(--participant-${CELL_COLORS[index % CELL_COLORS.length]}-fg)`,
              "--i": index,
            } as CSSProperties
          }
        >
          {letter}
        </span>
      ))}
      {children}
    </div>
  );
}
