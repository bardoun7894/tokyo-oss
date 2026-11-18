import { test } from "node:test";
import assert from "node:assert/strict";
import { signalWorkflow } from "./signal";

test("signalWorkflow gets the client for the namespace and signals the workflow id", async () => {
  const calls: string[] = [];
  const fake = async (ns: string) => ({
    workflow: {
      getHandle: (id: string) => ({ signal: async (name: string) => { calls.push(`${ns}/${id}/${name}`); } }),
    },
  }) as any;
  await signalWorkflow({ namespace: "oncall", workflowId: "inc-1", signalName: "approve" }, fake);
  assert.deepEqual(calls, ["oncall/inc-1/approve"]);
});

test("a stalled Temporal rejects after the deadline", async () => {
  const hang = async () => new Promise<never>(() => {});
  await assert.rejects(
    signalWorkflow({ namespace: "oncall", workflowId: "x", signalName: "approve" }, hang, 20),
    /timed out after 20 ms/,
  );
});

test("a connection failure rejects so the flow can retry", async () => {
  await assert.rejects(
    signalWorkflow({ namespace: "oncall", workflowId: "x", signalName: "approve" }, async () => { throw new Error("connect refused"); }),
    /connect refused/,
  );
});
