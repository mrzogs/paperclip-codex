import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { CompletionRelayBinding } from "@paperclipai/shared";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

// Bindings are immutable. Revisions are separate disabled mappings, never edits to an enabled grant.
export const completionRelayMappings = pgTable("completion_relay_mappings", {
  id: uuid("id").primaryKey().defaultRandom(),
  sourceCompanyId: uuid("source_company_id").notNull().references(() => companies.id),
  destinationCompanyId: uuid("destination_company_id").notNull().references(() => companies.id),
  sourceIssueId: uuid("source_issue_id").notNull().references(() => issues.id),
  destinationIssueId: uuid("destination_issue_id").notNull().references(() => issues.id),
  ownerUserId: text("owner_user_id").notNull(),
  ownerKeyId: uuid("owner_key_id").notNull(),
  binding: jsonb("binding").$type<CompletionRelayBinding>().notNull(),
  bindingHash: text("binding_hash").notNull(),
  idempotencyKey: uuid("idempotency_key").notNull(),
  enabled: boolean("enabled").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({ key: uniqueIndex("completion_relay_mapping_key_uq").on(t.idempotencyKey) }));

export const completionRelayOutbox = pgTable("completion_relay_outbox", {
  id: uuid("id").primaryKey().defaultRandom(),
  mappingId: uuid("mapping_id").notNull().references(() => completionRelayMappings.id),
  state: text("state").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
  failure: text("failure"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({ mapping: uniqueIndex("completion_relay_outbox_mapping_uq").on(t.mappingId),
  due: index("completion_relay_outbox_due_idx").on(t.state, t.nextAttemptAt) }));

export const completionRelayInbox = pgTable("completion_relay_inbox", {
  id: uuid("id").primaryKey().defaultRandom(),
  mappingId: uuid("mapping_id").notNull().references(() => completionRelayMappings.id),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  issueId: uuid("issue_id").notNull().references(() => issues.id),
  bindingHash: text("binding_hash").notNull(),
  receipt: jsonb("receipt").$type<{ attachmentIds: string[]; hashes: string[]; commentId: string }>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({ mapping: uniqueIndex("completion_relay_inbox_mapping_uq").on(t.mappingId),
  destination: index("completion_relay_inbox_destination_idx").on(t.companyId, t.issueId) }));
