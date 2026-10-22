export interface CompletionRelayStatus {
  id: string;
  enabled: boolean;
  bindingHash: string;
  binding: { mappingRevision: number; destinationGate: string };
  outbox: Array<{ state: string; attempts: number; nextAttemptAt: string; failure: string | null }>;
}
