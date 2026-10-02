import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { issueOceanIdentity, issueTestBrowserSecret } from './auth.mjs';
import { WorkflowBackend } from './backend.mjs';

const TEST_STRATEGY_ID = 'e2e-disposable-test-strategy';

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
};

function writeSources(root) {
  for (const [name, value] of Object.entries(sources)) fs.writeFileSync(path.join(root, name), JSON.stringify(value));
}

test('complete onboarding is actionable in the browser without touching production data', { timeout:120_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocean-onboarding-ui-'));
  const sourceRoot = path.join(root, 'sources'); fs.mkdirSync(sourceRoot); writeSources(sourceRoot);
  const publicRoot = path.resolve('public/workflow');
  const environment = {};
  let backend;
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (url.pathname.startsWith('/api/workflow/')) { void backend.handle(request, response, url); return; }
    if (url.pathname === '/replay-monitor.html') { response.setHeader('Content-Type','text/html'); response.end('<!doctype html><main><h1>Replay Monitor</h1></main>'); return; }
    if (url.pathname === '/assets/ocean-trading-icon.png') { response.setHeader('Content-Type','image/png'); response.end(fs.readFileSync(path.join(publicRoot, '../assets/ocean-trading-icon.png'))); return; }
    const file = url.pathname.startsWith('/workflow/') ? url.pathname.slice('/workflow/'.length) : 'index.html';
    if (!['index.html','ui.js','ui.css','icons.js','run-wizard.js','onboarding-help.js'].includes(file)) { response.writeHead(404).end(); return; }
    response.setHeader('Cache-Control','no-store');
    response.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
    response.end(fs.readFileSync(path.join(publicRoot, file)));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const strategyIds = [TEST_STRATEGY_ID]; const instanceIds = ['test-replay-two'];
  const config = {
    db_file:path.join(root,'workflow.sqlite'), test_only:true, contract_release:'2.1.0', allowed_origins:[base], lease_ms:30000,
    python_executable:'python', strategy_onboarding_root:sourceRoot, onboarding_brain_sync:{ enabled:false },
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
    await page.goto(`${base}/improvement/strategies/${TEST_STRATEGY_ID}`);
    assert.match(await page.locator('script[type="module"]').getAttribute('src'),/qualified-history-20260930-3/,'the deployed page must request the current workflow module version');
    await page.getByRole('button',{ name:'Sign in', exact:true }).click();
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
    await expect(page.getByRole('button',{ name:'Prepare Replay history run', exact:true })).toHaveCount(0);
    await expect(page.getByRole('heading',{ name:/Replay history/ })).toBeVisible();
    await expect(page.getByRole('heading',{ name:/Paper forward testing/ })).toBeVisible();
    await expect(page.getByRole('heading',{ name:/Live trading/ })).toBeVisible();
    await expect(page.getByText(/zero-trade result when no trade occurred/)).toBeVisible();
    await expect(page.getByText(/Sierra running, stopped, or stale does not change this status/)).toBeVisible();
    const monitorLink = page.getByRole('link',{ name:'Open Replay Monitor', exact:true }).first();
    await expect(monitorLink).toHaveAttribute('href','/replay-monitor.html');
    await expect(monitorLink).toHaveAttribute('target','_blank');
    await page.locator('details.onboarding-system-details > summary').click();
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
