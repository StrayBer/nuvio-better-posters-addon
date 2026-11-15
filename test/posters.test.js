import test from "node:test";
import assert from "node:assert/strict";
import {
  betterPosterUrl,
  findImdbId,
  rewriteCatalogResponse,
  rewriteMetaResponse,
} from "../src/posters.js";

test("finds common IMDb ID representations", () => {
  assert.equal(findImdbId({ id: "tt0111161" }), "tt0111161");
  assert.equal(findImdbId({ id: "tmdb:278", externalIds: { imdb: "TT0111161" } }), "tt0111161");
  assert.equal(findImdbId({ id: "custom", poster: "https://images.example/tt0111161/poster.jpg" }), "tt0111161");
  assert.equal(findImdbId({ id: "tmdb:278" }), null);
});

test("rewrites IMDb and TMDB catalog posters without changing other items", () => {
  const original = {
    metas: [
      { id: "tt0111161", type: "movie", name: "The Shawshank Redemption", poster: "old.jpg" },
      { id: "custom:1", imdbId: "tt0068646", type: "movie", name: "The Godfather" },
      { id: "tmdb:550", type: "movie", name: "Fight Club", poster: "old.jpg" },
      { id: "tmdb:1396", type: "series", name: "Breaking Bad", poster: "old.jpg" },
      { id: "kitsu:1", type: "series", name: "No known ID", poster: "keep.jpg" },
    ],
  };
  const rewritten = rewriteCatalogResponse(original);

  assert.equal(rewritten.metas[0].poster, "https://btttr.cc/poster/imdb/poster-default/tt0111161.jpg");
  assert.equal(rewritten.metas[0].posterShape, "poster");
  assert.equal(rewritten.metas[1].poster, "https://btttr.cc/poster/imdb/poster-default/tt0068646.jpg");
  assert.equal(rewritten.metas[2].poster, "https://btttr.cc/poster/tmdb/poster-default/movie-550.jpg");
  assert.equal(rewritten.metas[3].poster, "https://btttr.cc/poster/tmdb/poster-default/series-1396.jpg");
  assert.equal(rewritten.metas[4].poster, "keep.jpg");
  assert.equal(original.metas[0].poster, "old.jpg");
});

test("rewrites full metadata responses", () => {
  const response = rewriteMetaResponse({
    meta: { id: "tt0903747", type: "series", name: "Breaking Bad", poster: "old.jpg" },
  });
  assert.equal(response.meta.poster, "https://btttr.cc/poster/imdb/poster-default/tt0903747.jpg");
});

test("builds BetterPosters URLs for each poster style", () => {
  const url = (options) => betterPosterUrl("tt0111161", options);
  assert.equal(url(), "https://btttr.cc/poster/imdb/poster-default/tt0111161.jpg");
  assert.equal(url({ genre: false }), "https://btttr.cc/poster-r/imdb/poster-default/tt0111161.jpg");
  assert.equal(url({ rating: false }), "https://btttr.cc/poster-g/imdb/poster-default/tt0111161.jpg");
  assert.equal(url({ genre: false, rating: false }), "https://btttr.cc/poster-n/imdb/poster-default/tt0111161.jpg");
  assert.equal(url({ quality: true, age: true }), "https://btttr.cc/poster-qa/imdb/poster-default/tt0111161.jpg");
  assert.equal(
    url({ genre: false, quality: true, trend: false, ratingSource: "IM" }),
    "https://btttr.cc/poster-rq/imdb/poster-default/tt0111161.jpg?tag=none&rs=IM",
  );
  assert.throws(() => url({ ratingSource: "nope" }), /rating source/);
  assert.throws(() => url({ genre: "yes" }), /true or false/);
});
