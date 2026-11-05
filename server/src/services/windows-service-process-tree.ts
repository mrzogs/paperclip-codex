import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const execFileAsync = promisify(execFile);
let nativeHelper: Promise<string> | undefined;

export interface WindowsServiceProcessIdentity {
  pid: number;
  parentPid: number;
  startedAtTicks: string;
}

// Compile once per server process into a fresh private temp directory. Each
// operation is a bounded child process, with JSON on stdin (never command-line
// interpolation). Holding handles from validation through exit avoids PID reuse.
const source = String.raw`
using System;
using System.IO;
using System.Text;
using System.Diagnostics;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;

public class Identity {
  public int pid;
  public int parentPid;
  public string startedAtTicks;
}
public class Request {
  public string action;
  public int rootPid;
  public Identity[] identities;
  public int waitMs;
  public string registryPath;
  public Dictionary<string,object> registryRecord;
}
public class Result {
  public List<Identity> identities = new List<Identity>();
  public string error;
}
public static class ServiceProcessTree {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct Entry {
    public uint size, usage, processId;
    public UIntPtr heap;
    public uint moduleId, threads, parentProcessId;
    public int priority;
    public uint flags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string name;
  }
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool Process32FirstW(IntPtr snapshot, ref Entry entry);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool Process32NextW(IntPtr snapshot, ref Entry entry);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessTimes(IntPtr handle, out long created, out long exited, out long kernel, out long user);
  static long StartTicks(Process process) {
    long created, exited, kernel, user;
    if (!GetProcessTimes(process.Handle, out created, out exited, out kernel, out user)) throw new System.ComponentModel.Win32Exception();
    return DateTime.FromFileTimeUtc(created).Ticks;
  }
  static Dictionary<int,int> Snapshot() {
    var handle = CreateToolhelp32Snapshot(2, 0);
    if (handle == new IntPtr(-1)) throw new System.ComponentModel.Win32Exception();
    try {
      var entry = new Entry { size = (uint)Marshal.SizeOf(typeof(Entry)) };
      var result = new Dictionary<int,int>();
      if (!Process32FirstW(handle, ref entry)) throw new System.ComponentModel.Win32Exception();
      do { result[(int)entry.processId] = (int)entry.parentProcessId; } while (Process32NextW(handle, ref entry));
      if (Marshal.GetLastWin32Error() != 18) throw new System.ComponentModel.Win32Exception();
      return result;
    } finally { CloseHandle(handle); }
  }
  static Process Open(int pid) {
    if (pid <= 0) throw new ArgumentException("Invalid service process identity");
    Process process;
    try { process = Process.GetProcessById(pid); }
    catch (ArgumentException) { return null; }
    try { var handle = process.Handle; return process; }
    catch (InvalidOperationException) { process.Dispose(); return null; }
    catch (System.ComponentModel.Win32Exception error) {
      process.Dispose();
      if (error.NativeErrorCode == 87) return null; // Exited before OpenProcess.
      throw;
    }
    catch { process.Dispose(); throw; }
  }
  static void Add(Identity identity, Dictionary<int,Process> handles, Result result) {
    if (handles.ContainsKey(identity.pid)) return;
    var process = Open(identity.pid);
    if (process == null) return;
    try {
      if (StartTicks(process).ToString() != identity.startedAtTicks)
        throw new InvalidOperationException("Process identity changed for PID " + identity.pid + "; refusing termination");
      handles.Add(identity.pid, process);
      result.identities.Add(identity);
    } catch { process.Dispose(); throw; }
  }
  public static void Main() {
    var json = new JavaScriptSerializer { MaxJsonLength = 1024 * 1024 };
    var result = new Result();
    var handles = new Dictionary<int,Process>();
    try {
      var input = json.Deserialize<Request>(Console.In.ReadToEnd());
      if (input.rootPid <= 0) throw new ArgumentException("Invalid service PID");
      if (input.identities != null) {
        foreach (var identity in input.identities) Add(identity, handles, result);
      } else {
        using (var root = Open(input.rootPid)) {
          if (root == null) throw new InvalidOperationException("Service root exited before identity capture");
          Add(new Identity { pid = root.Id, startedAtTicks = StartTicks(root).ToString() }, handles, result);
        }
      }
      var snapshot = input.action == "verify" ? new Dictionary<int,int>() : Snapshot();
      if (input.identities == null && snapshot.ContainsKey(input.rootPid)) result.identities[0].parentPid = snapshot[input.rootPid];
      bool added;
      do {
        added = false;
        foreach (var candidate in snapshot) {
          if (handles.ContainsKey(candidate.Key) || !handles.ContainsKey(candidate.Value)) continue;
          var parent = handles[candidate.Value];
          if (parent.HasExited) continue;
          using (var child = Open(candidate.Key)) {
            if (child == null || StartTicks(child) < StartTicks(parent)) continue;
            Add(new Identity { pid = candidate.Key, parentPid = candidate.Value, startedAtTicks = StartTicks(child).ToString() }, handles, result);
            added = true;
          }
        }
      } while (added);
      if (input.action == "stop") {
        if (input.registryPath != null) {
          // Persist expanded custody before the first kill with all handles held.
          input.registryRecord["windowsProcessTree"] = result.identities;
          var temporary = input.registryPath + "." + Guid.NewGuid().ToString("N") + ".tmp";
          try {
            File.WriteAllText(temporary, json.Serialize(input.registryRecord), new UTF8Encoding(false));
            if (File.Exists(input.registryPath)) File.Replace(temporary, input.registryPath, null);
            else File.Move(temporary, input.registryPath);
          } finally { if (File.Exists(temporary)) File.Delete(temporary); }
        }
        for (var i = result.identities.Count - 1; i >= 0; i--) {
          var process = handles[result.identities[i].pid];
          if (!process.HasExited) {
            try { process.Kill(); }
            catch {
              // Accept the Git Bash last-child exit race only after handle proof.
              if (!process.WaitForExit(100)) throw;
            }
          }
        }
        foreach (var process in handles.Values) {
          if (!process.WaitForExit(input.waitMs)) throw new InvalidOperationException("Owned PID " + process.Id + " did not exit");
        }
        foreach (var candidate in Snapshot()) {
          if (handles.ContainsKey(candidate.Value) && !handles.ContainsKey(candidate.Key))
            throw new InvalidOperationException("Uncaptured descendant PID " + candidate.Key + " appeared during stop; retaining custody for verification");
        }
      }
    } catch (Exception error) { result.error = error.Message; }
    finally { foreach (var process in handles.Values) process.Dispose(); }
    Console.WriteLine(json.Serialize(result));
  }
}
`;

async function buildNativeHelper() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-service-native-"));
  const sourcePath = path.join(directory, "tree.cs");
  const executable = path.join(directory, "tree.exe");
  await fs.writeFile(sourcePath, source, "utf8");
  const fromBase64 = (value: string) => `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(value).toString("base64")}'))`;
  const compile = `$ErrorActionPreference='Stop'; Add-Type -TypeDefinition ([IO.File]::ReadAllText((${fromBase64(sourcePath)}))) -OutputAssembly (${fromBase64(executable)}) -OutputType ConsoleApplication -ReferencedAssemblies System.Web.Extensions`;
  await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(compile, "utf16le").toString("base64")], { windowsHide: true, timeout: 30_000 });
  return executable;
}

export async function windowsServiceProcessTree(input: {
  action: "capture" | "verify" | "stop";
  rootPid: number;
  identities?: WindowsServiceProcessIdentity[];
  waitMs?: number;
  registryPath?: string;
  registryRecord?: Record<string, unknown>;
}) {
  if (!Number.isSafeInteger(input.rootPid) || input.rootPid <= 0) throw new Error("Invalid service PID");
  nativeHelper ??= buildNativeHelper();
  const executable = await nativeHelper;
  return await new Promise<{ identities: WindowsServiceProcessIdentity[]; error: string | null }>((resolve, reject) => {
    const child = spawn(executable, [], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("Windows service process helper timed out")); }, 30_000);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr = (stderr + String(chunk)).slice(-4096); });
    child.stdin.on("error", reject);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) { reject(new Error(`Windows service helper exited ${code}: ${stderr}`)); return; }
      try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
    });
    child.stdin.end(JSON.stringify({ ...input, waitMs: input.waitMs ?? 2000 }));
  });
}
