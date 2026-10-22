import { useQuery } from "@tanstack/react-query";
import { completionRelaysApi } from "../api/completionRelays";

export function CompletionRelayStatus({ companyId }: { companyId: string }) {
  const query = useQuery({ queryKey: ["completion-relays", companyId], queryFn: () => completionRelaysApi.list(companyId) });
  return <section className="space-y-3 rounded-md border p-4" aria-label="Completion relays">
    <h2 className="text-sm font-medium">Completion relays</h2>
    <p className="text-sm text-muted-foreground">Evidence delivery leaves destination gates awaiting independent acceptance.</p>
    {query.isPending && <p>Loading relays…</p>}
    {query.error && <p role="alert">{query.error.message}</p>}
    {query.data?.length === 0 && <p className="text-sm">No relays owned by your Board identity.</p>}
    {query.data?.map(m => <div key={m.id} className="text-sm border-t pt-2">
      <p>{m.binding.destinationGate} · revision {m.binding.mappingRevision} · {m.enabled ? "Enabled" : "Disabled"}</p>
      {m.outbox.length === 0 && <p>Awaiting reconciliation</p>}
      {m.outbox.map((j, i) => <div key={i}><p>{j.state} · attempts {j.attempts}</p>{j.failure && <p role="alert">{j.failure}</p>}</div>)}
    </div>)}
  </section>;
}
