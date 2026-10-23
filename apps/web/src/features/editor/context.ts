import type { EditorView } from "@codemirror/view";
import type { GetShareResponse, UserRef } from "@codesh/shared";
import { createContext, type MutableRefObject, useContext } from "react";
import type * as Y from "yjs";
import type { Participant } from "../../lib/collab/hooks";
import type { DocMetaView, FileEntry } from "../../lib/collab/model";
import type { DocSession, SessionState } from "../../lib/collab/session";
import type { Store } from "../../lib/store";
import type { EditorInfo } from "./EditorPane";

export type PanelName =
  | "share"
  | "settings"
  | "history"
  | "comments"
  | "upload"
  | "identity"
  | "files";

export interface PanelState {
  name: PanelName | null;
  /** Extra detail for the panel: a share-dialog tab, a comment to focus. */
  arg?: string;
}

export interface EditorCtx {
  session: DocSession;
  doc: Y.Doc;
  share: GetShareResponse;
  refetchShare: () => void;
  state: SessionState;
  me: UserRef;
  isOwner: boolean;
  readOnly: boolean;
  meta: DocMetaView;
  files: FileEntry[];
  activeFile: FileEntry;
  setActiveFileId: (id: string) => void;
  participants: Participant[];
  viewRef: MutableRefObject<EditorView | null>;
  info: Store<EditorInfo>;
  panel: PanelState;
  openPanel: (name: PanelName, arg?: string) => void;
  closePanel: () => void;
  /** Awareness client id of the person I follow, or null. */
  following: string | null;
  setFollowing: (clientId: string | null) => void;
  presenting: boolean;
  setPresenting: (on: boolean) => void;
  rtt: number | null;
}

export const EditorContext = createContext<EditorCtx | null>(null);

export function useEditor(): EditorCtx {
  const value = useContext(EditorContext);
  if (!value) throw new Error("useEditor must be used inside the editor page");
  return value;
}
