import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

test("open-trades builds its payload before committing a success response", () => {
  const source = fs.readFileSync(path.join(root, "server.mjs"), "utf8");
  const route = source.match(/if \(req\.url === "\/api\/open-trades"\) \{([\s\S]*?)\n  \}/)?.[1] || "";
  assert.ok(route, "open-trades route must remain present");
  assert.ok(
    route.indexOf("const payload = JSON.stringify(openTradesPayload())") < route.indexOf("res.writeHead(200"),
    "payload construction must finish before the 200 response is committed",
  );
  assert.match(route, /!res\.headersSent && !res\.writableEnded/);
});
