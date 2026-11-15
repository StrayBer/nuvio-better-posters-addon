import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createBetterPostersServer } from "../src/server.js";
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

test("serves a generated manifest and rewrites catalog/meta posters end to end", async () => {
  clearManifestCache();
  const upstream = createServer((request, response) => {
    const pathname = new URL(request.url, "http://upstream.invalid").pathname;
    if (pathname === "/manifest.json") {
      json(response, {
        id: "test.upstream",
        name: "Test Upstream",
        version: "1.0.0",
        types: ["movie"],
        idPrefixes: ["tt"],
        resources: ["catalog", "meta", "stream", "subtitles"],
        catalogs: [{ type: "movie", id: "popular", name: "Popular", extra: [{ name: "skip" }] }],
      });
      return;
    }
    if (pathname.startsWith("/catalog/movie/popular")) {
      json(response, { metas: [{ id: "tt0111161", type: "movie", name: "Shawshank", poster: "old.jpg" }] });
      return;
    }
    if (pathname === "/meta/movie/tt0111161.json") {
      json(response, { meta: { id: "tt0111161", type: "movie", name: "Shawshank", poster: "old-meta.jpg" } });
      return;
    }
    if (pathname === "/stream/movie/tt0111161.json") {
      json(response, { streams: [{ url: "https://video.example/movie.mp4" }] });
      return;
    }
    if (pathname === "/subtitles/movie/tt0111161.json") {
      json(response, { subtitles: [{ url: "https://subs.example/en.vtt", lang: "eng" }] });
      return;
    }
    json(response, { error: "not found" }, 404);
  });
  const upstreamBase = await listen(upstream);
  const addon = createBetterPostersServer({
    env: {},
    fetchOptions: { validateUrl: async () => {} },
  });
  const addonBase = await listen(addon);

  try {
    const createResponse = await fetch(`${addonBase}/api/config`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ upstreams: [`${upstreamBase}/manifest.json`] }),
    });
    assert.equal(createResponse.status, 200);
    const generated = await createResponse.json();

    const manifestResponse = await fetch(generated.manifestUrl);
    assert.equal(manifestResponse.status, 200);
    const manifest = await manifestResponse.json();
    assert.equal(manifest.name, "Test Upstream - BetterPosters");
    const catalogId = manifest.catalogs[0].id;
    const configuredBase = generated.manifestUrl.replace(/\/manifest\.json$/, "");

    const catalog = await fetch(`${configuredBase}/catalog/movie/${catalogId}/skip=0.json`).then((response) => response.json());
    assert.equal(catalog.metas[0].poster, "https://btttr.cc/poster/imdb/poster-default/tt0111161.jpg");

    const meta = await fetch(`${configuredBase}/meta/movie/tt0111161.json`).then((response) => response.json());
    assert.equal(meta.meta.poster, "https://btttr.cc/poster/imdb/poster-default/tt0111161.jpg");

    const streams = await fetch(`${configuredBase}/stream/movie/tt0111161.json`).then((response) => response.json());
    assert.deepEqual(streams.streams, [{ url: "https://video.example/movie.mp4" }]);
  } finally {
    await Promise.all([close(addon), close(upstream)]);
  }
});
