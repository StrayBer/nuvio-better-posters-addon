import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_MIGRATION_TARGET =
  "https://nuvio-better-posters.nuvio-better-posters-addon.workers.dev";

function migrationTarget(rawRequestUrl, configuredTarget) {
  const target = new URL(configuredTarget || DEFAULT_MIGRATION_TARGET);
  if (target.protocol !== "https:") {
    throw new Error("MIGRATION_TARGET_BASE_URL must use HTTPS.");
  }
  return new URL(rawRequestUrl || "/", `${target.origin}/`).toString();
}

function setCorsHeaders(response) {
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  response.setHeader("access-control-allow-headers", "content-type");
}

export function createMigrationRedirectServer(options = {}) {
  const targetBaseUrl = options.targetBaseUrl ?? process.env.MIGRATION_TARGET_BASE_URL;

  return createServer((request, response) => {
    setCorsHeaders(response);

    if (request.method === "OPTIONS") {
      response.statusCode = 204;
      response.end();
      return;
    }

    if (request.method === "GET" && request.url?.split("?", 1)[0] === "/health") {
      response.statusCode = 200;
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.setHeader("cache-control", "no-store");
      response.end(JSON.stringify({ status: "ok", mode: "migration-redirect" }));
      return;
    }

    try {
      response.statusCode = 308;
      response.setHeader("location", migrationTarget(request.url, targetBaseUrl));
      response.setHeader("cache-control", "public, max-age=86400");
      response.end();
    } catch (error) {
      response.statusCode = 500;
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.end(JSON.stringify({ error: error.message }));
    }
  });
}

function start() {
  const port = Number(process.env.PORT || 7000);
  const server = createMigrationRedirectServer();
  server.listen(port, "0.0.0.0", () => {
    console.log(`Redirecting legacy addon traffic to ${DEFAULT_MIGRATION_TARGET}`);
  });
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === resolve(currentFile)) {
  start();
}
