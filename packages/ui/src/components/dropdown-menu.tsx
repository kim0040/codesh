import { Check, ChevronRight, Circle } from "lucide-react";
import { DropdownMenu as MenuPrimitive } from "radix-ui";
import { type ComponentProps, type ReactNode, useRef } from "react";
import { cx } from "../lib/cx.js";
import { Kbd } from "./kbd.js";

export const DropdownMenu = MenuPrimitive.Root;
export const DropdownMenuTrigger = MenuPrimitive.Trigger;
export const DropdownMenuGroup = MenuPrimitive.Group;
export const DropdownMenuSub = MenuPrimitive.Sub;
export const DropdownMenuRadioGroup = MenuPrimitive.RadioGroup;

const surface =
  "ui-pop z-(--z-dropdown) min-w-44 max-w-[calc(100vw-1rem)] origin-(--radix-dropdown-menu-content-transform-origin) overflow-y-auto rounded-lg border border-line bg-overlay p-1 text-fg shadow-3";
const item =
  "relative flex min-h-8 cursor-default select-none items-center gap-2 rounded-md px-2 py-1.5 text-body-sm outline-none coarse:min-h-11 " +
  "data-[highlighted]:bg-fill-hover data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-fg-3";

/**
 * Focus goes back to the trigger when the menu closes from the keyboard. Closed with a pointer
 * (an item clicked, or a click outside) it does not: the browser would draw the keyboard focus
 * ring on the trigger, because the menu items it moved focus through count as keyboard focus.
 */
export function DropdownMenuContent({
  sideOffset = 6,
  collisionPadding = 8,
  container,
  className,
  onPointerDown,
  onPointerDownOutside,
  onKeyDown,
  onCloseAutoFocus,
  ...props
}: ComponentProps<typeof MenuPrimitive.Content> & { container?: HTMLElement | null }) {
  const pointer = useRef(false);
  return (
    <MenuPrimitive.Portal container={container}>
      <MenuPrimitive.Content
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cx(surface, "max-h-(--radix-dropdown-menu-content-available-height)", className)}
        onPointerDown={(event) => {
          pointer.current = true;
          onPointerDown?.(event);
        }}
        onPointerDownOutside={(event) => {
          pointer.current = true;
          onPointerDownOutside?.(event);
        }}
        onKeyDown={(event) => {
          pointer.current = false;
          onKeyDown?.(event);
        }}
        onCloseAutoFocus={(event) => {
          onCloseAutoFocus?.(event);
          if (pointer.current) event.preventDefault();
          pointer.current = false;
        }}
        {...props}
      />
    </MenuPrimitive.Portal>
  );
}

export interface DropdownMenuItemProps extends ComponentProps<typeof MenuPrimitive.Item> {
  icon?: ReactNode;
  /** Shortcut keycaps shown at the end, e.g. ["⌘", "D"]. */
  shortcut?: readonly string[];
  destructive?: boolean;
}

export function DropdownMenuItem({
  icon,
  shortcut,
  destructive,
  className,
  children,
  ...props
}: DropdownMenuItemProps) {
  return (
    <MenuPrimitive.Item
      className={cx(
        item,
        destructive &&
          "text-danger-text data-[highlighted]:bg-danger-soft [&_svg]:text-danger-text",
        className,
      )}
      {...props}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {shortcut ? (
        <span className="ms-4 flex gap-0.5">
          {shortcut.map((key) => (
            <Kbd key={key}>{key}</Kbd>
          ))}
        </span>
      ) : null}
    </MenuPrimitive.Item>
  );
}

export function DropdownMenuCheckboxItem({
  className,
  children,
  ...props
}: ComponentProps<typeof MenuPrimitive.CheckboxItem>) {
  return (
    <MenuPrimitive.CheckboxItem className={cx(item, "ps-8", className)} {...props}>
      <span className="absolute inset-s-2 flex size-4 items-center justify-center">
        <MenuPrimitive.ItemIndicator>
          <Check aria-hidden="true" className="text-accent-text" />
        </MenuPrimitive.ItemIndicator>
      </span>
      {children}
    </MenuPrimitive.CheckboxItem>
  );
}

export function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: ComponentProps<typeof MenuPrimitive.RadioItem>) {
  return (
    <MenuPrimitive.RadioItem className={cx(item, "ps-8", className)} {...props}>
      <span className="absolute inset-s-2 flex size-4 items-center justify-center">
        <MenuPrimitive.ItemIndicator>
          <Circle aria-hidden="true" className="size-2! fill-accent-text text-accent-text" />
        </MenuPrimitive.ItemIndicator>
      </span>
      {children}
    </MenuPrimitive.RadioItem>
  );
}

export function DropdownMenuLabel({
  className,
  ...props
}: ComponentProps<typeof MenuPrimitive.Label>) {
  return (
    <MenuPrimitive.Label
      className={cx("px-2 py-1.5 text-caption text-fg-3", className)}
      {...props}
    />
  );
}

export function DropdownMenuSeparator({
  className,
  ...props
}: ComponentProps<typeof MenuPrimitive.Separator>) {
  return (
    <MenuPrimitive.Separator className={cx("-mx-1 my-1 h-px bg-line", className)} {...props} />
  );
}

export function DropdownMenuSubTrigger({
  className,
  children,
  ...props
}: ComponentProps<typeof MenuPrimitive.SubTrigger>) {
  return (
    <MenuPrimitive.SubTrigger
      className={cx(item, "data-[state=open]:bg-fill-hover", className)}
      {...props}
    >
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <ChevronRight aria-hidden="true" className="rtl:rotate-180" />
    </MenuPrimitive.SubTrigger>
  );
}

export function DropdownMenuSubContent({
  className,
  ...props
}: ComponentProps<typeof MenuPrimitive.SubContent>) {
  return <MenuPrimitive.SubContent className={cx(surface, className)} {...props} />;
}
