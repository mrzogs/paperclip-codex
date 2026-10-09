import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { digest } from './common.mjs';
import { exportFixture } from './operational-research-export.test-fixtures.mjs';

const require=createRequire(process.env.OCEAN_S21_NODE_MODULES?path.join(process.env.OCEAN_S21_NODE_MODULES,'package.json'):import.meta.url);
const {chromium}=require('playwright');
const evidence=process.env.OCEAN_RESEARCH_EXPORT_UI_ARTIFACTS || fs.mkdtempSync(path.join(os.tmpdir(),'ocean-report-export-ui-'));
fs.mkdirSync(evidence,{recursive:true});
async function pageFor(browser,f) {
  const context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true});
  const [name,value]=f.cookie.split('=');await context.addCookies([{name,value,url:f.base}]);
  const page=await context.newPage();
  // This session marker only allows UI initialization; actual HTTP reads require
  // the real isolated OceanAuth cookie. No service tokens reach the browser.
  await page.addInitScript(()=>sessionStorage.setItem('ocean-workflow-human-csrf','ISOLATED_READ_ONLY_UI'));
  await page.route('**/*',route=>new URL(route.request().url()).origin===f.base?route.continue():route.abort());
  return {page,context};
}
const settled=page=>page.waitForFunction(()=>document.querySelector('#content')?.getAttribute('aria-busy')==='false');
async function downloaded(page,selector) {
  const pending=page.waitForEvent('download');await page.locator(selector).click();const download=await pending;
  return fs.readFileSync(await download.path());
}

test('actual authenticated Chrome navigates raw reference to complete verified Research report and exports full bytes',async()=>{
  const f=await exportFixture(),browser=await chromium.launch({channel:'chrome',headless:true});
  try {
    const before=f.snapshot(),{page,context}=await pageFor(browser,f),errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(`${f.base}/improvement/artifacts/${f.artifactId}`);await settled(page);
    assert.equal(await page.locator('#content pre').textContent(),f.content);
    assert.deepEqual(await downloaded(page,'[data-action="download-artifact"]'),Buffer.from(f.content));
    await page.getByRole('link',{name:'View full Research report',exact:true}).click();await settled(page);
    assert.ok(page.url().endsWith('#full-research-report'));
    const expected=Buffer.from(JSON.stringify(f.report,null,2));
    assert.equal(digest(await page.locator('#content pre').textContent()),digest(expected));
    assert.ok((await page.locator('#content').innerText()).includes(digest(expected)));
    assert.deepEqual(await downloaded(page,'[data-action="download-research-report"]'),expected);
    for(const [width,height,label] of [[1440,1000,'desktop'],[390,844,'mobile']]) {
      await page.setViewportSize({width,height});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      await page.screenshot({path:path.join(evidence,`full-research-report-${label}.png`),fullPage:false,animations:'disabled'});
    }
    await page.reload();await settled(page);assert.equal(digest(await page.locator('#content pre').textContent()),digest(expected));
    await page.getByRole('link',{name:'View raw artifact',exact:true}).click();await settled(page);
    assert.equal(new URL(page.url()).hash,'');assert.equal(await page.locator('#content pre').textContent(),f.content);
    await page.goBack();await page.getByRole('heading',{name:'Research report',exact:true}).waitFor();await settled(page);
    assert.equal(digest(await page.locator('#content pre').textContent()),digest(expected));
    assert.deepEqual(errors,[]);assert.deepEqual(f.snapshot(),before);await context.close();
  }finally{await browser.close();await f.close();}
});

test('actual browser historical v2 report view and download retain inline bytes',async()=>{
  const f=await exportFixture({large:false,compactInline:true,version:'ocean-cumulative-research/v2'}),browser=await chromium.launch({channel:'chrome',headless:true});
  try {
    const {page}=await pageFor(browser,f);
    await page.goto(`${f.base}/improvement/artifacts/${f.artifactId}#full-research-report`);await settled(page);
    assert.equal(await page.locator('#content pre').textContent(),f.content);
    assert.deepEqual(await downloaded(page,'[data-action="download-research-report"]'),Buffer.from(f.content));
    assert.match(await page.locator('#content').innerText(),/Original inline report/);
  }finally{await browser.close();await f.close();}
});

test('actual browser rejects corrupted full-report response instead of displaying or exporting it',async()=>{
  const f=await exportFixture(),browser=await chromium.launch({channel:'chrome',headless:true});
  try {
    const {page}=await pageFor(browser,f);
    // Explicit transport fault on the isolated host; production backend is unchanged.
    await page.route('**/research-report/download',async route=>{
      const original=await route.fetch();await route.fulfill({response:original,body:'{"corrupt":true}'});
    });
    await page.goto(`${f.base}/improvement/artifacts/${f.artifactId}#full-research-report`);await settled(page);
    assert.equal(await page.locator('#content pre').count(),0);
    assert.equal(await page.locator('[data-action="download-research-report"]').count(),0);
    assert.match(await page.locator('#notice').innerText(),/RESEARCH_FULL_REPORT_HASH_CONFLICT|Research full report hash conflict/i);
  }finally{await browser.close();await f.close();}
});
