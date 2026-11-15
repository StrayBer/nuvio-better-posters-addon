import { createHash } from "node:crypto";
import { isDefaultPosterOptions, normalizePosterOptions } from "./posters.js";

export const MAX_UPSTREAMS = 20;
const MAX_MANIFEST_URL_LENGTH = 4_096;
const MAX_CONFIG_TOKEN_LENGTH = 64_000;

export function normalizeManifestUrl(input) {
  if (typeof input !== "string" || input.trim() === "") {
    throw new TypeError("Each upstream addon must have a manifest URL.");
  }

  let raw = input.trim();
  if (/^stremio:\/\//i.test(raw)) {
    raw = raw.replace(/^stremio:\/\//i, "https://");
  }
  if (raw.length > MAX_MANIFEST_URL_LENGTH) {
    throw new RangeError("An upstream manifest URL is too long.");
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new TypeError(`Invalid upstream manifest URL: ${raw}`);
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new TypeError("Upstream addon URLs must use HTTPS (or HTTP for explicitly enabled local development).");
  }
  if (url.username || url.password) {
    throw new TypeError("Credentials in upstream addon URLs are not supported.");
  }

  url.hash = "";
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path.endsWith("/manifest.json")
    ? path
    : `${path}/manifest.json`.replace(/^\/\//, "/");

  return url.toString();
}

export function createConfig(upstreams, poster) {
  if (!Array.isArray(upstreams)) {
    throw new TypeError("upstreams must be an array of addon manifest URLs.");
  }

  const normalized = [...new Set(upstreams.map(normalizeManifestUrl))];
  if (normalized.length === 0) {
    throw new RangeError("Add at least one upstream addon manifest URL.");
  }
  if (normalized.length > MAX_UPSTREAMS) {
    throw new RangeError(`At most ${MAX_UPSTREAMS} upstream addons can be wrapped at once.`);
  }

  // Default poster options are left out so that links created before poster
  // options existed keep the exact same token and addon ID.
  if (isDefaultPosterOptions(poster)) return { version: 1, upstreams: normalized };
  return { version: 1, upstreams: normalized, poster: normalizePosterOptions(poster) };
}

export function encodeConfig(config) {
  const canonical = createConfig(config.upstreams, config.poster);
  return Buffer.from(JSON.stringify(canonical), "utf8").toString("base64url");
}

export function decodeConfig(token) {
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_CONFIG_TOKEN_LENGTH) {
    throw new TypeError("Invalid addon configuration token.");
  }

  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch {
    throw new TypeError("Invalid addon configuration token.");
  }
  if (parsed?.version !== 1) {
    throw new TypeError("Unsupported addon configuration version.");
  }

  return createConfig(parsed.upstreams, parsed.poster);
}

export function configFingerprint(config) {
  return createHash("sha256").update(encodeConfig(config)).digest("hex").slice(0, 12);
}

export function environmentConfig(env = process.env) {
  const raw = env.UPSTREAM_ADDONS?.trim();
  if (!raw) return null;

  let entries;
  if (raw.startsWith("[")) {
    try {
      entries = JSON.parse(raw);
    } catch {
      throw new TypeError("UPSTREAM_ADDONS contains invalid JSON.");
    }
  } else {
    entries = raw.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  }
  return createConfig(entries);
}
