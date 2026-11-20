import { Logger } from 'homebridge';

/**
 * Minimal Home Assistant WebSocket client: keeps the state of a fixed set of entities current
 * (subscribe_entities) and calls services. Reconnects with backoff. No dependencies: it uses the
 * WebSocket global that Node 22+ provides.
 */

type StateListener = (entityId: string, state: string | undefined) => void;
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

// Compressed state messages sent by subscribe_entities (homeassistant/components/websocket_api).
export interface CompressedStateMessage {
  a?: Record<string, { s?: string }>;
  c?: Record<string, { '+'?: { s?: string }; '-'?: unknown }>;
  r?: string[];
}

/** Apply one subscribe_entities message to the state map; returns the entity ids whose state changed. */
export function applyStateMessage(states: Map<string, string>, message: CompressedStateMessage): string[] {
  const changed: string[] = [];
  const set = (entityId: string, state: string | undefined) => {
    if (state === undefined) {
      return;
    }
    if (states.get(entityId) !== state) {
      states.set(entityId, state);
      changed.push(entityId);
    }
  };
  for (const [entityId, entity] of Object.entries(message.a ?? {})) {
    set(entityId, entity.s);
  }
  for (const [entityId, diff] of Object.entries(message.c ?? {})) {
    set(entityId, diff['+']?.s);
  }
  for (const entityId of message.r ?? []) {
    if (states.delete(entityId)) {
      changed.push(entityId);
    }
  }
  return changed;
}

export class HomeAssistantClient {
  private static readonly MAX_BACKOFF_MS = 60_000;
  private static readonly CALL_TIMEOUT_MS = 10_000;

  readonly states = new Map<string, string>();
  private socket?: WebSocket;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private subscriptionId?: number;
  private ready = false;
  private stopped = false;
  private backoffMs = 1_000;
  private reconnectTimer?: NodeJS.Timeout;
  private listeners: StateListener[] = [];

  constructor(
    private readonly log: Logger,
    private readonly url: string,
    private readonly token: string,
    private readonly entityIds: string[],
  ) {}

  get connected(): boolean {
    return this.ready;
  }

  onStateChange(listener: StateListener): void {
    this.listeners.push(listener);
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    this.socket?.close();
  }

  /** Call a Home Assistant service on one entity, e.g. ('homeassistant', 'turn_on', 'input_boolean.x'). */
  async callService(domain: string, service: string, entityId: string): Promise<void> {
    if (!this.ready) {
      throw new Error('Home Assistant is not connected');
    }
    await this.send({ type: 'call_service', domain, service, target: { entity_id: entityId } });
  }

  private connect(): void {
    const WebSocketImpl = (globalThis as unknown as { WebSocket?: typeof WebSocket }).WebSocket;
    if (!WebSocketImpl) {
      this.log.error('[Home Assistant] This Node.js has no WebSocket support (needs Node 22 or newer).');
      return;
    }
    let socket: WebSocket;
    try {
      socket = new WebSocketImpl(this.url);
    } catch (error) {
      this.log.error(`[Home Assistant] Cannot open ${this.url}: ${error}`);
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.addEventListener('message', event => this.handleMessage(socket, String(event.data)));
    socket.addEventListener('close', () => this.handleClose(socket));
    socket.addEventListener('error', () => {
      // 'close' follows and handles the reconnect.
    });
  }

  private handleMessage(socket: WebSocket, raw: string): void {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    switch (message.type) {
      case 'auth_required':
        socket.send(JSON.stringify({ type: 'auth', access_token: this.token }));
        break;
      case 'auth_invalid':
        this.log.error('[Home Assistant] The access token was rejected. Fix homeAssistant.token in the config.');
        this.stopped = true;
        socket.close();
        break;
      case 'auth_ok':
        this.backoffMs = 1_000;
        this.subscribe();
        break;
      case 'event':
        if (message.id === this.subscriptionId) {
          const changed = applyStateMessage(this.states, message.event);
          if (!this.ready) {
            this.ready = true;
            const missing = this.entityIds.filter(id => !this.states.has(id));
            this.log.info(`[Home Assistant] Connected to ${this.url}` +
              (missing.length ? `; entities not found: ${missing.join(', ')}` : ''));
          }
          for (const entityId of changed) {
            for (const listener of this.listeners) {
              listener(entityId, this.states.get(entityId));
            }
          }
        }
        break;
      case 'result': {
        const pending = this.pending.get(message.id);
        if (pending) {
          this.pending.delete(message.id);
          if (message.success) {
            pending.resolve(message.result);
          } else {
            pending.reject(new Error(`${message.error?.code}: ${message.error?.message}`));
          }
        }
        break;
      }
    }
  }

  private subscribe(): void {
    const id = this.nextId++;
    this.subscriptionId = id;
    this.socket?.send(JSON.stringify({ id, type: 'subscribe_entities', entity_ids: this.entityIds }));
  }

  private send(payload: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error('Home Assistant did not answer in time'));
        }
      }, HomeAssistantClient.CALL_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: value => {
          clearTimeout(timer); resolve(value);
        },
        reject: error => {
          clearTimeout(timer); reject(error);
        },
      });
      this.socket?.send(JSON.stringify({ id, ...payload }));
    });
  }

  private handleClose(socket: WebSocket): void {
    if (socket !== this.socket) {
      return;
    }
    const wasReady = this.ready;
    this.ready = false;
    this.subscriptionId = undefined;
    for (const pending of this.pending.values()) {
      pending.reject(new Error('Home Assistant connection closed'));
    }
    this.pending.clear();
    if (wasReady) {
      this.log.warn('[Home Assistant] Connection lost; reconnecting.');
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped) {
      return;
    }
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, HomeAssistantClient.MAX_BACKOFF_MS);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
    this.reconnectTimer.unref?.();
  }
}
