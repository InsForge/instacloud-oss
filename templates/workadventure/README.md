# WorkAdventure

Virtual office where avatars meet and talk by walking up.

[![Deploy on InstaCloud](https://cdn.jsdelivr.net/gh/InsForge/instacloud-oss@main/assets/deploy-button.svg)](https://instacloud.com/templates/workadventure)

**Check the licence before you deploy this.** WorkAdventure is AGPL-3.0 with the Commons Clause,
which removes the right to sell a product or service that is substantially this software. Running
it for your own team is what the clause leaves intact; reselling access to it is not. The terms are
in `play/LICENSE.txt` and `back/LICENSE.txt` upstream.

## Overview

[WorkAdventure](https://github.com/workadventure/workadventure) is a 2D virtual office. Everyone
gets a pixel-art avatar on a tile map, and walking up to someone opens a video and audio call with
them: proximity is the interface, instead of a meeting link. Maps carry interactive areas, so a
tile can open a website in a side panel, start a Jitsi room, or run a script through the Scripting
API. A built-in map editor lets you lay out your own office in the browser.

This template packages upstream's own published images. Nothing is rebuilt from source and nothing
is rebranded: `play`, `back` and `map-storage` are copied out of `thecodingmachine/workadventure-*`
at the pinned tag, and the favicon service is `matthiasluedtke/iconserver`, the same image
upstream's production Compose file uses.

What the template adds is a single container. Upstream self-hosts as six containers behind Traefik,
and two parts of that wiring a template cannot have. `play` reaches `back` over gRPC and `back`
reaches `map-storage` over gRPC, both on a private Docker network, which a template has no
equivalent of: `${services.<name>.host}` resolves to the edge router, which routes HTTP and nothing
else. And Traefik splits one hostname across those containers by path, where `play` alone needs two
of its ports on that hostname: one for HTTP and a second for the game's WebSocket, which are
separate listeners in `play/src/server.ts`. A template gets one routed port per service. So the
processes share one container, with nginx making the same splits Traefik makes upstream, and
`./entrypoint.sh` supervising them.

nginx also adds a password prompt in front of the whole site, which is this template's own addition
rather than upstream's. WorkAdventure has no password login: an install is either anonymous, where
anyone holding the URL walks in, or behind an OpenID Connect provider you run yourself. A URL that
is the whole credential is not something to hand out by default, so `ADMIN_USERNAME` and
`ADMIN_PASSWORD` gate every request. Share them with the people you want in the office.

## What you get by hosting it

- A virtual office at your own HTTPS URL, with proximity video and audio between whoever is in it.
- The built-in map editor, and `map-storage` behind it, so maps you draw are stored on your own
  volume at `/data/maps` rather than on someone else's host.
- Redis for the Scripting API's variables, at `/data/redis`, so a map that remembers state keeps
  remembering it across a restart.
- One password in front of all of it, which is more than an anonymous upstream install has.
- No admin API and no accounts: everyone past the password is an anonymous visitor who picks a name
  and an avatar, which is upstream's default self-hosted shape.

## What you need before deploying

- A username and password of your choosing, shared with everyone you invite in.
- Nothing else. The deploy comes up on upstream's public starter office; `START_ROOM_URL` points it
  somewhere else once you have a map of your own.

Two things worth knowing before you decide:

- **Video and audio are peer to peer.** Browsers connect directly to each other, which works on
  most home and office networks and fails on the strict ones. Upstream's answer is a TURN server,
  which is a machine of its own with its own UDP port range and is not part of this template.
  `TURN_SERVER`, `TURN_USER` and `TURN_PASSWORD` point at one you run.
- **Text chat is proximity chat only.** Upstream's persistent chat is backed by a Matrix homeserver,
  and no Matrix stack ships here, so the `MATRIX_*` settings are unset. File upload in chat is off
  for the same reason: the uploader container is not part of this image.

## Configuration

| Variable | What it does | Where the value comes from |
|---|---|---|
| `ADMIN_USERNAME` | Username for the password prompt in front of the site | You choose it. No colon, and letters, digits and `. _ @ -` only |
| `ADMIN_PASSWORD` | Password for that prompt, shared with everyone you invite | You choose it. Anyone holding it can enter, talk and edit maps |
| `START_ROOM_URL` | The room a visitor lands in | Optional. Defaults to upstream's public starter office. `/_/global/<host>/<path>.tmj` for a map on any HTTP host, `/~/<dir>/<file>.wam` for one you uploaded here |
| `ENABLE_TELEMETRY` | Upstream's daily ping with the version and a rough user count | Optional. On by default, which is what upstream asks installs to do. `false` turns it off |
| `SECURITY_EMAIL` | Address upstream notifies about a security flaw in this version | Optional. Needs `ENABLE_TELEMETRY` left on |
| `STUN_SERVER` | STUN URLs for WebRTC, comma separated | Optional. A public one such as `stun:stun.l.google.com:19302`, or one of your own |
| `TURN_SERVER` | TURN URL for users whose network refuses a direct connection | Optional. A Coturn server you run; none is included here |
| `TURN_USER`, `TURN_PASSWORD` | Static credentials for that TURN server | Optional. From your TURN server's configuration |
| `JITSI_URL` | Jitsi Meet host for map areas that open a meeting room | Optional. `meet.jit.si`, or a Jitsi you run. Unset disables those areas |
| `MAX_PER_GROUP` | How many people fit in one conversation bubble | Optional. Upstream's default is 4 |

`SECRET_KEY` and `MAP_STORAGE_API_TOKEN` are generated at deploy time. They are shared by the three
processes that sign and check the same tokens, and nobody needs to read either one back.

## After deploy

1. Open the service URL. The browser asks for the username and password you set.
2. Pick a name and an avatar. You land in the starter office.
3. Open the same URL in a second browser, or send it to someone with the password, and walk the two
   avatars together: the video call starts when they are close enough.
4. To make the office your own, open `/map-storage/ui/` and upload a map, then point
   `START_ROOM_URL` at it as `/~/<directory>/<file>.wam`. The map store asks for the same username
   and password as the site, so the browser is already holding them. Upstream's
   [map starter kit](https://github.com/workadventure/map-starter-kit) is the usual beginning, and
   the map editor inside the game edits a map once it lives here.

A restart keeps the maps on `/data/maps` and the Scripting API's variables in `/data/redis`. It
does not keep anything about a visitor: names and avatars live in their own browser.

## Links

- Upstream: [workadventure/workadventure](https://github.com/workadventure/workadventure)
- Documentation: [docs.workadventu.re](https://docs.workadventu.re/)
- Self-hosting guide: [docs.workadventu.re/admin/getting-started/self-hosting](https://docs.workadventu.re/admin/getting-started/self-hosting/)
- Images: `thecodingmachine/workadventure-play`, `thecodingmachine/workadventure-back` and
  `thecodingmachine/workadventure-map-storage` on Docker Hub, plus
  `matthiasluedtke/iconserver` (MIT)
- Licence: AGPL-3.0 with the Commons Clause, in `play/LICENSE.txt` upstream
