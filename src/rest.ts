import {
  API_PREFIX,
  WELL_KNOWN_PATH,
  type AuthResponse,
  type Ban,
  type Channel,
  type CreateChannelBody,
  type CreateGuildBody,
  type CreateInviteBody,
  type CreateMessageBody,
  type CreateRoleBody,
  type FederationAuthBody,
  type Guild,
  type GuildIndexEntry,
  type GuildSnapshot,
  type IdentityCert,
  type InstanceInfo,
  type Invite,
  type ListMessagesQuery,
  type LoginBody,
  type Member,
  type Message,
  type ReadState,
  type RegisterBody,
  type ReorderBody,
  type Role,
  type SessionInfo,
  type UpdateChannelBody,
  type UpdateGuildBody,
  type UpdateMemberBody,
  type UpdateProfileBody,
  type UpdateRoleBody,
  type User,
  type CreatePostBody,
  type FriendSuggestion,
  type LinkActionBody,
  type LinkedAccount,
  type StartLinkBody,
  type UpdateLinkBody,
  type NotificationPage,
  type PageQuery,
  type Post,
  type Profile,
  type Relationship,
  type Thread,
  type TimelinePage,
} from '@getjolt/protocol';

export interface UploadedMedia {
  id: string;
  url: string;
  mediaType: string;
  width: number;
  height: number;
}

export type ProfileFilter = 'posts' | 'replies' | 'media';

export class JoltApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fields: Record<string, string> = {},
  ) {
    super(message);
  }
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RestOptions {
  origin: string;
  getToken: () => string | null;
  /** Called once on a 401; return true after refreshing credentials to retry the request. */
  onUnauthorized?: () => Promise<boolean>;
  timeoutMs?: number;
}

const enc = encodeURIComponent;

export class RestClient {
  constructor(private readonly options: RestOptions) {}

  get origin() {
    return this.options.origin;
  }

  async request<T>(
    method: Method,
    path: string,
    body?: unknown,
    query?: object,
    retried = false,
  ): Promise<T> {
    const url = new URL(path.startsWith('/.well-known') ? path : `${API_PREFIX}${path}`, this.options.origin);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = { accept: 'application/json' };
    const token = this.options.getToken();
    if (token) headers.authorization = `Bearer ${token}`;
    // Blobs (avatar uploads) go out as-is, and fetch sets their content type.
    const raw = body instanceof Blob;
    if (body !== undefined && !raw) headers['content-type'] = 'application/json';

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: body === undefined || raw ? (body as Blob | undefined) : JSON.stringify(body),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
      });
    } catch {
      throw new JoltApiError(0, 'network_error', `Couldn't reach ${url.host}. Check your connection.`);
    }

    if (response.status === 401 && !retried && token && this.options.onUnauthorized) {
      if (await this.options.onUnauthorized()) return this.request(method, path, body, query, true);
    }
    if (response.status === 204) return undefined as T;

    const data = (await response.json().catch(() => null)) as {
      error?: { code: string; message: string; fields?: Record<string, string> };
    } | null;
    if (!response.ok) {
      const error = data?.error;
      throw new JoltApiError(
        response.status,
        error?.code ?? 'unknown_error',
        error?.message ?? `Request failed (${response.status}).`,
        error?.fields,
      );
    }
    return data as T;
  }

  instanceInfo = () => this.request<InstanceInfo>('GET', WELL_KNOWN_PATH);

  register = (body: RegisterBody) => this.request<AuthResponse>('POST', '/auth/register', body);
  login = (body: LoginBody) => this.request<AuthResponse>('POST', '/auth/login', body);
  logout = () => this.request<void>('POST', '/auth/logout');

  me = () => this.request<User>('GET', '/users/@me');
  updateProfile = (body: UpdateProfileBody) => this.request<User>('PATCH', '/users/@me', body);
  syncProfile = () => this.request<User>('POST', '/users/@me/sync');
  /** Uploads a PNG, JPEG, WebP or GIF. The blob's type must be set, which it is for files and canvas output. */
  setAvatar = (image: Blob) => this.request<User>('PUT', '/users/@me/avatar', image);
  removeAvatar = () => this.request<User>('DELETE', '/users/@me/avatar');
  sessions = () => this.request<SessionInfo[]>('GET', '/users/@me/sessions');
  revokeSession = (id: string) => this.request<void>('DELETE', `/users/@me/sessions/${enc(id)}`);
  guildIndex = () => this.request<GuildIndexEntry[]>('GET', '/users/@me/guild-index');
  setGuildIndex = (entries: GuildIndexEntry[]) =>
    this.request<GuildIndexEntry[]>('PUT', '/users/@me/guild-index', { entries });
  issueCert = (devicePublicKey: string) =>
    this.request<{ cert: IdentityCert }>('POST', '/identity/certs', { devicePublicKey });
  user = (userId: string) => this.request<User>('GET', `/users/${enc(userId)}`);

  federationChallenge = () =>
    this.request<{ nonce: string; expiresAt: number }>('GET', '/federation/challenge');
  federatedAuth = (body: FederationAuthBody) => this.request<AuthResponse>('POST', '/federation/auth', body);

  createGuild = (body: CreateGuildBody) => this.request<GuildSnapshot>('POST', '/guilds', body);
  guild = (guildId: string) => this.request<GuildSnapshot>('GET', `/guilds/${enc(guildId)}`);
  updateGuild = (guildId: string, body: UpdateGuildBody) =>
    this.request<Guild>('PATCH', `/guilds/${enc(guildId)}`, body);
  deleteGuild = (guildId: string) => this.request<void>('DELETE', `/guilds/${enc(guildId)}`);

  createChannel = (guildId: string, body: CreateChannelBody) =>
    this.request<Channel>('POST', `/guilds/${enc(guildId)}/channels`, body);
  reorderChannels = (guildId: string, body: ReorderBody) =>
    this.request<void>('PATCH', `/guilds/${enc(guildId)}/channels`, body);
  updateChannel = (channelId: string, body: UpdateChannelBody) =>
    this.request<Channel>('PATCH', `/channels/${enc(channelId)}`, body);
  deleteChannel = (channelId: string) => this.request<void>('DELETE', `/channels/${enc(channelId)}`);

  createRole = (guildId: string, body: CreateRoleBody) =>
    this.request<Role>('POST', `/guilds/${enc(guildId)}/roles`, body);
  reorderRoles = (guildId: string, body: ReorderBody) =>
    this.request<Role[]>('PATCH', `/guilds/${enc(guildId)}/roles`, body);
  updateRole = (guildId: string, roleId: string, body: UpdateRoleBody) =>
    this.request<Role>('PATCH', `/guilds/${enc(guildId)}/roles/${enc(roleId)}`, body);
  deleteRole = (guildId: string, roleId: string) =>
    this.request<void>('DELETE', `/guilds/${enc(guildId)}/roles/${enc(roleId)}`);

  updateMember = (guildId: string, userId: string, body: UpdateMemberBody) =>
    this.request<Member>('PATCH', `/guilds/${enc(guildId)}/members/${enc(userId)}`, body);
  kickMember = (guildId: string, userId: string) =>
    this.request<void>('DELETE', `/guilds/${enc(guildId)}/members/${enc(userId)}`);
  leaveGuild = (guildId: string) => this.request<void>('DELETE', `/guilds/${enc(guildId)}/members/@me`);
  bans = (guildId: string) => this.request<Ban[]>('GET', `/guilds/${enc(guildId)}/bans`);
  ban = (guildId: string, userId: string, reason?: string) =>
    this.request<void>('PUT', `/guilds/${enc(guildId)}/bans/${enc(userId)}`, { reason });
  unban = (guildId: string, userId: string) =>
    this.request<void>('DELETE', `/guilds/${enc(guildId)}/bans/${enc(userId)}`);

  messages = (channelId: string, query: ListMessagesQuery = {}) =>
    this.request<Message[]>('GET', `/channels/${enc(channelId)}/messages`, undefined, query);
  sendMessage = (channelId: string, body: CreateMessageBody) =>
    this.request<Message>('POST', `/channels/${enc(channelId)}/messages`, body);
  editMessage = (channelId: string, messageId: string, content: string) =>
    this.request<Message>('PATCH', `/channels/${enc(channelId)}/messages/${enc(messageId)}`, { content });
  deleteMessage = (channelId: string, messageId: string) =>
    this.request<void>('DELETE', `/channels/${enc(channelId)}/messages/${enc(messageId)}`);
  ack = (channelId: string, messageId: string) =>
    this.request<ReadState>('POST', `/channels/${enc(channelId)}/messages/${enc(messageId)}/ack`);
  typing = (channelId: string) => this.request<void>('POST', `/channels/${enc(channelId)}/typing`);

  createInvite = (channelId: string, body: CreateInviteBody = {}) =>
    this.request<Invite>('POST', `/channels/${enc(channelId)}/invites`, body);
  invites = (guildId: string) => this.request<Invite[]>('GET', `/guilds/${enc(guildId)}/invites`);
  invite = (code: string) => this.request<Invite>('GET', `/invites/${enc(code)}`);
  acceptInvite = (code: string) => this.request<GuildSnapshot>('POST', `/invites/${enc(code)}`);
  deleteInvite = (code: string) => this.request<void>('DELETE', `/invites/${enc(code)}`);

  // Social. All of these go to the user's home instance.
  timeline = (query: PageQuery = {}) => this.request<TimelinePage>('GET', '/timeline', undefined, query);
  createPost = (body: CreatePostBody) => this.request<Post>('POST', '/posts', body);
  post = (postId: string) => this.request<Post>('GET', `/posts/${enc(postId)}`);
  /** Opens a post from its link, on this instance or anywhere on the fediverse. */
  lookupPost = (url: string) => this.request<Post>('GET', '/posts/lookup', undefined, { url });
  thread = (postId: string) => this.request<Thread>('GET', `/posts/${enc(postId)}/thread`);
  deletePost = (postId: string) => this.request<void>('DELETE', `/posts/${enc(postId)}`);
  like = (postId: string) => this.request<Post>('PUT', `/posts/${enc(postId)}/like`);
  unlike = (postId: string) => this.request<Post>('DELETE', `/posts/${enc(postId)}/like`);
  repost = (postId: string) => this.request<Post>('PUT', `/posts/${enc(postId)}/repost`);
  unrepost = (postId: string) => this.request<Post>('DELETE', `/posts/${enc(postId)}/repost`);
  /** Uploads an image for a post you're about to publish; pass the returned id in `createPost`. */
  uploadMedia = (image: Blob) => this.request<UploadedMedia>('POST', '/media', image);
  profile = (userId: string) => this.request<Profile>('GET', `/profiles/${enc(userId)}`);
  lookupProfile = (address: string) =>
    this.request<Profile>('GET', '/profiles/lookup', undefined, { address });
  profilePosts = (userId: string, query: PageQuery & { filter?: ProfileFilter } = {}) =>
    this.request<TimelinePage>('GET', `/profiles/${enc(userId)}/posts`, undefined, query);
  follow = (userId: string) => this.request<Relationship>('PUT', `/profiles/${enc(userId)}/follow`);
  unfollow = (userId: string) => this.request<Relationship>('DELETE', `/profiles/${enc(userId)}/follow`);
  notifications = (query: PageQuery = {}) =>
    this.request<NotificationPage>('GET', '/notifications', undefined, query);
  markNotificationsRead = () => this.request<void>('POST', '/notifications/read');

  links = () => this.request<LinkedAccount[]>('GET', '/links');
  /** Returns the Bluesky or Mastodon page to open so the user can approve linking their account. */
  startLink = (body: StartLinkBody) => this.request<{ url: string }>('POST', '/links/start', body);
  updateLink = (linkId: string, body: UpdateLinkBody) =>
    this.request<LinkedAccount>('PATCH', `/links/${enc(linkId)}`, body);
  unlink = (linkId: string) => this.request<void>('DELETE', `/links/${enc(linkId)}`);
  /** A linked account's own home timeline, fetched from Bluesky or Mastodon. */
  linkTimeline = (linkId: string, query: { before?: string } = {}) =>
    this.request<TimelinePage>('GET', `/links/${enc(linkId)}/timeline`, undefined, query);
  /** People the linked account follows, and how to follow each of them from Jolt. */
  linkFriends = (linkId: string) => this.request<FriendSuggestion[]>('GET', `/links/${enc(linkId)}/friends`);
  /** Like, repost or reply to a post from a linked timeline, as that account. */
  linkAction = (linkId: string, body: LinkActionBody) =>
    this.request<Post>('POST', `/links/${enc(linkId)}/actions`, body);
}
