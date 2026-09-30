# Friends Phase 2 — Direct messages (text)

**Goal:** two friends talk in a 1:1 conversation from the Home screen: send, edit, delete and reply; messages written while the friend is offline arrive when both are online; unread counts, "digitando…" and notifications.

**Spec:** `docs/superpowers/specs/2026-09-30-amigos-dm-p2p-design.md` (§3.3, §3.4, §4, §8, §10, §11). Builds on Phase 1 (friend identity, links, the Friends home).

**Format:** two tracks meeting at a contract, as in Phase 1.

## The contract

- `apps/desktop/src/shared/dmTypes.ts` (committed): `DmConversation`, `DmMessage`, `DmEvent`, `DmApi`, `DM_TEXT_MAX`, `DM_PAGE`.
- To add when Phase 1 has landed (so its typecheck stays green meanwhile): the `ghostlink:dm.*` channels and `IPC_EVENTS.dm` in `shared/ipcTypes.ts`, `window.ghostlink.dm` in the preload, and the pinned lists in `test/shared/contract.test.ts` and `test/preload/preload.test.ts`.
- No new error codes: `P2P_UNAVAILABLE` (engine off), `NOT_FOUND` (unknown conversation or message), `FORBIDDEN` (editing someone else's message), `BAD_REQUEST` (empty or oversized text).

## Track A — the engine (main process)

**Owns:** `apps/desktop/src/main/p2p/**`, `apps/desktop/src/main/dmIpc.ts`, wiring in `main/ipc.ts` and `main/index.ts`, `main/notifications.ts` (one new kind), tests under `apps/desktop/test/main/`.

| File | Responsibility |
|---|---|
| `main/p2p/entries.ts` | The signed entry (spec §4.2): the bytes that are signed, sign, verify, the body schemas of `msg`, `edit` and `delete`, the 64 KiB cap. |
| `main/p2p/conversations.ts` | The 1:1 conversation id (spec §4.1) and who may write in it. |
| `main/p2p/store.ts` | Migration 2: `conversations`, `members`, `entries`, `messages` (spec §4.4). Appending an entry and updating the `messages` view happen in one transaction. |
| `main/p2p/sync.ts` | `sync.have`, `sync.want`, `entry` (spec §4.3): what each side is missing, in `seq` order, at most 500 entries per request; live delivery to the connected peer. |
| `main/p2p/frames.ts` | The new frame schemas: `sync.have`, `sync.want`, `entry`, `typing`. |
| `main/p2p/dm.ts` | The rules: open, send, edit, delete, read mark, unread count, delivered, typing (one signal every 3 s), hidden conversations. |
| `main/dmIpc.ts` | Strict zod arg schemas and handlers for the `dm.*` channels. |

**Behaviour to honour**

- An entry is accepted only if the signature checks, the author is one of the two members, `seq` is the author's next one and `ts` is not more than 5 minutes ahead. Anything else is dropped and the link closes on a bad signature.
- `edit` and `delete` apply only to the author's own message; the entry stays in the log either way.
- Sending never needs the friend online: the entry is stored and goes out on the next link (`sync`).
- `delivered` turns true when the friend's `sync.have` covers the entry's `seq`.
- Removing or blocking a friend stops syncing that conversation; the history stays readable (spec §5.3).
- A desktop notification (the existing settings apply) for a message in a conversation that is not open while the window is focused on it; clicking it opens the conversation.
- Never log message text.

**Tests**

- Unit: entry bytes, sign and verify, tampered body, wrong author, a gap in `seq`, a future `ts`, oversized entries; store transactions; unread and read mark; edit and delete rules.
- Integration over `hyperdht/testnet.js`: both online (live delivery both ways); the friend offline then online (the queued messages arrive in order); edit and delete reach the other side; `delivered`; a non-friend's entry is refused; typing signals are throttled.

## Track B — the conversation screen (renderer)

**Owns:** `apps/desktop/src/renderer/features/dm/**`, `renderer/stores/dm.ts`, the sidebar list and the center switch in `renderer/integration/HomeLayout.tsx`, the "Mensagem" action in `features/friends/FriendsHome.tsx`, `renderer/i18n/dm.*.ts`, tests under `apps/desktop/test/renderer/`.

- **Sidebar "Mensagens diretas":** one row per visible conversation, newest first: avatar with the presence dot, the friend's name, the unread badge, and "×" on hover to close it.
- **Center:** with "Amigos" selected, the Friends page; with a conversation selected, the chat: a header (name, presence), the message list and the composer.
  - The list reuses the safe markdown (`features/chat/markdown.ts`, `markdownRender.ts`), the date separators and the 5-minute grouping (`features/chat/grouping.ts` helpers) and the message styles of `chat.module.css`.
  - Own messages show "enviada" or "entregue"; hovering a message offers reply, and for own messages edit and delete (with a confirmation).
  - The composer: Enter sends, Shift+Enter breaks the line, a reply bar, editing in place, the 4000-character limit, and a note when the friend is offline ("chega quando vocês dois estiverem online").
  - Older messages load in pages of 50 when scrolling up; opening a conversation marks it read.
- **Friends page:** a round "Mensagem" button on each friend row opens the conversation.
- pt-BR and en for every text.

## Integration

1. `npm run lint`, `npm run typecheck`, `npm test`.
2. e2e on the private DHT (extends `friends.e2e.ts`): Ana and Bia become friends, exchange messages, Bia quits, Ana writes two more, Bia comes back and receives them in order; edit and delete show on the other side; the unread badge appears and clears.

## Deferred

Files and images (Phase 3), groups (Phase 4), calls (Phase 5), reactions and mentions (out of scope for v0.3).
