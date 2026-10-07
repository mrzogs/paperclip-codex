import { renderIcons } from './icons.js';
import { openRunWizard } from './run-wizard.js?v=contract-aware-history-20261001-1';
import { ONBOARDING_HELP } from './onboarding-help.js?v=simple-onboarding-20260930-1';
import { buildReprocessRunId } from './reprocess-identity.js?v=repeat-safe-20261006-1';

const content = document.querySelector('#content');
const modal = document.querySelector('#modal');
const notice = document.querySelector('#notice');
const freshness = document.querySelector('#freshness');
const csrfKey = 'ocean-workflow-human-csrf';
const replayMonitorOpenedKey = 'ocean-workflow-replay-monitor-opened';
const initialOnboardingQuestionnaire = new URLSearchParams(location.search).get('onboarding');
const state = { csrf: sessionStorage.getItem(csrfKey), signedIn: false, data: null, offset: 0, filter: '', lastSuccess: null, timer: null, controller: null, generation: 0, fingerprint: null, mutation: false, imageUrls: [], onboardingMode: Boolean(initialOnboardingQuestionnaire), onboardingQuestionnaire: initialOnboardingQuestionnaire, onboardingFormDrafts: {} };
const text = value => value === null || value === undefined || value === '' ? 'Not recorded' : String(value);
const esc = value => text(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const formEsc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const human = value => text(value).replaceAll('_', ' ').toLowerCase().replace(/^\w/, letter => letter.toUpperCase());
const date = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('en-GB', { timeZone: 'Europe/London', dateStyle: 'medium', timeStyle: 'short' }) + ' UK' : 'Not recorded';
const newId = prefix => `test-ui-${prefix}-${crypto.randomUUID()}`;
const operationalId = prefix => `${prefix}-${crypto.randomUUID()}`;
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
function onboardingHref(questionnaireId = null) {
  const url = new URL(location.href);
  if (questionnaireId) url.searchParams.set('onboarding', questionnaireId);
  else url.searchParams.delete('onboarding');
  return `${url.pathname}${url.search}${url.hash}`;
}
const onboardingLink = (questionnaireId, label, attrs = '', symbol = '') => `<a class='button' data-onboarding-native href='${esc(onboardingHref(questionnaireId))}' ${attrs}>${symbol ? icon(symbol) : ''}${esc(label)}</a>`;
const onboardingStatusLink = (label = 'Back to status', attrs = '', symbol = '') => `<a class='button' data-onboarding-native href='${esc(onboardingHref())}' ${attrs}>${symbol ? icon(symbol) : ''}${esc(label)}</a>`;

function showNotice(message) { notice.textContent = message; notice.hidden = !message; }
function errorText(error) {
  if (error.code === 'HUMAN_UNENROLLED') return 'Human access is not set up yet. Service authentication is separate.';
  if (error.code === 'HUMAN_ACCESS_UNAVAILABLE') return 'Human access needs recovery. Service authentication is separate.';
  const messages = { WAYNE_LOCAL_ENROLLMENT_REQUIRED: 'Local workflow access is not set up yet. Open Set up or recover access below.', WORKFLOW_DISABLED: 'Workflow setup is pending. The trading dashboard is available.', WORKFLOW_CONFIG_BLOCKED: 'Workflow configuration needs attention.', WORKFLOW_DATABASE_BUSY: 'Workflow data is briefly busy. Ocean will retry automatically.', WORKFLOW_REQUEST_TIMEOUT: 'The workflow response timed out. Refresh and try again; no action was confirmed.', SESSION_EXPIRED_OR_INVALID: 'Your session expired. Sign in again.', AUTHENTICATION_REQUIRED: 'Sign in to review workflow records.', REVISION_CONFLICT: 'This record changed. Refresh and review the latest version.', APPROVAL_REQUEST_STALE_OR_MISMATCH: 'This approval has changed or expired. Open the latest review.', BLOCKED_RECONCILIATION: 'The registered version changed. This case needs reconciliation.', CSRF_REJECTED: 'The browser session changed. Sign in again before submitting.', RECIPIENT_ACCEPTANCE_REQUIRED: 'Recipient acknowledgement must come from the recipient account.', ACTIVE_ARTIFACT_CONTENT_REJECTED: 'This file contains active content or private filesystem references.', UNSAFE_IMAGE_REJECTED: 'Use a single PNG up to 128 KiB and 2048 pixels per side, without embedded metadata.', ENTITY_NOT_FOUND: 'This record is unavailable.', UNKNOWN_VIEW: 'This page is unavailable.', ARTIFACT_STAGE_PREREQUISITE_REQUIRED: 'This result does not belong to the current case stage.', ONBOARDING_SOURCE_CHANGED: 'The onboarding source changed. Refresh before recording this answer.', ONBOARDING_SOURCE_INCOMPLETE: 'The onboarding source set is incomplete. Resolve the source status first.', PRIOR_QUESTIONNAIRE_REQUIRED: 'Complete the preceding onboarding question first.', SOURCE_BASELINE_INCOMPLETE: 'The source baseline is incomplete.', ONBOARDING_REQUIRED_FIELD: 'Complete every required onboarding field.', ONBOARDING_CONFIRMATION_REQUIRED: 'Confirm every required onboarding statement.', ONBOARDING_NUMBER_INVALID: 'One of the numeric answers is outside its permitted range.', ONBOARDING_TEXT_INVALID: 'One of the text answers is incomplete or invalid.', ONBOARDING_OPTION_INVALID: 'Select one of the permitted options.', ONBOARDING_REGISTRATION_NOT_READY: 'Registration is available after every questionnaire has been confirmed in the Obsidian Brain.', ONBOARDING_PROFILE_BASELINE_CONFLICT: 'The existing Ocean profile belongs to a different strategy version or source hash. Registration was not changed.', ONBOARDING_STRATEGY_BASELINE_CONFLICT: 'The existing Ocean strategy record does not match the reviewed onboarding source. Registration was not changed.', ONBOARDING_INSTANCE_BINDING_CONFLICT: 'The existing Sierra binding does not match the reviewed Replay instance. Registration was not changed.', ONBOARDING_REGISTRATION_BRAIN_SYNC_REQUIRED: 'Activation is available after the registration receipt is confirmed in the Obsidian Brain.', ONBOARDING_ACTIVATION_PREFLIGHT_REQUIRED: 'Complete every activation preflight reference.', ONBOARDING_CAPABILITY_NOT_APPROVED: 'This environment was not approved during onboarding.', LIVE_ACTIVATION_REQUIRES_PRODUCTION_PROMOTION: 'Live requires a separate production promotion and cannot be activated here.', ONBOARDING_BRAIN_RETRY_NOT_REQUIRED: 'This Brain record is already current or is retrying automatically.' };
  return messages[error.code] || `${human(error.code || 'CONNECTION_FAILED')}. The action was not confirmed.`;
}
async function request(path, options = {}) {
  const controller = options.signal ? null : new AbortController();
  const timer = controller ? setTimeout(() => controller.abort(), 12000) : null;
  try {
    const response = await fetch(`/api/workflow/${path}`, { credentials: 'same-origin', cache: 'no-store', ...options, signal: options.signal || controller.signal });
    if (!response.ok) { const payload = await response.json().catch(() => ({})); throw Object.assign(new Error(payload.error?.code || 'REQUEST_FAILED'), { code: payload.error?.code || 'REQUEST_FAILED', status: response.status }); }
    return options.binary ? response : await response.json();
  } catch (error) {
    if (error?.name === 'AbortError') throw Object.assign(new Error('WORKFLOW_REQUEST_TIMEOUT'), { code:'WORKFLOW_REQUEST_TIMEOUT', retryable:true });
    throw error;
  } finally { clearTimeout(timer); }
}
async function post(path, data, message = newId('message')) {
  return request(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrf || '' }, body: JSON.stringify({ message_id: message, data }) });
}
async function postOperational(path, data) {
  return request(`operational/v1/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrf || '' }, body: JSON.stringify(data) });
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
function helpFieldTable(fields) {
  return table(['Field', 'What it means', 'What to provide', 'Validation'], fields.map(item => [
    `<strong>${esc(item.label)}</strong><div class='subline'><code>${esc(item.key)}</code></div>`, esc(item.meaning), esc(item.provide), esc(item.validation),
  ]));
}
function onboardingHelpPage() {
  const questionnaires = new Map(ONBOARDING_HELP.questionnaires.map(item => [item.step_id, (ONBOARDING_HELP.questionnaires.filter(entry => entry.step_id === item.step_id))]));
  const stepBody = ONBOARDING_HELP.steps.map(step => {
    const forms = questionnaires.get(step.id) || [];
    const formHelp = forms.map(form => `<div class='help-question' id='${esc(form.id)}'><h3>${esc(form.title)}</h3><p>${esc(form.purpose)}</p>${helpFieldTable(form.fields)}</div>`).join('');
    return `<article class='help-step' id='${esc(step.id)}'><div class='help-step-heading'><span>Step ${step.number}</span><div><h2>${esc(step.label)}</h2><p>${esc(step.mode)}</p></div></div><dl class='help-step-summary'><div><dt>Purpose</dt><dd>${esc(step.purpose)}</dd></div><div><dt>What you provide</dt><dd>${esc(step.input)}</dd></div><div><dt>Complete when</dt><dd>${esc(step.complete)}</dd></div></dl>${formHelp}</article>`;
  }).join('');
  const index = ONBOARDING_HELP.steps.map(step => `<li><a href='#${esc(step.id)}'><span>${step.number}</span>${esc(step.label)}</a></li>`).join('');
  return heading('Onboarding help', 'Simple strategy setup and testing guide', `<a class='button' href='/improvement/strategies'>${icon('chevron-left')}Back to strategies</a>`)
    + `<div class='help-lead'><strong>Set up once, then build evidence.</strong><p>Ocean reads the strategy and Sierra configuration directly. You confirm the detected non-live setup once, build history in Replay, forward test in Paper, and make a separate human decision before Live. Completed test periods with trades or no trades both form part of the strategy evidence.</p></div>`
    + `<div class='help-layout'><nav class='help-index' aria-label='Onboarding help topics'><h2>On this page</h2><ol>${index}</ol><a href='#submission-record'>Confirmation record</a><a href='#registration-fields'>Replay preparation</a><a href='#lifecycle-fields'>Testing journey</a></nav><div class='help-content'>${stepBody}`
    + `<article class='help-step' id='submission-record'><div class='help-step-heading'><span>Receipt</span><div><h2>Submission record</h2><p>Fields shown beside every questionnaire</p></div></div><p>These values are generated by Ocean and bind the submitted answers to the reviewed source state.</p>${helpFieldTable(ONBOARDING_HELP.submission_record)}</article>`
    + `<article class='help-step' id='registration-fields'><div class='help-step-heading'><span>Prepare</span><div><h2>Replay preparation</h2><p>Automatic technical recording after confirmation</p></div></div><p>Ocean records the verified setup and makes the strategy available for Replay. It does not start Sierra, place trades, or grant Live authority.</p>${helpFieldTable(ONBOARDING_HELP.registration_fields)}</article>`
    + `<article class='help-step' id='lifecycle-fields'><div class='help-step-heading'><span>Test</span><div><h2>Testing and learning journey</h2><p>Replay, Paper, then explicit Live approval</p></div></div><p>The journey is separate from onboarding. Sierra runtime state never reverses onboarding. Evidence is collected only for prepared runs with connected telemetry, and Live always needs a separate human decision.</p>${helpFieldTable(ONBOARDING_HELP.lifecycle_fields)}</article>`
    + `</div></div>`;
}
function caseTable(items) {
  return table(['Case / strategy', 'Stage', 'Owner', 'Work status', 'Next action'], items.map(row => [link('cases', row.case_id) + `<div class='subline'>${esc(row.strategy_name)}</div>`, esc(human(row.stage)), esc(row.owner_id), badge(row.work_status), esc(row.next_action || row.waiting_on || 'Stage prerequisites')]));
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
function operationalReleaseTable(items) {
  return table(['Dataset release', 'Instance', 'State', 'Expires', 'Action'], items.map(row => {
    const review=row.review,context=review.context;
    const action=row.state==='PENDING'?button('operational-release-review','Review',`data-request='${esc(row.request_id)}'`):row.state==='APPROVED'?button('operational-release-apply','Apply release',`data-request='${esc(row.request_id)}'`):row.state==='RELEASED'&&!row.run_state?button('operational-run-review','Prepare run',`data-request='${esc(row.request_id)}'`):row.run_state?badge(row.run_state):'';
    return [`${esc(context.dataset_manifest_id)} / r${esc(context.dataset_manifest_revision)}<div class='subline'>${hash(review.manifest_hash)}</div>`,esc(context.execution_instance_id),badge(row.state),esc(date(review.expires_at_utc)),action];
  }));
}
function timeline(items) {
  if (!items.length) return empty('No history recorded.');
  return `<ol class='timeline'>${items.map(event => `<li><span class='timestamp'>${esc(date(event.created_at_utc))}</span><p><strong>${esc(human(event.action.replaceAll('.', ' ')))}</strong> <span class='muted'>${esc(event.entity_id)}</span></p><p>${esc(event.actor_id)} <span class='muted'>${esc(event.actor_role)}</span></p>${event.payload?.reason || event.payload?.note ? `<p>${esc(event.payload.reason || event.payload.note)}</p>` : ''}<details><summary>Recorded details</summary><pre>${esc(JSON.stringify(event.payload, null, 2))}</pre></details></li>`).join('')}</ol>`;
}
function pager(data) {
  return `<div class='pager'><span>${data.total ? data.offset + 1 : 0}-${Math.min(data.offset + data.page_size, data.total)} of ${data.total}</span><span class='spacer'></span><button class='icon' data-action='previous' title='Previous page' aria-label='Previous page' ${data.offset === 0 ? 'disabled' : ''}>${icon('chevron-left')}</button><button class='icon' data-action='next' title='Next page' aria-label='Next page' ${data.offset + data.page_size >= data.total ? 'disabled' : ''}>${icon('chevron-right')}</button></div>`;
}
function overview(data) {
  const count = data.counts;
  const operations=data.operations;
  const operationsPanel=operations?section('Operations',facts([
    ['Execution',badge(operations.safety.execution)],['Ingestion',badge(operations.safety.normal_ingestion)],['Live real',badge(operations.safety.live_real)],
    ['Maintenance',badge(operations.readiness.maintenance)],['Identity capacity',`${operations.registry.used} / ${operations.registry.capacity}`],['Receipt registry',`${operations.receipts.registered} / ${operations.receipts.known_tasks}`],
    ['Pending delivery',String(operations.queues.pending)],['Repeated auth failures',String(operations.auth_failures.repeated.length)],['Automatic approval',badge(operations.safety.automatic_approval)],
  ])+table(['Service','Role / namespace','State','Version','Expiry','Renewal'],operations.services.map(row=>[esc(row.identity_id),`${esc(row.role)} / ${esc(row.namespace)}`,badge(row.state),String(row.credential_version),esc(date(row.expires_at_utc)),esc(row.renewal)])),`<span class='muted'>Credential values and references are never shown. ${operations.registry.remaining} identity slots remain; tombstones are retained.</span>`):'';
  return heading('Overview', 'Reviews, case progress and integration health') + `<div class='stats'>${[['Action required', count.action_required], ['Active cases', count.active_cases], ['Blocked / failed', count.blocked_cases], ['Active runs', count.active_runs], ['Pending sync', count.pending_sync]].map(([name, value], index) => `<div class='stat ${index === 0 || index === 2 ? 'attention' : ''}'><span>${esc(name)}</span><strong>${value}</strong></div>`).join('')}</div>${operationsPanel}${data.operational_releases?.length?section('Operational dataset release',operationalReleaseTable(data.operational_releases),'<a data-route href="/improvement/approvals">All approvals</a>'):''}<div class='columns'><div>${section('Awaiting decisions', approvalTable(data.pending), `<span class='muted'>${count.pending_gates} pending gates / ${count.urgent_reviews} urgent reviews</span>`)}${section('Current cases', caseTable(data.cases), '<a data-route href="/improvement/cases">All cases</a>')}</div><div>${section('Integration health', data.health.length ? data.health.map(row => `<div class='list-row'><div class='row-head'><strong>${esc(row.provider_id)}</strong>${badge(row.stale ? 'STALE' : row.status)}</div><p>${esc(row.instance_id)}</p><p>${esc(row.next_action)}</p><p class='muted'>${esc(row.next_owner)} / ${esc(date(row.observed_at_utc))}</p></div>`).join('') : empty('No provider observations recorded.'))}<p class='muted'>Local access ready. Dispatch and normal ingestion remain off.</p>${section('Recent history', timeline(data.history), '<a data-route href="/improvement/history">All history</a>')}</div></div>`;
}
function strategyPage(data) {
  if (data.onboarding) return strategyOnboardingPage(data);
  return heading(data.strategy_name, data.strategy_id, badge(data.activation_status) + button('prepare-run','Start New Run','', 'plus')) + facts([
    ['Onboarding', esc(human(data.activation_status))], ['Paper baseline', esc(data.baseline_version)], ['Production version', data.production_version ? esc(data.production_version) : 'None registered'],
    ['Profile', `${esc(data.profile.profile_id)} / ${esc(data.profile.profile_version)}`], ['Code hash', hash(data.baseline_hash)], ['Configuration hash', hash(data.profile.strategy_config_hash)],
  ]) + section('Execution instances', table(['Instance', 'Account', 'Capabilities', 'Version', 'Status'], data.instances.map(row => [esc(row.execution_instance_id), esc(row.account_alias), esc(row.capabilities.join(', ')), esc(row.version_binding), badge(row.status)]))) + section('Cases', caseTable(data.cases), `<span class='muted'>${data.cases_total} registered; each case has its own stage</span>`) + section('Runs and coverage', runTable(data.runs), `<span class='muted'>${data.runs_total} registered</span>`);
}
function onboardingField(questionnaire, field) {
  const localDraft = state.onboardingFormDrafts[questionnaire.id];
  const value = localDraft && Object.prototype.hasOwnProperty.call(localDraft, field.key)
    ? localDraft[field.key]
    : questionnaire.answers[field.key];
  const help = field.help ? `<small>${esc(field.help)}</small>` : '';
  const required = field.required || field.required_true || (field.required_when && questionnaire.answers[field.required_when.key] === field.required_when.value);
  if (field.type === 'readonly') return `<div class='field onboarding-readonly'><span>${esc(field.label)}</span><strong>${esc(value)}</strong></div>`;
  if (field.type === 'checkbox') return `<label class='check-line onboarding-check'><input name='${esc(field.key)}' type='checkbox' ${value === true ? 'checked' : ''} ${field.required_true ? 'required' : ''}><span>${esc(field.label)}</span></label>`;
  if (field.type === 'radio') return `<fieldset class='field onboarding-radio'><legend>${esc(field.label)}</legend><div>${field.options.map(entry => `<label><input type='radio' name='${esc(field.key)}' value='${esc(entry.value)}' ${value === entry.value ? 'checked' : ''} ${required ? 'required' : ''}><span>${esc(entry.label)}</span></label>`).join('')}</div>${help}</fieldset>`;
  const attributes = `${required ? 'required' : ''} ${field.min !== undefined ? `min='${field.min}'` : ''} ${field.max !== undefined ? `max='${field.max}'` : ''} ${field.min_length !== undefined ? `minlength='${field.min_length}'` : ''} ${field.max_length !== undefined ? `maxlength='${field.max_length}'` : ''} ${field.pattern ? `pattern='${esc(field.pattern)}'` : ''}`;
  if (field.type === 'select') return `<div class='field'><label for='onboarding-${esc(field.key)}'>${esc(field.label)}</label><select id='onboarding-${esc(field.key)}' name='${esc(field.key)}' ${attributes}><option value=''>Select</option>${field.options.map(entry => `<option value='${esc(entry.value)}' ${value === entry.value ? 'selected' : ''}>${esc(entry.label)}</option>`).join('')}</select>${help}</div>`;
  if (field.type === 'textarea') return `<div class='field'><label for='onboarding-${esc(field.key)}'>${esc(field.label)}</label><textarea id='onboarding-${esc(field.key)}' name='${esc(field.key)}' ${attributes}>${formEsc(value)}</textarea>${help}</div>`;
  return `<div class='field'><label for='onboarding-${esc(field.key)}'>${esc(field.label)}</label><input id='onboarding-${esc(field.key)}' name='${esc(field.key)}' type='${field.type === 'number' ? 'number' : 'text'}' value='${formEsc(value)}' ${attributes}>${help}</div>`;
}
function onboardingQuestionnaireFor(data) {
  const onboarding = data.onboarding;
  const requested = state.onboardingQuestionnaire;
  const selected = onboarding.questionnaires.find(item => item.id === state.onboardingQuestionnaire && !item.locked);
  const active = onboarding.questionnaires.find(item => item.id === onboarding.active_questionnaire_id && !item.locked);
  const fallback = onboarding.questionnaires.find(item => !item.locked);
  const questionnaire = selected || active || fallback || null;
  state.onboardingQuestionnaire = questionnaire?.id || null;
  if (questionnaire && requested && requested !== questionnaire.id) history.replaceState({}, '', onboardingHref(questionnaire.id));
  return questionnaire;
}
function onboardingQuestionForStep(onboarding, stepId) {
  const questions = onboarding.questionnaires.filter(item => item.step_id === stepId);
  return {
    available: questions.find(item => !item.locked && !item.status.startsWith('COMPLETE')) || questions.find(item => !item.locked) || null,
    first: questions[0] || null,
  };
}
function onboardingQuestionNavigation(onboarding, questionnaire, sameStep, questionIndex) {
  if (onboarding.questionnaires.length === 1) return '';
  const index = onboarding.questionnaires.findIndex(item => item.id === questionnaire.id);
  const previous = index > 0 ? onboarding.questionnaires[index - 1] : null;
  const next = index >= 0 ? onboarding.questionnaires[index + 1] || null : null;
  const complete = questionnaire.status.startsWith('COMPLETE');
  const previousLabel = previous?.step_id === questionnaire.step_id ? 'Previous question' : 'Previous step';
  const nextLabel = next?.step_id === questionnaire.step_id ? 'Next question' : 'Next step';
  const previousAction = previous
    ? onboardingLink(previous.id, previousLabel, `title='${esc(previous.title)}'`, 'chevron-left')
    : `<button disabled title='This is the first onboarding question'>${icon('chevron-left')}Previous question</button>`;
  const nextAction = !next
    ? onboardingStatusLink('View onboarding status', "class='primary'", 'check')
    : complete && !next.locked
      ? onboardingLink(next.id, nextLabel, `class='primary' title='${esc(next.title)}'`, 'chevron-right')
      : `<button disabled title='Submit this question to unlock ${esc(next.title)}'>${esc(nextLabel)}${icon('chevron-right')}</button>`;
  return `<nav class='onboarding-question-nav' aria-label='Question navigation'>${previousAction}<span>Question ${questionIndex} of ${sameStep.length} · ${sameStep.filter(item => item.status.startsWith('COMPLETE')).length} complete</span>${nextAction}</nav>`;
}
function onboardingWorkspace(data) {
  const onboarding = data.onboarding;
  const progress = onboarding.progress;
  const questionnaire = onboardingQuestionnaireFor(data);
  const percent = Math.round(progress.complete / progress.total * 100);
  const stepButtons = progress.checks.map((step, index) => {
    const target = onboardingQuestionForStep(onboarding, step.id);
    const available = target.available || target.first;
    const current = questionnaire?.step_id === step.id;
    const body = `<span>${icon(step.state === 'COMPLETE' ? 'check' : 'clock')}</span><span><small>Step ${index + 1}</small><strong>${esc(step.label)}</strong></span>${badge(step.state)}`;
    const control = available && !available.locked
      ? `<a data-onboarding-native href='${esc(onboardingHref(available.id))}'>${body}</a>`
      : `<button disabled>${body}</button>`;
    return `<li class='${step.state.toLowerCase()} ${current ? 'current' : ''}'>${control}</li>`;
  }).join('');
  if (!questionnaire) return heading(onboarding.strategy_name, onboarding.strategy_id, onboardingStatusLink('Back to status', '', 'chevron-left')) + empty('No onboarding questionnaire is currently available. Resolve the source baseline first.');
  const sameStep = onboarding.questionnaires.filter(item => item.step_id === questionnaire.step_id);
  const questionIndex = sameStep.findIndex(item => item.id === questionnaire.id) + 1;
  const completedInStep = sameStep.filter(item => item.status.startsWith('COMPLETE')).length;
  const questionNavigation = onboardingQuestionNavigation(onboarding, questionnaire, sameStep, questionIndex);
  const complete = questionnaire.status.startsWith('COMPLETE');
  const completedAnswerNote = complete ? `<div class='onboarding-answer-note'>${icon('history')}<span><strong>Setup confirmed</strong>You can update this confirmation later. Ocean preserves the earlier record automatically.</span></div>` : '';
  const receipt = questionnaire.submission;
  const submissionRecord = `<details class='onboarding-technical-record'><summary>Technical record</summary><div><h3>Submission record</h3>${facts([
    ['Status', badge(questionnaire.status)], ['Author', esc(receipt?.author || 'Recorded on submit')], ['Timestamp', esc(date(receipt?.submitted_at_utc))], ['Source fingerprint', hash(onboarding.source.fingerprint)], ['Receipt', receipt ? hash(receipt.receipt_hash) : 'Created on submit'],
  ])}<p>Ocean generates this record automatically. You do not need to provide hashes or receipt IDs.</p></div></details>`;
  return heading(onboarding.strategy_name, onboarding.strategy_id, onboardingStatusLink('Back to status', '', 'chevron-left'))
    + `<div class='onboarding-workspace-summary'><div><strong>Prepare a non-live test</strong><span>${progress.complete} of ${progress.total} steps complete</span></div><div class='progress-bar' aria-label='${progress.complete} of ${progress.total} onboarding steps complete'><span style='width:${percent}%'></span></div><strong>${percent}%</strong></div>`
    + `<div class='onboarding-workspace'><aside class='onboarding-step-panel'><h2>Onboarding steps</h2><ol>${stepButtons}</ol></aside><main class='onboarding-question-panel'>`
    + `<div class='onboarding-question-heading'><div><p>Step ${progress.checks.findIndex(item => item.id === questionnaire.step_id) + 1} of ${progress.total}</p><h2>${esc(progress.checks.find(item => item.id === questionnaire.step_id)?.label)}</h2><span>Ocean has already read the strategy and Sierra configuration.</span></div><div class='actions'>${badge(questionnaire.status)}<a class='button' href='/improvement/onboarding-guide#${esc(questionnaire.id)}'>${icon('arrow-up-right')}Help</a></div></div>`
    + questionNavigation
    + completedAnswerNote
    + `<div class='onboarding-question-body simple'><form id='onboarding-form'><h3>${esc(questionnaire.title)}</h3><p class='muted'>${esc(questionnaire.description)}</p><div class='onboarding-form-grid'>${questionnaire.fields.map(field => onboardingField(questionnaire, field)).join('')}</div>${submissionRecord}</form></div>`
    + `<div class='onboarding-safety-note'>${icon('check')}<span><strong>Replay only</strong>This prepares a simulation test. It does not start Sierra, enable Paper or Live, or change the strategy rules.</span></div>`
    + `<div class='onboarding-form-actions'>${onboardingStatusLink()}${button('review-onboarding-submission', complete ? 'Update setup' : 'Confirm setup', `class='primary' ${questionnaire.locked ? 'disabled' : ''}`, 'check')}</div>`
    + `</main></div>`;
}
function strategyOnboardingPage(data) {
  const onboarding = data.onboarding;
  if (state.onboardingMode) return onboardingWorkspace(data);
  const instance = onboarding.instance;
  const progress = onboarding.progress;
  const source = onboarding.source;
  const delivery = onboarding.continuous_delivery || {};
  const program = delivery.priority_program || { state:'NOT_CONFIGURED', status:'UNKNOWN', workstreams:[] };
  const improvement = delivery.autonomous_improvement || { state:'NOT_CONFIGURED', status:'UNKNOWN', pipeline:[], blockers:[], next_action:null };
  const eventMonitor = delivery.event_monitor || { status:'NOT_STARTED', disposition:'UNKNOWN', sources:[], observed_trade_count:0, eligible_trade_count:0, new_trade_count:0 };
  const improvementActive = improvement.state === 'AVAILABLE';
  const campaign = delivery.replay_campaign || { state:'NOT_CONFIGURED', status:'NOT_STARTED', completed_windows:[], failed_windows:[], next_action:'Ocean is preparing the sealed Replay campaign.' };
  const registration = onboarding.registration;
  const runtime = onboarding.replay_runtime;
  const replayEnvironment = onboarding.activation.environments.find(environment => environment.environment === 'REPLAY');
  const onboardingComplete = onboarding.onboarding_status === 'COMPLETE' || progress.complete === progress.total;
  const runs = Array.isArray(data.runs) ? data.runs : [];
  const environmentOf = run => String(run.context?.expected_environment || '').toUpperCase();
  const replayRuns = runs.filter(run => environmentOf(run) === 'REPLAY');
  const paperRuns = runs.filter(run => ['PAPER','PAPER_FORWARD'].includes(environmentOf(run)));
  const liveRuns = runs.filter(run => environmentOf(run) === 'LIVE_REAL');
  const completedRuns = items => items.filter(run => run.state === 'COMPLETED');
  const evidenceCount = run => {
    const completion = run.events?.find(event => event.payload?.completion)?.payload.completion;
    return Number(run.manager?.unique_canonical_count ?? completion?.unique_canonical_trade_count ?? 0);
  };
  const replayCompleted = completedRuns(replayRuns);
  const paperCompleted = completedRuns(paperRuns);
  const replayTrades = replayCompleted.reduce((total, run) => total + evidenceCount(run), 0);
  const paperTrades = paperCompleted.reduce((total, run) => total + evidenceCount(run), 0);
  const noTradeRuns = [...replayCompleted, ...paperCompleted].filter(run => evidenceCount(run) === 0).length;
  const paperWorkstream = (program.workstreams || []).find(item => item.id === 'W5' || /paper/i.test(item.name || ''));
  const paperWorkstreamStatus = String(paperWorkstream?.status || '');
  const paperRuntimeActive = paperWorkstreamStatus.startsWith('ACTIVE_SIM1_') || paperWorkstreamStatus === 'ACTIVE';
  const paperReconciliationRequired = paperWorkstreamStatus.includes('TELEMETRY_RECONCILIATION_PENDING');
  const paperAttributionRequired = paperWorkstreamStatus.includes('TELEMETRY_ATTRIBUTION_PENDING');
  const paperSafeCutoverPending = paperWorkstreamStatus.includes('SAFE_CUTOVER_PENDING');
  const pendingAcceptanceGate = program.current_acceptance_assessment?.pending?.[0] || null;
  const governedAction = program.next_governed_action || null;
  const checklist = `<ul class='onboarding-checklist'>${progress.checks.map(item => {
    const target = onboardingQuestionForStep(onboarding, item.id);
    const stateClass = item.state === 'COMPLETE' ? 'complete' : 'pending';
    const leading = `<span class='onboarding-step-icon'>${icon(item.state === 'COMPLETE' ? 'check' : 'clock')}</span><span class='onboarding-step-label'>${esc(item.label)}</span>`;
    if (target.available) return `<li class='${stateClass} actionable'><a data-onboarding-native href='${esc(onboardingHref(target.available.id))}' aria-label='Open ${esc(item.label)}'>${leading}<span class='onboarding-step-state'>${badge(item.state)}<span class='onboarding-step-action'>Open ${icon('chevron-right')}</span></span></a></li>`;
    const note = item.id === 'strategy-detected' ? 'Automatic' : item.id === 'ready-to-test' && item.state !== 'COMPLETE' ? 'Ocean prepares this after confirmation' : '';
    return `<li class='${stateClass}'><div class='onboarding-checklist-row'>${leading}<span class='onboarding-step-state'>${badge(item.state)}${note ? `<small>${esc(note)}</small>` : ''}</span></div></li>`;
  }).join('')}</ul>`;
  const sourceFailures = source.files.filter(file => file.state !== 'AVAILABLE');
  const sourceStatus = sourceFailures.length ? `<p class='form-error'>${esc(sourceFailures.map(file => `${file.filename}: ${human(file.state)}`).join('; '))}</p>` : '';
  const headingActions = badge(onboardingComplete ? 'ONBOARDING_COMPLETE' : onboarding.onboarding_status)
    + `<a class='button' href='/improvement/onboarding-guide'>${icon('arrow-up-right')}Onboarding guide</a>`
    + (onboarding.active_questionnaire_id ? onboardingLink(onboarding.active_questionnaire_id, 'Confirm setup', "class='primary'", 'check') : '')
    + (onboarding.registration.can_register ? button('register-onboarding', 'Prepare Replay test', "class='primary'", 'play') : '');
  const brainRows = onboarding.brain_sync.items.map(item => [
    esc(human(item.milestone_type)), esc(item.milestone_id), badge(item.state), String(item.attempts),
    item.brain_relative_path ? `<code>${esc(item.brain_relative_path)}</code>` : esc(item.last_error || 'Awaiting delivery'),
    ['FAILED','DEAD_LETTER'].includes(item.state) ? button('retry-onboarding-brain', 'Retry', `data-id='${esc(item.id)}'`, 'refresh-cw') : '',
  ]);
  const setupConfirmed = progress.checks.some(check => check.id === 'test-setup' && check.state === 'COMPLETE');
  const pendingRegistrationTitle = registration.can_register ? 'Setup confirmed' : setupConfirmed ? 'Ocean is recording the setup' : 'Waiting for setup confirmation';
  const pendingRegistrationText = registration.can_register
    ? 'Ocean can now prepare the strategy for a Replay test. This still does not start Sierra.'
    : setupConfirmed
      ? 'No action is required. Brain synchronization is completing automatically.'
      : 'Confirm the one-page detected setup. Ocean handles the technical records in the background.';
  const registrationBody = registration.receipt
    ? facts([['State',badge(registration.state)],['Recorded',esc(date(registration.receipt.created_at_utc))],['Brain',badge(registration.receipt.brain_sync?.state || 'PENDING')],['Sierra started','No']])
    : `<div class='registration-ready'><div><strong>${pendingRegistrationTitle}</strong><p>${pendingRegistrationText}</p></div>${registration.can_register ? button('register-onboarding', 'Prepare Replay test', "class='primary'", 'play') : ''}</div>`;
  const monitorOpened = Boolean(sessionStorage.getItem(replayMonitorOpenedKey));
  const sierraVerified = runtime.sierra.state === 'OPEN_EXACT_CHARTBOOK_VERIFIED';
  const replayRunning = runtime.chart_replay.state === 'RUNNING_VERIFIED';
  const activationBody = `<div class='replay-runtime-list' aria-label='Replay runtime status'>
    <div class='replay-runtime-row'><div><strong>Ocean Replay monitor</strong><p>Browser view of captured Replay data. It does not open Sierra or start chart replay.</p></div><div><span data-replay-monitor-state>${badge(monitorOpened ? 'OPENED_FROM_THIS_BROWSER' : runtime.monitor.state)}</span><a class='button primary' data-replay-monitor href='${esc(runtime.monitor.url)}' target='_blank' rel='noopener'>${icon('arrow-up-right')}Open Replay Monitor</a></div></div>
    <div class='replay-runtime-row'><div><strong>Sierra Replay Two</strong><p>${sierraVerified ? `Exact process and chartbook verified on chart ${esc(runtime.sierra.chart_id)}.` : 'Ocean cannot safely launch desktop Sierra from this page. Open the exact executable and chartbook manually.'}</p>${sierraVerified ? '' : `<dl class='runtime-paths'><div><dt>Executable</dt><dd><code>${esc(runtime.manual_launch.executable)}</code></dd></div><div><dt>Chartbook</dt><dd><code>${esc(runtime.manual_launch.chartbook_path)}</code></dd></div><div><dt>Account</dt><dd>${esc(runtime.manual_launch.account_alias)}</dd></div></dl>`}</div><div>${badge(runtime.sierra.state)}</div></div>
    <div class='replay-runtime-row'><div><strong>Chart replay</strong><p>${replayRunning ? 'A fresh Replay Two controller observation confirms chart replay is running.' : runtime.chart_replay.state === 'NOT_RUNNING_VERIFIED' ? 'A fresh Replay Two controller observation confirms chart replay is stopped.' : 'Chart replay is not currently verified. Refresh after using Sierra replay controls.'}</p>${runtime.chart_replay.observed_at_utc ? `<small>Controller observation: ${esc(date(runtime.chart_replay.observed_at_utc))}</small>` : ''}</div><div>${badge(runtime.chart_replay.state)}</div></div>
  </div><div class='activation-grid'>${replayEnvironment ? [replayEnvironment].map(environment => {
    const active = environment.state === 'ACTIVATED_NOT_STARTED';
    const paused = environment.state === 'PAUSE';
    const activateLabel = paused ? 'Resume Replay test' : 'Make Replay ready';
    const actions = environment.can_activate ? button('activate-onboarding', activateLabel, `class='primary' data-environment='${environment.environment}'`, 'play') : '';
    const controls = active ? button('pause-onboarding', 'Pause', `data-environment='${environment.environment}'`, 'pause') + button('deactivate-onboarding', 'Deactivate', `data-environment='${environment.environment}'`, 'square') + button('emergency-stop-onboarding', 'Emergency stop', `class='danger' data-environment='${environment.environment}'`, 'alert-triangle') : paused ? button('deactivate-onboarding', 'Deactivate', `data-environment='${environment.environment}'`, 'square') : '';
    return `<article class='activation-item'><div class='row-head'><h3>Advanced Replay control</h3>${badge(environment.state)}</div><p>${environment.permitted ? 'Ocean has recorded Replay readiness for this strategy.' : 'Available after strategy setup is complete.'}</p><div class='actions'>${actions}${controls}</div></article>`;
  }).join('') : ''}</div><p class='readonly-note'>${icon('check')}These controls change Ocean's Replay readiness record only. They do not start Sierra, place orders, or approve Live trading.</p>`;

  const setupAction = onboarding.active_questionnaire_id
    ? onboardingLink(onboarding.active_questionnaire_id, 'Confirm detected setup', "class='primary'", 'check')
    : registration.can_register
      ? button('register-onboarding', 'Finish Replay preparation', "class='primary'", 'play')
      : replayEnvironment?.can_activate
        ? button('activate-onboarding', 'Make Replay ready', `class='primary' data-environment='${replayEnvironment.environment}'`, 'play')
        : '';
  const replayState = !onboardingComplete ? 'WAITING' : campaign.status === 'COMPLETED' ? 'HISTORY_AVAILABLE' : campaign.status === 'RUNNING' ? 'BUILDING_HISTORY' : campaign.status === 'FAILED' || campaign.state === 'ATTENTION_REQUIRED' ? 'ATTENTION_REQUIRED' : paperRuns.length ? 'HISTORY_AVAILABLE' : replayRuns.length ? 'BUILDING_HISTORY' : 'READY';
  const paperState = !onboardingComplete ? 'WAITING' : paperReconciliationRequired || paperAttributionRequired ? 'ATTENTION_REQUIRED' : paperRuntimeActive || paperRuns.length ? 'FORWARD_TESTING' : 'NEXT';
  const liveState = liveRuns.length ? 'LIVE_ACTIVE' : 'HUMAN_APPROVAL_REQUIRED';
  const journey = `<ol class='strategy-journey' aria-label='Strategy testing journey'>
    <li class='complete'><span class='journey-marker'>${icon('check')}</span><div class='journey-copy'><div><h3>1. Strategy setup</h3>${badge(onboardingComplete ? 'COMPLETE' : 'IN_PROGRESS')}</div><p>Ocean reads the strategy and Sierra setup. One confirmation makes it ready for non-live testing.</p></div></li>
    <li class='${!onboardingComplete ? 'waiting' : paperRuntimeActive ? 'complete' : 'current'}'><span class='journey-marker'>${paperRuntimeActive ? icon('check') : '2'}</span><div class='journey-copy'><div><h3>2. Replay history</h3>${badge(replayState)}</div><p>Run historical Replay tests. Each completed run records its covered period, trades, and a zero-trade result when no trade occurred.</p><p class='journey-evidence'>${replayCompleted.length} completed run${replayCompleted.length === 1 ? '' : 's'} / ${replayTrades} trade${replayTrades === 1 ? '' : 's'} captured</p></div></li>
    <li class='${paperRuntimeActive || paperRuns.length ? 'current' : 'waiting'}'><span class='journey-marker'>3</span><div class='journey-copy'><div><h3>3. Paper forward testing</h3>${badge(paperState)}</div><p>After Replay evidence is reviewed, run the strategy in Paper. Completed Paper periods add trade and no-trade evidence continuously.</p><p class='journey-evidence'>${paperCompleted.length} completed run${paperCompleted.length === 1 ? '' : 's'} / ${paperTrades} trade${paperTrades === 1 ? '' : 's'} captured</p></div></li>
    <li class='${liveRuns.length ? 'current' : 'waiting'}'><span class='journey-marker'>4</span><div class='journey-copy'><div><h3>4. Live trading</h3>${badge(liveState)}</div><p>Live is a separate, explicit human decision after Replay and Paper evidence has been reviewed. Ocean never promotes a strategy automatically.</p></div></li>
  </ol>`;
  const nextActionTitle = improvementActive ? 'Complete the autonomous improvement loop' : pendingAcceptanceGate?.title || governedAction?.title || (paperSafeCutoverPending ? 'Wait for the safe Paper cutover' : paperAttributionRequired ? 'Complete Paper trade attribution' : paperReconciliationRequired ? 'Reconcile Paper telemetry' : paperRuntimeActive ? 'Observe the Paper forward run' : campaign.status === 'COMPLETED' ? 'Evaluate the Replay-to-Paper gate' : campaign.status === 'FAILED' || campaign.state === 'ATTENTION_REQUIRED' ? 'Repair the bounded Replay failure' : campaign.status === 'RUNNING' ? `Replay ${campaign.current_window_id || 'window'} is running` : 'Continue the sealed Replay campaign');
  const nextActionHref = paperRuntimeActive ? '/paper-dashboard.html' : runtime.monitor.url;
  const nextActionLabel = paperRuntimeActive ? 'Open Paper Dashboard' : 'Open Replay Monitor';
  const nextActionText = improvementActive ? improvement.next_action : pendingAcceptanceGate?.resolution_action || governedAction?.action || paperWorkstream?.next_action || campaign.next_action;
  const nextActionOwner = improvementActive ? 'Ocean continuous-improvement coordinator' : pendingAcceptanceGate?.owner || governedAction?.owner || null;
  const nextActionControls = improvementActive || pendingAcceptanceGate || governedAction ? '' : `<div class='actions'><a class='button primary' ${paperRuntimeActive ? '' : 'data-replay-monitor'} href='${esc(nextActionHref)}' target='_blank' rel='noopener'>${icon('arrow-up-right')}${nextActionLabel}</a></div>`;
  const nextAction = onboardingComplete
    ? `<div class='strategy-next-action'><div><span>Current action</span><h3>${esc(nextActionTitle)}</h3><p>${esc(nextActionText)}</p>${nextActionOwner ? `<small>Owner: ${esc(nextActionOwner)}</small>` : ''}</div>${nextActionControls}</div>`
    : `<div class='strategy-next-action'><div><span>Current action</span><h3>Finish the simple setup</h3><p>${registration.can_register ? 'The setup is confirmed. Let Ocean finish the Replay preparation.' : setupConfirmed ? 'Ocean is recording the confirmed setup. Refresh when synchronization is complete.' : 'Review the detected strategy, account, contract, and Replay instance once.'}</p></div><div class='actions'>${setupAction}</div></div>`;
  const completionBanner = onboardingComplete
    ? `<div class='onboarding-complete-banner'>${icon('check')}<div><h2>Onboarding complete</h2><p>${improvementActive ? 'The non-live strategy is onboarded. Ocean is implementing and proving the continuous learning loop; candidate promotion still requires human approval and Live remains disabled.' : pendingAcceptanceGate ? 'Operational Replay discovery is complete. Paper remains Sim1 non-promotional while the remaining acceptance gate is resolved; Live remains a separate human-only decision.' : governedAction ? 'The CI/CD system is operational and the frozen data ladder is sealed. The next strategy change remains a governed human decision; Paper stays Sim1 non-promotional and Live stays disabled.' : paperRuntimeActive ? 'This strategy has progressed to Paper forward testing; Live remains a separate human-only decision.' : 'This strategy is ready to build history in Replay. Sierra running, stopped, or stale does not change this status.'}</p></div></div>`
    : '';
  const workstreamRows = (program.workstreams || []).map(item => [esc(item.id), esc(item.name), badge(item.status), esc(item.owner), esc(item.next_action || 'No separate action recorded')]);
  const pipelineRows = (improvement.pipeline || []).map(item => [esc(item.id), esc(item.name), badge(item.status), esc(item.acceptance)]);
  const blockerRows = (improvement.blockers || []).map(item => [esc(item.id), badge(item.status), esc(item.blocker), esc(item.resolution)]);
  const eventMonitorSources = (eventMonitor.sources || []).map(item => [
    esc(item.id), esc(item.environment), esc(item.account), String(item.observed_trade_count || 0),
    String(item.eligible_trade_count || 0), '<code>'+esc(item.database_path || 'Not recorded')+'</code>',
  ]);
  const campaignBody = facts([
    ['Foundation program', badge(program.status)], ['Improvement program', badge(improvement.status)], ['Replay campaign', badge(campaign.status)], ['Campaign source', badge(campaign.state)],
    ['Current window', esc(campaign.current_window_id || 'None')], ['Completed windows', String(campaign.completed_count || 0)],
    ['Failed windows', String(campaign.failed_count || 0)], ['Execution instance', esc(campaign.execution_instance_id)],
    ['LIVE_REAL', badge(campaign.live_real || 'DISABLED')], ['Pending acceptance gates', String(program.current_acceptance_assessment?.pending?.length || 0)],
    ['Promotion', esc(program.current_acceptance_assessment?.promotion_disposition || 'Not recorded')], ['Last observed', esc(date(campaign.observed_at_utc))],
    ['Improvement gates', improvement.acceptance_gates ? `${esc(improvement.acceptance_gates.complete)} / ${esc(improvement.acceptance_gates.total)} proven` : 'Not recorded'],
    ['Controller', esc(improvement.controller?.canonical_version || 'Not recorded')], ['Automatic approval', badge(improvement.automatic_approval || 'DISABLED')],
    ['Event monitor', badge(eventMonitor.status || 'NOT_STARTED')], ['Detector disposition', badge(eventMonitor.disposition || 'UNKNOWN')],
    ['Database queries', String(eventMonitor.database_query_count || 0)], ['Last database interrogation', esc(date(eventMonitor.last_database_interrogation_at_utc))],
    ['Observed VWAP trades', String(eventMonitor.observed_trade_count || 0)], ['Eligible causal trades', String(eventMonitor.eligible_trade_count || 0)],
    ['New trades in last query', String(eventMonitor.new_trade_count || 0)], ['Codex polling', badge('NOT_REQUIRED')],
  ]) + '<h3>Event-driven evidence monitor</h3><p class="section-note">The local website monitor checks the bound Replay Two and Paper Sim1 SQLite ledgers. It stores NO_CHANGE and insufficient-evidence results locally, and wakes the Ocean coordinator only for a new actionable INVESTIGATE result.</p>'
    + (eventMonitorSources.length ? table(['Source','Environment','Account','Observed','Eligible','SQLite database'], eventMonitorSources) : empty('The event-driven evidence monitor has not completed its first database query.'))
    + (eventMonitor.last_error ? '<p class="form-error">'+esc(eventMonitor.last_error)+'</p>' : '')
    + (pipelineRows.length ? table(['Phase','Capability','State','Acceptance evidence required'], pipelineRows) : empty('The autonomous improvement program record is not available.'))
    + (blockerRows.length ? `<h3>Known blockers and resolutions</h3>${table(['ID','State','Blocker','Resolution'], blockerRows)}` : '')
    + (workstreamRows.length ? `<h3>Operational foundation</h3>${table(['Lane','Workstream','State','Owner','Exact next action'], workstreamRows)}` : '');
  return heading(onboarding.strategy_name, 'Strategy setup and testing', headingActions)
    + `<p class='readonly-note'>${icon('check')} Ocean reads the strategy and Sierra setup directly. You confirm the non-live setup once; testing evidence is collected afterwards.</p>`
    + completionBanner
    + `<div class='onboarding-status-band'>${[
      ['Onboarding', badge(onboardingComplete ? 'COMPLETE' : onboarding.onboarding_status)],
      ['Current stage', onboardingComplete ? improvementActive ? 'Autonomous improvement implementation' : pendingAcceptanceGate ? 'Post-discovery review' : governedAction ? 'Governed candidate decision' : paperRuntimeActive ? 'Paper forward testing' : 'Replay history' : 'Strategy setup'],
      ['Account', esc(instance.account_alias)],
      [paperRuntimeActive ? 'Paper contract' : 'Replay contract', esc((paperRuntimeActive ? program.current_runtime_contracts?.paper : program.current_runtime_contracts?.replay) || instance.symbol)],
    ].map(([label,value]) => `<div><span>${esc(label)}</span><strong>${value}</strong></div>`).join('')}</div>`
    + nextAction
    + section('CI/CD continuous run', campaignBody, `<span class='muted'>${esc(nextActionText)}</span>`)
    + section('Strategy journey', journey, `<span class='muted'>${noTradeRuns} completed zero-trade period${noTradeRuns === 1 ? '' : 's'} recorded</span>`)
    + (!onboardingComplete ? section('Setup progress', `<div class='progress-summary'><strong>${progress.complete} of ${progress.total} complete</strong><span>${Math.round(progress.complete / progress.total * 100)}%</span></div><div class='progress-bar' aria-label='${progress.complete} of ${progress.total} onboarding steps complete'><span style='width:${Math.round(progress.complete / progress.total * 100)}%'></span></div>${checklist}${registration.receipt && registration.state === 'REGISTERED' ? '' : registrationBody}`) : '')
    + `<details class='onboarding-system-details'><summary>Replay and system details</summary>${section('Replay runtime and advanced controls', activationBody)}${section('Obsidian Brain record', brainRows.length ? table(['Milestone','Receipt','State','Attempts','Record','Action'], brainRows) : empty('Created after setup confirmation.'))}${section('Source checks', facts([['Profile',badge(onboarding.profile.validity)],['Instance',badge(instance.status)],['Source',badge(source.status)],['Last verified',esc(date(source.last_verified_at_utc))]]) + sourceStatus)}</details>`;
}
function runPage(data) {
  const context = data.context;
  const observed = data.events.find(event => event.payload?.observed_handshake)?.payload.observed_handshake.source_state || context.observed_source_state;
  const completion = data.events.find(event => event.payload?.completion)?.payload.completion;
  const incoming = data.events.filter(event => event.payload?.wire_event);
  const canReprocess=data.manager?.namespace==='OPERATIONAL' && data.state==='COMPLETED' && data.manager.completion_current && context.evidence_purpose==='HISTORICAL_BUILD';
  const canAbandonReprocess=data.manager?.namespace==='OPERATIONAL' && data.state==='READY' && data.manager.plan?.reprocess_of_run_id;
  const noNewCoverage=data.events.find(event=>event.action==='run-manager.no-new-coverage');
  const canConfirmNoNew=canReprocess && data.manager.plan?.reprocess_of_run_id && !noNewCoverage;
  const learning=data.learning;
  const evidenceReady=Boolean(data.manager?.completion_current && data.manager?.completion?.status==='COMPLETED');
  const learningStages=learning ? [
    ['1. Evidence captured', evidenceReady ? 'COMPLETE' : data.state==='COMPLETED' ? 'BLOCKED' : 'PENDING', evidenceReady ? `${data.manager.unique_canonical_count} unique trade record${data.manager.unique_canonical_count===1?'':'s'} plus covered no-trade intervals` : 'Waiting for a current completion receipt and fully drained coverage.'],
    ['2. Evidence qualified', learning.eligible ? 'COMPLETE' : 'NOT_DUE', learning.eligible ? 'This operational run is eligible for cumulative strategy learning.' : (learning.reasons || []).map(human).join('; ') || 'This run is outside the learning policy.'],
    ['3. Cumulative Brain analysis', ['BRAIN_RECORDED','COMPLETE'].includes(learning.stage) ? 'COMPLETE' : learning.last_error ? 'FAILED' : learning.stage, learning.brain_record_id ? `Obsidian Brain record ${learning.brain_record_id}` : learning.last_error ? human(learning.last_error) : 'Waiting for the Obsidian Brain to analyse this run with all eligible strategy evidence.'],
    ['4. Result returned to Ocean', learning.stage==='COMPLETE' ? 'COMPLETE' : learning.stage==='FAILED' ? 'FAILED' : 'PENDING', learning.stage==='COMPLETE' ? `${human(learning.conclusion_type)} recorded; no strategy or trading permission was changed automatically.` : 'Waiting for the immutable Brain result and completion callback.'],
    ['5. Research evaluation', learning.research?.state || (learning.conclusion_type==='RECOMMENDATION'?'PENDING':'NOT_DUE'), learning.research?.report ? `${human(learning.research.report.outcome)}: ${learning.research.report.next_action}` : learning.next_action || 'Waiting for the persisted Research worker.'],
    ['6. Candidate validation', learning.research?.report?.candidate_validation?.status || 'NOT_DUE', 'Replay history is baseline discovery. A separate frozen candidate and independent evidence are required before validation can pass.'],
  ] : [];
  const learningBody=learning ? table(['Stage','Status','Evidence'],learningStages.map(([label,status,detail])=>[esc(label),badge(status),esc(detail)]))
    + facts([['Overall learning loop',badge(learning.loop_stage || learning.stage)],['Conclusion',learning.research?.report ? badge(learning.research.report.outcome) : learning.conclusion_type?badge(learning.conclusion_type):'Not recorded'],['Brain record',learning.brain_record_id?esc(learning.brain_record_id):'Not recorded'],['Governance reconciliation',learning.registry_reconciliation_id?esc(learning.registry_reconciliation_id):'Not loaded'],['Research continuation',learning.continuation_case_id?link('cases',learning.continuation_case_id,learning.continuation_case_id):'Not required'],['Next action',esc(learning.next_action || 'Await the learning result')],['Automatic strategy change','Disabled']])
    : empty('Learning status is not available for this run.');
  return heading(context.run_id, data.strategy_name, badge(data.state) + (data.manager && ['READY','ACTIVE'].includes(data.state) ? button('end-run','End run','', 'square') : '') + (canAbandonReprocess ? button('abandon-reprocess','Discard reservation','', 'x') : '') + (canConfirmNoNew ? button('confirm-no-new-coverage','Confirm no new coverage','', 'check') : '') + (canReprocess ? button('reprocess-history','Reprocess Existing History','', 'refresh-cw') : '')) + (noNewCoverage ? section('Historical build decision',facts([['Outcome',badge('NO_NEW_COVERAGE')],['Decision',esc(noNewCoverage.payload.decision_id)],['Decision hash',hash(noNewCoverage.payload.decision_hash)],['Coverage hash',hash(noNewCoverage.payload.coverage_hash)],['New run','No']])) : '') + (data.manager ? section('Run control',facts([
    ['Context',esc(human(data.manager.context_status))],['Last heartbeat',esc(date(data.manager.lease?.heartbeat_utc))],['Lease',data.state==='COMPLETED' ? 'Completed; lease not required' : data.manager.lease ? badge(data.manager.lease.expired?'EXPIRED':'CURRENT') : 'Awaiting telemetry'],['Unique evidence / processing',`${data.manager.unique_canonical_count} / ${data.manager.processing_count}`],['Open pins / pending events',`${data.manager.open_pins} / ${data.manager.progress?.pending_events ?? 'Unknown'}`],['Source / execution / processing coverage',data.manager.progress ? Object.entries(data.manager.progress.axes).map(([key,values])=>`${esc(human(key))}: ${values.length} observed intervals`).join('<br>') : 'Not observed'],['Completion receipt',data.manager.completion ? data.manager.completion_current?'Current':'New evidence needs review / new receipt':'Not recorded'],['Ingestion','Off / TEST only'],['Action required',data.manager.context_status!=='CURRENT'?esc(human(data.manager.context_status)):data.state==='READY'?'Await matching manual Sierra activity':data.state==='COMPLETING'?'Await telemetry drain and completion':data.state==='COMPLETED'?esc(learning?.next_action || 'Run complete'):'See observed progress'],
  ])) : '') + facts([
    ['Strategy', link('strategies', context.strategy_id, data.strategy_name)], ['Instance', esc(context.execution_instance_id)], ['Purpose', esc(human(context.evidence_purpose))],
    ['Declared environment', esc(context.expected_environment)], ['Observed environment', esc(observed.environment)], ['Source quality', badge(observed.quality)], ['Observation time', esc(date(observed.observed_at_utc))], ['Strategy version', esc(context.strategy_version)], ['Dataset scope', `${esc(context.dataset_manifest_id)} / revision ${esc(context.dataset_manifest_revision)}`], ['Scored interval', data.manager?.plan?.selection?.interval ? `${esc(data.manager.plan.selection.interval.start_utc)} to ${esc(data.manager.plan.selection.interval.end_utc)}` : 'Not recorded'],
    ['Persisted service-event receipts', esc(data.receipt_counts ? data.receipt_counts.workflow + data.receipt_counts.trades : incoming.length)], ['Persisted analysis callbacks', esc(data.receipt_counts?.analysis_complete ?? incoming.filter(event => event.payload.analysis_complete === true).length)], ['Learner permission', esc(context.learner_permission)],
  ]) + (observed.environment !== 'UNKNOWN' && context.expected_environment !== observed.environment ? `<p class='form-error'>Observed source does not match the declared environment.</p>` : '') + section('Learning loop',learningBody) + section('Pinned run context', `<pre>${esc(JSON.stringify(context, null, 2))}</pre>`) + section('Completion and coverage', completion ? `<pre>${esc(JSON.stringify(completion, null, 2))}</pre>` : empty('No completion receipt recorded.')) + section('Run history', timeline(data.events));
}
function caseProgress(data) {
  const phases = [['Research', ['DISCOVERY','EVIDENCE','RESEARCH']], ['Human review', ['DEVELOPMENT_REVIEW','DEVELOPMENT_HANDOFF']], ['Development', ['CANDIDATE_DEVELOPMENT']], ['Historical tests', ['HISTORICAL_VALIDATION']], ['Evaluation', ['CANDIDATE_EVALUATION','SHADOW_REVIEW','SHADOW_HANDOFF']], ['Shadow forward', ['FORWARD_VALIDATION','FORWARD_EVALUATION']], ['Deployment review', ['DEPLOYMENT_REVIEW','DEPLOYMENT_HANDOFF','ROLLBACK_REVIEW','ROLLBACK_HANDOFF']], ['Observation', ['POST_DEPLOYMENT_VALIDATION']], ['Retrospective', ['RETROSPECTIVE','CLOSED']]];
  const visited = data.history.map(event => event.payload?.after?.stage).filter(Boolean);
  return `<ol class='step-track' aria-label='Case progress'>${phases.map(([name, stages]) => `<li class='${stages.includes(data.stage) ? 'current' : stages.some(stage => visited.includes(stage)) ? 'complete' : ''}' ${stages.includes(data.stage) ? "aria-current='step'" : ''}>${esc(name)}</li>`).join('')}</ol>`;
}
function handoffList(data) {
  return data.handoffs.length ? data.handoffs.map(handoff => `<div class='list-row'><div class='row-head'><strong>${esc(human(handoff.gate))} / ${esc(handoff.recipient_id)}</strong>${badge(handoff.state)}</div><p class='subline'>${esc(handoff.handoff_id)}</p>${handoff.delivery_error || handoff.blocked_reason ? `<p class='form-error'>${esc(human(handoff.delivery_error || handoff.blocked_reason))}</p>` : ''}<div class='actions'>${button('view-handoff', 'View approved MD', `data-id='${esc(handoff.handoff_id)}'`)}${button('download-handoff', 'Download', `data-id='${esc(handoff.handoff_id)}'`, 'download')}${button('copy-handoff', 'Copy instruction', `data-id='${esc(handoff.handoff_id)}'`, 'copy')}${handoff.state === 'READY' ? button('send-handoff', 'Mark sent', `data-id='${esc(handoff.handoff_id)}'`) : ''}${['FAILED','BLOCKED','CREATED'].includes(handoff.state) ? button('retry-handoff', handoff.state === 'CREATED' ? 'Prepare delivery' : 'Retry delivery', `data-id='${esc(handoff.handoff_id)}'`) : ''}${handoff.state === 'DISPATCHED' ? button('manual-confirmation', 'Record manual confirmation', `data-id='${esc(handoff.handoff_id)}'`) : ''}</div>${handoff.result_artifact_id ? `<p>${link('artifacts', handoff.result_artifact_id, 'Returned result')}</p>` : ''}</div>`).join('') : empty('No handoff registered.');
}
function researchPanel(research) {
  if(!research)return '';
  const report=research.report;
  return section('Research evaluation',facts([
    ['Job',esc(research.job_id)],['Status',badge(research.effective_state || research.state)],
    ['Provenance',esc(research.qualification_warning || (research.qualified_for_new_support ? 'Currently qualified for new support' : 'Not qualified for new support'))],
    ['Outcome',report?badge(report.outcome):'Not recorded'],
    ['Next action',esc(research.next_action)],['Attempts',esc(research.attempts)],
    ['Result',research.result_artifact_id?link('artifacts',research.result_artifact_id,'View full Research report'):'Pending'],
  ]) + (report?facts([
    [research.historical || !research.qualified_for_new_support ? 'Preserved report history (not current qualified support)' : 'Currently qualified history',`${report.eligible_run_ids?.length || 0} runs / ${report.aggregate?.trades || 0} closed trades`],
    ['Simulated execution gross P/L',esc(report.aggregate.gross_profit_loss)],['Recorded fees',esc(report.aggregate.fees)],
    ['Simulated execution net P/L',esc(report.aggregate.net_profit_loss)],['Net wins / losses / flat',`${report.aggregate.wins} / ${report.aggregate.losses} / ${report.aggregate.flat}`],
    ['Accounting basis',esc(report.accounting_basis)],
    ['Missing exit attribution',esc(report.missing_exit_attribution)],
    ['Candidate validation',badge(report.candidate_validation.status)],
    ['Research Brain record',esc(report.brain_record?.record_id || 'Not recorded')],
  ]):research.last_error?`<p class='form-error'>${esc(human(research.last_error))}</p>`:''));
}
function casePage(data) {
  const executable = !['COMPLETED','PAUSED','FAILED','BLOCKED','CANCELLED'].includes(data.work_status) && data.stage !== 'CLOSED';
  const statusControl = ['PAUSED','FAILED','BLOCKED'].includes(data.work_status) ? button('resume', data.work_status === 'PAUSED' ? 'Resume' : 'Retry', '', 'play') : executable ? button('pause', 'Pause', '', 'pause') : '';
  const prepare = data.approvals.find(row => row.state === 'APPROVED' && row.decision?.current_test_authority && ['DEVELOPMENT','SHADOW','PRODUCTION','ROLLBACK'].includes(row.gate) && !data.handoffs.some(handoff => handoff.decision_id === row.decision.decision.decision_id));
  return heading(data.case_id, data.strategy_name, badge(data.work_status) + statusControl + (executable ? button('upload', 'Upload result', '', 'upload') : '')) + researchPanel(data.research) + facts([
    ['Stage', esc(human(data.stage))], ['Owner', esc(data.owner_id)], ['Waiting on', esc(data.work_status==='COMPLETED'?'None':data.waiting_on || 'Stage prerequisites')], ['Next action', esc(data.next_action)], ['Strategy', link('strategies', data.strategy_id, data.strategy_name)], ['Run', link('runs', data.run_id)], ['Baseline', hash(data.baseline_hash)], ['Candidate', data.candidate_hash ? hash(data.candidate_hash) : 'None registered'], ['Priority', esc(data.priority ? human(data.priority) : 'Not assigned')],
  ]) + caseProgress(data) + (data.blockers.length ? section('Blockers', table(['Owner', 'Required action', 'State'], data.blockers.map(row => [esc(row.owner_id), esc(row.action), badge(row.state)]))) : '') + `<div class='columns'><div>${section('Approvals', approvalTable(data.approvals))}${prepare ? `<div class='actions'>${button('prepare-handoff', 'Prepare approved handoff', `data-request='${esc(prepare.request_id)}'`)}</div>` : ''}${section('Evidence and results', table(['Artifact', 'Producer / recipient', 'Created', 'Availability'], data.artifacts.map(row => [link('artifacts', row.artifact_id, human(row.kind)) + `<div class='subline'>${esc(row.artifact_id)}</div>`, `${esc(row.producer_id)}<div class='subline'>To ${esc(row.recipient_id)}</div>`, esc(date(row.manifest.created_at_utc)), badge(row.manifest.availability)])), `<span class='muted'>${data.artifacts_total} immutable artifacts</span>`)}${section('Historical validation', table(['Test', 'Result', 'Report'], (data.tasks.length ? data.tasks : ['BACKTEST','ROBUSTNESS','WALK_FORWARD','OOS_HOLDOUT'].map(kind => ({ kind, status: data.research && !data.candidate_hash ? 'NOT_DUE' : 'NOT_PLANNED', artifact_id: null }))).map(task => [esc(human(task.kind)), badge(task.status), task.artifact_id ? link('artifacts', task.artifact_id, 'View report') : 'Not recorded'])))}${section('Handoffs', handoffList(data))}${data.outbox.length ? section('Delivery history', table(['Recipient','Delivery','Attempts','Error','Action'], data.outbox.map(row => [esc(row.recipient_id),badge(row.state),String(row.attempts),row.last_error ? esc(row.last_error) : 'None', ['FAILED','DEAD_LETTER'].includes(row.state) ? button('retry-outbox','Retry',`data-id='${esc(row.id)}'`) : '']))) : ''}</div><div>${section('Timeline', timeline(data.history))}</div></div>`;
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
  const rows = view === 'strategies' ? table(['Strategy', 'Onboarding', 'Profile / instance', 'Next action', 'Cases'], items.map(row => {
    const onboarding = row.onboarding;
    return [
      link('strategies', row.strategy_id, row.strategy_name) + `<div class='subline'>${esc(row.strategy_id)}</div>`,
      badge(row.activation_status) + (onboarding ? `<div class='subline'>${onboarding.progress.complete} of ${onboarding.progress.total} complete</div>` : `<div class='subline'>Baseline ${esc(row.baseline_version)}</div>`),
      onboarding ? `${badge(onboarding.profile.validity)}<div class='subline'>${esc(onboarding.instance.status)}</div>` : `${esc(row.profile.profile_id)} / ${esc(row.profile.profile_version)}`,
      onboarding?.next_action ? `<strong>Priority ${onboarding.next_action.priority}</strong><div class='subline'>${esc(onboarding.next_action.title)}</div>` : 'Open strategy record',
      String(row.cases_total),
    ];
  })) : view === 'cases' ? caseTable(items) : view === 'runs' ? runTable(items) : view === 'approvals' ? approvalTable(items) : timeline(items);
  const setup = view === 'history' && data.setup?.length ? `<details class='access-help' id='setup-history'><summary>Installation receipts (${data.setup.length})</summary>${table(['Task','Result','Project','Operator'],data.setup.map(row=>[esc(row.task_id),badge(row.status),esc(row.project),esc(row.operator_id)]))}<p class='muted'>Historical installation records. Not strategy approvals.</p></details>` : '';
  const operational=view==='approvals' && data.operational_releases?.length?section('Operational dataset release',operationalReleaseTable(data.operational_releases),'<span class="muted">Exact manifest-hash decision required</span>'):'';
  return heading(titles[view], `${data.total} records`, view === 'runs' ? button('prepare-run','Start New Run','', 'plus') : '') + `<div class='toolbar'><label for='filter'>Filter this page</label><input type='search' id='filter' value='${state.filter ? esc(state.filter) : ''}' autocomplete='off'></div>${operational}${setup}${rows}${pager(data)}`;
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
    const [data, dashboard] = await Promise.all([current.view === 'onboarding-guide' ? Promise.resolve({}) : request(endpoint, { signal:controller.signal }), current.view === 'dashboard' ? Promise.resolve(null) : request('view/dashboard', { signal:controller.signal })]);
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
      const html = current.view === 'onboarding-guide' ? onboardingHelpPage() : current.view === 'dashboard' ? overview(data) : current.view === 'artifacts' ? await renderArtifact(data,generation) : !current.key ? collectionPage(current.view,data) : ({ strategies:strategyPage, cases:casePage, runs:runPage, approvals:approvalPage })[current.view]?.(data);
      if (generation !== state.generation || html === undefined) return;
      content.innerHTML = html; renderIcons(); state.fingerprint = fingerprint;
      if (location.hash) requestAnimationFrame(() => document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView({ block:'start' }));
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
function onboardingAnswers(questionnaire) {
  const form = document.querySelector('#onboarding-form');
  if (!form) throw Object.assign(new Error(), { code: 'ONBOARDING_FORM_UNAVAILABLE' });
  const answers = {};
  for (const field of questionnaire.fields.filter(item => item.type !== 'readonly')) {
    const control = form.elements.namedItem(field.key);
    if (field.type === 'checkbox') answers[field.key] = Boolean(control?.checked);
    else if (field.type === 'radio') answers[field.key] = control?.value || '';
    else if (field.type === 'number') answers[field.key] = control?.value === '' ? '' : Number(control.value);
    else answers[field.key] = control?.value || '';
  }
  return answers;
}
function onboardingRequest(questionnaire, answers) {
  return {
    strategy_id: state.data.onboarding.strategy_id,
    questionnaire_id: questionnaire.id,
    receipt_id: newId('onboarding-receipt'),
    expected_revision: questionnaire.revision,
    source_fingerprint: state.data.onboarding.source.fingerprint,
    answers,
  };
}
async function act(action,element) {
  if (action === 'continue-onboarding') {
    state.onboardingMode = true; state.onboardingQuestionnaire = state.data.onboarding.active_questionnaire_id; state.fingerprint = null;
    await refresh(true); return;
  }
  if (action === 'back-onboarding-status') {
    state.onboardingMode = false; state.onboardingQuestionnaire = null; state.onboardingFormDrafts = {}; state.fingerprint = null;
    await refresh(true); return;
  }
  if (action === 'select-onboarding-question') {
    if (!element.dataset.id) return;
    state.onboardingMode = true; state.onboardingQuestionnaire = element.dataset.id; state.fingerprint = null;
    await refresh(true); return;
  }
  if (action === 'save-onboarding-draft' || action === 'review-onboarding-submission') {
    const questionnaire = state.data.onboarding.questionnaires.find(item => item.id === state.onboardingQuestionnaire);
    if (!questionnaire || questionnaire.locked) throw Object.assign(new Error(), { code: questionnaire?.blocked_reason || 'ONBOARDING_QUESTIONNAIRE_LOCKED' });
    const form = document.querySelector('#onboarding-form');
    const answers = onboardingAnswers(questionnaire);
    state.onboardingFormDrafts[questionnaire.id] = { ...answers };
    if (action === 'save-onboarding-draft') {
      if (state.mutation) return;
      state.mutation = true; element.disabled = true;
      try {
        const result = await post('onboarding/drafts', onboardingRequest(questionnaire, answers));
        delete state.onboardingFormDrafts[questionnaire.id];
        showNotice(`Draft saved. Receipt ${result.receipt_id}.`); state.fingerprint = null; await refresh(true);
      } finally { state.mutation = false; element.disabled = false; schedule(); }
      return;
    }
    if (!form.reportValidity()) return;
    const reviewRows = questionnaire.fields.filter(field => field.type !== 'readonly').map(field => {
      const value = answers[field.key];
      return [field.label, field.type === 'checkbox' ? (value ? 'Confirmed' : 'Not confirmed') : esc(value)];
    });
    return openModal('Confirm Replay setup', facts(reviewRows) + `<div class='onboarding-safety-note'>${icon('check')}<span><strong>Non-live only</strong>Ocean records the detected setup and handles its technical evidence automatically. This does not start Sierra or change the strategy.</span></div>`, 'Confirm setup', async () => {
      const result = await post('onboarding/submissions', onboardingRequest(questionnaire, answers));
      delete state.onboardingFormDrafts[questionnaire.id];
      const currentIndex = state.data.onboarding.questionnaires.findIndex(item => item.id === questionnaire.id);
      const nextQuestion = state.data.onboarding.questionnaires[currentIndex + 1] || null;
      state.onboardingQuestionnaire = nextQuestion?.id || null;
      state.onboardingMode = Boolean(nextQuestion);
      history.replaceState({}, '', onboardingHref(state.onboardingQuestionnaire));
      showNotice(`Setup confirmed. Ocean is preparing the Replay test in the background. Receipt ${result.receipt_id}.`);
    });
  }
  if (action === 'retry-onboarding-brain') {
    if (state.mutation) return;
    state.mutation = true; element.disabled = true;
    try {
      await post('onboarding/brain/retry', { outbox_id:element.dataset.id });
      showNotice('Brain synchronization queued for retry.'); state.fingerprint = null; await refresh(true);
    } finally { state.mutation = false; element.disabled = false; schedule(); }
    return;
  }
  if (action === 'register-onboarding') {
    const onboarding = state.data.onboarding;
    return openModal('Prepare Replay test', facts([
      ['Strategy',esc(onboarding.strategy_name)],['Instance',esc(onboarding.instance.configuration_revision)],['Account',esc(onboarding.instance.account_alias)],['Contract',esc(onboarding.instance.symbol)],['Result','Ready for Replay; Sierra remains stopped'],
    ]) + `<label class='check-line'><input id='onboarding-register-confirm' type='checkbox' required>Prepare this strategy for a non-live Replay test.</label>`, 'Prepare test', async form => {
      if (!form.querySelector('#onboarding-register-confirm').checked) throw Object.assign(new Error(), { code:'ONBOARDING_REGISTRATION_CONFIRMATION_REQUIRED' });
      const result = await post('onboarding/register', { strategy_id:onboarding.strategy_id, registration_id:newId('onboarding-registration'), expected_source_fingerprint:onboarding.source.fingerprint, confirmed:true });
      showNotice(`Replay setup prepared. Ocean is finishing its background record ${result.registration_id}.`);
    });
  }
  if (action === 'activate-onboarding') {
    const onboarding = state.data.onboarding;
    const environment = onboarding.activation.environments.find(item => item.environment === element.dataset.environment);
    if (!environment) return;
    return openModal(environment.state === 'PAUSE' ? 'Resume Replay test' : 'Make Replay ready', facts([
      ['Environment','Replay simulation'],['Account',esc(onboarding.instance.account_alias)],['Contract',esc(onboarding.instance.symbol)],['Sierra start','No'],['Live trading','Off'],
    ]) + `<label class='check-line'><input id='activation-confirm' type='checkbox' required>Mark this setup ready for a non-live Replay test.</label>`, environment.state === 'PAUSE' ? 'Resume test' : 'Make ready', async form => {
      if (!form.querySelector('#activation-confirm').checked) throw Object.assign(new Error(), { code:'ONBOARDING_ACTIVATION_CONFIRMATION_REQUIRED' });
      const result = await post('onboarding/activate', { strategy_id:onboarding.strategy_id, activation_id:newId('onboarding-activation'), environment:environment.environment, expected_revision:environment.revision, confirmed:true });
      showNotice(`${result.environment} is ready. Open Replay Monitor to view Ocean data. Start Sierra Replay Two and chart replay separately; this action started neither.`);
    });
  }
  if (['pause-onboarding','deactivate-onboarding','emergency-stop-onboarding'].includes(action)) {
    const onboarding = state.data.onboarding;
    const environment = onboarding.activation.environments.find(item => item.environment === element.dataset.environment);
    if (!environment) return;
    const spec = {
      'pause-onboarding': { route:'onboarding/pause', verb:'Pause', prefix:'onboarding-pause' },
      'deactivate-onboarding': { route:'onboarding/deactivate', verb:'Deactivate', prefix:'onboarding-deactivate' },
      'emergency-stop-onboarding': { route:'onboarding/emergency-stop', verb:'Emergency stop', prefix:'onboarding-emergency-stop' },
    }[action];
    return openModal(`${spec.verb} Replay test`, facts([['Environment','Replay simulation'],['Current state',badge(environment.state)],['Sierra control','Not changed by this action']]) + `<label class='check-line'><input id='activation-control-confirm' type='checkbox' required>I confirm this Replay test state change.</label>`, spec.verb, async form => {
      if (!form.querySelector('#activation-control-confirm').checked) throw Object.assign(new Error(), { code:'ONBOARDING_ACTIVATION_CONFIRMATION_REQUIRED' });
      const result = await post(spec.route, { strategy_id:onboarding.strategy_id, activation_id:newId(spec.prefix), environment:environment.environment, expected_revision:environment.revision, confirmed:true });
      showNotice(`${result.environment} lifecycle updated to ${human(result.state)}.`);
    });
  }
  const openPreparedRun=(operationalRequestId,directReplay=false)=>openRunWizard({modal,request,post,postOperational,esc,human,renderIcons,errorText,strategyId:route().view==='strategies'?route().key:null,operationalRequestId,skipModeChooser:directReplay,onPrepared:async result=>{history.pushState({},'',`/improvement/runs/${result.run_id}`);state.data=null;state.fingerprint=null;showNotice('Run reserved as READY. Sierra has not been started.');await refresh(true);}});
  if(action==='prepare-run')return openPreparedRun(null,route().view==='strategies');
  if(action==='operational-run-review')return openPreparedRun(element.dataset.request);
  if(action==='end-run')return openModal('End run','<div class="field"><label for="run-outcome">Outcome</label><select id="run-outcome"><option value="COMPLETED">Complete after drain</option><option value="CANCELLED">Cancel with partial coverage</option><option value="FAILED">Failed with partial coverage</option></select></div>','Begin drain',async()=>{const body={run_id:state.data.context.run_id,expected_revision:state.data.revision,outcome:document.querySelector('#run-outcome').value};if(state.data.manager?.namespace==='OPERATIONAL')await postOperational('run/end',body);else await post('run-manager/end',body);});
  if(action==='abandon-reprocess')return openModal('Discard unstarted reservation',facts([
    ['Run',esc(state.data.context.run_id)],['Original run',esc(state.data.manager.plan.reprocess_of_run_id)],['Execution','No source observation, lease, progress, evidence or coverage is permitted']
  ])+`<label class='check-line'><input id='abandon-reprocess-confirm' type='checkbox' required>I confirm this unstarted reprocess reservation should be cancelled.</label>`,'Discard reservation',async form=>{
    if(!form.querySelector('#abandon-reprocess-confirm').checked)throw Object.assign(new Error(),{code:'EXPLICIT_REPROCESS_CONFIRMATION_REQUIRED'});
    await postOperational('runs/reprocess/abandon',{run_id:state.data.context.run_id,expected_revision:state.data.revision,reason:'Authenticated pre-start cancellation of an unusable reprocess reservation.'});
    showNotice('The unstarted reprocess reservation was cancelled. Sierra was not started.');await refresh(true);
  });
  if(action==='confirm-no-new-coverage'){
    const data=state.data,manager=data.manager,decisionId=operationalId('no-new-coverage');
    return openModal('Confirm no new coverage',facts([
      ['Completed reprocess',esc(data.context.run_id)],['Original run',esc(manager.plan.reprocess_of_run_id)],['Strategy',esc(data.context.strategy_id)],['Version',esc(data.context.strategy_version)],['Instance',esc(data.context.execution_instance_id)],['Manifest',`${esc(data.context.dataset_manifest_id)} / revision ${esc(data.context.dataset_manifest_revision)}`],['Permitted interval',`${esc(manager.plan.selection.interval.start_utc)} to ${esc(manager.plan.selection.interval.end_utc)}`],['Execution','No new run will be created']
    ])+`<div class='field'><label for='no-new-coverage-reason'>Evidence and reason</label><textarea id='no-new-coverage-reason' required maxlength='1000'></textarea></div><label class='check-line'><input id='no-new-coverage-confirm' type='checkbox' required>I confirm the approved discovery coverage is complete and no new Historical Build interval may be created.</label><p class='subline'>Ocean will recheck the manifest, both completion receipts, all three coverage axes, hashes, leases and reservations before recording an immutable decision.</p>`,'Record decision',async form=>{
      if(!form.querySelector('#no-new-coverage-confirm').checked)throw Object.assign(new Error(),{code:'EXPLICIT_NO_NEW_COVERAGE_CONFIRMATION_REQUIRED'});
      const result=await postOperational('runs/no-new-coverage',{decision_id:decisionId,reprocess_run_id:data.context.run_id,expected_revision:data.revision,confirmed:true,reason:form.querySelector('#no-new-coverage-reason').value});
      showNotice(`No new coverage recorded. Decision ${result.decision_id}; no run was created.`);
    });
  }
  if(action==='reprocess-history'){
    const data=state.data,context=data.context,manager=data.manager,runId=buildReprocessRunId(context,manager),processingId=`processing-${crypto.randomUUID()}`;
    return openModal('Reprocess Existing History',facts([
      ['Original run',esc(context.run_id)],['Strategy',esc(context.strategy_id)],['Version',esc(context.strategy_version)],['Instance',esc(context.execution_instance_id)],['Dataset',`${esc(context.dataset_manifest_id)} / revision ${esc(context.dataset_manifest_revision)}`],['Interval',`${esc(manager.plan.selection.interval.start_utc)} to ${esc(manager.plan.selection.interval.end_utc)}`],['Code hash',hash(context.strategy_code_hash)],['Configuration hash',hash(context.strategy_config_hash)],['Canonical / processing counts',`${esc(manager.unique_canonical_count)} / ${esc(manager.processing_count)}`],['New processing ID',esc(processingId)],['Execution','READY only; Sierra is not started']
    ])+`<label class='check-line'><input id='reprocess-confirm' type='checkbox' required>I confirm the same governed interval, strategy, configuration and dataset for a new processing pass.</label><p class='subline'>The original run and canonical trade identity remain unchanged. Normal ingestion stays off and LIVE_REAL remains disabled.</p>`,'Create reprocess run',async form=>{
      if(!form.querySelector('#reprocess-confirm').checked)throw Object.assign(new Error(),{code:'EXPLICIT_REPROCESS_CONFIRMATION_REQUIRED'});
      const result=await postOperational('runs/reprocess',{source_run_id:context.run_id,run_id:runId,processing_id:processingId,expected_revision:data.revision,confirmed:true,reason:'Authenticated S43.3 confirmation to reprocess the exact completed governed history.'});
      history.pushState({},'',`/improvement/runs/${result.run_id}`);state.data=null;state.fingerprint=null;showNotice('Reprocess run reserved as READY. Sierra has not been started.');await refresh(true);
    });
  }
  if(action==='operational-release-review'){
    const row=state.data.operational_releases.find(value=>value.request_id===element.dataset.request),review=row.review,context=review.context;
    return openModal('Review operational dataset release',facts([
      ['Strategy',esc(context.strategy_id)],['Version',esc(context.strategy_version)],['Instance',esc(context.execution_instance_id)],['Purpose',esc(human(context.evidence_purpose))],['Dataset',`${esc(context.dataset_manifest_id)} / revision ${esc(context.dataset_manifest_revision)}`],['Manifest hash',hash(review.manifest_hash)],['Code hash',hash(context.strategy_code_hash)],['Configuration hash',hash(context.strategy_config_hash)],['Workflow profile',hash(review.profile_hash)],['Observed profile',hash(review.observed_profile_hash)],['Onboarding decision',esc(row.lineage.source_decision_id)],['Interval',`${esc(review.interval.start_utc)} to ${esc(review.interval.end_utc)}`],['Exposure',esc(human(review.prior_exposure))],['Run creation','No'],['RUN_RELEASE','Not granted']
    ])+`<div class='field'><label for='operational-decision'>Decision</label><select id='operational-decision'><option value='APPROVED'>Approve dataset release</option><option value='REJECTED'>Reject</option></select></div><div class='field'><label for='operational-reason'>Reason</label><textarea id='operational-reason' required maxlength='1000'></textarea></div>`,'Record decision',async form=>{
      const decision=form.querySelector('#operational-decision').value;
      await postOperational('decisions',{review,review_hash:review.review_hash,decision_id:operationalId('dataset-release'),scope:'DATASET_RELEASE',decision,reason:form.querySelector('#operational-reason').value});
      if(decision==='APPROVED')await postOperational('dataset-releases',{review,review_hash:review.review_hash});
      showNotice(decision==='APPROVED'?'Dataset released for TEST run selection. No run was created.':'Dataset release rejected.');
    });
  }
  if(action==='operational-release-apply'){
    const row=state.data.operational_releases.find(value=>value.request_id===element.dataset.request);
    await postOperational('dataset-releases',{review:row.review,review_hash:row.review.review_hash});
    showNotice('Dataset released for TEST run selection. No run was created.');await refresh(true);return;
  }
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
  const replayMonitor = event.target.closest('[data-replay-monitor]');
  if (replayMonitor) {
    sessionStorage.setItem(replayMonitorOpenedKey, new Date().toISOString());
    const status = document.querySelector('[data-replay-monitor-state]');
    if (status) status.innerHTML = badge('OPENED_FROM_THIS_BROWSER');
  }
  const action = event.target.closest('[data-action]');
  if (action) { event.preventDefault(); void act(action.dataset.action,action).catch(error => { if (error.status === 401 || ['WAYNE_LOCAL_ENROLLMENT_REQUIRED','WORKFLOW_CONFIG_BLOCKED','WORKFLOW_DISABLED'].includes(error.code)) signIn(errorText(error)); else showNotice(errorText(error)); }); return; }
  const anchor = event.target.closest('a[href^="/improvement/"]');
  if (!anchor || event.ctrlKey || event.metaKey || event.shiftKey || event.button !== 0) return;
  if (anchor.hasAttribute('data-onboarding-native')) return;
  event.preventDefault(); history.pushState({},'',anchor.getAttribute('href')); state.offset = 0; state.filter = ''; state.data = null; state.fingerprint = null; state.onboardingMode = false; state.onboardingQuestionnaire = null; state.onboardingFormDrafts = {}; showNotice('');
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
window.addEventListener('popstate',() => { const questionnaire = new URLSearchParams(location.search).get('onboarding'); state.offset = 0; state.filter = ''; state.data = null; state.fingerprint = null; state.onboardingMode = Boolean(questionnaire); state.onboardingQuestionnaire = questionnaire; state.onboardingFormDrafts = {}; void refresh(true); });
document.addEventListener('visibilitychange',() => { if (!document.hidden) void refresh(true); });
renderIcons(); void refresh(true);
