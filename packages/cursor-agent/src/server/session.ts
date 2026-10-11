import { shellQuote } from "@agents-in-the-cloud/core";
import { checkedWorkspaceShell, writeCliSessionFiles, type CliAgentConnection, type CliAgentSession } from "@agents-in-the-cloud/cli-agent/server";

export const cursorAgentId = "cursor" as const;

export const cursorMcpServerName = "agents-in-the-cloud";

export const cursorHookMarker = "runtime.mjs hook";

export const cursorSessionDirEnv = "AGENTS_IN_THE_CLOUD_SESSION_DIR";

export const cursorMcpTokenEnv = "AGENTS_IN_THE_CLOUD_MCP_TOKEN";

export const cursorMcpAuthorization = `Bearer \${env:${cursorMcpTokenEnv}}`;

export type CursorStopStatus = "completed" | "aborted" | "error";

export const cursorStopBoundary = {
  completed: "finished",
  aborted: "failed",
  error: "failed",
} as const satisfies Record<CursorStopStatus, "finished" | "failed">;

export interface CursorOwnedHooks {
  sessionStart: string;
  beforeSubmitPrompt: string;
  stop: string;
}

export interface CursorSessionStartReply {
  additional_context: string;
}

export interface CursorPromptReply {
  continue: true;
}

/** Stop must not include followup_message. That field submits another user turn. */
export type CursorStopReply = Record<string, never>;

export type CursorAuthDecision = "logged-in" | "logged-out";

/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type -- embedded into runtime.mjs via Function#toString */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function cursorTurnBoundary(status: CursorStopStatus): "finished" | "failed" {
  return cursorStopBoundary[status];
}

export function acceptCursorChatId(contents: string): string {
  const line = contents.endsWith("\n") ? contents.slice(0, -1) : contents;
  if (line.length === 0 || line.includes("\n") || line !== line.trim()) throw new Error("Cursor chat id is empty or contains a newline");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(line)) throw new Error("Cursor chat id is not a UUID");
  return line;
}

export function cursorSessionStartReply(instructions: string): CursorSessionStartReply {
  return { additional_context: instructions };
}

export function cursorPromptReply(): CursorPromptReply {
  return { continue: true };
}

export function cursorStopReply(): CursorStopReply {
  return {};
}

export function parseCursorStopStatus(value: unknown): CursorStopStatus {
  if (!isRecord(value)) throw new Error("Cursor stop payload must be an object");
  const status = value.status;
  if (status !== "completed" && status !== "aborted" && status !== "error") throw new Error(`Unknown Cursor stop status: ${String(status)}`);
  return status;
}

export function cursorAuthDecision(value: unknown): CursorAuthDecision {
  if (!isRecord(value)) throw new Error("Cursor status schema is not the captured document");
  const status = value.status;
  if (status !== "authenticated" && status !== "partially-authenticated" && status !== "unauthenticated") {
    throw new Error("Cursor status schema is not the captured document");
  }
  if (typeof value.isAuthenticated !== "boolean" || typeof value.hasAccessToken !== "boolean" || typeof value.hasRefreshToken !== "boolean") {
    throw new Error("Cursor status schema is not the captured document");
  }
  const loggedIn = status === "authenticated" && value.isAuthenticated && value.hasAccessToken && value.hasRefreshToken;
  const partial = status === "partially-authenticated" && !value.isAuthenticated && value.hasAccessToken && !value.hasRefreshToken;
  const loggedOut = status === "unauthenticated" && !value.isAuthenticated && !value.hasAccessToken && !value.hasRefreshToken;
  if (!loggedIn && !partial && !loggedOut) throw new Error("Cursor status flags do not match the captured schema");
  return loggedIn ? "logged-in" : "logged-out";
}

function isOwnedHook(entry: unknown): boolean {
  return isRecord(entry) && typeof entry.command === "string" && entry.command.includes(cursorHookMarker);
}

function foreignHookEntry(entry: unknown, event: string): Record<string, unknown> {
  if (!isRecord(entry)) throw new Error(`Cursor hooks.json event ${event} is invalid`);
  if ("command" in entry && typeof entry.command !== "string") throw new Error(`Cursor hooks.json ${event} command is invalid`);
  return entry;
}

export function mergeCursorHooks(existing: unknown, owned: CursorOwnedHooks) {
  const base = existing === undefined ? {} : existing;
  if (!isRecord(base)) throw new Error("Cursor hooks.json is invalid");
  if ("hooks" in base && base.hooks !== undefined && !isRecord(base.hooks)) throw new Error("Cursor hooks.json is invalid");
  const sourceHooks = isRecord(base.hooks) ? base.hooks : {};
  const hooks: Record<string, unknown[]> = {};
  for (const [event, commands] of Object.entries(sourceHooks)) {
    if (!Array.isArray(commands)) throw new Error(`Cursor hooks.json event ${event} is invalid`);
    const kept = commands.filter(command => !isOwnedHook(command)).map(command => foreignHookEntry(command, event));
    if (kept.length > 0) hooks[event] = kept;
  }
  hooks.sessionStart = [...(hooks.sessionStart ?? []), { command: owned.sessionStart }];
  hooks.beforeSubmitPrompt = [...(hooks.beforeSubmitPrompt ?? []), { command: owned.beforeSubmitPrompt }];
  hooks.stop = [...(hooks.stop ?? []), { command: owned.stop }];
  const merged = { ...base, hooks };
  if (!("version" in base)) merged.version = 1;
  return merged;
}

export function mergeCursorMcp(existing: unknown, url: string) {
  const base = existing === undefined ? {} : existing;
  if (!isRecord(base)) throw new Error("Cursor mcp.json is invalid");
  if ("mcpServers" in base && !isRecord(base.mcpServers)) throw new Error("Cursor mcp.json is invalid");
  const source = isRecord(base.mcpServers) ? base.mcpServers : {};
  const mcpServers: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(source)) {
    if (name === cursorMcpServerName) continue;
    if (!isRecord(server)) throw new Error(`Cursor MCP server ${name} is invalid`);
    mcpServers[name] = server;
  }
  mcpServers[cursorMcpServerName] = { url, headers: { Authorization: cursorMcpAuthorization } };
  return { ...base, mcpServers };
}
/* oxlint-enable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type */

export function cursorSessionFiles(connection: CliAgentConnection) {
  return {
    "cursor/connection.json": JSON.stringify({ url: connection.url, token: connection.token }),
    "cursor/instructions.txt": connection.instructions,
  };
}

const runtimeDispatcher = `
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

function signalTurn(directory, boundary) {
  const result = spawnSync("sh", [directory + "/turn-signal.sh", boundary], { stdio: ["ignore", "ignore", "inherit"] });
  if (result.error) console.error(result.error.message);
}

function writeAllow(entry) {
  if (entry === "session-start") process.stdout.write(JSON.stringify(cursorSessionStartReply("")) + "\\n");
  else if (entry === "prompt") process.stdout.write(JSON.stringify(cursorPromptReply()) + "\\n");
  else if (entry === "stop") process.stdout.write(JSON.stringify(cursorStopReply()) + "\\n");
  else throw new Error("Unknown Cursor hook: " + entry);
}

async function main() {
  const [command, action, third] = process.argv.slice(2);
  if (command === "auth-status") {
    const decision = cursorAuthDecision(JSON.parse(readFileSync(0, "utf8")));
    process.exit(decision === "logged-in" ? 0 : 10);
  }
  if (command === "accept-chat-id") {
    process.stdout.write(acceptCursorChatId(readFileSync(0, "utf8")) + "\\n");
    return;
  }
  if (command === "merge-hooks") {
    const raw = readFileSync(0, "utf8");
    const existing = raw.trim() === "" ? undefined : JSON.parse(raw);
    const merged = mergeCursorHooks(existing, { sessionStart: action, beforeSubmitPrompt: third, stop: process.argv[5] });
    process.stdout.write(JSON.stringify(merged) + "\\n");
    return;
  }
  if (command === "merge-mcp") {
    const raw = readFileSync(0, "utf8");
    const existing = raw.trim() === "" ? undefined : JSON.parse(raw);
    const merged = mergeCursorMcp(existing, action);
    process.stdout.write(JSON.stringify(merged) + "\\n");
    return;
  }
  if (command === "hook") {
    const text = readFileSync(0, "utf8");
    const directory = process.env[cursorSessionDirEnv];
    if (!directory) {
      writeAllow(action);
      return;
    }
    if (action === "session-start") {
      process.stdout.write(JSON.stringify(cursorSessionStartReply(readFileSync(directory + "/cursor/instructions.txt", "utf8"))) + "\\n");
      return;
    }
    if (action === "prompt") {
      // Exit 2 would deny the prompt, so a missed turn signal still prints allow JSON.
      signalTurn(directory, "started");
      process.stdout.write(JSON.stringify(cursorPromptReply()) + "\\n");
      return;
    }
    if (action === "stop") {
      signalTurn(directory, cursorTurnBoundary(parseCursorStopStatus(JSON.parse(text))));
      process.stdout.write(JSON.stringify(cursorStopReply()) + "\\n");
      return;
    }
    throw new Error("Unknown Cursor hook: " + action);
  }
  throw new Error("Unknown Cursor runtime command: " + command);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
`;

export function cursorRuntimeScript(): string {
  const functions = [isRecord, cursorTurnBoundary, cursorSessionStartReply, cursorPromptReply, cursorStopReply, parseCursorStopStatus, acceptCursorChatId, cursorAuthDecision, isOwnedHook, foreignHookEntry, mergeCursorHooks, mergeCursorMcp];
  return [
    `const cursorStopBoundary = ${JSON.stringify(cursorStopBoundary)};`,
    `const cursorHookMarker = ${JSON.stringify(cursorHookMarker)};`,
    `const cursorMcpServerName = ${JSON.stringify(cursorMcpServerName)};`,
    `const cursorMcpAuthorization = ${JSON.stringify(cursorMcpAuthorization)};`,
    `const cursorSessionDirEnv = ${JSON.stringify(cursorSessionDirEnv)};`,
    functions.map(fn => fn.toString()).join("\n"),
    runtimeDispatcher,
  ].join("\n");
}

export function cursorSharedHomeScript(url: string): string {
  const mcpUrl = shellQuote(url);
  return `set -eu
umask 077
mkdir -p "$HOME/.cursor/agents-in-the-cloud"
(
  flock 9
  runtime="$HOME/.cursor/agents-in-the-cloud/runtime.mjs"
  cat > "$runtime.next"
  mv "$runtime.next" "$runtime"
  chmod 700 "$runtime"
  hooks="$HOME/.cursor/hooks.json"
  hooks_tmp="$HOME/.cursor/hooks.json.agents-in-the-cloud"
  if [ -f "$hooks" ]; then
    node "$runtime" merge-hooks "node $runtime hook session-start" "node $runtime hook prompt" "node $runtime hook stop" < "$hooks" > "$hooks_tmp"
  else
    node "$runtime" merge-hooks "node $runtime hook session-start" "node $runtime hook prompt" "node $runtime hook stop" < /dev/null > "$hooks_tmp"
  fi
  mv "$hooks_tmp" "$hooks"
  chmod 600 "$hooks"
  mcp="$HOME/.cursor/mcp.json"
  mcp_tmp="$HOME/.cursor/mcp.json.agents-in-the-cloud"
  if [ -f "$mcp" ]; then
    node "$runtime" merge-mcp ${mcpUrl} < "$mcp" > "$mcp_tmp"
  else
    node "$runtime" merge-mcp ${mcpUrl} < /dev/null > "$mcp_tmp"
  fi
  mv "$mcp_tmp" "$mcp"
  chmod 600 "$mcp"
) 9>"$HOME/.cursor/agents-in-the-cloud.lock"
`;
}

export async function prepareCursorSession(workspaceId: string, session: CliAgentSession, connection: CliAgentConnection): Promise<Record<string, string>> {
  await writeCliSessionFiles(workspaceId, session, cursorSessionFiles(connection));
  await checkedWorkspaceShell(workspaceId, cursorSharedHomeScript(connection.url), cursorRuntimeScript());
  return {
    [cursorSessionDirEnv]: session.directory,
    [cursorMcpTokenEnv]: connection.token,
  };
}
