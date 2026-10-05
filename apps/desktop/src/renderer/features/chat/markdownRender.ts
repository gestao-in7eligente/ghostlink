// Markdown AST → React elements. Text only ever becomes React text children, so
// React escapes it; no HTML string is built and nothing is injected (spec §11.1).
import { createElement as h, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import type { ChannelChip } from '../channelMenu/channelChip.js';
import type { Block, Inline } from './markdown.js';

/** CSS-module class names (a missing one is simply left out). */
export interface MarkdownClasses {
  paragraph: string | undefined;
  quote: string | undefined;
  codeBlock: string | undefined;
  code: string | undefined;
  link: string | undefined;
  mention: string | undefined;
  /** Added to a mention of the current user (or @everyone / one of their roles). */
  mentionMe: string | undefined;
  /** Added to a channel link that opens a channel, and to one that names no channel I can see. */
  channel?: string | undefined;
  channelUnknown?: string | undefined;
}

/** Channel links (ghostlink://channel/…, the channel menu's "Copiar link"); without it they stay plain text. */
export interface MarkdownChannels {
  chip(serverKeyId: string, channelId: string): ChannelChip;
  /** The deep link's path: selects the channel, or opens that saved server on it. */
  open(serverKeyId: string, channelId: string): void;
  /** "canal" (another server's channel, its name unknown here) and "canal desconhecido". */
  labels: { channel: string; unknown: string };
}

function cx(...names: (string | undefined | false)[]): string | undefined {
  const joined = names.filter(Boolean).join(' ');
  return joined === '' ? undefined : joined;
}

export interface MarkdownContext {
  classes: MarkdownClasses;
  /** A member's nickname, or null for someone who is not a member any more. */
  userName(id: string): string | null;
  role(id: string): { name: string; color: string | null } | null;
  /** True for the current user or one of their roles. */
  pingsMe(kind: 'user' | 'role', id: string): boolean;
  labels: { everyone: string; formerMember: string; deletedRole: string };
  /** Opens a link through the main process, which asks for confirmation (spec §12). */
  openLink(url: string): void;
  channels?: MarkdownChannels;
}

function channelLink(node: Extract<Inline, { k: 'channel' }>, key: number, ctx: MarkdownContext): ReactNode {
  const channels = ctx.channels;
  if (!channels) return node.raw;
  const chip = channels.chip(node.serverKeyId, node.channelId);
  if (chip.kind === 'unknown') {
    return h('span', { key, className: cx(ctx.classes.mention, ctx.classes.channelUnknown), title: node.raw }, `#${channels.labels.unknown}`);
  }
  const open = () => channels.open(node.serverKeyId, node.channelId);
  return h(
    'span',
    {
      key,
      role: 'link',
      tabIndex: 0,
      className: cx(ctx.classes.mention, ctx.classes.channel),
      title: node.raw,
      onClick: (e: MouseEvent) => {
        e.preventDefault();
        open();
      },
      onKeyDown: (e: KeyboardEvent) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        open();
      },
    },
    chip.kind === 'here' ? `#${chip.name}` : `${chip.server} › #${channels.labels.channel}`,
  );
}

function inline(nodes: readonly Inline[], ctx: MarkdownContext): ReactNode[] {
  return nodes.map((node, key) => {
    switch (node.k) {
      case 'text':
        return node.text;
      case 'br':
        return h('br', { key });
      case 'bold':
        return h('strong', { key }, inline(node.children, ctx));
      case 'italic':
        return h('em', { key }, inline(node.children, ctx));
      case 'underline':
        return h('u', { key }, inline(node.children, ctx));
      case 'strike':
        return h('s', { key }, inline(node.children, ctx));
      case 'code':
        return h('code', { key, className: ctx.classes.code }, node.text);
      case 'link':
        return h(
          'a',
          {
            key,
            href: node.url,
            className: ctx.classes.link,
            rel: 'noreferrer noopener',
            title: node.url,
            onClick: (e: MouseEvent) => {
              e.preventDefault();
              ctx.openLink(node.url);
            },
          },
          node.url,
        );
      case 'channel':
        return channelLink(node, key, ctx);
      case 'user': {
        const name = ctx.userName(node.id);
        const me = ctx.pingsMe('user', node.id);
        return h('span', { key, className: cx(ctx.classes.mention, me && ctx.classes.mentionMe) }, `@${name ?? ctx.labels.formerMember}`);
      }
      case 'role': {
        const role = ctx.role(node.id);
        const me = ctx.pingsMe('role', node.id);
        const style = role?.color ? { color: role.color, backgroundColor: `color-mix(in srgb, ${role.color} 15%, transparent)` } : undefined;
        return h(
          'span',
          { key, className: cx(ctx.classes.mention, me && ctx.classes.mentionMe), style },
          `@${role?.name ?? ctx.labels.deletedRole}`,
        );
      }
      case 'everyone':
        return h('span', { key, className: cx(ctx.classes.mention, ctx.classes.mentionMe) }, ctx.labels.everyone);
    }
  });
}

/** Renders parsed blocks; the caller wraps them in the message body element. */
export function renderMarkdown(blocks: readonly Block[], ctx: MarkdownContext): ReactNode[] {
  return blocks.map((block, key) => {
    switch (block.k) {
      case 'paragraph':
        return h('div', { key, className: ctx.classes.paragraph }, inline(block.children, ctx));
      case 'quote':
        return h('blockquote', { key, className: ctx.classes.quote }, inline(block.children, ctx));
      case 'codeblock':
        return h('pre', { key, className: ctx.classes.codeBlock, 'data-lang': block.lang ?? undefined }, h('code', null, block.text));
    }
  });
}
