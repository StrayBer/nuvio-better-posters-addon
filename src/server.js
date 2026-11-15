import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createConfig,
  decodeConfig,
  encodeConfig,
  environmentConfig,
} from "./config.js";
import {
  prepareAddon,
  proxyAggregateResource,
  proxyCatalog,
} from "./addon.js";

const CONFIGURE_TEMPLATE = readFileSync(new URL("../public/configure.html", import.meta.url), "utf8");
const LOGO_SVG = readFileSync(new URL("../public/logo.svg", import.meta.url), "utf8");
const MAX_REQUEST_BODY_BYTES = 128 * 1024;
const RESOURCE_NAMES = new Set(["catalog", "meta", "stream", "subtitles"]);

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

function setCommonHeaders(response) {
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  response.setHeader("access-control-allow-headers", "content-type");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
}

function send(response, statusCode, body, contentType, cacheControl = "no-store") {
  setCommonHeaders(response);
  response.statusCode = statusCode;
  response.setHeader("content-type", contentType);
  response.setHeader("cache-control", cacheControl);
  response.end(body);
}

function sendJson(response, statusCode, value, cacheControl = "no-store") {
  send(response, statusCode, JSON.stringify(value), "application/json; charset=utf-8", cacheControl);
}

function publicBaseUrl(request, env) {
  if (env.PUBLIC_BASE_URL) {
    const configured = new URL(env.PUBLIC_BASE_URL);
    if (configured.protocol !== "https:" && configured.protocol !== "http:") {
      throw new HttpError(500, "PUBLIC_BASE_URL must use HTTP or HTTPS.");
    }
    return configured.toString().replace(/\/$/, "");
  }
  const forwardedProtocol = request.headers["x-forwarded-proto"]?.split(",")[0]?.trim();
  const protocol = forwardedProtocol === "https" ? "https" : "http";
  const host = request.headers["x-forwarded-host"]?.split(",")[0]?.trim() || request.headers.host;
  if (!host) throw new HttpError(500, "Unable to determine the public addon URL.");
  return `${protocol}://${host}`;
}

async function readJsonBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_REQUEST_BODY_BYTES) {
      throw new HttpError(413, "Request body is too large.");
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Request body must be valid JSON.");
  }
}

function renderConfigure(upstreams = [], poster = null, topToday = true) {
  const safeInitialState = JSON.stringify({ upstreams, poster, topToday }).replace(/</g, "\\u003c");
  return CONFIGURE_TEMPLATE.replace("__INITIAL_UPSTREAMS_JSON__", safeInitialState);
}

function decodeSegment(value, label) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new HttpError(400, `Invalid ${label} path segment.`);
  }
}

function stripJsonSuffix(value, label) {
  if (!value.endsWith(".json")) {
    throw new HttpError(404, `${label} route must end in .json.`);
  }
  return value.slice(0, -5);
}

function parseResourceRoute(routeSegments) {
  const [resource, rawType, rawId, rawExtraWithSuffix] = routeSegments;
  if (!RESOURCE_NAMES.has(resource) || !rawType || !rawId || routeSegments.length > 4) {
    throw new HttpError(404, "Unknown addon resource route.");
  }

  const rawIdWithoutSuffix = rawExtraWithSuffix == null
    ? stripJsonSuffix(rawId, "Resource")
    : rawId;
  const rawExtraSegment = rawExtraWithSuffix == null
    ? null
    : stripJsonSuffix(rawExtraWithSuffix, "Resource");

  return {
    resource,
    type: decodeSegment(rawType, "type"),
    id: decodeSegment(rawIdWithoutSuffix, "id"),
    rawExtraSegment,
  };
}

function resolveConfiguredRoute(segments, env) {
  if (segments[0] === "manifest.json" || RESOURCE_NAMES.has(segments[0])) {
    const config = environmentConfig(env);
    if (!config) {
      throw new HttpError(400, "This deployment has no fixed upstream addons. Open /configure first.");
    }
    return { config, routeSegments: segments, token: null };
  }
  if (segments.length < 2) throw new HttpError(404, "Unknown route.");
  try {
    return {
      config: decodeConfig(segments[0]),
      routeSegments: segments.slice(1),
      token: segments[0],
    };
  } catch (error) {
    throw new HttpError(400, error.message);
  }
}

function statusForError(error) {
  if (error instanceof HttpError) return error.statusCode;
  if (error instanceof TypeError || error instanceof RangeError) return 400;
  return 502;
}

export function createBetterPostersServer(options = {}) {
  const env = options.env ?? process.env;
  const fetchOptions = options.fetchOptions ?? {};

  return createServer(async (request, response) => {
    try {
      if (request.method === "OPTIONS") {
        setCommonHeaders(response);
        response.statusCode = 204;
        response.end();
        return;
      }

      const url = new URL(request.url, "http://addon.invalid");
      const segments = url.pathname.split("/").filter(Boolean);
      const baseUrl = publicBaseUrl(request, env);

      if (request.method === "GET" && (segments.length === 0 || segments[0] === "configure")) {
        send(response, 200, renderConfigure(), "text/html; charset=utf-8");
        return;
      }
      if (request.method === "GET" && segments.length === 2 && segments[1] === "configure") {
        let config;
        try {
          config = decodeConfig(segments[0]);
        } catch (error) {
          throw new HttpError(400, error.message);
        }
        send(response, 200, renderConfigure(config.upstreams, config.poster ?? null, config.topToday !== false), "text/html; charset=utf-8");
        return;
      }
      if (request.method === "GET" && segments.length === 1 && segments[0] === "health") {
        sendJson(response, 200, { status: "ok" }, "no-store");
        return;
      }
      if (request.method === "GET" && segments.length === 1 && segments[0] === "logo.svg") {
        send(response, 200, LOGO_SVG, "image/svg+xml; charset=utf-8", "public, max-age=86400");
        return;
      }
      if (request.method === "POST" && segments.join("/") === "api/config") {
        const body = await readJsonBody(request);
        const config = createConfig(body?.upstreams, body?.poster, body?.topToday);
        const { upstreams } = await prepareAddon(config, baseUrl, fetchOptions);
        const token = encodeConfig(config);
        const manifestUrl = `${baseUrl}/${token}/manifest.json`;
        sendJson(response, 200, {
          manifestUrl,
          stremioUrl: manifestUrl.replace(/^https?:\/\//i, "stremio://"),
          addons: upstreams.map(({ manifest }) => ({ id: manifest.id, name: manifest.name })),
        });
        return;
      }

      if (request.method !== "GET") {
        throw new HttpError(405, "Method not allowed.");
      }

      const { config, routeSegments } = resolveConfiguredRoute(segments, env);
      const { upstreams, manifest } = await prepareAddon(config, baseUrl, fetchOptions);
      if (routeSegments.length === 1 && routeSegments[0] === "manifest.json") {
        sendJson(response, 200, manifest, "public, max-age=300");
        return;
      }

      const route = parseResourceRoute(routeSegments);
      if (route.resource === "catalog") {
        const payload = await proxyCatalog({
          upstreams,
          type: route.type,
          encodedCatalogId: route.id,
          rawExtraSegment: route.rawExtraSegment,
          fetchOptions,
          posterOptions: config.poster,
        });
        sendJson(response, 200, payload, "public, max-age=120");
        return;
      }

      const payload = await proxyAggregateResource({
        upstreams,
        resource: route.resource,
        type: route.type,
        id: route.id,
        rawExtraSegment: route.rawExtraSegment,
        fetchOptions,
        posterOptions: config.poster,
      });
      const cacheControl = route.resource === "stream"
        ? "public, max-age=15"
        : "public, max-age=300";
      sendJson(response, 200, payload, cacheControl);
    } catch (error) {
      const statusCode = statusForError(error);
      sendJson(response, statusCode, { error: error?.message ?? "Unexpected addon error." });
    }
  });
}

function start() {
  const port = Number(process.env.PORT || 7000);
  const server = createBetterPostersServer();
  server.listen(port, "0.0.0.0", () => {
    console.log(`BetterPosters for Nuvio is listening on http://127.0.0.1:${port}/configure`);
  });
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === resolve(currentFile)) {
  start();
}
