import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('Ocean hosts Quant routes and saved state on its own listener across restart', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ocean-quant-integration-'));
  process.env.NODE_ENV = 'test';
  process.env.OCEAN_WORKFLOW_ENABLED = '0';
  process.env.QT_DATA_DIR = data;
  const { server } = await import('./server.mjs');
  const listen = async () => {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${server.address().port}`;
  };
  const close = () => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  });
  try {
    let base = await listen();
    const home = await fetch(base);
    assert.match(await home.text(), /href="\/quant-terminal\/"/);
    const redirect = await fetch(`${base}/quant-terminal`, { redirect: 'manual' });
    assert.equal(redirect.status, 308);
    assert.equal(redirect.headers.get('location'), '/quant-terminal/');
    for (const asset of ['', 'js/app.js', 'js/api.js', 'js/chart.js', 'vendor/lightweight-charts.standalone.production.js']) {
      assert.equal((await fetch(`${base}/quant-terminal/${asset}`)).status, 200, asset);
    }
    const health = await (await fetch(`${base}/quant-terminal/api/health`)).json();
    assert.equal(health.app, 'quant-terminal');
    assert.equal(health.ok, true);
    const saved = { watchlists: { Main: ['YAHOO:NQ=F', 'YAHOO:ES=F', 'YAHOO:GC=F'] } };
    const update = await fetch(`${base}/quant-terminal/api/state`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', 'x-qt': '1' }, body: JSON.stringify(saved),
    });
    assert.equal(update.status, 200);
    assert.equal((await fetch(`${base}/quant-terminal/api/shutdown`, {
      method: 'POST', headers: { 'x-qt': '1' },
    })).status, 404);
    await close();
    base = await listen();
    const state = await (await fetch(`${base}/quant-terminal/api/state`)).json();
    assert.deepEqual(state.watchlists, saved.watchlists);
    assert.match(fs.readFileSync(new URL('./public/app.js', import.meta.url), 'utf8'), /ensureNavLink\(nav, "quant-terminal"/);
  } finally {
    if (server.listening) await close();
    fs.rmSync(data, { recursive: true, force: true });
  }
});
