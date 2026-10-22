import type { CompletionRelayStatus } from "@paperclipai/shared";
import { api } from "./client";
export const completionRelaysApi = {
  list: (companyId: string) => api.get<CompletionRelayStatus[]>(`/companies/${companyId}/completion-relays`),
};
