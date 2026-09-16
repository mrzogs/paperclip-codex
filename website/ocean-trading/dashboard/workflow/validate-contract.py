import json
import sys
from pathlib import Path

from jsonschema import Draft202012Validator, FormatChecker


def main():
    root = Path(__file__).parent / "contracts" / "2.1.0" / "shared-contracts"
    kinds = {
        "strategy-profile": "strategyProfile",
        "strategy-registry": "strategyRegistry",
        "execution-instance": "executionInstance",
        "dataset-manifest": "datasetManifest",
        "run-context": "runContext",
        "run-completion": "runCompletion",
        "artifact-manifest": "artifactManifest",
        "approval-decision": "approvalDecision",
        "handoff": "handoff",
        "workflow-event": "workflowEvent",
        "source-state": "sourceState",
    }
    request = json.load(sys.stdin)
    definition = kinds.get(request.get("kind"))
    if definition is None:
        return 2
    schema = json.loads((root / "shared-contracts.schema.json").read_text(encoding="utf-8-sig"))
    schema["$ref"] = "#/$defs/" + definition
    errors = list(Draft202012Validator(schema, format_checker=FormatChecker()).iter_errors(request["payload"]))
    print(json.dumps({"valid": not errors, "error_count": len(errors)}))
    return 0 if not errors else 1


if __name__ == "__main__":
    raise SystemExit(main())
