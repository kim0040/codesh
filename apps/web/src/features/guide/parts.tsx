import type { LanguageEntry } from "@codesh/highlight";
import type { MessageKey } from "@codesh/i18n";
import { BUILTIN_TEMPLATES } from "@codesh/shared";
import { Avatar, Badge, Switch, ToggleGroup, ToggleGroupItem } from "@codesh/ui";
import { useDeferredValue, useEffect, useId, useMemo, useRef, useState } from "react";
import { useT } from "../../lib/i18n";
import { PLATFORM, type Platform } from "../../lib/platform";
import { SHORTCUTS, type ShortcutGroup, type ShortcutId } from "../../lib/shortcuts";
import { useInView } from "../intro/hooks";
import { FaqItem } from "../intro/sections/FaqItem";
import { ShortcutKeys } from "./blocks";
import { useGuide } from "./copy";
import { FACTS } from "./facts";

/**
 * The access settings of the Share window, drawn with the app's own switch, toggle and badge so
 * it looks like the screen the owner will see. Wrapped in Mock, so nothing in it can be reached.
 */
export function AccessMock() {
  const t = useT();
  const people = [
    { name: "Mina", slot: 5, role: "share.dialog.people.roleOwner" },
    { name: "Alex", slot: 7, role: "share.dialog.people.roleEdit" },
    { name: "Sam", slot: 3, role: "share.dialog.people.roleView" },
  ] as const satisfies readonly { name: string; slot: number; role: MessageKey }[];
  const toggles = [
    { label: "share.dialog.access.pin", hint: "share.dialog.access.pinHint", on: true },
    { label: "share.dialog.access.approval", hint: "share.dialog.access.approvalHint", on: false },
    { label: "share.dialog.access.nearby", hint: "share.dialog.access.nearbyHint", on: false },
    { label: "share.dialog.access.lock", hint: "share.dialog.access.lockHint", on: false },
  ] as const satisfies readonly { label: MessageKey; hint: MessageKey; on: boolean }[];
  return (
    <>
      <p className="ix-mock-title">{t("share.dialog.access.title")}</p>
      <div className="ix-mock-field">
        <span>{t("share.dialog.access.default")}</span>
        <ToggleGroup label={t("share.dialog.access.default")}>
          <ToggleGroupItem pressed={false} tabIndex={-1}>
            {t("share.dialog.access.edit")}
          </ToggleGroupItem>
          <ToggleGroupItem pressed tabIndex={-1}>
            {t("share.dialog.access.view")}
          </ToggleGroupItem>
        </ToggleGroup>
      </div>
      {toggles.map(({ label, hint, on }) => (
        <Switch
          key={label}
          label={t(label)}
          description={t(
            hint,
            hint === "share.dialog.access.pinHint"
              ? { min: FACTS.pinMin, max: FACTS.pinMax }
              : undefined,
          )}
          checked={on}
          tabIndex={-1}
        />
      ))}
      <p className="ix-mock-title">{t("share.dialog.people.title")}</p>
      <ul className="ix-mock-people">
        {people.map(({ name, slot, role }) => (
          <li key={name}>
            <Avatar name={name} slot={slot} size="sm" />
            <span>{name}</span>
            <Badge tone={role === "share.dialog.people.roleOwner" ? "accent" : "neutral"}>
              {t(role)}
            </Badge>
          </li>
        ))}
      </ul>
    </>
  );
}

function matches(language: LanguageEntry, query: string): boolean {
  const needle = query.trim().toLowerCase().replace(/^\./, "");
  if (!needle) return true;
  return (
    language.name.toLowerCase().includes(needle) ||
    language.id.includes(needle) ||
    language.aliases.some((alias) => alias.includes(needle)) ||
    language.extensions.some((extension) => extension.startsWith(needle))
  );
}

type Loaded =
  | { status: "idle" | "loading" | "error" }
  | { status: "ready"; languages: readonly LanguageEntry[] };

/**
 * Every supported language, searchable. The registry (and with it the highlighter) is fetched
 * only when this part comes near the screen, so the rest of the page never waits for it.
 */
export function LanguageBrowser() {
  const { t } = useGuide();
  const tApp = useT();
  const frame = useRef<HTMLDivElement>(null);
  const near = useInView(frame, "400px");
  const [state, setState] = useState<Loaded>({ status: "idle" });
  const [attempt, setAttempt] = useState(0);
  const [query, setQuery] = useState("");
  const deferred = useDeferredValue(query);
  const inputId = useId();
  const statusId = useId();

  // `attempt` is the retry button: it re-runs the load after a failure.
  useEffect(() => {
    if (!near && attempt === 0) return;
    let cancelled = false;
    setState({ status: "loading" });
    import("@codesh/highlight").then(
      (module) => {
        if (!cancelled) setState({ status: "ready", languages: module.LANGUAGES });
      },
      () => {
        if (!cancelled) setState({ status: "error" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [near, attempt]);

  const languages = state.status === "ready" ? state.languages : [];
  const shown = useMemo(
    () => languages.filter((language) => matches(language, deferred)),
    [languages, deferred],
  );

  return (
    <div className="ix-langbox" ref={frame}>
      <label htmlFor={inputId} className="ix-langbox-label">
        {t("guide.features.languages.searchLabel")}
      </label>
      <input
        id={inputId}
        type="search"
        className="ix-input"
        value={query}
        placeholder={t("guide.features.languages.placeholder")}
        autoComplete="off"
        spellCheck={false}
        aria-describedby={statusId}
        onChange={(event) => setQuery(event.target.value)}
      />
      <p id={statusId} className="ix-langbox-status" role="status">
        {state.status === "ready"
          ? shown.length > 0
            ? t("guide.features.languages.shown", { shown: shown.length, total: languages.length })
            : t("guide.features.languages.empty", { query: query.trim() })
          : state.status === "error"
            ? t("guide.features.languages.error")
            : t("guide.features.languages.loading")}
      </p>
      {state.status === "error" ? (
        <button type="button" className="ix-btn ix-btn-sm" onClick={() => setAttempt(attempt + 1)}>
          {tApp("common.retry")}
        </button>
      ) : null}
      <section
        className="ix-langs-scroll"
        aria-label={t("guide.features.languages.listLabel")}
        // Focusable so the keyboard can scroll the list.
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must take focus
        tabIndex={0}
      >
        <ul className="ix-langs">
          {shown.map((language) => (
            <li key={language.id}>
              <span
                className="ix-dot"
                aria-hidden="true"
                style={{ backgroundColor: language.color }}
              />
              <span className="ix-lang-name">{language.name}</span>
              <span className="ix-lang-ext">
                {language.extensions
                  .slice(0, 3)
                  .map((extension) => `.${extension}`)
                  .join(" ")}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

interface ShortcutRow {
  label: MessageKey;
  ids: ShortcutId[];
}

/** One row per action: shortcuts that share a label (move line up and down) share a row. */
function rowsOf(group: ShortcutGroup): ShortcutRow[] {
  const rows: ShortcutRow[] = [];
  for (const [id, def] of Object.entries(SHORTCUTS) as [
    ShortcutId,
    (typeof SHORTCUTS)[ShortcutId],
  ][]) {
    if (def.group !== group) continue;
    const row = rows.find((candidate) => candidate.label === def.label);
    if (row) row.ids.push(id);
    else rows.push({ label: def.label, ids: [id] });
  }
  return rows;
}

const GROUPS = ["general", "editing", "navigation"] as const;

/** Every shortcut from the app's own table, with a switch between the Mac and PC keys. */
export function ShortcutTables() {
  const t = useT();
  const { t: g } = useGuide();
  const [platform, setPlatform] = useState<Platform>(PLATFORM === "mac" ? "mac" : "windows");
  const groups = useMemo(() => GROUPS.map((group) => ({ group, rows: rowsOf(group) })), []);
  return (
    <div className="ix-shortcuts">
      <fieldset className="ix-seg-control">
        <legend className="ix-sr">{g("guide.features.shortcuts.platform")}</legend>
        {(["mac", "windows"] as const).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={platform === value}
            onClick={() => setPlatform(value)}
          >
            {g(
              value === "mac" ? "guide.features.shortcuts.mac" : "guide.features.shortcuts.windows",
            )}
          </button>
        ))}
      </fieldset>
      {groups.map(({ group, rows }) => (
        <div className="ix-sc-group" key={group}>
          <h3 id={`ix-sc-${group}`}>{g(`guide.features.shortcuts.group.${group}`)}</h3>
          <table className="ix-table" aria-labelledby={`ix-sc-${group}`}>
            <thead className="ix-sr">
              <tr>
                <th scope="col">{g("guide.features.shortcuts.action")}</th>
                <th scope="col">{g("guide.features.shortcuts.keys")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.label}>
                  <th scope="row">{t(row.label)}</th>
                  <td>
                    {row.ids.map((id) => (
                      <div key={id}>
                        <ShortcutKeys id={id} platform={platform} />
                      </div>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

/** Names of the templates that ship with codesh, in the current language. */
export function TemplateNames() {
  const t = useT();
  return (
    <ul className="ix-chips ix-chips-static">
      {BUILTIN_TEMPLATES.map((template) => (
        <li className="ix-chip" key={template.id}>
          {t(template.nameKey as MessageKey)}
        </li>
      ))}
    </ul>
  );
}

export interface FaqEntry {
  id: string;
  question: string;
  answer: string;
}

/** Questions of one topic. Several can be open at once; a link to `#<id>` opens its question. */
export function FaqGroup({
  title,
  entries,
  open,
  onToggle,
}: {
  title: string;
  entries: readonly FaqEntry[];
  open: ReadonlySet<string>;
  onToggle: (id: string) => void;
}) {
  const heading = useId();
  return (
    <section className="ix-gsec" aria-labelledby={heading}>
      <h2 id={heading} className="ix-gh2">
        {title}
      </h2>
      <ul className="ix-faq-list">
        {entries.map((entry) => (
          <FaqItem
            key={entry.id}
            id={entry.id}
            question={entry.question}
            open={open.has(entry.id)}
            onToggle={() => onToggle(entry.id)}
          >
            <p>{entry.answer}</p>
          </FaqItem>
        ))}
      </ul>
    </section>
  );
}
