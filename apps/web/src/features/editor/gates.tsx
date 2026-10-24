import { Button, EmptyState, Field, Input, Spinner } from "@codesh/ui";
import { Link } from "@tanstack/react-router";
import { Ban, Clock, DoorClosed, Hourglass, Lock, UserX } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useT } from "../../lib/i18n";
import { StatusScreen } from "../app/StatusScreen";

const homeLink = (label: string, variant: "primary" | "secondary" = "primary") => (
  <Button asChild variant={variant}>
    <Link to="/">{label}</Link>
  </Button>
);

export function LoadingScreen({ label }: { label?: string }) {
  const t = useT();
  return (
    <main
      id="main"
      aria-busy="true"
      className="grid min-h-dvh place-items-center px-4"
      data-testid="loading-screen"
    >
      <Spinner size="lg" label={label ?? t("editor.loading")} />
    </main>
  );
}

export function ExpiredScreen() {
  const t = useT();
  return (
    <StatusScreen
      icon={<Clock />}
      title={t("conn.expired.title")}
      description={t("conn.expired.body")}
      action={
        <Button asChild variant="primary">
          <Link to="/new">{t("conn.expired.newAction")}</Link>
        </Button>
      }
      secondaryAction={homeLink(t("error.page.homeAction"), "secondary")}
    />
  );
}

export function NotFoundShare({ onRetry }: { onRetry?: () => void }) {
  const t = useT();
  return (
    <StatusScreen
      icon={<DoorClosed />}
      title={t("error.not_found")}
      description={t("error.not_found.hint")}
      action={homeLink(t("error.page.homeAction"))}
      secondaryAction={onRetry ? <Button onClick={onRetry}>{t("common.retry")}</Button> : undefined}
    />
  );
}

export function KickedScreen({ banned }: { banned: boolean }) {
  const t = useT();
  return (
    <StatusScreen
      icon={banned ? <Ban /> : <UserX />}
      title={banned ? t("conn.banned.title") : t("conn.kicked.title")}
      description={banned ? t("conn.banned.body") : t("conn.kicked.body")}
      action={homeLink(t("error.page.homeAction"))}
    />
  );
}

export function LoadFailedScreen({
  title,
  hint,
  onRetry,
}: {
  title: string;
  hint?: string;
  onRetry: () => void;
}) {
  const t = useT();
  return (
    <StatusScreen
      tone="danger"
      title={title}
      description={hint}
      action={
        <Button variant="primary" onClick={onRetry}>
          {t("common.retry")}
        </Button>
      }
      secondaryAction={homeLink(t("error.page.homeAction"), "secondary")}
    />
  );
}

export function DeniedScreen() {
  const t = useT();
  return (
    <StatusScreen
      icon={<Lock />}
      title={t("wait.denied.title")}
      description={t("wait.denied.body")}
      action={homeLink(t("wait.deniedAction"))}
    />
  );
}

export function WaitingRoom({ onCancel }: { onCancel: () => void }) {
  const t = useT();
  return (
    <StatusScreen
      icon={<Hourglass />}
      title={t("wait.title")}
      description={t("wait.body")}
      action={
        <Button onClick={onCancel} leading={<Spinner size="sm" label={t("a11y.loading")} />}>
          {t("wait.cancelAction")}
        </Button>
      }
    />
  );
}

export function PinGate({
  invalid,
  busy,
  rateLimited,
  onSubmit,
}: {
  invalid: boolean;
  busy: boolean;
  rateLimited: boolean;
  onSubmit: (pin: string) => void;
}) {
  const t = useT();
  const [pin, setPin] = useState("");
  const [shown, setShown] = useState(false);
  const [empty, setEmpty] = useState(false);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!pin) {
      setEmpty(true);
      return;
    }
    onSubmit(pin);
  };
  return (
    <main id="main" className="grid min-h-dvh place-items-center px-4 py-12">
      <form
        onSubmit={submit}
        className="flex w-full max-w-sm flex-col gap-4 rounded-xl border border-line bg-panel p-5"
      >
        <div className="flex flex-col gap-1">
          <h1 className="flex items-center gap-2 text-heading font-semibold">
            <Lock aria-hidden="true" className="size-5 text-fg-3" />
            {t("pin.title")}
          </h1>
          <p className="text-body-sm text-fg-2">{t("pin.body")}</p>
        </div>
        <Field
          label={t("pin.label")}
          error={
            rateLimited
              ? t("pin.tooMany")
              : invalid
                ? t("pin.invalid")
                : empty && !pin
                  ? t("pin.required")
                  : undefined
          }
        >
          <Input
            autoFocus
            type={shown ? "text" : "password"}
            autoComplete="off"
            inputMode="text"
            value={pin}
            onChange={(event) => setPin(event.target.value)}
            data-testid="pin-input"
          />
        </Field>
        <div className="flex items-center justify-between gap-3">
          <label className="flex items-center gap-2 text-body-sm text-fg-2">
            <input
              type="checkbox"
              checked={shown}
              onChange={(event) => setShown(event.target.checked)}
            />
            {t("pin.show")}
          </label>
          <Button type="submit" variant="primary" loading={busy} loadingLabel={t("common.loading")}>
            {t("pin.submitAction")}
          </Button>
        </div>
      </form>
    </main>
  );
}

export { EmptyState };
