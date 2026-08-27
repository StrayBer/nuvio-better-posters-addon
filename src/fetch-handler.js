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

const MAX_REQUEST_BODY_BYTES = 128 * 1024;
const RESOURCE_NAMES = new Set(["catalog", "meta", "stream", "subtitles"]);

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

function commonHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  };
}

function send(status, body, contentType, cacheControl = "no-store") {
  return new Response(body, {
    status,
    headers: {
      ...commonHeaders(),
      "content-type": contentType,
      "cache-control": cacheControl,
    },
  });
}

function sendJson(status, value, cacheControl = "no-store") {
  return send(
    status,
    JSON.stringify(value),
    "application/json; charset=utf-8",
    cacheControl,
  );
}

function publicBaseUrl(request, env) {
  if (env.PUBLIC_BASE_URL) {
    const configured = new URL(env.PUBLIC_BASE_URL);
    if (configured.protocol !== "https:" && configured.protocol !== "http:") {
      throw new HttpError(500, "PUBLIC_BASE_URL must use HTTP or HTTPS.");
    }
    return configured.toString().replace(/\/$/, "");
  }
  const requestUrl = new URL(request.url);
  return requestUrl.origin;
}

async function readJsonBody(request) {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BODY_BYTES) {
    throw new HttpError(413, "Request body is too large.");
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_REQUEST_BODY_BYTES) {
    throw new HttpError(413, "Request body is too large.");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "Request body must be valid JSON.");
  }
}

function renderConfigure(template, upstreams = []) {
  const safeInitialState = JSON.stringify(upstreams).replace(/</g, "\\u003c");
  return template.replace("__INITIAL_UPSTREAMS_JSON__", safeInitialState);
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
    return { config, routeSegments: segments };
  }
  if (segments.length < 2) throw new HttpError(404, "Unknown route.");
  try {
    return {
      config: decodeConfig(segments[0]),
      routeSegments: segments.slice(1),
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

export function createBetterPostersFetchHandler(options = {}) {
  const configureTemplate = options.configureTemplate;
  const logoSvg = options.logoSvg;
  const fetchOptions = options.fetchOptions ?? {};
  if (typeof configureTemplate !== "string" || typeof logoSvg !== "string") {
    throw new TypeError("configureTemplate and logoSvg are required.");
  }

  return async function handleBetterPostersRequest(request, env = {}) {
    try {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: commonHeaders() });
      }

      const url = new URL(request.url);
      const segments = url.pathname.split("/").filter(Boolean);
      const baseUrl = publicBaseUrl(request, env);

      if (request.method === "GET" && (segments.length === 0 || segments[0] === "configure")) {
        return send(200, renderConfigure(configureTemplate), "text/html; charset=utf-8");
      }
      if (request.method === "GET" && segments.length === 2 && segments[1] === "configure") {
        let config;
        try {
          config = decodeConfig(segments[0]);
        } catch (error) {
          throw new HttpError(400, error.message);
        }
        return send(
          200,
          renderConfigure(configureTemplate, config.upstreams),
          "text/html; charset=utf-8",
        );
      }
      if (request.method === "GET" && segments.length === 1 && segments[0] === "health") {
        return sendJson(200, { status: "ok", platform: "cloudflare-workers" });
      }
      if (request.method === "GET" && segments.length === 1 && segments[0] === "logo.svg") {
        return send(200, logoSvg, "image/svg+xml; charset=utf-8", "public, max-age=86400");
      }
      if (request.method === "POST" && segments.join("/") === "api/config") {
        const body = await readJsonBody(request);
        const config = createConfig(body?.upstreams);
        const { upstreams } = await prepareAddon(config, baseUrl, fetchOptions);
        const token = encodeConfig(config);
        const manifestUrl = `${baseUrl}/${token}/manifest.json`;
        return sendJson(200, {
          manifestUrl,
          stremioUrl: manifestUrl.replace(/^https?:\/\//i, "stremio://"),
          addons: upstreams.map(({ manifest }) => ({ id: manifest.id, name: manifest.name })),
        });
      }

      if (request.method !== "GET") {
        throw new HttpError(405, "Method not allowed.");
      }

      const { config, routeSegments } = resolveConfiguredRoute(segments, env);
      const { upstreams, manifest } = await prepareAddon(config, baseUrl, fetchOptions);
      if (routeSegments.length === 1 && routeSegments[0] === "manifest.json") {
        return sendJson(200, manifest, "public, max-age=3600, stale-while-revalidate=86400");
      }

      const route = parseResourceRoute(routeSegments);
      if (route.resource === "catalog") {
        const payload = await proxyCatalog({
          upstreams,
          type: route.type,
          encodedCatalogId: route.id,
          rawExtraSegment: route.rawExtraSegment,
          fetchOptions,
        });
        return sendJson(200, payload, "public, max-age=300, stale-while-revalidate=3600");
      }

      const payload = await proxyAggregateResource({
        upstreams,
        resource: route.resource,
        type: route.type,
        id: route.id,
        rawExtraSegment: route.rawExtraSegment,
        fetchOptions,
      });
      const cacheControl = route.resource === "stream"
        ? "public, max-age=15"
        : "public, max-age=600, stale-while-revalidate=3600";
      return sendJson(200, payload, cacheControl);
    } catch (error) {
      const statusCode = statusForError(error);
      return sendJson(statusCode, { error: error?.message ?? "Unexpected addon error." });
    }
  };
}
