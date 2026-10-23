import { type ComponentType, type FormEvent, useId, useState } from "react";
import { useT } from "../../lib/i18n";

interface StartPanelProps {
  className?: string;
}

/*
 * The real panel lives in ../start/StartPanel.tsx and is built separately. Globbing for it means
 * this page builds and works before that file exists, and picks it up the moment it does. It is
 * loaded eagerly: returning visitors come here to use it, so it must not wait for a second request.
 */
const modules = import.meta.glob<{ StartPanel: ComponentType<StartPanelProps> }>(
  "../start/StartPanel.tsx",
  { eager: true },
);
const RealStartPanel = Object.values(modules)[0]?.StartPanel;

/** Minimal stand-in with the same job: start a share, or enter a six-digit code. */
function StandInPanel({ className }: StartPanelProps) {
  const t = useT();
  const inputId = useId();
  const errorId = useId();
  const [error, setError] = useState(false);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const code = String(new FormData(event.currentTarget).get("code") ?? "").trim();
    if (!/^\d{6}$/.test(code)) {
      setError(true);
      return;
    }
    window.location.assign(`/${code}`);
  };

  return (
    <div className={`ix-standin ${className ?? ""}`}>
      <a className="ix-btn ix-btn-primary" href="/new">
        {t("intro.hero.startAction")}
      </a>
      <form className="ix-standin-form" onSubmit={submit} noValidate>
        <label htmlFor={inputId}>{t("intro.join.hint")}</label>
        <div className="ix-standin-row">
          <input
            id={inputId}
            name="code"
            className="ix-input"
            inputMode="numeric"
            autoComplete="off"
            maxLength={6}
            placeholder="482913"
            aria-invalid={error}
            aria-describedby={error ? errorId : undefined}
            onChange={() => setError(false)}
          />
          <button type="submit" className="ix-btn">
            {t("intro.join.submitAction")}
          </button>
        </div>
        <p id={errorId} className="ix-standin-error" role="alert">
          {error ? t("intro.join.incomplete") : ""}
        </p>
      </form>
    </div>
  );
}

export function StartSlot() {
  const Panel = RealStartPanel ?? StandInPanel;
  return <Panel className="ix-start" />;
}
