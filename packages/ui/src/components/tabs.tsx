import { Tabs as TabsPrimitive } from "radix-ui";
import type { ComponentProps } from "react";
import { cx } from "../lib/cx.js";

export const Tabs = TabsPrimitive.Root;

export interface TabsListProps extends ComponentProps<typeof TabsPrimitive.List> {
  /** `underline` for page sections, `segmented` for compact switches inside panels. */
  variant?: "underline" | "segmented";
}

export function TabsList({ variant = "underline", className, ...props }: TabsListProps) {
  return (
    <TabsPrimitive.List
      data-variant={variant}
      className={cx(
        "group/tabs flex max-w-full items-center overflow-x-auto",
        variant === "underline"
          ? "gap-1 border-b border-line"
          : "gap-0.5 self-start rounded-lg border border-line bg-fill-hover p-0.5",
        className,
      )}
      {...props}
    />
  );
}

export function TabsTrigger({ className, ...props }: ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cx(
        "relative inline-flex h-8 shrink-0 items-center gap-2 whitespace-nowrap px-3 text-body-sm font-medium text-fg-2",
        "transition-[color,background-color] duration-(--duration-fast) ease-out hover:text-fg",
        "data-[state=active]:text-fg disabled:opacity-50 coarse:h-11",
        // underline variant: a 2px bar scales in under the active tab
        "group-data-[variant=underline]/tabs:after:absolute group-data-[variant=underline]/tabs:after:inset-x-2 group-data-[variant=underline]/tabs:after:-bottom-px",
        "group-data-[variant=underline]/tabs:after:h-0.5 group-data-[variant=underline]/tabs:after:origin-center group-data-[variant=underline]/tabs:after:scale-x-0 group-data-[variant=underline]/tabs:after:rounded-full group-data-[variant=underline]/tabs:after:bg-accent group-data-[variant=underline]/tabs:after:transition-transform group-data-[variant=underline]/tabs:after:duration-(--duration-normal) group-data-[variant=underline]/tabs:after:ease-out group-data-[variant=underline]/tabs:after:content-['']",
        "group-data-[variant=underline]/tabs:data-[state=active]:after:scale-x-100",
        // segmented variant: raised pill
        "group-data-[variant=segmented]/tabs:h-7 group-data-[variant=segmented]/tabs:rounded-md group-data-[variant=segmented]/tabs:px-2.5",
        "group-data-[variant=segmented]/tabs:data-[state=active]:bg-raised group-data-[variant=segmented]/tabs:data-[state=active]:shadow-1",
        className,
      )}
      {...props}
    />
  );
}

export function TabsContent({ className, ...props }: ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      className={cx("ui-appear-fade pt-4 outline-offset-4", className)}
      {...props}
    />
  );
}
