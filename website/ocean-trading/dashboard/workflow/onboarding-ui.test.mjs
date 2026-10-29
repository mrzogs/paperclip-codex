import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { issueOceanIdentity, issueTestBrowserSecret } from './auth.mjs';
import { WorkflowBackend } from './backend.mjs';
import { sealedHash } from './common.mjs';
import { loadVwapPhysicalComparatorApprovalDispatchConfig } from './vwap-physical-comparator-approval-dispatch.mjs';
import { DEFAULT_VWAP_PHYSICAL_COMPARATOR_CONTRACT } from './vwap-physical-comparator-contract.mjs';
import { handleVwapImprovementRequest } from './vwap-improvement-status.mjs';

const dispatchConfig = loadVwapPhysicalComparatorApprovalDispatchConfig();
const TEST_COMPANY_ID = dispatchConfig.paperclip.company_id;
const TEST_STRATEGY_ID = 'cicd-vwap-pull-back-strategy';
const TEST_APPROVAL_ID = 'd6bb0adb-2704-4e44-8aa8-011ee2b9baee';
const TEST_COMPARATOR_APPROVAL_ID = '11111111-1111-4111-8111-111111111111';
const TEST_RELEASE_APPROVAL_ID = '22222222-2222-4222-8222-222222222222';
const TEST_STAGING_APPROVAL_ID = '55555555-5555-4555-8555-555555555555';
const TEST_STAGING_ATTACHMENT_ID = '66666666-6666-4666-8666-666666666666';

const sources = {
  'strategy-registry.json': { strategy_id:TEST_STRATEGY_ID, strategy_name:'E2E Disposable Test Strategy', profile_id:'profile-1', profile_version:'v0.1.1', profile_hash:'sha256:profile', baseline_version:'v0.1.0', production_version:null, activation_status:'PENDING_ONBOARDING', activation_decision_id:null },
  'strategy-profile.json': { strategy_id:TEST_STRATEGY_ID, strategy_name:'E2E Disposable Test Strategy', profile_id:'profile-1', profile_version:'v0.1.1', profile_hash:'sha256:profile', baseline_version:'v0.1.0', production_version:null, strategy_code_hash:'sha256:code', strategy_config_hash:'sha256:config', onboarding_status:'PENDING_ONBOARDING' },
  'execution-instance.json': { strategy_id:TEST_STRATEGY_ID, execution_instance_id:'test-replay-two', configuration_revision:'v0.1.1-chart-alert-cleanup', account_alias:'Sim1', symbol:'MNQZ26_FUT_CME[M]', capabilities:[], status:'PREPARED_NOT_REGISTERED', safety_state:{ trade_simulation_mode:true, strategy_automated_order_placement:false, telemetry_logging:false, brain_submission:'OFF', replay_started:false } },
  'replay-two-setup.json': { strategy_id:TEST_STRATEGY_ID, configuration_revision:'v0.1.1-chart-alert-cleanup', status:'PREPARED_NOT_ACTIVATED', last_verified_at:'2026-09-29T07:14:21Z', safety:{ replay_started:false, paper_started:false, live_started:false } },
  'unresolved-items.json': { strategy_id:TEST_STRATEGY_ID, status:'OPEN', items:[
    { id:'U01', owner:'Wayne', resolution_action:'Assign owner.' }, { id:'U03', owner:'Wayne', resolution_action:'Approve contract.' },
    { id:'U18', owner:'Wayne', resolution_action:'Approve risk.' }, { id:'U22', owner:'Wayne/Ocean operator', resolution_action:'Enroll telemetry.' },
    { id:'U23', owner:'Wayne/Ocean operator', resolution_action:'Approve database policy.' }, { id:'U27', owner:'Wayne/strategy maintainer', resolution_action:'Reconcile versions.' },
    { id:'U24', owner:'Wayne/Data owner', resolution_action:'Qualify data.' }, { id:'U25', owner:'Wayne', resolution_action:'Approve thresholds.' },
    { id:'U26', owner:'Wayne/Ocean operator', resolution_action:'Approve non-live capabilities.' },
  ] },
  'replay-two-alert-remediation.json': { strategy_id:TEST_STRATEGY_ID, verified_through:'2026-09-29T07:14:21Z', diagnosis:{ dll_rebuild_required:false }, fix:{ alerts_enabled:false }, validation:{ automated_order_placement:false, telemetry_logging:false } },
  'priority-completion-program.json': { schema_version:'cicd-vwap-priority-completion-program/v1', strategy_id:TEST_STRATEGY_ID, program_id:'test-priority-program', status:'IN_PROGRESS_POST_DISCOVERY_REVIEW', priority:'CRITICAL', authorization:{ live_real:'PROHIBITED' }, current_runtime_contracts:{ replay:'MNQH26_FUT_CME', paper:'MNQZ26_FUT_CME' }, next_governed_action:{ title:'Review discovery and decide whether to freeze a candidate', owner:'Wayne with Ocean Trading', action:'Either freeze one new isolated candidate for backward regression or record NO_CHANGE.', automatic_action:'NONE_UNTIL_CANDIDATE_FREEZE', reason:'Non-discovery data remains sealed until candidate freeze.' }, current_acceptance_assessment:{ assessed_at:'2026-10-02T22:39:20Z', promotion_disposition:'NO_AUTOMATIC_PROMOTION', pending:[{ gate:'FROZEN_DATASET_LADDER_FULLY_QUALIFIED', title:'Acquire MNQZ25 history for backward regression', blocker:'The required segment is absent.', owner:'Coordinator', resolution_action:'Acquire the exact MNQZ25 SCID segment before backward regression.' }] }, workstreams:[{ id:'W5', name:'Paper simulation operation', owner:'Coordinator', status:'ACTIVE_SIM1_V234_V0532_VERIFIED_FLAT_CONNECTED', next_action:'Continue non-promotional Paper observation on Sim1.', exit:'Paper safety verified.' }] },
  'autonomous-continuous-improvement-program.json': { schema_version:'cicd-vwap-autonomous-continuous-improvement-program/v1', strategy_id:TEST_STRATEGY_ID, program_id:'test-autonomous-program', status:'ACTIVE_IMPLEMENTATION', priority:'CRITICAL', authorization:{ live_real:'PROHIBITED', real_order_routing:'PROHIBITED' }, fixed_boundaries:{ live_real_enabled:false, automatic_approval_enabled:false, production_version:null }, pipeline:[{ id:'P01', name:'Evidence ingestion and identity binding', status:'PROVEN', acceptance:'Every source is attributable.' },{ id:'P02', name:'Causal telemetry enrichment', status:'IMPLEMENTING', acceptance:'Causal fields are complete.' }], acceptance_gates:{ total:2, complete:1, implementing:1, pending:0 }, controller:{ canonical_version:'v0.2.0-cicd-vwap', deployment_receipt:'onboarding/controller-v020-replay-two-deployment-receipt.json' }, known_blockers:[{ id:'B01', status:'WORKAROUND_IN_PROGRESS', blocker:'Local-only controller CI integration is pending.', resolution:'Run the repository validation suite locally.' }], required_human_approvals:[{ approval_id:TEST_APPROVAL_ID, title:'Approve the dedicated coordinator', purpose:'Coordinator hiring gate' }], latest_verified_overlay_20261020:{ prospective_paper_provenance_diagnosis:{ required_remedy:'APPROVE_GENUINE_PAPER_RUN_AND_DATASET_MANIFEST;_BIND_SIX_SOURCE_INPUTS;_FIX_PROSPECTIVE_TELEMETRY_RUN_ID_PROPAGATION', telemetry_run_id_repair:{ status:'CODE_MERGED_NOT_DEPLOYED', version:'v0.5.53', pull_request:'https://github.com/mrzogs/sierra-trade-telemetry-logger/pull/21', merge_commit:'2bdcb5c2646d261d18f3b6cbd27083ff7dcea714', dll_sha256:'5B30CC3971184DAFD8A4E8A002FE63D588ADD9F416600BCD12292675242D110C', verification:'71 passed, 1 skipped; native attribution harness PASS.', deployed_to_paper:false, paper_qualified:false } } }, next_action:`Continue after approval ${TEST_APPROVAL_ID} and exact route verification.` },
};

function writeSources(root) {
  for (const [name, value] of Object.entries(sources)) fs.writeFileSync(path.join(root, name), JSON.stringify(value));
}

test('complete onboarding is actionable in the browser without touching production data', { timeout:120_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocean-onboarding-ui-'));
  const sourceRoot = path.join(root, 'sources'); fs.mkdirSync(sourceRoot); writeSources(sourceRoot);
  const physicalComparatorPath = path.join(root, 'physical-comparator.json');
  const physicalComparator = JSON.parse(fs.readFileSync(DEFAULT_VWAP_PHYSICAL_COMPARATOR_CONTRACT, 'utf8'));
  physicalComparator.required_human_approvals[0].approval_id = TEST_COMPARATOR_APPROVAL_ID;
  physicalComparator.required_human_approvals[1].approval_id = TEST_RELEASE_APPROVAL_ID;
  physicalComparator.document_hash = sealedHash(physicalComparator, 'document_hash');
  fs.writeFileSync(physicalComparatorPath, JSON.stringify(physicalComparator));
  const improvementMonitorState = path.join(root, 'vwap-improvement-monitor-state.json');
  fs.writeFileSync(improvementMonitorState, JSON.stringify({
    schema_version:'ocean-vwap-continuous-improvement-monitor-state/v1', strategy_id:TEST_STRATEGY_ID,
    enabled:true, status:'HEALTHY', disposition:'INSUFFICIENT_EVIDENCE', database_query_count:3,
    last_database_interrogation_at_utc:'2026-10-05T12:00:00Z', observed_trade_count:245,
    eligible_trade_count:0, new_trade_count:0, sources:[{ id:'replay-two', environment:'REPLAY', account:'Sim1',
      database_path:'D:\\Trading\\CICD\\runtime\\cicd-vwap-pull-back-strategy\\ReplayTwo-v013\\test.sqlite', observed_trade_count:239, eligible_trade_count:0 }],
  }));
  const approvalDispatchState = path.join(root, 'vwap-approval-dispatch-state.json');
  fs.writeFileSync(approvalDispatchState, JSON.stringify({
    schema_version:'ocean-vwap-physical-comparator-approval-dispatch-state/v1', strategy_id:TEST_STRATEGY_ID,
    enabled:true, status:'PREFLIGHT_BLOCKED_PHYSICAL_BINDING', checked_at_utc:'2026-10-20T13:33:06Z',
    approval_statuses:{DATASET_PHYSICAL_SELECTION:'APPROVED',RUN_RELEASE:'APPROVED'},approval_statuses_source:'PAPERCLIP_LIVE',
    continuity:{schema_version:'ocean-vwap-continuity-projection/v1',source:'PAPERCLIP_LIVE',observed_at_utc:new Date().toISOString(),freshness:{state:'CURRENT'},
      human_authority_blocker:{issue_id:'03390c6f-bbe2-4972-9183-ea349406160f',identifier:'OCEA-28',title:'Route exact source authority and supervised host integration for OCEA-24',status:'BLOCKED',
        owner_name:'Mara Vale - Quant Lab Coordinator',url:'http://127.0.0.1:3100/OCEA/issues/OCEA-28',worker:{state:'NOT_OBSERVED'},recovery_required:true,
        recovery_action:'Answer the pending Paperclip question.',human_interaction:{id:'27e9d62e-f900-4b86-8eb1-388ce37bf210',kind:'ask_user_questions',status:'PENDING',
          title:'Identify exact Telemetry and host authority',continuation_policy:'wake_assignee',owner:'Wayne / Paperclip board',
          action:'Answer the pending Paperclip question. Paperclip must then wake the assigned issue owner; Ocean only verifies that continuation and grants no runtime authority.',
          questions:[{id:'authority',prompt:'Select the source-authority handoff route and provide the named authorized Telemetry/Windows host principal.',selection_mode:'single',options:[
            {id:'snapshot',label:'Owner supplies immutable snapshot',description:'Owner supplies Stage source and custody evidence; agents stay root-bound.'},
            {id:'authorized-owner',label:'Existing authorized owner patches source',description:'Name the authorized repository owner and exact workspace.'},
          ]}]}},
      next_automatic_job:null,
      issue_chain:[{identifier:'OCEA-24',title:'Build approval-bound host staging executor for OCEA-22',status:'BLOCKED'},{identifier:'OCEA-28',title:'Route exact source authority and supervised host integration for OCEA-24',status:'BLOCKED',pending_interaction_id:'27e9d62e-f900-4b86-8eb1-388ce37bf210'}],
      authority:{instance_admission:'NOT_PROVEN',current_exclusive_booking:'NOT_PROVEN',booking_requirement:'Atomic current owner/generation, expiry and revocation readback is required.',
        per_run_manifest:'POST_STAGING_BINDING_NOT_AUTHORIZED',future_gate:'One consolidated post-staging run/measurement decision after physical and controller proof.',test_standing_policy:'NOT_GRANTED'}},
    heartbeat_run_id:'6971a2a5-2a42-4801-b8cc-6c98ccd1df71', heartbeat_run_status:'succeeded',
    preflight_outcome:{ status:'BLOCKED_PHYSICAL_BINDING_MISMATCH', heartbeat_run_id:'6971a2a5-2a42-4801-b8cc-6c98ccd1df71',
      completed_at_utc:'2026-10-20T13:32:41.930Z', brain_record_id:'reasoning-20261020133145-7184475e', supplemental_brain_record_id:'reasoning-20261020133945-6dfa3012', account_alias:'Sim1',
      strategy_artifact:{ saved_version:'v0.6.240', saved_hash:'sha256:'+'9'.repeat(64), selected_version:'v0.6.238', selected_hash:'sha256:'+'6'.repeat(64) },
      telemetry_artifact:{ saved_version:'v0.5.52', saved_hash:'sha256:'+'c'.repeat(64), selected_version:'v0.5.53', selected_hash:'sha256:'+'5'.repeat(64) },
      next_task:{ issue_id:'33333333-3333-4333-8333-333333333333', issue_identifier:'OCEA-22', title:'Prepare exact Sim1 TEST staging package', status:'IN_PROGRESS', execution_run_id:'44444444-4444-4444-8444-444444444444', url:'http://127.0.0.1:3100/OCEA/issues/OCEA-22' } },
    staging_authority:{ authoritative:true, approval_id:TEST_STAGING_APPROVAL_ID, approval_status:'APPROVED', action_required:false,
      approval_url:`http://127.0.0.1:3100/OCEA/approvals/${TEST_STAGING_APPROVAL_ID}`, requested_by_agent_id:'75618a1a-a7ba-44bd-b391-48d58617433c', decided_at_utc:'2026-10-21T06:49:09Z',
      title:'CICD Sim1 TEST only: exact v238 / v0.5.53 staging and one gated diagnostic start', approval_scope:'TEST_STAGING_WRITE_SINGLE_DIAGNOSTIC_START_ONLY',
      attachment_id:TEST_STAGING_ATTACHMENT_ID, package_url:`http://127.0.0.1:3100/api/attachments/${TEST_STAGING_ATTACHMENT_ID}/content`,
      package_sha256:'8'.repeat(64), package_bytes:32265, package_recovery:'BYTE_IDENTICAL_SHA256_VERIFIED', database_rule:'No database edit authority.',
      excluded:'RUN_RELEASE materialization, playback, bridge activation, Paper/Live, real orders, historical role/row edits, threshold selection', risks:['Fresh proof remains required.'],
      timeframe:{bar_seconds:300,display:'5 minutes',authority:'v0.6.238 source and current governed CICD profile',one_minute_disposition:'SUPERSEDED_UNQUALIFIED_OBSERVATION_SETUP'},
      mutable_reference:{path:'C:\\Users\\wayne\\OneDrive\\Documents\\Brady - Optimization\\onboarding\\replay-discovery-requalification-20261020.json',captured_sha256:'2'.repeat(64),classification:'INFORMATIONAL_SNAPSHOT_NOT_PHYSICAL_PREFLIGHT_PIN',fresh_reauthentication_required:true},
      continuation:{requester_agent_id:'75618a1a-a7ba-44bd-b391-48d58617433c',approval_resolution_wakes_requester:true,next_action:'REAUTHENTICATE_PACKAGE_AND_DERIVE_ONLY_EXACT_APPROVED_FILESYSTEM_SCOPE',no_ocean_approval_authority:true,state:'BLOCKED_BY_PAPERCLIP_HUMAN_AUTHORITY',blocker_issue_identifier:'OCEA-28',interaction_id:'27e9d62e-f900-4b86-8eb1-388ce37bf210'} },
    gate:{ action:'READ_ONLY_PREFLIGHT_ONLY', current_permission_state:'READ_ONLY_EXTERNAL_EVIDENCE_NO_REPLAY_RUNTIME_WRITE',
      post_preflight_gate:'EXACT_TEST_REPLAY_TWO_RUNTIME_OUTPUT_WRITE_START_SCOPE_REQUIRED', post_preflight_action:'REQUEST_OR_DERIVE_ONLY_AFTER_READ_ONLY_PREFLIGHT' },
    safety:{ execution_authority:false, runtime_write_scope_authorized:false, replay_start_authorized:false,
      paper_authorized:false, live_authorized:false, automatic_approval_enabled:false },
  }));
  const publicRoot = path.resolve('public/workflow');
  const environment = {};
  let backend;
  let approvalMode = 'approved';
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (url.pathname === '/api/vwap-improvement-monitor/status') {
      void handleVwapImprovementRequest(request,response,url,{loadConfigured:async()=>({ingestion:{status:'NOT_CONFIGURED'},reports:{}})});
      return;
    }
    if (url.pathname === `/api/approvals/${TEST_APPROVAL_ID}`) {
      response.setHeader('Content-Type','application/json');
      response.end(JSON.stringify({ id:TEST_APPROVAL_ID, companyId:TEST_COMPANY_ID, type:'hire_agent', status:'approved', payload:{ name:'CICD VWAP Recovery Coordinator' }, createdAt:'2026-10-19T15:46:53.575Z', decidedAt:'2026-10-20T09:51:07.457Z' }));
      return;
    }
    if ([TEST_COMPARATOR_APPROVAL_ID,TEST_RELEASE_APPROVAL_ID].some(id => url.pathname === `/api/approvals/${id}`)) {
      const approvalId = url.pathname.split('/').at(-1);
      response.setHeader('Content-Type','application/json');
      if (['denied','unavailable'].includes(approvalMode)) { response.writeHead(approvalMode === 'denied' ? 403 : 503); response.end('{}'); return; }
      response.end(JSON.stringify({ id:approvalId, companyId:approvalMode === 'company' ? 'other-company' : TEST_COMPANY_ID, type:'request_board_approval', status:approvalMode === 'pending' ? 'pending' : 'approved', payload:{
        strategy_id:TEST_STRATEGY_ID, namespace:'TEST', contract_id:physicalComparator.contract_id,
        contract_hash:approvalMode === 'contract' ? 'changed' : physicalComparator.contract_hash,
        context_hash:physicalComparator.run_context.context_hash, run_id:physicalComparator.run_context.run_id,
        decision_scope:approvalId === TEST_COMPARATOR_APPROVAL_ID ? 'DATASET_PHYSICAL_SELECTION' : 'RUN_RELEASE',
        output_root:dispatchConfig.staging_authority.continuation.run_release_output_root,
        title:approvalId === TEST_COMPARATOR_APPROVAL_ID
          ? 'Approve v0.6.238 TEST dataset and physical comparator selection'
          : 'Approve create-new v0.6.238 Sep-2025 Z25 TEST RUN_RELEASE',
      }, createdAt:'2026-10-20T12:00:00Z', decidedAt:'2026-10-20T13:30:17.602Z' }));
      return;
    }
    if (url.pathname.startsWith('/api/workflow/')) { void backend.handle(request, response, url); return; }
    if (url.pathname === '/replay-monitor.html') { response.setHeader('Content-Type','text/html'); response.end('<!doctype html><main><h1>Replay Monitor</h1></main>'); return; }
    if (url.pathname === '/assets/ocean-trading-icon.png') { response.setHeader('Content-Type','image/png'); response.end(fs.readFileSync(path.join(publicRoot, '../assets/ocean-trading-icon.png'))); return; }
    const file = url.pathname.startsWith('/workflow/') ? url.pathname.slice('/workflow/'.length) : 'index.html';
    if (!['index.html','ui.js','ui.css','icons.js','reprocess-identity.js','run-wizard.js','onboarding-help.js','vwap-improvement-view.js'].includes(file)) { response.writeHead(404).end(); return; }
    response.setHeader('Cache-Control','no-store');
    response.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
    response.end(fs.readFileSync(path.join(publicRoot, file)));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  environment.PAPERCLIP_API = `${base}/api`;
  const strategyIds = [TEST_STRATEGY_ID]; const instanceIds = ['test-replay-two'];
  const config = {
    db_file:path.join(root,'workflow.sqlite'), test_only:true, contract_release:'2.1.0', allowed_origins:[base], lease_ms:30000,
    python_executable:'python', strategy_onboarding_root:sourceRoot, strategy_improvement_monitor_state:improvementMonitorState,
    strategy_physical_comparator_contract:physicalComparatorPath, strategy_approval_dispatch_state:approvalDispatchState, onboarding_brain_sync:{ enabled:false },
    strategy_onboarding_runtime_probe:() => ({
      monitor:{ state:'AVAILABLE', url:'/replay-monitor.html' },
      sierra:{ state:'OPEN_EXACT_CHARTBOOK_VERIFIED', executable:'D:\\Trading\\SierraChart-Replay Two\\SierraChart_64.exe', chartbook_path:'D:\\Trading\\SierraChart-Replay Two\\Data\\CICD - VWAP Pull Back Strategy.Cht', chart_id:'1', process_id:123, window_title:'CICD - VWAP Pull Back Strategy' },
      chart_replay:{ state:'NOT_RUNNING_VERIFIED', started:false, observed_at_utc:'2026-09-30T09:00:00Z', source:'test-controller' },
      manual_launch:{ available:false, reason:'NO_SAFE_DESKTOP_LAUNCH_BRIDGE', executable:'D:\\Trading\\SierraChart-Replay Two\\SierraChart_64.exe', chartbook_path:'D:\\Trading\\SierraChart-Replay Two\\Data\\CICD - VWAP Pull Back Strategy.Cht', account_alias:'Sim1', chart_id:'1' },
    }),
    browser:{ subject_id:'wayne-ocean-ui', credential_ref:'OCEAN_WAYNE_BROWSER_SECRET' },
    identities:['BRAIN','TELEMETRY','STRATEGY'].map(role => issueOceanIdentity({ identity_id:`ocean-onboarding-${role.toLowerCase()}`, role, namespace:'TEST', credential_ref:`OCEAN_${role}_TOKEN`, strategy_ids:strategyIds, instance_ids:instanceIds }, environment, new Date(Date.now()+3600000).toISOString())),
  };
  issueTestBrowserSecret(environment, config.browser.credential_ref);
  backend = new WorkflowBackend(config, environment);
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  const page = await browser.newPage({ viewport:{ width:1440, height:950 } });
  const browserErrors = []; page.on('pageerror', error => browserErrors.push(error.message));
  try {
    assert.equal((await page.request.get(`${base}/api/workflow/session`)).status(),401,'direct API access must still require a protected session');
    await page.goto(`${base}/improvement/strategies/${TEST_STRATEGY_ID}`);
    assert.match(await page.locator('script[type="module"]').getAttribute('src'),/vwap-proof-separated-20261029-r1/,'the deployed page must request the current workflow module with automatic local access');
    await expect(page.locator('#login')).toHaveCount(0);
    await expect(page.locator('#logout')).toHaveCount(0);
    await expect(page.getByRole('heading',{ name:'E2E Disposable Test Strategy', exact:true })).toBeVisible();
    const evidencePanel=page.locator('#vwap-improvement-evidence-panel');
    await expect(evidencePanel.getByRole('heading',{name:'Strategy improvement loop',exact:true})).toBeVisible();
    await expect(evidencePanel).toContainText('stalled');
    assert.equal(await evidencePanel.evaluate(element=>Boolean(element.compareDocumentPosition(
      [...document.querySelectorAll('h2')].find(heading=>heading.textContent==='CI/CD continuous run')) & Node.DOCUMENT_POSITION_FOLLOWING)),true,
    'current proof status must precede the historical foundation/campaign section');
    assert.equal((await page.request.get(`${base}/api/workflow/session`)).status(),200,'the landing page must establish the protected local session automatically');
    await page.getByRole('link',{ name:'Help', exact:true }).click();
    await expect(page.getByRole('heading',{ name:'Onboarding help', exact:true })).toBeVisible();
    await expect(page.getByRole('heading',{ name:'Confirm the detected test setup', exact:true })).toBeVisible();
    await expect(page.getByRole('cell',{ name:/Strategy rules/ }).first()).toBeVisible();
    await expect(page.getByRole('heading',{ name:'Testing and learning journey', exact:true })).toBeVisible();
    await page.setViewportSize({ width:390, height:844 });
    await expect(page.getByRole('heading',{ name:'Onboarding help', exact:true })).toBeVisible();
    const mobileViewportFits = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
    assert.equal(mobileViewportFits,true,'onboarding help must not overflow the mobile viewport');
    await page.setViewportSize({ width:1440, height:950 });
    await page.getByRole('link',{ name:'Back to strategies', exact:true }).click();
    await page.getByRole('link',{ name:'E2E Disposable Test Strategy', exact:true }).click();
    await expect(page.getByRole('heading',{ name:'Required human approvals', exact:true })).toBeVisible({ timeout:10_000 });
    await expect(page.getByRole('heading',{ name:'CICD VWAP Recovery Coordinator', exact:true })).toBeVisible();
    await expect(page.getByText('Approved',{ exact:true }).last()).toBeVisible();
    await expect(page.locator(`[data-approval-id="${TEST_APPROVAL_ID}"]`).getByRole('link',{ name:'Open approval record', exact:true })).toHaveAttribute('href',`${base}/OCEA/approvals/${TEST_APPROVAL_ID}`);
    await expect(page.getByRole('heading',{ name:'Physical comparator approvals', exact:true })).toBeVisible();
    await expect(page.getByRole('heading',{ name:'Approve v0.6.238 TEST dataset and physical comparator selection', exact:true })).toBeVisible();
    await expect(page.getByRole('heading',{ name:'Approve create-new v0.6.238 Sep-2025 Z25 TEST RUN_RELEASE', exact:true })).toBeVisible();
    await expect(page.locator(`[data-approval-id="${TEST_COMPARATOR_APPROVAL_ID}"]`).getByRole('link',{ name:'Open approval record', exact:true })).toHaveAttribute('href',`${base}/OCEA/approvals/${TEST_COMPARATOR_APPROVAL_ID}`);
    await expect(page.locator(`[data-approval-id="${TEST_RELEASE_APPROVAL_ID}"]`).getByRole('link',{ name:'Open approval record', exact:true })).toHaveAttribute('href',`${base}/OCEA/approvals/${TEST_RELEASE_APPROVAL_ID}`);
    await expect(page.getByText('Approved in Paperclip',{ exact:true })).toBeVisible();
    await expect(page.getByRole('heading',{name:'Current Paperclip action',exact:true})).toBeVisible();
    await expect(page.getByRole('heading',{name:'Identify exact Telemetry and host authority',exact:true})).toBeVisible();
    await expect(page.getByText('Select the source-authority handoff route and provide the named authorized Telemetry/Windows host principal.',{exact:true})).toBeVisible();
    await expect(page.getByText('Owner supplies immutable snapshot',{exact:true})).toBeVisible();
    await expect(page.getByText('Existing authorized owner patches source',{exact:true})).toBeVisible();
    await expect(page.getByRole('link',{name:'OCEA-28',exact:true})).toHaveAttribute('href','http://127.0.0.1:3100/OCEA/issues/OCEA-28');
    await expect(page.getByText('Candidate detection: waiting for eligible trades (0 eligible / 245 observed).',{exact:true})).toBeVisible();
    await expect(page.getByText('Approved',{ exact:true }).last()).toBeVisible();
    await expect(page.getByRole('heading',{ name:'Read-only preflight complete — blocked', exact:true })).toBeVisible();
    await expect(page.getByRole('link',{ name:'OCEA-22', exact:true })).toHaveAttribute('href','http://127.0.0.1:3100/OCEA/issues/OCEA-22');
    await expect(page.getByRole('heading',{ name:'CICD Sim1 TEST only: exact v238 / v0.5.53 staging and one gated diagnostic start', exact:true })).toBeVisible();
    await expect(page.locator(`[data-approval-id="${TEST_STAGING_APPROVAL_ID}"]`).getByRole('link',{ name:'Open approval record', exact:true })).toHaveAttribute('href',`http://127.0.0.1:3100/OCEA/approvals/${TEST_STAGING_APPROVAL_ID}`);
    await expect(page.getByRole('link',{ name:'Open sealed package', exact:true }).first()).toHaveAttribute('href',`http://127.0.0.1:3100/api/attachments/${TEST_STAGING_ATTACHMENT_ID}/content`);
    await expect(page.getByText('5 minutes (300 seconds) · Superseded unqualified observation setup',{ exact:true })).toBeVisible();
    await expect(page.getByText(/mutable requalification draft hash is informational only/)).toBeVisible();
    await expect(page.getByText('v0.1.1 / v0.6.234-absolute-risk-gate-candidate',{ exact:true })).toBeVisible();
    await expect(page.getByText('Distinct unselected unchanged',{ exact:true })).toBeVisible();
    await expect(page.getByRole('heading',{ name:'Event-driven evidence monitor', exact:true })).toBeVisible();
    await expect(page.getByText('Codex polling',{ exact:true })).toBeVisible();
    await expect(page.getByText('Not required',{ exact:true }).first()).toBeVisible();
    await expect(page.getByText('245',{ exact:true })).toBeVisible();
    await expect(page.getByText(/ReplayTwo-v013\\test.sqlite/)).toBeVisible();
    await expect(page.getByRole('link',{ name:'Open Replay setup confirmed', exact:true })).toBeVisible();
    await page.getByRole('link',{ name:'Open Replay setup confirmed', exact:true }).click();
    await expect(page).toHaveURL(/onboarding=test-setup-confirmation/);
    await expect(page.getByRole('heading',{ name:'Confirm the detected test setup', exact:true })).toBeVisible();
    await expect(page.getByRole('link',{ name:'Help', exact:true }).last()).toHaveAttribute('href','/improvement/onboarding-guide#test-setup-confirmation');
    await page.getByRole('checkbox',{ name:'Use this detected setup for a non-live Replay test', exact:true }).check();
    await page.getByRole('button',{ name:'Confirm setup', exact:true }).click();
    await expect(page.getByRole('heading',{ name:'Confirm Replay setup', exact:true })).toBeVisible();
    await page.getByRole('button',{ name:'Confirm setup', exact:true }).last().click();
    await expect(page.locator('#notice')).toContainText('Setup confirmed');
    await expect(page).not.toHaveURL(/onboarding=/);
    await expect(page.getByRole('heading',{ name:'Finish the simple setup', exact:true })).toBeVisible();
    await expect(page.getByText('Ocean is recording the confirmed setup. Refresh when synchronization is complete.',{ exact:true })).toBeVisible();
    assert.equal(backend.db.prepare("SELECT COUNT(*) AS n FROM ow_events WHERE action='onboarding.submit' AND json_extract(payload_json,'$.payload.questionnaire_id')='test-setup-confirmation'").get().n,1);
    backend.db.prepare("UPDATE ow_onboarding_brain_outbox SET state='ACKNOWLEDGED',brain_record_id='reasoning-browser-test',brain_relative_path='reasoning/reasoning-browser-test.md',acknowledged_at_utc=?").run(new Date().toISOString());
    await page.locator('#refresh').click();
    await expect(page.getByRole('button',{ name:'Prepare Replay test', exact:true }).first()).toBeVisible();
    await page.getByRole('button',{ name:'Prepare Replay test', exact:true }).first().click();
    await page.locator('#onboarding-register-confirm').check();
    await page.getByRole('button',{ name:'Prepare test', exact:true }).click();
    await expect(page.locator('#notice')).toContainText('Replay setup prepared');
    backend.db.prepare("UPDATE ow_onboarding_brain_outbox SET state='ACKNOWLEDGED',brain_record_id='reasoning-registration-test',brain_relative_path='reasoning/reasoning-registration-test.md',acknowledged_at_utc=? WHERE milestone_type='REGISTRATION'").run(new Date().toISOString());
    await page.locator('#refresh').click();
    await expect(page.getByText('2 of 3 complete',{ exact:true })).toBeVisible();
    await expect(page.getByRole('button',{ name:'Make Replay ready', exact:true }).first()).toBeVisible();
    await page.getByRole('button',{ name:'Make Replay ready', exact:true }).first().click();
    await page.locator('#activation-confirm').check();
    await page.getByRole('button',{ name:'Make ready', exact:true }).click();
    await expect(page.locator('#notice')).toContainText('Open Replay Monitor to view Ocean data');
    await expect(page.getByRole('heading',{ name:'Onboarding complete', exact:true })).toBeVisible();
    await expect(page.getByRole('heading',{ name:'CI/CD continuous run', exact:true })).toBeVisible();
    await expect(page.getByRole('heading',{ name:'Continue current program and physical gates', exact:true })).toBeVisible();
    await expect(page.getByText('2 approved in Paperclip · 0 pending',{ exact:true })).toBeVisible();
    await expect(page.getByText('Approved in Paperclip',{ exact:true }).first()).toBeVisible();
    await expect(page.locator('.strategy-next-action')).toContainText('Separate comparator RUN_RELEASE gate');
    await expect(page.getByRole('link',{ name:'Answer authority question OCEA-28', exact:true })).toHaveAttribute('href','http://127.0.0.1:3100/OCEA/issues/OCEA-28');
    await expect(page.getByRole('heading',{name:'Identify exact Telemetry and host authority',exact:true})).toBeVisible();
    const priorDispatch = fs.readFileSync(approvalDispatchState,'utf8');
    const humanOwnedDispatch = JSON.parse(priorDispatch);
    humanOwnedDispatch.continuity.observed_at_utc = new Date().toISOString();
    humanOwnedDispatch.continuity.human_authority_blocker = null;
    humanOwnedDispatch.continuity.human_owner_blocker = {issue_id:'60d1f150-b541-41e8-aa1f-833ff0cb6560',
      identifier:'OCEA-31',title:'Obtain authorized Telemetry active-source and hardened custody receipt',status:'TODO',
      owner_user_id:'local-board',owner_name:'Wayne / Paperclip board',url:'http://127.0.0.1:3100/OCEA/issues/OCEA-31',
      action:'This task is assigned to a human Board owner for cross-owner routing. No agent wake or trading authority is inferred.'};
    humanOwnedDispatch.continuity.next_automatic_job = {issue_id:'fa919a56-79ff-475e-abbd-9336cbef5cd8',
      identifier:'OCEA-32',title:'Engineer supervised host worker',status:'IN_PROGRESS',owner_name:'CICD coordinator',
      url:'http://127.0.0.1:3100/OCEA/issues/OCEA-32',worker:{state:'RUNNING_VERIFIED'},recovery_required:false};
    fs.writeFileSync(approvalDispatchState,JSON.stringify(humanOwnedDispatch));
    await page.locator('#refresh').click();
    await expect(page.getByRole('heading',{name:'Continue current program and physical gates',exact:true})).toBeVisible();
    await expect(page.getByRole('link',{name:'Open cross-owner work OCEA-31',exact:true})).toHaveAttribute('href','http://127.0.0.1:3100/OCEA/issues/OCEA-31');
    await expect(page.getByText(/Parallel agent work:/)).toBeVisible();
    await expect(page.locator('.strategy-next-action')).toContainText('source completion does not grant Stage');
    fs.writeFileSync(approvalDispatchState,priorDispatch);
    await page.locator('#refresh').click();
    await expect(page.getByRole('heading',{ name:'Read-only preflight complete — blocked', exact:true })).toBeVisible();
    await expect(page.getByText('Preflight blocked physical binding',{ exact:true })).toBeVisible();
    await expect(page.getByText('Read only preflight only',{ exact:true })).toBeVisible();
    await expect(page.getByText('Not authorized',{ exact:true }).first()).toBeVisible();
    await expect(page.getByText('Prohibited',{ exact:true }).last()).toBeVisible();
    await expect(page.getByText(/The approved coordinator record is not the separate Paper manifest and qualification approval/)).toBeVisible();
    await expect(page.getByRole('heading',{ name:'Separate Paper qualification gate', exact:true })).toBeVisible();
    await expect(page.getByText('Code merged not deployed',{ exact:true })).toBeVisible();
    await expect(page.getByText(/Implementation status: v0\.5\.53 code merged and verified/)).toBeVisible();
    await expect(page.getByRole('link',{ name:'Telemetry PR', exact:true })).toHaveAttribute('href','https://github.com/mrzogs/sierra-trade-telemetry-logger/pull/21');
    await expect(page.getByText('No Paper approval record has been created or granted.',{ exact:true })).toBeVisible();
    await expect(page.getByText(/Existing Paper rows remain ineligible for learning or promotion/)).toBeVisible();
    await expect(page.getByText(`Continue after approval ${TEST_APPROVAL_ID} and exact route verification.`,{ exact:true }).first()).toBeVisible();
    await expect(page.getByText('Autonomous improvement implementation',{ exact:true })).toBeVisible();
    await expect(page.getByText('MNQZ26_FUT_CME',{ exact:true })).toBeVisible();
    await expect(page.getByText('The non-live strategy is onboarded. Ocean is implementing and proving the continuous learning loop; candidate promotion still requires human approval and Live remains disabled.',{ exact:true })).toBeVisible();
    await expect(page.getByRole('cell',{ name:'Causal telemetry enrichment', exact:true })).toBeVisible();
    await expect(page.getByText('v0.2.0-cicd-vwap',{ exact:true })).toBeVisible();
    await expect(page.getByRole('heading',{ name:'Known blockers and resolutions', exact:true })).toBeVisible();
    sources['priority-completion-program.json'].current_acceptance_assessment.pending = [];
    sources['priority-completion-program.json'].status = 'CICD_GATES_PROVEN_READY_FOR_GOVERNED_CANDIDATE_DECISION';
    fs.writeFileSync(path.join(sourceRoot,'priority-completion-program.json'),JSON.stringify(sources['priority-completion-program.json']));
    await page.locator('#refresh').click();
    await expect(page.locator('#content')).toHaveAttribute('aria-busy','false');
    await expect(page.getByRole('heading',{ name:'Continue current program and physical gates', exact:true })).toBeVisible();
    await expect(page.getByText('Owner: Program coordinator / named physical gate owners',{ exact:true })).toBeVisible();
    await expect(page.getByText('Autonomous improvement implementation',{ exact:true })).toBeVisible();
    await expect(page.getByRole('columnheader',{ name:'Exact next action', exact:true })).toBeVisible();
    await expect(page.getByRole('button',{ name:'Prepare Replay history run', exact:true })).toHaveCount(0);
    await expect(page.getByRole('heading',{ name:/Replay history/ })).toBeVisible();
    await expect(page.getByRole('heading',{ name:/Paper forward testing/ })).toBeVisible();
    await expect(page.getByRole('heading',{ name:/Live trading/ })).toBeVisible();
    await expect(page.getByText(/zero-trade result when no trade occurred/)).toBeVisible();
    await page.locator('details.onboarding-system-details > summary').click();
    const monitorLink = page.getByRole('link',{ name:'Open Replay Monitor', exact:true }).first();
    await expect(monitorLink).toHaveAttribute('href','/replay-monitor.html');
    await expect(monitorLink).toHaveAttribute('target','_blank');
    const replay = page.locator('.activation-item').filter({ has:page.getByRole('heading',{ name:'Advanced Replay control', exact:true }) });
    await expect(page.getByText('Exact process and chartbook verified on chart 1.',{ exact:true })).toBeVisible();
    await expect(page.getByText('A fresh Replay Two controller observation confirms chart replay is stopped.',{ exact:true })).toBeVisible();
    await expect(page.getByRole('link',{ name:'Open Sierra Replay Two', exact:true })).toHaveCount(0);
    const popupPromise = page.waitForEvent('popup');
    await monitorLink.click();
    const monitorPage = await popupPromise;
    await expect(monitorPage.getByRole('heading',{ name:'Replay Monitor', exact:true })).toBeVisible();
    assert.equal(new URL(monitorPage.url()).pathname,'/replay-monitor.html');
    await monitorPage.close();
    await expect(page.getByText('Opened from this browser',{ exact:true })).toBeVisible();
    await page.setViewportSize({ width:390, height:844 });
    await expect(page.getByRole('heading',{ name:'Onboarding complete', exact:true })).toBeVisible();
    const mobileStrategyFits = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
    assert.equal(mobileStrategyFits,true,'completed onboarding must not overflow the mobile viewport');
    await page.setViewportSize({ width:1440, height:950 });
    // Exercise the real GET -> enrichment -> render -> refresh path. The old
    // monitor still says approved throughout; it must not override these reads.
    const program = sources['autonomous-continuous-improvement-program.json'];
    program.next_action = 'TEST-only booking issuer source correction independent PASS; PR26 merged develop 08667719b1e004802b8716982f2bf167afa70b37; OCEA-28/44 physical gates pending.';
    writeSources(sourceRoot);
    if (process.env.OCEAN_PROJECTION_BEFORE_UI && process.env.OCEAN_PROJECTION_EVIDENCE) {
      await page.route('**/workflow/ui.js*',route=>route.fulfill({path:process.env.OCEAN_PROJECTION_BEFORE_UI,contentType:'text/javascript'}));
      await page.reload();
      await expect(page.locator('.strategy-next-action h3')).toHaveText('Answer the OCEA-28 authority question in Paperclip');
      await page.screenshot({path:path.join(process.env.OCEAN_PROJECTION_EVIDENCE,'projection-before.png'),fullPage:true});
      await page.unroute('**/workflow/ui.js*');
      await page.reload();
    }
    for (const [mode,label] of [['pending','Pending'],['unavailable','Unavailable'],['denied','Scoped access denied'],['company','Company mismatch'],['contract','Contract mismatch'],['approved','Approved']]) {
      approvalMode = mode;
      await page.locator('#refresh').click();
      const card = page.locator(`[data-approval-id="${TEST_COMPARATOR_APPROVAL_ID}"]`);
      await expect(card.locator('.badge')).toHaveText(label);
      const comparatorSummary = page.locator('.muted').filter({ hasText:'approved in Paperclip' });
      await expect(comparatorSummary).toHaveText(
        mode === 'approved' ? '2 approved in Paperclip · 0 pending'
          : mode === 'pending' ? '0 approved in Paperclip · 2 pending'
            : '0 approved in Paperclip · 0 pending · 2 unverified');
      await expect(comparatorSummary).not.toContainText('\uFFFD');
      await expect(page.locator('.strategy-next-action')).toContainText('booking issuer source correction independent PASS');
      await expect(page.locator('.strategy-next-action')).toContainText('OCEA-28/44 physical gates pending');
      await expect(page.locator('.strategy-next-action')).toContainText('Separate comparator RUN_RELEASE gate');
      await expect(page.locator('.strategy-next-action h3')).toHaveText('Continue current program and physical gates');
      if (mode === 'denied') await expect(card).toContainText('HTTP 403');
      if (process.env.OCEAN_PROJECTION_EVIDENCE) {
        fs.mkdirSync(process.env.OCEAN_PROJECTION_EVIDENCE,{recursive:true});
        await page.screenshot({path:path.join(process.env.OCEAN_PROJECTION_EVIDENCE,`projection-${mode}.png`),fullPage:true});
      }
    }
    await page.locator('details.onboarding-system-details > summary').click();
    await replay.getByRole('button',{ name:'Pause', exact:true }).click();
    await page.locator('#activation-control-confirm').check();
    await page.getByRole('button',{ name:'Pause', exact:true }).last().click();
    await page.locator('details.onboarding-system-details > summary').click();
    await expect(replay.getByRole('button',{ name:'Resume Replay test', exact:true })).toBeVisible();
    await replay.getByRole('button',{ name:'Deactivate', exact:true }).click();
    await page.locator('#activation-control-confirm').check();
    await page.getByRole('button',{ name:'Deactivate', exact:true }).last().click();
    await expect(page.locator('#notice')).toContainText('updated to Deactivate');
    assert.equal(backend.db.prepare('SELECT COUNT(*) AS n FROM ow_onboarding_registrations').get().n,1);
    assert.deepEqual(backend.db.prepare("SELECT action FROM ow_onboarding_activation_events WHERE environment='REPLAY' ORDER BY rowid").all().map(row => row.action), ['ACTIVATE','PAUSE','DEACTIVATE']);
    assert.equal(backend.db.prepare('SELECT COUNT(*) AS n FROM ow_runs').get().n,0,'opening the monitor must not create or start a run');
    assert.deepEqual(browserErrors,[]);
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
    backend.close();
    fs.rmSync(root,{ recursive:true, force:true });
  }
});
