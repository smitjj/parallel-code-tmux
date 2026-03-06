// Core IPC — wraps Electron's ipcRenderer for frontend-backend communication.

import { IPC } from '../../electron/ipc/channels';

declare global {
  interface Window {
    electron: {
      ipcRenderer: {
        invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
        postMessage: (channel: string, message: unknown, transfer?: MessagePort[]) => void;
        connectAgentStream: (agentId: string) => {
          on: (listener: (msg: unknown) => void) => () => void;
          close: () => void;
        };
        on: (channel: string, listener: (...args: unknown[]) => void) => () => void;
        removeAllListeners: (channel: string) => void;
      };
    };
  }
}

export class Channel<T> {
  private _id = crypto.randomUUID();
  cleanup: (() => void) | null = null;
  onmessage: ((msg: T) => void) | null = null;

  constructor() {
    this.cleanup = window.electron.ipcRenderer.on(`channel:${this._id}`, (msg: unknown) => {
      this.onmessage?.(msg as T);
    });
  }

  get id() {
    return this._id;
  }

  toJSON() {
    return { __CHANNEL_ID__: this._id };
  }
}

export class AgentStream<T> {
  private readonly _stream: {
    on: (listener: (msg: unknown) => void) => () => void;
    close: () => void;
  };
  private _cleanup: (() => void) | null = null;
  onmessage: ((msg: T) => void) | null = null;

  constructor(agentId: string) {
    this._stream = window.electron.ipcRenderer.connectAgentStream(agentId);
    this._cleanup = this._stream.on((msg: unknown) => this.onmessage?.(msg as T));
  }

  dispose() {
    if (this._cleanup) this._cleanup();
    this._stream.close();
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function serializeInvokeArg(value: unknown): unknown {
  if (value instanceof Channel) return value.toJSON();
  if (Array.isArray(value)) return value.map((v) => serializeInvokeArg(v));
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = serializeInvokeArg(v);
  return out;
}

export async function invoke<T>(cmd: IPC, args?: Record<string, unknown>): Promise<T> {
  // Replace Channel instances with structured-clone-safe channel IDs
  // without forcing a full JSON serialize/parse round-trip.
  const safeArgs = args ? (serializeInvokeArg(args) as Record<string, unknown>) : undefined;
  return window.electron.ipcRenderer.invoke(cmd, safeArgs) as Promise<T>;
}

/**
 * Invoke an IPC command without awaiting the result.
 * Logs errors to console and optionally calls onError for user-visible feedback.
 */
export function fireAndForget(
  cmd: IPC,
  args?: Record<string, unknown>,
  onError?: (err: unknown) => void,
): void {
  invoke(cmd, args).catch((err: unknown) => {
    console.error(`[IPC] ${cmd} failed:`, err);
    onError?.(err);
  });
}
