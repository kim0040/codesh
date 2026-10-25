import { formatRelativeTime } from "@gachipad/i18n";
import type { AdminUpdateResponse } from "@gachipad/shared";
import { Badge, Button, EmptyState, Skeleton, toast } from "@gachipad/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CircleCheck,
  CircleOff,
  Clock,
  ExternalLink,
  Info,
  TriangleAlert,
  WifiOff,
} from "lucide-react";
import type { ReactNode } from "react";
import { api, isApiError } from "../../lib/api";
import { copyText } from "../../lib/format";
import { useLocale, useT } from "../../lib/i18n";

/** Shared with the console's nav badge, so both read one request. */
export const updateQuery = (token: string) => ({
  queryKey: ["admin", "update"],
  queryFn: () => api.admin.update(token),
  refetchInterval: 10 * 60_000,
  retry: false,
});

const major = (version: string) => version.split(".")[0];

/**
 * The "Updates" tab: installed and latest release, notes as plain text, the commands that update
 * the server, and the automatic updates deploy/update.sh reports. Admins only, like the console.
 */
export function UpdatesPanel({ token }: { token: string }) {
  const t = useT();
  const queryClient = useQueryClient();
  const update = useQuery(updateQuery(token));
  const check = useMutation({
    mutationFn: () => api.admin.checkUpdate(token),
    onSuccess: (data) => queryClient.setQueryData(updateQuery(token).queryKey, data),
    onError: (error) =>
      toast({
        title: isApiError(error, "rate_limited")
          ? t("admin.update.rateLimited")
          : t("admin.error.title"),
        tone: isApiError(error, "rate_limited") ? "info" : "danger",
      }),
  });

  if (update.isPending) {
    return (
      <div
        role="status"
        aria-busy="true"
        aria-label={t("admin.loading")}
        className="flex flex-col gap-3"
      >
        <Skeleton className="h-28" />
        <Skeleton className="h-20" />
      </div>
    );
  }
  if (update.isError) {
    return (
      <EmptyState
        tone="danger"
        icon={<TriangleAlert />}
        title={t("admin.error.title")}
        description={t("admin.error.body")}
        action={<Button onClick={() => void update.refetch()}>{t("common.retry")}</Button>}
      />
    );
  }

  const data = update.data;
  return (
    <div className="flex flex-col gap-4" data-testid="admin-updates">
      <section className="flex flex-col gap-4 rounded-xl border border-line bg-panel p-4">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-body-sm font-semibold">{t("admin.update.title")}</h2>
          <Button
            size="sm"
            className="ms-auto"
            disabled={data.status === "disabled"}
            loading={check.isPending}
            loadingLabel={t("admin.update.checking")}
            onClick={() => check.mutate()}
            data-testid="update-check"
          >
            {t("admin.update.checkAction")}
          </Button>
        </div>
        <StatusLine data={data} />
        <dl className="grid gap-3 sm:grid-cols-3">
          <Cell label={t("admin.update.current")} value={data.current} />
          <Cell label={t("admin.update.latest")} value={data.latest ?? "—"} />
          <Cell
            label={t("admin.update.released")}
            value={<ReleaseDate value={data.publishedAt} />}
          />
        </dl>
        {data.checkedAt ? <CheckedAt value={data.checkedAt} /> : null}
      </section>

      {data.latest ? <Notes data={data} /> : null}
      <HowTo data={data} />
      <Auto data={data} />
      <p className="text-caption text-fg-3">{t("admin.update.privacy")}</p>
    </div>
  );
}

function StatusLine({ data }: { data: AdminUpdateResponse }) {
  const t = useT();
  let icon: ReactNode;
  let title: string;
  let hint: string | null = null;
  let className = "text-fg-2";
  if (data.status === "disabled") {
    icon = <CircleOff />;
    title = t("admin.update.disabled");
    hint = t("admin.update.disabledHint");
  } else if (data.status === "pending") {
    icon = <Clock />;
    title = t("admin.update.pending");
    hint = t("admin.update.pendingHint");
  } else if (data.status === "unreachable") {
    icon = <WifiOff />;
    title = t("admin.update.unreachable");
    hint = t("admin.update.unreachableHint");
    className = "text-warning-text";
  } else if (data.updateAvailable && data.latest) {
    icon = <Info />;
    title = t("admin.update.available", { version: data.latest });
    className = "text-info-text";
  } else if (!data.latest) {
    icon = <Info />;
    title = t("admin.update.noRelease");
  } else {
    icon = <CircleCheck />;
    title = t("admin.update.upToDate");
    className = "text-success-text";
  }
  return (
    <div role="status" className="flex items-start gap-2" data-testid="update-status">
      <span aria-hidden="true" className={`mt-0.5 flex shrink-0 [&_svg]:size-4 ${className}`}>
        {icon}
      </span>
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className={`text-body-sm font-medium ${className}`}>{title}</p>
        {hint ? <p className="text-caption text-fg-2">{hint}</p> : null}
      </div>
    </div>
  );
}

function Cell({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="text-caption text-fg-3">{label}</dt>
      <dd className="truncate text-body font-semibold tabular">{value}</dd>
    </div>
  );
}

function ReleaseDate({ value }: { value: string | null }) {
  const [locale] = useLocale();
  if (!value) return "—";
  return (
    <time dateTime={value}>
      {new Date(value).toLocaleDateString(locale, { dateStyle: "long" })}
    </time>
  );
}

function CheckedAt({ value }: { value: string }) {
  const t = useT();
  const [locale] = useLocale();
  return (
    <p className="text-caption text-fg-3">
      {t("admin.update.checked", {
        time: formatRelativeTime(locale, new Date(value).getTime() - Date.now()),
      })}
    </p>
  );
}

function Notes({ data }: { data: AdminUpdateResponse }) {
  const t = useT();
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-line bg-panel p-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-body-sm font-semibold">
          {t("admin.update.notes")} <span className="tabular text-fg-3">{data.latest}</span>
        </h2>
        {data.url ? (
          <a
            href={data.url}
            target="_blank"
            rel="noopener noreferrer"
            className="ms-auto inline-flex items-center gap-1 text-body-sm text-accent-text underline-offset-2 hover:underline"
          >
            {t("admin.update.releaseLink")}
            <ExternalLink aria-hidden="true" className="size-3.5" />
            <span className="sr-only">{t("admin.update.newTab")}</span>
          </a>
        ) : null}
      </div>
      {/* Plain text from GitHub: rendered as text, never as HTML or Markdown. */}
      {data.notes ? (
        <div
          data-testid="update-notes"
          className="max-h-80 overflow-y-auto whitespace-pre-wrap break-words text-body-sm text-fg-2"
        >
          {data.notes}
        </div>
      ) : (
        <p className="text-body-sm text-fg-3">{t("admin.update.notesEmpty")}</p>
      )}
    </section>
  );
}

function Command({ value }: { value: string }) {
  const t = useT();
  return (
    <div className="flex items-center gap-2 rounded-md border border-line bg-fill-hover px-3 py-1.5">
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-pre font-mono text-caption">
        {value}
      </code>
      <Button
        size="sm"
        variant="ghost"
        aria-label={`${t("admin.update.copyAction")}: ${value}`}
        onClick={async () => {
          const copied = await copyText(value);
          toast({
            title: copied ? t("toast.copied") : t("error.generic"),
            tone: copied ? "success" : "danger",
          });
        }}
      >
        {t("admin.update.copyAction")}
      </Button>
    </div>
  );
}

function HowTo({ data }: { data: AdminUpdateResponse }) {
  const t = useT();
  const crossesMajor = Boolean(data.latest && major(data.latest) !== major(data.current));
  const bundle = data.latest
    ? `codesh-${data.latest}-linux-amd64.tar.gz`
    : "<codesh-X.Y.Z-linux-amd64.tar.gz>";
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-line bg-panel p-4">
      <h2 className="text-body-sm font-semibold">{t("admin.update.how.title")}</h2>
      <p className="text-body-sm text-fg-2">{t("admin.update.how.online")}</p>
      <Command value={crossesMajor ? "./update.sh --allow-major" : "./update.sh"} />
      <p className="text-body-sm text-fg-2">
        {t("admin.update.how.offline")}{" "}
        <a
          href={data.releasesUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-accent-text underline-offset-2 hover:underline"
        >
          {t("admin.update.releaseLink")}
          <ExternalLink aria-hidden="true" className="size-3.5" />
          <span className="sr-only">{t("admin.update.newTab")}</span>
        </a>
      </p>
      <Command value={`./upgrade.sh ${bundle}`} />
      <p className="text-caption text-fg-3">{t("admin.update.how.safety")}</p>
    </section>
  );
}

function Auto({ data }: { data: AdminUpdateResponse }) {
  const t = useT();
  const [locale] = useLocale();
  const auto = data.updater?.auto;
  const last = data.updater?.lastRun ?? null;
  const resultText = (run: NonNullable<typeof last>) => {
    const values = { from: run.from ?? "—", to: run.to ?? "—" };
    switch (run.result) {
      case "updated":
        return t("admin.update.result.updated", values);
      case "up-to-date":
        return t("admin.update.result.upToDate");
      case "checked":
        return t("admin.update.result.checked");
      case "refused":
        return t("admin.update.result.refused", values);
      case "rolled-back":
        return t("admin.update.result.rolledBack", values);
      default:
        return t("admin.update.result.failed");
    }
  };
  return (
    <section
      className="flex flex-col gap-3 rounded-xl border border-line bg-panel p-4"
      data-testid="update-auto"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-body-sm font-semibold">{t("admin.update.auto.title")}</h2>
        {auto?.enabled ? (
          <Badge tone="success" size="sm">
            {t("common.on")}
          </Badge>
        ) : null}
      </div>
      {auto?.enabled ? (
        <>
          <p className="text-body-sm text-fg-2">
            {t("admin.update.auto.on", {
              time: auto.at ?? "04:00",
              policy: t(
                auto.policy === "minor"
                  ? "admin.update.auto.policy.minor"
                  : "admin.update.auto.policy.patch",
              ),
            })}
          </p>
          <Command value="sudo ./update.sh --disable-auto" />
        </>
      ) : (
        <>
          <p className="text-body-sm text-fg-2">
            {data.updater
              ? t("admin.update.auto.off")
              : `${t("admin.update.auto.unknown")} ${t("admin.update.auto.off")}`}
          </p>
          <Command value="sudo ./update.sh --enable-auto --at 04:00 --policy patch" />
        </>
      )}
      {last ? (
        <p className="text-caption text-fg-2">
          {t("admin.update.lastRun", {
            time: formatRelativeTime(locale, new Date(last.at).getTime() - Date.now()),
          })}{" "}
          · {resultText(last)}
        </p>
      ) : null}
    </section>
  );
}
