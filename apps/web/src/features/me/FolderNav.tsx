import { cx } from "@gachipad/ui";
import { Folder, Inbox } from "lucide-react";
import type { ReactNode } from "react";
import { useT } from "../../lib/i18n";
import type { FolderEntry, FolderFilter } from "../../lib/labels";

interface FolderNavProps {
  folders: readonly FolderEntry[];
  unfiled: number;
  total: number;
  value: FolderFilter;
  onChange: (value: FolderFilter) => void;
}

/**
 * Folder filter of "my shares": All, each folder with its count, No folder (only while some share has none). A sidebar from `md`,
 * wrapping pills below that so it fits a 320px screen without a horizontal scroll.
 */
export function FolderNav({ folders, unfiled, total, value, onChange }: FolderNavProps) {
  const t = useT();
  return (
    <nav
      aria-label={t("myshares.folder.title")}
      data-testid="folder-nav"
      className="md:sticky md:top-6 md:w-52 md:shrink-0"
    >
      <ul className="flex flex-wrap gap-1.5 md:flex-col md:gap-0.5">
        <li className="max-w-full md:w-full">
          <FolderButton
            icon={<Inbox />}
            label={t("myshares.folder.all")}
            count={total}
            current={value.kind === "all"}
            onClick={() => onChange({ kind: "all" })}
          />
        </li>
        {folders.map((folder) => (
          <li key={folder.key} className="max-w-full md:w-full">
            <FolderButton
              icon={<Folder />}
              label={folder.name}
              count={folder.count}
              current={value.kind === "folder" && value.key === folder.key}
              onClick={() => onChange({ kind: "folder", key: folder.key })}
            />
          </li>
        ))}
        {unfiled > 0 ? (
          <li className="max-w-full md:w-full">
            <FolderButton
              label={t("myshares.folder.none")}
              count={unfiled}
              current={value.kind === "none"}
              onClick={() => onChange({ kind: "none" })}
            />
          </li>
        ) : null}
      </ul>
    </nav>
  );
}

function FolderButton({
  icon,
  label,
  count,
  current,
  onClick,
}: {
  icon?: ReactNode;
  label: string;
  count: number;
  current: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-current={current ? "true" : undefined}
      onClick={onClick}
      className={cx(
        "flex min-h-8 w-full max-w-full items-center gap-2 rounded-md border px-2.5 text-start text-body-sm coarse:min-h-11",
        "transition-[color,background-color] duration-(--duration-fast) ease-out",
        current
          ? "border-line-strong bg-fill-selected font-medium text-fg"
          : "border-line text-fg-2 hover:bg-fill-hover hover:text-fg md:border-transparent",
      )}
    >
      {icon ? (
        <span aria-hidden="true" className="flex shrink-0 text-fg-3 [&_svg]:size-4">
          {icon}
        </span>
      ) : null}
      <span className="min-w-0 flex-1 truncate" title={label}>
        {label}
      </span>
      <span className="shrink-0 text-caption text-fg-3 tabular-nums">{count}</span>
    </button>
  );
}
