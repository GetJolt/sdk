// JoltSession is the batteries-included entry point for building a Jolt frontend: it signs in, keeps a live
// normalized store of everything the user can see across every instance, and exposes the actions a chat UI
// needs (optimistic sends, read markers, typing, invites). Bind `session.store` to any UI framework.

import {
  Limits,
  normalizeInstance,
  type DispatchFrame,
  type GuildIndexEntry,
  type Invite,
  type Message,
  type PresenceStatus,
  type RegisterBody,
} from '@getjolt/protocol';
import { JoltClient, type JoltClientOptions } from './client.js';
import { Emitter } from './emitter.js';
import { JoltApiError, type RestClient } from './rest.js';
import {
  compareIds,
  emptyChannel,
  initialChatState,
  patchChannelMessages,
  reduceDispatch,
  scoped,
  sortedTextChannels,
  unscope,
  withGuild,
  withoutGuild,
  type ChatMessage,
  type ChatState,
  type ChannelMessages,
  type ScopedKey,
} from './state.js';
import { JoltSocial } from './social.js';
import { createStore, type Store } from './store.js';

type SessionEvents = {
  /** Every gateway event, after it has been applied to the store. */
  dispatch: { instance: string; frame: DispatchFrame };
  /** A new message from someone else, for notifications or screen reader announcements. */
  message: { instance: string; message: Message; mentionsMe: boolean };
  error: { instance: string | null; error: Error };
};

export interface ParsedInvite {
  instance: string;
  code: string;
}

const ACK_DEBOUNCE_MS = 600;
const TYPING_SWEEP_MS = 3000;

export function errorMessage(error: unknown): string {
  if (error instanceof JoltApiError || error instanceof Error) return error.message;
  return 'Something went wrong.';
}

/** Accepts `jolt://invite/host/code`, `https://host/invite/code`, `host/invite/code` or a bare code. */
export function parseInvite(input: string, fallbackInstance: string): ParsedInvite | null {
  const value = input.trim();
  const deepLink = /^jolt:\/\/invite\/([^/\s]+)\/([A-Za-z0-9]{4,32})\/?$/.exec(value);
  if (deepLink) return { instance: normalizeInstance(deepLink[1]!), code: deepLink[2]! };
  const url = /^(?:https?:\/\/)?([^/\s]+)\/invite\/([A-Za-z0-9]{4,32})\/?$/.exec(value);
  if (url) return { instance: normalizeInstance(url[1]!), code: url[2]! };
  if (/^[A-Za-z0-9]{4,32}$/.test(value)) return { instance: fallbackInstance, code: value };
  return null;
}

export const inviteLink = (instance: string, code: string) => `jolt://invite/${instance}/${code}`;

export interface FoundInvite extends ParsedInvite {
  /** The exact text that matched, so a client can hide it and show a card instead. */
  match: string;
}

const INVITE_LINK =
  /(?<![\w/])(?:jolt:\/\/invite\/([a-z0-9.:-]+)\/([A-Za-z0-9]{4,32})|https?:\/\/([a-z0-9.:-]+)\/invite\/([A-Za-z0-9]{4,32}))\/?(?![\w/])/gi;
const CODE = /```[\s\S]*?```|`[^`\n]+`/g;

/** Invite links in a message, outside code spans and blocks, de-duplicated and in order. */
export function findInviteLinks(content: string): FoundInvite[] {
  const code = [...content.matchAll(CODE)].map((m) => [m.index, m.index + m[0].length] as const);
  const seen = new Set<string>();
  const found: FoundInvite[] = [];
  for (const m of content.matchAll(INVITE_LINK)) {
    if (code.some(([start, end]) => m.index >= start && m.index < end)) continue;
    const instance = normalizeInstance((m[1] ?? m[3])!);
    const inviteCode = (m[2] ?? m[4])!;
    const key = `${instance}/${inviteCode}`;
    if (!seen.has(key)) found.push({ instance, code: inviteCode, match: m[0] });
    seen.add(key);
  }
  return found;
}

export class JoltSession extends Emitter<SessionEvents> {
  readonly client: JoltClient;
  readonly store: Store<ChatState> = createStore(initialChatState());
  /** Timelines, posting, follows and notifications. */
  readonly social: JoltSocial;
  private nonceCounter = 0;
  private readonly lastTyping = new Map<ScopedKey, number>();
  private readonly ackTimers = new Map<ScopedKey, ReturnType<typeof setTimeout>>();
  private typingSweep: ReturnType<typeof setInterval> | null = null;

  constructor(options: JoltClientOptions) {
    super();
    this.client = new JoltClient(options);
    this.client.on('dispatch', ({ instance, frame }) => this.handleDispatch(instance, frame));
    this.client.on('connection', ({ instance, state }) =>
      this.set((s) => ({ connections: { ...s.connections, [instance]: state } })),
    );
    this.client.on('signedOut', () => this.reset('signedOut'));
    this.client.on('error', ({ instance, error }) => this.emit('error', { instance, error }));
    this.social = new JoltSocial({
      get: () => this.state.social,
      set: (patch) =>
        this.set((s) => ({
          social: { ...s.social, ...(typeof patch === 'function' ? patch(s.social) : patch) },
        })),
      rest: () => this.client.home.rest,
      me: () => (this.state.homeInstance ? this.state.me[this.state.homeInstance] : undefined),
    });
  }

  get state(): ChatState {
    return this.store.getState();
  }

  private set(partial: Partial<ChatState> | ((s: ChatState) => Partial<ChatState>)) {
    this.store.setState(partial);
  }

  /** REST client for an instance the session is connected to. */
  rest(instance: string): RestClient {
    const conn = this.client.connection(instance);
    if (!conn) throw new Error(`Not connected to ${instance}`);
    return conn.rest;
  }

  private handleDispatch(instance: string, frame: DispatchFrame) {
    this.set((s) => reduceDispatch(s, instance, frame));
    this.emit('dispatch', { instance, frame });
    if (frame.t === 'MESSAGE_CREATE') {
      const me = this.state.me[instance];
      if (me && frame.d.author.id !== me.id) {
        const mentionsMe = frame.d.mentionIds.includes(me.id) || frame.d.mentionEveryone;
        this.emit('message', { instance, message: frame.d, mentionsMe });
      }
    }
  }

  private reset(status: ChatState['status']) {
    this.store.setState({ ...initialChatState(), status });
    if (this.typingSweep) clearInterval(this.typingSweep);
    this.typingSweep = null;
  }

  async restore(): Promise<boolean> {
    if (!(await this.client.restore())) {
      this.reset('signedOut');
      return false;
    }
    await this.start();
    return true;
  }

  async login(instance: string, handle: string, password: string): Promise<void> {
    this.reset('booting');
    try {
      await this.client.login(instance, { handle, password });
    } catch (error) {
      this.reset('signedOut');
      throw error;
    }
    await this.start();
  }

  async register(instance: string, body: Omit<RegisterBody, 'deviceName'>): Promise<void> {
    this.reset('booting');
    try {
      await this.client.register(instance, body);
    } catch (error) {
      this.reset('signedOut');
      throw error;
    }
    await this.start();
  }

  async signOut(): Promise<void> {
    await this.client.signOut();
    this.reset('signedOut');
  }

  private async start() {
    this.set({ status: 'signedIn', homeInstance: this.client.homeDomain });
    this.typingSweep ??= setInterval(() => this.sweepTyping(), TYPING_SWEEP_MS);
    const index = await this.client.start();
    if (index.length) this.applyGuildIndex(index);
  }

  private applyGuildIndex(index: GuildIndexEntry[]) {
    const ordered = [...index]
      .sort((a, b) => a.position - b.position)
      .map((e) => scoped(e.instance, e.guildId));
    this.set((s) => ({ guildOrder: [...ordered, ...s.guildOrder.filter((k) => !ordered.includes(k))] }));
  }

  private sweepTyping() {
    const now = Date.now();
    const typing = this.state.typing;
    let changed = false;
    const next: ChatState['typing'] = {};
    for (const [channel, users] of Object.entries(typing)) {
      const live = Object.fromEntries(Object.entries(users).filter(([, expires]) => expires > now));
      if (Object.keys(live).length !== Object.keys(users).length) changed = true;
      if (Object.keys(live).length) next[channel] = live;
    }
    if (changed) this.set({ typing: next });
  }

  setPresence(status: PresenceStatus): void {
    this.client.setPresence(status);
  }

  channelMessages(channelKey: ScopedKey): ChannelMessages {
    return this.state.messages[channelKey] ?? emptyChannel;
  }

  private patchMessages(key: ScopedKey, patch: (c: ChannelMessages) => Partial<ChannelMessages>) {
    this.set((s) => patchChannelMessages(s, key, patch));
  }

  /** Loads the newest page of a channel, or the page before the oldest cached message. */
  async loadMessages(channelKey: ScopedKey, direction: 'latest' | 'older' = 'latest'): Promise<void> {
    const current = this.channelMessages(channelKey);
    if (current.loading || (direction === 'older' && !current.hasMoreBefore)) return;
    const { instance, id: channelId } = unscope(channelKey);

    this.patchMessages(channelKey, () => ({ loading: true }));
    try {
      const before = direction === 'older' ? current.messages.find((m) => !m.pending)?.id : undefined;
      const page = await this.rest(instance).messages(channelId, { before, limit: Limits.messagesPerPage });
      this.patchMessages(channelKey, (c) => {
        const known = new Set(c.messages.map((m) => m.id));
        const unsent = c.messages.filter((m) => m.pending || m.failed);
        const messages =
          direction === 'older'
            ? [...page.filter((m) => !known.has(m.id)), ...c.messages]
            : [...page, ...unsent];
        return {
          messages,
          loading: false,
          loaded: true,
          hasMoreBefore: page.length === Limits.messagesPerPage,
        };
      });
    } catch (error) {
      this.patchMessages(channelKey, () => ({ loading: false }));
      throw error;
    }
  }

  /** Shows the message immediately and reconciles it with the server's copy by nonce. */
  async sendMessage(channelKey: ScopedKey, content: string, replyTo?: Message | null): Promise<void> {
    const { instance, id: channelId } = unscope(channelKey);
    const me = this.state.me[instance];
    const guild = Object.values(this.state.guilds).find(
      (g) => g.instance === instance && g.channels[channelId],
    );
    if (!me || !guild) return;

    const nonce = `${Date.now()}-${++this.nonceCounter}`;
    const optimistic: ChatMessage = {
      id: `pending-${nonce}`,
      channelId,
      guildId: guild.guild.id,
      author: me,
      content,
      createdAt: Date.now(),
      editedAt: null,
      replyTo: replyTo
        ? { id: replyTo.id, author: replyTo.author, content: replyTo.content.slice(0, 200), deleted: false }
        : null,
      mentionIds: [],
      mentionEveryone: false,
      nonce,
      encryption: null,
      pending: true,
    };
    this.patchMessages(channelKey, (c) => ({ messages: [...c.messages, optimistic] }));
    this.lastTyping.delete(channelKey);
    await this.deliver(channelKey, optimistic);
  }

  private async deliver(channelKey: ScopedKey, message: ChatMessage) {
    const { instance, id: channelId } = unscope(channelKey);
    try {
      const sent = await this.rest(instance).sendMessage(channelId, {
        content: message.content,
        nonce: message.nonce ?? undefined,
        replyToId: message.replyTo?.id,
      });
      // The gateway echo usually lands first; if not, swap in the server copy here.
      this.patchMessages(channelKey, (c) => ({
        messages: c.messages.some((m) => m.id === sent.id)
          ? c.messages.filter((m) => !(m.pending && m.nonce === message.nonce))
          : c.messages.map((m) => (m.pending && m.nonce === message.nonce ? sent : m)),
      }));
    } catch (error) {
      this.patchMessages(channelKey, (c) => ({
        messages: c.messages.map((m) =>
          m.pending && m.nonce === message.nonce ? { ...m, pending: false, failed: true } : m,
        ),
      }));
      throw error;
    }
  }

  async retryMessage(channelKey: ScopedKey, message: ChatMessage): Promise<void> {
    this.patchMessages(channelKey, (c) => ({
      messages: c.messages.map((m) =>
        m.nonce === message.nonce ? { ...m, failed: false, pending: true } : m,
      ),
    }));
    await this.deliver(channelKey, { ...message, pending: true, failed: false });
  }

  discardMessage(channelKey: ScopedKey, message: ChatMessage): void {
    this.patchMessages(channelKey, (c) => ({
      messages: c.messages.filter((m) => !(m.failed && m.nonce === message.nonce)),
    }));
  }

  async editMessage(channelKey: ScopedKey, messageId: string, content: string): Promise<void> {
    const { instance, id } = unscope(channelKey);
    await this.rest(instance).editMessage(id, messageId, content);
  }

  async deleteMessage(channelKey: ScopedKey, messageId: string): Promise<void> {
    const { instance, id } = unscope(channelKey);
    await this.rest(instance).deleteMessage(id, messageId);
  }

  /** Call on every keystroke; it only tells the server every few seconds. */
  notifyTyping(channelKey: ScopedKey): void {
    const now = Date.now();
    if (now - (this.lastTyping.get(channelKey) ?? 0) < Limits.typingIndicatorMs) return;
    this.lastTyping.set(channelKey, now);
    const { instance, id } = unscope(channelKey);
    void this.rest(instance)
      .typing(id)
      .catch(() => undefined);
  }

  /** Marks a channel read up to `messageId`. Updates locally at once and tells the server shortly after. */
  markRead(channelKey: ScopedKey, messageId: string | null): void {
    if (!messageId || messageId.startsWith('pending-')) return;
    const current = this.state.readStates[channelKey];
    if (current && compareIds(current.lastReadMessageId, messageId) >= 0 && current.mentionCount === 0)
      return;

    const { instance, id: channelId } = unscope(channelKey);
    this.set((s) => ({
      readStates: {
        ...s.readStates,
        [channelKey]: { channelId, lastReadMessageId: messageId, mentionCount: 0 },
      },
    }));
    clearTimeout(this.ackTimers.get(channelKey));
    this.ackTimers.set(
      channelKey,
      setTimeout(
        () =>
          void this.rest(instance)
            .ack(channelId, messageId)
            .catch(() => undefined),
        ACK_DEBOUNCE_MS,
      ),
    );
  }

  markGuildRead(guildKey: ScopedKey): void {
    const guild = this.state.guilds[guildKey];
    if (!guild) return;
    for (const channel of sortedTextChannels(guild.channels)) {
      if (channel.lastMessageId) this.markRead(scoped(guild.instance, channel.id), channel.lastMessageId);
    }
  }

  async createGuild(name: string): Promise<ScopedKey> {
    const snapshot = await this.client.createGuild(name);
    const instance = this.client.home.instance;
    this.set((s) => withGuild(s, instance, snapshot));
    return scoped(instance, snapshot.guild.id);
  }

  parseInvite(input: string): ParsedInvite | null {
    return parseInvite(input, this.client.homeDomain ?? '');
  }

  /** Looks at an invite without joining, using the existing connection or an anonymous request. */
  async previewInvite(invite: ParsedInvite): Promise<Invite> {
    const conn = this.client.connection(invite.instance);
    return (conn?.rest ?? this.client.probe(invite.instance)).invite(invite.code);
  }

  async joinInvite(invite: ParsedInvite): Promise<ScopedKey> {
    const { instance, snapshot } = await this.client.joinInvite(invite.instance, invite.code);
    this.set((s) => withGuild(s, instance, snapshot));
    return scoped(instance, snapshot.guild.id);
  }

  async leaveGuild(guildKey: ScopedKey): Promise<void> {
    const { instance, id } = unscope(guildKey);
    await this.client.leaveGuild(instance, id);
    this.set((s) => withoutGuild(s, guildKey));
  }

  async deleteGuild(guildKey: ScopedKey): Promise<void> {
    const { instance, id } = unscope(guildKey);
    await this.rest(instance).deleteGuild(id);
    await this.client.forgetGuild(instance, id).catch(() => undefined);
    this.set((s) => withoutGuild(s, guildKey));
  }

  async saveGuildOrder(order: ScopedKey[]): Promise<void> {
    this.set({ guildOrder: order });
    await this.client.saveGuildOrder(
      order.map((key, position) => {
        const { instance, id } = unscope(key);
        return { instance, guildId: id, position };
      }),
    );
  }

  /** Updates the profile at home and asks every other instance to refresh its copy. */
  async updateProfile(body: { displayName?: string; bio?: string }): Promise<void> {
    await this.client.home.rest.updateProfile(body);
    await this.client.syncProfileEverywhere();
  }

  /** Sets or, with `null`, removes the avatar. It's hosted by the home instance and shown everywhere. */
  async setAvatar(image: Blob | null): Promise<void> {
    const rest = this.client.home.rest;
    await (image ? rest.setAvatar(image) : rest.removeAvatar());
    await this.client.syncProfileEverywhere();
  }
}
