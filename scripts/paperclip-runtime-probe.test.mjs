import assert from "node:assert/strict";
import test from "node:test";

import { classifyActiveRunCustody, probePaperclipRuntime } from "./paperclip-runtime-probe.mjs";

function response(body, { status = 200, contentType = "application/json" } = {}) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": contentType },
  });
}

test("requires liveness, application shell, and database-backed data", async () => {
  const seen = [];
  const result = await probePaperclipRuntime({
    issueIdentifier: "OCE-918",
    fetchImpl: async (url) => {
      seen.push(url);
      if (url.endsWith("/api/health")) return response({ status: "ok" });
      if (url.endsWith("/api/issues/OCE-918")) return response({ identifier: "OCE-918" });
      return response('<div id="root"></div>', { contentType: "text/html; charset=utf-8" });
    },
  });

  assert.equal(result.healthy, true);
  assert.deepEqual(seen, [
    "http://127.0.0.1:3100/api/health",
    "http://127.0.0.1:3100/OCE/issues/OCE-918",
    "http://127.0.0.1:3100/api/issues/OCE-918",
  ]);
});

test("does not accept an SPA shell when the data path hangs", async () => {
  const result = await probePaperclipRuntime({
    issueIdentifier: "OCE-918",
    fetchImpl: async (url) => {
      if (url.endsWith("/api/health")) return response({ status: "ok" });
      if (url.endsWith("/api/issues/OCE-918")) throw new DOMException("timed out", "TimeoutError");
      return response('<div id="root"></div>', { contentType: "text/html" });
    },
  });

  assert.equal(result.healthy, false);
  assert.equal(result.probes.page.ok, true);
  assert.equal(result.probes.data.ok, false);
});

test("rejects arbitrary HTML that is not the Paperclip application shell", async () => {
  const result = await probePaperclipRuntime({
    issueIdentifier: "OCE-918",
    fetchImpl: async (url) => {
      if (url.endsWith("/api/health")) return response({ status: "ok" });
      if (url.endsWith("/api/issues/OCE-918")) return response({ identifier: "OCE-918" });
      return response("<html>proxy error</html>", { contentType: "text/html" });
    },
  });

  assert.equal(result.healthy, false);
  assert.equal(result.probes.page.ok, false);
});

test("queued runs are durable work, not live process custody", () => {
  const result = classifyActiveRunCustody([{ status: "queued", processPid: null }]);
  assert.equal(result.custodyKnown, true);
  assert.equal(result.activeRunCount, 0);
  assert.equal(result.recoverableRunCount, 1);
});

test("live running processes retain custody", () => {
  const result = classifyActiveRunCustody(
    [{ status: "running", processPid: 1234 }],
    { processAlive: () => true },
  );
  assert.equal(result.custodyKnown, true);
  assert.equal(result.activeRunCount, 1);
  assert.equal(result.recoverableRunCount, 0);
});

test("dead running processes are recoverable after a safe restart", () => {
  const result = classifyActiveRunCustody(
    [{ status: "running", processPid: 1234 }],
    { processAlive: () => false },
  );
  assert.equal(result.custodyKnown, true);
  assert.equal(result.activeRunCount, 0);
  assert.equal(result.deadRunningRunCount, 1);
});

test("running rows without a process identity fail closed", () => {
  const result = classifyActiveRunCustody([{ status: "running", processPid: null }]);
  assert.equal(result.custodyKnown, false);
  assert.equal(result.unknownRunningRunCount, 1);
});
