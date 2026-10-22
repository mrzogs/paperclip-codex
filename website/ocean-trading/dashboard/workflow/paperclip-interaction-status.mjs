import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG = path.join(__dirname, '..', 'config', 'paperclip-interaction-projection.json');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISSUE_IDENTIFIER = /^[A-Z][A-Z0-9]*-\d+$/;

function loadConfig(configPath = DEFAULT_CONFIG) {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (config?.schema_version !== 'ocean-paperclip-interaction-projection/v1'
    || !UUID.test(String(config.paperclip?.company_id || ''))
    || !UUID.test(String(config.paperclip?.project_id || ''))
    || !UUID.test(String(config.paperclip?.workspace_id || ''))
    || !/^[A-Z][A-Z0-9]*$/.test(String(config.paperclip?.company_prefix || ''))
    || !Array.isArray(config.issues) || config.issues.length > 16
    || config.safety?.read_only !== true || config.safety?.automatic_approval !== false
    || config.safety?.runtime_authority !== false) throw new Error('PAPERCLIP_INTERACTION_CONFIG_INVALID');
  for (const issue of config.issues) {
    if (!UUID.test(String(issue?.issue_id || '')) || !ISSUE_IDENTIFIER.test(String(issue?.issue_identifier || ''))
      || typeof issue?.purpose !== 'string' || typeof issue?.response_owner !== 'string') {
      throw new Error('PAPERCLIP_INTERACTION_ISSUE_CONFIG_INVALID');
    }
  }
  return config;
}

function apiUrl(apiBase, pathname) {
  const base = new URL(String(apiBase || 'http://127.0.0.1:3100/api').replace(/\/?$/, '/'));
  return new URL(String(pathname).replace(/^\//, ''), base).toString();
}

function browserIssueUrl(apiBase, prefix, identifier) {
  const base = new URL(String(apiBase || 'http://127.0.0.1:3100/api'));
  base.pathname = base.pathname.replace(/\/api\/?$/, '/');
  base.search = '';
  base.hash = '';
  return new URL(`${encodeURIComponent(prefix)}/issues/${encodeURIComponent(identifier)}`, base).toString();
}

async function getJson(fetchImpl, url, signal) {
  const response = await fetchImpl(url, {method:'GET',cache:'no-store',headers:{Accept:'application/json'},signal});
  if (!response.ok) throw Object.assign(new Error('PAPERCLIP_INTERACTION_READ_FAILED'), {httpStatus:response.status});
  const payload = await response.json().catch(() => null);
  if (!payload) throw new Error('PAPERCLIP_INTERACTION_READ_INVALID');
  return payload;
}

function safeQuestion(question) {
  return {id:String(question?.id || ''),prompt:String(question?.prompt || '')};
}

export async function readPaperclipPendingInteractions(options = {}) {
  const checkedAt = new Date().toISOString();
  let config;
  try { config = loadConfig(options.configPath); }
  catch (error) {
    return {state:'UNAVAILABLE',authoritative:false,action_required:false,checked_at_utc:checkedAt,
      error_code:error.message,items:[]};
  }
  const apiBase = options.apiBase || 'http://127.0.0.1:3100/api';
  const fetchImpl = options.fetchImpl || fetch;
  const configuredTimeoutMs = Number(options.timeoutMs || 2000);
  const timeoutMs = Number.isFinite(configuredTimeoutMs) ? Math.max(250, Math.min(configuredTimeoutMs, 5000)) : 2000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let httpStatus = null;
  try {
    const rows = await Promise.all(config.issues.map(async reference => {
      const issue = await getJson(fetchImpl, apiUrl(apiBase, `issues/${reference.issue_identifier}`), controller.signal);
      if (issue.id !== reference.issue_id || issue.identifier !== reference.issue_identifier
        || issue.companyId !== config.paperclip.company_id || issue.projectId !== config.paperclip.project_id
        || issue.projectWorkspaceId !== config.paperclip.workspace_id) throw new Error('PAPERCLIP_INTERACTION_ISSUE_BINDING_MISMATCH');
      const payload = await getJson(fetchImpl, apiUrl(apiBase, `issues/${reference.issue_id}/interactions`), controller.signal);
      const interactions = Array.isArray(payload) ? payload : [];
      for (const interaction of interactions) {
        if (!UUID.test(String(interaction?.id || '')) || interaction.issueId !== reference.issue_id
          || interaction.companyId !== config.paperclip.company_id || typeof interaction.kind !== 'string'
          || typeof interaction.status !== 'string') throw new Error('PAPERCLIP_INTERACTION_BINDING_INVALID');
      }
      return interactions.filter(interaction => interaction.status === 'pending').map(interaction => ({
        interaction_id:interaction.id, issue_id:reference.issue_id, issue_identifier:reference.issue_identifier,
        issue_title:String(issue.title || reference.issue_identifier), issue_status:String(issue.status || 'unknown').toUpperCase(),
        purpose:reference.purpose, kind:String(interaction.kind).toUpperCase(), status:'PENDING',
        title:String(interaction.title || 'Paperclip input required'), summary:interaction.summary ? String(interaction.summary) : null,
        response_owner:reference.response_owner, action_required:true, authoritative:true,
        questions:interaction.kind === 'ask_user_questions' && Array.isArray(interaction.payload?.questions)
          ? interaction.payload.questions.map(safeQuestion) : [],
        requested_at_utc:interaction.createdAt || null, checked_at_utc:checkedAt,
        url:browserIssueUrl(apiBase, config.paperclip.company_prefix, reference.issue_identifier),
      }));
    }));
    const items = rows.flat();
    return {state:'CURRENT',authoritative:true,action_required:items.length > 0,checked_at_utc:checkedAt,items};
  } catch (error) {
    httpStatus = error?.httpStatus || null;
    return {state:'UNAVAILABLE',authoritative:false,action_required:false,checked_at_utc:checkedAt,
      error_code:error?.name === 'AbortError' ? 'PAPERCLIP_INTERACTION_READ_TIMEOUT' : String(error?.message || 'PAPERCLIP_INTERACTION_UNAVAILABLE'),
      http_status:httpStatus,items:[]};
  } finally {
    clearTimeout(timeout);
  }
}

export async function enrichPaperclipPendingInteractions(view, options = {}) {
  const projection = await readPaperclipPendingInteractions(options);
  const pending = projection.items.filter(item => item.action_required).length;
  const counts = view?.counts ? {...view.counts,
    action_required:Number(view.counts.action_required || 0) + pending,
    pending_gates:Number(view.counts.pending_gates || 0) + pending} : view?.counts;
  return {...view, ...(counts ? {counts} : {}), paperclip_interactions:projection.items,
    paperclip_interactions_total:projection.items.length,
    paperclip_interactions_status:{...projection,items:undefined}};
}
