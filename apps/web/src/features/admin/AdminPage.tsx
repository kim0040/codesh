import { formatRelativeTime } from "@codesh/i18n";
import type { Settings } from "@codesh/shared";
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Input,
  Skeleton,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  toast,
} from "@codesh/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  ArrowLeft,
  Plus,
  ScrollText,
  ShieldCheck,
  Trash2,
  TriangleAlert,
  Users,
} from "lucide-react";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { api, isApiError, rawRequest } from "../../lib/api";
import { usePresence } from "../../lib/events";
import { formatBytes } from "../../lib/format";
import { useLocale, useT } from "../../lib/i18n";

const TOKEN_KEY = "codesh.admin";

function loadToken(): string {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

function saveToken(token: string) {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // The token then lives only for this page view.
  }
}

export function AdminPage() {
  const [token, setToken] = useState(loadToken);
  const logout = () => {
    saveToken("");
    setToken("");
  };
  return token ? (
    <AdminConsole token={token} onLogout={logout} />
  ) : (
    <Login
      onToken={(value) => {
        saveToken(value);
        setToken(value);
      }}
    />
  );
}

function Login({ onToken }: { onToken: (token: string) => void }) {
  const t = useT();
  const [value, setValue] = useState("");
  const [invalid, setInvalid] = useState(false);
  const [empty, setEmpty] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!value.trim()) {
      setEmpty(true);
      return;
    }
    setBusy(true);
    setInvalid(false);
    try {
      await api.admin.settings(value.trim());
      onToken(value.trim());
    } catch (error) {
      if (isApiError(error) && (error.status === 401 || error.status === 403)) setInvalid(true);
      else
        toast({
          title: t("admin.error.title"),
          description: t("admin.error.body"),
          tone: "danger",
        });
    } finally {
      setBusy(false);
    }
  };

  return (
    <main id="main" className="grid min-h-dvh place-items-center px-4 py-12">
      <form
        onSubmit={submit}
        className="flex w-full max-w-sm flex-col gap-4 rounded-xl border border-line bg-panel p-5"
      >
        <h1 className="flex items-center gap-2 text-heading font-semibold">
          <ShieldCheck aria-hidden="true" className="size-5 text-fg-3" />
          {t("admin.login.title")}
        </h1>
        <Field
          label={t("admin.login.tokenLabel")}
          error={
            invalid
              ? t("admin.login.invalid")
              : empty && !value.trim()
                ? t("admin.login.required")
                : undefined
          }
        >
          <Input
            autoFocus
            type="password"
            autoComplete="off"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            data-testid="admin-token"
          />
        </Field>
        <Button
          type="submit"
          variant="primary"
          loading={busy}
          loadingLabel={t("common.loading")}
          data-testid="admin-login"
        >
          {t("admin.login.action")}
        </Button>
      </form>
    </main>
  );
}

function AdminConsole({ token, onLogout }: { token: string; onLogout: () => void }) {
  const t = useT();
  const [tab, setTab] = useState("settings");
  const settings = useQuery({
    queryKey: ["admin", "settings", token],
    queryFn: () => api.admin.settings(token),
    retry: false,
  });

  useEffect(() => {
    if (
      isApiError(settings.error) &&
      (settings.error.status === 401 || settings.error.status === 403)
    )
      onLogout();
  }, [settings.error, onLogout]);

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-4xl flex-col gap-5 px-4 py-6 sm:py-10">
      <header className="flex flex-wrap items-center gap-3">
        <Link
          to="/"
          aria-label={t("editor.top.back")}
          className="inline-flex size-8 items-center justify-center rounded-md text-fg-2 hover:bg-fill-hover coarse:size-11"
        >
          <ArrowLeft aria-hidden="true" className="size-4 rtl:rotate-180" />
        </Link>
        <h1 className="text-heading font-semibold">{t("admin.title")}</h1>
        <Button size="sm" className="ms-auto" onClick={onLogout}>
          {t("admin.logoutAction")}
        </Button>
      </header>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList aria-label={t("admin.title")}>
          <TabsTrigger value="settings">{t("admin.nav.settings")}</TabsTrigger>
          <TabsTrigger value="people">{t("admin.nav.people")}</TabsTrigger>
          <TabsTrigger value="audit">{t("admin.nav.audit")}</TabsTrigger>
          <TabsTrigger value="status">{t("admin.nav.status")}</TabsTrigger>
        </TabsList>
        <main id="main" className="pt-5">
          <TabsContent value="settings">
            {settings.isPending ? (
              <Loading />
            ) : settings.isError ? (
              <ErrorBlock onRetry={() => void settings.refetch()} />
            ) : (
              <SettingsForm token={token} initial={settings.data} />
            )}
          </TabsContent>
          <TabsContent value="people">
            <People />
          </TabsContent>
          <TabsContent value="audit">
            <Audit
              token={token}
              enabled={settings.data?.audit.enabled ?? false}
              onOpenSettings={() => setTab("settings")}
            />
          </TabsContent>
          <TabsContent value="status">
            <Status token={token} />
          </TabsContent>
        </main>
      </Tabs>
    </div>
  );
}

function Loading() {
  const t = useT();
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={t("admin.loading")}
      className="flex flex-col gap-3"
    >
      <Skeleton className="h-10" />
      <Skeleton className="h-10" />
      <Skeleton className="h-10" />
    </div>
  );
}

function ErrorBlock({ onRetry }: { onRetry: () => void }) {
  const t = useT();
  return (
    <EmptyState
      tone="danger"
      icon={<TriangleAlert />}
      title={t("admin.error.title")}
      description={t("admin.error.body")}
      action={<Button onClick={onRetry}>{t("common.retry")}</Button>}
    />
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-4 rounded-xl border border-line bg-panel p-4">
      <h2 className="text-body-sm font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function NumberField({
  label,
  hint,
  value,
  onChange,
  min,
  max,
  unit,
  step,
  testId,
}: {
  label: string;
  hint: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  unit?: string;
  step?: number;
  testId?: string;
}) {
  return (
    <Field label={label} hint={hint}>
      <Input
        type="number"
        inputMode="decimal"
        min={min}
        max={max}
        step={step}
        value={Number.isFinite(value) ? value : ""}
        onChange={(event) =>
          onChange(event.target.value === "" ? Number.NaN : Number(event.target.value))
        }
        trailing={unit ? <span className="text-caption text-fg-3">{unit}</span> : undefined}
        data-testid={testId}
      />
    </Field>
  );
}

function SettingsForm({ token, initial }: { token: string; initial: Settings }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Settings>(initial);
  useEffect(() => setDraft(initial), [initial]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const patch = (next: Partial<Settings>) => setDraft((previous) => ({ ...previous, ...next }));

  const save = useMutation({
    mutationFn: () => api.admin.putSettings(token, draft),
    onSuccess: (saved) => {
      queryClient.setQueryData(["admin", "settings", token], saved);
      toast({ title: t("admin.saved"), tone: "success", duration: 2500 });
    },
    onError: () => toast({ title: t("admin.saveFailed"), tone: "danger" }),
  });

  const valid = [
    draft.anonymousTtlHours,
    draft.historyRetentionDays,
    draft.maxDocBytes,
    draft.maxUploadMB,
    draft.audit.retentionDays,
  ].every(Number.isFinite);

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid) save.mutate();
      }}
    >
      <Group title={t("admin.setting.group.sharing")}>
        <div className="grid gap-4 sm:grid-cols-2">
          <NumberField
            label={t("admin.setting.anonymousTtlHours.label")}
            hint={t("admin.setting.anonymousTtlHours.hint")}
            value={draft.anonymousTtlHours}
            min={1}
            unit={t("admin.unit.hours", { count: draft.anonymousTtlHours })}
            onChange={(anonymousTtlHours) => patch({ anonymousTtlHours })}
            testId="set-ttl"
          />
          <NumberField
            label={t("admin.setting.historyRetentionDays.label")}
            hint={t("admin.setting.historyRetentionDays.hint")}
            value={draft.historyRetentionDays}
            min={0}
            step={1}
            unit={t("admin.unit.days", { count: draft.historyRetentionDays })}
            onChange={(historyRetentionDays) => patch({ historyRetentionDays })}
          />
          <NumberField
            label={t("admin.setting.maxDocBytes.label")}
            hint={`${t("admin.setting.maxDocBytes.hint")} (${formatBytes(draft.maxDocBytes)})`}
            value={draft.maxDocBytes}
            min={1024}
            step={1024}
            unit="B"
            onChange={(maxDocBytes) => patch({ maxDocBytes })}
          />
          <NumberField
            label={t("admin.setting.maxUploadMB.label")}
            hint={t("admin.setting.maxUploadMB.hint")}
            value={draft.maxUploadMB}
            min={1}
            unit="MB"
            onChange={(maxUploadMB) => patch({ maxUploadMB })}
          />
        </div>
        <Switch
          label={t("admin.setting.guestAllowed.label")}
          description={t("admin.setting.guestAllowed.hint")}
          checked={draft.guestAllowed}
          onCheckedChange={(guestAllowed) => patch({ guestAllowed })}
        />
      </Group>

      <Group title={t("admin.setting.group.nearby")}>
        <Switch
          label={t("admin.setting.nearbyDefault.label")}
          description={t("admin.setting.nearbyDefault.hint")}
          checked={draft.nearbyDefault}
          onCheckedChange={(nearbyDefault) => patch({ nearbyDefault })}
        />
        <NumberField
          label={t("admin.setting.subnetPrefixV4.label")}
          hint={t("admin.setting.subnetPrefixV4.hint")}
          value={draft.subnetPrefixV4}
          min={8}
          max={32}
          step={1}
          unit="/n"
          onChange={(subnetPrefixV4) => patch({ subnetPrefixV4 })}
        />
        <div className="flex flex-col gap-3">
          <div>
            <h3 className="text-label font-medium">{t("admin.setting.rooms.label")}</h3>
            <p className="text-caption text-fg-3">{t("admin.setting.rooms.hint")}</p>
          </div>
          {draft.rooms.length === 0 ? (
            <p className="text-body-sm text-fg-3">{t("admin.setting.rooms.empty")}</p>
          ) : null}
          {draft.rooms.map((room, index) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: rooms have no stable id while being edited
              key={index}
              className="flex flex-col gap-2 rounded-lg border border-line p-3 sm:flex-row sm:items-start"
            >
              <Field label={t("admin.setting.rooms.nameLabel")} className="sm:w-48">
                <Input
                  value={room.name}
                  onChange={(event) =>
                    patch({
                      rooms: draft.rooms.map((r, i) =>
                        i === index ? { ...r, name: event.target.value } : r,
                      ),
                    })
                  }
                />
              </Field>
              <Field
                label={t("admin.setting.rooms.cidrsLabel")}
                hint={t("admin.setting.rooms.cidrsHint")}
                className="flex-1"
              >
                <textarea
                  rows={2}
                  value={room.cidrs.join("\n")}
                  onChange={(event) =>
                    patch({
                      rooms: draft.rooms.map((r, i) =>
                        i === index
                          ? {
                              ...r,
                              cidrs: event.target.value
                                .split("\n")
                                .map((line) => line.trim())
                                .filter(Boolean),
                            }
                          : r,
                      ),
                    })
                  }
                  className="w-full rounded-md border border-line-control bg-panel p-2 font-mono text-caption focus:border-accent-text"
                />
              </Field>
              <Button
                size="sm"
                variant="ghost"
                leading={<Trash2 />}
                onClick={() => patch({ rooms: draft.rooms.filter((_, i) => i !== index) })}
              >
                {t("admin.setting.rooms.removeAction")}
              </Button>
            </div>
          ))}
          <Button
            size="sm"
            leading={<Plus />}
            className="self-start"
            onClick={() => patch({ rooms: [...draft.rooms, { name: "", cidrs: [] }] })}
          >
            {t("admin.setting.rooms.addAction")}
          </Button>
        </div>
      </Group>

      <Group title={t("admin.setting.group.privacy")}>
        <Switch
          label={t("admin.setting.auditEnabled.label")}
          description={t("admin.setting.auditEnabled.hint")}
          checked={draft.audit.enabled}
          onCheckedChange={(enabled) => patch({ audit: { ...draft.audit, enabled } })}
          data-testid="set-audit"
        />
        <NumberField
          label={t("admin.setting.auditRetentionDays.label")}
          hint={t("admin.setting.auditRetentionDays.hint")}
          value={draft.audit.retentionDays}
          min={1}
          step={1}
          unit={t("admin.unit.days", { count: draft.audit.retentionDays })}
          onChange={(retentionDays) => patch({ audit: { ...draft.audit, retentionDays } })}
        />
        <Switch
          label={t("admin.setting.secretWarning.label")}
          description={t("admin.setting.secretWarning.hint")}
          checked={draft.secretWarning}
          onCheckedChange={(secretWarning) => patch({ secretWarning })}
        />
      </Group>

      <Group title={t("admin.setting.group.login")}>
        <p className="text-caption text-fg-3">{t("admin.setting.login.hint")}</p>
        <ul className="flex flex-col gap-2">
          {(["oidc", "ldap"] as const).map((provider) => (
            <li
              key={provider}
              className="flex items-center justify-between gap-3 rounded-lg border border-line px-3 py-2"
            >
              <span className="text-body-sm">{t(`admin.setting.${provider}.label`)}</span>
              <Badge tone={draft.auth[provider] ? "success" : "neutral"}>
                {draft.auth[provider]
                  ? t("admin.setting.login.configured")
                  : t("admin.setting.login.notConfigured")}
              </Badge>
            </li>
          ))}
        </ul>
        <Field label={t("admin.setting.contact.label")} hint={t("admin.setting.contact.hint")}>
          <Input
            value={draft.contact}
            placeholder={t("admin.setting.contact.placeholder")}
            onChange={(event) => patch({ contact: event.target.value })}
          />
        </Field>
      </Group>

      <div className="sticky bottom-0 -mx-1 flex flex-wrap items-center gap-3 border-t border-line bg-bg/95 px-1 py-3 backdrop-blur">
        <span role="status" className="me-auto text-caption text-fg-3">
          {dirty ? t("admin.unsaved") : ""}
        </span>
        <Button disabled={!dirty} onClick={() => setDraft(initial)}>
          {t("admin.discardAction")}
        </Button>
        <Button
          type="submit"
          variant="primary"
          disabled={!dirty || !valid}
          loading={save.isPending}
          loadingLabel={t("common.loading")}
          data-testid="admin-save"
        >
          {t("admin.saveAction")}
        </Button>
      </div>
    </form>
  );
}

function People() {
  const t = useT();
  const people = usePresence();
  return (
    <section aria-labelledby="people-h" className="flex flex-col gap-3">
      <h2 id="people-h" className="flex items-center gap-2 text-body-sm font-semibold">
        <Users aria-hidden="true" className="size-4 text-fg-3" />
        {t("admin.people.online", { count: people.length })}
      </h2>
      {people.length === 0 ? (
        <EmptyState size="sm" icon={<Users />} title={t("admin.people.empty")} />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line">
          <table className="w-full min-w-72 text-start text-body-sm">
            <thead className="bg-fill-hover text-caption text-fg-3">
              <tr>
                <th scope="col" className="px-3 py-2 text-start font-medium">
                  {t("admin.people.column.name")}
                </th>
                <th scope="col" className="px-3 py-2 text-start font-medium">
                  {t("admin.people.column.room")}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {people.map((person) => (
                <tr key={person.clientId}>
                  <td className="px-3 py-2">
                    <span className="flex items-center gap-2">
                      <span
                        aria-hidden="true"
                        className="size-2.5 rounded-full"
                        style={{ backgroundColor: person.color }}
                      />
                      {person.name}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-fg-2">{person.room ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

const AUDIT_PAGE = 50;

function Audit({
  token,
  enabled,
  onOpenSettings,
}: {
  token: string;
  enabled: boolean;
  onOpenSettings: () => void;
}) {
  const t = useT();
  const [locale] = useLocale();
  const [entries, setEntries] = useState<Awaited<ReturnType<typeof api.admin.audit>>>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [more, setMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(
    async (before?: string) => {
      try {
        const page = await api.admin.audit(token, { limit: AUDIT_PAGE, before });
        setEntries((previous) => (before ? [...previous, ...page] : page));
        setMore(page.length === AUDIT_PAGE);
        setState("ready");
      } catch {
        setState("error");
      }
    },
    [token],
  );

  useEffect(() => {
    setState("loading");
    void load();
  }, [load]);

  if (!enabled && entries.length === 0 && state !== "loading") {
    return (
      <EmptyState
        icon={<ScrollText />}
        title={t("admin.audit.off.title")}
        description={t("admin.audit.off.body")}
        action={<Button onClick={onOpenSettings}>{t("admin.audit.off.action")}</Button>}
      />
    );
  }
  if (state === "loading") return <Loading />;
  if (state === "error") return <ErrorBlock onRetry={() => void load()} />;
  if (entries.length === 0)
    return <EmptyState size="sm" icon={<ScrollText />} title={t("admin.audit.empty")} />;

  const actionLabel = (action: string) => {
    if (action === "share.create") return t("admin.audit.action.create");
    if (action === "share.join" || action === "share.open") return t("admin.audit.action.open");
    if (action === "share.download") return t("admin.audit.action.download");
    if (action === "share.delete") return t("admin.audit.action.delete");
    return t("admin.audit.action.unknown");
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-x-auto rounded-xl border border-line">
        <table className="w-full min-w-xl text-body-sm">
          <thead className="bg-fill-hover text-caption text-fg-3">
            <tr>
              {(["time", "actor", "action", "share", "network"] as const).map((column) => (
                <th key={column} scope="col" className="px-3 py-2 text-start font-medium">
                  {t(`admin.audit.column.${column}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {entries.map((entry, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: entries have no id
              <tr key={`${entry.at}-${index}`}>
                <td className="whitespace-nowrap px-3 py-2 text-fg-2">
                  <time dateTime={entry.at} title={new Date(entry.at).toLocaleString(locale)}>
                    {formatRelativeTime(locale, new Date(entry.at).getTime() - Date.now())}
                  </time>
                </td>
                <td className="px-3 py-2 font-mono text-caption">{entry.actor.slice(0, 8)}</td>
                <td className="px-3 py-2">{actionLabel(entry.action)}</td>
                <td className="px-3 py-2 font-mono text-caption">{entry.shareId ?? "—"}</td>
                <td className="px-3 py-2 font-mono text-caption">{entry.ip}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {more ? (
        <Button
          className="self-start"
          loading={loadingMore}
          loadingLabel={t("admin.audit.loading")}
          onClick={async () => {
            setLoadingMore(true);
            await load(entries.at(-1)?.at);
            setLoadingMore(false);
          }}
        >
          {t("admin.audit.loadMoreAction")}
        </Button>
      ) : null}
    </div>
  );
}

function Status({ token }: { token: string }) {
  const t = useT();
  const stats = useQuery({
    queryKey: ["admin", "stats", token],
    queryFn: () => api.admin.stats(token),
    refetchInterval: 10_000,
    retry: false,
  });
  const health = useQuery({
    queryKey: ["admin", "health"],
    queryFn: async () => (await rawRequest("GET", "/healthz")).ok,
    refetchInterval: 10_000,
    retry: false,
  });
  if (stats.isPending) return <Loading />;
  if (stats.isError) return <ErrorBlock onRetry={() => void stats.refetch()} />;
  const healthy = health.data === true;
  const cell = (label: string, value: number | string) => (
    <div className="flex flex-col gap-1 rounded-xl border border-line bg-panel p-4">
      <dt className="text-caption text-fg-3">{label}</dt>
      <dd className="text-heading font-semibold tabular">{value}</dd>
    </div>
  );
  return (
    <div className="flex flex-col gap-4">
      <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {cell(t("admin.status.shares"), stats.data.shares)}
        {cell(t("admin.status.people"), stats.data.onlineUsers)}
        {cell(t("lab.mode"), stats.data.labs)}
        {cell(t("admin.setting.maxUploadMB.label"), formatBytes(stats.data.uploadBytes))}
      </dl>
      <section className="flex flex-col gap-2 rounded-xl border border-line bg-panel p-4">
        <h2 className="text-body-sm font-semibold">{t("admin.health.title")}</h2>
        <Badge tone={healthy ? "success" : "warning"} className="self-start">
          {healthy ? t("admin.health.ok") : t("admin.health.degraded")}
        </Badge>
      </section>
      <section className="flex flex-col gap-1 rounded-xl border border-line bg-panel p-4">
        <h2 className="text-body-sm font-semibold">{t("admin.backup.title")}</h2>
        <p className="text-body-sm text-fg-2">{t("admin.backup.body")}</p>
      </section>
    </div>
  );
}
