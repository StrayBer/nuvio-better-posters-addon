import test from "node:test";
import assert from "node:assert/strict";
import { createConfig } from "../src/config.js";
import {
  buildProxyManifest,
  correctedSearchValue,
  decodeCatalogId,
  encodeCatalogId,
} from "../src/addon.js";

test("builds a Nuvio-compatible aggregate manifest", () => {
  const config = createConfig(["https://one.example/manifest.json", "https://two.example/manifest.json"]);
  const upstreams = [
    {
      manifestUrl: config.upstreams[0],
      manifest: {
        id: "one",
        name: "One",
        version: "1.0.0",
        types: ["movie"],
        idPrefixes: ["tt"],
        resources: ["catalog", "meta"],
        catalogs: [{ type: "movie", id: "popular", name: "Popular", extra: [{ name: "skip" }] }],
      },
    },
    {
      manifestUrl: config.upstreams[1],
      manifest: {
        id: "two",
        name: "Two",
        version: "1.0.0",
        types: ["movie", "series"],
        resources: [{ name: "stream", types: ["movie", "series"], idPrefixes: ["tt"] }],
        catalogs: [],
      },
    },
  ];

  const manifest = buildProxyManifest(config, upstreams, "https://proxy.example");
  assert.equal(manifest.catalogs.length, 1);
  assert.equal(manifest.catalogs[0].name, "Popular");
  assert.equal(manifest.name, "BetterPosters for Nuvio");
  assert.deepEqual(decodeCatalogId(manifest.catalogs[0].id), { upstreamIndex: 0, catalogId: "popular" });
  assert.ok(manifest.resources.some((resource) => resource.name === "meta"));
  assert.ok(manifest.resources.some((resource) => resource.name === "stream"));
  assert.deepEqual(decodeCatalogId(encodeCatalogId(3, "catalog/with symbols")), {
    upstreamIndex: 3,
    catalogId: "catalog/with symbols",
  });
});

test("names a single wrapped addon after its upstream", () => {
  const config = createConfig(["https://catalog.example/manifest.json"]);
  const manifest = buildProxyManifest(config, [{
    manifestUrl: config.upstreams[0],
    manifest: { id: "nuvio", name: "Nuvio Catalog Addon", version: "1.0.0", types: ["movie"], resources: ["catalog"], catalogs: [] },
  }], "https://proxy.example");
  assert.equal(manifest.name, "Nuvio Catalog - BetterPosters");
});

test("corrects misspelled search words from suggested titles", () => {
  const names = ["Superman", "Superman Returns", "Batman v Superman: Dawn of Justice", "Batman Begins"];
  assert.equal(correctedSearchValue("suerman", names), "superman");
  assert.equal(correctedSearchValue("batmn%20begins", names), "batman%20begins");
  assert.equal(correctedSearchValue("batmn+begins", names), "batman%20begins");
  assert.equal(correctedSearchValue("superman", names), null);
  assert.equal(correctedSearchValue("zzqqxxyy", names), null);
});
