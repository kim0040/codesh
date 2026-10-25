import type { AdminShare, DiagnosticEvent } from "@codesh/shared";
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  EmptyState,
  Field,
  Input,
  Select,
  Skeleton,
} from "@codesh/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../../lib/api";
import { downloadDiagnostics } from "../../lib/diagnostics";
import { formatBytes } from "../../lib/format";
import { useLocale, useT } from "../../lib/i18n";

function QueryState({
  pending,
  error,
  retry,
  children,
}: {
  pending: boolean;
  error: boolean;
  retry: () => void;
  children: React.ReactNode;
}) {
  const t = useT();
  if (pending)
    return (
      <div role="status" aria-label={t("common.loading")}>
        <Skeleton className="h-20" />
      </div>
    );
  if (error)
    return (
      <EmptyState
        tone="danger"
        title={t("admin.error.title")}
        description={t("admin.error.body")}
        action={<Button onClick={retry}>{t("common.retry")}</Button>}
      />
    );
  return children;
}
function Metric({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0 border-b border-line py-3">
      <dt className="text-caption text-fg-3">{label}</dt>
      <dd className="break-words text-heading font-semibold tabular">{value}</dd>
    </div>
  );
}

export function OverviewPanel({
  token,
  onDiagnostics,
}: {
  token: string;
  onDiagnostics: () => void;
}) {
  const t = useT();
  const query = useQuery({
    queryKey: ["admin", "overview"],
    queryFn: () => api.admin.overview(token),
    refetchInterval: 15_000,
  });
  const data = query.data;
  return (
    <section className="flex min-w-0 flex-col gap-4" data-testid="admin-overview">
      <h2 className="text-heading font-semibold">{t("admin.nav.overview")}</h2>
      <QueryState
        pending={query.isPending}
        error={query.isError}
        retry={() => void query.refetch()}
      >
        {data && (
          <>
            <dl className="grid min-w-0 grid-cols-2 gap-x-4 sm:grid-cols-3">
              <Metric label={t("admin.ops.shares")} value={data.shares} />
              <Metric label={t("admin.ops.online")} value={data.onlineUsers} />
              <Metric label={t("admin.ops.documents")} value={data.documents} />
              <Metric label={t("admin.ops.connections")} value={data.connections} />
              <Metric
                label={t("admin.ops.storage")}
                value={`${formatBytes(data.storageBytes)} / ${formatBytes(data.quotaBytes)}`}
              />
              <Metric
                label={t("admin.ops.uptime")}
                value={t("admin.ops.seconds", { count: data.uptimeSeconds })}
              />
              <Metric label={t("admin.ops.version")} value={data.version} />
            </dl>
            <div className="flex flex-wrap gap-2">
              {Object.entries(data.health).map(([name, value]) => (
                <Badge
                  key={name}
                  tone={
                    value === true || value === "healthy"
                      ? "success"
                      : value === false
                        ? "danger"
                        : "neutral"
                  }
                >
                  {name}:{" "}
                  {value === true || value === "healthy"
                    ? t("admin.ops.healthy")
                    : t(value === false ? "admin.ops.down" : "admin.ops.unknown")}
                </Badge>
              ))}
            </div>
            <Button className="self-start" onClick={onDiagnostics}>
              {t("admin.ops.errors", { count: data.errors24h })}
            </Button>
            <figure className="min-w-0 rounded-lg border border-line p-3">
              <figcaption className="text-caption text-fg-3">{t("admin.ops.activity")}</figcaption>
              <svg
                viewBox="0 0 480 100"
                role="img"
                aria-label={t("admin.ops.activity")}
                className="mt-3 w-full text-accent-text"
              >
                {data.activity.map((count, index) => {
                  const height = (count / Math.max(1, ...data.activity)) * 90;
                  return (
                    <rect
                      // biome-ignore lint/suspicious/noArrayIndexKey: each bar is a fixed hour bucket
                      key={24 - index}
                      x={index * 20 + 2}
                      y={100 - height}
                      width="15"
                      height={Math.max(height, 1)}
                      fill="currentColor"
                    />
                  );
                })}
              </svg>
              <p className="text-caption text-fg-3">
                {data.activity.reduce((a, b) => a + b, 0)} / 24 h
              </p>
            </figure>
          </>
        )}
      </QueryState>
    </section>
  );
}

function Events({ events }: { events: DiagnosticEvent[] }) {
  const t = useT();
  const [locale] = useLocale();
  if (!events.length) return <EmptyState title={t("admin.ops.noEvents")} />;
  return (
    <ul className="flex min-w-0 flex-col gap-3">
      {events.map((event) => (
        <li
          key={`${event.source}-${event.kind}-${event.firstAt}-${JSON.stringify(event.details)}`}
          className="min-w-0 rounded-lg border border-line p-3"
        >
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={event.level === "error" ? "danger" : "neutral"}>{event.level}</Badge>
            <code className="break-all text-body-sm">
              {event.source} / {event.kind}
            </code>
            <span className="text-caption tabular">× {event.count}</span>
          </div>
          <p className="mt-1 text-caption text-fg-3">
            {new Date(event.firstAt).toLocaleString(locale)} –{" "}
            {new Date(event.lastAt).toLocaleString(locale)}
          </p>
          <pre className="mt-2 max-w-full whitespace-pre-wrap break-all text-caption">
            {JSON.stringify(event.details, null, 2)}
          </pre>
        </li>
      ))}
    </ul>
  );
}
export function DiagnosticsPanel({ token }: { token: string }) {
  const t = useT();
  const [level, setLevel] = useState("all");
  const [source, setSource] = useState("all");
  const [period, setPeriod] = useState("all");
  const query = useQuery({
    queryKey: ["admin", "diagnostics", level, source, period],
    queryFn: () =>
      api.admin.diagnostics(token, {
        ...(level !== "all" ? { level } : {}),
        ...(source !== "all" ? { source } : {}),
        ...(period !== "all" ? { since: new Date(Date.now() - 86400_000).toISOString() } : {}),
      }),
    refetchInterval: 15_000,
  });
  const [exportError, setExportError] = useState(false);
  const bundle = useMutation({
    mutationFn: () => api.admin.diagnosticExport(token),
    onSuccess: (data) => {
      setExportError(false);
      downloadDiagnostics(
        JSON.stringify(data, null, 2),
        `codesh-server-diagnostics-${data.version.replace(/[^\w.-]/g, "_")}.json`,
      );
    },
    onError: () => setExportError(true),
  });
  return (
    <section className="flex min-w-0 flex-col gap-4" data-testid="admin-diagnostics">
      <h2 className="text-heading font-semibold">{t("admin.nav.diagnostics")}</h2>
      <p className="text-body-sm text-fg-3">{t("admin.ops.clientHelp")}</p>
      <div className="flex flex-wrap gap-3">
        <Field label={t("admin.ops.level")}>
          <Select
            value={level}
            onValueChange={setLevel}
            options={[
              { value: "all", label: t("admin.ops.all") },
              { value: "warn", label: "warn" },
              { value: "error", label: "error" },
            ]}
          />
        </Field>
        <Field label={t("admin.ops.source")}>
          <Select
            value={source}
            onValueChange={setSource}
            options={[
              { value: "all", label: t("admin.ops.all") },
              { value: "api", label: "api" },
              { value: "collab", label: "collab" },
            ]}
          />
        </Field>
        <Field label={t("admin.ops.period")}>
          <Select
            value={period}
            onValueChange={setPeriod}
            options={[
              { value: "all", label: t("admin.ops.all") },
              { value: "day", label: t("admin.ops.lastDay") },
            ]}
          />
        </Field>
      </div>
      <Button
        className="self-start"
        loading={bundle.isPending}
        loadingLabel={t("common.loading")}
        onClick={() => bundle.mutate()}
        data-testid="server-diagnostics-export"
      >
        {t("settings.diag.export")}
      </Button>
      {exportError && (
        <p role="alert" className="text-body-sm text-danger-text">
          {t("admin.error.body")}
        </p>
      )}
      <QueryState
        pending={query.isPending}
        error={query.isError}
        retry={() => void query.refetch()}
      >
        <Events events={query.data ?? []} />
      </QueryState>
    </section>
  );
}
export function SecurityPanel({ token }: { token: string }) {
  const t = useT();
  const query = useQuery({
    queryKey: ["admin", "security"],
    queryFn: () => api.admin.security(token),
    refetchInterval: 15_000,
  });
  const data = query.data;
  return (
    <section className="flex min-w-0 flex-col gap-4" data-testid="admin-security">
      <h2 className="text-heading font-semibold">{t("admin.nav.security")}</h2>
      <QueryState
        pending={query.isPending}
        error={query.isError}
        retry={() => void query.refetch()}
      >
        {data && (
          <>
            <dl className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
              <Metric
                label={t("admin.ops.cidr")}
                value={t(data.cidrRestricted ? "admin.ops.on" : "admin.ops.off")}
              />
              <Metric
                label={t("admin.ops.proxy")}
                value={t(data.proxyRestricted ? "admin.ops.on" : "admin.ops.off")}
              />
              <Metric label={t("admin.ops.loginRate")} value={`${data.loginPerMinute} / min`} />
              <Metric label={t("admin.ops.apiRate")} value={`${data.apiPerMinute} / min`} />
            </dl>
            <p className="text-body-sm text-fg-3">{t("admin.ops.proxyHint")}</p>
            <p className="text-body-sm text-fg-3">{t("admin.ops.rotation")}</p>
            <h3 className="text-body-sm font-semibold">{t("admin.ops.failedLogins")}</h3>
            <p className="text-caption text-fg-3">{t("admin.ops.auditSample")}</p>
            <Events events={data.failedLogins} />
          </>
        )}
      </QueryState>
    </section>
  );
}
export function SharesPanel({ token }: { token: string }) {
  const t = useT();
  const [locale] = useLocale();
  const cache = useQueryClient();
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState("");
  const [before, setBefore] = useState<{ at: string; id: string }>();
  const [confirm, setConfirm] = useState<{
    share: AdminShare;
    action: "lock" | "unlock" | "delete";
  } | null>(null);
  const query = useQuery({
    queryKey: ["admin", "shares", search, before],
    queryFn: () => api.admin.shares(token, search, before?.at, before?.id),
  });
  const action = useMutation({
    mutationFn: (value: NonNullable<typeof confirm>) =>
      api.admin.shareAction(token, value.share.id, value.action),
    onSuccess: () => {
      setConfirm(null);
      void cache.invalidateQueries({ queryKey: ["admin"] });
    },
  });
  return (
    <section className="flex min-w-0 flex-col gap-4" data-testid="admin-shares">
      <h2 className="text-heading font-semibold">{t("admin.nav.shares")}</h2>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setSearch(draft);
          setBefore(undefined);
        }}
      >
        <Field label={t("admin.ops.search")} className="min-w-0 flex-1">
          <Input value={draft} maxLength={100} onChange={(e) => setDraft(e.target.value)} />
        </Field>
        <Button type="submit">{t("admin.ops.search")}</Button>
      </form>
      <QueryState
        pending={query.isPending}
        error={query.isError}
        retry={() => void query.refetch()}
      >
        {!query.data?.length ? (
          <EmptyState title={t("admin.ops.noShares")} />
        ) : (
          <ul className="flex min-w-0 flex-col gap-3">
            {query.data.map((s) => (
              <li key={s.id} className="min-w-0 rounded-lg border border-line p-3">
                <h3 className="break-words text-body-sm font-semibold">
                  {s.title || t("admin.ops.untitled")}
                </h3>
                <p className="break-words text-caption text-fg-3">
                  {s.id} · {s.language} ·{" "}
                  {t(
                    s.ownerKind === "signed_in"
                      ? "admin.ops.signedIn"
                      : s.ownerKind === "lab"
                        ? "admin.ops.lab"
                        : "admin.ops.ownerUnknown",
                  )}{" "}
                  · {formatBytes(s.sizeBytes)}
                </p>
                <p className="text-caption text-fg-3">
                  {t("admin.ops.created")}: {new Date(s.createdAt).toLocaleString(locale)}
                  <br />
                  {t("admin.ops.active")}: {new Date(s.lastActiveAt).toLocaleString(locale)}
                  <br />
                  {s.participants === null
                    ? t("admin.ops.unknown")
                    : t("admin.ops.participants", { count: s.participants })}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {([s.locked ? "unlock" : "lock", "delete"] as const).map((value) => (
                    <Button
                      key={value}
                      size="sm"
                      aria-label={`${t(`admin.ops.${value}`)}: ${s.title || t("admin.ops.untitled")}`}
                      variant={value === "delete" ? "danger" : "secondary"}
                      onClick={() => {
                        action.reset();
                        setConfirm({ share: s, action: value });
                      }}
                    >
                      {t(`admin.ops.${value}`)}
                    </Button>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap gap-2">
          {before && <Button onClick={() => setBefore(undefined)}>{t("admin.ops.newest")}</Button>}
          {query.data?.length === 100 && (
            <Button
              onClick={() =>
                (() => {
                  const last = query.data?.at(-1);
                  if (last) setBefore({ at: last.createdAt, id: last.id });
                })()
              }
            >
              {t("admin.ops.older")}
            </Button>
          )}
        </div>
      </QueryState>
      <Dialog
        open={confirm !== null}
        onOpenChange={(open) => !open && !action.isPending && setConfirm(null)}
      >
        <DialogContent
          title={confirm ? t(`admin.ops.${confirm.action}`) : t("admin.ops.confirm")}
          description={t("admin.ops.confirmBody")}
          closeLabel={t("common.close")}
          footer={
            <>
              <Button disabled={action.isPending} onClick={() => setConfirm(null)}>
                {t("common.cancel")}
              </Button>
              <Button
                variant="danger"
                loading={action.isPending}
                loadingLabel={t("common.loading")}
                onClick={() => confirm && action.mutate(confirm)}
              >
                {confirm ? t(`admin.ops.${confirm.action}`) : t("admin.ops.confirm")}
              </Button>
            </>
          }
        >
          <p className="break-all text-body-sm">{confirm?.share.title || confirm?.share.id}</p>
          {action.isError && <p role="alert">{t("admin.error.body")}</p>}
        </DialogContent>
      </Dialog>
    </section>
  );
}
