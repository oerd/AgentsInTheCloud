import { agentsInTheCloudSystemPrompt } from "@agents-in-the-cloud/agent/server/system-prompt";
import { prepareCliAgentConnection } from "@agents-in-the-cloud/agent/server";
import { checkedWorkspaceShell, cliLaunchScript, createCliModelSettings } from "@agents-in-the-cloud/cli-agent/server";
import { createPiModelRuntime, installCodexSubscriptionAuth, requireProviderSubscription } from "@agents-in-the-cloud/llm/server";
import { codexVersion } from "./protocol.ts";

export const agentTypeId = "codex";
export const label = "Codex";
export const settings = createCliModelSettings({ agentTypeId, provider: "openai-codex", label: "Codex", mapThinkingLevel: (level, mapped) => mapped === null ? undefined : mapped ?? (level === "off" ? "none" : level) });
export async function requireSetup() {
  await requireProviderSubscription(await createPiModelRuntime(), "openai-codex", "Codex");
}
export function codexHome(agentId: string) { return `/home/agents-in-the-cloud/.local/share/agents-in-the-cloud-agents/${agentId}/codex`; }

export async function prepareCodex(workspaceId: string, agentId: string): Promise<{ instructions: string; mcp: { url: string; token: string } }> {
  await installCodexSubscriptionAuth(workspaceId, codexHome(agentId), await createPiModelRuntime());
  const connection = await prepareCliAgentConnection(workspaceId, agentId, agentsInTheCloudSystemPrompt);
  // Codex keeps its base coding prompt, AGENTS.md discovery and native tools.
  // Only the renderer-aware application guidance and plugin instructions differ.
  // Connection overrides belong to this process, not the native settings file.
  // Codex owns config.toml so skill, plugin and app changes survive reconnects.
  await checkedWorkspaceShell(workspaceId, cliLaunchScript({ executable: "codex", label: "Codex", npmPackage: "@openai/codex", version: codexVersion, args: ["--version"] }));
  return { instructions: connection.instructions, mcp: { url: connection.url, token: connection.token } };
}
