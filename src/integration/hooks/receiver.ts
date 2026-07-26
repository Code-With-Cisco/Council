/**
 * Localhost push receiver for Claude Code hooks.
 *
 * Hooks are the fast path — a needs-input state should reach the tray in
 * milliseconds, not on the next 10s reconciliation tick. They are never the
 * only path: the poller corrects anything a missed delivery leaves stale.
 *
 * Security posture, given that any local process can reach a loopback port:
 *  - binds 127.0.0.1 explicitly, so the port is never exposed off-machine;
 *  - port 0, so the OS assigns a free port and nothing is squatted;
 *  - a random secret written beside the port and required on every request,
 *    which keeps other local software from injecting fake agent states;
 *  - the event name is taken from the URL path, not the body;
 *  - a body size cap, so a runaway hook cannot exhaust memory.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import * as path from 'node:path';
import type { ClaudePaths } from '../paths.js';
import { parseHookDelivery, type HookDelivery } from './events.js';

/** Header carrying the shared secret. */
export const SECRET_HEADER = 'x-muster-secret';

/** Hook payloads are small; anything larger is malformed or hostile. */
const MAX_BODY_BYTES = 256 * 1024;

/** Contents of `<config>/muster/receiver.json`, which hook scripts read at fire time. */
export interface ReceiverDescriptor {
  readonly version: 1;
  readonly port: number;
  readonly secret: string;
  readonly url: string;
  /** PID of the app instance that owns this receiver, so a stale file is detectable. */
  readonly pid: number;
  readonly startedAt: string;
}

export interface ReceiverOptions {
  readonly onDelivery: (delivery: HookDelivery) => void;
  /** Reported but not thrown — a bad delivery is a diagnostic, not a crash. */
  readonly onError?: ((error: Error) => void) | undefined;
}

export class HookReceiver {
  private server: Server | undefined;
  private descriptor: ReceiverDescriptor | undefined;

  constructor(
    private readonly paths: ClaudePaths,
    private readonly options: ReceiverOptions,
  ) {}

  get info(): ReceiverDescriptor | undefined {
    return this.descriptor;
  }

  /** Binds an ephemeral loopback port and publishes the descriptor file. */
  async start(): Promise<ReceiverDescriptor> {
    if (this.descriptor !== undefined) return this.descriptor;

    const secret = randomBytes(32).toString('hex');
    const server = createServer((req, res) => {
      this.handle(req, res, secret).catch((err: unknown) => {
        this.report(err);
        respond(res, 500, { ok: false });
      });
    });

    // Hook scripts are short-lived; a lingering keep-alive socket would hold
    // the process open at shutdown for no benefit.
    server.keepAliveTimeout = 1_000;

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });

    const address = server.address();
    if (address === null || typeof address === 'string') {
      server.close();
      throw new Error('hook receiver did not bind a TCP port');
    }

    server.on('error', (err) => this.report(err));

    this.server = server;
    this.descriptor = {
      version: 1,
      port: address.port,
      secret,
      url: `http://127.0.0.1:${address.port}`,
      pid: process.pid,
      startedAt: new Date().toISOString(),
    };

    await this.writeDescriptor(this.descriptor);
    return this.descriptor;
  }

  /** Closes the port and removes the descriptor so hook scripts stop trying to post. */
  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.descriptor = undefined;

    if (server !== undefined) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    try {
      await rm(this.paths.receiverFile(), { force: true });
    } catch {
      // A leftover descriptor is harmless: scripts fail to connect and the
      // poller keeps the roster correct.
    }
  }

  private async writeDescriptor(descriptor: ReceiverDescriptor): Promise<void> {
    const file = this.paths.receiverFile();
    await mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.tmp`;
    // 0600: the file carries the secret that authenticates state changes.
    await writeFile(temp, `${JSON.stringify(descriptor, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    const { rename } = await import('node:fs/promises');
    await rename(temp, file);
  }

  private report(err: unknown): void {
    this.options.onError?.(err instanceof Error ? err : new Error(String(err)));
  }

  private async handle(req: IncomingMessage, res: ServerResponse, secret: string): Promise<void> {
    if (req.method !== 'POST') {
      respond(res, 405, { ok: false, error: 'POST only' });
      return;
    }

    const provided = req.headers[SECRET_HEADER];
    if (typeof provided !== 'string' || !timingSafeEqualString(provided, secret)) {
      respond(res, 403, { ok: false, error: 'bad secret' });
      return;
    }

    // `/hook/<EventName>` — the event comes from the path so a payload cannot
    // claim to be an event the app did not register a hook for.
    const url = req.url ?? '';
    const event = /^\/hook\/([A-Za-z]+)\/?$/.exec(url)?.[1];
    if (event === undefined) {
      respond(res, 404, { ok: false, error: 'unknown endpoint' });
      return;
    }

    let body: string;
    try {
      body = await readBody(req);
    } catch (err) {
      respond(res, 413, { ok: false, error: err instanceof Error ? err.message : 'bad body' });
      return;
    }

    let parsed: unknown;
    try {
      parsed = body.trim() === '' ? {} : JSON.parse(body);
    } catch {
      respond(res, 400, { ok: false, error: 'invalid JSON' });
      return;
    }

    const delivery = parseHookDelivery(event, parsed);
    if (delivery === null) {
      respond(res, 400, { ok: false, error: 'unsupported event' });
      return;
    }

    // Acknowledge before dispatching: hooks run inline in the agent's turn and
    // a slow listener would stall the session that fired it.
    respond(res, 200, { ok: true });

    try {
      this.options.onDelivery(delivery);
    } catch (err) {
      this.report(err);
    }
  }
}

function respond(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('hook payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Length-independent comparison, so the secret cannot be recovered by timing. */
function timingSafeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
