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
  async fetch(request, env) {
    return handleRequest(request, env);
  },
};
