import type { ReactNode } from "react";
import { PlusIcon } from "../icons";
import { reveal } from "../reveal";

export interface FaqItemProps {
  /** Anchor of the question; the answer panel is `<id>-answer`. */
  id: string;
  question: string;
  open: boolean;
  onToggle: () => void;
  /** Stagger of the entrance, in milliseconds. */
  delay?: number;
  children: ReactNode;
}

/** One question that opens into its answer; shared by the home page and the FAQ page. */
export function FaqItem({ id, question, open, onToggle, delay = 0, children }: FaqItemProps) {
  const panelId = `${id}-answer`;
  return (
    <li id={id} className="ix-faq-item" data-open={open ? "" : undefined} {...reveal(delay)}>
      <h3>
        <button
          type="button"
          className="ix-faq-q"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={onToggle}
        >
          <span>{question}</span>
          <PlusIcon className="ix-faq-icon" />
        </button>
      </h3>
      <section id={panelId} className="ix-faq-panel" aria-label={question}>
        <div>{children}</div>
      </section>
    </li>
  );
}
