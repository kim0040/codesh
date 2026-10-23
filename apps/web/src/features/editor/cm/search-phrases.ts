import { EditorState } from "@codemirror/state";
import type { TFunction } from "@codesh/i18n";

/** CodeMirror's search panel and tooltips, translated through the app dictionary. */
export function searchPhrases(t: TFunction) {
  return EditorState.phrases.of({
    Find: t("editor.search.find"),
    Replace: t("editor.search.replace"),
    next: t("editor.search.next"),
    previous: t("editor.search.previous"),
    all: t("editor.search.all"),
    "match case": t("editor.search.matchCase"),
    regexp: t("editor.search.regexp"),
    "by word": t("editor.search.byWord"),
    replace: t("editor.search.replaceOne"),
    "replace all": t("editor.search.replaceAll"),
    close: t("common.close"),
    "Go to line": t("editor.search.goToLine"),
    go: t("editor.search.go"),
    "Selection deleted": t("editor.search.selectionDeleted"),
    "current match": t("editor.search.currentMatch"),
    "on line": t("editor.search.onLine"),
    "replaced match on line $": t("editor.search.replacedOne"),
    "replaced $ matches": t("editor.search.replacedMany"),
    "Folded lines": t("editor.search.foldedLines"),
    "Unfolded lines": t("editor.search.unfoldedLines"),
    to: t("editor.search.to"),
    "folded code": t("editor.search.foldedCode"),
    unfold: t("editor.search.unfold"),
    "Fold line": t("editor.search.foldLine"),
    "Unfold line": t("editor.search.unfoldLine"),
    "Control character": t("editor.search.controlChar"),
  });
}
