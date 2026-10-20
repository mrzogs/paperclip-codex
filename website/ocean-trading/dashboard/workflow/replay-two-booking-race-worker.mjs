import { WorkflowStore } from "./store.mjs";
import { ReplayTwoBookingRegistry } from "./replay-two-booking-registry.mjs";

const [database, rawConfig, rawActor, rawInput, rawNow] = process.argv.slice(2);
const store = new WorkflowStore(database);
const registry = new ReplayTwoBookingRegistry({
  db: store.db,
  store,
  environment: {},
  config: { replay_two_booking_registry: JSON.parse(rawConfig) },
});
registry.now = () => Number(rawNow);
const actor = JSON.parse(rawActor);
const input = JSON.parse(rawInput);

process.send({ type: "ready" });
process.once("message", (message) => {
  if (message?.type !== "go") return;
  try {
    const response = registry.acquire(actor, input);
    process.send({ type: "result", ok: true, generation: response.receipt.generation });
  } catch (error) {
    process.send({ type: "result", ok: false, status: error.status, code: error.code || error.message });
  } finally {
    store.close();
  }
});
