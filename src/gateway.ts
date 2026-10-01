import {
  GATEWAY_PATH,
  GatewayCloseCode,
  type ClientFrame,
  type DispatchFrame,
  type PresenceStatus,
  type ServerFrame,
} from '@jolt/protocol';
import { Emitter } from './emitter.js';

export type GatewayState = 'idle' | 'connecting' | 'ready' | 'reconnecting' | 'closed';

type GatewayEvents = {
  dispatch: DispatchFrame;
  state: GatewayState;
  /** The server rejected our token; the owner should refresh credentials and call connect() again. */
  unauthorized: void;
};

const MAX_BACKOFF_MS = 30_000;

export class GatewayClient extends Emitter<GatewayEvents> {
  private socket: WebSocket | null = null;
  private sessionId: string | null = null;
  private seq = 0;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private awaitingAck = false;
  private attempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private status: PresenceStatus = 'online';
  state: GatewayState = 'idle';

  constructor(
    private readonly origin: string,
    private readonly getToken: () => string | null,
  ) {
    super();
  }

  connect(): void {
    this.stopped = false;
    this.open();
  }

  close(): void {
    this.stopped = true;
    this.sessionId = null;
    this.teardown();
    this.setState('closed');
  }

  setPresence(status: PresenceStatus): void {
    this.status = status;
    if (this.state === 'ready') this.send({ op: 'presence_update', d: { status } });
  }

  private setState(state: GatewayState) {
    if (this.state === state) return;
    this.state = state;
    this.emit('state', state);
  }

  private open() {
    this.teardown();
    const token = this.getToken();
    if (!token) return;

    this.setState(this.sessionId ? 'reconnecting' : 'connecting');
    const url = new URL(GATEWAY_PATH, this.origin);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url);
    this.socket = socket;

    socket.onmessage = (event) => {
      let frame: ServerFrame;
      try {
        frame = JSON.parse(String(event.data)) as ServerFrame;
      } catch {
        return;
      }
      this.handle(frame, token);
    };

    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.stopHeartbeat();
      this.socket = null;
      if (this.stopped) return;
      if (event.code === GatewayCloseCode.AuthenticationFailed) {
        this.sessionId = null;
        this.setState('idle');
        this.emit('unauthorized', undefined);
        return;
      }
      this.scheduleReconnect();
    };
  }

  private handle(frame: ServerFrame, token: string) {
    switch (frame.op) {
      case 'hello':
        this.startHeartbeat(frame.d.heartbeatInterval);
        if (this.sessionId) {
          this.send({ op: 'resume', d: { token, sessionId: this.sessionId, seq: this.seq } });
        } else {
          this.send({ op: 'identify', d: { token } });
        }
        return;

      case 'heartbeat_ack':
        this.awaitingAck = false;
        return;

      case 'invalid_session':
        this.sessionId = null;
        this.seq = 0;
        this.send({ op: 'identify', d: { token } });
        return;

      case 'reconnect':
        this.socket?.close(4000);
        return;

      case 'dispatch':
        this.seq = frame.s;
        if (frame.t === 'READY') {
          this.sessionId = frame.d.sessionId;
          this.attempts = 0;
          this.setState('ready');
          if (this.status !== 'online') this.send({ op: 'presence_update', d: { status: this.status } });
        } else if (frame.t === 'RESUMED') {
          this.attempts = 0;
          this.setState('ready');
        }
        this.emit('dispatch', frame);
        return;
    }
  }

  private send(frame: ClientFrame) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(frame));
  }

  private startHeartbeat(interval: number) {
    this.stopHeartbeat();
    this.awaitingAck = false;
    this.heartbeat = setInterval(() => {
      // No ack since the last beat means the connection is a zombie; drop it and resume.
      if (this.awaitingAck) {
        this.socket?.close(4000);
        return;
      }
      this.awaitingAck = true;
      this.send({ op: 'heartbeat', d: { seq: this.seq || null } });
    }, interval);
  }

  private stopHeartbeat() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  private scheduleReconnect() {
    this.setState('reconnecting');
    const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** this.attempts) * (0.5 + Math.random() / 2);
    this.attempts++;
    this.reconnectTimer = setTimeout(() => this.open(), delay);
  }

  private teardown() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.stopHeartbeat();
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000);
  }
}
