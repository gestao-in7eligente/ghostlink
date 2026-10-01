# Profile Photo Implementation Plan (servers, v0.2.2)

> **For agentic workers:** three parallel tracks meeting at a committed contract (the owner wants speed: one review per milestone). Each track works test-first and ends with `lint`, `typecheck` and its tests green. Commit only your own files (`git add <paths>`, never `-A`); another track commits in the same worktree, so retry once if `index.lock` is busy.

**Goal:** a person picks one photo in User Settings → Perfil (with crop, zoom and animated GIFs); it appears for everyone in every server that runs 0.2.2.

**Spec:** `docs/superpowers/specs/2026-10-01-foto-de-perfil-design.md`. Friends (spec §5) are **not** in this plan; they go to `v0.3-friends` later.

**Branch:** `v0.2-avatar` (from `main` at v0.2.1), worktree `.claude/worktrees/avatar`. The palette commit `237b04d` is already in.

## The contract (committed, `487bd30`)

- `packages/shared/src/avatar.ts`:
  - `AVATAR_LIMITS` (`maxBytes` 2 MB, `minSide` 16, `maxSide` 512, `outputSide` 256, `inputMaxBytes` 10 MB, `maxFrames` 300, `changesPerMinute` 5);
  - `FEATURE_AVATARS = 'avatars'`, `AVATAR_HASH`, `avatarHashSchema`;
  - `uploadBeginSchema` (`{ purpose: 'avatar', size, sha256 }`), `UploadBeginResult`, `AvatarUploadResult`, `avatarClearSchema`;
  - `imageInfo(bytes)`: PNG, JPEG, GIF and WebP type and sides from the bytes alone;
  - `avatarTarget(hash)`, `fileSignatureInput(target, sid, exp)`, `fileUrlExpiry(serverNowMs)`, `FILE_URL_MAX_AHEAD_S`.
- `Member.avatar: string | null`. The server's `repo.ts` already fills it from `users.avatar_file_id`, and the client schema turns a missing or bad value into `null`.
- Desktop:
  - `src/shared/profileTypes.ts`: `AvatarInfo`, `ProfileApi`, `avatarUrl(hash)` (`app://ghostlink/_avatar/<hash>`);
  - IPC `ghostlink:profile.avatar` / `.setAvatar(bytes)` / `.clearAvatar`;
  - `main/profileIpc.ts`: arg schemas, `ProfileIpcDeps`, handlers; `IpcDeps.profile` is optional until Track B wires it;
  - preload `window.ghostlink.profile`.
- Signed URLs: `GET /avatars/<hash>?sid=<sessionId>&e=<expUnix>&s=<base64url(HMAC-SHA256(fileToken, fileSignatureInput(avatarTarget(hash), sid, e)))>`. The welcome already carries `sessionId`, `serverTime` and `fileToken`; main strips `fileToken` before the renderer.

## Track A: server

**Owns:** `apps/server/src/avatars/**` (new module), one line in `apps/server/src/defaultModules.ts`, the smallest possible hook in `apps/server/src/text/**` to broadcast `member.updated` (or reuse an existing one), tests `apps/server/test/avatars*.test.ts`.

Read `apps/server/src/MODULES.md` first and follow it (handlers, `welcome`, `features`, `http`, `isCurrent()`, rate limits with `SlidingWindowLimiter`, never log URLs).

| Unit | Responsibility |
|---|---|
| `features` | Adds `avatars` to every welcome. |
| `upload.begin` | Own account. Validates `uploadBeginSchema`; rate limit `changesPerMinute` per user (shared with `avatar.clear`). Returns a 256-bit base64url `uploadToken`, single use, valid 60 s, bound to that session, user, `size` and `sha256`. At most 3 open tokens per session. |
| `POST /upload?u=<token>` | Looks the token up and consumes it. Reads the body and cuts the connection as soon as it passes `size`; 60 s without progress also cuts it. Then checks, in order: length equals `size`, SHA-256 equals `sha256`, `imageInfo` is one of the four types, both sides within `minSide..maxSide`. Stores `<dataDir>/avatars/<hash>.<ext>` (temp file + rename; an existing file with that hash is reused). Sets `users.avatar_file_id = hash`, broadcasts `member.updated` to everyone, answers `200 { avatar: hash }`. Errors answer `400` with `{ code }` (`BAD_REQUEST`) or `403` for an unknown, used or expired token. CORS `*`, `OPTIONS` answered, `X-Content-Type-Options: nosniff`. |
| `avatar.clear` | Own account, same rate limit. Sets the column to null and broadcasts `member.updated`. |
| `GET /avatars/<hash>` | `hash` must match `AVATAR_HASH`. Finds the session by `sid` (an active session of this server). Refuses (`403`) an expired `e`, an `e` more than `FILE_URL_MAX_AHEAD_S` ahead, or a signature that does not match (`timingSafeEqual`). `404` when no file. Serves the bytes with the type from the extension, `nosniff`, `Cache-Control: private, max-age=86400`, CORS `*`. |
| Clean-up | After a change, a clear, or a member's removal (kick, ban, leave already null the column), delete `<hash>.*` files no user references. Also once at start (orphans from a crash). |

**Tests** (with `startTestServer({ modules: [...] })` and the existing helpers): the welcome flag; upload happy path and the `member.updated` event seen by a second client; wrong hash, wrong type (an SVG), too large, sides out of range, a lying `size`; token reused, expired, from another session; rate limit; `GET` without a signature, expired, too far ahead, tampered, valid; the orphan file deleted after a change and after a kick; behind the TCP proxy mode nothing changes (one test through `proxy` if a helper exists, otherwise skip with a note).

## Track B: desktop main

**Owns:** `apps/desktop/src/main/avatars/**` (new), `apps/desktop/src/main/profileIpc.ts`, the `_avatar` route in `apps/desktop/src/main/appProtocol.ts`, the wiring in `main/index.ts` and `main/ipc.ts`, the smallest hooks in `main/controller.ts` / `main/connection.ts` to reach the current connection, tests `apps/desktop/test/main/avatar*.test.ts` and `profileIpc.test.ts`.

**First step (a measurement, report it):** in development the page comes from the Vite server, not `app://`. Check that an `<img src="app://ghostlink/_avatar/<hash>">` loads there (a throwaway route returning a PNG is enough). If it does not, make it work (for example a dev-only rule) and say how.

| Unit | Responsibility |
|---|---|
| `avatarStore.ts` | My photo: `<userData>/profile/avatar.webp\|gif` + `avatar.json` (`{ version: 1, hash, mime }`), written atomically (`files.ts` helpers). `set(bytes)` checks again with `imageInfo`: only WebP or GIF, exactly `outputSide`×`outputSide`, at most `maxBytes`; otherwise `AppError('BAD_REQUEST')`. `clear()` removes both files. |
| `avatarCache.ts` | Others' photos: `<userData>/avatars/<hash>`. `put(hash, bytes)` refuses unless SHA-256 matches and `imageInfo` is one of the four types. Keeps the total under 100 MB, evicting the least recently read. |
| `avatarHttp.ts` | HTTPS to the connected server through `pinnedTlsConnect(options, pin)` (`connection.ts`): `upload(bytes)` = `upload.begin` over the existing connection, then `POST /upload?u=…`; `download(hash)` = the signed `GET /avatars/<hash>` with `fileUrlExpiry(Date.now() + serverClockOffset)`. 2 MB cap on the response, 30 s timeout. Never log URLs. |
| `avatarSync.ts` | After every `welcome` whose `features` include `avatars`, and after `setAvatar` / `clearAvatar` while connected: compare my member's `avatar` with my stored hash; upload or `avatar.clear` when they differ. A failure is logged (without URL) and retried at the next welcome. Servers without the flag: do nothing. |
| `_avatar` route | `app://ghostlink/_avatar/<hash>`: hash must be 64 hex. Mine → my file. In the cache → serve it. Otherwise, if connected to a server with `avatars`, download, `put`, serve. Concurrent requests for one hash share one download. Anything else → `404`. `Content-Type` from `imageInfo`, `nosniff`, `Cache-Control: no-cache`. |
| `profileIpc.ts` | Handlers on top of the store and the sync. `setAvatar` returns `AvatarInfo` as soon as it is stored; the upload runs after it. |

**Tests:** store (valid WebP/GIF accepted, PNG and wrong sides refused, atomic files, clear); cache (hash mismatch refused, eviction order, limit); sync decisions (same hash → nothing; differs → upload; local none → clear; no flag → nothing; failure → retried at next welcome) with fakes; HTTP against a real `startTestServer` with Track A's module if it is in by then, otherwise against a local HTTPS fake with a self-signed cert and the pin; the route (bad hash `404`, mine, cached, downloaded once for two concurrent requests).

## Track C: renderer

**Owns:** `apps/desktop/src/renderer/features/profile/**` (new), `renderer/stores/profile.ts` (new), the `Avatar` component in `renderer/layout/primitives.tsx` (+ its CSS) and its call sites (`features/chat/MessageItem.tsx`, `features/members/MemberList.tsx`, `features/server-settings/MembersTab.tsx`, `layout/UserPanel.tsx`, `integration/HomeLayout.tsx`, voice participants in `features/voice/**` only where an avatar is drawn), `layout/UserSettings.tsx`, `renderer/i18n/profile.*.ts`, the `gifenc` dependency, tests under `apps/desktop/test/renderer/` and `apps/desktop/test/e2e/avatar.e2e.ts`.

| Unit | Responsibility |
|---|---|
| `Avatar` | `{ hash?: string \| null, name: string, size, online? }`. With a hash: `<img src={avatarUrl(hash)} alt="">` inside the circle, `onError` falls back to initials. Without: the person's initials (`serverInitials`) on the blurple circle, the same look the Home rows use. Keeps the presence dot. Replace the grey silhouette everywhere. |
| `stores/profile.ts` | My `AvatarInfo \| null`: `load()`, `set(bytes)`, `clear()`. My own avatar always shows from here (immediate), not from the server's member. |
| `cropMath.ts` | Pure: from the image size, the 320 px frame, zoom (1–5) and offset → the source square `{ x, y, side }`, clamped so the circle never shows empty space. Zoom 1 = the image's shorter side fills the circle. |
| `encodeAvatar.ts` | Static: `OffscreenCanvas` 256×256 → `image/webp` quality 0.9. Animated (GIF or animated WebP with more than one frame): `ImageDecoder` frame by frame with durations, crop and scale each, encode a GIF with `gifenc` (palette per frame, `maxFrames`), and refuse above `maxBytes` with a typed error. A one-frame image always takes the static path. |
| `AvatarCropModal.tsx` | The layout `Modal`: the image in a 320×320 frame under a circular mask; drag to move (pointer events), the zoom slider; animated images play; Aplicar / Cancelar; a busy state while encoding; the "GIF grande demais…" error. |
| `ProfilePhoto.tsx` | Top of the Perfil tab: my avatar at 80 px, "Alterar foto" (file input: png, jpeg, webp, gif; above `inputMaxBytes` or undecodable → "Não deu para abrir essa imagem."), "Remover foto" when I have one. |
| `UserSettings.tsx` | The Perfil tab shows on the Home screen too (only the photo there); inside a server, the photo above the nickname form. |
| i18n | pt-BR and en for every text (`profile.*`). |

**Tests:** `cropMath` (zoom 1 centres, limits at every edge, max zoom, non-square images); the encoder's decision logic with the decoders injected (static vs animated, frame cap, size refusal); the profile store with a fake `window.ghostlink.profile`; `Avatar` picks image vs initials (render test if the repo has one, otherwise a pure helper).

**e2e `avatar.e2e.ts`** on the v0.1 harness (`v01.e2e.ts` is the model):
1. Ana hosts, Bia joins.
2. Ana opens User Settings → Perfil, sets a generated 300×200 PNG through the file input, applies the crop.
3. Bia sees an `img` whose `src` contains `_avatar/` for Ana in the member list and on Ana's message, and it has `naturalWidth === 256`.
4. Ana removes the photo; Bia sees Ana's initials again.
5. The Home screen's Perfil tab shows the photo section.

## Integration (me)

1. `npm run lint`, `npm run typecheck`, `npm test`, `npm run test:e2e`.
2. Manual: an animated GIF near 2 MB; a GIF that is too large; max zoom; a Railway server (proxy mode) after updating its image.
3. `docs/checklist-teste.md`: the spec §9 items.
