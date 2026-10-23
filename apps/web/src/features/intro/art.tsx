/*
 * Drawings made here in CSS and SVG: no files, no external requests. Every drawing is decorative
 * (aria-hidden); the text that explains it sits next to it in the page.
 */
import type { CSSProperties, ReactNode } from "react";
import { useT } from "../../lib/i18n";
import { DownloadIcon, LockIcon } from "./icons";
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

/* ── Intranet previews ── */

export function CodeArt() {
  const t = useT();
  return (
    <div className="ix-art ix-art-code">
      <Cells characters="482913" size="lg" />
      <span className="ix-art-caption">{t("intro.art.code")}</span>
    </div>
  );
}

/** A QR-like pattern: three finder squares and a fixed pseudo-random fill. Looks right, encodes nothing. */
export function QrArt() {
  const t = useT();
  const size = 25;
  let seed = 7;
  const modules: string[] = [];
  const inFinder = (x: number, y: number) =>
    (x < 8 && y < 8) || (x > size - 9 && y < 8) || (x < 8 && y > size - 9);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      seed = (seed * 48271) % 2147483647;
      if (!inFinder(x, y) && seed % 100 < 47) modules.push(`M${x} ${y}h1v1h-1z`);
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
        <g fill="#0a0c10">
          <path d={modules.join("")} />
          {finder(0, 0)}
          {finder(size - 7, 0)}
          {finder(0, size - 7)}
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
      <span className="ix-art-title">{t("intro.nearby.title")}</span>
      <ul className="ix-rows">
        {rows.map((row, index) => (
          <li className="ix-row" data-hot={index === 0 ? "" : undefined} key={row.file}>
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
          <li className="ix-row" data-hot={index === 1 ? "" : undefined} key={person.slot}>
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
      <div className="ix-toast">
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
          <div className="ix-screen" key={screen}>
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

export function HighlightArt() {
  return (
    <div className="ix-fx ix-fx-highlight">
      <Code
        lines={[
          [["comment", "// total price"]],
          [
            ["keyword", "export function "],
            ["function", "total"],
            [null, "("],
            ["variable", "n"],
            [null, ": "],
            ["type", "number"],
            [null, ") {"],
          ],
          [
            [null, "  "],
            ["keyword", "const "],
            ["variable", "unit"],
            ["operator", " = "],
            ["number", "1200"],
            [null, ";"],
          ],
          [
            [null, "  "],
            ["keyword", "return "],
            ["variable", "n"],
            ["operator", " > "],
            ["number", "0"],
            ["operator", " ? "],
            ["variable", "n"],
            ["operator", " * "],
            ["variable", "unit"],
            ["operator", " : "],
            ["string", '"none"'],
            [null, ";"],
          ],
          [[null, "}"]],
        ]}
      />
      <ul className="ix-chips" aria-hidden="true">
        {["typescript", "python", "go", "rust", "java", "kotlin", "cpp", "swift", "php", "sql"].map(
          (id) => (
            <li className="ix-chip" key={id}>
              <LangDot id={id} />
              {lang(id).name}
            </li>
          ),
        )}
      </ul>
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

/** The name, built from six cells like the join code. */
export function NameCells({ children }: { children?: ReactNode }) {
  return (
    <div className="ix-name" aria-hidden="true">
      {[..."codesh"].map((letter, index) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed six letters
          key={index}
          className="ix-name-cell"
          style={
            {
              "--c": `var(--participant-${CELL_COLORS[index]})`,
              "--l": `var(--participant-${CELL_COLORS[index]}-fg)`,
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
