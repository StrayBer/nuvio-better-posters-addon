# BetterPosters for Nuvio

An unofficial Nuvio addon that gives your catalogs artwork from [BetterPosters](https://btttr.cc/).

## Quick install: Nuvio Catalog (recommended)

The [Nuvio Catalog](https://catalog.nuvio.tv/) has far more titles than Cinemeta. This link gives you all of its catalogs with BetterPosters artwork.

**Copy this manifest URL:**

```text
https://nuvio-better-posters.nuvio-better-posters-addon.workers.dev/eyJ2ZXJzaW9uIjoxLCJ1cHN0cmVhbXMiOlsiaHR0cHM6Ly9jYXRhbG9nLm51dmlvLnR2L21hbmlmZXN0Lmpzb24iXX0/manifest.json
```

1. In Nuvio, open **Settings → Addons**.
2. Add an addon using the manifest URL above.
3. Disable the original Nuvio Catalog (and Cinemeta) addon to avoid duplicate catalog rows.

## Quick install: Cinemeta only

```text
https://nuvio-better-posters.nuvio-better-posters-addon.workers.dev/eyJ2ZXJzaW9uIjoxLCJ1cHN0cmVhbXMiOlsiaHR0cHM6Ly92My1jaW5lbWV0YS5zdHJlbS5pby9tYW5pZmVzdC5qc29uIl19/manifest.json
```

## Pick your own poster style or catalog

Open the [configurator](https://nuvio-better-posters.nuvio-better-posters-addon.workers.dev/configure) to:

- choose what the posters show: rating (and which rating source), genre, trend tags, quality tags (4K, Dolby Vision, Atmos) and age rating, with a live preview;
- wrap a different addon, or a Nuvio Catalog link set to another language or country (configure it on catalog.nuvio.tv, copy the configured link and paste it in).

Do not enter private or secret addon URLs into the public configurator. Its generated configuration is encoded, not encrypted.

## What it does

- Replaces poster URLs in wrapped catalog and metadata responses with [BetterPosters](https://btttr.cc/) artwork, for titles with an IMDb ID and for titles that only have a TMDB ID.
- Titles BetterPosters has no artwork for keep their normal poster.
- Makes search forgive typos: when the wrapped catalog finds nothing (for example `suerman`), Cinemeta's search answers instead.
- Leaves streams and subtitles unchanged.

Because of how the addon protocol works, one addon cannot modify every other installed addon's posters. Each catalog addon must be wrapped separately, and already cached or Nuvio-native artwork may remain unchanged.

## Existing Render installs

The addon moved to Cloudflare Workers after the former Render free service reached its monthly bandwidth allowance. The Render deployment now contains only a lightweight permanent redirect that preserves the complete path and query string, so existing installed `nuvio-better-posters.onrender.com` URLs migrate automatically when that Render service is available again.

While Render itself is suspended, its hostname cannot send the redirect. During that gap, either temporarily disable the old addon or replace it with the Cloudflare manifest URL above.

This project is unofficial and is not affiliated with Nuvio, Cinemeta, Stremio, or BetterPosters.
