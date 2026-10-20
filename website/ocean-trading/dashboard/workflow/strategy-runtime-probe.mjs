import {probeReplayTwoRuntime} from './strategy-onboarding.mjs';
// This subprocess performs the existing read-only process/status observation only.
process.stdout.write(JSON.stringify(probeReplayTwoRuntime(JSON.parse(process.argv[2]))));
