// The social side of a session: timelines, posts, profiles, notifications and messages from the instance. It all
// comes from the user's home instance. Posts are stored once by id and feeds hold ids, so a like or delete shows up
// everywhere at once.

import type {
  CreatePostBody,
  DispatchFrame,
  FriendSuggestion,
  LinkedAccount,
  LinkProvider,
  Notification,
  Post,
  PostVisibility,
  Profile,
  Relationship,
  SystemMessage,
  TimelineItem,
  TimelinePage,
  UpdateLinkBody,
  User,
} from '@getjolt/protocol';
import { detectFacets } from '@getjolt/protocol';
import type { ProfileFilter, RestClient, UploadedMedia } from './rest.js';

/** A post as the client holds it, including optimistic ones still on their way to the server. */
export interface SocialPost extends Post {
  pending?: boolean;
  failed?: boolean;
}

export interface FeedEntry {
  /** The timeline item id (a post id, or a repost id), used as the paging cursor. */
  id: string;
  postId: string;
  repostedBy: User | null;
}

export interface FeedState {
  entries: FeedEntry[];
  cursor: string | null;
  hasMore: boolean;
  loading: boolean;
  loaded: boolean;
  /** New items that arrived while the user was reading, shown behind a "Show new posts" button. */
  fresh: FeedEntry[];
}

export interface ThreadState {
  ancestors: string[];
  replies: string[];
  loading: boolean;
}

export interface NotificationsState {
  items: Notification[];
  cursor: string | null;
  hasMore: boolean;
  loading: boolean;
  loaded: boolean;
  unread: number;
}

/** The read-only conversation with "Jolt": messages from the home instance itself. */
export interface SystemMessagesState {
  items: SystemMessage[];
  unread: number;
  loaded: boolean;
}

export interface SocialState {
  posts: Record<string, SocialPost>;
  feeds: Record<string, FeedState>;
  threads: Record<string, ThreadState>;
  profiles: Record<string, Profile>;
  relationships: Record<string, Relationship>;
  notifications: NotificationsState;
  linkedAccounts: LinkedAccount[];
  system: SystemMessagesState;
}

/** Feed keys: the home timeline, someone's profile tab, or a linked account's timeline. */
export const feedKey = {
  home: 'home',
  profile: (userId: string, filter: ProfileFilter = 'posts') => `profile:${userId}:${filter}`,
  link: (linkId: string) => `link:${linkId}`,
};

/** The linked account a Bluesky or Mastodon post was read through, from the id the server gave it. */
export function linkOf(post: Pick<Post, 'id' | 'source'>): string | null {
  if (post.source !== 'bluesky' && post.source !== 'mastodon') return null;
  return /^(?:bsky|masto):(\d+):/.exec(post.id)?.[1] ?? null;
}

/** The linked account a Bluesky or Mastodon person was seen through, from their id. */
export function linkOfUser(userId: string): string | null {
  return /^(?:bsky|masto):(\d+):/.exec(userId)?.[1] ?? null;
}

export const emptyFeed: FeedState = {
  entries: [],
  cursor: null,
  hasMore: true,
  loading: false,
  loaded: false,
  fresh: [],
};

export const initialSocialState = (): SocialState => ({
  posts: {},
  feeds: {},
  threads: {},
  profiles: {},
  relationships: {},
  notifications: { items: [], cursor: null, hasMore: true, loading: false, loaded: false, unread: 0 },
  linkedAccounts: [],
  system: { items: [], unread: 0, loaded: false },
});

const entryOf = (item: TimelineItem): FeedEntry => ({
  id: item.id,
  postId: item.post.id,
  repostedBy: item.repostedBy,
});

function withPosts(state: SocialState, posts: Post[]): Record<string, SocialPost> {
  if (posts.length === 0) return state.posts;
  const next = { ...state.posts };
  for (const post of posts) next[post.id] = post;
  return next;
}

function withoutPost(state: SocialState, postId: string): Partial<SocialState> {
  const { [postId]: _removed, ...posts } = state.posts;
  const feeds = Object.fromEntries(
    Object.entries(state.feeds).map(([key, feed]) => [
      key,
      {
        ...feed,
        entries: feed.entries.filter((e) => e.postId !== postId),
        fresh: feed.fresh.filter((e) => e.postId !== postId),
      },
    ]),
  );
  const threads = Object.fromEntries(
    Object.entries(state.threads).map(([key, thread]) => [
      key,
      { ...thread, replies: thread.replies.filter((id) => id !== postId) },
    ]),
  );
  return { posts, feeds, threads };
}

/** Folds social gateway events into the state. Returns null for events that aren't social. */
export function reduceSocial(
  state: SocialState,
  me: User | undefined,
  frame: DispatchFrame,
): Partial<SocialState> | null {
  switch (frame.t) {
    case 'FEED_ITEM_CREATE': {
      const item = frame.d;
      const entry = entryOf(item);
      const home = state.feeds[feedKey.home];
      const posts = withPosts(state, [item.post]);
      if (!home?.loaded) return { posts };

      // My own post replaces its optimistic placeholder in place; other people's wait behind "Show new posts".
      const mine = (item.repostedBy ?? item.post.author).id === me?.id;
      const placeholder = item.post.nonce
        ? Object.values(state.posts).find((p) => p.pending && p.nonce === item.post.nonce)
        : undefined;
      const known = (e: FeedEntry) => e.id === entry.id;
      if (home.entries.some(known) || home.fresh.some(known)) return { posts };

      let feed: FeedState;
      if (placeholder) {
        feed = { ...home, entries: home.entries.map((e) => (e.postId === placeholder.id ? entry : e)) };
      } else if (mine) {
        feed = { ...home, entries: [entry, ...home.entries] };
      } else {
        feed = { ...home, fresh: [entry, ...home.fresh] };
      }
      const cleaned = placeholder ? withoutPost({ ...state, posts }, placeholder.id).posts! : posts;
      return {
        posts: { ...cleaned, [item.post.id]: item.post },
        feeds: { ...state.feeds, [feedKey.home]: feed },
      };
    }

    case 'POST_UPDATE':
      return state.posts[frame.d.id] ? { posts: withPosts(state, [frame.d]) } : null;

    case 'POST_DELETE':
      return withoutPost(state, frame.d.id);

    case 'NOTIFICATION_CREATE': {
      const n = state.notifications;
      if (n.items.some((i) => i.id === frame.d.id)) return null;
      return {
        notifications: { ...n, items: n.loaded ? [frame.d, ...n.items] : n.items, unread: n.unread + 1 },
        posts: frame.d.post ? withPosts(state, [frame.d.post]) : state.posts,
      };
    }

    case 'RELATIONSHIP_UPDATE':
      return { relationships: { ...state.relationships, [frame.d.userId]: frame.d } };

    case 'LINKED_ACCOUNTS_UPDATE':
      return { linkedAccounts: frame.d };

    case 'SYSTEM_MESSAGE_CREATE': {
      const system = state.system;
      if (system.items.some((m) => m.id === frame.d.id)) return null;
      return { system: { ...system, items: [...system.items, frame.d], unread: system.unread + 1 } };
    }

    default:
      return null;
  }
}

export interface ComposeInput {
  text: string;
  media?: Array<UploadedMedia & { alt?: string }>;
  replyTo?: Post | null;
  quote?: Post | null;
  visibility?: PostVisibility;
  cw?: string | null;
  crosspost?: string[];
}

interface SocialHost {
  get(): SocialState;
  set(patch: Partial<SocialState> | ((s: SocialState) => Partial<SocialState>)): void;
  rest(): RestClient;
  me(): User | undefined;
}

/**
 * Social actions with optimistic updates. Reach it through `session.social`.
 *
 * ```ts
 * await session.social.loadFeed(feedKey.home);
 * await session.social.createPost({ text: 'hello #jolt' });
 * ```
 */
export class JoltSocial {
  private nonceCounter = 0;

  constructor(private readonly host: SocialHost) {}

  get state(): SocialState {
    return this.host.get();
  }

  feed(key: string): FeedState {
    return this.state.feeds[key] ?? emptyFeed;
  }

  private patchFeed(key: string, patch: (f: FeedState) => Partial<FeedState>) {
    this.host.set((s) => {
      const feed = s.feeds[key] ?? emptyFeed;
      return { feeds: { ...s.feeds, [key]: { ...feed, ...patch(feed) } } };
    });
  }

  private fetchPage(key: string, before?: string): Promise<TimelinePage> {
    const rest = this.host.rest();
    if (key === feedKey.home) return rest.timeline({ before });
    // User ids from Bluesky and Mastodon contain colons, so only the filter at the end is split off.
    const profile = /^profile:(.+):(posts|replies|media)$/.exec(key);
    if (profile) {
      const [userId, filter] = [profile[1]!, profile[2] as ProfileFilter];
      const linkId = linkOfUser(userId);
      return linkId
        ? rest.linkProfilePosts(linkId, userId, { before, filter })
        : rest.profilePosts(userId, { before, filter });
    }
    const link = /^link:(\d+)$/.exec(key);
    if (link) return rest.linkTimeline(link[1]!, { before });
    throw new Error(`Unknown feed "${key}"`);
  }

  /** Loads the newest page of a feed, or the next older page. */
  async loadFeed(key: string, direction: 'latest' | 'older' = 'latest'): Promise<void> {
    const feed = this.feed(key);
    if (feed.loading || (direction === 'older' && (!feed.hasMore || !feed.cursor))) return;
    this.patchFeed(key, () => ({ loading: true }));
    try {
      const page = await this.fetchPage(key, direction === 'older' ? (feed.cursor ?? undefined) : undefined);
      this.host.set((s) => ({
        posts: withPosts(
          s,
          page.items.map((i) => i.post),
        ),
      }));
      this.patchFeed(key, (f) => {
        const pending = f.entries.filter((e) => this.state.posts[e.postId]?.pending);
        const entries =
          direction === 'latest'
            ? [...pending, ...page.items.map(entryOf)]
            : [...f.entries, ...page.items.map(entryOf)];
        return {
          entries,
          cursor: page.cursor,
          hasMore: page.cursor !== null,
          loading: false,
          loaded: true,
          fresh: direction === 'latest' ? [] : f.fresh,
        };
      });
    } catch (error) {
      this.patchFeed(key, () => ({ loading: false }));
      throw error;
    }
  }

  /** Moves posts that arrived in the background to the top of the feed. */
  showFresh(key: string = feedKey.home): void {
    this.patchFeed(key, (f) => ({ entries: [...f.fresh, ...f.entries], fresh: [] }));
  }

  uploadMedia(image: Blob): Promise<UploadedMedia> {
    return this.host.rest().uploadMedia(image);
  }

  /** Publishes a post. It appears straight away and is swapped for the server's copy when that arrives. */
  async createPost(input: ComposeInput): Promise<Post> {
    const linkId = input.replyTo ? linkOf(input.replyTo) : null;
    if (input.replyTo && linkId) return this.replyOnLink(linkId, input.replyTo, input.text);
    const me = this.host.me();
    if (!me) throw new Error('Not signed in');
    const nonce = `${Date.now()}-${++this.nonceCounter}`;
    const placeholder: SocialPost = {
      id: `pending-${nonce}`,
      source: 'jolt',
      author: me,
      text: input.text.trim(),
      facets: detectFacets(input.text.trim()),
      media: (input.media ?? []).map((m) => ({
        url: m.url,
        mediaType: m.mediaType,
        alt: m.alt ?? '',
        width: m.width,
        height: m.height,
      })),
      cw: input.cw ?? null,
      visibility: input.visibility ?? 'public',
      url: null,
      createdAt: Date.now(),
      editedAt: null,
      replyToId: input.replyTo?.id ?? null,
      rootId: input.replyTo ? (input.replyTo.rootId ?? input.replyTo.id) : null,
      replyToAuthor: input.replyTo?.author ?? null,
      quote: input.quote ?? null,
      counts: { replies: 0, reposts: 0, likes: 0 },
      viewer: { liked: false, reposted: false },
      nonce,
      pending: true,
    };
    this.insertPlaceholder(placeholder);

    const body: CreatePostBody = {
      text: input.text,
      media: (input.media ?? []).map((m) => ({ id: m.id, alt: m.alt ?? '' })),
      replyToId: input.replyTo?.id,
      quoteId: input.quote?.id,
      visibility: input.visibility ?? 'public',
      cw: input.cw ?? null,
      crosspost: input.crosspost ?? [],
      nonce,
    };
    try {
      const post = await this.host.rest().createPost(body);
      this.settlePlaceholder(placeholder.id, post);
      return post;
    } catch (error) {
      this.host.set((s) =>
        s.posts[placeholder.id]
          ? { posts: { ...s.posts, [placeholder.id]: { ...placeholder, pending: false, failed: true } } }
          : {},
      );
      throw error;
    }
  }

  /** Replies to a Bluesky or Mastodon post from a linked timeline, as that account. */
  private async replyOnLink(linkId: string, parent: Post, text: string): Promise<Post> {
    const reply = await this.host.rest().linkAction(linkId, { postId: parent.id, action: 'reply', text });
    this.host.set((s) => {
      const thread = s.threads[parent.id];
      return {
        posts: withPosts(s, [
          reply,
          { ...parent, counts: { ...parent.counts, replies: parent.counts.replies + 1 } },
        ]),
        threads: thread
          ? { ...s.threads, [parent.id]: { ...thread, replies: [...thread.replies, reply.id] } }
          : s.threads,
      };
    });
    return reply;
  }

  private insertPlaceholder(post: SocialPost) {
    this.host.set((s) => {
      const entry: FeedEntry = { id: post.id, postId: post.id, repostedBy: null };
      const feeds = { ...s.feeds };
      const home = feeds[feedKey.home];
      if (home?.loaded && !post.replyToId)
        feeds[feedKey.home] = { ...home, entries: [entry, ...home.entries] };
      const threads = { ...s.threads };
      const thread = post.replyToId ? threads[post.replyToId] : undefined;
      if (thread && post.replyToId)
        threads[post.replyToId] = { ...thread, replies: [...thread.replies, post.id] };
      return { posts: { ...s.posts, [post.id]: post }, feeds, threads };
    });
  }

  private settlePlaceholder(placeholderId: string, post: Post) {
    this.host.set((s) => {
      if (!s.posts[placeholderId]) return { posts: withPosts(s, [post]) };
      const swap = (e: FeedEntry): FeedEntry =>
        e.postId === placeholderId ? { ...e, id: post.id, postId: post.id } : e;
      const feeds = Object.fromEntries(
        Object.entries(s.feeds).map(([key, feed]) => {
          const entries = feed.entries.map(swap);
          // The gateway may have delivered the real post already; don't show it twice.
          const unique = entries.filter((e, i) => entries.findIndex((x) => x.id === e.id) === i);
          return [key, { ...feed, entries: unique }];
        }),
      );
      const threads = Object.fromEntries(
        Object.entries(s.threads).map(([key, t]) => [
          key,
          { ...t, replies: [...new Set(t.replies.map((id) => (id === placeholderId ? post.id : id)))] },
        ]),
      );
      const { [placeholderId]: _gone, ...posts } = s.posts;
      return { posts: { ...posts, [post.id]: post }, feeds, threads };
    });
  }

  /** Drops a failed optimistic post. */
  discardPost(postId: string): void {
    this.host.set((s) => withoutPost(s, postId));
  }

  async deletePost(postId: string): Promise<void> {
    const before = this.state;
    this.host.set((s) => withoutPost(s, postId));
    try {
      await this.host.rest().deletePost(postId);
    } catch (error) {
      this.host.set({ posts: before.posts, feeds: before.feeds, threads: before.threads });
      throw error;
    }
  }

  private async optimistic(postId: string, change: (p: SocialPost) => SocialPost, call: () => Promise<Post>) {
    const original = this.state.posts[postId];
    if (!original || original.pending) return;
    this.host.set((s) => ({ posts: { ...s.posts, [postId]: change(original) } }));
    try {
      const post = await call();
      this.host.set((s) => ({ posts: withPosts(s, [post]) }));
    } catch (error) {
      this.host.set((s) => ({ posts: { ...s.posts, [postId]: original } }));
      throw error;
    }
  }

  toggleLike(postId: string): Promise<void> {
    const post = this.state.posts[postId];
    if (!post) return Promise.resolve();
    const liked = !post.viewer.liked;
    const rest = this.host.rest();
    return this.optimistic(
      postId,
      (p) => ({
        ...p,
        viewer: { ...p.viewer, liked },
        counts: { ...p.counts, likes: Math.max(0, p.counts.likes + (liked ? 1 : -1)) },
      }),
      () => {
        const linkId = linkOf(post);
        if (linkId) return rest.linkAction(linkId, { postId, action: liked ? 'like' : 'unlike' });
        return liked ? rest.like(postId) : rest.unlike(postId);
      },
    );
  }

  toggleRepost(postId: string): Promise<void> {
    const post = this.state.posts[postId];
    if (!post) return Promise.resolve();
    const reposted = !post.viewer.reposted;
    const rest = this.host.rest();
    return this.optimistic(
      postId,
      (p) => ({
        ...p,
        viewer: { ...p.viewer, reposted },
        counts: { ...p.counts, reposts: Math.max(0, p.counts.reposts + (reposted ? 1 : -1)) },
      }),
      () => {
        const linkId = linkOf(post);
        if (linkId) return rest.linkAction(linkId, { postId, action: reposted ? 'repost' : 'unrepost' });
        return reposted ? rest.repost(postId) : rest.unrepost(postId);
      },
    );
  }

  relationship(userId: string): Relationship | undefined {
    return this.state.relationships[userId] ?? this.state.profiles[userId]?.relationship ?? undefined;
  }

  async setFollowing(userId: string, follow: boolean): Promise<Relationship> {
    const previous = this.relationship(userId);
    this.host.set((s) => ({
      relationships: {
        ...s.relationships,
        [userId]: {
          userId,
          followedBy: previous?.followedBy ?? false,
          following: follow ? 'pending' : 'none',
        },
      },
    }));
    try {
      const rest = this.host.rest();
      const linkId = linkOfUser(userId);
      const relationship = await (linkId
        ? follow
          ? rest.linkFollow(linkId, userId)
          : rest.linkUnfollow(linkId, userId)
        : follow
          ? rest.follow(userId)
          : rest.unfollow(userId));
      this.host.set((s) => ({ relationships: { ...s.relationships, [userId]: relationship } }));
      return relationship;
    } catch (error) {
      this.host.set((s) => {
        const { [userId]: _dropped, ...relationships } = s.relationships;
        return { relationships: previous ? { ...relationships, [userId]: previous } : relationships };
      });
      throw error;
    }
  }

  private storeProfile(profile: Profile): Profile {
    this.host.set((s) => ({
      profiles: { ...s.profiles, [profile.user.id]: profile },
      relationships: profile.relationship
        ? { ...s.relationships, [profile.user.id]: profile.relationship }
        : s.relationships,
    }));
    return profile;
  }

  async loadProfile(userId: string): Promise<Profile> {
    const linkId = linkOfUser(userId);
    const rest = this.host.rest();
    return this.storeProfile(await (linkId ? rest.linkProfile(linkId, userId) : rest.profile(userId)));
  }

  /** Finds someone by `@name@server`, asking their server if needed. */
  async lookup(address: string): Promise<Profile> {
    return this.storeProfile(await this.host.rest().lookupProfile(address));
  }

  /** Opens a post from a link, whether it's on Jolt or another fediverse server. */
  async lookupPost(url: string): Promise<Post> {
    const post = await this.host.rest().lookupPost(url);
    this.host.set((s) => ({ posts: withPosts(s, [post]) }));
    return post;
  }

  async loadThread(postId: string): Promise<void> {
    this.host.set((s) => ({
      threads: {
        ...s.threads,
        [postId]: { ...(s.threads[postId] ?? { ancestors: [], replies: [] }), loading: true },
      },
    }));
    try {
      // Post ids from Bluesky and Mastodon start with their link, the same way people's ids do.
      const linkId = linkOfUser(postId);
      const thread = await (linkId
        ? this.host.rest().linkThread(linkId, postId)
        : this.host.rest().thread(postId));
      this.host.set((s) => ({
        posts: withPosts(s, [...thread.ancestors, thread.post, ...thread.replies]),
        threads: {
          ...s.threads,
          [postId]: {
            ancestors: thread.ancestors.map((p) => p.id),
            replies: thread.replies.map((p) => p.id),
            loading: false,
          },
        },
      }));
    } catch (error) {
      this.host.set((s) => {
        const { [postId]: _dropped, ...threads } = s.threads;
        return { threads };
      });
      throw error;
    }
  }

  async loadNotifications(direction: 'latest' | 'older' = 'latest'): Promise<void> {
    const n = this.state.notifications;
    if (n.loading || (direction === 'older' && !n.hasMore)) return;
    this.host.set((s) => ({ notifications: { ...s.notifications, loading: true } }));
    try {
      const page = await this.host
        .rest()
        .notifications({ before: direction === 'older' ? (n.cursor ?? undefined) : undefined });
      this.host.set((s) => ({
        posts: withPosts(
          s,
          page.items.flatMap((i) => (i.post ? [i.post] : [])),
        ),
        notifications: {
          items: direction === 'latest' ? page.items : [...s.notifications.items, ...page.items],
          cursor: page.cursor,
          hasMore: page.cursor !== null,
          loading: false,
          loaded: true,
          unread: page.unread,
        },
      }));
    } catch (error) {
      this.host.set((s) => ({ notifications: { ...s.notifications, loading: false } }));
      throw error;
    }
  }

  async loadLinks(): Promise<LinkedAccount[]> {
    const links = await this.host.rest().links();
    this.host.set({ linkedAccounts: links });
    return links;
  }

  /**
   * Starts linking a Bluesky account (pass the handle) or a Mastodon account (pass the server). Open the returned
   * address in a browser; once the user approves, the link arrives over the gateway.
   */
  async linkAccount(provider: LinkProvider, identifier: string): Promise<string> {
    return (await this.host.rest().startLink({ provider, identifier })).url;
  }

  async updateLink(linkId: string, body: UpdateLinkBody): Promise<void> {
    const updated = await this.host.rest().updateLink(linkId, body);
    this.host.set((s) => ({ linkedAccounts: s.linkedAccounts.map((l) => (l.id === linkId ? updated : l)) }));
  }

  /** Who the linked account follows, with people already on Jolt first. */
  findFriends(linkId: string): Promise<FriendSuggestion[]> {
    return this.host.rest().linkFriends(linkId);
  }

  async unlink(linkId: string): Promise<void> {
    await this.host.rest().unlink(linkId);
    this.host.set((s) => ({ linkedAccounts: s.linkedAccounts.filter((l) => l.id !== linkId) }));
  }

  async loadSystemMessages(): Promise<void> {
    const list = await this.host.rest().systemMessages();
    this.host.set({ system: { items: list.items, unread: list.unread, loaded: true } });
  }

  async markSystemMessagesRead(): Promise<void> {
    if (this.state.system.unread === 0) return;
    this.host.set((s) => ({
      system: { ...s.system, unread: 0, items: s.system.items.map((m) => ({ ...m, read: true })) },
    }));
    await this.host.rest().markSystemMessagesRead();
  }

  async markNotificationsRead(): Promise<void> {
    if (this.state.notifications.unread === 0) return;
    this.host.set((s) => ({
      notifications: {
        ...s.notifications,
        unread: 0,
        items: s.notifications.items.map((i) => ({ ...i, read: true })),
      },
    }));
    await this.host.rest().markNotificationsRead();
  }
}
