# Publishing the web app

The web app is a static bundle. Publishing it is one command once
`deploy/publish.env` exists:

```bash
cp deploy/publish.env.example deploy/publish.env   # then edit it
./deploy/publish.sh
```

`publish.env` is git-ignored on purpose: where a given operator publishes is not
a property of this project, and a live hostname does not belong in a public
repository.

## What publish.sh does

1. Builds `apps/web` with `BASE_PATH` set to `PUBLISH_BASE_PATH`, so asset URLs
   resolve under the subpath the app is served from.
2. Replaces `PUBLISH_LINK` with a symlink to `apps/web/dist` — refusing to touch
   it if it exists and is not already a symlink.
3. Fetches `PUBLISH_URL` and fails unless it returns 200 **and** the body
   contains `SPIKE Control Studio`.

That third check matters: a host with an SPA fallback will happily answer 200
with its own index page, which looks like a successful deploy until someone
opens it.

## Why a symlink rather than a copy

A symlink keeps a few hundred build artifacts out of the serving directory's
version control, and it makes redeploy a rebuild rather than a sync. Any server
that reads its static root from disk per request — Vite's `public/`, nginx,
Caddy — then serves the new build with no restart.

Two consequences worth knowing:

- The server must follow symlinks. nginx does by default; `disable_symlinks` on
  turns it off.
- If the serving directory is a git working tree, add the symlink to that repo's
  `.git/info/exclude`. Otherwise it shows up as untracked and someone's
  `git add -A` commits an absolute path that resolves nowhere else.

## Before you point this at anything public

`publish.sh` performs no authentication. It puts a static page on whatever host
you configure, and the app inside it is a **robot control surface**.

- Confirm what your host actually gates. Auth middleware that protects `/api/`
  frequently leaves static paths open, so the page can be reachable by anyone
  who knows the URL.
- The shipped `index.html` is `noindex, nofollow`. That keeps it out of search
  results; it is not access control.
- Serving the app is not the same as exposing hardware. Direct Web Bluetooth
  only ever reaches a hub in the room with the operator, and requires HTTPS plus
  a user gesture. Remote operation over WebRTC is MVP 2, and the auth gate is a
  prerequisite for it, not a follow-up.

Nothing about a static publish is suitable for driving a real robot from the
open internet.
