import { EventEmitter } from 'events';
import { describe, expect, it, mock } from 'bun:test';
import { createIntegrationLifecycle } from '@garcon/server-agent-common/lifecycle/integration-lifecycle';
import { resolveCodexCli, resolveCodexCliCommand } from '../cli.js';
import { CodexAppServerClient } from '../client.js';
import { CodexSingleQueryRuntime } from '../run-single-query.js';

function deferred() {
  let resolve;
  const promise = new Promise((settle) => { resolve = settle; });
  return { promise, resolve };
}

class FakeClient extends EventEmitter {
  startThread = mock(async () => ({ thread: { id: `thread-${this.startThread.mock.calls.length}` } }));
  startTurn = mock(async ({ threadId }) => ({ turn: { id: `turn-${threadId}` } }));
  interruptTurn = mock(async () => ({}));
  unsubscribeThread = mock(async () => ({ status: 'unsubscribed' }));
  shutdown = mock(async () => {});
  respond = mock(() => {});
  reject = mock(() => {});

  complete(threadId, text) {
    const turnId = `turn-${threadId}`;
    const item = {
      type: 'agentMessage',
      id: `message-${threadId}`,
      text,
      phase: null,
      memoryCitation: null,
    };
    this.emit('notification', {
      method: 'item/completed',
      params: { threadId, turnId, item },
    });
    this.emit('notification', {
      method: 'turn/completed',
      params: {
        threadId,
        turn: { id: turnId, items: [item], status: 'completed', error: null },
      },
    });
  }
}

describe('Codex single-query runtime', () => {
  it('uses isolated read-only ephemeral threads and returns only the final agent output', async () => {
    const client = new FakeClient();
    const runtime = new CodexSingleQueryRuntime({ createClient: () => client });

    const result = runtime.run('  improve this  ', {
      projectPath: '/workspace',
      model: 'gpt-5.6',
      thinkingMode: 'max',
      permissionMode: 'bypassPermissions',
      codexConfig: { config: { model_provider: 'custom' } },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(client.startThread).toHaveBeenCalledWith({
      ephemeral: true,
      cwd: '/workspace',
      sandbox: 'read-only',
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      model: 'gpt-5.6',
      config: { model_provider: 'custom' },
    });
    expect(client.startTurn).toHaveBeenCalledWith({
      threadId: 'thread-1',
      input: [{ type: 'text', text: '  improve this  ', text_elements: [] }],
      cwd: '/workspace',
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      model: 'gpt-5.6',
      effort: 'max',
    });

    client.complete('thread-1', '  Refined output.  ');
    await expect(result).resolves.toBe('Refined output.');
    expect(client.unsubscribeThread).toHaveBeenCalledWith('thread-1');
  });

  it('isolates concurrent query events on separate clients', async () => {
    const clients = [];
    const createClient = mock(() => {
      const client = new FakeClient();
      clients.push(client);
      return client;
    });
    const runtime = new CodexSingleQueryRuntime({ createClient });

    const first = runtime.run('first');
    const second = runtime.run('second');
    await Promise.resolve();
    await Promise.resolve();
    clients[1].complete('thread-1', 'second output');
    clients[0].complete('thread-1', 'first output');

    await expect(Promise.all([first, second])).resolves.toEqual(['first output', 'second output']);
    expect(createClient).toHaveBeenCalledTimes(2);
    expect(clients.every((client) => client.unsubscribeThread.mock.calls.length === 1)).toBe(true);
  });

  it('uses separate persistent clients for distinct endpoint environments', async () => {
    const clients = [];
    const createClient = mock(() => {
      const client = new FakeClient();
      clients.push(client);
      return client;
    });
    const runtime = new CodexSingleQueryRuntime({ createClient });

    const first = runtime.run('first', { codexConfig: { env: { API_KEY: 'one' } } });
    const second = runtime.run('second', { codexConfig: { env: { API_KEY: 'two' } } });
    await Promise.resolve();
    await Promise.resolve();
    clients[0].complete('thread-1', 'first');
    clients[1].complete('thread-1', 'second');

    await Promise.all([first, second]);
    expect(createClient.mock.calls.map(([options]) => options)).toEqual([
      { env: { API_KEY: 'one' } },
      { env: { API_KEY: 'two' } },
    ]);
  });

  it('interrupts an aborted query and retires its exclusive client', async () => {
    const client = new FakeClient();
    const turnStarted = deferred();
    client.startTurn = mock(async (params) => {
      turnStarted.resolve();
      return { turn: { id: `turn-${params.threadId}` } };
    });
    const runtime = new CodexSingleQueryRuntime({ createClient: () => client });
    const controller = new AbortController();

    const query = runtime.run('cancel me', { signal: controller.signal });
    await turnStarted.promise;
    await Promise.resolve();
    controller.abort(new Error('cancelled'));

    await expect(query).rejects.toThrow('cancelled');
    await Promise.resolve();
    expect(client.interruptTurn).toHaveBeenCalledWith('thread-1', 'turn-thread-1');
    expect(client.shutdown).toHaveBeenCalledTimes(1);
    expect(client.unsubscribeThread).not.toHaveBeenCalled();
  });

  it('does not strand an exclusive client when abort cleanup never resolves', async () => {
    const clients = [];
    const runtime = new CodexSingleQueryRuntime({
      createClient: () => {
        const client = new FakeClient();
        if (clients.length === 0) {
          client.interruptTurn = mock(() => new Promise(() => {}));
        }
        clients.push(client);
        return client;
      },
    });
    const controller = new AbortController();

    const aborted = runtime.run('cancel me', { signal: controller.signal });
    while (clients[0]?.startTurn.mock.calls.length === 0) await Promise.resolve();
    controller.abort(new Error('cancelled'));
    await expect(aborted).rejects.toThrow('cancelled');

    const next = runtime.run('continue');
    while (clients[1]?.startTurn.mock.calls.length === 0) await Promise.resolve();
    clients[1].complete('thread-1', 'continued');

    await expect(next).resolves.toBe('continued');
    expect(clients[0].interruptTurn).toHaveBeenCalledTimes(1);
    expect(clients[0].shutdown).toHaveBeenCalledTimes(1);
  });

  it('does not strand a client when thread cleanup never resolves', async () => {
    const client = new FakeClient();
    client.unsubscribeThread = mock(() => new Promise(() => {}));
    const runtime = new CodexSingleQueryRuntime({ createClient: () => client });

    const first = runtime.run('first');
    await Promise.resolve();
    await Promise.resolve();
    client.complete('thread-1', 'first');
    await expect(first).resolves.toBe('first');

    const second = runtime.run('second');
    await Promise.resolve();
    await Promise.resolve();
    client.complete('thread-2', 'second');

    await expect(second).resolves.toBe('second');
    expect(client.unsubscribeThread).toHaveBeenCalledTimes(2);
  });

  it('interrupts a turn whose start response arrives after cancellation', async () => {
    const client = new FakeClient();
    const turnResponse = deferred();
    client.startTurn = mock(() => turnResponse.promise);
    const runtime = new CodexSingleQueryRuntime({ createClient: () => client });
    const controller = new AbortController();

    const query = runtime.run('cancel while starting', { signal: controller.signal });
    while (client.startTurn.mock.calls.length === 0) await Promise.resolve();
    controller.abort(new Error('cancelled while starting'));
    await expect(query).rejects.toThrow('cancelled while starting');
    turnResponse.resolve({ turn: { id: 'late-turn' } });
    while (client.interruptTurn.mock.calls.length === 0) await Promise.resolve();

    expect(client.interruptTurn).toHaveBeenCalledWith('thread-1', 'late-turn');
    expect(client.shutdown).toHaveBeenCalledTimes(1);
    expect(client.unsubscribeThread).not.toHaveBeenCalled();
  });

  it('does not start a turn when thread creation finishes after cancellation', async () => {
    const client = new FakeClient();
    const threadResponse = deferred();
    client.startThread = mock(() => threadResponse.promise);
    const runtime = new CodexSingleQueryRuntime({ createClient: () => client });
    const controller = new AbortController();

    const query = runtime.run('cancel before thread', { signal: controller.signal });
    while (client.startThread.mock.calls.length === 0) await Promise.resolve();
    controller.abort(new Error('cancelled before thread'));
    await expect(query).rejects.toThrow('cancelled before thread');
    threadResponse.resolve({ thread: { id: 'late-thread' } });
    await Promise.resolve();
    await Promise.resolve();

    expect(client.startTurn).not.toHaveBeenCalled();
    expect(client.shutdown).toHaveBeenCalledTimes(1);
    expect(client.unsubscribeThread).not.toHaveBeenCalled();
  });

  it('does not terminate another query when cancellation retires a starting client', async () => {
    const clients = [];
    const firstTurn = deferred();
    const runtime = new CodexSingleQueryRuntime({
      createClient: () => {
        const client = new FakeClient();
        if (clients.length === 0) client.startTurn = mock(() => firstTurn.promise);
        clients.push(client);
        return client;
      },
    });
    const controller = new AbortController();

    const first = runtime.run('cancel me', { signal: controller.signal });
    while (clients[0]?.startTurn.mock.calls.length === 0) await Promise.resolve();
    const second = runtime.run('keep running');
    while (clients.length < 2 || clients[1].startTurn.mock.calls.length === 0) await Promise.resolve();
    controller.abort(new Error('cancelled'));
    await expect(first).rejects.toThrow('cancelled');
    clients[1].complete('thread-1', 'still running');

    await expect(second).resolves.toBe('still running');
    expect(clients[0].shutdown).toHaveBeenCalledTimes(1);
    expect(clients[1].shutdown).not.toHaveBeenCalled();
    firstTurn.resolve({ turn: { id: 'late-turn' } });
    await Promise.resolve();
    await Promise.resolve();
  });

  it('does not reconnect to unsubscribe after an app-server exit', async () => {
    const client = new FakeClient();
    const runtime = new CodexSingleQueryRuntime({ createClient: () => client });
    const query = runtime.run('exit');
    while (client.startTurn.mock.calls.length === 0) await Promise.resolve();

    client.emit('exit', 1);

    await expect(query).rejects.toThrow('Codex app-server exited with code 1');
    expect(client.unsubscribeThread).not.toHaveBeenCalled();
  });

  it('does not reconnect during integration shutdown cleanup', async () => {
    const client = new FakeClient();
    client.shutdown = mock(async () => { client.emit('exit', 0); });
    const runtime = new CodexSingleQueryRuntime({ createClient: () => client });
    const query = runtime.run('shutdown');
    while (client.startTurn.mock.calls.length === 0) await Promise.resolve();

    await runtime.shutdown();

    await expect(query).rejects.toThrow('Codex app-server exited with code 0');
    expect(client.unsubscribeThread).not.toHaveBeenCalled();
    await expect(runtime.run('too late')).rejects.toThrow('Codex single-query runtime is shut down');
  });

  it('recycles a warm client after a bounded number of queries', async () => {
    const clients = [];
    const createClient = mock(() => {
      const client = new FakeClient();
      clients.push(client);
      return client;
    });
    const runtime = new CodexSingleQueryRuntime({
      createClient,
      maxQueriesPerClient: 2,
    });

    const first = runtime.run('first');
    await Promise.resolve();
    await Promise.resolve();
    clients[0].complete('thread-1', 'first');
    await first;

    const second = runtime.run('second');
    await Promise.resolve();
    await Promise.resolve();
    clients[0].complete('thread-2', 'second');
    await second;

    expect(createClient).toHaveBeenCalledTimes(1);
    expect(clients[0].shutdown).toHaveBeenCalledTimes(1);

    const third = runtime.run('third');
    await Promise.resolve();
    await Promise.resolve();
    clients[1].complete('thread-1', 'third');
    await expect(third).resolves.toBe('third');
    expect(createClient).toHaveBeenCalledTimes(2);
  });

  it('awaits an in-progress recycling shutdown during runtime shutdown', async () => {
    const client = new FakeClient();
    const retired = deferred();
    client.shutdown = mock(() => retired.promise);
    const runtime = new CodexSingleQueryRuntime({
      createClient: () => client,
      maxQueriesPerClient: 1,
    });
    const query = runtime.run('one');
    await Promise.resolve();
    await Promise.resolve();
    client.complete('thread-1', 'one');
    await query;

    let shutdownFinished = false;
    const shutdown = runtime.shutdown().then(() => { shutdownFinished = true; });
    await Promise.resolve();
    expect(shutdownFinished).toBe(false);
    retired.resolve();
    await shutdown;
    expect(shutdownFinished).toBe(true);
  });

  it('shuts down an active client that has exhausted its admission budget', async () => {
    const client = new FakeClient();
    client.shutdown = mock(async () => { client.emit('exit', 0); });
    const runtime = new CodexSingleQueryRuntime({
      createClient: () => client,
      maxQueriesPerClient: 1,
    });
    const query = runtime.run('active');
    while (client.startTurn.mock.calls.length === 0) await Promise.resolve();

    await runtime.shutdown();

    await expect(query).rejects.toThrow('Codex app-server exited with code 0');
    expect(client.shutdown).toHaveBeenCalledTimes(1);
  });

  it('shuts down every cached app-server client', async () => {
    const clients = [];
    const runtime = new CodexSingleQueryRuntime({
      createClient: () => {
        const client = new FakeClient();
        clients.push(client);
        return client;
      },
    });
    const first = runtime.run('first', { envOverrides: { PROFILE: 'one' } });
    const second = runtime.run('second', { envOverrides: { PROFILE: 'two' } });
    await Promise.resolve();
    await Promise.resolve();
    clients[0].complete('thread-1', 'first');
    clients[1].complete('thread-1', 'second');
    await Promise.all([first, second]);

    await runtime.shutdown();
    expect(clients.every((client) => client.shutdown.mock.calls.length === 1)).toBe(true);
  });

  it('restarts with a fresh client after shutdown', async () => {
    const clients = [];
    const runtime = new CodexSingleQueryRuntime({
      createClient: () => {
        const client = new FakeClient();
        clients.push(client);
        return client;
      },
    });
    const lifecycle = createIntegrationLifecycle({
      start: () => runtime.start(),
      stop: () => runtime.shutdown(),
    });

    await lifecycle.start();
    const first = runtime.run('first');
    await Promise.resolve();
    await Promise.resolve();
    clients[0].complete('thread-1', 'first');
    await first;
    await lifecycle.stop();

    await lifecycle.start();
    const second = runtime.run('second');
    await Promise.resolve();
    await Promise.resolve();
    clients[1].complete('thread-1', 'second');

    await expect(second).resolves.toBe('second');
    expect(clients).toHaveLength(2);
  });

  it('restarts after a failed lifecycle start rolls back', async () => {
    const clients = [];
    const runtime = new CodexSingleQueryRuntime({
      createClient: () => {
        const client = new FakeClient();
        clients.push(client);
        return client;
      },
    });
    let failStart = true;
    const lifecycle = createIntegrationLifecycle({
      async start() {
        runtime.start();
        if (failStart) {
          failStart = false;
          throw new Error('startup failed');
        }
      },
      stop: () => runtime.shutdown(),
    });

    await expect(lifecycle.start()).rejects.toThrow('startup failed');
    await lifecycle.start();
    const query = runtime.run('retry');
    await Promise.resolve();
    await Promise.resolve();
    clients[0].complete('thread-1', 'retried');

    await expect(query).resolves.toBe('retried');
  });
});

describe('Codex CLI resolution', () => {
  it('does not spawn or reconnect when shutdown wins pending CLI resolution', async () => {
    const cli = deferred();
    const spawn = mock(() => { throw new Error('must not spawn'); });
    const client = new CodexAppServerClient({ spawn, resolveCli: () => cli.promise });

    const connection = client.connect();
    const connectionFailure = connection.catch((error) => error);
    const shutdown = client.shutdown();
    cli.resolve({ command: '/tmp/codex', source: 'bundled' });

    const [error] = await Promise.all([connectionFailure, shutdown]);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('Codex app-server client is shut down');
    expect(spawn).not.toHaveBeenCalled();
    await expect(client.connect()).rejects.toThrow('Codex app-server client is shut down');
  });

  it('honors an explicit codex CLI override', async () => {
    const original = process.env.GARCON_CODEX_CLI;
    process.env.GARCON_CODEX_CLI = '/custom/codex';
    try {
      expect(await resolveCodexCliCommand()).toBe('/custom/codex');
    } finally {
      if (original === undefined) delete process.env.GARCON_CODEX_CLI;
      else process.env.GARCON_CODEX_CLI = original;
    }
  });

  it('prefers the bundled codex CLI before PATH fallback', async () => {
    await expect(resolveCodexCli({
      env: {},
      bundledCommand: '/repo/server/node_modules/.bin/codex',
      isExecutable: async () => true,
    })).resolves.toEqual({
      command: '/repo/server/node_modules/.bin/codex',
      source: 'bundled',
    });

    await expect(resolveCodexCli({
      env: {},
      bundledCommand: '/repo/server/node_modules/.bin/codex',
      isExecutable: async () => false,
    })).resolves.toEqual({
      command: 'codex',
      source: 'path',
    });
  });
});
