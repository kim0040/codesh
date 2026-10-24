/**
 * Named load scenarios (docs/OPERATIONS.md §11). A plan is a set of client groups that run at the
 * same time, optionally with a reconnect storm in the middle.
 */

export interface ShareGroup {
  kind: "share";
  /** Name of the group in the report. */
  name: string;
  shares: number;
  /** Typing clients per share, owner included. Every keystroke also moves the writer's cursor. */
  writers: number;
  /** Clients per share that never type (they join with the view role). */
  viewers: number;
  /** Keystrokes per writer and second. */
  typeRate: number;
  /** Cursor moves per viewer and second; 0 keeps viewers still. */
  cursorRate: number;
}

export interface LabGroup {
  kind: "lab";
  name: string;
  /** Each student types in their own copy; the teacher watches every copy over one socket. */
  students: number;
  typeRate: number;
}

export type Group = ShareGroup | LabGroup;

export interface Storm {
  /** `drop`: every socket dies at once (a Wi-Fi blip); `restart`: runs `command` (a collab restart). */
  kind: "drop" | "restart";
  /** Seconds after typing started. */
  atS: number;
  command?: string;
}

export interface Plan {
  scenario: string;
  groups: Group[];
  durationS: number;
  storm?: Storm;
}

/** One class in one share: 10 people type at human speed, everyone moves their cursor. */
const CLASS: ShareGroup = {
  kind: "share",
  name: "class",
  shares: 1,
  writers: 10,
  viewers: 40,
  typeRate: 5,
  cursorRate: 5,
};

const LAB: LabGroup = { kind: "lab", name: "lab", students: 50, typeRate: 3 };

export const SCENARIOS: Record<string, Omit<Plan, "scenario">> = {
  "single-share-50": { groups: [CLASS], durationS: 60 },
  "lab-50": { groups: [LAB], durationS: 60 },
  "reconnect-storm": { groups: [CLASS], durationS: 40, storm: { kind: "drop", atS: 15 } },
  // About 200 people: a class, a lab and twenty small pairs or groups.
  "mixed-200": {
    groups: [
      CLASS,
      LAB,
      {
        kind: "share",
        name: "small",
        shares: 20,
        writers: 2,
        viewers: 3,
        typeRate: 5,
        cursorRate: 2,
      },
    ],
    durationS: 60,
  },
};

export function clientCount(group: Group): number {
  return group.kind === "lab" ? group.students + 1 : group.shares * (group.writers + group.viewers);
}
