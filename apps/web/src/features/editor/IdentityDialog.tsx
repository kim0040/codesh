import { PARTICIPANT_COLORS } from "@codesh/highlight";
import { MAX_NAME_LENGTH } from "@codesh/shared";
import { Avatar, Button, Dialog, DialogContent, Field, Input } from "@codesh/ui";
import { Check } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { useT } from "../../lib/i18n";
import { guestNumber, useUpdateProfile } from "../../lib/session";
import { labelColorFor } from "./cm/remote-cursors";
import { useEditor } from "./context";

/** Name and cursor colour; the name is kept on this device by the session cookie. */
export function IdentityDialog() {
  const t = useT();
  const ctx = useEditor();
  const open = ctx.panel.name === "identity";
  const update = useUpdateProfile();
  const [name, setName] = useState(ctx.me.name);
  const [color, setColor] = useState(ctx.me.color);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (open) {
      setName(ctx.me.name);
      setColor(ctx.me.color);
      setTouched(false);
    }
  }, [open, ctx.me.name, ctx.me.color]);

  const trimmed = name.trim();
  const error = !touched
    ? undefined
    : trimmed.length === 0
      ? t("identity.nameRequired")
      : trimmed.length > MAX_NAME_LENGTH
        ? t("identity.nameTooLong", { max: MAX_NAME_LENGTH })
        : undefined;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (!trimmed || trimmed.length > MAX_NAME_LENGTH) return;
    update.mutate({ name: trimmed, color }, { onSuccess: () => ctx.closePanel() });
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && ctx.closePanel()}>
      <DialogContent
        size="sm"
        title={t("identity.title")}
        description={t("identity.body")}
        closeLabel={t("common.close")}
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => setName(t("identity.guest", { number: guestNumber(ctx.me.clientId) }))}
            >
              {t("identity.randomAction")}
            </Button>
            <Button
              variant="primary"
              type="submit"
              form="identity-form"
              loading={update.isPending}
              loadingLabel={t("common.loading")}
            >
              {t("identity.saveAction")}
            </Button>
          </>
        }
      >
        <form id="identity-form" onSubmit={submit} className="flex flex-col gap-4">
          <Field label={t("identity.nameLabel")} error={error}>
            <Input
              autoFocus
              value={name}
              maxLength={MAX_NAME_LENGTH + 10}
              placeholder={t("identity.namePlaceholder")}
              onChange={(event) => {
                setName(event.target.value);
                setTouched(true);
              }}
              data-testid="identity-name"
            />
          </Field>
          <fieldset className="flex flex-col gap-2">
            <legend className="text-label font-medium">{t("identity.colorLabel")}</legend>
            <div className="flex flex-wrap gap-2">
              {PARTICIPANT_COLORS.map((swatch, index) => {
                const checked = swatch.hex.toLowerCase() === color.toLowerCase();
                return (
                  <label key={swatch.hex} className="relative cursor-pointer">
                    <input
                      type="radio"
                      name="identity-color"
                      value={swatch.hex}
                      checked={checked}
                      onChange={() => setColor(swatch.hex)}
                      className="peer sr-only"
                      aria-label={t("identity.colorOption", { index: index + 1 })}
                    />
                    <span
                      className="grid size-8 place-items-center rounded-full outline-offset-2 peer-checked:outline-2 peer-checked:outline-fg peer-focus-visible:outline-2 peer-focus-visible:outline-focus coarse:size-11"
                      style={{ backgroundColor: swatch.hex, color: labelColorFor(swatch.hex) }}
                    >
                      {checked ? <Check aria-hidden="true" className="size-4" /> : null}
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>
          <div className="flex items-center gap-2 text-body-sm text-fg-2">
            <Avatar
              name={trimmed || "?"}
              slot={1}
              style={{ backgroundColor: color, color: labelColorFor(color) }}
            />
            <span className="truncate">{trimmed}</span>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
