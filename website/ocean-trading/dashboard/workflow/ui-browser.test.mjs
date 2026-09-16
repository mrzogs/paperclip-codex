import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { startUiTestHost } from './ui-test-host.mjs';

const host = await startUiTestHost();
const {base,fixture,root} = host;
const output=path.join(root,'artifacts/evidence/ui-runtime-results.json');
const screenshots=path.join(root,'artifacts/screenshots'); fs.mkdirSync(screenshots,{recursive:true});
const results=[]; const errors=[];
const browser=await host.chromium.launch({channel:'chrome',headless:true});
const context=await browser.newContext({viewport:{width:1500,height:1000},permissions:['clipboard-read','clipboard-write']});
const page=await context.newPage(); page.on('pageerror',error => errors.push(error.message));
const waitText=async (locator,expected) => { await locator.filter({hasText:expected}).first().waitFor({timeout:15000}); };
const navigate=async route => { const response=await page.goto(base+route,{waitUntil:'domcontentloaded'}); assert.equal(response.status(),200); if(route.startsWith('/improvement')) await page.waitForFunction(()=>document.querySelector('#content')?.getAttribute('aria-busy') === 'false'); };
const snapshot=async name => { await page.screenshot({path:path.join(screenshots,name+'.png'),fullPage:false}); };
const readCase=id => fixture.call(`view/cases/${id}`);
const readDb=sql => { const db=new DatabaseSync(host.config.db_file,{readOnly:true}); try{return db.prepare(sql).all();}finally{db.close();} };
async function check(name,fn) {
  const start=Date.now();
  try { await fn(); results.push({name,status:'PASS',type:'ACTUAL_CHROME_CURRENT_MAIN_SERVER_SQLITE',elapsed_ms:Date.now()-start}); console.log('PASS '+name); }
  catch(error) { results.push({name,status:'FAILED',error:error.message}); await snapshot('failure-'+results.length); throw error; }
}
async function login() {
  await page.locator('#credential').fill(process.env.OCEAN_WAYNE_BROWSER_SECRET);
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await page.locator('#login').waitFor({state:'detached'});
  await waitText(page.locator('#freshness'),'Updated');
}
async function closeModal() { await page.locator('#modal button[aria-label=Close]').click(); await page.waitForFunction(()=>!document.querySelector('#modal').open); }
try {
  await check('GOV-09: authenticated real routes, keyboard login and inaccessible evidence',async()=>{
    await navigate('/improvement/dashboard'); await page.locator('#credential').waitFor();
    const unauth=await context.request.get(base+`/api/workflow/artifacts/${fixture.primary.evidence.manifest.artifact_id}/download`); assert.equal(unauth.status(),401);
    await page.locator('#credential').fill('wrong-browser-credential'); await page.getByRole('button',{name:'Sign in',exact:true}).click(); await waitText(page.locator('.form-error'),'Invalid browser credential');
    await page.locator('#credential').fill('unfinished-login-entry');
    await page.waitForTimeout(5500);
    assert.equal(await page.locator('#credential').inputValue(),'unfinished-login-entry');
    await page.locator('#credential').focus(); await page.keyboard.press('Tab'); assert.equal(await page.evaluate(()=>document.activeElement.textContent),'Sign in');
    await login(); assert.equal((await fixture.call('view/dashboard')).counts.action_required,1);
    const status=await context.request.get(base+'/api/workflow/session'); assert.equal(status.status(),200);
    await fixture.call('view/dashboard',{role:'BRAIN',expected:403});
  });
  await check('GOV-05: overview badges, two dynamic strategies, profile versions and blocked subtests',async()=>{
    await waitText(page.locator('h1'),'Overview'); assert.equal(await page.locator('#approval-badge').innerText(),'1');
    assert.ok((await page.locator('#content').innerText()).includes('Review failed robustness result'));
    await snapshot('overview-desktop');
    await page.locator('.workspace-nav [data-view=strategies]').click(); await waitText(page.locator('h1'),'Strategies');
    await waitText(page.locator('tbody'),'VWAP Wave Pullback'); await waitText(page.locator('tbody'),'Price Action');
    await page.getByRole('link',{name:'VWAP Wave Pullback / S21 test',exact:true}).click(); await waitText(page.locator('h1'),'VWAP Wave Pullback');
    assert.ok(page.url().endsWith('/vwap_wave_pullback_balanced_nasdaq_v0434'));
    assert.ok((await page.locator('#content').innerText()).includes('None registered')); await snapshot('strategy-desktop');
    await navigate('/improvement/cases/'+fixture.secondary.caseId);
    const body=await page.locator('#content').innerText(); for(const text of ['Pass','Fail','Blocked','Not run','Review failed robustness result']) assert.ok(body.includes(text),text);
    await snapshot('case-blocked-desktop');
  });
  await check('GOV-05: scoped approval confirmation and independent case state',async()=>{
    const before=await readCase(fixture.secondary.caseId);
    await navigate('/improvement/approvals/'+fixture.primary.approval.request_id);
    await page.locator('[data-decision=APPROVED]').click(); await page.locator('#decision-reason').fill('S21 browser acceptance only');
    await page.locator('#confirm-scope').check(); await snapshot('approval-confirmation');
    await page.getByRole('button',{name:'Record decision',exact:true}).click(); await page.waitForFunction(()=>!document.querySelector('#modal').open);
    await waitText(page.locator('#content'),'Decision recorded');
    const changed=await readCase(fixture.primary.caseId); assert.equal(changed.stage,'DEVELOPMENT_REVIEW'); assert.equal(changed.handoffs.length,0);
    assert.equal((await readCase(fixture.secondary.caseId)).revision,before.revision);
    assert.equal((await fixture.call('view/dashboard')).counts.action_required,0);
  });
  let primaryHandoff;
  await check('GOV-07: approved download/copy, dispatch and manual confirmation remain separate',async()=>{
    await navigate('/improvement/cases/'+fixture.primary.caseId); await page.locator('[data-action=prepare-handoff]').click();
    await page.getByRole('button',{name:'Prepare handoff',exact:true}).click(); await page.waitForFunction(()=>!document.querySelector('#modal').open);
    await page.locator('[data-action=download-handoff]').waitFor();
    let data=await readCase(fixture.primary.caseId); primaryHandoff=data.handoffs[0]; assert.equal(primaryHandoff.state,'READY');
    const beforeEvents=data.history.length;
    const downloading=page.waitForEvent('download'); await page.locator('[data-action=download-handoff]').click(); const downloaded=await downloading;
    await downloaded.saveAs(path.join(host.privateRun,'approved-handoff.md'));
    const md=fs.readFileSync(path.join(host.privateRun,'approved-handoff.md'),'utf8'); assert.ok(md.includes(fixture.primary.caseId)); assert.ok(md.includes('No actual candidate changes'));
    assert.equal((await readCase(fixture.primary.caseId)).history.length,beforeEvents);
    await page.locator('[data-action=copy-handoff]').click(); await waitText(page.locator('#notice'),'Approved instruction copied');
    assert.equal((await page.evaluate(()=>navigator.clipboard.readText())).replaceAll('\r\n','\n'),md);
    assert.equal(md,(await fixture.call(`handoffs/${primaryHandoff.handoff_id}`)).instruction_md);
    await page.locator('[data-action=send-handoff]').click(); await page.locator('[data-action=manual-confirmation]').waitFor();
    await page.locator('[data-action=manual-confirmation]').click(); await page.locator('#confirmation-note').fill('Synthetic operator report; recipient is separately verified');
    await page.getByRole('button',{name:'Record manual report',exact:true}).click(); await page.waitForFunction(()=>!document.querySelector('#modal').open);
    data=await readCase(fixture.primary.caseId); assert.equal(data.handoffs[0].state,'DISPATCHED'); assert.ok(data.history.some(e=>e.action==='handoff.manual-confirmation' && e.payload.recipient_authenticated===false));
    await fixture.call('handoff-events',{data:{handoff_id:primaryHandoff.handoff_id,expected_revision:data.handoffs[0].revision,state:'ACKNOWLEDGED'},expected:403});
    await fixture.call('handoff-events',{role:'STRATEGY',data:{handoff_id:primaryHandoff.handoff_id,expected_revision:data.handoffs[0].revision,state:'ACKNOWLEDGED'}});
    await page.waitForFunction(()=>Array.from(document.querySelectorAll('.badge')).some(e=>e.textContent==='Acknowledged'),null,{timeout:15000});
    await snapshot('handoff-acknowledged');
  });
  await check('GOV-07: recipient work/result receipt and failed-delivery retry refresh',async()=>{
    let handoff=(await readCase(fixture.primary.caseId)).handoffs[0];
    await fixture.call('handoff-events',{role:'STRATEGY',data:{handoff_id:handoff.handoff_id,expected_revision:handoff.revision,state:'WORK_IN_PROGRESS'}});
    const result=await fixture.artifact(fixture.primary.caseId,'EVIDENCE',{payload:{result:'S21 returned synthetic result'}},'STRATEGY');
    handoff=(await readCase(fixture.primary.caseId)).handoffs[0];
    await fixture.call('handoff-events',{role:'STRATEGY',data:{handoff_id:handoff.handoff_id,expected_revision:handoff.revision,state:'RESULT_RETURNED',result_artifact_id:result.manifest.artifact_id}});
    await waitText(page.locator('#content'),'Returned result');
    handoff=(await readCase(fixture.primary.caseId)).handoffs[0];
    await fixture.call('handoff-events',{role:'STRATEGY',data:{handoff_id:handoff.handoff_id,expected_revision:handoff.revision,state:'FAILED',reason:'Synthetic transport failure'}});
    await page.locator('[data-action=retry-handoff]').waitFor({timeout:15000}); await page.locator('[data-action=retry-handoff]').click();
    await page.locator('[data-action=send-handoff]').waitFor(); assert.equal((await readCase(fixture.primary.caseId)).handoffs[0].state,'READY');
  });
  await check('GOV-09: browser result upload records immutable bytes and named test outcome',async()=>{
    await navigate('/improvement/cases/'+fixture.secondary.caseId); await page.locator('[data-action=resume]').click(); await page.locator('[data-action=upload]').waitFor();
    const data=await readCase(fixture.secondary.caseId);
    await page.locator('[data-action=upload]').click(); await page.locator('#upload-kind').selectOption('ROBUSTNESS');
    await page.locator('#upload-file').setInputFiles({name:'robustness.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({status:'PASS',candidate_hash:data.candidate_hash,note:'Synthetic re-evaluation upload'}))});
    await page.locator('#record-test').check(); await page.getByRole('button',{name:'Register immutable artifact',exact:true}).click(); await page.waitForFunction(()=>!document.querySelector('#modal').open);
    const after=await readCase(fixture.secondary.caseId); assert.equal(after.tasks.find(t=>t.kind==='ROBUSTNESS').status,'PASS');
    const uploaded=after.artifacts.find(a=>a.producer_id==='wayne-ocean-ui' && a.kind==='ROBUSTNESS'); assert.ok(uploaded); assert.ok(uploaded.manifest.immutable);
    await navigate('/improvement/artifacts/'+uploaded.artifact_id); await waitText(page.locator('pre'),'Synthetic re-evaluation upload'); await snapshot('artifact-json');
  });
  await check('GOV-09: active content/private paths rejected; text and PNG previews stay safe',async()=>{
    await navigate('/improvement/cases/'+fixture.primary.caseId); await page.locator('[data-action=upload]').click();
    await page.locator('#upload-file').setInputFiles({name:'unsafe.md',mimeType:'text/markdown',buffer:Buffer.from('<script>window.injected=true</script>')});
    await page.getByRole('button',{name:'Register immutable artifact',exact:true}).click(); await waitText(page.locator('#modal .form-error'),'active content');
    await page.locator('#upload-file').setInputFiles({name:'path.md',mimeType:'text/markdown',buffer:Buffer.from('Source D:\\private\\sensitive.txt')});
    await page.getByRole('button',{name:'Register immutable artifact',exact:true}).click(); await waitText(page.locator('#modal .form-error'),'private filesystem');
    await closeModal();
    const safe=await fixture.artifact(fixture.primary.caseId,'EVIDENCE',{media_type:'text/markdown',content:'<img src=x onerror="window.injected=true">\n[External](https://example.invalid/)'});
    await navigate('/improvement/artifacts/'+safe.manifest.artifact_id); await page.locator('pre').waitFor(); assert.equal(await page.locator('#content img').count(),0); assert.equal(await page.evaluate(()=>window.injected),undefined);
    const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAFElEQVR4nGNUiJvDgA0wYRUdtBIA4KgBKplPpY8AAAAASUVORK5CYII=','base64');
    await navigate('/improvement/cases/'+fixture.primary.caseId); await page.locator('[data-action=upload]').click();
    await page.locator('#upload-file').setInputFiles({name:'image.png',mimeType:'image/png',buffer:png});
    await page.getByRole('button',{name:'Register immutable artifact',exact:true}).click(); await page.waitForFunction(()=>!document.querySelector('#modal').open);
    const image=(await readCase(fixture.primary.caseId)).artifacts.find(a=>a.manifest.media_type==='image/png'); assert.ok(image);
    await navigate('/improvement/artifacts/'+image.artifact_id); await page.waitForFunction(()=>document.querySelector('.artifact-image')?.naturalWidth===8);
  });
  await check('GOV-05 GOV-09: live badge refresh, stale review, forged scope and decision attempts',async()=>{
    const review=await fixture.review('test-ui-stale-review');
    await page.waitForFunction(()=>document.querySelector('#approval-badge')?.textContent==='1',null,{timeout:15000});
    await navigate('/improvement/approvals/'+review.approval.request_id); await page.locator('[data-decision=APPROVED]').click();
    await page.locator('#decision-reason').fill('Stale synthetic review'); await page.locator('#confirm-scope').check();
    await fixture.change(review.caseId,{action:'pause'});
    await waitText(page.locator('#modal .form-error'),'review changed'); assert.equal(await page.getByRole('button',{name:'Record decision',exact:true}).isDisabled(),true); await closeModal();
    await fixture.call('decisions',{role:'STRATEGY',data:{decision_by:'Wayne'},expected:403});
    await fixture.call('decisions',{data:{decision_by:'Wayne'},expected:422});
    const forged=await page.evaluate(async()=>{ const r=await fetch('/api/workflow/view/dashboard',{headers:{'X-Role':'HUMAN'}}); return r.status; }); assert.equal(forged,403);
    const csrf=await page.evaluate(async()=>{ const r=await fetch('/api/workflow/decisions',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':'wrong'},body:JSON.stringify({message_id:'test-forged',data:{}})}); return r.status; }); assert.equal(csrf,403);
    assert.equal(readDb("SELECT COUNT(*) AS n FROM ow_decisions WHERE case_id='test-ui-stale-review'")[0].n,0);
  });
  await check('GOV-05: mobile layout, keyboard modal and navigation reload',async()=>{
    await page.setViewportSize({width:390,height:844}); await navigate('/improvement/dashboard'); await snapshot('overview-mobile');
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
    await navigate('/improvement/cases/'+fixture.primary.caseId); await snapshot('case-mobile');
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
    await page.locator('[data-action=upload]').click(); await page.keyboard.press('Escape'); await page.waitForFunction(()=>!document.querySelector('#modal').open);
    await page.reload({waitUntil:'domcontentloaded'}); await waitText(page.locator('h1'),fixture.primary.caseId); assert.equal(await page.locator('#login').count(),0);
    await page.setViewportSize({width:1500,height:1000});
  });
  await check('GOV-05 GOV-09: more-evidence and rejection preserve separate governed branches',async()=>{
    for (const [action,stage] of [['MORE_EVIDENCE','RESEARCH'],['REJECTED','RETROSPECTIVE']]) {
      const review=await fixture.review('test-ui-'+action.toLowerCase().replaceAll('_','-'));
      await navigate('/improvement/approvals/'+review.approval.request_id);
      await page.locator(`[data-decision=${action}]`).click();
      await page.locator('#decision-reason').fill('Synthetic browser branch verification');
      await page.locator('#confirm-scope').check();
      await page.getByRole('button',{name:'Record decision',exact:true}).click();
      await page.waitForFunction(()=>!document.querySelector('#modal').open);
      const changed=await readCase(review.caseId);
      assert.equal(changed.stage,stage); assert.equal(changed.handoffs.length,0);
      assert.equal(changed.approvals[0].state,action);
      if(action==='MORE_EVIDENCE') assert.equal(changed.tasks.find(row=>row.kind==='RESEARCH_MORE_EVIDENCE').status,'NOT_RUN');
    }
  });
  await check('GOV-05: empty filter and paginated history preserve server totals',async()=>{
    await navigate('/improvement/strategies');
    await page.locator('#filter').fill('definitely-no-matching-strategy');
    assert.equal(await page.locator('tbody a').count(),0);
    await page.locator('#filter').fill(''); assert.equal(await page.locator('tbody a').count(),2);
    await navigate('/improvement/history');
    const first=await page.locator('#content .timeline').innerText();
    await page.getByRole('button',{name:'Next page',exact:true}).click();
    await waitText(page.locator('.pager'),'51-');
    assert.notEqual(await page.locator('#content .timeline').innerText(),first);
    await page.getByRole('button',{name:'Previous page',exact:true}).click();
    await waitText(page.locator('.pager'),'1-50');
  });
  await check('GOV-05: connection failure and retry preserve freshness and recover',async()=>{
    await navigate('/improvement/dashboard'); await context.setOffline(true); await page.locator('#refresh').click(); await waitText(page.locator('#freshness'),'Refresh failed');
    await context.setOffline(false); await waitText(page.locator('#freshness'),'Updated'); assert.equal(await page.locator('#notice').isVisible(),false);
  });
  await check('LEG-02: calendar, ledger, mode selection and new navigation on actual frontend',async()=>{
    await navigate('/'); await page.locator('[data-dashboard-performance-calendar]').waitFor();
    await page.locator('[data-dashboard-mode-option=live]').click(); await waitText(page.locator('#dashboard-performance-calendar'),'S07 Fixture Strategy');
    const live=await page.locator('#dashboard-performance-calendar').innerText(); assert.ok(live.includes('2 trades')); assert.ok(live.includes('Manual Trade'));
    await snapshot('legacy-live');
    await page.locator('[data-dashboard-mode-option=paper]').click(); await waitText(page.locator('#dashboard-performance-calendar'),'S07 Paper Strategy'); assert.ok((await page.locator('#dashboard-performance-calendar').innerText()).includes('1 to 1 of 1 trades'));
    for(const route of ['/live-dashboard.html','/paper-dashboard.html','/ledger.html','/replay-monitor.html']) { await page.goto(base+route,{waitUntil:'domcontentloaded'}); await page.locator('main').waitFor(); await page.locator('[data-nav-page=improvement]').waitFor(); assert.ok((await page.locator('main').innerText()).trim().length>0); }
    await page.locator('[data-nav-page=improvement]').click(); await waitText(page.locator('h1'),'Overview');
  });
  await check('GOV-09: expiry clears protected page, reauthentication and logout',async()=>{
    await navigate('/improvement/cases/'+fixture.primary.caseId);
    const db=new DatabaseSync(host.config.db_file); try { db.prepare('UPDATE ow_sessions SET expires_ms=?').run(Date.now()-1); }finally{db.close();}
    await page.locator('#refresh').click(); await page.locator('#credential').waitFor(); assert.equal(await page.locator('#content table').count(),0); assert.equal(await page.locator('#approval-badge').isVisible(),false);
    const r=await context.request.get(base+`/api/workflow/artifacts/${fixture.primary.evidence.manifest.artifact_id}/download`); assert.equal(r.status(),401);
    await login(); await waitText(page.locator('h1'),fixture.primary.caseId); await page.locator('#logout').click(); await waitText(page.locator('#login'),'Signed out');
    assert.equal((await context.request.get(base+'/api/workflow/view/dashboard')).status(),401);
  });
  await check('GOV-09: service values absent from frontend, responses and browser storage',async()=>{
    const strings=await page.evaluate(()=>({html:document.documentElement.outerHTML,local:JSON.stringify(localStorage),session:JSON.stringify(sessionStorage)}));
    const js=await (await context.request.get(base+'/workflow/ui.js')).text();
    for(const key of ['OCEAN_BRAIN_TOKEN','OCEAN_TELEMETRY_TOKEN','OCEAN_STRATEGY_TOKEN']) for(const value of [...Object.values(strings),js]) assert.ok(!value.includes(process.env[key]));
    assert.deepEqual(errors,[]);
  });
} catch(error) { console.error(error.message); process.exitCode=1; }
finally {
  fs.writeFileSync(output,JSON.stringify({status:results.every(r=>r.status==='PASS')?'PASS':'FAILED',test_type:'ACTUAL_CHROME_PLAYWRIGHT_ISOLATED_OCEAN_MAIN_SERVER',data:'SYNTHETIC_TEST_WORKFLOW_AND_S07_SCHEMA_FAITHFUL_TELEMETRY',mocks:'NONE; explicit offline-browser and expired synthetic-session fault injection',base_url:base,results,page_errors:errors,production_service_state:'UNCHANGED',bindings:'S23/S28/S29 PENDING; no real Wayne approval or strategy activation'},null,2));
  await browser.close(); await host.close(); console.log(JSON.stringify({result:output,passed:results.filter(r=>r.status==='PASS').length,total:results.length}));
}
