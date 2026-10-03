import { expect, test } from 'bun:test';
import type { AgentInstallation } from '@garcon/server-agent-interface';
import { AGENT_CLI_UPDATE_TIMEOUT_MS } from '@garcon/common/agent-installation';
import { outgoingFault, remoteFixture } from './integration-fixture.js';
import { rpcContinuity } from '../transport/rpc-protocol.js';
import { rpcLane } from '../transport/rpc-routing.js';

for (const dialer of ['controller', 'worker'] as const) {
  test(`installation maintenance executes on the selected worker (${dialer} dials)`, async () => {
    const calls: string[] = [];
    let version = '2.1.207';
    const installation = {
      async status() { calls.push('status'); return { version, minimumVersion: '2.1.238', supported: version === '2.1.285' }; },
      async update() {
        calls.push('update');
        version = '2.1.285';
        return { installation: await this.status(), output: 'Synthetic update complete' };
      },
    } satisfies AgentInstallation;
    const fixture = await remoteFixture(dialer, (_controller, _worker, runtime) => {
      Object.assign(runtime.integration, { installation });
    });
    try {
      const integration = await fixture.executor.getAgentIntegration('test');
      expect(integration.installation).not.toBeNull();
      await expect(integration.installation!.status()).resolves.toMatchObject({ version: '2.1.207', supported: false });
      await expect(integration.installation!.update({ timeoutMs: AGENT_CLI_UPDATE_TIMEOUT_MS + 15_000 })).resolves.toMatchObject({
        installation: { version: '2.1.285', supported: true }, output: 'Synthetic update complete',
      });
      expect(calls).toEqual(['status', 'update', 'status']);
    } finally { await fixture.dispose(); }
  });

  for (const lost of ['request', 'reply'] as const) {
    test(`an update lost at its ${lost} completes once after reconnect (${dialer} dials)`, async () => {
      let updates = 0;
      let fault!: ReturnType<typeof outgoingFault>;
      const status = { version: '2.1.285', minimumVersion: '2.1.238', supported: true };
      const installation = {
        async status() { return status; },
        async update() { updates++; return { installation: status, output: 'Synthetic journaled installation result' }; },
      } satisfies AgentInstallation;
      const fixture = await remoteFixture(dialer, (controller, worker, runtime) => {
        Object.assign(runtime.integration, { installation });
        fault = outgoingFault(lost === 'request' ? controller : worker);
      });
      try {
        const integration = await fixture.executor.getAgentIntegration('test');
        fault.inject = (encoded) => {
          const matches = lost === 'request'
            ? encoded.includes('"method":"installation.update"')
            : encoded.includes('Synthetic journaled installation result');
          if (!matches) return null;
          fault.inject = () => null;
          return 'disconnect';
        };
        await expect(integration.installation!.update({ timeoutMs: 5000 })).resolves.toEqual({ installation: status, output: 'Synthetic journaled installation result' });
        expect(updates).toBe(1);
      } finally { await fixture.dispose(); }
    });
  }
}

test('installation maintenance uses journaled primary RPCs', () => {
  for (const method of ['installation.status', 'installation.update']) {
    expect(rpcContinuity(method)).toBe('journaled');
    expect(rpcLane(method, null)).toBe('primary');
  }
});
