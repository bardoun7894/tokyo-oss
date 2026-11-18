import { askJev, jevEnabled, type JevAnswer, type JevQuestion } from "./jev";
import type { ProjectLocation } from "./project-registry";

// Jev decides whether a client's WhatsApp message is coding work and which part of the
// project it touches; the policy below turns that into where Claude runs. Anything Jev
// is not sure about goes back to the ✅ Run card, never straight to a run.

export const KIND_MIN = 0.85;
export const TARGET_MIN = 0.8;

export const CLIENT_TASK_QUESTIONS: Record<"kind" | "target", JevQuestion> = {
  kind: {
    type: "choice",
    instructions: "What is this WhatsApp message from a client asking for?",
    criteria: {
      coding: "a change, fix, bug report or new feature in the client's software project (code, pages, screens, design, deployment)",
      personal: "not software work: greetings, thanks, payment, meeting times, personal chat, or a question answered without changing code",
      unclear: "too vague or too short to tell whether code has to change",
    },
  },
  target: {
    type: "choice",
    instructions: "If the message asks for software work, which part of the project does it touch?",
    criteria: {
      website: "a website or web app: its pages, frontend, admin panel, or the server API and backend behind it",
      mobile_app: "a mobile app (Android, iOS, Flutter): its screens, APK or store build",
      none: "no software work, or the part of the project cannot be told from the message",
    },
  },
};

// "mission": server mission (clone, tests, deploy gate). "run": Claude in herdr on the
// project's own host (Mac or server), ending with a Deploy question.
export type ClientRoute =
  | { action: "mission"; reason: string }
  | { action: "run"; reason: string }
  | { action: "skip"; reason: string }
  | { action: "ask"; reason: string };

export interface RouteProject {
  location: ProjectLocation;
  /** The project has a server mission config (repo, tests, deploy) — Claude can run in herdr there. */
  hasMission: boolean;
}

const pct = (a?: JevAnswer) => `${a?.choice} ${(a?.confidence ?? 0).toFixed(2)}`;

export function decideClientRoute(
  answers: Partial<Record<"kind" | "target", JevAnswer>> | null,
  project: RouteProject,
): ClientRoute {
  const kind = answers?.kind;
  const target = answers?.target;
  if (!kind?.choice) return { action: "ask", reason: "jev unavailable" };
  if ((kind.confidence ?? 0) < KIND_MIN) return { action: "ask", reason: `jev unsure: ${pct(kind)}` };
  if (kind.choice === "personal") return { action: "skip", reason: `not coding: ${pct(kind)}` };
  if (kind.choice !== "coding") return { action: "ask", reason: `jev: ${pct(kind)}` };

  if (!target?.choice || (target.confidence ?? 0) < TARGET_MIN || target.choice === "none") {
    return { action: "ask", reason: `coding, but part unclear: ${pct(target)}` };
  }
  const why = `${pct(kind)}, ${pct(target)}`;
  if (target.choice === "mobile_app") {
    return project.location === "laptop"
      ? { action: "run", reason: `mobile app → laptop (${why})` }
      : { action: "ask", reason: `mobile app, but the project only lives on the server (${why})` };
  }
  if (project.hasMission) return { action: "mission", reason: `website → server mission (${why})` };
  return { action: "run", reason: `website → ${project.location} (${why})` };
}

export async function routeClientTask(
  msg: { content: string; sender_name: string },
  project: { name: string; note?: string } & RouteProject,
): Promise<ClientRoute> {
  if (!jevEnabled()) return { action: "ask", reason: "jev off" };
  try {
    const answers = await askJev(
      { message: msg.content.slice(0, 4000), sender: msg.sender_name, project: project.name, project_note: project.note ?? "" },
      CLIENT_TASK_QUESTIONS,
    );
    return decideClientRoute(answers, project);
  } catch (err: any) {
    console.warn("[client-task-route] jev failed:", err?.message || err);
    return { action: "ask", reason: "jev error" };
  }
}
