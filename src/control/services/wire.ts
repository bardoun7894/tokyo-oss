import type { AllowEntry, Exec } from "../ops-restart";
import type { OpsStore } from "../ops-store";
import type { ServicesDeps } from "./routes";
import { ServiceStates } from "./state";

/**
 * The live services area. It shares the allowlist loader and the exec of the incident restart (wiring.ts), so both read the same
 * file and the same kinds of command; the state reads are cached for 15 s inside `ServiceStates`.
 */
export function wireServices(ops: OpsStore, allowlist: () => readonly AllowEntry[], exec: Exec): ServicesDeps {
  return { allowlist, states: new ServiceStates(exec), ops };
}
