import { configFingerprint } from "./config.js";
import { rewriteCatalogResponse, rewriteMetaResponse } from "./posters.js";
import {
  buildUpstreamResourceUrl,
  fetchJson,
  loadUpstreams,
  normalizedResources,
  supportsResource,
} from "./upstreams.js";

const PROXIED_RESOURCES = ["meta", "stream", "subtitles"];

export function encodeCatalogId(upstreamIndex, catalogId) {
  return `bp_${upstreamIndex}_${Buffer.from(catalogId, "utf8").toString("base64url")}`;
}

export function decodeCatalogId(encoded) {
  const match = /^bp_(\d+)_([A-Za-z0-9_-]+)$/.exec(encoded);
  if (!match) throw new TypeError("Unknown BetterPosters catalog ID.");
  const upstreamIndex = Number(match[1]);
  const catalogId = Buffer.from(match[2], "base64url").toString("utf8");
  if (!Number.isSafeInteger(upstreamIndex) || !catalogId) {
    throw new TypeError("Invalid BetterPosters catalog ID.");
  }
  return { upstreamIndex, catalogId };
}

function mergedResource(upstreams, name) {
  const matches = upstreams.flatMap(({ manifest }) =>
    normalizedResources(manifest).filter((resource) => resource.name === name),
  );
  if (matches.length === 0) return null;

  const types = [...new Set(matches.flatMap((resource) => resource.types))];
  const anyUnrestrictedPrefix = matches.some((resource) => resource.idPrefixes.length === 0);
  const idPrefixes = anyUnrestrictedPrefix
    ? []
    : [...new Set(matches.flatMap((resource) => resource.idPrefixes))];
  return {
    name,
    ...(types.length > 0 ? { types } : {}),
    ...(idPrefixes.length > 0 ? { idPrefixes } : {}),
  };
}

export function buildProxyManifest(config, upstreams, publicBaseUrl) {
  const catalogs = upstreams.flatMap(({ manifest }, upstreamIndex) =>
    (Array.isArray(manifest.catalogs) ? manifest.catalogs : []).flatMap((catalog) => {
      if (!catalog || typeof catalog.id !== "string" || typeof catalog.type !== "string") return [];
      return [{
        ...catalog,
        id: encodeCatalogId(upstreamIndex, catalog.id),
        name: catalog.name || catalog.id,
      }];
    }),
  );
  const types = [...new Set([
    ...catalogs.map((catalog) => catalog.type),
    ...upstreams.flatMap(({ manifest }) => Array.isArray(manifest.types) ? manifest.types : []),
  ])];
  const resources = [];
  if (catalogs.length > 0) {
    resources.push({ name: "catalog", types: [...new Set(catalogs.map((catalog) => catalog.type))] });
  }
  for (const resourceName of PROXIED_RESOURCES) {
    const resource = mergedResource(upstreams, resourceName);
    if (resource) resources.push(resource);
  }

  return {
    id: `cc.btttr.nuvio.proxy.${configFingerprint(config)}`,
    version: "1.0.0",
    name: "BetterPosters Cinemeta Proxy",
    description: `BetterPosters wrapper for ${upstreams.length} addon${upstreams.length === 1 ? "" : "s"}. IMDb-backed catalog and metadata posters use poster-default.`,
    logo: `${publicBaseUrl.replace(/\/$/, "")}/logo.svg`,
    resources,
    types,
    catalogs,
    behaviorHints: {
      configurable: true,
      configurationRequired: false,
    },
  };
}

export async function proxyCatalog({
  upstreams,
  type,
  encodedCatalogId,
  rawExtraSegment,
  fetchOptions,
}) {
  const { upstreamIndex, catalogId } = decodeCatalogId(encodedCatalogId);
  const upstream = upstreams[upstreamIndex];
  if (!upstream) throw new RangeError("Catalog refers to an unavailable upstream addon.");
  const catalogExists = (Array.isArray(upstream.manifest.catalogs) ? upstream.manifest.catalogs : [])
    .some((catalog) => catalog?.id === catalogId && catalog?.type === type);
  if (!catalogExists) throw new RangeError("Catalog is not declared by its upstream addon.");

  const resourceUrl = buildUpstreamResourceUrl(
    upstream.manifestUrl,
    "catalog",
    type,
    catalogId,
    rawExtraSegment,
  );
  const payload = await fetchJson(resourceUrl, fetchOptions);
  return rewriteCatalogResponse(payload);
}

function dedupe(items, keyFor) {
  const seen = new Set();
  return items.filter((item) => {
    const key = keyFor(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function streamKey(stream) {
  if (stream?.url) return `url:${stream.url}`;
  if (stream?.infoHash) return `torrent:${stream.infoHash}:${stream.fileIdx ?? ""}`;
  if (stream?.externalUrl) return `external:${stream.externalUrl}`;
  return JSON.stringify(stream);
}

function subtitleKey(subtitle) {
  return `${subtitle?.url ?? JSON.stringify(subtitle)}|${subtitle?.lang ?? ""}`;
}

export async function proxyAggregateResource({
  upstreams,
  resource,
  type,
  id,
  rawExtraSegment,
  fetchOptions,
}) {
  if (!PROXIED_RESOURCES.includes(resource)) {
    throw new TypeError(`Unsupported proxy resource: ${resource}`);
  }
  const candidates = upstreams.filter(({ manifest }) => supportsResource(manifest, resource, type, id));
  if (candidates.length === 0) {
    if (resource === "meta") return { meta: null };
    return { [resource]: [] };
  }

  const responses = await Promise.all(candidates.map(async (upstream) => {
    const resourceUrl = buildUpstreamResourceUrl(
      upstream.manifestUrl,
      resource,
      type,
      id,
      rawExtraSegment,
    );
    try {
      return { ok: true, payload: await fetchJson(resourceUrl, fetchOptions) };
    } catch (error) {
      return { ok: false, error };
    }
  }));
  const successful = responses.filter((response) => response.ok).map((response) => response.payload);
  if (successful.length === 0) {
    const reason = responses[0]?.error?.message ?? "all upstream requests failed";
    throw new Error(`No upstream ${resource} response was available (${reason}).`);
  }

  if (resource === "meta") {
    const response = successful.find((payload) => payload?.meta && typeof payload.meta === "object");
    return response ? rewriteMetaResponse(response) : { meta: null };
  }
  if (resource === "stream") {
    const streams = successful.flatMap((payload) => Array.isArray(payload?.streams) ? payload.streams : []);
    return { streams: dedupe(streams, streamKey) };
  }

  const subtitles = successful.flatMap((payload) => Array.isArray(payload?.subtitles) ? payload.subtitles : []);
  return { subtitles: dedupe(subtitles, subtitleKey) };
}

export async function prepareAddon(config, publicBaseUrl, loadOptions = {}) {
  const upstreams = await loadUpstreams(config, loadOptions);
  return {
    upstreams,
    manifest: buildProxyManifest(config, upstreams, publicBaseUrl),
  };
}
