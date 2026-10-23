import { createContext, type ReactNode, use, useId } from "react";
import { cx } from "../lib/cx.js";

interface FieldContextValue {
  id: string;
  describedBy: string | undefined;
  invalid: boolean;
  required: boolean;
}

const FieldContext = createContext<FieldContextValue | null>(null);

/** Wired attributes for a control inside a `<Field>`; empty outside one. */
export function useFieldProps(): Partial<{
  id: string;
  "aria-describedby": string;
  "aria-invalid": true;
  "aria-required": true;
}> {
  const field = use(FieldContext);
  if (!field) return {};
  return {
    id: field.id,
    "aria-describedby": field.describedBy,
    "aria-invalid": field.invalid ? true : undefined,
    "aria-required": field.required ? true : undefined,
  };
}

export interface FieldProps {
  label: ReactNode;
  hint?: ReactNode;
  /** Error text. Presence marks the control invalid and replaces the hint. */
  error?: ReactNode;
  required?: boolean;
  className?: string;
  children: ReactNode;
}

/** Label + control + hint/error with the ids and ARIA wiring done for you. */
export function Field({ label, hint, error, required = false, className, children }: FieldProps) {
  const id = useId();
  const messageId = `${id}-message`;
  const message = error ?? hint;
  const value: FieldContextValue = {
    id,
    describedBy: message ? messageId : undefined,
    invalid: Boolean(error),
    required,
  };
  return (
    <FieldContext value={value}>
      <div className={cx("flex flex-col gap-1.5", className)}>
        <label htmlFor={id} className="text-label font-medium text-fg">
          {label}
        </label>
        {children}
        {message ? (
          <p
            id={messageId}
            role={error ? "alert" : undefined}
            className={cx("text-caption", error ? "text-danger-text" : "text-fg-3")}
          >
            {message}
          </p>
        ) : null}
      </div>
    </FieldContext>
  );
}
