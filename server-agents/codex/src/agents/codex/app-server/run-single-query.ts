import { EventEmitter } from 'events';
import { createHash } from 'node:crypto';
import type { PermissionMode, ThinkingMode } from '@garcon/common/chat-modes';
import { withSingleQueryControl } from '@garcon/server-agent-common/shared/single-query-control';
import { isApprovalRequest } from './approvals.js';
import {
  CodexAppServerClient,
  type CodexAppServerClientOptions,
} from './client.js';
import type {
  CodexThreadItem,
  ItemCompletedNotification,
  JsonRpcNotification,
  JsonRpcServerRequest,
  TurnCompletedNotification,
} from './protocol.js';
import { buildCodexEnv, mapThinkingModeToCodexEffort } from './request-builders.js';
import { denialResponseForRequest } from './runtime-support.js';
import type { CodexProviderConfig } from '../runtime-types.js';

interface CodexSingleQueryOptions {
  cwd?: string;
  projectPath?: string;
  model?: string;
  permissionMode?: PermissionMode;
  thinkingMode?: ThinkingMode;
  envOverrides?: Record<string, string>;
  codexConfig?: CodexProviderConfig;
  timeoutMs?: number;
  signal?: AbortSignal;
}

interface CodexSingleQueryClient extends EventEmitter {
  startThread(params: Record<string, unknown>): Promise<{ thread: { id: string } }>;
  startTurn(params: Record<string, unknown>): Promise<{ turn: { id: string } }>;
  interruptTurn(threadId: string, turnId: string): Promise<unknown>;
  unsubscribeThread(threadId: string): Promise<unknown>;
  shutdown(): Promise<void>;
  respond(id: number, result: unknown): void;
  reject(id: number, code: number, message: string): void;
}

interface CodexSingleQueryRuntimeOptions {
  createClient?: (options?: CodexAppServerClientOptions) => CodexSingleQueryClient;
  maxQueriesPerClient?: number;
  clientIdleMs?: number;
}

interface ClientEntry {
  client: CodexSingleQueryClient;
  environmentKey: string;
  activeQueries: number;
  admittedQueries: number;
  acceptingQueries: boolean;
  retired: boolean;
  exited: boolean;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

const DEFAULT_MAX_QUERIES_PER_CLIENT = 32;
const DEFAULT_CLIENT_IDLE_MS = 30_000;

export class CodexSingleQueryRuntime {
  readonly #clients = new Map<string, ClientEntry>();
  readonly #drainingClients = new Set<ClientEntry>();
  readonly #createClient: NonNullable<CodexSingleQueryRuntimeOptions['createClient']>;
  readonly #maxQueriesPerClient: number;
  readonly #clientIdleMs: number;
  readonly #retirementPromises = new Set<Promise<void>>();
  #shutdownPromise: Promise<void> | null = null;
  #shutdownRequested = false;

  constructor(options: CodexSingleQueryRuntimeOptions = {}) {
    this.#createClient = options.createClient ?? ((clientOptions) => new CodexAppServerClient(clientOptions));
    this.#maxQueriesPerClient = options.maxQueriesPerClient ?? DEFAULT_MAX_QUERIES_PER_CLIENT;
    this.#clientIdleMs = options.clientIdleMs ?? DEFAULT_CLIENT_IDLE_MS;
  }

  run(prompt: string, options: CodexSingleQueryOptions = {}): Promise<string> {
    return withSingleQueryControl(options, (signal) => this.#run(prompt, options, signal));
  }

  async #run(
    prompt: string,
    options: CodexSingleQueryOptions,
    signal: AbortSignal,
  ): Promise<string> {
    const workingDirectory = options.cwd || options.projectPath || process.cwd();
    const environment = buildCodexEnv(options.envOverrides, options.codexConfig);
    const entry = this.#acquireClient(environment);
    const { client } = entry;
    let threadId: string | null = null;
    let turnId: string | null = null;
    let output = '';
    let settleCompletion: ((notification: TurnCompletedNotification) => void) | null = null;
    let rejectCompletion: ((error: unknown) => void) | null = null;
    let interruption: Promise<void> | null = null;
    const completion = new Promise<TurnCompletedNotification>((resolve, reject) => {
      settleCompletion = resolve;
      rejectCompletion = reject;
    });
    // Startup can fail after cancellation without ever awaiting the turn result.
    void completion.catch(() => {});

    const collectItem = (item: CodexThreadItem): void => {
      if (item.type === 'agentMessage') output = item.text;
    };
    const handleNotification = (notification: JsonRpcNotification): void => {
      if (notification.method === 'item/completed') {
        const params = notification.params as ItemCompletedNotification;
        if (params.threadId !== threadId || (turnId && params.turnId !== turnId)) return;
        collectItem(params.item);
        return;
      }
      if (notification.method !== 'turn/completed') return;
      const params = notification.params as TurnCompletedNotification;
      if (params.threadId !== threadId || (turnId && params.turn.id !== turnId)) return;
      for (const item of params.turn.items) collectItem(item);
      settleCompletion?.(params);
    };
    const handleServerRequest = (request: JsonRpcServerRequest): void => {
      const params = request.params && typeof request.params === 'object'
        ? request.params as Record<string, unknown>
        : {};
      if (params.threadId !== threadId && params.conversationId !== threadId) return;
      if (isApprovalRequest(request)) {
        client.respond(request.id, denialResponseForRequest(request.method));
      } else {
        client.reject(request.id, -32601, `Unsupported Codex app-server request: ${request.method}`);
      }
    };
    const handleExit = (code: number): void => {
      rejectCompletion?.(new Error(`Codex app-server exited with code ${code}`));
    };
    const interruptStartedTurn = (): Promise<void> | null => {
      if (!threadId || !turnId || entry.exited) return null;
      interruption ??= client.interruptTurn(threadId, turnId).then(
        () => undefined,
        () => undefined,
      );
      return interruption;
    };
    const handleAbort = (): void => {
      rejectCompletion?.(signal.reason);
      if (turnId) {
        void interruptStartedTurn();
      } else {
        // Startup RPCs have no cancellation handle or usable turn identity. Retiring
        // the shared transport prevents a late response from starting orphaned work.
        this.#retireClient(entry, true);
      }
    };

    client.on('notification', handleNotification);
    client.on('serverRequest', handleServerRequest);
    client.on('exit', handleExit);
    signal.addEventListener('abort', handleAbort, { once: true });

    try {
      signal.throwIfAborted();
      const thread = await client.startThread({
        ephemeral: true,
        cwd: workingDirectory,
        sandbox: 'read-only',
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
        ...(options.model ? { model: options.model } : {}),
        ...(options.codexConfig?.config ? { config: options.codexConfig.config } : {}),
      });
      threadId = thread.thread.id;
      signal.throwIfAborted();

      const effort = mapThinkingModeToCodexEffort(options.thinkingMode, options.model);
      const turn = await client.startTurn({
        threadId,
        input: [{ type: 'text', text: prompt, text_elements: [] }],
        cwd: workingDirectory,
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
        ...(options.model ? { model: options.model } : {}),
        ...(effort ? { effort } : {}),
      });
      turnId = turn.turn.id;
      if (signal.aborted) await interruptStartedTurn();
      signal.throwIfAborted();

      const terminal = await completion;
      signal.throwIfAborted();
      if (terminal.turn.status === 'failed') {
        throw new Error(terminal.turn.error?.message ?? 'Codex turn failed');
      }
      if (terminal.turn.status === 'interrupted') throw new Error('Codex turn was interrupted');
      return output.trim();
    } finally {
      signal.removeEventListener('abort', handleAbort);
      client.off('notification', handleNotification);
      client.off('serverRequest', handleServerRequest);
      client.off('exit', handleExit);
      if (signal.aborted) await interruptStartedTurn();
      if (threadId && !entry.retired && !entry.exited) {
        await client.unsubscribeThread(threadId).catch(() => {});
      }
      this.#releaseClient(entry);
    }
  }

  #acquireClient(environment?: Record<string, string>): ClientEntry {
    if (this.#shutdownRequested) throw new Error('Codex single-query runtime is shut down');
    const environmentKey = stableEnvironmentKey(environment);
    // Reuses process startup while each request remains an in-memory ephemeral thread.
    const existing = this.#clients.get(environmentKey);
    if (existing) {
      this.#clients.delete(environmentKey);
      this.#drainingClients.add(existing);
      if (existing.idleTimer) clearTimeout(existing.idleTimer);
      existing.idleTimer = null;
      existing.activeQueries += 1;
      existing.admittedQueries += 1;
      if (existing.admittedQueries >= this.#maxQueriesPerClient) {
        existing.acceptingQueries = false;
      }
      return existing;
    }

    const client = this.#createClient(environment ? { env: environment } : undefined);
    const entry: ClientEntry = {
      client,
      environmentKey,
      activeQueries: 1,
      admittedQueries: 1,
      acceptingQueries: this.#maxQueriesPerClient > 1,
      retired: false,
      exited: false,
      idleTimer: null,
    };
    this.#drainingClients.add(entry);
    client.once('exit', () => {
      entry.exited = true;
      entry.retired = true;
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
      if (this.#clients.get(environmentKey) === entry) this.#clients.delete(environmentKey);
      this.#drainingClients.delete(entry);
    });
    return entry;
  }

  #releaseClient(entry: ClientEntry): void {
    entry.activeQueries -= 1;
    if (entry.retired || entry.activeQueries > 0) return;
    this.#drainingClients.delete(entry);
    if (!entry.acceptingQueries) {
      this.#retireClient(entry);
      return;
    }
    const available = this.#clients.get(entry.environmentKey);
    if (available) {
      this.#retireClient(entry);
      return;
    }
    this.#clients.set(entry.environmentKey, entry);
    entry.idleTimer = setTimeout(() => this.#retireClient(entry), this.#clientIdleMs);
    (entry.idleTimer as { unref?: () => void }).unref?.();
  }

  #retireClient(entry: ClientEntry, force = false): void {
    if (entry.retired || (!force && entry.activeQueries > 0)) return;
    entry.retired = true;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
    if (this.#clients.get(entry.environmentKey) === entry) {
      this.#clients.delete(entry.environmentKey);
    }
    this.#drainingClients.delete(entry);
    if (!entry.exited) {
      const retirement = entry.client.shutdown().catch(() => {}).finally(() => {
        this.#retirementPromises.delete(retirement);
      });
      this.#retirementPromises.add(retirement);
    }
  }

  async shutdown(): Promise<void> {
    if (this.#shutdownPromise) return this.#shutdownPromise;
    this.#shutdownRequested = true;
    const entries = [...new Set([
      ...this.#clients.values(),
      ...this.#drainingClients,
    ])];
    this.#clients.clear();
    this.#drainingClients.clear();
    for (const entry of entries) {
      entry.retired = true;
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
    const shutdown = Promise.allSettled([
      ...this.#retirementPromises,
      ...entries.map(({ client }) => client.shutdown()),
    ]).then(() => undefined);
    this.#shutdownPromise = shutdown;
    await shutdown;
  }
}

function stableEnvironmentKey(environment?: Record<string, string>): string {
  const serialized = JSON.stringify(
    Object.entries(environment ?? {}).sort(([left], [right]) => left.localeCompare(right)),
  );
  return createHash('sha256').update(serialized).digest('hex');
}
