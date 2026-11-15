import configureTemplate from "../public/configure.html";
import logoSvg from "../public/logo.svg";
import { createBetterPostersFetchHandler } from "./fetch-handler.js";

function upstreamCacheTtl(input) {
  const pathname = new URL(input).pathname;
  if (pathname.endsWith("/manifest.json")) return 3600;
  if (pathname.includes("/meta/")) return 3600;
  if (pathname.includes("/catalog/")) return 300;
  if (pathname.includes("/subtitles/")) return 300;
  if (pathname.includes("/stream/")) return 15;
  return 60;
}

function cachedUpstreamFetch(input, init = {}) {
  const cacheTtl = upstreamCacheTtl(input);
  return fetch(input, {
    ...init,
    cf: {
      cacheEverything: true,
      cacheTtl,
      cacheTtlByStatus: {
        "200-299": cacheTtl,
        "404": 30,
        "500-599": 0,
      },
    },
  });
}

const handleRequest = createBetterPostersFetchHandler({
  configureTemplate,
  logoSvg,
  fetchOptions: { fetchImpl: cachedUpstreamFetch },
});

// Bump this when a deploy changes what catalog or metadata answers contain,
// so copies saved at the edge by the previous version are not served.
const EDGE_CACHE_VERSION = "3";
const EDGE_CACHE_SECONDS = 300;

export default {
  // Catalog and metadata answers are kept at the edge for five minutes, so
  // repeat visits skip the upstream requests and poster checks.
  async fetch(request, env, ctx) {
    if (request.method !== "GET") return handleRequest(request, env);
    const url = new URL(request.url);
    const cacheable = url.pathname.includes("/catalog/") || url.pathname.includes("/meta/");
    if (!cacheable) return handleRequest(request, env);

    url.searchParams.set("__edge", EDGE_CACHE_VERSION);
    const cacheKey = new Request(url.toString(), { method: "GET" });
    const cache = caches.default;
    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    const response = await handleRequest(request, env);
    if (response.status === 200) {
      // No stale-while-revalidate on the saved copy: it would keep an old
      // answer alive long after the five minutes are up.
      const copy = new Response(response.clone().body, response);
      copy.headers.set("cache-control", `public, max-age=${EDGE_CACHE_SECONDS}`);
      ctx.waitUntil(cache.put(cacheKey, copy));
    }
    return response;
  },
};
