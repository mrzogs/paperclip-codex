"""Fixed, isolated bootstrap for owner-pinned W3 code. Never a generic runner."""
from __future__ import annotations
import argparse
import datetime as dt
import hashlib
import importlib.abc
import importlib.util
import json
import os
from pathlib import Path
import stat
import sys
import types

ROOT = Path(r"C:\Users\wayne\OneDrive\Documents\Brady - Optimization")
PYTHON = Path(r"D:\Codex\artifacts\cicd-vwap-pull-back-strategy\implementation-20261029\venv\Scripts\python.exe")
PROJECT = "cicd-vwap-pull-back-strategy"
DOMAIN = "trading-strategy"
JOB_HANDLE = None

def require(value, code):
    if not value:
        raise ValueError(code)

def sha(raw):
    return hashlib.sha256(raw).hexdigest().upper()

def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode()

def pairs(values):
    result = {}
    for key, value in values:
        require(key not in result, "DUPLICATE_JSON_KEY")
        result[key] = value
    return result

def decode(raw):
    value = json.loads(raw.decode("utf-8"), object_pairs_hook=pairs,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError("NONFINITE_JSON")))
    require(isinstance(value, dict), "JSON_OBJECT_REQUIRED")
    return value

def checked(path, root=None, directory=False):
    path = Path(path)
    require(path.is_absolute() and not str(path).startswith("\\\\"), "LOCAL_ABSOLUTE_PATH_REQUIRED")
    for item in (path, *path.parents):
        if item.exists():
            info = item.lstat()
            require(not item.is_symlink() and not getattr(info, "st_file_attributes", 0) & 0x400, "ALIAS_PATH_REJECTED")
    resolved = path.resolve(strict=not directory)
    require(root is None or resolved.is_relative_to(root) and resolved != root, "PATH_OUTSIDE_ROOT: " + str(resolved)[-90:])
    return resolved

def bounded(path, limit=33554432):
    file = checked(path)
    require(file.is_file(), "REGULAR_FILE_REQUIRED")
    before = file.stat()
    require(before.st_size <= limit, "BYTE_LIMIT")
    with file.open("rb") as handle:
        raw = handle.read(before.st_size)
    after = file.stat()
    require(len(raw) == before.st_size and (before.st_size, before.st_mtime_ns, before.st_ino) ==
            (after.st_size, after.st_mtime_ns, after.st_ino), "FILE_CHANGED_DURING_READ")
    return raw

def reference(ref):
    require(isinstance(ref, dict) and set(ref) == {"id", "path", "sha256", "byte_length"}, "REFERENCE_REQUIRED")
    raw = bounded(ref["path"])
    require(type(ref["byte_length"]) is int and len(raw) == ref["byte_length"] and sha(raw) == ref["sha256"].upper(), "REFERENCE_HASH_CONFLICT")
    return raw

def budgeted_reader(original_bounded, byte_limit, max_artifact_bytes):
    """Clamp before the authoritative reader opens or allocates an artifact."""
    used_bytes = 0
    def read(*args, **kwargs):
        nonlocal used_bytes
        remaining = byte_limit - used_bytes
        require(remaining > 0, "EVIDENCE_BYTE_BUDGET")
        requested = kwargs.get("max_bytes", max_artifact_bytes)
        require(type(requested) is int and 0 < requested <= max_artifact_bytes, "INVALID_ARTIFACT_BYTE_LIMIT")
        kwargs["max_bytes"] = min(requested, remaining)
        data = original_bounded(*args, **kwargs)
        require(len(data) <= remaining, "EVIDENCE_BYTE_BUDGET")
        used_bytes += len(data)
        return data
    return read

def protect_process_tree():
    """Closing the Python process kills its own decoder descendants on timeout."""
    global JOB_HANDLE
    require(os.name == "nt", "APPROVED_WINDOWS_RUNTIME_REQUIRED")
    import ctypes
    from ctypes import wintypes as w
    class Basic(ctypes.Structure):
        _fields_ = [("PerProcessUserTimeLimit", ctypes.c_longlong), ("PerJobUserTimeLimit", ctypes.c_longlong),
                    ("LimitFlags", w.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t), ("MaximumWorkingSetSize", ctypes.c_size_t),
                    ("ActiveProcessLimit", w.DWORD), ("Affinity", ctypes.c_size_t), ("PriorityClass", w.DWORD), ("SchedulingClass", w.DWORD)]
    class IO(ctypes.Structure):
        _fields_ = [(key, ctypes.c_ulonglong) for key in ("ReadOperationCount", "WriteOperationCount", "OtherOperationCount", "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]
    class Extended(ctypes.Structure):
        _fields_ = [("BasicLimitInformation", Basic), ("IoInfo", IO), ("ProcessMemoryLimit", ctypes.c_size_t),
                    ("JobMemoryLimit", ctypes.c_size_t), ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t)]
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateJobObjectW.argtypes = (ctypes.c_void_p, w.LPCWSTR)
    kernel.CreateJobObjectW.restype = w.HANDLE
    kernel.SetInformationJobObject.argtypes = (w.HANDLE, ctypes.c_int, ctypes.c_void_p, w.DWORD)
    kernel.SetInformationJobObject.restype = w.BOOL
    kernel.GetCurrentProcess.restype = w.HANDLE
    kernel.AssignProcessToJobObject.argtypes = (w.HANDLE, w.HANDLE)
    kernel.AssignProcessToJobObject.restype = w.BOOL
    JOB_HANDLE = kernel.CreateJobObjectW(None, None)
    require(JOB_HANDLE, "PROCESS_JOB_CREATION_FAILED")
    limits = Extended()
    limits.BasicLimitInformation.LimitFlags = 0x2000 | 0x8  # KILL_ON_JOB_CLOSE, ACTIVE_PROCESS
    limits.BasicLimitInformation.ActiveProcessLimit = 2
    require(kernel.SetInformationJobObject(JOB_HANDLE, 9, ctypes.byref(limits), ctypes.sizeof(limits)), "PROCESS_JOB_LIMIT_FAILED")
    require(kernel.AssignProcessToJobObject(JOB_HANDLE, kernel.GetCurrentProcess()), "PROCESS_JOB_ASSIGNMENT_FAILED")

class RetainedLoader(importlib.abc.MetaPathFinder, importlib.abc.Loader):
    def __init__(self, sources):
        self.sources = sources
    def find_spec(self, fullname, path=None, target=None):
        if fullname.startswith("scripts."):
            require(fullname in self.sources, "UNPINNED_LOCAL_IMPORT")
            return importlib.util.spec_from_loader(fullname, self)
        return None
    def create_module(self, spec):
        return None
    def exec_module(self, module):
        file, raw = self.sources[module.__name__]
        module.__file__ = str(file)
        exec(compile(raw, str(file), "exec", dont_inherit=True), module.__dict__)

def main():
    parser = argparse.ArgumentParser(allow_abbrev=False)
    parser.add_argument("--descriptor", required=True)
    parser.add_argument("--descriptor-sha256", required=True)
    args = parser.parse_args()
    require(sys.flags.isolated and sys.flags.no_site and sys.dont_write_bytecode, "ISOLATED_RUNTIME_REQUIRED")
    raw = bounded(args.descriptor, 262144)
    require(sha(raw) == args.descriptor_sha256, "DESCRIPTOR_HASH_CONFLICT")
    d = decode(raw)
    require(d["schema_version"] == "ocean-vwap-discovery-semantic-config/v1" and d["project"] == PROJECT and
            d["domain"] == DOMAIN and d["project_root"] == str(ROOT), "DESCRIPTOR_SCOPE_INVALID")
    require(d["python"]["path"] == str(PYTHON) and Path(sys.executable).absolute() == PYTHON and
            sha(bounded(PYTHON)) == d["python"]["sha256"].upper(), "PYTHON_PIN_CONFLICT")
    require(sha(bounded(__file__)) == d["bootstrap_sha256"].upper(), "BOOTSTRAP_PIN_CONFLICT")
    evidence = checked(d["evidence_root"], directory=True)
    output = checked(d["output_root"], root=evidence, directory=True)
    require(evidence.is_dir() and not checked(args.descriptor).is_relative_to(evidence), "OPERATOR_CONFIG_MUST_BE_INDEPENDENT")
    policy_path = checked(d["policy"]["path"])
    require(not policy_path.is_relative_to(evidence), "POLICY_MUST_BE_INDEPENDENT")
    policy = decode(reference(d["policy"]))
    software = d["execution_class"] == "SOFTWARE_CONTRACT_TEST"
    require(d["execution_class"] in ("AUTHENTICATED_SYSTEM", "SOFTWARE_CONTRACT_TEST") and
            (software or "fixture_clock_utc" not in d), "PRODUCTION_CLOCK_OVERRIDE_REJECTED")
    require(policy["evidence_class"] == ("SYNTHETIC" if software else "AUTHENTICATED_SYSTEM"), "POLICY_CLASS_CONFLICT")
    sources = {}
    for module in d["modules"]:
        name, relative = module["module"], module["relative_path"]
        require(name.startswith("scripts.") and relative == "scripts\\" + name[8:] + ".py" and name not in sources, "MODULE_PATH_INVALID")
        file = checked(ROOT / relative, root=ROOT)
        sources[name] = (file, reference({"id": name, "path": str(file), "sha256": module["sha256"], "byte_length": module["byte_length"]}))
    require(all(name in sources for name in ("scripts.vwap_discovery_intake", "scripts.vwap_improvement_contracts", "scripts.vwap_improvement_proofs", "scripts.vwap_discovery_pack_builder")), "MODULE_CLOSURE_INCOMPLETE")
    index = decode(reference(d["contract_index"]))
    require(index["schema_version"] == "cicd-vwap-contract-index/v1" and len(index["schemas"]) == 21, "CONTRACT_INDEX_INVALID")
    for ref in index["schemas"]:
        file = checked(Path(d["contract_index"]["path"]).parent / ref["path"], root=ROOT)
        reference({"id": ref["id"], "path": str(file), "sha256": ref["sha256"], "byte_length": ref["byte_length"]})
    checked(d["w0_package"]["path"], root=ROOT)
    reference(d["w0_package"])
    decoder = checked(d["hmm_decoder"]["path"])
    reference(d["hmm_decoder"])
    package = {key: d[key] for key in ("python", "bootstrap_sha256", "modules", "contract_index", "w0_package", "hmm_decoder")}
    package_hash = sha(canonical(package))
    request = decode(sys.stdin.buffer.read(16385))
    require(len(canonical(request)) <= 16384 and set(request) == {"pack_ref", "expected"}, "REQUEST_INVALID")
    expected = request["expected"]
    require(expected["source_sha256"].upper() == d["baseline_sha256"].upper() and
            expected["config_sha256"].upper() == d["config_sha256"].upper(), "ACTIVE_BINDING_CONFLICT")
    pack_path = checked(request["pack_ref"]["path"], root=evidence)
    pack_raw = reference(request["pack_ref"])
    protect_process_tree()
    # -S bypasses every .pth/sitecustomize startup hook. Add only the approved
    # runtime's package directory without executing site.addsitedir hooks.
    packages = checked(PYTHON.parent.parent / "Lib/site-packages", directory=True)
    require(packages.is_dir(), "APPROVED_DEPENDENCIES_UNAVAILABLE")
    sys.path.append(str(packages))
    scripts = types.ModuleType("scripts")
    scripts.__path__ = []
    sys.modules["scripts"] = scripts
    sys.meta_path.insert(0, RetainedLoader(sources))
    import scripts.vwap_improvement_contracts as common
    import scripts.vwap_improvement_proofs as proofs
    import scripts.vwap_discovery_intake as intake
    require(intake.HMM_DECODER_PATH == decoder and intake.HMM_DECODER_SHA256 == d["hmm_decoder"]["sha256"].upper(), "SOURCE_DECODER_PIN_CONFLICT")
    common.bounded_bytes = budgeted_reader(common.bounded_bytes, d["limits"]["evidence_bytes"], common.MAX_JSON_BYTES)
    # Reload intake from the retained bytes so its direct bounded_bytes import
    # also uses the budget wrapper, never a changed file on disk.
    loader = sys.meta_path[0]
    loader.exec_module(intake)
    import ctypes
    from ctypes import wintypes
    parse_command = ctypes.WinDLL("shell32", use_last_error=True).CommandLineToArgvW
    parse_command.argtypes = (wintypes.LPCWSTR, ctypes.POINTER(ctypes.c_int))
    parse_command.restype = ctypes.POINTER(wintypes.LPWSTR)
    local_free = ctypes.WinDLL("kernel32", use_last_error=True).LocalFree
    local_free.argtypes = (ctypes.c_void_p,)
    local_free.restype = ctypes.c_void_p
    def audit(event, values):
        if event in ("socket.connect", "socket.bind", "os.system") or event.startswith("os.exec") or event.startswith("os.spawn"):
            raise ValueError("NETWORK_OR_ARBITRARY_EXECUTION_DENIED")
        if event == "subprocess.Popen":
            executable, argv = values[0], values[1]
            if isinstance(argv, str):
                count = ctypes.c_int()
                parsed = parse_command(argv, ctypes.byref(count))
                require(bool(parsed), "DECODER_COMMAND_PARSE_FAILED")
                try:
                    argv = [parsed[index] for index in range(count.value)]
                finally:
                    local_free(parsed)
            require(isinstance(argv, (list, tuple)) and len(argv) == 2 and Path(argv[0]).resolve() == decoder and
                    (executable is None or Path(executable).resolve() == decoder), "ARBITRARY_SUBPROCESS_DENIED")
            checked(argv[1], root=evidence)
        if event == "open" and isinstance(values[0], (str, bytes)):
            flags = values[2] if len(values) > 2 else 0
            if flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND):
                target = Path(os.fsdecode(values[0])).absolute()
                # NamedTemporaryFile audits its directory placeholder before
                # its custom opener; the actual child-file os.open is audited
                # separately and must remain beneath this same output root.
                if target == output:
                    require(output.is_dir(), "OUTPUT_DIRECTORY_REQUIRED")
                else:
                    checked(target, root=output, directory=True)
        if event == "os.mkdir":
            target = Path(values[0]).absolute()
            require(target == output or target.is_relative_to(output), "WRITE_OUTSIDE_OPERATOR_OUTPUT")
        if event in ("os.remove", "os.rmdir", "os.rename", "os.link"):
            for value in values[:2] if event in ("os.rename", "os.link") else values[:1]:
                checked(os.fsdecode(value), root=output, directory=True)
    sys.addaudithook(audit)
    clock = None
    if software:
        clock = common.parse_timestamp(d["fixture_clock_utc"])
    verifier = proofs.TrustedReceiptVerifier.from_policy(policy_path, d["policy"]["sha256"], evidence, now=clock)
    report = intake.admit_discovery_pack(pack_path, evidence, custody_verifier=verifier, software_fixture=software)
    if software:
        require(report["status"] == "SOFTWARE_FIXTURE_VALIDATED" and report["evidence_class"] == "SYNTHETIC",
                "SOFTWARE_SEMANTIC_SMOKE_REJECTED: " + str(report.get("errors", []))[:100])
        # Actual source semantics above, plus all six actual RSA verifications.
        # Never promote this separate software smoke into real source custody.
        pack = common.decode_json(pack_raw)
        for purpose in intake.PURPOSES:
            matches = []
            for ref in pack["custody_receipts"]:
                envelope = common.verified_json(ref, evidence)
                if envelope.get("payload", {}).get("purpose") == purpose:
                    claims = verifier(envelope, purpose, report["manifest_sha256"])
                    require(claims["run_id"] == report["run_id"], "SOFTWARE_CUSTODY_RUN_CONFLICT")
                    matches.append(claims)
            require(len(matches) == 1, "SOFTWARE_CUSTODY_PURPOSE_MISSING")
    report_path = intake.publish_report(report, output)
    raw_report = common.bounded_bytes(report_path, evidence_root=output)
    learning = report.get("learning_rows_artifact")
    require(report.get("manifest_sha256", "").upper() == expected["manifest_sha256"].upper() and
            report.get("run_id") == expected["run_id"] and report["pack_artifact"]["sha256"].upper() == request["pack_ref"]["sha256"].upper(), "REPORT_IDENTITY_CONFLICT")
    result = {"schema_version": "ocean-vwap-discovery-semantic-result/v1", "verified": not software and report["status"] == "QUALIFIED_DISCOVERY",
              "qualified": not software and report["status"] == "QUALIFIED_DISCOVERY", "status": report["status"],
              "report_ref": {"id": report_path.stem, "path": str(report_path), "sha256": sha(raw_report), "byte_length": len(raw_report)},
              "learning_rows_ref": learning, "manifest_sha256": report["manifest_sha256"].upper(), "pack_sha256": sha(pack_raw),
              "learning_rows_sha256": report.get("learning_rows_sha256", "").upper(), "intake_package_sha256": package_hash}
    print(json.dumps(result, separators=(",", ":")), flush=True)

if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        import traceback
        frames = traceback.extract_tb(exc.__traceback__)[-3:]
        print(json.dumps({"schema_version": "ocean-vwap-discovery-semantic-error/v1", "error_type": type(exc).__name__, "code": str(exc)[:160],
                          "frames": [{"function": frame.name, "line": frame.lineno} for frame in frames]}), flush=True)
        raise SystemExit(2)
