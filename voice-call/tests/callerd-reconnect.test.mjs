import test from "node:test";
import assert from "node:assert/strict";
import { createConnectionUpdateHandler } from "../baileys-caller/dist/connection-lifecycle.mjs";

test("post-open socket closure is reported once with its reason", () => {
  const events = [];
  const reason = new Error("Connection Closed");
  const handle = createConnectionUpdateHandler({
    onOpen: () => events.push("open"),
    onClosedBeforeOpen: () => events.push("closed-before-open"),
    onClosedAfterOpen: (update) => events.push(update.lastDisconnect.error),
  });

  handle({ connection: "open" });
  handle({ connection: "close", lastDisconnect: { error: reason } });
  handle({ connection: "close", lastDisconnect: { error: reason } });

  assert.deepEqual(events, ["open", reason]);
});

test("pre-open socket closure remains on the initial-connect path", () => {
  const events = [];
  const handle = createConnectionUpdateHandler({
    onOpen: () => events.push("open"),
    onClosedBeforeOpen: () => events.push("closed-before-open"),
    onClosedAfterOpen: () => events.push("closed-after-open"),
  });

  handle({ connection: "close" });
  assert.deepEqual(events, ["closed-before-open"]);
});
