import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { currentFixture, changeJson } from './current-execution.test-fixtures.mjs';

const require=createRequire(process.env.OCEAN_S21_NODE_MODULES?path.join(process.env.OCEAN_S21_NODE_MODULES,'package.json'):import.meta.url);
const {chromium}=require('playwright');
const evidence=process.env.OCEAN_CURRENT_EXECUTION_UI_ARTIFACTS || fs.mkdtempSync(path.join(os.tmpdir(),'ocean-current-ui-'));
fs.mkdirSync(evidence,{recursive:true});
const settled=page=>page.waitForFunction(()=>document.querySelector('#content')?.getAttribute('aria-busy')==='false');

test('actual authenticated Chrome shows current native warmup/scored/end phases without asserting coverage; stale proof expires during outage',async()=>{
  const f=await currentFixture({logicalVersion:'v0.1.1',sessionObservationMode:'sierra_trading_day_v1'}),
    browser=await chromium.launch({channel:'chrome',headless:true});try{
    const context=await browser.newContext({viewport:{width:1440,height:1000}}),[name,value]=f.cookie.split('=');
    await context.addCookies([{name,value,url:f.base}]);const page=await context.newPage(),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.addInitScript(()=>sessionStorage.setItem('ocean-workflow-human-csrf','ISOLATED_READ_ONLY_UI'));
    await page.route('**/*',route=>new URL(route.request().url()).origin===f.base?route.continue():route.abort());
    await page.goto(`${f.base}/improvement/runs/${f.runId}`);await settled(page);
    let text=await page.locator('#content').innerText();assert.match(text,/Current running verified/);assert.match(text,/Warmup/);
    assert.doesNotMatch(text,/Verify current physical progress/);assert.match(text,/No completion receipt recorded/);
    changeJson(f.controllerFile,{currentChartDateTime:'2025-09-01 00:00:00'});
    await page.locator('#refresh').click();await page.waitForFunction(()=>document.querySelector('#content')?.textContent.includes('Scored replay'));await settled(page);
    for(const [width,height,label] of [[1440,1000,'desktop'],[390,844,'mobile']]) {
      await page.setViewportSize({width,height});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      await page.screenshot({path:path.join(evidence,`current-execution-${label}.png`),fullPage:false,animations:'disabled'});
    }
    changeJson(f.controllerFile,{currentChartDateTime:'2025-09-13 00:00:00'});await page.locator('#refresh').click();
    await page.waitForFunction(()=>document.querySelector('#content')?.textContent.includes('End boundary awaiting stop'));await settled(page);
    assert.match(await page.locator('#content').innerText(),/Running is not completion/);
    // Explicit isolated outage after a real server-computed proof window. No
    // production clock override: file mtime/freshness are native fixture inputs.
    changeJson(f.configFile,{freshness_seconds:30});
    changeJson(f.controllerFile,{currentChartDateTime:'2025-08-18 14:03:00'});const old=new Date(Date.now()-27000);
    fs.utimesSync(f.controllerFile,old,old);fs.utimesSync(f.controllerCommandFile,old,old);
    const reply=page.waitForResponse(response=>response.url()===`${f.base}/api/workflow/view/runs/${f.runId}` && response.status()===200);
    await page.locator('#refresh').click();
    const fresh=(await (await reply).json()).manager.execution;
    assert.equal(fresh.status,'CURRENT_RUNNING_VERIFIED');
    assert.ok(Date.parse(fresh.valid_until_utc)<Date.now()+4000,'outage begins only after the short-lived source proof is computed');
    await page.waitForFunction(()=>document.querySelector('#content')?.textContent.includes('Warmup is physically running'));
    await page.route('**/api/workflow/**',route=>route.fulfill({status:503,json:{error:{code:'MOCK_OUTAGE'}}}));
    await page.waitForFunction(()=>document.querySelector('#content')?.textContent.includes('previous physical observation has expired'),{},{timeout:10000});
    text=await page.locator('#content').innerText();assert.match(text,/Current execution unverified/);assert.doesNotMatch(text,/Current running verified/);
    assert.deepEqual(errors,[]);
  }finally{await browser.close();await f.close();}
});
