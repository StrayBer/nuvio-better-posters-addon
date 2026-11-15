const IMDB_ID_PATTERN = /(?:^|[^a-z0-9])(tt\d{5,12})(?=$|[^0-9])/i;
const TMDB_ID_PATTERN = /^tmdb:(\d{1,12})$/i;
const BETTER_POSTERS_ORIGIN = "https://btttr.cc";

export const RATING_SOURCES = ["avg", "IM", "TM", "RT", "MC", "TR", "LB", "RE"];

// The defaults match the plain `/poster/.../poster-default/` BetterPosters URL
// that version 1 of this addon always used.
export const DEFAULT_POSTER_OPTIONS = Object.freeze({
  genre: true,
  rating: true,
  quality: false,
  age: false,
  trend: true,
  ratingSource: "avg",
});

export function normalizePosterOptions(input) {
  const options = { ...DEFAULT_POSTER_OPTIONS };
  if (input == null) return options;
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Poster options must be an object.");
  }
  for (const key of ["genre", "rating", "quality", "age", "trend"]) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== "boolean") {
      throw new TypeError(`Poster option "${key}" must be true or false.`);
    }
    options[key] = input[key];
  }
  if (input.ratingSource !== undefined) {
    if (!RATING_SOURCES.includes(input.ratingSource)) {
      throw new TypeError("Unknown poster rating source.");
    }
    options.ratingSource = input.ratingSource;
  }
  return options;
}

export function isDefaultPosterOptions(options) {
  const normalized = normalizePosterOptions(options);
  return Object.keys(DEFAULT_POSTER_OPTIONS)
    .every((key) => normalized[key] === DEFAULT_POSTER_OPTIONS[key]);
}

// BetterPosters route prefix: poster (genre + rating), poster-g, poster-r,
// poster-n (neither), followed by q (quality tags) and/or a (age rating).
function routePrefix(options) {
  let base = "poster";
  if (options.genre && !options.rating) base = "poster-g";
  else if (!options.genre && options.rating) base = "poster-r";
  else if (!options.genre && !options.rating) base = "poster-n";
  const suffix = (options.quality ? "q" : "") + (options.age ? "a" : "");
  if (suffix) base += base.includes("-") ? suffix : `-${suffix}`;
  return base;
}

function queryString(options) {
  const params = [];
  if (!options.trend) params.push("tag=none");
  if (options.rating && options.ratingSource !== "avg") params.push(`rs=${options.ratingSource}`);
  return params.length > 0 ? `?${params.join("&")}` : "";
}

function imdbIdFrom(value) {
  if (typeof value !== "string") return null;
  return value.match(IMDB_ID_PATTERN)?.[1]?.toLowerCase() ?? null;
}

export function findImdbId(meta) {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;

  const candidates = [
    meta.id,
    meta.imdb_id,
    meta.imdbId,
    meta.imdb,
    meta.externalIds?.imdb,
    meta.externalIds?.imdbId,
    meta.external_ids?.imdb,
    meta.external_ids?.imdb_id,
    meta.behaviorHints?.imdbId,
    meta.poster,
  ];
  for (const candidate of candidates) {
    const id = imdbIdFrom(candidate);
    if (id) return id;
  }
  return null;
}

// Titles that only have a TMDB ID (`tmdb:123`) use BetterPosters' TMDB route,
// which needs to know whether the title is a movie or a series.
export function findTmdbRef(meta) {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
  const id = typeof meta.id === "string" ? meta.id.match(TMDB_ID_PATTERN)?.[1] : null;
  if (!id) return null;
  if (meta.type === "movie") return `movie-${id}`;
  if (meta.type === "series" || meta.type === "tv") return `series-${id}`;
  return null;
}

export function betterPosterUrl(imdbId, posterOptions) {
  const normalized = imdbIdFrom(imdbId);
  if (!normalized) return null;
  const options = normalizePosterOptions(posterOptions);
  return `${BETTER_POSTERS_ORIGIN}/${routePrefix(options)}/imdb/poster-default/${normalized}.jpg${queryString(options)}`;
}

export function betterPosterTmdbUrl(tmdbRef, posterOptions) {
  if (typeof tmdbRef !== "string" || !/^(movie|series)-\d{1,12}$/.test(tmdbRef)) return null;
  const options = normalizePosterOptions(posterOptions);
  return `${BETTER_POSTERS_ORIGIN}/${routePrefix(options)}/tmdb/poster-default/${tmdbRef}.jpg${queryString(options)}`;
}

export function rewriteMetaObject(meta, posterOptions) {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return meta;
  const imdbId = findImdbId(meta);
  const poster = imdbId
    ? betterPosterUrl(imdbId, posterOptions)
    : betterPosterTmdbUrl(findTmdbRef(meta), posterOptions);
  if (!poster) return meta;

  return {
    ...meta,
    poster,
    posterShape: "poster",
  };
}

export function rewriteCatalogResponse(payload, posterOptions) {
  if (!payload || typeof payload !== "object") return payload;
  if (!Array.isArray(payload.metas)) return payload;
  return {
    ...payload,
    metas: payload.metas.map((meta) => rewriteMetaObject(meta, posterOptions)),
  };
}

export function rewriteMetaResponse(payload, posterOptions) {
  if (!payload || typeof payload !== "object") return payload;
  if (Array.isArray(payload.meta)) {
    return { ...payload, meta: payload.meta.map((meta) => rewriteMetaObject(meta, posterOptions)) };
  }
  return { ...payload, meta: rewriteMetaObject(payload.meta, posterOptions) };
}
