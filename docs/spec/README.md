# Serving the specification at `ag-ui.com/spec`

Every schema file names its own web address in `$id`, and a tool that meets one
fetches that address to resolve it and any reference it makes. The address has
to serve the file. The shape chosen for the draft is the shape every frozen
version inherits, and frozen versions are permanent, so this layout is a
long-lived commitment rather than a deployment detail.

## What lives here

One folder per version holds both halves of that version:

```
/spec/draft                       the readable specification (index.mdx)
/spec/draft/basic/processing      a page
/spec/draft/events/lifecycle      a page
/spec/draft/schema.json           the machine-readable schema
```

Pages are `.mdx` files Mintlify renders. `schema.json` is a static file Mintlify
serves as-is, the same way it serves `/images/…`. They share a folder and must
never share a name — `spec/harness/publishing.test.ts` fails the build if a page
is ever named so that it would shadow a published file.

`schema.json` is written by the generator (`pnpm --filter @ag-ui/spec generate`)
as a byte-for-byte copy of `spec/draft/schema.json`, the file the SDKs are
generated from. Editing it here does nothing: the spec suite's drift gate
compares the committed bytes against a fresh generation and fails on any
difference. Change `spec/draft/schema.json` and regenerate.

## The Cloudflare configuration

`ag-ui.com` sits behind Cloudflare and redirects every path to
`docs.ag-ui.com`, preserving the path. That is right for every page and wrong
for the schema: a tool resolving `$id` must receive the file, not a redirect to
a different origin, and the schema's address must stay stable even if the docs
host changes.

Two rules carry `/spec/*`, and both live in the Cloudflare dashboard for the
`ag-ui.com` zone. **Owner: the CopilotKit team** — the zone is team-administered
rather than any one person's, so ask in the team channel for access.

### 1. Do not redirect `/spec/*` (Rules → Redirect Rules)

The existing apex redirect must skip `/spec/`. Amend its expression so it fires
only when the path is not under `/spec/`:

```
(http.host eq "ag-ui.com" and not starts_with(http.request.uri.path, "/spec/"))
```

`/spec/*` then falls through to the origin that serves the docs site, so both
the pages and the files are served at the apex without a hop.

### 2. Add the CORS header (Rules → Response Header Transform Rules)

Mintlify sends no cross-origin header, so a browser-based tool — an online
schema validator, a playground — cannot read the file. Add a response header
rule scoped to the schema files:

```
Expression:  (http.host eq "ag-ui.com" and starts_with(http.request.uri.path, "/spec/") and ends_with(http.request.uri.path, ".json"))
Set static:  Access-Control-Allow-Origin: *
```

`*` is correct here: these files are public, unauthenticated, and meant to be
read by anything.

### Content type

Mintlify serves `.json` as `application/json`. Confirm it rather than assume it
(step 3 below); if a future host does not, add `Content-Type: application/json`
to the same response header rule.

## Verifying by hand

No automated test watches Cloudflare — a test in this repository cannot see it,
and making every pull request depend on a live site would trade one silent
failure for a noisy one. Run these four commands after any change to the rules
above, and after any change of docs host:

```bash
# 1. The file is served directly, with no redirect on the way.
curl -sS -o /dev/null -w '%{http_code} %{num_redirects}\n' \
  https://ag-ui.com/spec/draft/schema.json          # expect: 200 0

# 2. It comes back as JSON, and it is THIS schema, not an older deployment.
curl -sS -D- -o /dev/null https://ag-ui.com/spec/draft/schema.json \
  | grep -i '^content-type'                          # expect: application/json
curl -sS https://ag-ui.com/spec/draft/schema.json | shasum -a 256
shasum -a 256 < spec/draft/schema.json               # expect: the same digest
#   $id alone proves nothing here: it is stable across every deployment of the
#   draft, so a site serving last month's file states exactly the same address.

# 3. A browser on another origin may read it.
curl -sS -D- -o /dev/null -H 'Origin: https://example.com' \
  https://ag-ui.com/spec/draft/schema.json \
  | grep -i '^access-control-allow-origin'           # expect: *

# 4. Pages still render, and everything outside /spec/ still redirects.
curl -sSL -o /dev/null -w '%{http_code}\n' https://ag-ui.com/spec/draft
#                                                    expect: 200 — -L tolerated
#   in case the renderer answers the bare path with a redirect to the index
#   page. Either way the overview must come back; only 4xx/5xx is a failure.
curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' https://ag-ui.com/introduction
                                                     # expect: 3xx → docs.ag-ui.com/introduction
```

The distinction in step 4 is the one to keep straight: a page may redirect (the
retired page addresses do, to their new homes under `basic/` and `events/`), a
`.json` address may never.
