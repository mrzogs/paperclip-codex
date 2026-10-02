import assert from "node:assert/strict";
import test from "node:test";

const parentIssue = {
  id: "parent-issue",
  identifier: "OCE-770",
  title: "Workflow B strategy intake: VWAP Wave Pullback",
  description: "Workflow B parent intake.",
  status: "blocked",
  priority: "high",
  createdAt: "2026-06-04T10:00:00.000Z",
  updatedAt: "2026-06-04T10:00:00.000Z",
};

const childIssue = {
  id: "child-issue",
  identifier: "OCE-784",
  title: "Workflow B A4: register VWAP Wave Pullback strategy plugin",
  description: "Workflow B child stage.",
  status: "blocked",
  priority: "high",
  createdAt: "2026-06-04T11:00:00.000Z",
  updatedAt: "2026-06-04T11:00:00.000Z",
};

const unresolvedBlocker = {
  id: "other-blocker",
  identifier: "OCE-785",
  title: "Remaining Workflow B evidence blocker",
  status: "blocked",
};

test("status-only Workflow B action suppresses parent resume while Paperclip blockers remain unresolved", async () => {
  process.env.NODE_ENV = "test";
  const patchCalls = [];
  const getIssueCalls = [];

  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(String(url));
    const method = options.method || "GET";
    if (method === "GET" && parsed.pathname.endsWith("/companies/378244c6-8e72-41b2-a4ab-27e9cca17a04/issues")) {
      return Response.json([parentIssue, childIssue]);
    }
    if (method === "GET" && parsed.pathname.endsWith("/issues/child-issue")) {
      getIssueCalls.push("child");
      return Response.json({ ...childIssue, blockedBy: [] });
    }
    if (method === "GET" && parsed.pathname.endsWith("/issues/parent-issue")) {
      getIssueCalls.push("parent");
      return Response.json({ ...parentIssue, blockedBy: [unresolvedBlocker] });
    }
    if (method === "PATCH" && parsed.pathname.endsWith("/issues/child-issue")) {
      patchCalls.push({ issue: "child", body: JSON.parse(options.body) });
      return Response.json({ ...childIssue, status: "done" });
    }
    if (method === "PATCH" && parsed.pathname.endsWith("/issues/parent-issue")) {
      patchCalls.push({ issue: "parent", body: JSON.parse(options.body) });
      return Response.json({ ...parentIssue, status: "todo" });
    }
    return Response.json({ error: `Unexpected ${method} ${parsed.pathname}` }, { status: 500 });
  };

  const { resolveHmmWorkflowBlocker } = await import("./server.mjs");
  const result = await resolveHmmWorkflowBlocker({ note: "regression test" });

  assert.equal(result.ok, true);
  assert.deepEqual(getIssueCalls, ["child", "parent"]);
  assert.equal(patchCalls.length, 1);
  assert.equal(patchCalls[0].issue, "child");
  assert.equal(patchCalls[0].body.status, "done");
  assert.match(patchCalls[0].body.comment, /No live trading was enabled/);
  assert.equal(result.suppressedActions.length, 1);
  assert.equal(result.suppressedActions[0].kind, "parent_issue_resume");
  assert.equal(result.suppressedActions[0].reason, "unresolved_paperclip_blockers");
  assert.deepEqual(
    result.suppressedActions[0].unresolvedBlockers.map((blocker) => blocker.identifier),
    ["OCE-785"],
  );
});
