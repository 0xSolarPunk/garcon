import type { CodexAppServerClient } from './client.js';
import { cleanupMaterializedGoalDraft, cleanupOwnedGoalAttachments, type MaterializedGoalDraft } from './goal-files.js';
import type { CodexThreadGoal, ThreadGoalSetResponse } from './protocol.js';

export async function recoverGoalDraftAfterError(
  client: CodexAppServerClient,
  codexHome: string | null,
  threadId: string,
  draft: MaterializedGoalDraft,
  previousObjective: string | null,
  deliveryError: unknown,
): Promise<ThreadGoalSetResponse> {
  let goal: CodexThreadGoal | null;
  try {
    goal = (await client.getThreadGoal(threadId)).goal;
  } catch {
    throw deliveryError;
  }
  if (goal?.objective === draft.objective) return { goal };
  if (goal?.objective === previousObjective) await cleanupMaterializedGoalDraft(draft.outputDir);
  else await cleanupOwnedGoalAttachments(codexHome, threadId, null);
  throw deliveryError;
}
