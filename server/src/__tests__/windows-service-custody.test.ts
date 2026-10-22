import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as tree from "../services/windows-service-process-tree.js";
import {
  findAdoptableLocalService, listLocalServiceRegistryRecords, readLocalServiceRegistryRecord,
  removeLocalServiceRegistryRecord, terminateLocalService, writeLocalServiceRegistryRecord,
  type LocalServiceRegistryRecord,
} from "../services/local-service-supervisor.js";
import {
  resetRuntimeServicesForTests, startRuntimeServicesForWorkspaceControl, stopRuntimeServicesForExecutionWorkspace,
} from "../services/workspace-runtime.js";

describe.skipIf(process.platform !== "win32")("Windows service custody", () => {
  const owned: LocalServiceRegistryRecord[] = [];
  beforeEach(async () => {
    vi.stubEnv("PAPERCLIP_HOME", await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-custody-")));
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "custody-test");
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const record of owned.splice(0)) {
      await terminateLocalService(record);
      await removeLocalServiceRegistryRecord(record.serviceKey);
    }
    await resetRuntimeServicesForTests();
    vi.unstubAllEnvs();
  });

  async function fixture(name: string) {
    const server = "const s=require('node:http').createServer((q,r)=>r.end('ok'));s.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({port:s.address().port,pid:process.pid})))";
    const root = spawn("sh", ["-lc", `node -e '${server.replace(/'/g, "'\\''")}'`], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const [chunk] = await once(root.stdout!, "data");
    const info = JSON.parse(String(chunk)) as { port: number; pid: number };
    const record: LocalServiceRegistryRecord = {
      version: 1, serviceKey: name, serviceName: name, profileKind: "custody-test", command: "fixture",
      cwd: process.cwd(), envFingerprint: "test", port: info.port, url: `http://127.0.0.1:${info.port}`,
      pid: root.pid!, processGroupId: null, provider: "local_process", runtimeServiceId: name,
      reuseKey: null, startedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), metadata: null,
    };
    await writeLocalServiceRegistryRecord(record);
    owned.push(record);
    return { record, root, info };
  }

  it("adopts saved descendants after the original root exits and leaves a sibling alive", async () => {
    const target = await fixture("target");
    const sibling = await fixture("sibling");
    expect(target.record.windowsProcessTree!.some((identity) => identity.pid === target.info.pid)).toBe(true);
    expect(target.record.windowsProcessTree![0]?.parentPid).toBe(process.pid);
    target.root.kill();
    await once(target.root, "exit");
    const adopted = await findAdoptableLocalService({ serviceKey: "target" });
    expect(adopted?.pid).toBe(target.record.pid);
    await terminateLocalService(adopted!);
    await expect(fetch(target.record.url!)).rejects.toThrow();
    expect((await fetch(sibling.record.url!)).ok).toBe(true);
  }, 30_000);

  it("refuses a mismatched process identity without killing the service", async () => {
    const target = await fixture("identity");
    const mismatched = structuredClone(target.record);
    mismatched.windowsProcessTree![0]!.startedAtTicks = "1";
    await expect(terminateLocalService(mismatched)).rejects.toThrow("identity changed");
    expect((await fetch(target.record.url!)).ok).toBe(true);
    expect((await readLocalServiceRegistryRecord("identity"))?.stopError).toContain("identity changed");
  }, 30_000);

  it("retains runtime ownership and registry on failed stop, then permits retry", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-stop-retry-"));
    const services = await startRuntimeServicesForWorkspaceControl({
      actor: { id: null, name: "test", companyId: "company-1" }, issue: null,
      workspace: { baseCwd: cwd, cwd, source: "project_primary", projectId: "p", workspaceId: "w", repoUrl: null,
        repoRef: "HEAD", strategy: "project_primary", branchName: null, worktreePath: null, warnings: [], created: false },
      executionWorkspaceId: "retry-workspace", adapterEnv: {},
      config: { workspaceRuntime: { services: [{ name: "web", port: { type: "auto" }, lifecycle: "shared",
        reuseScope: "execution_workspace", command: "node -e \"require('node:http').createServer((q,r)=>r.end('ok')).listen(Number(process.env.PORT),'127.0.0.1')\"",
        readiness: { type: "http", urlTemplate: "http://127.0.0.1:{{port}}", timeoutSec: 10, intervalMs: 100 } }] } },
    });
    const [registry] = await listLocalServiceRegistryRecords();
    owned.push(registry!);
    const original = tree.windowsServiceProcessTree;
    const spy = vi.spyOn(tree, "windowsServiceProcessTree").mockImplementation(async (input) =>
      input.action === "stop" ? { identities: input.identities ?? [], error: "injected stop failure" } : original(input));
    await expect(stopRuntimeServicesForExecutionWorkspace({ executionWorkspaceId: "retry-workspace" })).rejects.toThrow("injected stop failure");
    expect((await fetch(services[0]!.url!)).ok).toBe(true);
    expect((await readLocalServiceRegistryRecord(registry!.serviceKey))?.stopError).toContain("injected stop failure");
    spy.mockRestore();
    await stopRuntimeServicesForExecutionWorkspace({ executionWorkspaceId: "retry-workspace" });
    expect(await readLocalServiceRegistryRecord(registry!.serviceKey)).toBeNull();
    await expect(fetch(services[0]!.url!)).rejects.toThrow();
  }, 30_000);

  it("retains evidence when an unrelated listener occupies the recorded port", async () => {
    const target = await fixture("port-target");
    const sibling = await fixture("port-sibling");
    await expect(terminateLocalService({ ...target.record, port: sibling.record.port })).rejects.toThrow("still listens");
    expect((await fetch(sibling.record.url!)).ok).toBe(true);
    expect((await readLocalServiceRegistryRecord("port-target"))?.stopError).toContain("still listens");
  }, 30_000);

  it("retains a failed-readiness tree when startup cleanup fails", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-start-cleanup-"));
    const original = tree.windowsServiceProcessTree;
    const spy = vi.spyOn(tree, "windowsServiceProcessTree").mockImplementation(async (input) =>
      input.action === "stop" ? { identities: input.identities ?? [], error: "injected startup cleanup failure" } : original(input));
    try {
      await expect(startRuntimeServicesForWorkspaceControl({
        actor: { id: null, name: "test", companyId: "company-1" }, issue: null,
        workspace: { baseCwd: cwd, cwd, source: "project_primary", projectId: "p", workspaceId: "w", repoUrl: null,
          repoRef: "HEAD", strategy: "project_primary", branchName: null, worktreePath: null, warnings: [], created: false },
        executionWorkspaceId: "startup-cleanup", adapterEnv: {},
        config: { workspaceRuntime: { services: [{ name: "unready", port: { type: "auto" }, lifecycle: "shared",
          reuseScope: "execution_workspace", command: "node -e \"require('node:http').createServer((q,r)=>{r.statusCode=503;r.end('unready')}).listen(Number(process.env.PORT),'127.0.0.1')\"",
          readiness: { type: "http", urlTemplate: "http://127.0.0.1:{{port}}", timeoutSec: 1, intervalMs: 100 } }] } },
      })).rejects.toThrow("registry");
      const [registry] = await listLocalServiceRegistryRecords();
      expect(registry?.stopError).toContain("injected startup cleanup failure");
      expect(registry?.windowsProcessTree?.length).toBeGreaterThan(1);
      owned.push(registry!);
      await vi.waitFor(async () => expect((await fetch(registry!.url!)).status).toBe(503), { timeout: 3000, interval: 50 });
    } finally { spy.mockRestore(); }
  }, 30_000);
});
