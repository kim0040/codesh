import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
  closeCompletion,
  startCompletion,
} from "@codemirror/autocomplete";
import type { Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import type { EditorTheme } from "@codesh/highlight";
import { completionTheme } from "./completion-theme";

const FALLBACK_LANGUAGES = new Set([
  "javascript",
  "typescript",
  "jsx",
  "tsx",
  "python",
  "css",
  "html",
  "sql",
  "c",
  "cpp",
  "java",
  "kotlin",
  "go",
  "rust",
  "csharp",
  "php",
  "ruby",
  "swift",
  "bash",
  "shell",
  "sh",
  "lua",
]);

const keywordLists = new Map<string, Promise<readonly string[]>>();

/** Activate only on CodeMirror's local typing transactions; Yjs updates cannot open the popup. */
const localTypingCompletion = ViewPlugin.fromClass(
  class {
    timer: number | null = null;

    update(update: ViewUpdate) {
      if (update.view.composing) {
        this.clearTimer();
        return;
      }
      if (
        !update.docChanged ||
        update.state.readOnly ||
        !update.transactions.some((transaction) => transaction.isUserEvent("input.type"))
      ) {
        return;
      }
      this.clearTimer();
      const view = update.view;
      this.timer = window.setTimeout(() => {
        this.timer = null;
        if (view.hasFocus && !view.composing && !view.state.readOnly) startCompletion(view);
      }, 350);
    }

    destroy() {
      this.clearTimer();
    }

    private clearTimer() {
      if (this.timer !== null) window.clearTimeout(this.timer);
      this.timer = null;
    }
  },
);

const closeForComposition = EditorView.domEventHandlers({
  compositionstart(_event, view) {
    closeCompletion(view);
    return false;
  },
});

function wordsForLanguage(languageId: string): Promise<readonly string[]> {
  if (!FALLBACK_LANGUAGES.has(languageId)) return Promise.resolve([]);
  let words = keywordLists.get(languageId);
  if (!words) {
    words = import("./completion-words.js").then((module) =>
      module.completionWordsForLanguage(languageId),
    );
    keywordLists.set(languageId, words);
  }
  return words;
}

/** A bounded document scan keeps word completion responsive even for large shared files. */
function documentWords(context: CompletionContext): string[] {
  const start = Math.max(0, context.pos - 50_000);
  const end = Math.min(context.state.doc.length, context.pos + 50_000);
  const text = context.state.doc.sliceString(start, end);
  const currentToken = context.matchBefore(/[\w$-]*/)?.text;
  const words = new Set<string>();
  for (const match of text.matchAll(/[A-Za-z_$][\w$-]*/g)) {
    const word = match[0];
    if (!word || word === currentToken) continue;
    words.add(word);
    if (words.size >= 250) break;
  }
  return [...words];
}

function completionSource(languageId: string): CompletionSource {
  return async (context) => {
    const token = context.matchBefore(/[\w$-]*/);
    const nativeSources = context.state
      .languageDataAt<CompletionSource>("autocomplete", context.pos)
      .filter((source) => typeof source === "function");
    const hasWord = Boolean(token && token.from < context.pos);
    if (!hasWord && !context.explicit && nativeSources.length === 0) return null;

    const nativeResults = await Promise.all(
      nativeSources.map(async (source) => {
        try {
          return await source(context);
        } catch {
          return null;
        }
      }),
    );

    const options = new Map<string, Completion>();
    for (const result of nativeResults) {
      for (const option of result?.options ?? []) {
        if (!options.has(option.label)) options.set(option.label, option);
        if (options.size >= 300) break;
      }
      if (options.size >= 300) break;
    }

    if (hasWord || context.explicit) {
      const fallback = await wordsForLanguage(languageId);
      for (const word of fallback) {
        if (!options.has(word)) options.set(word, { label: word, type: "keyword" });
      }
      for (const word of documentWords(context)) {
        if (!options.has(word)) options.set(word, { label: word, type: "variable" });
        if (options.size >= 550) break;
      }
    }

    if (options.size === 0) return null;
    const nativeFrom = nativeResults.find((result) => result?.options.length)?.from;
    const result: CompletionResult = {
      from: hasWord ? (token?.from ?? context.pos) : (nativeFrom ?? context.pos),
      options: [...options.values()],
      validFor: /^[\w$-]*$/,
    };
    return result;
  };
}

/** The owning compartment omits this extension for viewers and when completion is turned off. */
export function completionExtension(
  languageId: string,
  enabled: boolean,
  readOnly: boolean,
  theme: EditorTheme,
): Extension {
  if (!enabled || readOnly) return [];
  return [
    completionTheme(theme),
    autocompletion({
      activateOnTyping: false,
      defaultKeymap: false,
      interactionDelay: 0,
      maxRenderedOptions: 9,
      selectOnOpen: true,
      override: [completionSource(languageId)],
    }),
    localTypingCompletion,
    closeForComposition,
  ];
}
