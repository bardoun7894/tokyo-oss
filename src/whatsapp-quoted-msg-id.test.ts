import "./test-db-env";
import { test, after } from "node:test";
import assert from "node:assert/strict";

// whatsapp.ts imports db.ts, which opens a database at module-load time;
// ./test-db-env (first import) points it at a scratch file.
import { extractQuotedMsgId } from "./whatsapp";

function withMessage(message: any): any {
  return { key: { id: "test-key" }, message };
}

test("extendedTextMessage.contextInfo.stanzaId is resolved (a bare-number text reply)", () => {
  const id = extractQuotedMsgId(withMessage({
    extendedTextMessage: { text: "58", contextInfo: { stanzaId: "WA_QUOTED_1", participant: "x@s.whatsapp.net" } },
  }));
  assert.equal(id, "WA_QUOTED_1");
});

test("imageMessage.contextInfo.stanzaId is resolved (replying with an image)", () => {
  const id = extractQuotedMsgId(withMessage({
    imageMessage: { caption: "58", contextInfo: { stanzaId: "WA_QUOTED_2" } },
  }));
  assert.equal(id, "WA_QUOTED_2");
});

test("a shape not explicitly named in the brief (videoMessage) still resolves generically", () => {
  const id = extractQuotedMsgId(withMessage({
    videoMessage: { contextInfo: { stanzaId: "WA_QUOTED_3" } },
  }));
  assert.equal(id, "WA_QUOTED_3");
});

test("a plain conversation-string message has no contextInfo at all -> null", () => {
  const id = extractQuotedMsgId(withMessage({ conversation: "hello" }));
  assert.equal(id, null);
});

test("extendedTextMessage with no contextInfo -> null (not a reply)", () => {
  const id = extractQuotedMsgId(withMessage({ extendedTextMessage: { text: "58" } }));
  assert.equal(id, null);
});

test("contextInfo present but with no stanzaId -> null", () => {
  const id = extractQuotedMsgId(withMessage({
    extendedTextMessage: { text: "hi", contextInfo: { participant: "x@s.whatsapp.net" } },
  }));
  assert.equal(id, null);
});

test("no message payload at all -> null", () => {
  const id = extractQuotedMsgId({ key: { id: "test-key" } } as any);
  assert.equal(id, null);
});

after(() => {
  // ../whatsapp pulls in heavy side-effecting modules (Baileys, shop-group,
  // mission-wiring...) that hold the event loop open — same workaround as
  // products-routes.test.ts.
  setImmediate(() => process.exit(0));
});
