import type { EditorView } from "@codemirror/view";
import {
  canChangeDocument,
  type GetShareResponse,
  participantPermissions,
  type UserRef,
} from "@gachipad/shared";
import { createContext, type MutableRefObject, useContext } from "react";
import type * as Y from "yjs";
import type { Participant } from "../../lib/collab/hooks";
import type { DocMetaView, FileEntry } from "../../lib/collab/model";
import type { DocSession, SessionState } from "../../lib/collab/session";
import type { Store } from "../../lib/store";
import type { EditorInfo } from "./doc-info";

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

/** Central UI guard; the collab server independently checks the actual update. */
export function useDocumentPermissions() {
  const ctx = useEditor();
  const permissions = ctx.state.permissions ?? ctx.share.permissions ?? participantPermissions();
  const can = (action: "rename" | "files" | "language") =>
    canChangeDocument(ctx.state.role, ctx.readOnly, permissions, action);
  return { rename: can("rename"), files: can("files"), language: can("language") };
}
