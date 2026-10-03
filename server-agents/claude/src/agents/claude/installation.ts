import { execFile } from 'node:child_process';
import { promisify, stripVTControlCharacters } from 'node:util';
import {
  AgentIntegrationError,
  type AgentInstallation,
  type ExecutorCallOptions,
} from '@garcon/server-agent-interface';
import {
  AGENT_CLI_UPDATE_TIMEOUT_MS,
  type AgentCliInstallationStatus,
  type AgentCliUpdateResult,
} from '@garcon/common/agent-installation';
import type { ClaudeConfig } from '../../config.js';
import { buildClaudeHostEnvironment } from './endpoint-runtime.js';
import {
  ClaudeCliVersionProbe,
  isVersionBefore,
  MINIMUM_CLAUDE_CLI_VERSION,
} from './cli-version.js';

const runFile = promisify(execFile);
const MAX_UPDATE_OUTPUT_BYTES = 16 * 1024;

export class ClaudeInstallation implements AgentInstallation {
  #update: Promise<AgentCliUpdateResult> | null = null;

  constructor(
    private readonly config: ClaudeConfig,
    private readonly versionProbe: ClaudeCliVersionProbe,
    private readonly updateTimeoutMs = AGENT_CLI_UPDATE_TIMEOUT_MS,
  ) {}

  async status(options?: ExecutorCallOptions): Promise<AgentCliInstallationStatus> {
    options?.signal?.throwIfAborted();
    try {
      const version = await this.versionProbe.refresh(this.config.binary());
      options?.signal?.throwIfAborted();
      return {
        version: version.join('.'),
        minimumVersion: MINIMUM_CLAUDE_CLI_VERSION.join('.'),
        supported: !isVersionBefore(version, MINIMUM_CLAUDE_CLI_VERSION),
      };
    } catch (error) {
      throw installationError(error);
    }
  }

  update(options?: ExecutorCallOptions): Promise<AgentCliUpdateResult> {
    options?.signal?.throwIfAborted();
    if (!this.#update) {
      this.#update = this.#runUpdate(options).finally(() => { this.#update = null; });
    }
    return this.#update;
  }

  async #runUpdate(options?: ExecutorCallOptions): Promise<AgentCliUpdateResult> {
    const binary = this.config.binary();
    const environment: NodeJS.ProcessEnv = { ...process.env, ...buildClaudeHostEnvironment(this.config), NO_COLOR: '1' };
    delete environment.CLAUDECODE;
    try {
      const { stdout, stderr } = await runFile(binary, ['update'], {
        env: environment,
        timeout: this.updateTimeoutMs,
        maxBuffer: MAX_UPDATE_OUTPUT_BYTES,
        killSignal: 'SIGKILL',
        signal: options?.signal,
      });
      this.versionProbe.invalidate(binary);
      return {
        installation: await this.status(options),
        output: [stdout, stderr].map((output) => stripVTControlCharacters(output).trim()).filter(Boolean).join('\n'),
      };
    } catch (error) {
      throw installationError(error);
    } finally {
      // Failed updates may also replace the launcher; future admissions must probe again.
      this.versionProbe.invalidate(binary);
    }
  }
}

function installationError(error: unknown): AgentIntegrationError {
  if (error instanceof AgentIntegrationError) return error;
  const failure = error as { code?: unknown; killed?: unknown; stderr?: unknown; message?: unknown };
  if (failure?.code === 'ENOENT') {
    return new AgentIntegrationError('BINARY_NOT_FOUND', 'Claude Code is not installed or its configured executable is unavailable.', false);
  }
  if (failure?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    return new AgentIntegrationError('PROVIDER_FAILURE', 'Claude Code update output exceeded its size limit. Refresh the installed version before trying again.', true);
  }
  if (failure?.killed) {
    return new AgentIntegrationError('TIMEOUT', 'Claude Code update timed out. Refresh the installed version before trying again.', true);
  }
  const detail = typeof failure?.stderr === 'string' && failure.stderr.trim()
    ? failure.stderr.trim()
    : error instanceof Error ? error.message : String(error);
  return new AgentIntegrationError('PROVIDER_FAILURE', `Claude Code installation check or update failed: ${stripVTControlCharacters(detail)}`, true);
}
