// Whether a finished mission deploys by itself. Auto-deploy (operator decision
// D3) is the default, but only when nothing about the result is in doubt; every
// other case holds with a reason the owner reads before approving by hand.

export interface GateInput {
  tests: "passed" | "failed" | "unverified";
  projectConfirmed: boolean;
  liveDirtyFiles: number;
  mergeable: boolean;
  autoDeploy: boolean;
}

export type GateDecision =
  | { action: "deploy" }
  | { action: "hold"; reason: string }
  | { action: "stop"; reason: string };

export function decideDeploy(g: GateInput): GateDecision {
  if (g.tests === "failed") return { action: "stop", reason: "tests failed — nothing deployed" };
  if (g.tests === "unverified") return { action: "hold", reason: "no tests ran for this project — approve deploy by hand" };
  if (!g.projectConfirmed) return { action: "hold", reason: "deploy target not confirmed for this project yet" };
  if (g.liveDirtyFiles > 0) {
    return { action: "hold", reason: `live checkout has ${g.liveDirtyFiles} uncommitted files — merging would ship them` };
  }
  if (!g.mergeable) return { action: "hold", reason: "mission branch does not merge cleanly into the live branch" };
  if (!g.autoDeploy) return { action: "hold", reason: "auto-deploy is off" };
  return { action: "deploy" };
}
