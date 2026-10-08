import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

test('isolated actual Chrome labels bridge heartbeat/historical activation and stopped failure recovery truthfully',async()=>{
  const require=createRequire(process.env.OCEAN_S21_NODE_MODULES
    ?path.join(process.env.OCEAN_S21_NODE_MODULES,'package.json'):import.meta.url);
  const {chromium}=require('playwright');
  const publicRoot=fileURLToPath(new URL('../public/',import.meta.url));
  const artifacts=process.env.OCEAN_FAILURE_UI_ARTIFACTS || fs.mkdtempSync(path.join(os.tmpdir(),'ocean-failure-ui-'));
  fs.mkdirSync(artifacts,{recursive:true});
  let browser;
  try {
    browser=await chromium.launch({channel:'chrome',headless:true});
    const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    const context=JSON.parse(fs.readFileSync(new URL('./contracts/2.1.0/shared-contracts/examples/positive-examples.json',import.meta.url),'utf8'))['run-context'];
    context.run_id='mock-stopped-u';context.expected_environment='REPLAY';
    const next='Reconcile the verified failed attempt, then reserve fresh exact coverage from mock-original-completed-u with a new run/context and reviewed producer pins. Retain this attempt as failed observations, not completed learning coverage.';
    const data={context,state:'ACTIVE',revision:2,strategy_name:'Explicit mock stopped run',events:[],
      manager:{namespace:'OPERATIONAL',context_status:'CURRENT',lease:{heartbeat_utc:'2026-10-08T16:57:50Z',expired:false},
        unique_canonical_count:0,processing_count:0,open_pins:0,progress:{pending_events:0,axes:{source_market:[],strategy_execution:[],processing_review:[]}},
        completion:null,completion_current:false,plan:{selection:{interval:{start_utc:'2025-08-31T23:00:00Z',end_utc:'2025-09-12T23:00:00Z'}}},
        execution:{status:'FAILED_STOP_VERIFIED',retained_trade_count:63,retained_fill_count:126,next_action:next}},
      learning:{eligible:false,stage:'NOT_DUE',loop_stage:'NOT_DUE',reasons:['RUN_NOT_COMPLETED'],next_action:'Await the learning result'}};
    // All requests are intercepted: this renders real UI bytes without any live authority or server.
    await page.route('**/*',async route=>{
      const url=new URL(route.request().url());
      if(route.request().method()!=='GET')return route.abort();
      if(url.pathname==='/api/workflow/view/runs/mock-stopped-u')return route.fulfill({json:data});
      if(url.pathname==='/api/workflow/view/dashboard')return route.fulfill({json:{counts:{action_required:0}}});
      if(url.pathname==='/api/workflow/session')return route.fulfill({json:{expires_at_utc:'2099-01-01T00:00:00Z'}});
      const relative=url.pathname.startsWith('/improvement/')?'workflow/index.html':url.pathname.slice(1);
      const file=path.resolve(publicRoot,relative);
      if(!file.startsWith(publicRoot) || !fs.existsSync(file))return route.fulfill({status:404,body:'Not found'});
      const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png'};
      return route.fulfill({body:fs.readFileSync(file),contentType:types[path.extname(file)] || 'application/octet-stream'});
    });
    await page.addInitScript(()=>sessionStorage.setItem('ocean-workflow-human-csrf','EXPLICIT_MOCK_ONLY'));
    await page.goto('http://127.0.0.1:49783/improvement/runs/mock-stopped-u');
    await page.waitForFunction(()=>document.querySelector('#content')?.getAttribute('aria-busy')==='false');
    for(const [width,height,label] of [[1440,1000,'desktop'],[390,844,'mobile']]) {
      await page.setViewportSize({width,height});
      const body=await page.locator('#content').innerText();
      for(const text of ['Bridge service heartbeat','Service lease (not replay execution)','Activation source quality (historical)',
        '63 trades / 126 fills; not completed coverage','reserve fresh exact coverage from mock-original-completed-u'])assert.ok(body.includes(text),text);
      assert.ok(!body.includes('See observed progress'));assert.ok(!body.includes('Await the learning result'));
      await page.screenshot({path:path.join(artifacts,`mock-failed-attempt-${label}.png`),fullPage:true});
    }
    assert.deepEqual(errors,[]);
  }finally{await browser?.close();}
});
