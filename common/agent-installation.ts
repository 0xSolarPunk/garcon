export const AGENT_CLI_UPDATE_TIMEOUT_MS = 90_000;

export interface AgentCliInstallationStatus {
  readonly version: string;
  readonly minimumVersion: string;
  readonly supported: boolean;
}

export interface AgentCliUpdateResult {
  readonly installation: AgentCliInstallationStatus;
  readonly output: string;
}
