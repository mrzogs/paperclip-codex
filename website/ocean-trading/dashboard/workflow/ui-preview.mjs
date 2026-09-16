import fs from 'node:fs';
import path from 'node:path';
import { startUiTestHost } from './ui-test-host.mjs';

// The preview runs the current main server against isolated synthetic TEST stores.
const host = await startUiTestHost();
const browser = await host.chromium.launch({channel:'chrome',headless:false});
const context = await browser.newContext({viewport:{width:1500,height:1000}});
const page = await context.newPage();
await page.goto(host.base+'/improvement/dashboard');
await page.locator('#credential').fill(process.env.OCEAN_WAYNE_BROWSER_SECRET);
await page.getByRole('button',{name:'Sign in',exact:true}).click();
await page.locator('#login').waitFor({state:'detached'});
await page.getByRole('heading',{name:'Overview',exact:true}).waitFor();
const preview = {status:'RUNNING_ISOLATED_TEST_PREVIEW',url:host.base+'/improvement/dashboard',pid:process.pid,started_at_utc:new Date().toISOString(),maximum_lifetime_minutes:120,credentials:'MEMORY_ONLY_NOT_EXPORTED',production_service_state:'UNCHANGED'};
fs.writeFileSync(path.join(host.root,'artifacts/evidence/preview-binding.json'),JSON.stringify(preview,null,2));
console.log(JSON.stringify({preview_url:preview.url,namespace:'TEST',production_service_state:'UNCHANGED'}));
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await browser.close(); await host.close(); process.exit(0);
}
process.on('SIGINT',close); process.on('SIGTERM',close);
browser.on('disconnected',close);
setTimeout(close,120*60*1000);
