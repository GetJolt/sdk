// JoltClient owns one connection per instance: the user's home instance, plus a federated connection to
// every other instance hosting a guild they've joined.

import {
  federationChallengeMessage,
  generateKeyPair,
  instanceOrigin,
  normalizeInstance,
  signBytes,
  type DispatchFrame,
  type GuildIndexEntry,
  type GuildSnapshot,
  type IdentityCert,
  type KeyPair,
  type LoginBody,
  type PresenceStatus,
  type RegisterBody,
  type User,
} from '@getjolt/protocol';
import { Emitter } from './emitter.js';
import { GatewayClient, type GatewayState } from './gateway.js';
import { JoltApiError, RestClient } from './rest.js';

/** Somewhere safe to keep tokens and the device key, e.g. Electron safeStorage. */
export interface SecureStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface JoltClientOptions {
  storage: SecureStorage;
  deviceName?: string;
  /** Which instances to reach over plain http. Defaults to localhost addresses only. */
  isInsecure?: (instance: string) => boolean;
}

export class InstanceConnection {
  readonly rest: RestClient;
  readonly gateway: GatewayClient;
  token: string | null = null;
  user: User | null = null;

  constructor(
    readonly instance: string,
    readonly origin: string,
    readonly isHome: boolean,
    onUnauthorized: () => Promise<boolean>,
  ) {
    this.rest = new RestClient({ origin, getToken: () => this.token, onUnauthorized });
    this.gateway = new GatewayClient(origin, () => this.token);
  }
}

type ClientEvents = {
  dispatch: { instance: string; frame: DispatchFrame };
  connection: { instance: string; state: GatewayState };
  error: { instance: string; error: Error };
  signedOut: void;
};

const SESSION_KEY = 'jolt.session';
const DEVICE_KEY = 'jolt.deviceKey';
const tokenKey = (instance: string) => `jolt.token.${instance}`;
const CERT_RENEW_MARGIN_SECONDS = 60 * 60;

export const defaultIsInsecure = (instance: string) =>
  /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(instance);

export class JoltClient extends Emitter<ClientEvents> {
  private readonly connections = new Map<string, InstanceConnection>();
  private homeInstance: string | null = null;
  private cert: IdentityCert | null = null;
  private deviceKey: Promise<KeyPair> | null = null;
  private presence: PresenceStatus = 'online';
  private readonly pendingAuth = new Map<string, Promise<InstanceConnection>>();

  constructor(private readonly options: JoltClientOptions) {
    super();
  }

  get home(): InstanceConnection {
    const conn = this.homeInstance ? this.connections.get(this.homeInstance) : undefined;
    if (!conn) throw new Error('Not signed in');
    return conn;
  }

  get homeDomain(): string | null {
    return this.homeInstance;
  }

  connection(instance: string): InstanceConnection | undefined {
    return this.connections.get(instance);
  }

  allConnections(): InstanceConnection[] {
    return [...this.connections.values()];
  }

  originFor(instance: string): string {
    return instanceOrigin(instance, (this.options.isInsecure ?? defaultIsInsecure)(instance));
  }

  /** A throwaway REST client for looking at an instance before signing in, e.g. to show its name. */
  probe(instance: string): RestClient {
    return new RestClient({ origin: this.originFor(normalizeInstance(instance)), getToken: () => null });
  }

  private createConnection(instance: string, isHome: boolean): InstanceConnection {
    const conn = new InstanceConnection(instance, this.originFor(instance), isHome, () =>
      this.refreshAuth(instance),
    );
    conn.gateway.on('dispatch', (frame) => {
      if (frame.t === 'READY') conn.user = frame.d.user;
      if (frame.t === 'USER_UPDATE' && frame.d.id === conn.user?.id) conn.user = frame.d;
      this.emit('dispatch', { instance, frame });
    });
    conn.gateway.on('state', (state) => this.emit('connection', { instance, state }));
    conn.gateway.on('unauthorized', () => {
      void this.refreshAuth(instance).then((ok) =>
        ok ? conn.gateway.connect() : this.handleLostSession(instance),
      );
    });
    conn.gateway.setPresence(this.presence);
    this.connections.set(instance, conn);
    return conn;
  }

  /** Restores the previous session, if any. Returns false when the user needs to sign in. */
  async restore(): Promise<boolean> {
    const home = await this.options.storage.get(SESSION_KEY);
    if (!home) return false;
    const token = await this.options.storage.get(tokenKey(home));
    if (!token) return false;

    this.homeInstance = home;
    const conn = this.createConnection(home, true);
    conn.token = token;
    try {
      conn.user = await conn.rest.me();
    } catch (error) {
      if (error instanceof JoltApiError && error.status === 401) {
        await this.clearLocalState();
        return false;
      }
      // Offline: carry on with the stored token, the gateway will keep retrying.
    }
    return true;
  }

  async register(instance: string, body: Omit<RegisterBody, 'deviceName'>): Promise<User> {
    return this.signIn(instance, (rest) => rest.register({ ...body, deviceName: this.options.deviceName }));
  }

  async login(instance: string, body: Omit<LoginBody, 'deviceName'>): Promise<User> {
    return this.signIn(instance, (rest) => rest.login({ ...body, deviceName: this.options.deviceName }));
  }

  private async signIn(
    rawInstance: string,
    call: (rest: RestClient) => Promise<{ token: string; user: User }>,
  ): Promise<User> {
    const instance = normalizeInstance(rawInstance);
    await this.signOut({ remote: false });
    const conn = this.createConnection(instance, true);
    const { token, user } = await call(conn.rest).catch((error: unknown) => {
      this.connections.delete(instance);
      throw error;
    });
    this.homeInstance = instance;
    conn.token = token;
    conn.user = user;
    await this.options.storage.set(SESSION_KEY, instance);
    await this.options.storage.set(tokenKey(instance), token);
    return user;
  }

  /** Opens the home gateway and every instance the user has guilds on. */
  async start(): Promise<GuildIndexEntry[]> {
    this.home.gateway.connect();
    let index: GuildIndexEntry[] = [];
    try {
      index = await this.home.rest.guildIndex();
    } catch (error) {
      this.emit('error', { instance: this.home.instance, error: error as Error });
    }
    const remotes = new Set(index.map((e) => e.instance).filter((i) => i !== this.homeInstance));
    await Promise.all(
      [...remotes].map((instance) =>
        this.connect(instance).catch((error: Error) => this.emit('error', { instance, error })),
      ),
    );
    return index;
  }

  /** Returns a ready connection to `instance`, signing in with a federated identity if needed. */
  async connect(rawInstance: string): Promise<InstanceConnection> {
    const instance = normalizeInstance(rawInstance);
    const existing = this.connections.get(instance);
    if (existing?.token) {
      if (existing.gateway.state === 'idle' || existing.gateway.state === 'closed')
        existing.gateway.connect();
      return existing;
    }

    let pending = this.pendingAuth.get(instance);
    if (!pending) {
      pending = (async () => {
        const conn = existing ?? this.createConnection(instance, false);
        conn.token = await this.options.storage.get(tokenKey(instance));
        if (!conn.token) await this.federate(conn);
        conn.gateway.connect();
        return conn;
      })().finally(() => this.pendingAuth.delete(instance));
      this.pendingAuth.set(instance, pending);
    }
    return pending;
  }

  /** Memoized as a promise: concurrent callers must all get the same key, not each generate their own. */
  private getDeviceKey(): Promise<KeyPair> {
    this.deviceKey ??= (async () => {
      const stored = await this.options.storage.get(DEVICE_KEY);
      if (stored) return JSON.parse(stored) as KeyPair;
      const key = await generateKeyPair();
      await this.options.storage.set(DEVICE_KEY, JSON.stringify(key));
      return key;
    })();
    return this.deviceKey;
  }

  private async getCert(): Promise<IdentityCert> {
    const now = Math.floor(Date.now() / 1000);
    if (this.cert && this.cert.payload.exp - now > CERT_RENEW_MARGIN_SECONDS) return this.cert;
    const key = await this.getDeviceKey();
    this.cert = (await this.home.rest.issueCert(key.publicKey)).cert;
    return this.cert;
  }

  private async federate(conn: InstanceConnection): Promise<void> {
    const [cert, key, challenge] = await Promise.all([
      this.getCert(),
      this.getDeviceKey(),
      conn.rest.federationChallenge(),
    ]);
    const signature = await signBytes(
      federationChallengeMessage(conn.instance, challenge.nonce),
      key.secretKey,
    );
    const { token, user } = await conn.rest.federatedAuth({
      cert,
      nonce: challenge.nonce,
      signature,
      deviceName: this.options.deviceName,
    });
    conn.token = token;
    conn.user = user;
    await this.options.storage.set(tokenKey(conn.instance), token);
  }

  private async refreshAuth(instance: string): Promise<boolean> {
    const conn = this.connections.get(instance);
    if (!conn) return false;
    if (conn.isHome) {
      this.handleLostSession(instance);
      return false;
    }
    try {
      conn.token = null;
      await this.options.storage.delete(tokenKey(instance));
      await this.federate(conn);
      return true;
    } catch (error) {
      this.emit('error', { instance, error: error as Error });
      return false;
    }
  }

  private handleLostSession(instance: string) {
    if (instance === this.homeInstance) {
      void this.clearLocalState().then(() => this.emit('signedOut', undefined));
    }
  }

  setPresence(status: PresenceStatus): void {
    this.presence = status;
    for (const conn of this.connections.values()) conn.gateway.setPresence(status);
  }

  /** Adds a guild to the home index so the user's other devices pick it up too. */
  async rememberGuild(instance: string, guildId: string): Promise<void> {
    const index = await this.home.rest.guildIndex();
    if (index.some((e) => e.instance === instance && e.guildId === guildId)) return;
    const position = index.reduce((max, e) => Math.max(max, e.position + 1), 0);
    await this.home.rest.setGuildIndex([...index, { instance, guildId, position }]);
  }

  async forgetGuild(instance: string, guildId: string): Promise<void> {
    const index = await this.home.rest.guildIndex();
    await this.home.rest.setGuildIndex(
      index.filter((e) => !(e.instance === instance && e.guildId === guildId)),
    );
  }

  async saveGuildOrder(entries: GuildIndexEntry[]): Promise<void> {
    await this.home.rest.setGuildIndex(entries);
  }

  async createGuild(name: string): Promise<GuildSnapshot> {
    const snapshot = await this.home.rest.createGuild({ name });
    await this.rememberGuild(this.home.instance, snapshot.guild.id);
    return snapshot;
  }

  async joinInvite(
    rawInstance: string,
    code: string,
  ): Promise<{ instance: string; snapshot: GuildSnapshot }> {
    const instance = normalizeInstance(rawInstance);
    const conn = instance === this.homeInstance ? this.home : await this.connect(instance);
    const snapshot = await conn.rest.acceptInvite(code);
    await this.rememberGuild(instance, snapshot.guild.id);
    return { instance, snapshot };
  }

  async leaveGuild(instance: string, guildId: string): Promise<void> {
    const conn = this.connections.get(instance);
    if (conn) await conn.rest.leaveGuild(guildId);
    await this.forgetGuild(instance, guildId);
  }

  /** After editing the profile at home, ask other instances to pull the new version. */
  async syncProfileEverywhere(): Promise<void> {
    await Promise.allSettled(
      [...this.connections.values()].filter((c) => !c.isHome && c.token).map((c) => c.rest.syncProfile()),
    );
  }

  async signOut({ remote = true }: { remote?: boolean } = {}): Promise<void> {
    if (remote && this.homeInstance)
      await this.connections
        .get(this.homeInstance)
        ?.rest.logout()
        .catch(() => undefined);
    await this.clearLocalState();
  }

  private async clearLocalState() {
    for (const conn of this.connections.values()) {
      conn.gateway.close();
      await this.options.storage.delete(tokenKey(conn.instance));
    }
    this.connections.clear();
    this.cert = null;
    this.homeInstance = null;
    await this.options.storage.delete(SESSION_KEY);
  }
}
