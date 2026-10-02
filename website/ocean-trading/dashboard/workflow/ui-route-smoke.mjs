import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { startUiTestHost } from './ui-test-host.mjs';

const host = await startUiTestHost();
const browser = await host.chromium.launch({channel:'chrome',headless:true});
const page = await browser.newPage({viewport:{width:1500,height:1000}});
const results = [];
try {
  await page.goto(host.base+'/improvement/dashboard');
  await page.locator('#credential').fill(process.env.OCEAN_WAYNE_BROWSER_SECRET);
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await page.locator('#login').waitFor({state:'detached'});
  for (const [route,title] of [['cases','Cases'],['approvals','Approvals'],['runs','Runs'],['runs/test-ui-run-0','test-ui-run-0']]) {
    const response = await page.goto(host.base+'/improvement/'+route);
    assert.equal(response.status(),200);
    await page.getByRole('heading',{name:title,exact:true}).waitFor();
    const text = await page.locator('#content').innerText();
    assert.ok(text.includes('VWAP Wave Pullback'));
    if(route.includes('/')) for (const label of ['Declared environment','Observed environment','Completion and coverage','No completion receipt recorded.']) assert.ok(text.includes(label),label);
    results.push({route:'/improvement/'+route,status:'PASS',type:'ACTUAL_CHROME_MAIN_SERVER_SYNTHETIC_TEST'});
  }
  await page.screenshot({path:path.join(host.root,'artifacts/screenshots/run-desktop.png')});
  fs.writeFileSync(path.join(host.root,'artifacts/evidence/ui-route-smoke-results.json'),JSON.stringify({status:'PASS',base_url:host.base,results},null,2));
  console.log(JSON.stringify({status:'PASS',routes:results.length}));
} finally { await browser.close(); await host.close(); }
