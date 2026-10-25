import { unstable_OneTimePasswordField as OTP } from "radix-ui";
import { Fragment } from "react";
import { cx } from "../lib/cx.js";

export interface PinInputProps {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  /** Fired once when the last digit is entered or a full code is pasted. */
  onComplete?: (value: string) => void;
  /** Number of digits. Defaults to 6, the gachipad join code length. */
  length?: number;
  /** Visual grouping (6 digits show as 3 + 3). */
  groupSize?: number;
  invalid?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
  /** Form field name for the combined value. */
  name?: string;
  /** Name of the whole group, e.g. "Join code". */
  "aria-label": string;
  /** Name of one digit box, e.g. (i, n) => `Digit ${i} of ${n}`. */
  getDigitLabel: (position: number, total: number) => string;
  className?: string;
}

/**
 * Numeric one-time-code style input: one box per digit, auto-advance, backspace goes back,
 * arrow keys move, and pasting a full code (digits only, spaces and dashes ignored) fills every box.
 * `autocomplete="one-time-code"` lets phones offer codes from messages.
 */
export function PinInput({
  value,
  defaultValue,
  onValueChange,
  onComplete,
  length = 6,
  groupSize = 3,
  invalid,
  disabled,
  autoFocus,
  name,
  "aria-label": ariaLabel,
  getDigitLabel,
  className,
}: PinInputProps) {
  const handleChange = (next: string) => {
    onValueChange?.(next);
    if (next.length === length) onComplete?.(next);
  };
  return (
    <OTP.Root
      aria-label={ariaLabel}
      value={value}
      defaultValue={defaultValue}
      onValueChange={handleChange}
      validationType="numeric"
      sanitizeValue={(raw) => raw.replace(/\D/g, "")}
      disabled={disabled}
      autoFocus={autoFocus}
      autoSubmit={false}
      data-invalid={invalid || undefined}
      className={cx("flex items-center gap-1.5", invalid && "ui-shake", className)}
    >
      {Array.from({ length }, (_, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the boxes are positional and never reorder
        <Fragment key={index}>
          {index > 0 && index % groupSize === 0 ? (
            <span aria-hidden="true" className="w-1.5" />
          ) : null}
          <OTP.Input
            aria-label={getDigitLabel(index + 1, length)}
            aria-invalid={invalid || undefined}
            className={cx(
              "h-12 w-10 min-w-0 rounded-md border border-line-control bg-panel text-center font-mono text-title tabular-nums text-fg sm:w-11 coarse:h-14",
              "transition-[border-color,background-color] duration-(--duration-fast) ease-out",
              "hover:border-fg-3 focus:border-accent-text focus:outline-2 focus:outline-offset-2 focus:outline-focus",
              "aria-[invalid=true]:border-danger-text disabled:opacity-50",
            )}
          />
        </Fragment>
      ))}
      <OTP.HiddenInput name={name} />
    </OTP.Root>
  );
}
