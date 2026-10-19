import assert from 'node:assert/strict';
import test from 'node:test';
import { startUiTestHost } from './ui-test-host.mjs';

test('secondary approval-summary binding fault does not hide Strategies', async () => {
  const host = await startUiTestHost();
  const browser = await host.chromium.launch({ channel:'chrome', headless:true });
  const context = await browser.newContext({ viewport:{ width:1500, height:1000 } });
  const page = await context.newPage();
  try {
    const response = await page.goto(`${host.base}/improvement/strategies`, { waitUntil:'domcontentloaded' });
    assert.equal(response.status(), 200);
    await page.locator('#credential').waitFor();
    await page.route('**/api/workflow/view/dashboard', route => route.fulfill({
      status:503,
      contentType:'application/json',
      body:JSON.stringify({ error:{ code:'OPERATIONAL_FACTUAL_BINDING_CHANGED' } }),
    }));
    await page.locator('#credential').fill(process.env.OCEAN_WAYNE_BROWSER_SECRET);
    await page.getByRole('button', { name:'Sign in', exact:true }).click();
    await page.getByRole('heading', { name:'Strategies', exact:true }).waitFor();
    await page.locator('tbody').filter({ hasText:'VWAP Wave Pullback' }).waitFor();
    const notice = page.locator('#notice');
    await notice.filter({ hasText:"This page's records are available" }).waitFor();
    assert.match(await notice.innerText(), /Protected actions remain blocked/);

    await page.unroute('**/api/workflow/view/dashboard');
    await page.locator('#refresh').click();
    await notice.waitFor({ state:'hidden' });
  } finally {
    await browser.close();
    await host.close();
  }
});
