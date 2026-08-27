import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createMigrationRedirectServer } from "../src/redirect-server.js";

test("legacy Render routes redirect to the same Worker path and query", async (t) => {
  const server = createMigrationRedirectServer({
    targetBaseUrl: "https://replacement.example",
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());

  const address = server.address();
  const response = await fetch(
    `http://127.0.0.1:${address.port}/encoded/catalog/movie/list.json?skip=20`,
    { redirect: "manual" },
  );

  assert.equal(response.status, 308);
  assert.equal(
    response.headers.get("location"),
    "https://replacement.example/encoded/catalog/movie/list.json?skip=20",
  );
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
});

test("legacy health check stays local so Render can resume safely", async (t) => {
  const server = createMigrationRedirectServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());

  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/health`);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: "ok",
    mode: "migration-redirect",
  });
});
