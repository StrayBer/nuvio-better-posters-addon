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

export default {
  // Catalog and metadata answers are kept at the edge for as long as their
  // Cache-Control allows, so repeat visits skip the upstream and poster checks.
  async fetch(request, env, ctx) {
    if (request.method !== "GET") return handleRequest(request, env);
    const pathname = new URL(request.url).pathname;
    const cacheable = pathname.includes("/catalog/") || pathname.includes("/meta/");
    if (!cacheable) return handleRequest(request, env);
    const cache = caches.default;
    const cached = await cache.match(request);
    if (cached) return cached;
    const response = await handleRequest(request, env);
    if (response.status === 200) ctx.waitUntil(cache.put(request, response.clone()));
    return response;
  },
};
