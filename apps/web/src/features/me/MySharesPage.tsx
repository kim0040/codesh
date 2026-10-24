import { getLanguage } from "@codesh/highlight";
import { formatDuration, formatRelativeTime } from "@codesh/i18n";
import type { ShareListItem } from "@codesh/shared";
import {
  Badge,
  Button,
  cx,
  Dialog,
  DialogContent,
  EmptyState,
  IconButton,
  Input,
  LanguageBadge,
  Skeleton,
  ToggleGroup,
  ToggleGroupItem,
  toast,
} from "@codesh/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  ArrowLeft,
  Bookmark,
  Folder,
  FolderOpen,
  Plus,
  Search,
  SearchX,
  Tags,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { useMemo, useState } from "react";
import { api } from "../../lib/api";
import { firstLines } from "../../lib/format";
import { useLocale, useT } from "../../lib/i18n";
import {
  ALL_FOLDERS,
  type FolderFilter,
  labelKey,
  listFolders,
  listTags,
  matchesLabels,
  pruneFilters,
} from "../../lib/labels";
import { FolderNav } from "./FolderNav";
import { OrganizeDialog } from "./OrganizeDialog";

type Filter = "all" | "saved" | "owned";

export function MySharesPage() {
  const t = useT();
  const [locale] = useLocale();
  const queryClient = useQueryClient();
  const shares = useQuery({
    queryKey: ["shares"],
    queryFn: ({ signal }) => api.listShares(signal),
    retry: false,
  });
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [target, setTarget] = useState<ShareListItem | null>(null);
  const [organizing, setOrganizing] = useState<ShareListItem | null>(null);
  const [folderFilter, setFolderFilter] = useState<FolderFilter>(ALL_FOLDERS);
  const [tagKeys, setTagKeys] = useState<string[]>([]);

  const remove = useMutation({
    mutationFn: (share: ShareListItem) =>
      share.role === "owner" ? api.deleteShare(share.id) : api.unsaveShare(share.id),
    onSuccess: (_data, share) => {
      queryClient.setQueryData<ShareListItem[]>(["shares"], (old) =>
        old?.filter((item) => item.id !== share.id),
      );
      toast({
        title: share.role === "owner" ? t("toast.deleted") : t("toast.unsaved"),
        tone: "success",
        duration: 2500,
      });
      setTarget(null);
    },
    onError: () => {
      toast({ title: t("error.generic"), tone: "danger" });
      setTarget(null);
    },
  });

  // Folders and tags come from the whole list; a filter whose last share moved away drops out.
  const library = useMemo(() => {
    const all = shares.data ?? [];
    const { folders, unfiled } = listFolders(all);
    const active = pruneFilters(folderFilter, tagKeys, all);
    return {
      folders,
      unfiled,
      allTags: listTags(all),
      folder: active.folder,
      selected: active.tags,
    };
  }, [shares.data, folderFilter, tagKeys]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return [...(shares.data ?? [])]
      .filter((share) =>
        filter === "saved" ? share.saved : filter === "owned" ? share.role === "owner" : true,
      )
      .filter((share) => !q || share.title.toLowerCase().includes(q) || share.id.includes(q))
      .filter((share) => matchesLabels(share, library.folder, library.selected))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }, [shares.data, filter, query, library.folder, library.selected]);

  const total = shares.data?.length ?? 0;
  const hasFolders = library.folders.length > 0;
  const labelFiltered = library.folder.kind !== "all" || library.selected.length > 0;
  const resetLabels = () => {
    setFolderFilter(ALL_FOLDERS);
    setTagKeys([]);
  };
  const toggleTag = (key: string) =>
    setTagKeys((current) =>
      current.includes(key) ? current.filter((item) => item !== key) : [...current, key],
    );

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
        <h1 className="text-heading font-semibold">{t("myshares.title")}</h1>
        {shares.data ? (
          <span className="text-caption text-fg-3">{t("myshares.count", { count: total })}</span>
        ) : null}
        <Button asChild variant="primary" size="sm" leading={<Plus />} className="ms-auto">
          <Link to="/new">{t("share.new")}</Link>
        </Button>
      </header>

      <div className="flex flex-wrap items-center gap-3">
        <ToggleGroup label={t("myshares.title")}>
          <ToggleGroupItem pressed={filter === "all"} onClick={() => setFilter("all")}>
            {t("myshares.tab.all")}
          </ToggleGroupItem>
          <ToggleGroupItem pressed={filter === "saved"} onClick={() => setFilter("saved")}>
            {t("myshares.tab.saved")}
          </ToggleGroupItem>
          <ToggleGroupItem pressed={filter === "owned"} onClick={() => setFilter("owned")}>
            {t("myshares.tab.owned")}
          </ToggleGroupItem>
        </ToggleGroup>
        <div className="min-w-48 flex-1 sm:max-w-xs sm:flex-none">
          <Input
            type="search"
            aria-label={t("myshares.searchLabel")}
            placeholder={t("myshares.searchPlaceholder")}
            leading={<Search />}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            data-testid="share-search"
          />
        </div>
      </div>

      <div className="flex flex-col gap-5 md:flex-row md:items-start">
        {hasFolders ? (
          <FolderNav
            folders={library.folders}
            unfiled={library.unfiled}
            total={total}
            value={library.folder}
            onChange={setFolderFilter}
          />
        ) : null}

        <main id="main" className="flex min-w-0 flex-1 flex-col gap-3">
          {library.allTags.length > 0 ? (
            <fieldset
              className="m-0 flex min-w-0 flex-wrap items-center gap-1.5 p-0"
              data-testid="tag-filter"
            >
              <legend className="sr-only">{t("myshares.tag.filter")}</legend>
              {library.allTags.map((tag) => {
                const pressed = library.selected.includes(tag.key);
                return (
                  <button
                    key={tag.key}
                    type="button"
                    aria-pressed={pressed}
                    onClick={() => toggleTag(tag.key)}
                    className={cx(
                      "inline-flex min-h-6 max-w-full items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-label coarse:min-h-10",
                      "transition-[color,background-color] duration-(--duration-fast) ease-out",
                      pressed
                        ? "border-accent-text/50 bg-accent-soft text-accent-text"
                        : "border-line text-fg-2 hover:bg-fill-hover hover:text-fg",
                    )}
                  >
                    <span className="min-w-0 truncate">{tag.name}</span>
                    <span className="text-caption tabular-nums opacity-80">{tag.count}</span>
                  </button>
                );
              })}
              {library.selected.length > 0 ? (
                <Button size="sm" variant="ghost" onClick={() => setTagKeys([])}>
                  {t("myshares.tag.clearAction")}
                </Button>
              ) : null}
            </fieldset>
          ) : null}

          {shares.isPending ? (
            <div
              role="status"
              aria-busy="true"
              aria-label={t("myshares.loading")}
              className="flex flex-col gap-3"
            >
              <Skeleton className="h-24" />
              <Skeleton className="h-24" />
              <Skeleton className="h-24" />
            </div>
          ) : shares.isError ? (
            <EmptyState
              tone="danger"
              icon={<TriangleAlert />}
              title={t("myshares.error.title")}
              description={t("myshares.error.body")}
              action={<Button onClick={() => void shares.refetch()}>{t("common.retry")}</Button>}
            />
          ) : visible.length === 0 ? (
            query.trim() ? (
              <EmptyState
                icon={<SearchX />}
                title={t("myshares.emptySearch.title", { query: query.trim() })}
                description={t("myshares.emptySearch.body")}
                action={
                  <Button onClick={() => setQuery("")}>{t("myshares.emptySearch.action")}</Button>
                }
              />
            ) : labelFiltered ? (
              <EmptyState
                icon={<Folder />}
                title={t("myshares.emptyFilter.title")}
                description={t("myshares.emptyFilter.body")}
                action={<Button onClick={resetLabels}>{t("myshares.emptyFilter.action")}</Button>}
              />
            ) : filter === "saved" ? (
              <EmptyState
                icon={<Bookmark />}
                title={t("myshares.emptySaved.title")}
                description={t("myshares.emptySaved.body")}
              />
            ) : (
              <EmptyState
                icon={<FolderOpen />}
                title={t("myshares.empty.title")}
                description={t("myshares.empty.body")}
                action={
                  <Button asChild variant="primary">
                    <Link to="/new">{t("myshares.empty.action")}</Link>
                  </Button>
                }
              />
            )
          ) : (
            <ul className="flex flex-col gap-3" data-testid="share-list">
              {visible.map((share) => {
                const language = getLanguage(share.language);
                const left = share.expiresAt
                  ? new Date(share.expiresAt).getTime() - Date.now()
                  : null;
                return (
                  <li
                    key={share.id}
                    data-testid={`share-${share.id}`}
                    className="group relative flex flex-col gap-2 rounded-xl border border-line bg-panel p-3 hover:border-fg-3 sm:p-4"
                  >
                    <div className="flex items-start gap-2">
                      <h2 className="min-w-0 flex-1 truncate text-body font-medium">
                        <Link
                          to="/$id"
                          params={{ id: share.id }}
                          className="outline-offset-4 after:absolute after:inset-0 after:content-['']"
                        >
                          {share.title || t("common.untitled")}
                        </Link>
                      </h2>
                      {share.saved ? <Badge tone="accent">{t("myshares.saved")}</Badge> : null}
                      <IconButton
                        aria-label={t("myshares.organizeAction")}
                        size="sm"
                        className="relative z-10"
                        onClick={() => setOrganizing(share)}
                        data-testid="share-organize"
                      >
                        <Tags />
                      </IconButton>
                      <IconButton
                        aria-label={
                          share.role === "owner"
                            ? t("myshares.deleteAction")
                            : t("myshares.removeAction")
                        }
                        size="sm"
                        className="relative z-10"
                        onClick={() => setTarget(share)}
                        data-testid="share-remove"
                      >
                        <Trash2 />
                      </IconButton>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-fg-3">
                      <LanguageBadge
                        name={language?.name ?? share.language}
                        color={language?.color ?? "#8b949e"}
                      />
                      <span>
                        {t("myshares.updated", {
                          time: formatRelativeTime(
                            locale,
                            new Date(share.updatedAt).getTime() - Date.now(),
                          ),
                        })}
                      </span>
                      <span className={left !== null && left <= 0 ? "text-danger-text" : undefined}>
                        {left === null
                          ? t("myshares.noExpiry")
                          : left <= 0
                            ? t("myshares.expired")
                            : t("myshares.expiresIn", { time: formatDuration(locale, left) })}
                      </span>
                      {share.folder ? (
                        <span
                          className="inline-flex min-w-0 max-w-full items-center gap-1"
                          data-testid="share-folder"
                        >
                          <Folder aria-hidden="true" className="size-3.5 shrink-0" />
                          <span className="sr-only">{t("myshares.row.folder")}: </span>
                          <span className="min-w-0 truncate">{share.folder}</span>
                        </span>
                      ) : null}
                    </div>
                    {share.tags.length > 0 ? (
                      <ul
                        aria-label={t("myshares.tag.title")}
                        className="flex flex-wrap gap-1"
                        data-testid="share-tags"
                      >
                        {share.tags.map((tag) => (
                          <li
                            key={labelKey(tag)}
                            className="max-w-full truncate rounded-full bg-fill-active px-2 py-0.5 text-caption text-fg-2"
                          >
                            {tag}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {share.preview ? (
                      <pre className="hidden max-h-16 overflow-hidden rounded-md bg-bg p-2 font-mono text-[0.6875rem] leading-snug text-fg-2 sm:block">
                        {firstLines(share.preview, 3)}
                      </pre>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </main>
      </div>

      <OrganizeDialog
        share={organizing}
        shares={shares.data ?? []}
        onClose={() => setOrganizing(null)}
      />

      <Dialog open={target !== null} onOpenChange={(open) => !open && setTarget(null)}>
        <DialogContent
          size="sm"
          title={
            target?.role === "owner"
              ? t("myshares.deleteTitle", { title: target.title || t("common.untitled") })
              : t("myshares.removeTitle", { title: target?.title || t("common.untitled") })
          }
          description={
            target?.role === "owner" ? t("myshares.deleteBody") : t("myshares.removeBody")
          }
          closeLabel={t("common.close")}
          footer={
            <>
              <Button onClick={() => setTarget(null)}>{t("common.cancel")}</Button>
              <Button
                variant="danger"
                loading={remove.isPending}
                loadingLabel={t("common.loading")}
                onClick={() => target && remove.mutate(target)}
                data-testid="share-remove-confirm"
              >
                {target?.role === "owner" ? t("myshares.deleteAction") : t("myshares.removeAction")}
              </Button>
            </>
          }
        >
          <span className="sr-only">{target?.title}</span>
        </DialogContent>
      </Dialog>
    </div>
  );
}
