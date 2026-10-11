import { readTextIfExists, shellQuote, getAgentsInTheCloudRuntimeContext } from "@agents-in-the-cloud/core";
import { checkedWorkspaceShell, writeCliSessionFiles, type CliAgentConnection, type CliAgentSession } from "@agents-in-the-cloud/cli-agent/server";
import { join } from "node:path";

export const cursorAgentId = "cursor" as const;

export const cursorMcpUrl = "http://127.0.0.1:2988/mcp" as const;

export const cursorMcpServerName = "agents-in-the-cloud";

export const cursorHookMarker = "runtime.mjs hook";

export type CursorStopStatus = "completed" | "aborted" | "error";

export const cursorStopBoundary = {
  completed: "finished",
  aborted: "failed",
  error: "failed",
} as const satisfies Record<CursorStopStatus, "finished" | "failed">;

export type CursorPaneIdentity =
  | { kind: "ours"; sessionId: string }
  | { kind: "foreign" };

export interface CursorConnectionFile {
  url: typeof cursorMcpUrl;
  token: string;
}

export interface CursorHooksFile {
  version: 1;
  hooks: Record<string, CursorHookCommand[]>;
  disableAllHooks?: boolean;
}

export interface CursorHookCommand {
  command?: string;
  timeout?: number;
  matcher?: string;
  type?: string;
  prompt?: string;
  failClosed?: boolean;
}

export interface CursorOwnedHooks {
  sessionStart: string;
  beforeSubmitPrompt: string;
  stop: string;
}

export interface CursorMcpStdioServer {
  command: "node";
  args: readonly [runtimeScriptPath: string, "mcp"];
}

export interface CursorMcpServer {
  command?: string;
  args?: readonly string[];
  url?: string;
  type?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
}

export interface CursorMcpFile {
  mcpServers: Record<string, CursorMcpServer>;
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

export function identifyCursorPane(tmuxSessionName: string): CursorPaneIdentity {
  const prefix = `${cursorAgentId}-`;
  if (!tmuxSessionName.startsWith(prefix)) return { kind: "foreign" };
  const sessionId = tmuxSessionName.slice(prefix.length);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) return { kind: "foreign" };
  return { kind: "ours", sessionId };
}

export function cursorTurnBoundary(status: CursorStopStatus): "finished" | "failed" {
  return cursorStopBoundary[status];
}

export function parseCursorConnection(value: unknown): CursorConnectionFile {
  if (!isRecord(value)) throw new Error("Cursor connection must be an object");
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== "token" || keys[1] !== "url") throw new Error("Cursor connection has unexpected keys");
  if (value.url !== cursorMcpUrl) throw new Error("Cursor connection URL is not the workspace MCP relay");
  if (typeof value.token !== "string" || value.token.length === 0 || value.token.includes("\n")) throw new Error("Cursor connection token is invalid");
  return { url: cursorMcpUrl, token: value.token };
}

export function acceptCursorChatId(contents: string): string {
  const line = contents.endsWith("\n") ? contents.slice(0, -1) : contents;
  if (line.length === 0 || line.includes("\n") || line !== line.trim()) throw new Error("Cursor chat id is empty or contains a newline");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(line)) throw new Error("Cursor chat id is not a UUID");
  return line;
}

export function parseCursorChatId(contents: string | undefined): string | undefined {
  if (contents === undefined) return undefined;
  return acceptCursorChatId(contents);
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

function knownAuthKey(key: string): boolean {
  return key === "status" || key === "isAuthenticated" || key === "hasAccessToken" || key === "hasRefreshToken" || key === "message" || key === "userInfo";
}

function knownUserInfoKey(key: string): boolean {
  return key === "email" || key === "userId" || key === "firstName" || key === "lastName" || key === "teamId" || key === "teamName" || key === "createdAt";
}

export function cursorAuthDecision(value: unknown): CursorAuthDecision {
  if (!isRecord(value)) throw new Error("Cursor status schema is not the captured document");
  for (const key of Object.keys(value)) {
    if (!knownAuthKey(key)) throw new Error(`Cursor status field is not in the captured schema: ${key}`);
  }
  const status = value.status;
  if (status !== "authenticated" && status !== "partially-authenticated" && status !== "unauthenticated") {
    throw new Error("Cursor status schema is not the captured document");
  }
  if (typeof value.isAuthenticated !== "boolean" || typeof value.hasAccessToken !== "boolean" || typeof value.hasRefreshToken !== "boolean") {
    throw new Error("Cursor status schema is not the captured document");
  }
  if ("message" in value && typeof value.message !== "string") throw new Error("Cursor status message is not a string");
  if (status !== "authenticated" && typeof value.message !== "string") throw new Error("Cursor status message is missing");
  if ("userInfo" in value) {
    if (!isRecord(value.userInfo)) throw new Error("Cursor status userInfo is invalid");
    for (const [key, entry] of Object.entries(value.userInfo)) {
      if (!knownUserInfoKey(key)) throw new Error(`Cursor status userInfo field is not in the captured schema: ${key}`);
      if (typeof entry !== "string" && typeof entry !== "number") throw new Error(`Cursor status userInfo field is not a string or number: ${key}`);
    }
  }
  const loggedIn = status === "authenticated" && value.isAuthenticated && value.hasAccessToken && value.hasRefreshToken;
  const partial = status === "partially-authenticated" && !value.isAuthenticated && value.hasAccessToken && !value.hasRefreshToken;
  const loggedOut = status === "unauthenticated" && !value.isAuthenticated && !value.hasAccessToken && !value.hasRefreshToken;
  if (!loggedIn && !partial && !loggedOut) throw new Error("Cursor status flags do not match the captured schema");
  return loggedIn ? "logged-in" : "logged-out";
}

function knownHookField(key: string): boolean {
  return key === "command" || key === "timeout" || key === "matcher" || key === "type" || key === "prompt" || key === "failClosed";
}

function hookCommand(value: Record<string, unknown>, event: string): CursorHookCommand {
  for (const key of Object.keys(value)) {
    if (!knownHookField(key)) throw new Error(`Cursor hooks.json ${event} field is not in the captured schema: ${key}`);
  }
  const command: CursorHookCommand = {};
  if ("command" in value) {
    if (typeof value.command !== "string") throw new Error(`Cursor hooks.json ${event} command is invalid`);
    command.command = value.command;
  }
  if ("timeout" in value) {
    if (typeof value.timeout !== "number") throw new Error(`Cursor hooks.json ${event} timeout is invalid`);
    command.timeout = value.timeout;
  }
  if ("matcher" in value) {
    if (typeof value.matcher !== "string") throw new Error(`Cursor hooks.json ${event} matcher is invalid`);
    command.matcher = value.matcher;
  }
  if ("type" in value) {
    if (typeof value.type !== "string") throw new Error(`Cursor hooks.json ${event} type is invalid`);
    command.type = value.type;
  }
  if ("prompt" in value) {
    if (typeof value.prompt !== "string") throw new Error(`Cursor hooks.json ${event} prompt is invalid`);
    command.prompt = value.prompt;
  }
  if ("failClosed" in value) {
    if (typeof value.failClosed !== "boolean") throw new Error(`Cursor hooks.json ${event} failClosed is invalid`);
    command.failClosed = value.failClosed;
  }
  return command;
}

export function parseCursorHooksFile(raw: string | undefined): CursorHooksFile | undefined {
  if (raw === undefined) return undefined;
  const value: unknown = JSON.parse(raw);
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.hooks)) throw new Error("Cursor hooks.json is invalid");
  for (const key of Object.keys(value)) {
    if (key !== "version" && key !== "hooks" && key !== "disableAllHooks") throw new Error(`Cursor hooks.json field is not in the captured schema: ${key}`);
  }
  const hooks: Record<string, CursorHookCommand[]> = {};
  for (const [event, commands] of Object.entries(value.hooks)) {
    if (!Array.isArray(commands)) throw new Error(`Cursor hooks.json event ${event} is invalid`);
    hooks[event] = commands.map(command => {
      if (!isRecord(command)) throw new Error(`Cursor hooks.json event ${event} is invalid`);
      return hookCommand(command, event);
    });
  }
  const file: CursorHooksFile = { version: 1, hooks };
  if ("disableAllHooks" in value) {
    if (typeof value.disableAllHooks !== "boolean") throw new Error("Cursor hooks.json disableAllHooks is invalid");
    file.disableAllHooks = value.disableAllHooks;
  }
  return file;
}

function isOwnedHook(entry: unknown): boolean {
  return isRecord(entry) && typeof entry.command === "string" && entry.command.includes(cursorHookMarker);
}

export function mergeCursorHooks(existing: CursorHooksFile | undefined, owned: CursorOwnedHooks): CursorHooksFile {
  const hooks: Record<string, CursorHookCommand[]> = {};
  for (const [event, commands] of Object.entries(existing?.hooks ?? {})) {
    const kept = commands.filter(command => !isOwnedHook(command));
    if (kept.length > 0) hooks[event] = kept;
  }
  hooks.sessionStart = [...(hooks.sessionStart ?? []), { command: owned.sessionStart }];
  hooks.beforeSubmitPrompt = [...(hooks.beforeSubmitPrompt ?? []), { command: owned.beforeSubmitPrompt }];
  hooks.stop = [...(hooks.stop ?? []), { command: owned.stop }];
  return { ...(existing ?? {}), version: 1, hooks };
}

function knownMcpField(key: string): boolean {
  return key === "command" || key === "args" || key === "url" || key === "type" || key === "headers" || key === "env";
}

function stringRecord(value: Record<string, unknown>, label: string) {
  const record: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") throw new Error(`${label} ${key} is invalid`);
    record[key] = entry;
  }
  return record;
}

function mcpServer(value: Record<string, unknown>, name: string): CursorMcpServer {
  for (const key of Object.keys(value)) {
    if (!knownMcpField(key)) throw new Error(`Cursor MCP server ${name} field is not in the captured schema: ${key}`);
  }
  const server: CursorMcpServer = {};
  if ("command" in value) {
    if (typeof value.command !== "string") throw new Error(`Cursor MCP server ${name} command is invalid`);
    server.command = value.command;
  }
  if ("args" in value) {
    if (!Array.isArray(value.args) || value.args.some(arg => typeof arg !== "string")) throw new Error(`Cursor MCP server ${name} args are invalid`);
    server.args = value.args;
  }
  if ("url" in value) {
    if (typeof value.url !== "string") throw new Error(`Cursor MCP server ${name} url is invalid`);
    server.url = value.url;
  }
  if ("type" in value) {
    if (typeof value.type !== "string") throw new Error(`Cursor MCP server ${name} type is invalid`);
    server.type = value.type;
  }
  if ("headers" in value) {
    if (!isRecord(value.headers)) throw new Error(`Cursor MCP server ${name} headers are invalid`);
    server.headers = stringRecord(value.headers, `Cursor MCP server ${name} header`);
  }
  if ("env" in value) {
    if (!isRecord(value.env)) throw new Error(`Cursor MCP server ${name} env is invalid`);
    server.env = stringRecord(value.env, `Cursor MCP server ${name} env`);
  }
  return server;
}

export function parseCursorMcpFile(raw: string | undefined): CursorMcpFile | undefined {
  if (raw === undefined) return undefined;
  const value: unknown = JSON.parse(raw);
  if (!isRecord(value) || !isRecord(value.mcpServers)) throw new Error("Cursor mcp.json is invalid");
  for (const key of Object.keys(value)) {
    if (key !== "mcpServers") throw new Error(`Cursor mcp.json field is not in the captured schema: ${key}`);
  }
  const mcpServers: Record<string, CursorMcpServer> = {};
  for (const [name, server] of Object.entries(value.mcpServers)) {
    if (!isRecord(server)) throw new Error(`Cursor MCP server ${name} is invalid`);
    mcpServers[name] = mcpServer(server, name);
  }
  return { mcpServers };
}

export function mergeCursorMcp(existing: CursorMcpFile | undefined, bridge: CursorMcpStdioServer): CursorMcpFile {
  return { ...(existing ?? {}), mcpServers: { ...(existing?.mcpServers ?? {}), [cursorMcpServerName]: bridge } };
}
/* oxlint-enable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type */

export function cursorSessionFiles(connection: CliAgentConnection) {
  return {
    "cursor/connection.json": JSON.stringify({ url: cursorMcpUrl, token: connection.token }),
    "cursor/instructions.txt": connection.instructions,
  };
}

const runtimeDispatcher = `
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

function cursorPane() {
  let pid = process.pid;
  const seen = new Set();
  while (pid > 0 && !seen.has(pid)) {
    seen.add(pid);
    let env;
    try { env = readFileSync("/proc/" + pid + "/environ"); } catch { env = undefined; }
    if (env) {
      let pane;
      let home;
      for (const entry of env.toString("utf8").split("\\0")) {
        if (entry.startsWith("TMUX_PANE=")) pane = entry.slice("TMUX_PANE=".length);
        else if (entry.startsWith("HOME=")) home = entry.slice("HOME=".length);
      }
      if (pane) return { pane, home: home || process.env.HOME };
    }
    try {
      const stat = readFileSync("/proc/" + pid + "/stat", "utf8");
      pid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    } catch { break; }
  }
  return undefined;
}

function tmuxSessionName(pane, home) {
  return execFileSync("tmux", ["display-message", "-t", pane, "-p", "#{session_name}"], {
    encoding: "utf8",
    env: { ...process.env, HOME: home || process.env.HOME },
  }).trim();
}

function sessionDirectory(home, sessionId) {
  const directory = readFileSync(home + "/.cursor/agents-in-the-cloud/sessions/" + sessionId, "utf8").replace(/\\n$/, "");
  if (!directory || directory.includes("\\n")) throw new Error("Cursor session directory pointer is invalid");
  return directory;
}

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

function writeMessages(data) {
  const messages = Array.isArray(data) ? data : [data];
  for (const message of messages) {
    if (message && message.result && typeof message.result.protocolVersion === "string") protocolVersion = message.result.protocolVersion;
    process.stdout.write(JSON.stringify(message) + "\\n");
  }
}

async function writeSse(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  while (true) {
    const step = await reader.read();
    if (step.done) break;
    pending += decoder.decode(step.value, { stream: true });
    let split;
    while ((split = pending.indexOf("\\n\\n")) !== -1) {
      const event = pending.slice(0, split);
      pending = pending.slice(split + 2);
      const data = event.split("\\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\\n");
      if (data) writeMessages(JSON.parse(data));
    }
  }
}

let sessionId;
let protocolVersion;
async function forward(connection, message) {
  const headers = new Headers();
  headers.set("content-type", "application/json");
  headers.set("accept", "application/json, text/event-stream");
  headers.set("authorization", "Bearer " + connection.token);
  if (sessionId) headers.set("mcp-session-id", sessionId);
  if (protocolVersion) headers.set("mcp-protocol-version", protocolVersion);
  const response = await fetch(connection.url, { method: "POST", headers, body: JSON.stringify(message) });
  const nextSession = response.headers.get("mcp-session-id");
  if (nextSession) sessionId = nextSession;
  if (!response.ok) {
    const text = await response.text();
    throw new Error("Cursor MCP bridge HTTP " + response.status + ": " + text);
  }
  if (response.status === 202) {
    await response.body?.cancel();
    return;
  }
  const media = (response.headers.get("content-type") ?? "").split(";")[0].trim();
  if (media === "application/json") {
    writeMessages(await response.json());
    return;
  }
  if (media === "text/event-stream") {
    await writeSse(response.body);
    return;
  }
  throw new Error("Cursor MCP bridge unexpected content type: " + media);
}

async function bridge(connection) {
  let pending = "";
  let chain = Promise.resolve();
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    pending += chunk;
    let newline;
    while ((newline = pending.indexOf("\\n")) !== -1) {
      const line = pending.slice(0, newline).replace(/\\r$/, "");
      pending = pending.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      chain = chain.then(() => forward(connection, message));
    }
  });
  await new Promise((resolve, reject) => {
    process.stdin.on("end", () => { chain.then(resolve, reject); });
    process.stdin.on("error", reject);
  });
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
    const existing = raw.trim() === "" ? undefined : parseCursorHooksFile(raw);
    const merged = mergeCursorHooks(existing, { sessionStart: action, beforeSubmitPrompt: third, stop: process.argv[5] });
    process.stdout.write(JSON.stringify(merged) + "\\n");
    return;
  }
  if (command === "merge-mcp") {
    const raw = readFileSync(0, "utf8");
    const existing = raw.trim() === "" ? undefined : parseCursorMcpFile(raw);
    const merged = mergeCursorMcp(existing, { command: "node", args: [action, "mcp"] });
    process.stdout.write(JSON.stringify(merged) + "\\n");
    return;
  }
  if (command === "hook") {
    const text = readFileSync(0, "utf8");
    const found = cursorPane();
    if (!found) {
      console.error("cursor hook: no TMUX_PANE");
      writeAllow(action);
      return;
    }
    const identity = identifyCursorPane(tmuxSessionName(found.pane, found.home));
    if (identity.kind !== "ours") {
      writeAllow(action);
      return;
    }
    const directory = sessionDirectory(found.home, identity.sessionId);
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
  if (command === "mcp") {
    const found = cursorPane();
    if (!found) {
      console.error("cursor mcp: no TMUX_PANE");
      process.exit(1);
    }
    const identity = identifyCursorPane(tmuxSessionName(found.pane, found.home));
    if (identity.kind !== "ours") {
      console.error("cursor mcp: foreign pane");
      process.exit(1);
    }
    const directory = sessionDirectory(found.home, identity.sessionId);
    const connection = parseCursorConnection(JSON.parse(readFileSync(directory + "/cursor/connection.json", "utf8")));
    await bridge(connection);
    return;
  }
  throw new Error("Unknown Cursor runtime command: " + command);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
`;

export function cursorRuntimeScript(): string {
  const functions = [isRecord, identifyCursorPane, parseCursorConnection, cursorTurnBoundary, cursorSessionStartReply, cursorPromptReply, cursorStopReply, parseCursorStopStatus, acceptCursorChatId, parseCursorChatId, knownAuthKey, knownUserInfoKey, cursorAuthDecision, knownHookField, hookCommand, parseCursorHooksFile, isOwnedHook, mergeCursorHooks, stringRecord, knownMcpField, mcpServer, parseCursorMcpFile, mergeCursorMcp];
  return [
    `const cursorAgentId = ${JSON.stringify(cursorAgentId)};`,
    `const cursorMcpUrl = ${JSON.stringify(cursorMcpUrl)};`,
    `const cursorStopBoundary = ${JSON.stringify(cursorStopBoundary)};`,
    `const cursorHookMarker = ${JSON.stringify(cursorHookMarker)};`,
    `const cursorMcpServerName = ${JSON.stringify(cursorMcpServerName)};`,
    functions.map(fn => fn.toString()).join("\n"),
    runtimeDispatcher,
  ].join("\n");
}

export function cursorSharedHomeScript(session: CliAgentSession): string {
  const directory = shellQuote(session.directory);
  const id = shellQuote(session.id);
  return `set -eu
umask 077
mkdir -p "$HOME/.cursor" "$HOME/.cursor/agents-in-the-cloud/sessions"
(
  flock 9
  runtime="$HOME/.cursor/agents-in-the-cloud/runtime.mjs"
  cat > "$runtime.next"
  mv "$runtime.next" "$runtime"
  chmod 700 "$runtime"
  printf '%s\\n' ${directory} > "$HOME/.cursor/agents-in-the-cloud/sessions/"${id}
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
    node "$runtime" merge-mcp "$runtime" < "$mcp" > "$mcp_tmp"
  else
    node "$runtime" merge-mcp "$runtime" < /dev/null > "$mcp_tmp"
  fi
  mv "$mcp_tmp" "$mcp"
  chmod 600 "$mcp"
) 9>"$HOME/.cursor/agents-in-the-cloud.lock"
`;
}

export async function prepareCursorSession(workspaceId: string, session: CliAgentSession, connection: CliAgentConnection): Promise<Record<string, string>> {
  await writeCliSessionFiles(workspaceId, session, cursorSessionFiles(connection));
  await checkedWorkspaceShell(workspaceId, cursorSharedHomeScript(session), cursorRuntimeScript());
  return {};
}

export async function readCursorChatId(workspaceId: string, session: CliAgentSession): Promise<string | undefined> {
  const path = join(getAgentsInTheCloudRuntimeContext().agentsInTheCloudDataDir, "workspaces", workspaceId, "home-local", ".local", "share", "agents-in-the-cloud-agents", session.id, "cursor", "chat-id");
  return parseCursorChatId(await readTextIfExists(path));
}
