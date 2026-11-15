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

// Ranked "today" lists from BetterPosters, shown as the first rows of the
// addon. Their posters already carry the rank number and tags, so they are
// passed through untouched. The lists are a fixed top 25 with no paging.
const TOP_TODAY_CATALOGS = [
  { type: "series", id: "bp_top_shows_today", name: "Top Shows Today", source: "https://btttr.cc/catalog/series/tmdb-today-shows.json" },
  { type: "movie", id: "bp_top_movies_today", name: "Top Movies Today", source: "https://btttr.cc/catalog/movie/tmdb-today.json" },
];

// Preferred home-screen order for the Nuvio Catalog's rows: what is hot and
// new first, then the streaming services, then curated shelves, and the
// "pick a year / language" browsing rows last. Rows not listed here (and
// other addons' rows) keep their original order after these.
const PREFERRED_ROW_ORDER = [
  "trending-movies",
  "trending-series",
  "popular-movies",
  "popular-series",
  "new-and-upcoming-movies",
  "new-and-returning-series",
  "airing-today-series",
  "netflix-movies",
  "netflix-series",
  "disney-plus-movies",
  "disney-plus-series",
  "prime-video-movies",
  "prime-video-series",
  "critically-acclaimed-movies",
  "critically-acclaimed-series",
  "limited-series",
  "family-movies",
  "family-series",
  "documentaries",
  "documentary-series",
  "international-cinema",
  "international-series",
  "independent-and-festival-picks",
];
const BROWSE_ROWS_LAST = ["movies-by-year", "series-by-year", "movies-by-language", "series-by-language"];

function rowRank(catalogId) {
  const preferred = PREFERRED_ROW_ORDER.indexOf(catalogId);
  if (preferred >= 0) return preferred;
  const last = BROWSE_ROWS_LAST.indexOf(catalogId);
  return last >= 0 ? 2_000 + last : 1_000;
}

function addonName(upstreams) {
  if (upstreams.length !== 1) return "BetterPosters for Nuvio";
  const name = String(upstreams[0].manifest.name ?? "").replace(/\s+addon$/i, "").trim();
  return name ? `${name} - BetterPosters` : "BetterPosters for Nuvio";
}

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
  const wrappedCatalogs = upstreams.flatMap(({ manifest }, upstreamIndex) =>
    (Array.isArray(manifest.catalogs) ? manifest.catalogs : [])
      .filter((catalog) => catalog && typeof catalog.id === "string" && typeof catalog.type === "string")
      .map((catalog, index) => ({ catalog, index }))
      .sort((a, b) => rowRank(a.catalog.id) - rowRank(b.catalog.id) || a.index - b.index)
      .flatMap(({ catalog }) => {
      return [{
        ...catalog,
        id: encodeCatalogId(upstreamIndex, catalog.id),
        name: catalog.name || catalog.id,
      }];
    }),
  );
  const catalogs = [
    ...(config.topToday === false ? [] : TOP_TODAY_CATALOGS.map(({ type, id, name }) => ({ type, id, name }))),
    ...wrappedCatalogs,
  ];
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
    name: addonName(upstreams),
    description: `BetterPosters wrapper for ${upstreams.length} addon${upstreams.length === 1 ? "" : "s"}. Catalog and metadata posters come from btttr.cc.`,
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
  posterOptions,
}) {
  const topToday = TOP_TODAY_CATALOGS.find((catalog) => catalog.id === encodedCatalogId && catalog.type === type);
  if (topToday) {
    if (rawExtraSegment != null) return { metas: [] };
    const payload = await fetchJson(topToday.source, fetchOptions);
    return { metas: Array.isArray(payload?.metas) ? payload.metas : [] };
  }

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
  const searchValue = rawSearchValue(rawExtraSegment);
  if (searchValue == null) {
    return rewriteCatalogResponse(await fetchJson(resourceUrl, fetchOptions), posterOptions);
  }

  // Search. The Nuvio Catalog searches TMDB, which returns nothing for a
  // misspelled title ("suerman"). When the wrapped catalog comes back empty,
  // Cinemeta's typo-tolerant search is used as a spell-checker and the
  // corrected words are searched in the wrapped catalog again, so the results
  // still come from the full wrapped catalog. Only if that also finds nothing
  // are Cinemeta's own results returned.
  let payload = null;
  let failure = null;
  try {
    payload = await fetchJson(resourceUrl, fetchOptions);
  } catch (error) {
    failure = error;
  }
  if (hasMetas(payload)) return rewriteCatalogResponse(payload, posterOptions);

  const suggestions = await searchSuggestions(upstream.manifestUrl, type, searchValue, fetchOptions);
  if (suggestions) {
    const corrected = correctedSearchValue(searchValue, suggestions.names);
    if (corrected) {
      const correctedExtra = rawExtraSegment
        .split("&")
        .map((part) => (part.startsWith("search=") ? `search=${corrected}` : part))
        .join("&");
      try {
        const retried = await fetchJson(
          buildUpstreamResourceUrl(upstream.manifestUrl, "catalog", type, catalogId, correctedExtra),
          fetchOptions,
        );
        if (hasMetas(retried)) return rewriteCatalogResponse(retried, posterOptions);
      } catch {
        // Fall through to Cinemeta's own results.
      }
    }
    if (suggestions.metas.length > 0) {
      return rewriteCatalogResponse({ metas: suggestions.metas }, posterOptions);
    }
  }
  if (failure) throw failure;
  return rewriteCatalogResponse(payload, posterOptions);
}

const SPELLCHECK_HOST = "v3-cinemeta.strem.io";

function hasMetas(payload) {
  return Array.isArray(payload?.metas) && payload.metas.length > 0;
}

function rawSearchValue(rawExtraSegment) {
  if (typeof rawExtraSegment !== "string") return null;
  for (const part of rawExtraSegment.split("&")) {
    if (part.startsWith("search=") && part.length > "search=".length) {
      return part.slice("search=".length);
    }
  }
  return null;
}

// Asks Cinemeta for both movies and series: `names` (best matches first) feed
// the spell-checker, `metas` are the last-resort results for this type.
async function searchSuggestions(manifestUrl, type, searchValue, fetchOptions) {
  if (type !== "movie" && type !== "series") return null;
  if (new URL(manifestUrl).hostname === SPELLCHECK_HOST) return null;
  const search = async (searchType) => {
    try {
      const payload = await fetchJson(
        `https://${SPELLCHECK_HOST}/catalog/${searchType}/top/search=${searchValue}.json`,
        fetchOptions,
      );
      return Array.isArray(payload?.metas) ? payload.metas : [];
    } catch {
      return [];
    }
  };
  const [movies, series] = await Promise.all([search("movie"), search("series")]);
  const own = type === "movie" ? movies : series;
  const other = type === "movie" ? series : movies;
  const names = [];
  for (let index = 0; index < Math.max(own.length, other.length); index += 1) {
    for (const meta of [own[index], other[index]]) {
      if (typeof meta?.name === "string") names.push(meta.name);
    }
  }
  if (names.length === 0) return null;
  return { names, metas: own };
}

function words(text) {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

export function editDistance(a, b) {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length];
}

// Replaces each misspelled word of the search with the closest word found in
// the suggested titles. Returns a URL-encoded search value, or null when
// nothing needed correcting.
export function correctedSearchValue(rawValue, names) {
  let query;
  try {
    query = decodeURIComponent(rawValue.replace(/\+/g, " "));
  } catch {
    return null;
  }
  const vocabulary = [];
  const known = new Set();
  for (const name of names) {
    for (const word of words(name)) {
      if (!known.has(word)) {
        known.add(word);
        vocabulary.push(word);
      }
    }
  }
  const queryWords = words(query);
  if (queryWords.length === 0 || queryWords.length > 8) return null;

  let changed = false;
  const corrected = queryWords.map((word) => {
    if (known.has(word) || word.length < 3) return word;
    const allowed = word.length <= 4 ? 1 : word.length <= 8 ? 2 : 3;
    let best = null;
    let bestDistance = allowed + 1;
    for (const candidate of vocabulary) {
      if (Math.abs(candidate.length - word.length) >= bestDistance) continue;
      const distance = editDistance(word, candidate);
      if (distance < bestDistance) {
        best = candidate;
        bestDistance = distance;
      }
    }
    if (!best) return word;
    changed = true;
    return best;
  });
  return changed ? encodeURIComponent(corrected.join(" ")) : null;
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
  posterOptions,
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
    return response ? rewriteMetaResponse(response, posterOptions) : { meta: null };
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
