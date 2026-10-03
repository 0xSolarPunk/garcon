import { apiGet, apiPost } from './client.js';
import { effectiveExecutorId } from '$shared/executors';
import {
	AGENT_CLI_UPDATE_TIMEOUT_MS,
	type AgentCliInstallationStatus,
	type AgentCliUpdateResult,
} from '$shared/agent-installation';

export function getAgentInstallationStatus(agentId: string, executorId: string): Promise<AgentCliInstallationStatus> {
	return apiGet<AgentCliInstallationStatus>(
		`/api/v1/agents/installation?agent=${encodeURIComponent(agentId)}&executorId=${encodeURIComponent(effectiveExecutorId(executorId))}`,
	);
}

export function updateAgentInstallation(agentId: string, executorId: string): Promise<AgentCliUpdateResult> {
	return apiPost<AgentCliUpdateResult>('/api/v1/agents/installation/update', {
		agentId,
		executorId: effectiveExecutorId(executorId),
	}, { timeoutMs: AGENT_CLI_UPDATE_TIMEOUT_MS + 30_000 });
}
