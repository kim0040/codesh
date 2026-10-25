import {
  Compartment,
  EditorState,
  type Extension,
  StateEffect,
  StateField,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  lineNumbers,
  WidgetType,
} from "@codemirror/view";
import {
  DEFAULT_THEME_ID,
  getEditorTheme,
  getLanguage,
  participantColor,
} from "@gachipad/highlight";
import { useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../../lib/i18n";
import { DemoPlayer } from "./demo-player";
import { type Cursors, lineColumn, SCENES, type Who } from "./demo-script";
import {
  type Appearance,
  useAppearance,
  useInView,
  usePageVisible,
  usePrefersReducedMotion,
} from "./hooks";
import { PauseIcon, PlayIcon } from "./icons";

const COLORS: Record<Who, ReturnType<typeof participantColor>> = {
  a: participantColor(0),
  b: participantColor(6),
};

class CaretWidget extends WidgetType {
  constructor(
    readonly who: Who,
    readonly name: string,
  ) {
    super();
  }

  override eq(other: CaretWidget): boolean {
    return other.who === this.who && other.name === this.name;
  }

  override toDOM(): HTMLElement {
    const color = COLORS[this.who];
    const caret = document.createElement("span");
    caret.className = "ix-caret";
    caret.dataset.who = this.who;
    caret.style.setProperty("--c", color.hex);
    caret.style.setProperty("--l", color.label);
    const label = document.createElement("span");
    label.className = "ix-caret-name";
    label.textContent = this.name;
    caret.append(label);
    return caret;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

const setCursors = StateEffect.define<Cursors>();

function caretField(names: () => Record<Who, string>) {
  return StateField.define<{ cursors: Cursors; decorations: DecorationSet }>({
    create: () => ({ cursors: { a: 0, b: 0 }, decorations: Decoration.none }),
    update(value, tr) {
      let cursors = value.cursors;
      let changed = false;
      for (const effect of tr.effects) {
        if (effect.is(setCursors)) {
          cursors = effect.value;
          changed = true;
        }
      }
      if (!changed && !tr.docChanged) return value;
      const length = tr.state.doc.length;
      const widgets = (["a", "b"] as const).map((who) =>
        Decoration.widget({ widget: new CaretWidget(who, names()[who]), side: 1 }).range(
          Math.min(cursors[who], length),
        ),
      );
      return { cursors, decorations: Decoration.set(widgets, true) };
    },
    provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
  });
}

const baseTheme = EditorView.theme({
  "&": { height: "100%", fontSize: "var(--ix-code-size, 13px)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { lineHeight: "1.75", overflow: "hidden" },
  ".cm-content": { padding: "34px 0 14px" },
  ".cm-gutters": { paddingLeft: "6px" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 10px 0 4px", minWidth: "2.2em" },
  ".cm-line": { padding: "0 14px 0 6px" },
});

function themeFor(appearance: Appearance) {
  return getEditorTheme(DEFAULT_THEME_ID[appearance]).extension;
}

function initials(name: string): string {
  return [...name][0]?.toUpperCase() ?? "";
}

export default function DemoEditor() {
  const t = useT();
  const reduced = usePrefersReducedMotion();
  const appearance = useAppearance();
  const visible = usePageVisible();
  const frameRef = useRef<HTMLElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const onScreen = useInView(frameRef, "120px");
  const [active, setActive] = useState(0);
  const [paused, setPaused] = useState(false);
  const [position, setPosition] = useState({ line: 1, col: 1 });

  const names = useMemo<Record<Who, string>>(
    () => ({ a: t("intro.demo.userA"), b: t("intro.demo.userB") }),
    [t],
  );

  const view = useRef<EditorView | null>(null);
  const player = useRef<DemoPlayer | null>(null);
  const compartments = useRef({ theme: new Compartment(), language: new Compartment() });
  const carets = useRef<ReturnType<typeof caretField> | null>(null);
  const lastStatus = useRef(0);
  const appearanceRef = useRef(appearance);
  appearanceRef.current = appearance;

  // The editor is created once; names are read when it is built and refreshed through `namesRef`.
  const namesRef = useRef(names);
  namesRef.current = names;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const { theme, language } = compartments.current;
    const field = caretField(() => namesRef.current);
    carets.current = field;
    const editor = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: "",
        extensions: [
          lineNumbers(),
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          baseTheme,
          theme.of(themeFor(appearanceRef.current)),
          language.of([]),
          field,
        ],
      }),
    });
    view.current = editor;

    const grammar = new Map<number, Promise<Extension | null>>();
    const load = (index: number) => {
      const scene = SCENES[index];
      const entry = scene ? getLanguage(scene.languageId) : undefined;
      if (!entry) return Promise.resolve(null);
      let pending = grammar.get(index);
      if (!pending) {
        pending = entry.load().then(
          (support): Extension => support,
          () => null,
        );
        grammar.set(index, pending);
      }
      return pending;
    };

    const reportCursor = (doc: string, cursors: Cursors, force: boolean) => {
      const now = performance.now();
      if (!force && now - lastStatus.current < 220) return;
      lastStatus.current = now;
      setPosition(lineColumn(doc, cursors.a));
    };

    let alive = true;
    const instance = new DemoPlayer(
      SCENES,
      {
        async prepare(index) {
          const support = await load(index);
          if (alive) editor.dispatch({ effects: language.reconfigure(support ?? []) });
        },
        reset(_index, doc, cursors) {
          editor.dispatch({
            changes: { from: 0, to: editor.state.doc.length, insert: doc },
            effects: setCursors.of(cursors),
          });
          reportCursor(doc, cursors, true);
        },
        edit(edit, cursors) {
          editor.dispatch({
            changes: edit,
            effects: setCursors.of(cursors),
          });
          reportCursor(editor.state.doc.toString(), cursors, false);
        },
        moved(cursors) {
          editor.dispatch({ effects: setCursors.of(cursors) });
          reportCursor(editor.state.doc.toString(), cursors, true);
        },
      },
      setActive,
    );
    player.current = instance;
    // Warm the other grammars once the first file is up, so switching files never waits.
    void instance.open(0).then(() => {
      for (let i = 1; i < SCENES.length; i++) void load(i);
    });

    return () => {
      alive = false;
      instance.dispose();
      editor.destroy();
      player.current = null;
      view.current = null;
    };
  }, []);

  useEffect(() => {
    view.current?.dispatch({
      effects: compartments.current.theme.reconfigure(themeFor(appearance)),
    });
  }, [appearance]);

  const running = !reduced && !paused && onScreen && visible;
  useEffect(() => {
    player.current?.setRunning(running);
  }, [running]);

  // A language switch renames the carets; the cursor field rebuilds its widgets when it sees a cursor effect.
  useEffect(() => {
    const editor = view.current;
    const field = carets.current;
    if (!editor || !field || !names) return;
    editor.dispatch({ effects: setCursors.of(editor.state.field(field).cursors) });
  }, [names]);

  const select = (index: number) => {
    void player.current?.open(index);
  };

  const scene = SCENES[active] ?? SCENES[0];
  const entry = scene ? getLanguage(scene.languageId) : undefined;

  return (
    <figure ref={frameRef} className="ix-ed" data-ui aria-label={t("intro.demo.label")}>
      <div className="ix-ed-top">
        <fieldset className="ix-ed-tabs">
          <legend className="ix-sr">{t("intro.demo.filesLabel")}</legend>
          {SCENES.map((item, index) => {
            const language = getLanguage(item.languageId);
            return (
              <button
                key={item.filename}
                type="button"
                className="ix-ed-tab"
                aria-pressed={index === active}
                onClick={() => select(index)}
              >
                <span
                  className="ix-dot"
                  aria-hidden="true"
                  style={{ backgroundColor: language?.color }}
                />
                {item.filename}
              </button>
            );
          })}
        </fieldset>
        <div className="ix-ed-people">
          {(["a", "b"] as const).map((who) => (
            <span key={who} className="ix-ed-person">
              <span
                className="ix-avatar"
                aria-hidden="true"
                style={{ backgroundColor: COLORS[who].hex, color: COLORS[who].label }}
              >
                {initials(names[who])}
              </span>
              <span className="ix-ed-person-name">{names[who]}</span>
            </span>
          ))}
          <button
            type="button"
            className="ix-ed-pause"
            aria-pressed={paused}
            aria-label={t(paused ? "intro.demo.playAction" : "intro.demo.pauseAction")}
            title={t(paused ? "intro.demo.playAction" : "intro.demo.pauseAction")}
            onClick={() => setPaused((value) => !value)}
          >
            {paused ? <PlayIcon /> : <PauseIcon />}
          </button>
        </div>
      </div>
      <div className="ix-ed-body" aria-hidden="true" ref={hostRef} />
      <figcaption className="ix-ed-status">
        <span className="ix-ed-state">
          <span className="ix-ed-live" aria-hidden="true" />
          {t("status.connected")}
        </span>
        <span className="ix-ed-pos">
          {t("status.cursor", { line: position.line, col: position.col })}
        </span>
        <span className="ix-ed-lang">
          <span className="ix-dot" aria-hidden="true" style={{ backgroundColor: entry?.color }} />
          {entry?.name}
        </span>
        <span className="ix-ed-ms">{t("status.latency", { ms: 12 })}</span>
      </figcaption>
      <p className="ix-sr">{t("intro.demo.description")}</p>
    </figure>
  );
}
