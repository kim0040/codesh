import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
  closeCompletion,
} from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import type { EditorState, Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { EditorTheme } from "@gachipad/highlight";
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

/** Languages whose names may contain a hyphen (CSS properties, HTML attributes). */
const HYPHEN_LANGUAGES = new Set(["css", "scss", "sass", "less", "html", "xml", "vue", "svelte"]);

/** Typing opens the list only after this many name characters; Ctrl+Space opens it at any length. */
const MIN_TYPED = 2;

const keywordLists = new Map<string, Promise<readonly string[]>>();

function namePatterns(languageId: string): { before: RegExp; word: RegExp } {
  return HYPHEN_LANGUAGES.has(languageId)
    ? { before: /[A-Za-z_$][\w$-]*$/, word: /[A-Za-z_$][\w$-]*/g }
    : { before: /[A-Za-z_$][\w$]*$/, word: /[A-Za-z_$][\w$]*/g };
}

/** Comments and string literals are prose: the list stays closed there unless asked for. */
function inProse(state: EditorState, pos: number): boolean {
  const node = syntaxTree(state).resolveInner(pos, -1);
  return /comment|string|regexp|docstring/i.test(node.type.name);
}

/** Snippet templates ("for name in collection:") insert more than was asked for; plain keywords stay. */
function isSnippet(option: Completion): boolean {
  return typeof option.apply === "function" && option.type === "keyword";
}

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

/** A bounded scan around the cursor, counting how often each name is used there. */
function documentWords(
  context: CompletionContext,
  word: RegExp,
  typed: string,
): Map<string, number> {
  const start = Math.max(0, context.pos - 50_000);
  const end = Math.min(context.state.doc.length, context.pos + 50_000);
  const text = context.state.doc.sliceString(start, end);
  const counts = new Map<string, number>();
  for (const match of text.matchAll(word)) {
    const name = match[0];
    if (name.length < 3 || name === typed) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
    if (counts.size >= 2000) break;
  }
  return counts;
}

function completionSource(languageId: string): CompletionSource {
  const names = namePatterns(languageId);
  return async (context) => {
    const token = context.matchBefore(names.before);
    const typed = token?.text ?? "";
    if (!context.explicit && (typed.length < MIN_TYPED || inProse(context.state, context.pos)))
      return null;
    const from = token?.from ?? context.pos;
    const lower = typed.toLowerCase();
    // Only names that continue what was typed, never the word itself.
    const fits = (label: string) =>
      label !== typed && label.length > typed.length && label.toLowerCase().startsWith(lower);

    const nativeSources = context.state
      .languageDataAt<CompletionSource>("autocomplete", context.pos)
      .filter((source) => typeof source === "function");
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
        if (isSnippet(option) || !fits(option.label) || options.has(option.label)) continue;
        options.set(option.label, option);
        if (options.size >= 300) break;
      }
    }
    for (const word of await wordsForLanguage(languageId)) {
      if (fits(word) && !options.has(word)) options.set(word, { label: word, type: "keyword" });
    }
    // Names used in this file rank by how often they appear, so the one in use comes first.
    for (const [word, count] of documentWords(context, names.word, typed)) {
      if (!fits(word) || options.has(word)) continue;
      options.set(word, { label: word, type: "variable", boost: Math.min(count, 20) - 1 });
      if (options.size >= 500) break;
    }

    if (options.size === 0) return null;
    const result: CompletionResult = { from, options: [...options.values()] };
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
      // CodeMirror opens it only for local typing ("input.type"), never for remote Yjs updates.
      activateOnTyping: true,
      activateOnTypingDelay: 350,
      defaultKeymap: false,
      filterStrict: true,
      interactionDelay: 0,
      maxRenderedOptions: 6,
      // Nothing is picked until an arrow key: Enter keeps making new lines, Tab takes the first.
      selectOnOpen: false,
      override: [completionSource(languageId)],
    }),
    closeForComposition,
  ];
}
