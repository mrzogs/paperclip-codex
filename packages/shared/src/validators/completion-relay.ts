import { z } from "zod";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const completionRelayMappingSchema = z.object({
  projectId: z.string().uuid(),
  domain: z.string().regex(/^[a-z0-9-]{1,80}$/),
  strategy: z.string().regex(/^[a-z0-9-]{1,80}$/),
  sourceCompanyId: z.string().uuid(),
  sourceIssueId: z.string().uuid(),
  destinationCompanyId: z.string().uuid(),
  destinationIssueId: z.string().uuid(),
  destinationGate: z.string().regex(/^[a-z0-9-]{1,80}$/),
  sourceStatus: z.literal("done"),
  sourceVersion: z.string().datetime(),
  sourceAssigneeAgentId: z.string().uuid().nullable(),
  sourceAssigneeUserId: z.string().nullable(),
  sourceRunId: z.string().uuid(),
  acceptanceId: z.string().uuid(),
  acceptanceHash: digest,
  reviewerAgentId: z.string().uuid().nullable(),
  reviewerUserId: z.string().nullable(),
  evidence: z.array(z.object({
    workProductId: z.string().uuid(),
    attachmentId: z.string().uuid(),
    sha256: digest,
  }).strict()).min(1).max(10),
  authorizeOriginalCopies: z.literal(true),
  mappingRevision: z.number().int().positive(),
  idempotencyKey: z.string().uuid(),
}).strict().refine(v => v.sourceCompanyId !== v.destinationCompanyId && v.sourceIssueId !== v.destinationIssueId,
  "Relay endpoints must be in distinct companies and issues")
  .refine(v => Boolean(v.reviewerAgentId) !== Boolean(v.reviewerUserId), "Exactly one reviewer identity required");

export type CompletionRelayBinding = z.infer<typeof completionRelayMappingSchema>;
