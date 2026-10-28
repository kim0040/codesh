import type { ShareRecord } from "@gachipad/shared";
import type { TransferRecord } from "./types.js";

/** savedBy or bans entries per share record or `shareMembers` item. */
export const MEMBER_PAGE = 128;

/** The share with the first page of each member list, then the rest of each list in pages. */
export function* splitShare(share: ShareRecord): Iterable<TransferRecord> {
  yield {
    kind: "shares",
    record: {
      ...share,
      savedBy: share.savedBy.slice(0, MEMBER_PAGE),
      bans: share.bans.slice(0, MEMBER_PAGE),
    },
  };
  for (const list of ["savedBy", "bans"] as const)
    for (let offset = MEMBER_PAGE; offset < share[list].length; offset += MEMBER_PAGE)
      yield {
        kind: "shareMembers",
        record: {
          shareId: share.id,
          list,
          offset,
          clientIds: share[list].slice(offset, offset + MEMBER_PAGE),
        },
      };
}
