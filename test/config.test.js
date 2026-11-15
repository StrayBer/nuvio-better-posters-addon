import test from "node:test";
import assert from "node:assert/strict";
import {
  createConfig,
  decodeConfig,
  encodeConfig,
  normalizeManifestUrl,
} from "../src/config.js";

test("normalizes and round-trips addon configuration", () => {
  assert.equal(
    normalizeManifestUrl("stremio://example.com/addon"),
    "https://example.com/addon/manifest.json",
  );
  const config = createConfig([
    "https://example.com/manifest.json",
    "https://example.com/manifest.json",
    "https://other.example/config/manifest.json?token=abc",
  ]);
  assert.equal(config.upstreams.length, 2);
  assert.deepEqual(decodeConfig(encodeConfig(config)), config);
});

test("rejects unsupported and credential-bearing upstream URLs", () => {
  assert.throws(() => normalizeManifestUrl("ftp://example.com/addon"), /HTTP/);
  assert.throws(() => normalizeManifestUrl("https://user:pass@example.com/addon"), /Credentials/);
  assert.throws(() => createConfig([]), /at least one/i);
});

test("keeps old tokens stable and round-trips poster options", () => {
  const plain = createConfig(["https://v3-cinemeta.strem.io/manifest.json"]);
  assert.equal(
    encodeConfig(plain),
    "eyJ2ZXJzaW9uIjoxLCJ1cHN0cmVhbXMiOlsiaHR0cHM6Ly92My1jaW5lbWV0YS5zdHJlbS5pby9tYW5pZmVzdC5qc29uIl19",
  );
  const sameAsDefault = createConfig(plain.upstreams, { genre: true, rating: true, trend: true });
  assert.equal(encodeConfig(sameAsDefault), encodeConfig(plain));

  const styled = createConfig(plain.upstreams, { quality: true, ratingSource: "IM" });
  assert.equal(styled.poster.quality, true);
  assert.deepEqual(decodeConfig(encodeConfig(styled)), styled);
  assert.notEqual(encodeConfig(styled), encodeConfig(plain));
});
