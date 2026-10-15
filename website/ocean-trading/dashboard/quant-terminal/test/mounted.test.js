import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const tempData = fs.mkdtempSync(path.join(os.tmpdir(), "ocean-quant-terminal-"));
process.env.QT_DATA_DIR = tempData;

const {
  handleQuantTerminalRequest,
  stopQuantTerminal,
} = await import("../server.js");

let server;
let base;

before(async () => {
  server = http.createServer((req, res) => {
    void handleQuantTerminalRequest(req, res, { basePath: "/quant-terminal" }).catch((error) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message }));
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  stopQuantTerminal();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tempData, { recursive: true, force: true });
});

test("serves the complete terminal below the Ocean route", async () => {
  const page = await fetch(`${base}/quant-terminal/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Quant Terminal/);

  const script = await fetch(`${base}/quant-terminal/js/app.js`);
  assert.equal(script.status, 200);

  const health = await (await fetch(`${base}/quant-terminal/api/health`)).json();
  assert.equal(health.ok, true);
  assert.equal(health.app, "quant-terminal");
});

test("keeps terminal writes scoped and disables process shutdown when mounted", async () => {
  const stateResponse = await fetch(`${base}/quant-terminal/api/state`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "x-qt": "1" },
    body: JSON.stringify({ watchlists: { Main: ["BINANCE:BTCUSDT"] } }),
  });
  assert.equal(stateResponse.status, 200);

  const shutdown = await fetch(`${base}/quant-terminal/api/shutdown`, {
    method: "POST",
    headers: { "x-qt": "1" },
  });
  assert.equal(shutdown.status, 404);
  assert.equal((await fetch(`${base}/quant-terminal/api/health`)).status, 200);
});
