import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

export async function startUiTestHost({extraInstances=[],fixtureOptions={}}={}) {
  const evidenceRoot = process.env.OCEAN_S21_ROOT;
  assert.ok(evidenceRoot && path.isAbsolute(evidenceRoot),'Explicit isolated S21 root required');
  const sourceDashboard = path.join(evidenceRoot,'private/legacy-clone/dashboard');
  assert.ok(fs.statSync(sourceDashboard).isDirectory(),'Prepared isolated dashboard clone required');
  // Python's schema reader can reject deep Windows evidence paths. Keep the
  // disposable host short; never remove or mutate the caller's evidence clone.
  const temp = path.resolve(os.tmpdir()),root = fs.mkdtempSync(path.join(temp,'ocean-ui-test-'));
  const dashboard = path.join(root,'dashboard');
  const cleanup = () => {
    if (!fs.existsSync(root)) return;
    if (!root.startsWith(temp+path.sep) || !path.basename(root).startsWith('ocean-ui-test-')
      || fs.lstatSync(root).isSymbolicLink()) {console.warn('OWNED_TEST_ROOT_CLEANUP_SCOPE_REJECTED');return;}
    try {fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
    catch(error) {console.warn(`OWNED_TEST_ROOT_CLEANUP_FAILED: ${error.code || 'UNKNOWN'}`);}
  };
  let server;
  try {
    assert.ok(path.join(dashboard,'workflow/contracts/2.1.0/shared-contracts/shared-contracts.schema.json').length<=240,
      'Temporary test schema path must fit the Windows boundary');
    fs.cpSync(sourceDashboard,dashboard,{recursive:true,errorOnExist:true});
    fs.mkdirSync(path.join(root,'private'));
    const privateRun = fs.mkdtempSync(path.join(root,'private/ui-run-'));
    const {issueOceanIdentity,issueTestBrowserSecret} = await import(pathToFileURL(path.join(dashboard,'workflow/auth.mjs')));
    const {UI_STRATEGIES,UI_INSTANCES,createUiFixture} = await import(pathToFileURL(path.join(dashboard,'workflow/ui-test-fixture.mjs')));
    const permittedInstances=[...UI_INSTANCES,...extraInstances];
    const probe = net.createServer(); await new Promise(resolve => probe.listen(0,'127.0.0.1',resolve));
    const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
    const base = `http://127.0.0.1:${port}`;
    const config = {schema_version:'ocean-workflow-config/v1',contract_release:'2.1.0',test_only:true,namespace:'TEST',allowed_origins:[base],db_file:path.join(privateRun,'workflow-ui.sqlite'),browser:{subject_id:'wayne-ocean-ui',credential_ref:'OCEAN_WAYNE_BROWSER_SECRET'},identities:['BRAIN','TELEMETRY','STRATEGY'].map(role => issueOceanIdentity({identity_id:`ocean-ui-${role.toLowerCase()}`,role,namespace:'TEST',credential_ref:`OCEAN_${role}_TOKEN`,strategy_ids:UI_STRATEGIES,instance_ids:permittedInstances},process.env,new Date(Date.now()+7200000).toISOString())),brain_submission:'OFF',live_real:'DISABLED',dispatch_worker:'OFF',lease_ms:30000};
    issueTestBrowserSecret(process.env,config.browser.credential_ref);
    const configFile=path.join(privateRun,'config-references.json'); fs.writeFileSync(configFile,JSON.stringify(config,null,2));
    Object.assign(process.env,{NODE_ENV:'test',OCEAN_WORKFLOW_ENABLED:'1',OCEAN_WORKFLOW_CONFIG:configFile,OCEAN_TRADING_PYTHON:'python',OCEAN_WEBSITE_DB:path.join(root,'private/test-output/ocean-fixture.sqlite'),PATRADING_LIVE_SQLITE_FILE:path.join(root,'private/fixtures/TradeTelemetry_Live.s07.sqlite'),PATRADING_PAPER_SQLITE_FILE:path.join(root,'private/fixtures/TradeTelemetry_PaperTrading.s07.sqlite'),PATRADING_REPLAY_SQLITE_FILE:path.join(root,'private/fixtures/TradeTelemetry_Replay.s07.sqlite'),PAPERCLIP_REPO_DIR:path.join(root,'private/isolated-paperclip'),PAPERCLIP_API:'http://127.0.0.1:9/api',OCEAN_TRADING_MONITOR_DEFAULT_ON:'0',OCEAN_STRATEGY_REPO_DIR:path.join(root,'private/empty-inputs/strategies'),OQL_REPO_ROOT:path.join(root,'private/empty-inputs/oql'),SIERRA_LIVE_ROOT:path.join(root,'private/empty-inputs/live'),SIERRA_PAPER_ROOT:path.join(root,'private/empty-inputs/paper'),SIERRA_REPLAY_ROOT:path.join(root,'private/empty-inputs/replay')});
    ({server} = await import(pathToFileURL(path.join(dashboard,'server.mjs'))));
    await new Promise(resolve => server.listen(port,'127.0.0.1',resolve));
    const fixture = await createUiFixture(base,process.env,fixtureOptions);
    const require = createRequire(import.meta.url);
    const {chromium,expect} = require(require.resolve('playwright',{paths:[process.env.OCEAN_S21_NODE_MODULES]}));
    return {root:evidenceRoot,evidenceRoot,privateRoot:root,dashboard,privateRun,config,base,fixture,chromium,expect,server,
      close:async()=>{await new Promise(resolve=>server.close(resolve));cleanup();}};
  } catch(error) {
    if(server?.listening) await new Promise(resolve=>server.close(resolve));
    cleanup();throw error;
  }
}
