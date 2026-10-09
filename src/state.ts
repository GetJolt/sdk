// Normalized client state for every connected instance, plus the reducer that folds gateway events into it.
// IDs are only unique per instance, so guilds and channels are keyed as `instance|id`.

import {
  computeBasePermissions,
  computeChannelPermissions,
  hasPermission,
  type Channel,
  type DispatchFrame,
  type Guild,
  type GuildSnapshot,
  type Member,
  type Message,
  type PermissionContext,
  type PresenceStatus,
  type ReadState,
  type Role,
  type User,
} from '@getjolt/protocol';
import type { GatewayState } from './gateway.js';
import { initialSocialState, reduceSocial, type SocialState } from './social.js';

export type ScopedKey = string;

export const scoped = (instance: string, id: string): ScopedKey => `${instance}|${id}`;

export function unscope(key: ScopedKey): { instance: string; id: string } {
  const at = key.lastIndexOf('|');
  return { instance: key.slice(0, at), id: key.slice(at + 1) };
}

export function compareIds(a: string | null | undefined, b: string | null | undefined): number {
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

export interface ChatMessage extends Message {
  /** Optimistic message waiting for the server; matched up again by `nonce`. */
  pending?: boolean;
  failed?: boolean;
}

export interface GuildState {
  key: ScopedKey;
  instance: string;
  guild: Guild;
  channels: Record<string, Channel>;
  roles: Record<string, Role>;
  members: Record<string, Member>;
  presences: Record<string, PresenceStatus>;
}

export interface ChannelMessages {
  messages: ChatMessage[];
  hasMoreBefore: boolean;
  loading: boolean;
  loaded: boolean;
}

export type SessionStatus = 'booting' | 'signedOut' | 'signedIn';

export interface ChatState {
  status: SessionStatus;
  homeInstance: string | null;
  guilds: Record<ScopedKey, GuildState>;
  /** The user's guild order, synced through their home instance. */
  guildOrder: ScopedKey[];
  /** The signed-in user as each instance knows them (ids differ per instance). */
  me: Record<string, User>;
  messages: Record<ScopedKey, ChannelMessages>;
  readStates: Record<ScopedKey, ReadState>;
  /** channelKey → userId → expiry timestamp. */
  typing: Record<ScopedKey, Record<string, number>>;
  connections: Record<string, GatewayState>;
  /** Timelines, posts, profiles and notifications, all from the home instance. */
  social: SocialState;
}

export const emptyChannel: ChannelMessages = {
  messages: [],
  hasMoreBefore: true,
  loading: false,
  loaded: false,
};

export const initialChatState = (): ChatState => ({
  status: 'booting',
  homeInstance: null,
  guilds: {},
  guildOrder: [],
  me: {},
  messages: {},
  readStates: {},
  typing: {},
  connections: {},
  social: initialSocialState(),
});

const MAX_MESSAGES_IN_MEMORY = 600;
export const TYPING_TTL_MS = 9000;

const byId = <T extends { id: string }>(items: T[]) => Object.fromEntries(items.map((i) => [i.id, i]));

export function guildFromSnapshot(instance: string, snapshot: GuildSnapshot): GuildState {
  return {
    key: scoped(instance, snapshot.guild.id),
    instance,
    guild: snapshot.guild,
    channels: byId(snapshot.channels),
    roles: byId(snapshot.roles),
    members: Object.fromEntries(snapshot.members.map((m) => [m.user.id, m])),
    presences: snapshot.presences,
  };
}

type Patch = Partial<ChatState>;

function patchGuild(state: ChatState, key: ScopedKey, patch: (g: GuildState) => Partial<GuildState>): Patch {
  const guild = state.guilds[key];
  if (!guild) return {};
  return { guilds: { ...state.guilds, [key]: { ...guild, ...patch(guild) } } };
}

export function patchChannelMessages(
  state: ChatState,
  key: ScopedKey,
  patch: (c: ChannelMessages) => Partial<ChannelMessages>,
): Patch {
  const current = state.messages[key] ?? emptyChannel;
  return { messages: { ...state.messages, [key]: { ...current, ...patch(current) } } };
}

export function withGuild(state: ChatState, instance: string, snapshot: GuildSnapshot): Patch {
  const guild = guildFromSnapshot(instance, snapshot);
  const guildOrder = state.guildOrder.includes(guild.key)
    ? state.guildOrder
    : [...state.guildOrder, guild.key];
  return { guilds: { ...state.guilds, [guild.key]: guild }, guildOrder };
}

export function withoutGuild(state: ChatState, key: ScopedKey): Patch {
  const { [key]: _removed, ...guilds } = state.guilds;
  return { guilds, guildOrder: state.guildOrder.filter((k) => k !== key) };
}

function withoutTyping(state: ChatState, channelKey: ScopedKey, userId: string): Patch {
  const current = state.typing[channelKey];
  if (!current?.[userId]) return {};
  const { [userId]: _removed, ...rest } = current;
  return { typing: { ...state.typing, [channelKey]: rest } };
}

/** Returns the state changes for one gateway event. Messages for channels never opened are not cached. */
export function reduceDispatch(state: ChatState, instance: string, frame: DispatchFrame): Patch {
  const g = (guildId: string) => scoped(instance, guildId);
  const c = (channelId: string) => scoped(instance, channelId);

  switch (frame.t) {
    case 'READY': {
      const guilds = { ...state.guilds };
      for (const key of Object.keys(guilds)) if (guilds[key]!.instance === instance) delete guilds[key];
      for (const snapshot of frame.d.guilds) {
        const guild = guildFromSnapshot(instance, snapshot);
        guilds[guild.key] = guild;
      }
      const readStates = { ...state.readStates };
      for (const rs of frame.d.readStates) readStates[c(rs.channelId)] = rs;

      const known = new Set(state.guildOrder);
      const added = frame.d.guilds.map((s) => g(s.guild.id)).filter((k) => !known.has(k));
      // A fresh session may have missed messages, so drop this instance's cached history; it reloads on demand.
      const messages = Object.fromEntries(
        Object.entries(state.messages).filter(([key]) => unscope(key).instance !== instance),
      );
      return {
        guilds,
        readStates,
        messages,
        guildOrder: [...state.guildOrder, ...added],
        me: { ...state.me, [instance]: frame.d.user },
      };
    }

    case 'GUILD_CREATE':
      return withGuild(state, instance, frame.d);
    case 'GUILD_UPDATE':
      return patchGuild(state, g(frame.d.id), () => ({ guild: frame.d }));
    case 'GUILD_DELETE':
      return withoutGuild(state, g(frame.d.id));

    case 'CHANNEL_CREATE':
    case 'CHANNEL_UPDATE':
      return patchGuild(state, g(frame.d.guildId), (guild) => ({
        channels: { ...guild.channels, [frame.d.id]: frame.d },
      }));
    case 'CHANNEL_DELETE':
      return patchGuild(state, g(frame.d.guildId), (guild) => {
        const { [frame.d.id]: _removed, ...channels } = guild.channels;
        return { channels };
      });

    case 'GUILD_ROLE_CREATE':
    case 'GUILD_ROLE_UPDATE':
      return patchGuild(state, g(frame.d.guildId), (guild) => ({
        roles: { ...guild.roles, [frame.d.id]: frame.d },
      }));
    case 'GUILD_ROLE_DELETE':
      return patchGuild(state, g(frame.d.guildId), (guild) => {
        const { [frame.d.id]: _removed, ...roles } = guild.roles;
        const members = Object.fromEntries(
          Object.entries(guild.members).map(([id, m]) => [
            id,
            { ...m, roleIds: m.roleIds.filter((r) => r !== frame.d.id) },
          ]),
        );
        return { roles, members };
      });

    case 'GUILD_MEMBER_ADD':
    case 'GUILD_MEMBER_UPDATE':
      return patchGuild(state, g(frame.d.guildId), (guild) => ({
        members: { ...guild.members, [frame.d.user.id]: frame.d },
      }));
    case 'GUILD_MEMBER_REMOVE':
      return patchGuild(state, g(frame.d.guildId), (guild) => {
        const { [frame.d.userId]: _removed, ...members } = guild.members;
        return { members };
      });

    case 'MESSAGE_CREATE': {
      const message = frame.d;
      const key = c(message.channelId);
      const next: ChatState = {
        ...state,
        ...patchGuild(state, g(message.guildId), (guild) => {
          const channel = guild.channels[message.channelId];
          return channel
            ? { channels: { ...guild.channels, [channel.id]: { ...channel, lastMessageId: message.id } } }
            : {};
        }),
      };
      Object.assign(next, withoutTyping(next, key, message.author.id));
      if (!next.messages[key]?.loaded) return next;

      return {
        ...next,
        ...patchChannelMessages(next, key, ({ messages }) => {
          const settled = message.nonce
            ? messages.filter((m) => !(m.pending && m.nonce === message.nonce))
            : messages;
          if (settled.some((m) => m.id === message.id)) return { messages: settled };
          const appended = [...settled, message];
          return appended.length > MAX_MESSAGES_IN_MEMORY
            ? { messages: appended.slice(-MAX_MESSAGES_IN_MEMORY), hasMoreBefore: true }
            : { messages: appended };
        }),
      };
    }
    case 'MESSAGE_UPDATE':
      return patchChannelMessages(state, c(frame.d.channelId), ({ messages }) => ({
        messages: messages.map((m) => (m.id === frame.d.id ? frame.d : m)),
      }));
    case 'MESSAGE_DELETE':
      return patchChannelMessages(state, c(frame.d.channelId), ({ messages }) => ({
        messages: messages
          .filter((m) => m.id !== frame.d.id)
          .map((m) =>
            m.replyTo?.id === frame.d.id
              ? { ...m, replyTo: { ...m.replyTo, deleted: true, author: null, content: '' } }
              : m,
          ),
      }));

    case 'TYPING_START': {
      if (frame.d.userId === state.me[instance]?.id) return {};
      const key = c(frame.d.channelId);
      return {
        typing: {
          ...state.typing,
          [key]: { ...state.typing[key], [frame.d.userId]: Date.now() + TYPING_TTL_MS },
        },
      };
    }

    case 'PRESENCE_UPDATE': {
      const guilds = { ...state.guilds };
      for (const [key, guild] of Object.entries(guilds)) {
        if (guild.instance !== instance || !guild.members[frame.d.userId]) continue;
        guilds[key] = { ...guild, presences: { ...guild.presences, [frame.d.userId]: frame.d.status } };
      }
      return { guilds };
    }

    case 'USER_UPDATE': {
      const user = frame.d;
      const guilds = { ...state.guilds };
      for (const [key, guild] of Object.entries(guilds)) {
        const member = guild.instance === instance ? guild.members[user.id] : undefined;
        if (member) guilds[key] = { ...guild, members: { ...guild.members, [user.id]: { ...member, user } } };
      }
      const me = state.me[instance]?.id === user.id ? { ...state.me, [instance]: user } : state.me;
      return { guilds, me };
    }

    case 'READ_STATE_UPDATE':
      return { readStates: { ...state.readStates, [c(frame.d.channelId)]: frame.d } };

    case 'RESUMED':
      return {};

    case 'FEED_ITEM_CREATE':
    case 'POST_UPDATE':
    case 'POST_DELETE':
    case 'NOTIFICATION_CREATE':
    case 'RELATIONSHIP_UPDATE':
    case 'LINKED_ACCOUNTS_UPDATE':
    case 'SYSTEM_MESSAGE_CREATE': {
      // Social events only mean anything from the home instance.
      if (instance !== state.homeInstance) return {};
      const patch = reduceSocial(state.social, state.me[instance], frame);
      return patch ? { social: { ...state.social, ...patch } } : {};
    }
  }
}

export function isUnread(channel: Channel, readState: ReadState | undefined): boolean {
  if (!channel.lastMessageId) return false;
  return compareIds(channel.lastMessageId, readState?.lastReadMessageId) > 0;
}

/** Text channels in sidebar order: uncategorised first, then by category position. */
export function sortedTextChannels(channels: Record<string, Channel>): Channel[] {
  const list = Object.values(channels);
  const categories = new Map(list.filter((c) => c.type === 'category').map((c) => [c.id, c.position]));
  return list
    .filter((c) => c.type === 'text')
    .sort((a, b) => {
      const pa = a.parentId ? (categories.get(a.parentId) ?? -1) : -1;
      const pb = b.parentId ? (categories.get(b.parentId) ?? -1) : -1;
      return pa - pb || a.position - b.position;
    });
}

export function permissionContext(guild: GuildState, userId: string | undefined): PermissionContext | null {
  const member = userId ? guild.members[userId] : undefined;
  if (!member) return null;
  return {
    guildId: guild.guild.id,
    ownerId: guild.guild.ownerId,
    userId: member.user.id,
    memberRoleIds: member.roleIds,
    roles: Object.values(guild.roles),
  };
}

/** Permission bits for UI decisions. The server enforces everything regardless. */
export function permissionsFor(
  guild: GuildState,
  userId: string | undefined,
  channel?: Channel | null,
): bigint {
  const ctx = permissionContext(guild, userId);
  if (!ctx) return 0n;
  return channel ? computeChannelPermissions(ctx, channel.overwrites) : computeBasePermissions(ctx);
}

export function canSeeChannel(guild: GuildState, channel: Channel, userId: string | undefined): boolean {
  return permissionsFor(guild, userId, channel) !== 0n;
}

export function can(
  guild: GuildState,
  userId: string | undefined,
  permission: bigint,
  channel?: Channel | null,
): boolean {
  return hasPermission(permissionsFor(guild, userId, channel), permission);
}

/** Unread flag and mention count for a whole guild, counting only channels the user can see. */
export function guildActivity(state: ChatState, guild: GuildState): { unread: boolean; mentions: number } {
  const me = state.me[guild.instance];
  let unread = false;
  let mentions = 0;
  for (const channel of sortedTextChannels(guild.channels)) {
    if (!canSeeChannel(guild, channel, me?.id)) continue;
    const rs = state.readStates[scoped(guild.instance, channel.id)];
    if (isUnread(channel, rs)) unread = true;
    mentions += rs?.mentionCount ?? 0;
  }
  return { unread, mentions };
}

/** User ids currently typing in a channel, oldest first. */
export function typingUsers(state: ChatState, channelKey: ScopedKey, now = Date.now()): string[] {
  return Object.entries(state.typing[channelKey] ?? {})
    .filter(([, expires]) => expires > now)
    .sort(([, a], [, b]) => a - b)
    .map(([userId]) => userId);
}
