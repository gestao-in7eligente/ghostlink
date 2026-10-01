# Friends Phase 1 — Friend identity, requests by code and the Friends home

**Goal:** the Home screen shows **Amigos** instead of servers: a friend code to share, requests by code, accept/decline/block/remove, and who is online, over direct P2P links.

**Spec:** `docs/superpowers/specs/2026-09-30-amigos-dm-p2p-design.md` (§2, §3, §5.1, §5.3, §8, §10, §11). Phase 0 (`FriendSwarm`, the smoke self-test) is done: §12.1.

**Format:** two parallel tracks that meet at a contract, as in `2026-09-28-v0.1-release.md` (the owner wants speed: one review per milestone). Each track works test-first and ends with `lint`, `typecheck` and its tests green.

## The contract (already committed)

- `apps/desktop/src/shared/friendsTypes.ts`: `Friend`, `FriendState`, `FriendsSnapshot`, `FriendsApi`, `normalizeFriendCode`, `FRIEND_CODE_SHAPE`.
- `apps/desktop/src/shared/ipcTypes.ts`: the `ghostlink:friends.*` channels, `IPC_EVENTS.friends`, `FriendsIpcChannel`.
- `apps/desktop/src/preload/index.ts`: `window.ghostlink.friends`.
- `apps/desktop/src/shared/appErrors.ts`: `FRIEND_CODE_INVALID`, `FRIEND_SELF`, `FRIEND_LIMIT`, `P2P_UNAVAILABLE`.

Neither track changes these without saying so in its report.

## Track A — the engine (main process)

**Owns:** `apps/desktop/src/main/p2p/**`, `apps/desktop/src/main/friendsIpc.ts`, minimal wiring in `main/ipc.ts`, `main/index.ts` and `main/identity.ts` (one method), `packages/shared/src/constants.ts` (new labels only), tests under `apps/desktop/test/main/p2p*.test.ts` and `friendsIpc.test.ts`.

| File | Responsibility |
|---|---|
| `main/identity.ts` | `IdentityStore.friendSeed()`: `HKDF-SHA256(masterSeed, salt "ghostlink/friend/v1", info "", 32)`. |
| `main/p2p/friendCode.ts` | Encode, decode and validate friend codes (spec §2): `GLF1-` + base32 of `friendPub ‖ inviteSecret ‖ checksum`, the inbox key derivation, the short code. |
| `main/p2p/frames.ts` | The wire codec (spec §3.3): 1 type byte + uint32 BE length + body; JSON frames up to 256 KiB, strict zod schemas for `hello`, `friend.request`, `inbox.hello`, `friend.accept`, `friend.remove`, `ping`, `pong`. |
| `main/p2p/store.ts` | `<userData>/friends.db` (`node:sqlite`, WAL, numbered migrations): tables `me` and `friends` (spec §4.4). |
| `main/p2p/swarm.ts` | `FriendSwarm` gains the inbox: a second listener on the inbox key, and `requestVia(inboxKey)` to reach someone's inbox. |
| `main/p2p/friends.ts` | The rules of spec §5.1 and §5.3: add by code, deliver the request (retry with backoff up to 10 min), incoming requests, accept, crossed requests, dismiss, remove, block, limits, presence. |
| `main/p2p/engine.ts` | The façade main uses: start/stop with the identity and `available`, snapshots with a revision, change events. |
| `main/friendsIpc.ts` | Strict zod arg schemas and handlers for the `friends.*` channels (pattern of `hostIpc.ts`). |

**Behaviour to honour**

- The firewall refuses every key that is not a friend, a `pending_out` target or (later) a group co-member, and is not blocked. Phase 0 finding: Hyperswarm's firewall also drops **outgoing** connections, so a key goes into the allow-list **before** `connectTo`.
- The inbox owner proves itself with `inbox.hello` (a signature by the friend key over the connection's handshake hash); the requester checks it before sending `friend.request`. An inbox connection carries that one request (≤ 1 KiB) and closes. At most 8 concurrent unknown connections and 30 per hour.
- The friend key derived by `node:crypto` from the friend seed and the key Hyperswarm derives from the same seed must be the same 32 bytes (a test asserts it).
- `newCode()` draws a new invite secret and moves the inbox; `setInbox(false)` stops listening; `setAvailable(false)` stops the engine. All three persist in `me`.
- The nickname in `hello` is the global nickname from the settings; a change is announced on open links.
- Snapshots: `running` is false with `code: null` when there is no usable identity. The engine follows identity changes (created, imported, deleted, locked).
- Development only (never when packaged): `GHOSTLINK_DHT_BOOTSTRAP="host:port,host:port"` and `GHOSTLINK_P2P_BIND=127.0.0.1`.
- Limits of spec §3.4 (500 friends, 100 pending incoming).

**Tests**

- Unit: friend code round trip and every rejection (prefix, length, alphabet, checksum, own code), frames (oversized, unknown type, extra keys), store migrations, the rules in `friends.ts` with fake links and an injected clock.
- Integration over `hyperdht/testnet.js` with two and three engines: request by code → `pending_in` → accept → both `friend` and `online`; crossed requests; target offline then online; dismiss; block (later requests dropped); remove (the other side loses the friend); a new code makes the old one unreachable; inbox off; a stranger on the main key never gets a link; the inbox limit; a fake inbox (right inbox key, wrong friend key) is refused by the requester.
- IPC: bad arguments are refused.

## Track B — the Friends home (renderer)

**Owns:** `apps/desktop/src/renderer/features/friends/**`, `renderer/stores/friends.ts`, `renderer/integration/HomeLayout.tsx` and `home.module.css`, `renderer/integration/homeModel.ts`, `renderer/i18n/friends.*.ts` (and the home keys in `integration.*.ts`), tests under `apps/desktop/test/renderer/`.

- **Sidebar:** the search button, the **Amigos** item with the count of pending incoming requests, and the **Mensagens diretas** section (its conversations arrive in Phase 2; until then it says so). "Identidade e backup" stays in the user settings only.
- **Center:** the top bar **Amigos · Online · Todos · Pendentes · Bloqueados** and the blue **Adicionar amigo**; search; rows with avatar, name (the local name wins), status line and round actions.
  - **Adicionar amigo:** a field for the code with the error messages of spec §10, and "Seu código" with copy and "Gerar código novo" (with a confirmation that says the old code stops working).
  - **Pendentes:** incoming (accept, decline, block) and outgoing (cancel), each with the short code.
  - More options on a friend: local nickname, remove, block.
- **Right:** "Ativo agora" keeps the server hosted on this computer.
- **Off states:** no identity, the engine off ("Ficar disponível para amigos" with a button to turn it on) or failed (`P2P_UNAVAILABLE`).
- Servers stay in the rail; the central server list of v0.2 leaves the Home.
- pt-BR and en for every text.

## Integration (after both tracks)

1. Full `npm run lint`, `npm run typecheck`, `npm test`.
2. e2e: two apps on a local testnet (`GHOSTLINK_DHT_BOOTSTRAP`): Ana copies her code, Bia adds it, Ana accepts, both show the other online; block and remove.
3. With the owner and a second person: a request and presence between two different networks over the public DHT (the check Phase 0 left open).

## Deferred to later phases

The `ghostlink://amigo/…` link, requests through a shared server (§5.2), conversations, files, groups and calls.
