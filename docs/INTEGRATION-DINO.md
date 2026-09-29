# Dino integration

capturekit is standalone: it captures any URL and needs nothing from Dino. Dino is
one of several possible destinations for a run. This document fixes the boundary
so neither side has to know the other's internals.

## Why two projects

The PRD lists "a hosted SaaS, accounts, or billing" and "a visual editor or
annotation UI" as explicit non-goals, and states local-first as a principle. Dino
is a hosted SaaS with accounts, billing, RLS, and an annotation UI. Merging them
would contradict the product definition, force headless Chromium and ffmpeg into
Dino's `node:20-alpine` image, and require a minutes-long capture job to run
somewhere a web request cannot.

They do share one thing: the artifact. capturekit produces exactly the material
Dino consumes — ordered images and short clips for client review.

## The contract

`manifest.json` is the interface. It is versioned (`schemaVersion: 1`) and
self-describing, so Dino never parses filenames.

```jsonc
{
  "schemaVersion": 1,
  "runId": "a1b2c3",
  "target": "http://localhost:3000",
  "gitRef": "feat/checkout@9f3c1d2",
  "summary": { "planned": 6, "succeeded": 6, "failed": 0, "retried": 0, "durationMs": 46680 },
  "assets": [
    {
      "page": "/",
      "viewport": "desktop",
      "type": "screenshot",
      "path": "screenshots/home/desktop.png",
      "width": 1920,
      "height": 1080,
      "deviceScaleFactor": 2,
      "fullPage": true,
      "format": "png",
      "bytes": 262826,
      "contentHeight": 1416,
      "attempts": 1,
      "durationMs": 4120,
      "strategy": "standard waits"
    }
  ],
  "failures": []
}
```

Failures are first-class in the manifest on purpose: a run that silently dropped
three pages would produce a gallery that looks complete and lies about the
product.

## Importing into Dino

One route, additive to Dino's existing REST API:

```
POST /api/v1/imports/capturekit
Authorization: Bearer dino_<api key>
{ "manifest": { ... }, "projectId": "optional", "title": "optional" }
```

Dino's side of the mapping is thin because the models already align:

| manifest | Dino |
|---|---|
| `assets[].type: "screenshot"` | `ProjectFile.type: "image"` |
| `assets[].path` + bytes | upload to the private bucket at `projects/{id}/{assetId}/{filename}` |
| `assets[].page` + `viewport` | `caption`, e.g. `/pricing — desktop` |
| `assets[].contentHeight` | `ProjectFile` metadata for tall captures |
| `gitRef`, `target` | `Project.description`, or a version title |
| run folder name | snapshot/version label |

Rules that protect Dino's core loop:

1. **Land as a draft.** Never auto-publish. The creator orders the assets into a
   story; that ordering is the product.
2. **Reuse, do not reimplement.** `safeFileName`, `signedUrlFor`,
   `thumbnailPath`, `FILE_BUCKETS`, `MAX_FILE_BYTES`, `makeSlug` already exist and
   are the right primitives.
3. **Cap by what will fit.** Respect the existing 100 MB per-file limit and plan
   quota checks, since a 6-viewport run is a lot of images.
4. **Refuse, don't guess.** A manifest with `schemaVersion` other than 1 or a
   `target` that does not match the uploaded files should be rejected with a
   clear error rather than partially imported.

capturekit's side is one publisher adapter, alongside the folder adapter it
already has:

```ts
publish: [{ type: "dino", apiKey: "DINO_API_KEY" }]
```

## What Dino gets that it could not produce alone

Dino reviews assets people upload. capturekit fills the gap in Dino's own feature
list ("screenshot / screen-recording attachments", "video transcoding +
posters") from the opposite direction: the site *is* the asset source. A
freelancer captures their live project, imports it, and gets a share link with
pinned comments on the exact pixel of a pricing table — without opening a
screenshot tool.

## Non-dependencies

- capturekit works with zero Dino configuration, and must keep working that way.
- Dino needs nothing installed to accept an import; there is no shared runtime.
- No shared database, auth, or secrets. The API key is the only credential.
- The static gallery in a run folder stays the default output. It is the
  zero-dependency deliverable for users who do not use Dino, and the fallback
  when a network publish is unavailable.
