const field = (key, label, meaning, provide, validation) => ({ key, label, meaning, provide, validation });

export const ONBOARDING_HELP = {
  steps: [
    {
      number: 1, id: 'strategy-detected', label: 'Strategy detected', mode: 'Automatic',
      purpose: 'Ocean reads the strategy profile, Sierra instance, account, contract, version, and safety state.',
      input: 'Nothing. Correct the strategy or Sierra configuration at source if the displayed setup is wrong.',
      complete: 'The source records belong to one strategy and the prepared instance is non-live with automated ordering off.',
    },
    {
      number: 2, id: 'test-setup', label: 'Replay setup confirmed', mode: 'One confirmation',
      purpose: 'Confirms that Ocean should use the detected setup for a non-live Replay test.',
      input: 'Review the short summary and select Use this detected setup.',
      complete: 'Ocean stores one confirmation receipt and synchronizes it with the project Obsidian Brain.',
    },
    {
      number: 3, id: 'ready-to-test', label: 'Ready to test', mode: 'Automatic preparation',
      purpose: 'Prepares the Ocean record and makes Replay available without starting Sierra.',
      input: 'Click Prepare Replay test after the setup confirmation is recorded. Ocean handles its hashes and technical receipts.',
      complete: 'Onboarding is complete and Replay history runs can be prepared. Sierra runtime, Paper, and Live remain separate.',
    },
  ],
  questionnaires: [
    {
      id: 'test-setup-confirmation', step_id: 'test-setup', title: 'Confirm the detected test setup',
      purpose: 'A single human check that the strategy is attached to the intended non-live Replay setup.',
      fields: [
        field('strategy_summary', 'Strategy rules', 'Ocean uses the entry, exit, stop, target, and sizing rules already encoded in the strategy.', 'Read only. Change the strategy source if these rules are wrong.', 'System generated.'),
        field('test_environment', 'Test environment', 'The environment used for the first controlled test.', 'Read only. The simple onboarding flow starts with Replay.', 'Replay simulation only.'),
        field('instance', 'Sierra instance', 'The prepared Sierra installation that contains the chart and strategy.', 'Read only. Correct the source binding if it is wrong.', 'System generated.'),
        field('account', 'Simulation account', 'The Sierra simulation account used by the Replay setup.', 'Read only. Correct the chart configuration if it is wrong.', 'System generated.'),
        field('symbol', 'Contract', 'The exact contract currently loaded in the prepared chart.', 'Read only. Correct the chart configuration if it is wrong.', 'System generated.'),
        field('version', 'Detected strategy version', 'The version reported by the prepared strategy binary.', 'Read only. Ocean keeps the underlying hash and version observations as technical evidence.', 'System generated.'),
        field('confirm_setup', 'Use this detected setup for a non-live Replay test', 'Your only onboarding decision.', 'Select this when the displayed strategy, instance, account, and contract are the setup you intend to test.', 'Required confirmation.'),
      ],
    },
  ],
  submission_record: [
    field('status', 'Status', 'Whether the setup confirmation has been recorded.', 'No entry.', 'System generated.'),
    field('author', 'Author', 'The signed-in operator who confirmed the setup.', 'No entry.', 'System generated.'),
    field('timestamp', 'Timestamp', 'When the confirmation was recorded.', 'No entry.', 'System generated.'),
    field('source_fingerprint', 'Source fingerprint', 'Ocean\'s internal proof of the exact source records that were displayed.', 'No entry and no manual hash required.', 'System generated.'),
    field('receipt', 'Receipt', 'The immutable audit record for the confirmation.', 'No entry and no manual receipt ID required.', 'System generated.'),
  ],
  registration_fields: [
    field('strategy', 'Strategy', 'The detected strategy being prepared.', 'Review only.', 'Read only.'),
    field('instance', 'Instance', 'The prepared Replay instance.', 'Review only.', 'Read only.'),
    field('account', 'Account', 'The simulation account used by the test.', 'Review only.', 'Read only.'),
    field('contract', 'Contract', 'The contract loaded in the prepared chart.', 'Review only.', 'Read only.'),
    field('result', 'Result', 'Ready for Replay without starting Sierra.', 'Review only.', 'Read only.'),
  ],
  lifecycle_fields: [
    field('replay_history', 'Replay history', 'Historical tests run in Sierra Replay Two after onboarding is complete.', 'Prepare a Replay run in Ocean, then start the chart replay in Sierra.', 'Evidence is accepted only while the prepared run and telemetry are connected.'),
    field('trade_evidence', 'Trade evidence', 'Trades captured during a completed Replay or Paper run.', 'Nothing to type. Ocean receives the telemetry and associates it with the run.', 'Canonical trade identities are deduplicated before evidence totals are shown.'),
    field('no_trade_evidence', 'No-trade evidence', 'A completed covered period in which the strategy made no trades.', 'Nothing to type. Complete the prepared run so the covered zero-trade period can be recorded.', 'A stopped or abandoned run is not presented as completed no-trade evidence.'),
    field('paper_forward', 'Paper forward testing', 'Forward observation in a Sierra simulation account after Replay evidence has been reviewed.', 'Prepare a Paper Forward run when that stage is available, then run the strategy normally.', 'Paper is non-live and uses scoped evidence collection.'),
    field('live_approval', 'Live trading', 'The later production stage after Replay and Paper evidence has been reviewed.', 'Make a separate, explicit human decision when the strategy is genuinely ready.', 'Ocean never promotes or activates Live automatically.'),
    field('advanced_controls', 'Advanced Replay controls', 'Pause, resume, or deactivate Ocean\'s Replay readiness record.', 'Use only when intentionally changing readiness.', 'These controls do not operate Sierra or change onboarding completion.'),
  ],
};
