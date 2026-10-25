import { Button, Switch, toast } from "@codesh/ui";
import { useId, useSyncExternalStore } from "react";
import {
  clearDiagnostics,
  clientDiagnosticExport,
  diagnosticsRevision,
  diagnosticsState,
  downloadDiagnostics,
  setDiagnosticsEnabled,
  subscribeDiagnostics,
} from "../../lib/diagnostics";
import { useT } from "../../lib/i18n";

export function DiagnosticsSection() {
  const t = useT();
  const id = useId();
  useSyncExternalStore(subscribeDiagnostics, diagnosticsRevision, diagnosticsRevision);
  const state = diagnosticsState();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(clientDiagnosticExport());
      toast({ title: t("settings.diag.copied"), tone: "success" });
    } catch {
      toast({ title: t("settings.diag.copyFailed"), tone: "danger" });
    }
  };
  return (
    <section
      aria-labelledby={id}
      className="flex flex-col gap-3 border-b border-line pb-5"
      data-testid="diagnostics-section"
    >
      <h3 id={id} className="text-label font-medium text-fg-3">
        {t("settings.diag.title")}
      </h3>
      <p className="text-caption text-fg-3">{t("settings.diag.description")}</p>
      <Switch
        label={t("settings.diag.enabled")}
        checked={state.enabled}
        onCheckedChange={setDiagnosticsEnabled}
        data-testid="diagnostics-enabled"
      />
      <p role="status" className="text-body-sm">
        {t("settings.diag.count", { count: state.count })}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          onClick={() => downloadDiagnostics(clientDiagnosticExport())}
          data-testid="diagnostics-export"
        >
          {t("settings.diag.export")}
        </Button>
        <Button onClick={() => void copy()} data-testid="diagnostics-copy">
          {t("settings.diag.copy")}
        </Button>
        <Button
          onClick={clearDiagnostics}
          disabled={state.count === 0}
          data-testid="diagnostics-clear"
        >
          {t("settings.diag.clear")}
        </Button>
      </div>
    </section>
  );
}
