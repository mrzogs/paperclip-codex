import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

export async function startUiTestHost({extraInstances=[],fixtureOptions={}}={}) {
  const root = process.env.OCEAN_S21_ROOT;
  assert.ok(root && path.isAbsolute(root),'Explicit isolated S21 root required');
  const dashboard = path.join(root,'private/legacy-clone/dashboard');
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
  const {server} = await import(pathToFileURL(path.join(dashboard,'server.mjs')));
  await new Promise(resolve => server.listen(port,'127.0.0.1',resolve));
  try {
    const fixture = await createUiFixture(base,process.env,fixtureOptions);
    const require = createRequire(import.meta.url);
    const {chromium,expect} = require(require.resolve('playwright',{paths:[process.env.OCEAN_S21_NODE_MODULES]}));
    return {root,dashboard,privateRun,config,base,fixture,chromium,expect,server,close:()=>new Promise(resolve => server.close(resolve))};
  } catch(error) { await new Promise(resolve => server.close(resolve)); throw error; }
}
