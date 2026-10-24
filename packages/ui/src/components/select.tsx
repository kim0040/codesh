import { Check, ChevronDown, ChevronUp } from "lucide-react";
import { Select as SelectPrimitive } from "radix-ui";
import type { ComponentProps, ReactNode } from "react";
import { cx } from "../lib/cx.js";
import { useFieldProps } from "./field.js";

export interface SelectOption {
  value: string;
  label: ReactNode;
  /** Plain-text form used for type-ahead and the closed trigger. Defaults to `label` when it is a string. */
  textValue?: string;
  disabled?: boolean;
}

export interface SelectProps {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  options: readonly SelectOption[];
  placeholder?: string;
  size?: "sm" | "md" | "lg";
  invalid?: boolean;
  disabled?: boolean;
  name?: string;
  id?: string;
  "aria-label"?: string;
  className?: string;
  /** Portal target; defaults to document.body. */
  container?: HTMLElement | null;
  /** Controlled open state (mostly for the gallery). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

const heights = { sm: "h-7", md: "h-8", lg: "h-10" } as const;

export function Select({
  options,
  placeholder,
  size = "md",
  invalid,
  className,
  container,
  id,
  "aria-label": ariaLabel,
  value,
  defaultValue,
  onValueChange,
  disabled,
  name,
  open,
  onOpenChange,
}: SelectProps) {
  const field = useFieldProps();
  const isInvalid = invalid ?? field["aria-invalid"] === true;
  return (
    <SelectPrimitive.Root
      value={value}
      defaultValue={defaultValue}
      onValueChange={onValueChange}
      disabled={disabled}
      name={name}
      open={open}
      onOpenChange={onOpenChange}
    >
      <SelectPrimitive.Trigger
        id={id ?? field.id}
        aria-label={ariaLabel}
        aria-describedby={field["aria-describedby"]}
        aria-invalid={isInvalid || undefined}
        className={cx(
          "group inline-flex w-full items-center justify-between gap-2 rounded-md border border-line-control bg-panel px-3 text-body-sm text-fg",
          "transition-[border-color] duration-(--duration-fast) ease-out hover:border-fg-3",
          "data-[state=open]:border-accent-text aria-[invalid=true]:border-danger-text",
          "data-[placeholder]:text-fg-3 disabled:opacity-50 coarse:min-h-11",
          heights[size],
          className,
        )}
      >
        <span className="min-w-0 truncate">
          <SelectPrimitive.Value placeholder={placeholder} />
        </span>
        <SelectPrimitive.Icon className="text-fg-3 transition-transform duration-(--duration-normal) ease-out group-data-[state=open]:rotate-180">
          <ChevronDown className="size-4" aria-hidden="true" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal container={container}>
        <SelectContent>
          {options.map((option) => (
            <SelectItem
              key={option.value}
              value={option.value}
              disabled={option.disabled}
              textValue={
                option.textValue ?? (typeof option.label === "string" ? option.label : undefined)
              }
            >
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

export function SelectContent({
  className,
  children,
  ...props
}: ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Content
      position="popper"
      sideOffset={6}
      collisionPadding={8}
      className={cx(
        "ui-pop z-(--z-toast) max-h-(--radix-select-content-available-height) min-w-(--radix-select-trigger-width) origin-(--radix-select-content-transform-origin) overflow-hidden rounded-lg border border-line bg-overlay p-1 text-fg shadow-3",
        className,
      )}
      {...props}
    >
      <SelectPrimitive.ScrollUpButton className="flex h-6 items-center justify-center text-fg-3">
        <ChevronUp className="size-4" aria-hidden="true" />
      </SelectPrimitive.ScrollUpButton>
      <SelectPrimitive.Viewport>{children}</SelectPrimitive.Viewport>
      <SelectPrimitive.ScrollDownButton className="flex h-6 items-center justify-center text-fg-3">
        <ChevronDown className="size-4" aria-hidden="true" />
      </SelectPrimitive.ScrollDownButton>
    </SelectPrimitive.Content>
  );
}

export function SelectItem({
  className,
  children,
  ...props
}: ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      className={cx(
        "relative flex min-h-8 cursor-default select-none items-center gap-2 rounded-md py-1.5 ps-2 pe-8 text-body-sm outline-none",
        "data-[highlighted]:bg-fill-hover data-[state=checked]:font-medium data-[disabled]:pointer-events-none data-[disabled]:opacity-50 coarse:min-h-11",
        className,
      )}
      {...props}
    >
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator className="absolute inset-e-2 flex items-center text-accent-text">
        <Check className="size-4" aria-hidden="true" />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  );
}

export const SelectRoot = SelectPrimitive.Root;
export const SelectTrigger = SelectPrimitive.Trigger;
export const SelectValue = SelectPrimitive.Value;
export const SelectGroup = SelectPrimitive.Group;
export const SelectLabel = ({
  className,
  ...props
}: ComponentProps<typeof SelectPrimitive.Label>) => (
  <SelectPrimitive.Label
    className={cx("px-2 py-1.5 text-caption text-fg-3", className)}
    {...props}
  />
);
export const SelectSeparator = ({
  className,
  ...props
}: ComponentProps<typeof SelectPrimitive.Separator>) => (
  <SelectPrimitive.Separator className={cx("-mx-1 my-1 h-px bg-line", className)} {...props} />
);
