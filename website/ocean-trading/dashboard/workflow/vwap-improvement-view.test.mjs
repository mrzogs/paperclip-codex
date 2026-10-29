import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { renderVwapImprovementPanel, unavailableVwapImprovementStatus } from '../public/workflow/vwap-improvement-view.js';
import { handleVwapImprovementRequest } from './vwap-improvement-status.mjs';
import { makeVwapStatusSoftwareFixture } from './vwap-improvement-status.fixtures.mjs';

test('public panel escapes text and admits only controlled kind/hash download URLs',()=>{
  const status=unavailableVwapImprovementStatus();status.strategy_improvement.owner='<img src=x onerror=alert(1)>';
  status.strategy_improvement.next_action='" onclick="alert(2)';
  status.verified_report_links=[{kind:'cohort',sha256:'A'.repeat(64),href:'javascript:alert(1)'},
    {kind:'../secret',sha256:'A'.repeat(64),href:'/api/workflow/vwap-improvement-monitor/reports/../secret'}];
  const html=renderVwapImprovementPanel(status);
  assert.ok(html.includes('&lt;img'));assert.ok(!html.includes('<img'));assert.ok(!html.includes('href="javascript:'));
  assert.ok(html.includes('Strategy improvement loop'));assert.ok(html.includes('UNPROVED'));
});

test('disposable browser shows ingestion separately, controlled downloads, safe text, and stalled failures', {timeout:90000},async t=>{
  const f=makeVwapStatusSoftwareFixture(t),publicRoot=path.resolve('public/workflow');let failStatus=false;
  f.documents.improvement_liveness.blockers[0].owner='<img src=x onerror=alert(1)> Host custodian';f.publish();
  const strategy={strategy_id:'cicd-vwap-pull-back-strategy',strategy_name:'Disposable VWAP strategy fixture',activation_status:'ACTIVE',
    baseline_version:'fixture-v1',production_version:null,baseline_hash:'sha256:fixture',
    profile:{profile_id:'fixture-profile',profile_version:'v1',strategy_config_hash:'sha256:fixture'},instances:[],cases:[],runs:[],cases_total:0,runs_total:0};
  const server=http.createServer((req,res)=>{
    const url=new URL(req.url,'http://fixture');
    const json=value=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));};
    if(url.pathname.startsWith('/api/vwap-improvement-monitor/') || url.pathname.startsWith('/api/workflow/vwap-improvement-monitor/reports/')){
      if(failStatus && url.pathname.endsWith('/status')){res.writeHead(503).end('{}');return;}
      void handleVwapImprovementRequest(req,res,url,{loadConfigured:f.loadConfigured,now:f.now,legacyState:{status:'HEALTHY'}})
        .catch(()=>res.writeHead(500).end());return;
    }
    if(url.pathname==='/api/workflow/session'){json({csrf_token:'software-fixture-csrf',expires_at_utc:'2099-01-01T00:00:00Z'});return;}
    if(url.pathname==='/api/workflow/view/strategies/cicd-vwap-pull-back-strategy'){json(strategy);return;}
    if(url.pathname==='/api/workflow/view/dashboard'){json({counts:{action_required:0}});return;}
    const file=url.pathname.startsWith('/workflow/')?url.pathname.slice('/workflow/'.length):'index.html';
    if(!['index.html','ui.js','ui.css','icons.js','run-wizard.js','onboarding-help.js','reprocess-identity.js','vwap-improvement-view.js'].includes(file)){
      res.writeHead(404).end();return;
    }
    res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');
    res.end(fs.readFileSync(path.join(publicRoot,file)));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const browser=await chromium.launch({headless:true,executablePath:process.env.OCEAN_BROWSER_TEST_EXECUTABLE || undefined});t.after(()=>browser.close());
  const page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
  const base=`http://127.0.0.1:${server.address().port}`;
  await page.goto(`${base}/improvement/strategies/cicd-vwap-pull-back-strategy`);
  const panel=page.locator('#vwap-improvement-evidence-panel');
  await expect(page.getByRole('heading',{name:'Disposable VWAP strategy fixture',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Start New Run',exact:true})).toBeVisible();
  await expect(panel.getByRole('heading',{name:'Evidence ingestion',exact:true})).toBeVisible();
  await expect(panel.getByRole('heading',{name:'Strategy improvement loop',exact:true})).toBeVisible();
  await expect(panel).toContainText('integrity verified diagnostic only');await expect(panel).toContainText('stalled');
  await expect(panel).toContainText('-2618.86');await expect(panel).toContainText('UNKNOWN');
  await expect(panel).toContainText('<img src=x onerror=alert(1)> Host custodian');assert.equal(await panel.locator('img').count(),0);
  const downloadEvent=page.waitForEvent('download');await panel.getByRole('link',{name:'Descriptive cohort',exact:true}).click();
  assert.match((await downloadEvent).suggestedFilename(),/^vwap-cohort-[A-F0-9]{64}\.json$/);
  f.documents.cohort.currency='GBP';f.publish();await page.getByRole('button',{name:'Refresh data',exact:true}).click();
  await expect(panel).toContainText('GBP');
  for(const document of Object.values(f.documents))document.evidence_class='SYNTHETIC';f.publish();
  await page.getByRole('button',{name:'Refresh data',exact:true}).click();await expect(panel).toContainText('Software-only fixture evidence.');
  fs.appendFileSync(path.join(f.root,'cohort.json'),' ');await page.getByRole('button',{name:'Refresh data',exact:true}).click();
  await expect(panel).toContainText('blocked');assert.equal(await panel.getByRole('link',{name:'Descriptive cohort',exact:true}).count(),0);
  failStatus=true;await page.getByRole('button',{name:'Refresh data',exact:true}).click();await expect(panel).toContainText('unavailable');
  await expect(panel).toContainText('stalled');await expect(page.getByRole('button',{name:'Start New Run',exact:true})).toBeVisible();
  assert.deepEqual(errors,[]);
});
