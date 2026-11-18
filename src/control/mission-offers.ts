import type { MissionRow } from "../mission-store";
import type { OfferRow } from "./contract";

export const MISSION_BUTTONS = [{ id: "approve", label: "Approve" }, { id: "skip", label: "Skip" }];

/** Structured answer of the mission approval store, for the Control API. */
export type MissionAnswer =
  | { status: "applied"; mission: MissionRow; reply: string }
  | { status: "already"; mission: MissionRow }
  | { status: "expired"; mission?: MissionRow }
  | { status: "missing" };

/** The mission offer is the mission itself: its id is the offer id. */
export function missionRow(m: MissionRow, now: number): OfferRow {
  const state = m.state === "proposed" ? (now >= m.expires_at ? "expired" : "pending")
    : m.state === "expired" ? "expired"
    : m.state === "declined" ? "declined" : "approved";
  return {
    id: m.id, kind: "mission", project: m.project, title: `Mission for ${m.project}`, body: m.prompt, from: m.sender || null,
    state, missionId: m.id, buttons: MISSION_BUTTONS, createdAt: m.created_at, expiresAt: m.expires_at,
    answeredButton: state === "approved" ? "approve" : state === "declined" ? "skip" : null,
    channel: m.answered_by, answeredAt: m.answered_at,
  };
}
