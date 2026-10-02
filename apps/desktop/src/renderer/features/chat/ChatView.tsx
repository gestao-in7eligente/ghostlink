import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Hash } from 'lucide-react';
import { FEATURE_ATTACHMENTS, MB, PERMISSIONS, has, roleColorHex, type Channel, type Message } from '@ghostlink/shared';
import { ATTACHMENT_IPC_MAX_BYTES, serverFileUrl } from '../../../shared/attachmentTypes.js';
import { useT } from '../../i18n/index.js';
import { ConfirmDialog } from '../../layout/primitives.js';
import { readMark } from '../../stores/channels.js';
import { useConnectionStore } from '../../stores/connection.js';
import { channelLog, typingUserIds } from '../../stores/messages.js';
import { myPermissions } from '../../stores/server.js';
import { dispatchText, useTextStore } from '../../stores/text.js';
import { mentionsUser } from '../../stores/textState.js';
import { useSettingsStore } from '../../stores/settings.js';
import { MAX_ATTACHMENTS, type TrayLimits } from '../attachments/attachmentModel.js';
import a from '../attachments/attachments.module.css';
import { DropOverlay, useFileDrop, useTray } from '../attachments/filePicking.js';
import { deleteMessage, dropMessage, loadHistory, markRead, retryMessage, toggleReaction } from './actions.js';
import c from './chat.module.css';
import { Composer } from './Composer.js';
import { useComposerStore } from './composerStore.js';
import { EmojiPicker } from './EmojiPicker.js';
import type { MarkdownContext } from './markdownRender.js';
import { MessageList, type MessageListHandle } from './MessageList.js';
import type { MessageEnv } from './MessageItem.js';
import { memberName, plainContent } from './notify.js';

/** The open text channel: header, messages, "digitando…" and the composer. */
export function ChatView() {
  const t = useT();
  const channel = useTextStore((s) => (s.channels.activeId !== null && Object.hasOwn(s.channels.byId, s.channels.activeId) ? s.channels.byId[s.channels.activeId]! : null));
  if (!channel) {
    return (
      <div className={c.empty}>
        <p>{t('layout.noChannel')}</p>
      </div>
    );
  }
  return <OpenChannel key={channel.id} channel={channel} />;
}

function useWindowFocus(): boolean {
  const [focused, setFocused] = useState(() => document.hasFocus() && document.visibilityState === 'visible');
  useEffect(() => {
    const update = () => setFocused(document.hasFocus() && document.visibilityState === 'visible');
    window.addEventListener('focus', update);
    window.addEventListener('blur', update);
    document.addEventListener('visibilitychange', update);
    return () => {
      window.removeEventListener('focus', update);
      window.removeEventListener('blur', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, []);
  return focused;
}

function OpenChannel({ channel }: { channel: Channel }) {
  const t = useT();
  const locale = useSettingsStore((s) => s.settings?.locale ?? 'pt-BR');
  const server = useTextStore((s) => s.server);
  const members = useTextStore((s) => s.members);
  const log = useTextStore((s) => channelLog(s.messages, channel.id));
  const mark = useTextStore((s) => readMark(s.channels, channel.id));
  const focused = useWindowFocus();
  const [atBottom, setAtBottom] = useState(true);
  const [highlight, setHighlight] = useState<number | null>(null);
  const [deleting, setDeleting] = useState<Message | null>(null);
  const [picker, setPicker] = useState<{ message: Message; anchor: DOMRect } | null>(null);
  const listHandle = useRef<MessageListHandle | null>(null);

  // First visit, or after a reconnect dropped the loaded messages: load the newest page.
  // (Only when the log appears or disappears; a failed load is retried from the list.)
  const missing = log === undefined || log.status === 'stale';
  useEffect(() => {
    if (missing) void loadHistory(channel.id);
  }, [channel.id, missing]);

  const bits = useMemo(() => myPermissions({ server, members }, channel), [server, members, channel]);
  const canSend = has(bits, PERMISSIONS.SEND_MESSAGES);
  const canReact = has(bits, PERMISSIONS.ADD_REACTIONS);
  const canManageMessages = has(bits, PERMISSIONS.MANAGE_MESSAGES);
  // Files (anexos §1, §2): a server with the feature, and ATTACH_FILES here besides SEND_MESSAGES.
  const takesFiles = useConnectionStore((s) => s.welcome?.serverId === server.serverId && s.welcome.features.includes(FEATURE_ATTACHMENTS));
  const canAttach = canSend && takesFiles && has(bits, PERMISSIONS.ATTACH_FILES);
  const attachHint = canAttach ? null : !takesFiles ? t('attachments.noFeature') : canSend ? t('attachments.noPermission') : t('chat.readOnly');
  const limits: TrayLimits = useMemo(
    () => ({ maxFiles: MAX_ATTACHMENTS, maxBytes: Math.min(server.uploadLimitMb * MB, ATTACHMENT_IPC_MAX_BYTES) }),
    [server.uploadLimitMb],
  );
  const tray = useTray(limits);
  const drop = useFileDrop(tray.add, canAttach);

  // The chat is "on screen" when the window is focused and the list shows the newest message.
  const attentive = focused && atBottom;
  useEffect(() => {
    dispatchText({ type: 'attention', attentive });
  }, [attentive]);
  useEffect(() => () => dispatchText({ type: 'attention', attentive: false }), []);

  // Mark read while on screen (spec §11.1: channel.read when the user views a channel).
  const ready = log?.status === 'ready';
  useEffect(() => {
    if (!attentive || !ready || channel.lastMessageId <= mark.lastReadMessageId) return;
    const timer = setTimeout(() => void markRead(channel.id, channel.lastMessageId), 250);
    return () => clearTimeout(timer);
  }, [attentive, ready, channel.id, channel.lastMessageId, mark.lastReadMessageId]);

  // Clear the highlight a moment after jumping to a quoted message.
  useEffect(() => {
    if (highlight === null) return;
    const timer = setTimeout(() => setHighlight(null), 2000);
    return () => clearTimeout(timer);
  }, [highlight]);

  const selfId = server.selfId;
  const myRoleIds = useMemo(() => (Object.hasOwn(members.byId, selfId) ? members.byId[selfId]!.roleIds : []), [members, selfId]);

  const md: MarkdownContext = useMemo(
    () => ({
      classes: { paragraph: c.p, quote: c.quote, codeBlock: c.codeBlock, code: c.code, link: c.link, mention: c.mention, mentionMe: c.mentionMe },
      userName: (id) => (Object.hasOwn(members.byId, id) ? members.byId[id]!.nickname : null),
      role: (id) => (Object.hasOwn(server.roles, id) ? { name: server.roles[id]!.name, color: roleColorHex(server.roles[id]!.color) } : null),
      pingsMe: (kind, id) => (kind === 'user' ? id === selfId : myRoleIds.includes(id)),
      labels: { everyone: t('chat.everyone'), formerMember: t('chat.formerMember'), deletedRole: t('chat.unknownRole').replace(/^@/, '') },
      openLink: (url) => void window.ghostlink.app.openExternal(url).catch(() => undefined),
    }),
    [members, server.roles, selfId, myRoleIds, t],
  );

  const env: MessageEnv = useMemo(
    () => ({
      t,
      locale,
      selfId,
      canManageMessages,
      canReact,
      md,
      name: (id) => memberName({ members }, id, t('chat.formerMember')),
      author: (id, authorBot) => {
        const member = Object.hasOwn(members.byId, id) ? members.byId[id]! : undefined;
        if (member) return { name: member.nickname, bot: member.bot };
        return { name: authorBot ? t('bots.deletedBot') : t('chat.formerMember'), bot: authorBot };
      },
      avatar: (id) => (id !== null && Object.hasOwn(members.byId, id) ? members.byId[id]!.avatar : null),
      plain: (content) => plainContent({ members, server }, content, t),
      fileUrl: (fileId) => (server.serverId === null ? null : serverFileUrl(server.serverId, fileId)),
      pingsMe: (m) => m.authorId !== selfId && mentionsUser(m, selfId, myRoleIds),
      highlightId: highlight,
      onReply: (m) => useComposerStore.getState().startReply({ channelId: m.channelId, messageId: m.id }),
      onEdit: (m) => useComposerStore.getState().startEdit({ channelId: m.channelId, messageId: m.id }),
      onDelete: (m) => setDeleting(m),
      onPickReaction: (message, anchor) => setPicker({ message, anchor }),
      onToggleReaction: (m, emoji) => void toggleReaction(m, emoji).catch(() => undefined),
      onJumpTo: (id) => setHighlight(id),
      onRetry: (p) => void retryMessage(p.channelId, p.clientMsgId),
      onDrop: (p) => dropMessage(p.channelId, p.clientMsgId),
      onDismiss: (local) => dispatchText({ type: 'bots.dismiss', channelId: local.channelId, kind: local.kind, id: local.id }),
    }),
    [t, locale, selfId, canManageMessages, canReact, md, members, server, myRoleIds, highlight],
  );

  const onAttention = useCallback((bottom: boolean) => setAtBottom(bottom), []);
  const registerHandle = useCallback((h: MessageListHandle | null) => {
    listHandle.current = h;
  }, []);

  return (
    <div className={a.dropArea} {...drop.handlers} data-chat>
      <header className={c.header}>
        <Hash className={c.headerHash} size={20} aria-hidden="true" />
        <h1 className={c.headerName}>{channel.name}</h1>
        <span className={c.headerPill} title={channel.topic || undefined}>
          {channel.topic || t('chat.textChannel')}
        </span>
      </header>
      <MessageList channel={channel} env={env} highlight={highlight} onAttention={onAttention} registerHandle={registerHandle} />
      <div className={c.composerBand}>
        <TypingLine channelId={channel.id} />
        <Composer
          channel={channel}
          canSend={canSend}
          files={tray}
          limits={limits}
          canAttach={canAttach}
          attachHint={attachHint}
          onSent={() => listHandle.current?.scrollToBottom()}
        />
      </div>
      {drop.dragging && <DropOverlay target={`#${channel.name}`} maxFiles={MAX_ATTACHMENTS} />}
      {deleting && (
        <ConfirmDialog
          title={t('chat.delete')}
          body={t('chat.deleteConfirm')}
          confirmLabel={t('chat.delete')}
          onConfirm={() => deleteMessage(deleting.id)}
          onClose={() => setDeleting(null)}
        />
      )}
      {picker && (
        <EmojiPicker
          anchor={picker.anchor}
          onClose={() => setPicker(null)}
          onPick={(emoji) => {
            const current = channelLog(useTextStore.getState().messages, channel.id)?.items.find((m) => m.id === picker.message.id) ?? picker.message;
            void toggleReaction(current, emoji).catch(() => undefined);
          }}
        />
      )}
    </div>
  );
}

/** "Fulano está digitando…" (spec §11.1), refreshed as entries expire. */
function TypingLine({ channelId }: { channelId: string }) {
  const t = useT();
  const typing = useTextStore((s) => s.messages.typing);
  const members = useTextStore((s) => s.members);
  const ids = typingUserIds({ logs: {}, typing }, channelId, Date.now());
  const names = ids.map((id) => memberName({ members }, id, t('chat.formerMember')));
  let text = '';
  if (names.length === 1) text = t('chat.typing.one', { name: names[0]! });
  else if (names.length === 2) text = t('chat.typing.two', { a: names[0]!, b: names[1]! });
  else if (names.length > 2) text = t('chat.typing.many');
  return (
    <div className={c.typing} aria-live="polite">
      {text && (
        <>
          <span className={c.typingDots} aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          {text}
        </>
      )}
    </div>
  );
}
