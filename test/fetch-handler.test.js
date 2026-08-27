import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createBetterPostersFetchHandler } from "../src/fetch-handler.js";
import { clearManifestCache } from "../src/upstreams.js";

function json(response, value, statusCode = 200) {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(value));
}

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  server.close();
  await once(server, "close");
}

test("web-standard handler preserves existing configured URL routes", async () => {
  clearManifestCache();
  const upstream = createServer((request, response) => {
    const pathname = new URL(request.url, "http://upstream.invalid").pathname;
    if (pathname === "/manifest.json") {
      json(response, {
        id: "test.worker-upstream",
        name: "Worker Test Upstream",
        version: "1.0.0",
        types: ["movie"],
        idPrefixes: ["tt"],
        resources: ["catalog", "meta"],
        catalogs: [{ type: "movie", id: "popular", name: "Popular" }],
      });
      return;
    }
    if (pathname === "/catalog/movie/popular.json") {
      json(response, {
        metas: [{ id: "tt0111161", type: "movie", name: "Shawshank", poster: "old.jpg" }],
      });
      return;
    }
    json(response, { error: "not found" }, 404);
  });
  const upstreamBase = await listen(upstream);
  const handler = createBetterPostersFetchHandler({
    configureTemplate: "<script>const initial = __INITIAL_UPSTREAMS_JSON__;</script>",
    logoSvg: "<svg></svg>",
    fetchOptions: { validateUrl: async () => {} },
  });

  try {
    const generated = await handler(new Request("https://worker.example/api/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ upstreams: [`${upstreamBase}/manifest.json`] }),
    })).then((response) => response.json());

    assert.match(generated.manifestUrl, /^https:\/\/worker\.example\//);
    const manifestResponse = await handler(new Request(generated.manifestUrl));
    assert.equal(manifestResponse.status, 200);
    const manifest = await manifestResponse.json();
    const configuredBase = generated.manifestUrl.replace(/\/manifest\.json$/, "");
    const catalogResponse = await handler(new Request(
      `${configuredBase}/catalog/movie/${manifest.catalogs[0].id}.json`,
    ));
    assert.equal(catalogResponse.status, 200);
    const catalog = await catalogResponse.json();
    assert.equal(
      catalog.metas[0].poster,
      "https://btttr.cc/poster/imdb/poster-default/tt0111161.jpg",
    );
  } finally {
    await close(upstream);
  }
});
