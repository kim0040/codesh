import type { ReactNode } from "react";
import { createStore, useStore } from "./store";

/** Command palette registry: screens register their actions while they are mounted. */

export interface Command {
  id: string;
  label: string;
  group: string;
  /** Extra words that should find this command. */
  keywords?: string;
  shortcut?: readonly string[];
  icon?: ReactNode;
  disabled?: boolean;
  run: () => void;
}

const sources = createStore<ReadonlyMap<string, readonly Command[]>>(new Map());

/** Registers a set of commands under `owner`; the returned function removes them. */
export function registerCommands(owner: string, commands: readonly Command[]): () => void {
  sources.set((previous) => new Map(previous).set(owner, commands));
  return () => {
    sources.set((previous) => {
      const next = new Map(previous);
      next.delete(owner);
      return next;
    });
  };
}

export function useCommands(): Command[] {
  const map = useStore(sources);
  return [...map.values()].flat().filter((command) => !command.disabled);
}

/** Case-insensitive word match: every typed word must appear in the label or keywords. */
export function matchCommand(command: Command, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = `${command.label} ${command.group} ${command.keywords ?? ""}`.toLowerCase();
  return words.every((word) => haystack.includes(word));
}
