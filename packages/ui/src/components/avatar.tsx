import { Avatar as AvatarPrimitive } from "radix-ui";
import type { CSSProperties, ReactNode } from "react";
import { cx } from "../lib/cx.js";
import { initialsOf } from "../lib/initials.js";
import { Tooltip } from "./tooltip.js";

export const PARTICIPANT_COUNT = 12;

/** 1-based participant palette slot for a stable seed (user id, client id). */
export function participantSlot(seed: string | number): number {
  if (typeof seed === "number") return (Math.abs(Math.trunc(seed)) % PARTICIPANT_COUNT) + 1;
  let hash = 2166136261;
  for (const char of seed) hash = Math.imul(hash ^ (char.codePointAt(0) ?? 0), 16777619);
  return ((hash >>> 0) % PARTICIPANT_COUNT) + 1;
}

export type AvatarSize = "xs" | "sm" | "md" | "lg";

const sizes: Record<AvatarSize, string> = {
  xs: "size-5 text-[0.625rem]",
  sm: "size-6 text-caption",
  md: "size-8 text-label",
  lg: "size-10 text-body-sm",
};

export interface AvatarProps {
  name: string;
  /** Participant palette slot, 1–12. Use `participantSlot(id)` for a stable pick. */
  slot: number;
  src?: string;
  size?: AvatarSize;
  className?: string;
  style?: CSSProperties;
}

/** Round initials chip in the participant's colour. The name is always the accessible label. */
export function Avatar({ name, slot, src, size = "md", className, style }: AvatarProps) {
  return (
    <AvatarPrimitive.Root
      role="img"
      aria-label={name}
      style={{
        backgroundColor: `var(--participant-${slot})`,
        color: `var(--participant-${slot}-fg)`,
        ...style,
      }}
      className={cx(
        "relative inline-flex shrink-0 select-none items-center justify-center overflow-hidden rounded-full font-semibold leading-none",
        sizes[size],
        className,
      )}
    >
      {src ? <AvatarPrimitive.Image src={src} alt="" className="size-full object-cover" /> : null}
      <AvatarPrimitive.Fallback aria-hidden="true" delayMs={src ? 300 : 0}>
        {initialsOf(name)}
      </AvatarPrimitive.Fallback>
    </AvatarPrimitive.Root>
  );
}

export interface StackedPerson {
  id: string;
  name: string;
  slot: number;
  src?: string;
}

export interface AvatarStackProps {
  people: readonly StackedPerson[];
  /** Avatars shown before collapsing the rest into "+n". */
  max?: number;
  size?: AvatarSize;
  /** Name of the group, e.g. "Participants". */
  label: string;
  /** Accessible text for the overflow chip, e.g. (n) => `${n} more participants`. */
  overflowLabel: (hidden: number) => string;
  /** Wrap each avatar in a tooltip with the person's name (needs a TooltipProvider). */
  tooltips?: boolean;
  /** Surface colour the stack sits on; the gap ring uses it to cut avatars apart. */
  ringClassName?: string;
  className?: string;
}

const overlaps: Record<AvatarSize, string> = {
  xs: "-ms-1",
  sm: "-ms-1.5",
  md: "-ms-2",
  lg: "-ms-2.5",
};

export function AvatarStack({
  people,
  max = 4,
  size = "md",
  label,
  overflowLabel,
  tooltips = false,
  ringClassName = "ring-panel",
  className,
}: AvatarStackProps) {
  const shown = people.slice(0, people.length > max ? max : people.length);
  const hidden = people.length - shown.length;
  const ring = cx("ring-2", ringClassName);
  const wrap = (person: StackedPerson, node: ReactNode) =>
    tooltips ? (
      <Tooltip key={person.id} content={person.name}>
        <span className="inline-flex rounded-full">{node}</span>
      </Tooltip>
    ) : (
      node
    );

  return (
    // biome-ignore lint/a11y/useSemanticElements: a labelled group of avatars, not a form fieldset
    <div role="group" aria-label={label} className={cx("flex items-center", className)}>
      {shown.map((person, index) =>
        wrap(
          person,
          <Avatar
            key={person.id}
            name={person.name}
            slot={person.slot}
            src={person.src}
            size={size}
            className={cx(ring, index > 0 && overlaps[size])}
          />,
        ),
      )}
      {hidden > 0 ? (
        <span
          role="img"
          aria-label={overflowLabel(hidden)}
          className={cx(
            "relative inline-flex shrink-0 items-center justify-center rounded-full bg-raised font-medium tabular-nums text-fg-2 leading-none shadow-1",
            sizes[size],
            overlaps[size],
            ring,
          )}
        >
          <span aria-hidden="true">+{hidden}</span>
        </span>
      ) : null}
    </div>
  );
}
