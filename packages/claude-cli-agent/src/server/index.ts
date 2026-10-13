import { createCliAgentModule, emptyAgentInput, createCliModelSettings } from "@agents-in-the-cloud/cli-agent/server";
import { createPiModelRuntime, installSubscriptionCli, requireProviderSubscription } from "@agents-in-the-cloud/llm/server";
import { providerBrandIconHtml } from "@agents-in-the-cloud/shared";
import { claudeLaunchScript } from "./launch-command.ts";
import { prepareClaudeSession } from "./session.ts";
import { loadClaudeTranscript, loadClaudeTranscriptImage, hasClaudeSession, hasClaudeTurnSettled, claudeHistoryFiles } from "./transcript.ts";

const claudeModelSettings = createCliModelSettings({
  agentTypeId: "claude-cli", provider: "anthropic", label: "Claude Code CLI",
  mapThinkingLevel: (level, mapped) => mapped !== null && ["low", "medium", "high", "xhigh", "max"].includes(mapped ?? level) ? mapped ?? level : undefined,
});

export const agentsInTheCloudServerModule = createCliAgentModule({
  id: "claude-cli", legacyId: "claude", label: "Claude Code CLI", iconHtml: providerBrandIconHtml("anthropic"),
  requireSetup: async () => requireProviderSubscription(await createPiModelRuntime(), "anthropic", "Claude"),
  settings: claudeModelSettings,
  prepareWorkspace: async (workspaceId) => installSubscriptionCli(workspaceId, await createPiModelRuntime()),
  prepareSession: prepareClaudeSession,
  launchScript: claudeLaunchScript,
  resumeScript: async (_workspaceId, settings, session) => claudeLaunchScript(emptyAgentInput(), [], settings, session, await hasClaudeSession(session.id)),
  loadTranscript: loadClaudeTranscript,
  loadTranscriptImage: loadClaudeTranscriptImage,
  turnSettled: hasClaudeTurnSettled,
  historyFiles: claudeHistoryFiles,
});
