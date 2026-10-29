"""Build an owned SOFTWARE_CONTRACT_TEST pack; never export private test keys."""
import hashlib
import json
from pathlib import Path
import sys

if sys.argv[1] == "--budget-contract":
    import runpy
    make_reader = runpy.run_path(sys.argv[2])["budgeted_reader"]
    calls = []
    def bounded_stub(*args, **kwargs):
        calls.append(kwargs["max_bytes"])
        return b"x" * kwargs["max_bytes"]
    reader = make_reader(bounded_stub, 10, 32)
    assert len(reader("unused", max_bytes=3)) == 3
    assert len(reader("unused", max_bytes=20)) == 7
    try:
        reader("unused")
    except ValueError as exc:
        assert str(exc) == "EVIDENCE_BYTE_BUDGET"
    else:
        raise AssertionError("Exhausted reader reached original reader")
    assert calls == [3, 7]
    print(json.dumps({"classification":"SOFTWARE_CONTRACT_TEST", "read_limits":calls, "calls_after_exhaustion":len(calls)}))
    raise SystemExit(0)

ROOT=Path(r"C:\Users\wayne\OneDrive\Documents\Brady - Optimization")
PYTHON=Path(r"D:\Codex\artifacts\cicd-vwap-pull-back-strategy\implementation-20261029\venv\Scripts\python.exe")
sys.path.append(str(PYTHON.parent.parent / "Lib/site-packages"))
sys.path.insert(0,str(ROOT))
from scripts.test_vwap_discovery_intake import build_pack,signed_custody_fixture,mutate
from scripts.vwap_discovery_intake import admit_discovery_pack,HMM_DECODER_PATH
from scripts.vwap_improvement_contracts import canonical_bytes,read_json

def ref(path):
    raw=path.read_bytes()
    return {"id":path.stem,"path":str(path),"sha256":hashlib.sha256(raw).hexdigest().upper(),"byte_length":len(raw)}

base=Path(sys.argv[1]).resolve()
evidence=base/"evidence"
trust=base/"operator"
evidence.mkdir(parents=True)
trust.mkdir()
pack=build_pack(evidence,evidence_class="SYNTHETIC")
report=admit_discovery_pack(pack,evidence,software_fixture=True)
assert report["status"]=="SOFTWARE_FIXTURE_VALIDATED",report
bad_semantics=len(sys.argv)>3 and sys.argv[3]=="--invalid-semantic"
if bad_semantics:
    mutate(pack,"economics",lambda value:value["records"][0].update(net="999"))
verifier=signed_custody_fixture(pack,trust,"SYNTHETIC")
signed_pack=read_json(pack)
for receipt_ref in signed_pack["custody_receipts"]:
    envelope=read_json(evidence/receipt_ref["path"])
    assert verifier(envelope,envelope["payload"]["purpose"],signed_pack["manifest"]["sha256"])["verified"] is True
manifest=read_json(evidence/read_json(pack)["manifest"]["path"])
bootstrap=Path(sys.argv[2]).resolve()
modules=[]
for name in ("vwap_improvement_contracts","vwap_improvement_proofs","vwap_discovery_intake","vwap_discovery_pack_builder"):
    item=ref(ROOT/"scripts"/(name+".py"))
    modules.append({"module":"scripts."+name,"relative_path":"scripts\\"+name+".py","sha256":item["sha256"],"byte_length":item["byte_length"]})
descriptor={"schema_version":"ocean-vwap-discovery-semantic-config/v1","project":"cicd-vwap-pull-back-strategy","domain":"trading-strategy","project_root":str(ROOT),
  "execution_class":"SOFTWARE_CONTRACT_TEST","fixture_clock_utc":"2026-10-29T13:30:00Z",
  "python":{"path":str(PYTHON),"sha256":ref(PYTHON)["sha256"]},"bootstrap_sha256":ref(bootstrap)["sha256"],"modules":modules,
  "contract_index":ref(ROOT/"onboarding/contracts/vwap-improvement-v1/contract-index.json"),
  "w0_package":ref(ROOT/"onboarding/vwap-cross-system-coding-plan-20261029.md"),"hmm_decoder":ref(HMM_DECODER_PATH),
  "policy":ref(trust/"test-policy.json"),"evidence_root":str(evidence),"output_root":str(evidence/"semantic-output"),
  "baseline_sha256":manifest["source_binding"]["source_sha256"],"config_sha256":manifest["source_binding"]["config_sha256"],
  "limits":{"timeout_ms":60000,"stdout_bytes":16384,"stderr_bytes":8192,"evidence_bytes":67108864}}
config=trust/"semantic-config.json"
config.write_bytes(canonical_bytes(descriptor))
request={"pack_ref":ref(pack),"expected":{"manifest_sha256":signed_pack["manifest"]["sha256"],"run_id":report["run_id"],
  "source_sha256":descriptor["baseline_sha256"],"config_sha256":descriptor["config_sha256"],"learning_rows_sha256":report["learning_rows_sha256"]}}
(base/"fixture-metadata.json").write_bytes(canonical_bytes({"classification":"SOFTWARE_CONTRACT_TEST","private_keys_exported":False,"custody_signature_count_verified":len(signed_pack["custody_receipts"]),"descriptor":ref(config),"request":request}))
print(json.dumps({"classification":"SOFTWARE_CONTRACT_TEST","descriptor":ref(config),"request":request}))
