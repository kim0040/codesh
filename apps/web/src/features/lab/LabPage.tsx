import { formatRelativeTime } from "@gachipad/i18n";
import type { GetLabResponse, UserRef } from "@gachipad/shared";
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
  Spinner,
  toast,
} from "@gachipad/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowLeft,
  Copy,
  Expand,
  GraduationCap,
  Lock,
  LockOpen,
  Send,
  TriangleAlert,
  Users,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, isApiError } from "../../lib/api";
import type { DocSession } from "../../lib/collab/session";
import { useSseEvent } from "../../lib/events";
import { copyText, firstLines, groupCode } from "../../lib/format";
import { useLocale, useT } from "../../lib/i18n";
import { useSession } from "../../lib/session";
import { LoadFailedScreen, LoadingScreen, NotFoundShare } from "../editor/gates";
import { usePreview, usePreviewSession } from "./use-preview";

/** Teachers see every student's work live; students are sent to their own copy. */
export function LabPage({ idOrCode }: { idOrCode: string }) {
  if (idOrCode === "new") return <LabCreate />;
  return <LabLoader id={idOrCode} />;
}

function LabCreate() {
  const t = useT();
  const navigate = useNavigate();
  const [title, setTitle] = useState("");
  const create = useMutation({
    mutationFn: () => api.createLab({ title: title.trim() || undefined }),
    onSuccess: (lab) => void navigate({ to: "/lab/$id", params: { id: lab.id }, replace: true }),
    onError: () => toast({ title: t("lab.error.title"), tone: "danger" }),
  });
  return (
    <main
      id="main"
      className="mx-auto grid min-h-dvh w-full max-w-md place-items-center px-4 py-12"
    >
      <form
        className="flex w-full flex-col gap-4 rounded-xl border border-line bg-panel p-5"
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate();
        }}
      >
        <div className="flex flex-col gap-1">
          <h1 className="flex items-center gap-2 text-heading font-semibold">
            <GraduationCap aria-hidden="true" className="size-5 text-fg-3" />
            {t("lab.create.title")}
          </h1>
          <p className="text-body-sm text-fg-2">{t("lab.create.body")}</p>
        </div>
        <Field label={t("editor.top.titleLabel")}>
          <Input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={t("editor.top.titlePlaceholder")}
            maxLength={200}
          />
        </Field>
        <Button
          type="submit"
          variant="primary"
          loading={create.isPending}
          loadingLabel={t("common.loading")}
          data-testid="lab-create"
        >
          {t("lab.create.action")}
        </Button>
      </form>
    </main>
  );
}

function LabLoader({ id }: { id: string }) {
  const t = useT();
  const queryClient = useQueryClient();
  const lab = useQuery({
    queryKey: ["lab", id],
    queryFn: ({ signal }) => api.getLab(id, signal),
    retry: false,
  });

  useSseEvent("lab", (event) => {
    if (event.labId !== id) return;
    void queryClient.invalidateQueries({ queryKey: ["lab", id] });
    // A student joining shows up in the grid; the other events deserve a word.
    if (event.kind !== "joined")
      toast({ title: t(`lab.event.${event.kind}`), tone: "info", duration: 3000 });
  });

  if (lab.isPending) return <LoadingScreen label={t("lab.loading")} />;
  if (lab.isError) {
    if (isApiError(lab.error, "not_found") || isApiError(lab.error, "expired"))
      return <NotFoundShare />;
    return (
      <LoadFailedScreen
        title={t("lab.error.title")}
        hint={t("lab.error.body")}
        onRetry={() => void lab.refetch()}
      />
    );
  }
  return lab.data.role === "teacher" ? <Teacher lab={lab.data} /> : <Student lab={lab.data} />;
}

// ── student ─────────────────────────────────────────────────────────

function Student({ lab }: { lab: GetLabResponse }) {
  const t = useT();
  const navigate = useNavigate();
  const session = useSession();
  const [name, setName] = useState(session.data?.name ?? "");
  const [missing, setMissing] = useState(false);
  const own = lab.students[0];

  useEffect(() => {
    if (own) void navigate({ to: "/$id", params: { id: own.shareId }, replace: true });
  }, [own, navigate]);

  const join = useMutation({
    mutationFn: () => api.joinLab(lab.id, name.trim()),
    onSuccess: ({ shareId }) =>
      void navigate({ to: "/$id", params: { id: shareId }, replace: true }),
    onError: () => toast({ title: t("lab.error.title"), tone: "danger" }),
  });

  if (own) return <LoadingScreen label={t("lab.loading")} />;
  return (
    <main
      id="main"
      className="mx-auto grid min-h-dvh w-full max-w-md place-items-center px-4 py-12"
    >
      <form
        className="flex w-full flex-col gap-4 rounded-xl border border-line bg-panel p-5"
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim()) join.mutate();
          else setMissing(true);
        }}
      >
        <div className="flex flex-col gap-1">
          <h1 className="text-heading font-semibold">
            {t("lab.student.title", { title: lab.title || t("common.untitled") })}
          </h1>
          <p className="text-body-sm text-fg-2">{t("lab.student.joinBody")}</p>
          {lab.locked ? (
            <p className="text-body-sm text-warning-text">{t("lab.student.locked")}</p>
          ) : null}
        </div>
        <Field
          label={t("identity.nameLabel")}
          error={missing && !name.trim() ? t("identity.nameRequired") : undefined}
        >
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t("identity.namePlaceholder")}
            maxLength={40}
            data-testid="lab-name"
          />
        </Field>
        <Button
          type="submit"
          variant="primary"
          loading={join.isPending}
          loadingLabel={t("common.loading")}
          data-testid="lab-join"
        >
          {t("intro.join.submitAction")}
        </Button>
      </form>
    </main>
  );
}

// ── teacher ─────────────────────────────────────────────────────────

const CELL_MIN_WIDTH = 260;
const CELL_HEIGHT = 196;
const GAP = 12;
const VIRTUALIZE_FROM = 20;

function Teacher({ lab }: { lab: GetLabResponse }) {
  const t = useT();
  const queryClient = useQueryClient();
  const session = useSession();
  const [zoom, setZoom] = useState<string | null>(null);
  const [distributing, setDistributing] = useState(false);
  const students = lab.students;
  const me = useMemo<UserRef | null>(
    () =>
      session.data
        ? {
            clientId: session.data.clientId,
            name: session.data.name ?? "",
            color: session.data.color,
          }
        : null,
    [session.data],
  );

  const lock = useMutation({
    mutationFn: (locked: boolean) => api.patchLab(lab.id, { locked }),
    onSuccess: (data) => queryClient.setQueryData(["lab", lab.id], data),
    onError: () => toast({ title: t("error.generic"), tone: "danger" }),
  });

  return (
    <div className="flex min-h-dvh flex-col" data-testid="lab-teacher">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line bg-panel px-4 py-3">
        <Link
          to="/"
          aria-label={t("editor.top.back")}
          className="inline-flex size-8 items-center justify-center rounded-md text-fg-2 hover:bg-fill-hover coarse:size-11"
        >
          <ArrowLeft aria-hidden="true" className="size-4 rtl:rotate-180" />
        </Link>
        <h1 className="min-w-0 truncate text-body font-semibold">{lab.title || t("lab.mode")}</h1>
        <div className="flex items-center gap-2">
          <span className="text-caption text-fg-3">{t("lab.code.label")}</span>
          <output
            className="font-mono text-heading font-semibold tracking-[0.1em] tabular"
            data-testid="lab-code"
          >
            {groupCode(lab.joinCode)}
          </output>
          <Button
            size="sm"
            leading={<Copy />}
            onClick={() =>
              void copyText(lab.joinCode).then(
                (ok) =>
                  ok && toast({ title: t("toast.codeCopied"), tone: "success", duration: 2000 }),
              )
            }
          >
            {t("common.copy")}
          </Button>
        </div>
        <div className="ms-auto flex flex-wrap items-center gap-2">
          <Badge tone={lab.locked ? "warning" : "success"}>
            {lab.locked ? t("lab.lock.locked") : t("lab.lock.unlocked")}
          </Badge>
          <Button
            size="sm"
            leading={lab.locked ? <LockOpen /> : <Lock />}
            loading={lock.isPending}
            loadingLabel={t("common.loading")}
            onClick={() => lock.mutate(!lab.locked)}
            data-testid="lab-lock"
          >
            {lab.locked ? t("lab.unlock.action") : t("lab.lock.action")}
          </Button>
          <Button
            size="sm"
            variant="primary"
            leading={<Send />}
            onClick={() => setDistributing(true)}
            data-testid="lab-distribute"
          >
            {t("lab.distribute.title")}
          </Button>
        </div>
      </header>

      <main id="main" className="flex min-h-0 flex-1 flex-col gap-3 p-4">
        <h2 className="flex items-center gap-2 text-body-sm font-semibold">
          <Users aria-hidden="true" className="size-4 text-fg-3" />
          {t("lab.grid.title")}
          <span className="font-normal text-fg-3" data-testid="lab-count">
            {t("lab.grid.students", { count: students.length })}
          </span>
        </h2>
        {students.length === 0 ? (
          <EmptyState
            icon={<Users />}
            title={t("lab.empty.title")}
            description={t("lab.empty.body")}
          />
        ) : me ? (
          <StudentGrid students={students} me={me} onZoom={setZoom} />
        ) : (
          <Skeleton className="h-48" />
        )}
      </main>

      <ZoomDialog
        student={students.find((s) => s.shareId === zoom)}
        me={me}
        onClose={() => setZoom(null)}
      />
      <DistributeDialog
        open={distributing}
        labId={lab.id}
        current={lab.templateShareId}
        onClose={() => setDistributing(false)}
      />
    </div>
  );
}

type Student = GetLabResponse["students"][number];

function StudentGrid({
  students,
  me,
  onZoom,
}: {
  students: Student[];
  me: UserRef;
  onZoom: (shareId: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    setWidth(element.clientWidth);
    return () => observer.disconnect();
  }, []);

  const columns = Math.max(1, Math.floor((width + GAP) / (CELL_MIN_WIDTH + GAP)));
  const rows = Math.ceil(students.length / columns);
  const virtual = students.length >= VIRTUALIZE_FROM;
  const virtualizer = useVirtualizer({
    count: rows,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => CELL_HEIGHT + GAP,
    overscan: 1,
    enabled: virtual,
  });

  return (
    <div
      ref={scrollRef}
      className="min-h-0 flex-1 overflow-y-auto"
      data-testid="lab-grid"
      data-virtual={virtual || undefined}
    >
      {virtual ? (
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {virtualizer.getVirtualItems().map((row) => (
            <ul
              key={row.key}
              className="absolute inset-x-0 grid gap-3"
              style={{
                top: 0,
                transform: `translateY(${row.start}px)`,
                height: CELL_HEIGHT,
                gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
              }}
            >
              {students.slice(row.index * columns, row.index * columns + columns).map((student) => (
                <li key={student.clientId} className="min-w-0">
                  <StudentCell student={student} me={me} onZoom={onZoom} />
                </li>
              ))}
            </ul>
          ))}
        </div>
      ) : (
        <ul
          className="grid gap-3"
          style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
        >
          {students.map((student) => (
            <li key={student.clientId} className="min-w-0" style={{ height: CELL_HEIGHT }}>
              <StudentCell student={student} me={me} onZoom={onZoom} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function StudentCell({
  student,
  me,
  onZoom,
}: {
  student: Student;
  me: UserRef;
  onZoom: (shareId: string) => void;
}) {
  const session = usePreviewSession(student.shareId, me);
  return (
    <article
      aria-label={student.name}
      data-testid={`student-${student.name}`}
      className="flex h-full flex-col overflow-hidden rounded-xl border border-line bg-panel"
    >
      {session ? (
        <CellBody session={session} student={student} onZoom={onZoom} />
      ) : (
        <CellSkeleton student={student} />
      )}
    </article>
  );
}

function CellSkeleton({ student }: { student: Student }) {
  const t = useT();
  return (
    <>
      <CellHeader
        name={student.name}
        status={<Spinner size="sm" label={t("a11y.loading")} />}
        actions={null}
      />
      <Skeleton className="m-3 flex-1" />
    </>
  );
}

function CellHeader({
  name,
  status,
  actions,
}: {
  name: string;
  status: React.ReactNode;
  actions: React.ReactNode;
}) {
  return (
    <header className="flex items-center gap-2 border-b border-line px-3 py-2">
      <h3 className="min-w-0 flex-1 truncate text-body-sm font-medium">{name}</h3>
      {status}
      {actions}
    </header>
  );
}

function CellBody({
  session,
  student,
  onZoom,
}: {
  session: DocSession;
  student: Student;
  onZoom: (shareId: string) => void;
}) {
  const t = useT();
  const [locale] = useLocale();
  const preview = usePreview(session);
  const navigate = useNavigate();
  const connected = preview.state.status === "connected";
  const status = !connected ? "offline" : preview.online ? "online" : "idle";
  return (
    <>
      <CellHeader
        name={student.name}
        status={
          <span className="flex items-center gap-1.5 text-caption text-fg-3" data-status={status}>
            <span
              aria-hidden="true"
              className={`size-2 rounded-full ${status === "online" ? "bg-success" : status === "idle" ? "bg-fg-3" : "bg-warning"}`}
            />
            {status === "offline"
              ? t("lab.grid.offline")
              : status === "online"
                ? t("lab.grid.online", { count: 1 })
                : t("lab.grid.idle")}
          </span>
        }
        actions={
          <>
            <button
              type="button"
              aria-label={`${t("lab.grid.zoomAction")}: ${student.name}`}
              onClick={() => onZoom(student.shareId)}
              className="inline-flex size-7 items-center justify-center rounded-md text-fg-2 hover:bg-fill-hover coarse:size-10"
            >
              <Expand aria-hidden="true" className="size-4" />
            </button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void navigate({ to: "/$id", params: { id: student.shareId } })}
            >
              {t("lab.grid.enterAction")}
            </Button>
          </>
        }
      />
      <div className="relative min-h-0 flex-1">
        {preview.text ? (
          <pre
            className="absolute inset-0 overflow-hidden p-3 font-mono text-[0.6875rem] leading-snug text-fg-2"
            data-testid="student-code"
          >
            {firstLines(preview.text, 12)}
          </pre>
        ) : (
          <p className="p-3 text-caption text-fg-3">{t("lab.grid.untouched")}</p>
        )}
        {preview.text && preview.changedAt ? (
          <span className="absolute bottom-1.5 end-2 rounded bg-panel/90 px-1.5 text-caption text-fg-3">
            {t("lab.grid.edited", {
              time: formatRelativeTime(locale, preview.changedAt - Date.now()),
            })}
          </span>
        ) : null}
      </div>
    </>
  );
}

function ZoomDialog({
  student,
  me,
  onClose,
}: {
  student: Student | undefined;
  me: UserRef | null;
  onClose: () => void;
}) {
  const t = useT();
  const navigate = useNavigate();
  return (
    <Dialog open={student !== undefined} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        size="lg"
        title={student?.name ?? ""}
        closeLabel={t("lab.grid.backAction")}
        footer={
          student ? (
            <Button
              variant="primary"
              onClick={() => void navigate({ to: "/$id", params: { id: student.shareId } })}
            >
              {t("lab.grid.enterAction")}
            </Button>
          ) : null
        }
      >
        {student && me ? <ZoomBody shareId={student.shareId} me={me} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function ZoomBody({ shareId, me }: { shareId: string; me: UserRef }) {
  const session = usePreviewSession(shareId, me);
  if (!session) return <Skeleton className="h-64" />;
  return <ZoomText session={session} />;
}

function ZoomText({ session }: { session: DocSession }) {
  const t = useT();
  const preview = usePreview(session);
  return preview.text ? (
    <pre
      className="max-h-[60dvh] overflow-auto rounded-md bg-bg p-3 font-mono text-caption leading-snug"
      data-testid="zoom-code"
    >
      {preview.text}
    </pre>
  ) : (
    <p className="text-body-sm text-fg-3">{t("lab.grid.untouched")}</p>
  );
}

function DistributeDialog({
  open,
  labId,
  current,
  onClose,
}: {
  open: boolean;
  labId: string;
  current: string | null;
  onClose: () => void;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const shares = useQuery({
    queryKey: ["shares"],
    queryFn: ({ signal }) => api.listShares(signal),
    enabled: open,
  });
  const [template, setTemplate] = useState(current ?? "");
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (open) {
      setTemplate(current ?? "");
      setConfirming(false);
    }
  }, [open, current]);

  const send = useMutation({
    mutationFn: async () => {
      if (template && template !== current)
        await api.patchLab(labId, { templateShareId: template });
      return api.distributeLab(labId);
    },
    onSuccess: ({ count }) => {
      toast({ title: t("lab.distribute.done", { count }), tone: "success" });
      void queryClient.invalidateQueries({ queryKey: ["lab", labId] });
      onClose();
    },
    onError: () => {
      toast({ title: t("error.generic"), tone: "danger" });
      setConfirming(false);
    },
  });

  const options = (shares.data ?? []).map((share) => ({
    value: share.id,
    label: share.title || t("common.untitled"),
  }));

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        size="md"
        title={t("lab.distribute.title")}
        description={t("lab.distribute.body")}
        closeLabel={t("common.close")}
        footer={
          confirming ? (
            <>
              <Button onClick={() => setConfirming(false)}>{t("common.cancel")}</Button>
              <Button
                variant="primary"
                loading={send.isPending}
                loadingLabel={t("common.loading")}
                onClick={() => send.mutate()}
                data-testid="lab-distribute-confirm"
              >
                {t("lab.distribute.action")}
              </Button>
            </>
          ) : (
            <Button variant="primary" disabled={!template} onClick={() => setConfirming(true)}>
              {t("lab.distribute.action")}
            </Button>
          )
        }
      >
        <div className="flex flex-col gap-3">
          <Field label={t("lab.distribute.templateLabel")}>
            {shares.isPending ? (
              <Skeleton className="h-8" />
            ) : shares.isError ? (
              <p className="flex items-center gap-1.5 text-body-sm text-danger-text">
                <TriangleAlert aria-hidden="true" className="size-4" />
                {t("myshares.error.title")}
              </p>
            ) : (
              <Select
                value={template}
                onValueChange={setTemplate}
                options={options}
                placeholder={t("lab.distribute.templateLabel")}
              />
            )}
          </Field>
          {confirming ? (
            <div role="alert" className="rounded-lg border border-line bg-fill-hover p-3">
              <p className="text-body-sm font-medium">{t("lab.distribute.confirmTitle")}</p>
              <p className="text-caption text-fg-2">{t("lab.distribute.confirmBody")}</p>
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
