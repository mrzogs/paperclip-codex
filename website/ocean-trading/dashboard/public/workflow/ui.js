import { renderIcons } from './icons.js';
import { openRunWizard } from './run-wizard.js';

const content = document.querySelector('#content');
const modal = document.querySelector('#modal');
const notice = document.querySelector('#notice');
const freshness = document.querySelector('#freshness');
const csrfKey = 'ocean-workflow-human-csrf';
const state = { csrf: sessionStorage.getItem(csrfKey), signedIn: false, data: null, offset: 0, filter: '', lastSuccess: null, timer: null, controller: null, generation: 0, fingerprint: null, mutation: false, imageUrls: [] };
const text = value => value === null || value === undefined || value === '' ? 'Not recorded' : String(value);
const esc = value => text(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const human = value => text(value).replaceAll('_', ' ').toLowerCase().replace(/^\w/, letter => letter.toUpperCase());
const date = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('en-GB', { timeZone: 'Europe/London', dateStyle: 'medium', timeStyle: 'short' }) + ' UK' : 'Not recorded';
const newId = prefix => `test-ui-${prefix}-${crypto.randomUUID()}`;
const icon = name => `<i data-lucide='${name}'></i>`;
const badge = value => `<span class='badge ${/FAIL|BLOCK|REJECT|MISMATCH|REVOK|EXPIRED/.test(value) ? 'bad' : /PENDING|REVIEW|PAUSED|NOT_RUN|UNKNOWN|STALE/.test(value) ? 'warn' : /PASS|APPROVED|COMPLETE|ACKNOWLEDGED/.test(value) ? 'good' : 'neutral'}'>${esc(human(value))}</span>`;
const link = (collection, key, label = key) => `<a data-route href='/improvement/${collection}/${encodeURIComponent(key)}'>${esc(label)}</a>`;
const empty = message => `<p class='empty'>${esc(message)}</p>`;
const facts = entries => `<dl class='facts'>${entries.map(([key, value]) => `<div><dt>${esc(key)}</dt><dd>${value}</dd></div>`).join('')}</dl>`;
const hash = value => value ? `<code>${esc(value)}</code>` : '<span class="muted">Not recorded</span>';
const table = (headers, rows) => rows.length ? `<div class='table-wrap'><table><thead><tr>${headers.map(value => `<th scope='col'>${esc(value)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(value => `<td>${value}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : empty('No records in this view.');
const section = (title, body, extra = '') => `<section><div class='section-heading'><h2>${esc(title)}</h2>${extra}</div>${body}</section>`;
const button = (action, label, attrs = '', symbol = '') => `<button data-action='${action}' ${attrs}>${symbol ? icon(symbol) : ''}${esc(label)}</button>`;
const route = () => { const parts = location.pathname.replace(/\/$/, '').split('/'); return { view: parts[2] || 'dashboard', key: parts[3] || null }; };

function showNotice(message) { notice.textContent = message; notice.hidden = !message; }
function errorText(error) {
  if (error.code === 'HUMAN_UNENROLLED') return 'Human access is not set up yet. Service authentication is separate.';
  if (error.code === 'HUMAN_ACCESS_UNAVAILABLE') return 'Human access needs recovery. Service authentication is separate.';
  const messages = { WAYNE_LOCAL_ENROLLMENT_REQUIRED: 'Local workflow access is not set up yet. Open Set up or recover access below.', WORKFLOW_DISABLED: 'Workflow setup is pending. The trading dashboard is available.', WORKFLOW_CONFIG_BLOCKED: 'Workflow configuration needs attention.', SESSION_EXPIRED_OR_INVALID: 'Your session expired. Sign in again.', AUTHENTICATION_REQUIRED: 'Sign in to review workflow records.', REVISION_CONFLICT: 'This record changed. Close this review and open the latest version.', APPROVAL_REQUEST_STALE_OR_MISMATCH: 'This approval has changed or expired. Open the latest review.', BLOCKED_RECONCILIATION: 'The registered version changed. This case needs reconciliation.', CSRF_REJECTED: 'The browser session changed. Sign in again before submitting.', RECIPIENT_ACCEPTANCE_REQUIRED: 'Recipient acknowledgement must come from the recipient account.', ACTIVE_ARTIFACT_CONTENT_REJECTED: 'This file contains active content or private filesystem references.', UNSAFE_IMAGE_REJECTED: 'Use a single PNG up to 128 KiB and 2048 pixels per side, without embedded metadata.', ENTITY_NOT_FOUND: 'This record is unavailable.', UNKNOWN_VIEW: 'This page is unavailable.', ARTIFACT_STAGE_PREREQUISITE_REQUIRED: 'This result does not belong to the current case stage.' };
  return messages[error.code] || `${human(error.code || 'CONNECTION_FAILED')}. The action was not confirmed.`;
}
async function request(path, options = {}) {
  const controller = options.signal ? null : new AbortController();
  const timer = controller ? setTimeout(() => controller.abort(), 12000) : null;
  try {
    const response = await fetch(`/api/workflow/${path}`, { credentials: 'same-origin', cache: 'no-store', ...options, signal: options.signal || controller.signal });
    if (!response.ok) { const payload = await response.json().catch(() => ({})); throw Object.assign(new Error(payload.error?.code || 'REQUEST_FAILED'), { code: payload.error?.code || 'REQUEST_FAILED', status: response.status }); }
    return options.binary ? response : await response.json();
  } finally { clearTimeout(timer); }
}
async function post(path, data, message = newId('message')) {
  return request(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrf || '' }, body: JSON.stringify({ message_id: message, data }) });
}
function signIn(message = '') {
  freshness.textContent = 'Sign-in required';
  showNotice('');
  state.signedIn = false; state.data = null; state.fingerprint = null; state.csrf = null;
  sessionStorage.removeItem(csrfKey);
  if (modal.open) modal.close();
  for (const url of state.imageUrls) URL.revokeObjectURL(url);
  state.imageUrls = [];
  document.querySelector('#logout').hidden = true; document.querySelector('#approval-badge').hidden = true;
  content.setAttribute('aria-busy', 'false');
  content.innerHTML = `<form class='login' id='login'><h1>Sign in to Ocean</h1><p class='muted'>Wayne's workflow account</p><div class='field'><label for='credential'>Optional recovery password</label><input id='credential' type='password' autocomplete='current-password' maxlength='256' spellcheck='false' placeholder='Leave blank for local access'></div><p class='form-error' role='alert'>${message ? esc(message) : ''}</p><button class='primary' type='submit'>Sign in</button><details class='access-help'><summary>Set up or recover access</summary><p>Run the protected local operator command in your Windows PowerShell window. It creates local access without asking for a password.</p><code>&amp; 'D:\\Paperclip-codex\\scripts\\ocean-workflow-operator.ps1' -Action Initialize</code><p><code>-Action Reset-Password</code> is optional and only needed if you deliberately switch to password recovery mode. Then restart the website:</p><code>&amp; 'D:\\Paperclip-codex\\scripts\\start-ocean-trading-stack.ps1' -WebsiteOnly -RestartWebsite</code><p>Access setup does not approve a strategy or start trading.</p></details></form>`;
  document.querySelector('#login').addEventListener('submit', async event => {
    event.preventDefault(); const form = event.currentTarget; const submit = form.querySelector('button'); submit.disabled = true;
    const input = form.querySelector('#credential'); const credential = input.value; input.value = '';
    try {
      const session = await request('session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ credential }) });
      state.csrf = session.csrf_token; sessionStorage.setItem(csrfKey, state.csrf); state.signedIn = true;
      document.querySelector('#logout').hidden = false; showNotice(''); await refresh(true);
    } catch (error) { form.querySelector('.form-error').textContent = errorText(error); submit.disabled = false; input.focus(); }
  });
  const status = document.createElement('p'); status.className='muted'; status.id='service-readiness';
  document.querySelector('#login h1').after(status);
  request('readiness').then(value => {
    if(status.isConnected)status.textContent=`Services: ${human(value.machine)}. Human access: ${human(value.human)}. Auth: ${human(value.human_auth_method || 'operator')}. Due: ${esc(value.human_acceptance_due || 'Not recorded')}. Ingestion: off.`;
  }).catch(()=>{if(status.isConnected)status.textContent='Service readiness unavailable.';});
}
function heading(title, subtitle = '', actions = '') {
  return `<div class='page-heading'><div><h1>${esc(title)}</h1>${subtitle ? `<p class='subline'>${esc(subtitle)}</p>` : ''}</div><div class='actions'>${actions}</div></div>`;
}
function caseTable(items) {
  return table(['Case / strategy', 'Stage', 'Owner', 'Work status', 'Waiting on'], items.map(row => [link('cases', row.case_id) + `<div class='subline'>${esc(row.strategy_name)}</div>`, esc(human(row.stage)), esc(row.owner_id), badge(row.work_status), esc(row.waiting_on || 'Stage prerequisites')]));
}
function runTable(items) {
  return table(['Run / strategy', 'State', 'Instance', 'Declared / observed', 'Purpose'], items.map(row => {
    const context = row.context; const observed = row.events.find(event => event.payload?.observed_handshake)?.payload.observed_handshake.source_state || context.observed_source_state;
    return [link('runs', context.run_id) + `<div class='subline'>${esc(row.strategy_name)}</div>`, badge(row.state), esc(context.execution_instance_id), `${esc(context.expected_environment)} / ${esc(observed.environment)}`, esc(human(context.evidence_purpose))];
  }));
}
function approvalTable(items) {
  return table(['Gate / case', 'Strategy', 'State', 'Recipient', 'Expires'], items.map(row => [link('approvals', row.request_id, human(row.gate)) + `<div class='subline'>${esc(row.case_id)}</div>`, esc(row.strategy_name), badge(row.state) + (row.blocked_reason && row.state === 'PENDING' ? `<div class='subline'>${esc(human(row.blocked_reason))}</div>` : ''), esc(row.snapshot.recipient_id), esc(date(row.expires_at_utc))]));
}
function timeline(items) {
  if (!items.length) return empty('No history recorded.');
  return `<ol class='timeline'>${items.map(event => `<li><span class='timestamp'>${esc(date(event.created_at_utc))}</span><p><strong>${esc(human(event.action.replaceAll('.', ' ')))}</strong> <span class='muted'>${esc(event.entity_id)}</span></p><p>${esc(event.actor_id)} <span class='muted'>${esc(event.actor_role)}</span></p>${event.payload?.reason || event.payload?.note ? `<p>${esc(event.payload.reason || event.payload.note)}</p>` : ''}<details><summary>Recorded details</summary><pre>${esc(JSON.stringify(event.payload, null, 2))}</pre></details></li>`).join('')}</ol>`;
}
function providerPanel(data) {
  const binding = data.provider_binding || {};
  const operational = data.operational_readiness || {};
  const current = binding.current_amended_provider || {};
  const foundation = binding.immutable_machine_foundation || {};
  const rows = (binding.historical_diagnostics || []).map(row => [
    esc(row.task_id),
    badge(row.status || 'NOT_IMPORTED'),
    esc(row.diagnostic_preserved ? 'Preserved diagnostic' : row.task_id === 'S26.2' ? 'Replacement receipt' : 'Setup receipt'),
    row.verified_bundle_sha256 ? hash(`sha256:${row.verified_bundle_sha256}`) : '<span class="muted">Not imported</span>',
  ]);
  const pending = (operational.pending_items || []).length ? table(['Pending item', 'Strategy', 'Kind', 'Created'], operational.pending_items.map(row => [esc(row.id), esc(row.strategy_id || 'Not recorded'), esc(row.kind), esc(date(row.created_at_utc))])) : empty('No pending operational dataset/profile records in this store.');
  return section('Provider binding and setup receipts',
    facts([
      ['Current TEST provider', `${esc(current.task_id || 'S23.3')} ${badge(current.status || 'NOT_IMPORTED')}`],
      ['Machine foundation', `${esc(foundation.task_id || 'S23.2')} ${badge(foundation.status || 'NOT_IMPORTED')}`],
      ['Human access due', esc(data.human_acceptance_due || 'S33.2')],
      ['Execution state', `TEST only; dispatch ${esc(data.dispatch_worker || 'OFF')}; ingestion ${esc(operational.normal_ingestion || 'OFF')}`],
      ['Operational release', `Replay ${esc(operational.replay_enabled ? 'enabled' : 'disabled')}; Paper ${esc(operational.paper_forward_enabled ? 'enabled' : 'disabled')}; Live ${esc(operational.live_real || data.live_real || 'DISABLED')}`],
      ['Persisted setup receipts', esc(binding.persisted_receipts_total ?? 0)],
    ]) + table(['Task', 'Receipt state', 'Meaning', 'Bundle hash'], rows) + `<div class='section-heading'><h3>Pending operational records</h3><span class='muted'>S31.2 manifests remain proposed until later human release gates.</span></div>${pending}`,
    `<span class='muted'>${esc(binding.receipt_order || 'Historical statuses preserved')}</span>`);
}
function pager(data) {
  return `<div class='pager'><span>${data.total ? data.offset + 1 : 0}-${Math.min(data.offset + data.page_size, data.total)} of ${data.total}</span><span class='spacer'></span><button class='icon' data-action='previous' title='Previous page' aria-label='Previous page' ${data.offset === 0 ? 'disabled' : ''}>${icon('chevron-left')}</button><button class='icon' data-action='next' title='Next page' aria-label='Next page' ${data.offset + data.page_size >= data.total ? 'disabled' : ''}>${icon('chevron-right')}</button></div>`;
}
function overview(data) {
  const count = data.counts;
  return heading('Overview', 'Reviews, case progress and integration health') + `<div class='stats'>${[['Action required', count.action_required], ['Active cases', count.active_cases], ['Blocked / failed', count.blocked_cases], ['Active runs', count.active_runs], ['Pending sync', count.pending_sync]].map(([name, value], index) => `<div class='stat ${index === 0 || index === 2 ? 'attention' : ''}'><span>${esc(name)}</span><strong>${value}</strong></div>`).join('')}</div>${providerPanel(data)}<div class='columns'><div>${section('Awaiting decisions', approvalTable(data.pending), `<span class='muted'>${count.pending_gates} pending gates / ${count.urgent_reviews} urgent reviews</span>`)}${section('Current cases', caseTable(data.cases), '<a data-route href="/improvement/cases">All cases</a>')}</div><div>${section('Integration health', data.health.length ? data.health.map(row => `<div class='list-row'><div class='row-head'><strong>${esc(row.provider_id)}</strong>${badge(row.stale ? 'STALE' : row.status)}</div><p>${esc(row.instance_id)}</p><p>${esc(row.next_action)}</p><p class='muted'>${esc(row.next_owner)} / ${esc(date(row.observed_at_utc))}</p></div>`).join('') : empty('No provider observations recorded.'))}<p class='muted'>Local access ready. Integrations pending S24.1 / S26.2 / S27.2 / S28.2. Dispatch off.</p>${section('Recent history', timeline(data.history), '<a data-route href="/improvement/history">All history</a>')}</div></div>`;
}
function strategyPage(data) {
  return heading(data.strategy_name, data.strategy_id, badge(data.activation_status) + button('prepare-run','Prepare run','', 'plus')) + facts([
    ['Onboarding', esc(human(data.activation_status))], ['Paper baseline', esc(data.baseline_version)], ['Production version', data.production_version ? esc(data.production_version) : 'None registered'],
    ['Profile', `${esc(data.profile.profile_id)} / ${esc(data.profile.profile_version)}`], ['Code hash', hash(data.baseline_hash)], ['Configuration hash', hash(data.profile.strategy_config_hash)],
  ]) + section('Execution instances', table(['Instance', 'Account', 'Capabilities', 'Version', 'Status'], data.instances.map(row => [esc(row.execution_instance_id), esc(row.account_alias), esc(row.capabilities.join(', ')), esc(row.version_binding), badge(row.status)]))) + section('Cases', caseTable(data.cases), `<span class='muted'>${data.cases_total} registered; each case has its own stage</span>`) + section('Runs and coverage', runTable(data.runs), `<span class='muted'>${data.runs_total} registered</span>`);
}
function runPage(data) {
  const context = data.context;
  const observed = data.events.find(event => event.payload?.observed_handshake)?.payload.observed_handshake.source_state || context.observed_source_state;
  const completion = data.events.find(event => event.payload?.completion)?.payload.completion;
  const incoming = data.events.filter(event => event.payload?.wire_event);
  return heading(context.run_id, data.strategy_name, badge(data.state) + (data.manager && ['READY','ACTIVE'].includes(data.state) ? button('end-run','End run','', 'square') : '')) + (data.manager ? section('Run control',facts([
    ['Context',esc(human(data.manager.context_status))],['Last heartbeat',esc(date(data.manager.lease?.heartbeat_utc))],['Lease',data.manager.lease ? badge(data.manager.lease.expired?'EXPIRED':'CURRENT') : 'Awaiting telemetry'],['Unique evidence / processing',`${data.manager.unique_canonical_count} / ${data.manager.processing_count}`],['Open pins / pending events',`${data.manager.open_pins} / ${data.manager.progress?.pending_events ?? 'Unknown'}`],['Source / execution / processing coverage',data.manager.progress ? Object.entries(data.manager.progress.axes).map(([key,values])=>`${esc(human(key))}: ${values.length} observed intervals`).join('<br>') : 'Not observed'],['Completion receipt',data.manager.completion ? data.manager.completion_current?'Current':'New evidence needs review / new receipt':'Not recorded'],['Ingestion','Off / TEST only'],['Action required',data.manager.context_status!=='CURRENT'?esc(human(data.manager.context_status)):data.state==='READY'?'Await matching manual Sierra activity':data.state==='COMPLETING'?'Await telemetry drain and completion':'See observed progress'],
  ])) : '') + facts([
    ['Strategy', link('strategies', context.strategy_id, data.strategy_name)], ['Instance', esc(context.execution_instance_id)], ['Purpose', esc(human(context.evidence_purpose))],
    ['Declared environment', esc(context.expected_environment)], ['Observed environment', esc(observed.environment)], ['Source quality', badge(observed.quality)], ['Observation time', esc(date(observed.observed_at_utc))], ['Strategy version', esc(context.strategy_version)], ['Dataset scope', `${esc(context.dataset_manifest_id)} / revision ${esc(context.dataset_manifest_revision)}`],
    ['Event receipts in history', esc(incoming.length)], ['Analysis complete in history', esc(incoming.filter(event => event.payload.analysis_complete === true).length)], ['Learner permission', esc(context.learner_permission)],
  ]) + (observed.environment !== 'UNKNOWN' && context.expected_environment !== observed.environment ? `<p class='form-error'>Observed source does not match the declared environment.</p>` : '') + section('Pinned run context', `<pre>${esc(JSON.stringify(context, null, 2))}</pre>`) + section('Completion and coverage', completion ? `<pre>${esc(JSON.stringify(completion, null, 2))}</pre>` : empty('No completion receipt recorded.')) + section('Run history', timeline(data.events));
}
function caseProgress(data) {
  const phases = [['Research', ['DISCOVERY','EVIDENCE','RESEARCH']], ['Human review', ['DEVELOPMENT_REVIEW','DEVELOPMENT_HANDOFF']], ['Development', ['CANDIDATE_DEVELOPMENT']], ['Historical tests', ['HISTORICAL_VALIDATION']], ['Evaluation', ['CANDIDATE_EVALUATION','SHADOW_REVIEW','SHADOW_HANDOFF']], ['Shadow forward', ['FORWARD_VALIDATION','FORWARD_EVALUATION']], ['Deployment review', ['DEPLOYMENT_REVIEW','DEPLOYMENT_HANDOFF','ROLLBACK_REVIEW','ROLLBACK_HANDOFF']], ['Observation', ['POST_DEPLOYMENT_VALIDATION']], ['Retrospective', ['RETROSPECTIVE','CLOSED']]];
  const visited = data.history.map(event => event.payload?.after?.stage).filter(Boolean);
  return `<ol class='step-track' aria-label='Case progress'>${phases.map(([name, stages]) => `<li class='${stages.includes(data.stage) ? 'current' : stages.some(stage => visited.includes(stage)) ? 'complete' : ''}' ${stages.includes(data.stage) ? "aria-current='step'" : ''}>${esc(name)}</li>`).join('')}</ol>`;
}
function handoffList(data) {
  return data.handoffs.length ? data.handoffs.map(handoff => `<div class='list-row'><div class='row-head'><strong>${esc(human(handoff.gate))} / ${esc(handoff.recipient_id)}</strong>${badge(handoff.state)}</div><p class='subline'>${esc(handoff.handoff_id)}</p>${handoff.delivery_error || handoff.blocked_reason ? `<p class='form-error'>${esc(human(handoff.delivery_error || handoff.blocked_reason))}</p>` : ''}<div class='actions'>${button('view-handoff', 'View approved MD', `data-id='${esc(handoff.handoff_id)}'`)}${button('download-handoff', 'Download', `data-id='${esc(handoff.handoff_id)}'`, 'download')}${button('copy-handoff', 'Copy instruction', `data-id='${esc(handoff.handoff_id)}'`, 'copy')}${handoff.state === 'READY' ? button('send-handoff', 'Mark sent', `data-id='${esc(handoff.handoff_id)}'`) : ''}${['FAILED','BLOCKED','CREATED'].includes(handoff.state) ? button('retry-handoff', handoff.state === 'CREATED' ? 'Prepare delivery' : 'Retry delivery', `data-id='${esc(handoff.handoff_id)}'`) : ''}${handoff.state === 'DISPATCHED' ? button('manual-confirmation', 'Record manual confirmation', `data-id='${esc(handoff.handoff_id)}'`) : ''}</div>${handoff.result_artifact_id ? `<p>${link('artifacts', handoff.result_artifact_id, 'Returned result')}</p>` : ''}</div>`).join('') : empty('No handoff registered.');
}
function casePage(data) {
  const executable = !['PAUSED','FAILED','BLOCKED','CANCELLED'].includes(data.work_status) && data.stage !== 'CLOSED';
  const statusControl = ['PAUSED','FAILED','BLOCKED'].includes(data.work_status) ? button('resume', data.work_status === 'PAUSED' ? 'Resume' : 'Retry', '', 'play') : executable ? button('pause', 'Pause', '', 'pause') : '';
  const prepare = data.approvals.find(row => row.state === 'APPROVED' && row.decision?.current_test_authority && ['DEVELOPMENT','SHADOW','PRODUCTION','ROLLBACK'].includes(row.gate) && !data.handoffs.some(handoff => handoff.decision_id === row.decision.decision.decision_id));
  return heading(data.case_id, data.strategy_name, badge(data.work_status) + statusControl + (executable ? button('upload', 'Upload result', '', 'upload') : '')) + facts([
    ['Stage', esc(human(data.stage))], ['Owner', esc(data.owner_id)], ['Waiting on', esc(data.waiting_on || 'Stage prerequisites')], ['Next action', esc(data.next_action)], ['Strategy', link('strategies', data.strategy_id, data.strategy_name)], ['Run', link('runs', data.run_id)], ['Baseline', hash(data.baseline_hash)], ['Candidate', data.candidate_hash ? hash(data.candidate_hash) : 'None registered'], ['Priority', esc(data.priority ? human(data.priority) : 'Not assigned')],
  ]) + caseProgress(data) + (data.blockers.length ? section('Blockers', table(['Owner', 'Required action', 'State'], data.blockers.map(row => [esc(row.owner_id), esc(row.action), badge(row.state)]))) : '') + `<div class='columns'><div>${section('Approvals', approvalTable(data.approvals))}${prepare ? `<div class='actions'>${button('prepare-handoff', 'Prepare approved handoff', `data-request='${esc(prepare.request_id)}'`)}</div>` : ''}${section('Evidence and results', table(['Artifact', 'Producer / recipient', 'Created', 'Availability'], data.artifacts.map(row => [link('artifacts', row.artifact_id, human(row.kind)) + `<div class='subline'>${esc(row.artifact_id)}</div>`, `${esc(row.producer_id)}<div class='subline'>To ${esc(row.recipient_id)}</div>`, esc(date(row.manifest.created_at_utc)), badge(row.manifest.availability)])), `<span class='muted'>${data.artifacts_total} immutable artifacts</span>`)}${section('Historical validation', table(['Test', 'Result', 'Report'], (data.tasks.length ? data.tasks : ['BACKTEST','ROBUSTNESS','WALK_FORWARD','OOS_HOLDOUT'].map(kind => ({ kind, status: 'NOT_PLANNED', artifact_id: null }))).map(task => [esc(human(task.kind)), badge(task.status), task.artifact_id ? link('artifacts', task.artifact_id, 'View report') : 'Not recorded'])))}${section('Handoffs', handoffList(data))}${data.outbox.length ? section('Pending sync', table(['Recipient','Delivery','Attempts','Error','Action'], data.outbox.map(row => [esc(row.recipient_id),badge(row.state),String(row.attempts),row.last_error ? esc(row.last_error) : 'None', ['FAILED','DEAD_LETTER'].includes(row.state) ? button('retry-outbox','Retry',`data-id='${esc(row.id)}'`) : '']))) : ''}</div><div>${section('Timeline', timeline(data.history))}</div></div>`;
}
function approvalPage(data) {
  const snapshot = data.snapshot;
  return heading(`${human(data.gate)} review`, data.strategy_name, badge(data.state)) + facts([
    ['Case', link('cases', data.case_id)], ['Instance', esc(data.execution_instance_id)], ['Recipient', esc(snapshot.recipient_id)], ['Permitted tests', esc(snapshot.authorized_tests.join(', '))], ['Baseline hash', hash(snapshot.baseline_hash)], ['Candidate hash', hash(snapshot.candidate_hash)], ['Evidence', link('artifacts', snapshot.artifact_id, 'View immutable snapshot')], ['Snapshot hash', hash(data.snapshot_hash)], ['Expires', esc(date(data.expires_at_utc))],
  ]) + (data.actionable ? `<div class='section-heading'><h2>Decision</h2></div><div class='actions'>${button('decision', `Approve ${human(data.gate)}`, "class='primary' data-decision='APPROVED'", 'check')}${button('decision','Reject',"class='danger' data-decision='REJECTED'")}${button('decision','Request more evidence',"data-decision='MORE_EVIDENCE'")}</div>` : `<p class='muted'>${esc(data.state === 'PENDING' ? human(data.blocked_reason) : 'Decision recorded')}</p>`) + (data.decision ? section('Recorded decision', facts([['Decision', badge(data.decision.decision.decision)], ['Recorded by', esc(data.decision.decision.decided_by)], ['Recorded at', esc(date(data.decision.decision.decided_at_utc))], ['Reason', esc(data.decision.decision.reason)], ['Current TEST authority', data.decision.current_test_authority ? 'Current' : esc(human(data.decision.blocked_reason))], ['Operational activation', 'Disabled']])) : '') + section('Immutable approval scope', `<pre>${esc(JSON.stringify(snapshot, null, 2))}</pre>`);
}
function collectionPage(view, data) {
  let items = data.items;
  if (state.filter) items = items.filter(item => JSON.stringify(item).toLowerCase().includes(state.filter.toLowerCase()));
  const titles = { strategies:'Strategies', cases:'Cases', runs:'Runs', approvals:'Approvals', history:'History' };
  const rows = view === 'strategies' ? table(['Strategy', 'Onboarding', 'Paper baseline', 'Profile', 'Cases'], items.map(row => [link('strategies', row.strategy_id, row.strategy_name) + `<div class='subline'>${esc(row.strategy_id)}</div>`, badge(row.activation_status), esc(row.baseline_version), `${esc(row.profile.profile_id)} / ${esc(row.profile.profile_version)}`, String(row.cases_total)])) : view === 'cases' ? caseTable(items) : view === 'runs' ? runTable(items) : view === 'approvals' ? approvalTable(items) : timeline(items);
  const setup = view === 'history' && data.setup?.length ? `<details class='access-help' id='setup-history'><summary>Installation receipts (${data.setup.length})</summary>${table(['Task','Result','Project','Operator'],data.setup.map(row=>[esc(row.task_id),badge(row.status),esc(row.project),esc(row.operator_id)]))}<p class='muted'>Historical installation records. Not strategy approvals.</p></details>` : '';
  return heading(titles[view], `${data.total} records`, view === 'runs' ? button('prepare-run','Prepare run','', 'plus') : '') + `<div class='toolbar'><label for='filter'>Filter this page</label><input type='search' id='filter' value='${state.filter ? esc(state.filter) : ''}' autocomplete='off'></div>${setup}${rows}${pager(data)}`;
}
async function renderArtifact(data, generation) {
  const response = await request(`artifacts/${route().key}/download`, { binary:true });
  const buffer = await response.arrayBuffer();
  if (generation !== state.generation) return;
  const actualHash = `sha256:${[...new Uint8Array(await crypto.subtle.digest('SHA-256', buffer))].map(value => value.toString(16).padStart(2,'0')).join('')}`;
  if (actualHash !== data.manifest.content_hash) throw Object.assign(new Error(), { code:'ARTIFACT_HASH_MISMATCH' });
  let body;
  if (data.manifest.media_type === 'image/png') { const url = URL.createObjectURL(new Blob([buffer], { type:'image/png' })); state.imageUrls.push(url); body = `<img class='artifact-image' src='${url}' alt='Registered evidence ${esc(data.manifest.artifact_id)}'>`; }
  else body = `<pre>${esc(new TextDecoder().decode(buffer))}</pre>`;
  return heading(data.manifest.artifact_id, 'Immutable evidence', button('download-artifact','Download evidence','', 'download')) + facts([['Producer',esc(data.manifest.producer_id)], ['Strategy',link('strategies',data.manifest.strategy_id)], ['Run',link('runs',data.manifest.run_id)], ['Created',esc(date(data.manifest.created_at_utc))], ['Content hash',hash(data.manifest.content_hash)], ['Media / bytes',`${esc(data.manifest.media_type)} / ${data.manifest.bytes}`]]) + section('Evidence', body);
}
async function refresh(force = false) {
  clearTimeout(state.timer);
  if (state.mutation && !force) return schedule();
  if (state.controller && !force) return;
  if (state.controller) state.controller.abort();
  const generation = ++state.generation;
  const controller = new AbortController(); state.controller = controller;
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const session = await request('session', { signal:controller.signal });
    if (!state.csrf) { signIn(); return; }
    state.signedIn = true; document.querySelector('#logout').hidden = false;
    const current = route();
    const endpoint = current.view === 'artifacts' ? `artifacts/${current.key}` : `view/${current.view}${current.key ? `/${current.key}` : current.view === 'dashboard' ? '' : `/page/${state.offset}`}`;
    const [data, dashboard] = await Promise.all([request(endpoint, { signal:controller.signal }), current.view === 'dashboard' ? Promise.resolve(null) : request('view/dashboard', { signal:controller.signal })]);
    if (generation !== state.generation) return;
    const count = (dashboard || data).counts?.action_required || 0;
    const countElement = document.querySelector('#approval-badge'); countElement.textContent = String(count); countElement.hidden = count === 0;
    state.lastSuccess = new Date(); freshness.textContent = `Updated ${state.lastSuccess.toLocaleTimeString('en-GB', { timeZone:'Europe/London' })} UK`;
    if (state.connectionError) { showNotice(''); state.connectionError = false; }
    state.data = data; state.sessionExpiry = session.expires_at_utc;
    const fingerprint = JSON.stringify(data, (key,value) => key === 'refreshed_at_utc' ? undefined : value);
    if (!modal.open && (force || fingerprint !== state.fingerprint)) {
      const focused = document.activeElement?.id; const selection = focused === 'filter' ? document.activeElement.selectionStart : null;
      for (const url of state.imageUrls) URL.revokeObjectURL(url); state.imageUrls = [];
      const html = current.view === 'dashboard' ? overview(data) : current.view === 'artifacts' ? await renderArtifact(data,generation) : !current.key ? collectionPage(current.view,data) : ({ strategies:strategyPage, cases:casePage, runs:runPage, approvals:approvalPage })[current.view]?.(data);
      if (generation !== state.generation || html === undefined) return;
      content.innerHTML = html; renderIcons(); state.fingerprint = fingerprint;
      if (focused && document.getElementById(focused)) { document.getElementById(focused).focus(); if (selection !== null) document.getElementById(focused).setSelectionRange?.(selection,selection); }
      document.title = `${content.querySelector('h1')?.textContent || 'Continuous Improvement'} | Ocean Trading`;
    }
    if (modal.open && modal.dataset.request && data.request_id === modal.dataset.request && (data.case_revision !== Number(modal.dataset.revision) || !data.actionable)) {
      modal.querySelector('[type=submit]').disabled = true; modal.querySelector('.form-error').textContent = 'This review changed. Close it and review the latest version.';
    }
    content.setAttribute('aria-busy','false');
    document.querySelectorAll('[data-view]').forEach(anchor => { if (anchor.dataset.view === current.view) anchor.setAttribute('aria-current','page'); else anchor.removeAttribute('aria-current'); });
  } catch (error) {
    if (generation !== state.generation) return;
    if (error.status === 401 || ['WAYNE_LOCAL_ENROLLMENT_REQUIRED','WORKFLOW_CONFIG_BLOCKED','WORKFLOW_DISABLED'].includes(error.code)) signIn(errorText(error));
    else {
      state.connectionError = true;
      showNotice(errorText(error)); freshness.textContent = state.lastSuccess ? `Refresh failed; last success ${date(state.lastSuccess.toISOString())}` : 'Not connected';
      if (!state.data) content.innerHTML = heading('Continuous Improvement') + empty(errorText(error)) + '<a class="button" href="/">Trading dashboard</a>';
      content.setAttribute('aria-busy','false');
    }
  } finally { clearTimeout(timeout); if (state.controller === controller) state.controller = null; schedule(); }
}
function schedule() { clearTimeout(state.timer); if (!state.signedIn) return; state.timer = setTimeout(() => { if (!document.hidden) void refresh(); else schedule(); },5000); }
function openModal(title,body,submitLabel,submit) {
  modal.dataset.request = ''; modal.dataset.revision = '';
  document.querySelector('#modal-body').innerHTML = `<form id='modal-form'><div class='page-heading'><h2 id='modal-title'>${esc(title)}</h2><button type='button' class='icon' data-action='close-modal' aria-label='Close' title='Close'>${icon('x')}</button></div>${body}<p class='form-error' role='alert'></p><div class='footer'><button type='button' data-action='close-modal'>Close</button>${submit ? `<button type='submit' class='primary'>${esc(submitLabel)}</button>` : ''}</div></form>`;
  if (submit) document.querySelector('#modal-form').addEventListener('submit', async event => {
    event.preventDefault(); if (state.mutation) return;
    const form = event.currentTarget; const submitButton = form.querySelector('[type=submit]'); submitButton.disabled = true; state.mutation = true;
    try { await submit(form); modal.close(); state.fingerprint = null; await refresh(true); }
    catch (error) { if (error.status === 401 || ['WAYNE_LOCAL_ENROLLMENT_REQUIRED','WORKFLOW_CONFIG_BLOCKED','WORKFLOW_DISABLED'].includes(error.code)) signIn(errorText(error)); else { form.querySelector('.form-error').textContent = errorText(error); submitButton.disabled = ['REVISION_CONFLICT','APPROVAL_REQUEST_STALE_OR_MISMATCH','BLOCKED_RECONCILIATION'].includes(error.code); } }
    finally { state.mutation = false; schedule(); }
  });
  renderIcons(); modal.showModal();
}
async function download(path,filename) {
  const response = await request(path,{ binary:true }); const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click(); setTimeout(() => URL.revokeObjectURL(url),1000);
}
function decisionDialog(action) {
  const data = structuredClone(state.data); const snapshot = data.snapshot; const message = newId('decision-message'); const decisionId = newId('decision');
  openModal(`${human(action)}: ${human(data.gate)}`,facts([['Case',esc(data.case_id)], ['Recipient',esc(snapshot.recipient_id)], ['Baseline',hash(snapshot.baseline_hash)], ['Snapshot',hash(data.snapshot_hash)], ['Permitted tests',esc(snapshot.authorized_tests.join(', '))], ['Expires',esc(date(data.expires_at_utc))]]) + `<div class='field'><label for='decision-reason'>Reason</label><textarea id='decision-reason' required maxlength='2000'></textarea></div><label class='check-line'><input type='checkbox' required id='confirm-scope'>I confirm this ${esc(human(data.gate))} decision for the displayed TEST scope.</label>`,'Record decision',async form => {
    await post('decisions',{ decision_id:decisionId,request_id:data.request_id,case_id:data.case_id,expected_revision:data.case_revision,snapshot_hash:data.snapshot_hash,decision:action,reason:form.querySelector('#decision-reason').value },message);
    showNotice('Decision recorded. The case remains open.');
  });
  modal.dataset.request = data.request_id; modal.dataset.revision = String(data.case_revision);
}
function uploadDialog() {
  const data = structuredClone(state.data);
  let attempt = null;
  const types = ['EVIDENCE','RECOMMENDATION','CANDIDATE','BACKTEST','ROBUSTNESS','WALK_FORWARD','OOS_HOLDOUT','EVALUATION','FORWARD_RESULT','FORWARD_EVALUATION','DEPLOYMENT_PLAN','ROLLBACK_PLAN','VALIDATION_REPORT','OUTCOME','LESSON','NO_BENEFIT'];
  openModal('Upload evidence or result',`<div class='field'><label for='upload-kind'>Artifact type</label><select id='upload-kind'>${types.map(kind => `<option value='${kind}'>${esc(human(kind))}</option>`).join('')}</select></div><div class='field'><label for='upload-recipient'>Intended recipient</label><select id='upload-recipient'>${data.recipients.map(value => `<option value='${esc(value.identity_id)}'>${esc(value.identity_id)} (${esc(value.role)})</option>`).join('')}</select></div><div class='field'><label for='upload-file'>Result file</label><input type='file' id='upload-file' accept='.md,.txt,.json,.png' required><small>Markdown, text, JSON or PNG; maximum 128 KiB.</small></div><div class='field'><label for='upload-candidate'>Candidate hash</label><input id='upload-candidate' value='${data.candidate_hash ? esc(data.candidate_hash) : ''}' placeholder='sha256:...'></div><div class='field'><label for='upload-dependencies'>Dependency artifacts</label><select multiple id='upload-dependencies'>${data.artifacts.map(value => `<option value='${esc(value.artifact_id)}'>${esc(human(value.kind))} / ${esc(value.artifact_id)}</option>`).join('')}</select></div><label class='check-line'><input type='checkbox' id='record-test'>Record the JSON historical test outcome on this case</label><p class='muted'>Producer: Wayne. Recipient acceptance remains separately recorded.</p>`,'Register immutable artifact',async form => {
    const file = form.querySelector('#upload-file').files[0];
    if (!file || file.size > 128 * 1024) throw Object.assign(new Error(),{ code:'UNSAFE_ARTIFACT_TYPE_OR_SIZE' });
    const media = { md:'text/markdown',txt:'text/plain',json:'application/json',png:'image/png' }[file.name.split('.').pop().toLowerCase()];
    if (!media) throw Object.assign(new Error(),{ code:'UNSAFE_ARTIFACT_TYPE_OR_SIZE' });
    const buffer = await file.arrayBuffer(); const contentHash = `sha256:${[...new Uint8Array(await crypto.subtle.digest('SHA-256',buffer))].map(value => value.toString(16).padStart(2,'0')).join('')}`;
    const fileContent = media === 'image/png' ? btoa(Array.from(new Uint8Array(buffer),value => String.fromCharCode(value)).join('')) : new TextDecoder('utf-8',{ fatal:true }).decode(buffer);
    const kind = form.querySelector('#upload-kind').value;
    const binding = JSON.stringify({contentHash,media,kind,recipient:form.querySelector('#upload-recipient').value,candidate:form.querySelector('#upload-candidate').value,dependencies:Array.from(form.querySelector('#upload-dependencies').selectedOptions,option=>option.value)});
    if (!attempt || attempt.binding !== binding) attempt = {binding,artifactId:newId('artifact'),messageId:newId('upload-message')};
    const artifactId = attempt.artifactId;
    let outcome = null;
    if (form.querySelector('#record-test').checked) {
      if (media !== 'application/json' || !['BACKTEST','ROBUSTNESS','WALK_FORWARD','OOS_HOLDOUT'].includes(kind) || data.stage !== 'HISTORICAL_VALIDATION') throw Object.assign(new Error(),{ code:'INVALID_SUBTEST_STATE' });
      outcome = JSON.parse(fileContent).status;
      if (!['PASS','FAIL','NOT_RUN','BLOCKED','NOT_APPLICABLE'].includes(outcome)) throw Object.assign(new Error(),{ code:'INVALID_SUBTEST_STATE' });
    }
    await post('artifacts',{ artifact_id:artifactId,case_id:data.case_id,run_id:data.run_id,recipient_id:form.querySelector('#upload-recipient').value,kind,media_type:media,content:fileContent,content_encoding:media === 'image/png' ? 'base64' : 'utf8',content_hash:contentHash,candidate_hash:form.querySelector('#upload-candidate').value || null,dependency_ids:Array.from(form.querySelector('#upload-dependencies').selectedOptions,option => option.value) },attempt.messageId);
    if (outcome) { try { await post('tasks',{ case_id:data.case_id,expected_revision:data.revision,kind,status:outcome,artifact_id:artifactId }); } catch (error) { showNotice(`Artifact ${artifactId} was registered; the test outcome needs review: ${errorText(error)}`); return; } }
    showNotice(`Registered ${human(kind)} from Wayne.`);
  });
}
async function act(action,element) {
  if(action==='prepare-run')return openRunWizard({modal,request,post,esc,human,renderIcons,errorText,strategyId:route().view==='strategies'?route().key:null,onPrepared:async result=>{history.pushState({},'',`/improvement/runs/${result.run_id}`);state.data=null;state.fingerprint=null;showNotice('Run reserved as READY. Sierra has not been started.');await refresh(true);}});
  if(action==='end-run')return openModal('End run','<div class="field"><label for="run-outcome">Outcome</label><select id="run-outcome"><option value="COMPLETED">Complete after drain</option><option value="CANCELLED">Cancel with partial coverage</option><option value="FAILED">Failed with partial coverage</option></select></div>','Begin drain',async()=>{await post('run-manager/end',{run_id:state.data.context.run_id,expected_revision:state.data.revision,outcome:document.querySelector('#run-outcome').value});});
  if (action === 'close-modal') { modal.close(); return; }
  if (action === 'decision') { decisionDialog(element.dataset.decision); return; }
  if (action === 'upload') { uploadDialog(); return; }
  if (action === 'next' || action === 'previous') { state.offset = Math.max(0,state.offset + (action === 'next' ? 50 : -50)); state.filter = ''; await refresh(true); return; }
  if (action === 'download-artifact') { await download(`artifacts/${route().key}/download`,`${route().key}.${state.data.manifest.media_type === 'image/png' ? 'png' : 'txt'}`); return; }
  if (['view-handoff','download-handoff','copy-handoff'].includes(action)) {
    const handoff = await request(`handoffs/${element.dataset.id}`);
    if (action === 'view-handoff') openModal('Approved handoff',`<pre>${esc(handoff.instruction_md)}</pre>`);
    if (action === 'download-handoff') await download(`handoffs/${element.dataset.id}/download`,`${element.dataset.id}.md`);
    if (action === 'copy-handoff') { await navigator.clipboard.writeText(handoff.instruction_md); showNotice('Approved instruction copied.'); }
    return;
  }
  const data = structuredClone(state.data);
  if (action === 'manual-confirmation') {
    const handoff = data.handoffs.find(row => row.handoff_id === element.dataset.id);
    openModal('Record manual confirmation',`<p>Recipient: <strong>${esc(handoff.recipient_id)}</strong></p><p class='muted'>This records Wayne's report. Authenticated recipient acknowledgement remains pending.</p><div class='field'><label for='confirmation-note'>Confirmation evidence</label><textarea id='confirmation-note' required maxlength='1000'></textarea></div>`,'Record manual report',async form => post('handoff-confirmations',{ handoff_id:handoff.handoff_id,expected_revision:handoff.revision,note:form.querySelector('#confirmation-note').value })); return;
  }
  if (action === 'prepare-handoff') {
    const approval = data.approvals.find(row => row.request_id === element.dataset.request);
    openModal('Prepare approved handoff',facts([['Gate',esc(human(approval.gate))], ['Recipient',esc(approval.snapshot.recipient_id)], ['Decision',esc(approval.decision.decision.decision_id)]]) + `<div class='field'><label for='handoff-test'>Authorised test</label><select id='handoff-test'>${approval.snapshot.authorized_tests.map(value => `<option>${esc(value)}</option>`).join('')}</select></div>`,'Prepare handoff',async form => {
      const stage = { DEVELOPMENT:'DEVELOPMENT_HANDOFF',SHADOW:'SHADOW_HANDOFF',PRODUCTION:'DEPLOYMENT_HANDOFF',ROLLBACK:'ROLLBACK_HANDOFF' }[approval.gate];
      if (data.stage !== stage) await post('transitions',{ case_id:data.case_id,expected_revision:data.revision,action:'advance',to_stage:stage,decision_id:approval.decision.decision.decision_id });
      const handoff = await post('handoffs',{ handoff_id:newId('handoff'),case_id:data.case_id,decision_id:approval.decision.decision.decision_id,gate:approval.gate,recipient_id:approval.snapshot.recipient_id,authorized_test:form.querySelector('#handoff-test').value });
      await post('handoff-events',{ handoff_id:handoff.handoff_id,expected_revision:handoff.revision,state:'READY' });
    }); return;
  }
  if (state.mutation) return;
  state.mutation = true; element.disabled = true;
  try {
    if (['pause','resume'].includes(action)) await post('transitions',{ case_id:data.case_id,expected_revision:data.revision,action:action === 'resume' && data.work_status !== 'PAUSED' ? 'retry' : action });
    else if (action === 'retry-outbox') await post('outbox/retry',{ outbox_id:element.dataset.id });
    else if (['send-handoff','retry-handoff'].includes(action)) { const handoff = data.handoffs.find(row => row.handoff_id === element.dataset.id); await post('handoff-events',{ handoff_id:handoff.handoff_id,expected_revision:handoff.revision,state:action === 'send-handoff' ? 'DISPATCHED' : 'READY' }); }
    showNotice('Workflow record updated.'); await refresh(true);
  } finally { state.mutation = false; element.disabled = false; schedule(); }
}
document.addEventListener('click',event => {
  const action = event.target.closest('[data-action]');
  if (action) { event.preventDefault(); void act(action.dataset.action,action).catch(error => { if (error.status === 401 || ['WAYNE_LOCAL_ENROLLMENT_REQUIRED','WORKFLOW_CONFIG_BLOCKED','WORKFLOW_DISABLED'].includes(error.code)) signIn(errorText(error)); else showNotice(errorText(error)); }); return; }
  const anchor = event.target.closest('a[href^="/improvement/"]');
  if (!anchor || event.ctrlKey || event.metaKey || event.shiftKey || event.button !== 0) return;
  event.preventDefault(); history.pushState({},'',anchor.getAttribute('href')); state.offset = 0; state.filter = ''; state.data = null; state.fingerprint = null; showNotice('');
  content.setAttribute('aria-busy','true'); content.innerHTML = empty('Loading workflow data...'); void refresh(true); content.focus();
});
document.addEventListener('input',event => {
  if (event.target.id === 'filter') { state.filter = event.target.value.trimStart(); const selection = event.target.selectionStart; content.innerHTML = collectionPage(route().view,state.data); renderIcons(); const input = document.querySelector('#filter'); input.value = state.filter; input.focus(); input.setSelectionRange?.(selection,selection); }
});
modal.addEventListener('close',() => { document.querySelector('#modal-body').replaceChildren(); state.fingerprint = null; if (state.signedIn && !state.mutation) void refresh(true); });
document.querySelector('#refresh').addEventListener('click',() => { showNotice(''); void refresh(true); });
document.querySelector('#logout').addEventListener('click',async () => {
  try { await request('session/logout',{ method:'POST',headers:{ 'Content-Type':'application/json','X-CSRF-Token':state.csrf || '' },body:'{}' }); signIn('Signed out.'); } catch(error) { showNotice(errorText(error)); }
});
window.addEventListener('popstate',() => { state.offset = 0; state.filter = ''; state.data = null; state.fingerprint = null; void refresh(true); });
document.addEventListener('visibilitychange',() => { if (!document.hidden) void refresh(true); });
renderIcons(); void refresh(true);
