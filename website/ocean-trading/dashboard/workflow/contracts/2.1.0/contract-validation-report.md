# Shared contract 2.1.0 validation report

Date: 2026-09-14

## Result

PASS. Release 2.1.0 is an additive successor to immutable 2.0.1. It preserves
existing identifiers without aliasing and adds an explicit Paper designation
lifecycle plus versioned release history. A Paper designation is not a claim of
a connected Sierra instance, loaded DLL, account, telemetry producer, order, or
trade. Production remains unset.

## Validation

| Command | Type | Observed result |
|---|---|---|
| `python -m pytest backend/tests/test_shared_contract_release.py backend/tests/test_shared_contract_release_2_0_1.py backend/tests/test_shared_contract_release_2_1_0.py backend/tests/test_strategy_registry.py -q` | Actual local contract and registry tests | PASS: 38 passed; one known Starlette/httpx deprecation warning |
| `python -m pytest backend/tests -q` | Actual complete backend suite | PASS: 144 passed; one known Starlette/httpx deprecation warning |
| `python -m pytest cli/tests -q` | Actual CLI unit suite | PASS: 12 passed |
| `python -m pytest mcp/brain_mcp_server/tests -q` | Actual MCP unit suite | PASS: 9 passed |
| `git diff --check` | Static source check | PASS |

The new focused tests compile all root/wrapper schemas, validate the full
manifest, preserve 2.0.1 behaviour, reject malformed identifiers, validate a
Paper-designated profile and registry, reject a falsely complete release, and
prove that a Paper designation without an active exact Paper instance is not
eligible for normal Brain ingestion or recommendations.

## Compatibility and preservation

- Releases 2.0.0 and 2.0.1 remain unchanged.
- The legacy generic `vwap-wave-pullback` record is a distinct historic draft;
  it is not an alias for `vwap_wave_pullback_balanced_nasdaq_v0434`.
- No VWAP strategy or HMM rule, OQL registry, SQLite/Ocean ledger, Brain vault,
  Library, index, service configuration, Sierra instance, Paper account, or
  order path was changed.
- No provider, runtime source, or execution instance was activated.

## Material unknowns

1. Paper runtime binding still needs a factual Sierra installation, chartbook,
   chart, strategy/HMM study, loaded strategy DLL, source session, account,
   telemetry producer and order/fill-correlation receipt.
2. The current Paper release has source/config/HMM identities but no attested
   strategy DLL binding. The release is therefore `PAPER_BINDING_PENDING`, not
   a full runtime attestation.
3. Historical v0.6.165 baseline identity is preserved as partial historical
   evidence. Missing hashes remain null rather than guessed.
4. No Paper-forward result exists in this validation. Strategy profitability and
   live-readiness are not established by this contract work.
