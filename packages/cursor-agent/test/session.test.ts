import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cursorRuntimeScript, cursorSessionFiles, cursorSharedHomeScript, acceptCursorChatId, cursorAuthDecision, cursorPromptReply, cursorSessionStartReply, cursorStopBoundary, cursorStopReply, cursorTurnBoundary, identifyCursorPane, mergeCursorHooks, mergeCursorMcp, parseCursorChatId, parseCursorConnection, parseCursorHooksFile, parseCursorMcpFile, parseCursorStopStatus, prepareCursorSession, readCursorChatId, type CursorOwnedHooks } from "../src/server/session.ts";

const sessionId = "11111111-2222-4333-8444-555555555555";
const owned: CursorOwnedHooks = {
  sessionStart: "node /rt/runtime.mjs hook session-start",
  beforeSubmitPrompt: "node /rt/runtime.mjs hook prompt",
  stop: "node /rt/runtime.mjs hook stop",
};
const fixtureDir = join(import.meta.dir, "fixtures");

test("pane names, connections, and chat ids accept only the captured shapes", () => {
  expect(identifyCursorPane(`cursor-${sessionId}`)).toEqual({ kind: "ours", sessionId });
  expect(identifyCursorPane("cursor-not-a-uuid")).toEqual({ kind: "foreign" });
  expect(identifyCursorPane(`claude-${sessionId}`)).toEqual({ kind: "foreign" });
  expect(parseCursorConnection({ url: "http://127.0.0.1:2988/mcp", token: "sekret" })).toEqual({ url: "http://127.0.0.1:2988/mcp", token: "sekret" });
  expect(() => parseCursorConnection({ url: "http://127.0.0.1:9/mcp", token: "sekret" })).toThrow("workspace MCP relay");
  expect(() => parseCursorConnection({ url: "http://127.0.0.1:2988/mcp", token: "sekret", extra: true })).toThrow("unexpected keys");
  expect(() => parseCursorConnection({ url: "http://127.0.0.1:2988/mcp", token: "" })).toThrow("token is invalid");
  expect(parseCursorChatId(undefined)).toBeUndefined();
  expect(acceptCursorChatId(`${sessionId}\n`)).toBe(sessionId);
  expect(() => acceptCursorChatId("-1\n")).toThrow("not a UUID");
  expect(() => acceptCursorChatId("\n")).toThrow("empty");
  expect(() => parseCursorChatId(`${sessionId}\n\n`)).toThrow("newline");
});

test("stop replies finish only completed turns and never ask for a follow-up", () => {
  expect(cursorTurnBoundary("completed")).toBe("finished");
  expect(cursorTurnBoundary("aborted")).toBe("failed");
  expect(cursorTurnBoundary("error")).toBe("failed");
  expect(cursorStopBoundary).toEqual({ completed: "finished", aborted: "failed", error: "failed" });
  expect(parseCursorStopStatus({ status: "completed", loop_count: 0 })).toBe("completed");
  expect(() => parseCursorStopStatus({ status: "nope" })).toThrow("Unknown Cursor stop status: nope");
  expect(cursorStopReply()).toEqual({});
  expect(cursorPromptReply()).toEqual({ continue: true });
  expect(cursorSessionStartReply("Use the workspace tools.")).toEqual({ additional_context: "Use the workspace tools." });
});

test("status decisions follow captured agent status documents and reject schema drift", async () => {
  const unauthenticated = JSON.parse(await readFile(join(fixtureDir, "status-unauthenticated.json"), "utf8"));
  const authenticated = JSON.parse(await readFile(join(fixtureDir, "status-authenticated-no-profile.json"), "utf8"));
  const partial = JSON.parse(await readFile(join(fixtureDir, "status-partial.json"), "utf8"));
  expect(cursorAuthDecision(unauthenticated)).toBe("logged-out");
  expect(cursorAuthDecision(authenticated)).toBe("logged-in");
  expect(cursorAuthDecision(partial)).toBe("logged-out");
  expect(cursorAuthDecision({
    status: "authenticated",
    isAuthenticated: true,
    hasAccessToken: true,
    hasRefreshToken: true,
    userInfo: { email: "ada@example.com", userId: 42, teamName: "Analytical" },
  })).toBe("logged-in");
  expect(() => cursorAuthDecision({ status: "error", message: "Status check error: boom" })).toThrow("not the captured document");
  expect(() => cursorAuthDecision({ ...authenticated, endpoint: "https://api2.cursor.sh" })).toThrow("not in the captured schema: endpoint");
  expect(() => cursorAuthDecision({
    status: "authenticated",
    isAuthenticated: false,
    hasAccessToken: true,
    hasRefreshToken: true,
    message: "Logged in (unable to fetch user details)",
  })).toThrow("do not match the captured schema");
  expect(() => cursorAuthDecision({
    status: "authenticated",
    isAuthenticated: true,
    hasAccessToken: true,
    hasRefreshToken: true,
    userInfo: { email: "ada@example.com", plan: "pro" },
  })).toThrow("userInfo field is not in the captured schema: plan");
});

test("hook and MCP merges keep foreign entries and replace only our commands", () => {
  const existingHooks = {
    version: 1 as const,
    disableAllHooks: false,
    hooks: {
      beforeSubmitPrompt: [{ command: "./hooks/audit.sh", timeout: 30 }, { command: "node /old/runtime.mjs hook prompt" }],
      stop: [{ command: "node /old/runtime.mjs hook stop" }],
      preToolUse: [{ command: "./hooks/allow.sh" }],
    },
  };
  const mergedHooks = {
    version: 1,
    disableAllHooks: false,
    hooks: {
      beforeSubmitPrompt: [{ command: "./hooks/audit.sh", timeout: 30 }, { command: owned.beforeSubmitPrompt }],
      preToolUse: [{ command: "./hooks/allow.sh" }],
      sessionStart: [{ command: owned.sessionStart }],
      stop: [{ command: owned.stop }],
    },
  };
  expect(mergeCursorHooks(existingHooks, owned)).toEqual(mergedHooks);
  expect(mergeCursorHooks(mergedHooks, owned)).toEqual(mergedHooks);
  expect(parseCursorHooksFile(undefined)).toBeUndefined();
  expect(() => parseCursorHooksFile("{")).toThrow();
  expect(() => parseCursorHooksFile('{"version":1,"hooks":{"stop":["nope"]}}')).toThrow("event stop is invalid");
  const existingMcp = { mcpServers: { other: { command: "python", args: ["server.py"] } } };
  const bridge = { command: "node" as const, args: ["/rt/runtime.mjs", "mcp"] as const };
  const mergedMcp = { mcpServers: { other: { command: "python", args: ["server.py"] }, "agents-in-the-cloud": bridge } };
  expect(mergeCursorMcp(existingMcp, bridge)).toEqual(mergedMcp);
  expect(mergeCursorMcp(mergedMcp, bridge)).toEqual(mergedMcp);
  expect(parseCursorMcpFile(undefined)).toBeUndefined();
  expect(() => parseCursorMcpFile('{"mcpServers":{"other":"nope"}}')).toThrow("server other is invalid");
});

test("session files keep the bearer token out of the shared-home script", () => {
  const session = { id: sessionId, directory: "/session", turnSignalCommand: "/session/turn-signal.sh" };
  const files = cursorSessionFiles({ url: "http://127.0.0.1:2988/mcp", token: "sekret", instructions: "Guide the workspace." });
  expect(JSON.parse(files["cursor/connection.json"])).toEqual({ url: "http://127.0.0.1:2988/mcp", token: "sekret" });
  expect(files["cursor/instructions.txt"]).toBe("Guide the workspace.");
  expect(cursorSharedHomeScript(session)).not.toContain("sekret");
  expect(cursorRuntimeScript()).not.toContain("sekret");
});

async function runtimeHome() {
  const home = await mkdtemp(join(tmpdir(), "cursor-runtime-"));
  const directory = join(home, "session");
  await mkdir(join(home, ".cursor/agents-in-the-cloud/sessions"), { recursive: true });
  await mkdir(join(home, "bin"), { recursive: true });
  await mkdir(join(directory, "cursor"), { recursive: true });
  const runtime = join(home, ".cursor/agents-in-the-cloud/runtime.mjs");
  await writeFile(runtime, cursorRuntimeScript());
  await writeFile(join(home, ".cursor/agents-in-the-cloud/sessions", sessionId), `${directory}\n`);
  await writeFile(join(home, "bin/tmux"), `#!/bin/sh
if [ "$1" = display-message ]; then printf '%s\\n' "$CURSOR_TEST_SESSION"; exit 0; fi
echo "unexpected tmux $*" >&2
exit 1
`);
  await chmod(join(home, "bin/tmux"), 0o755);
  return { home, directory, runtime };
}

function runNode(runtime: string, args: string[], stdin: string, env: NodeJS.ProcessEnv) {
  const child = Bun.spawn(["node", runtime, ...args], { env, stdin: new Blob([stdin]), stdout: "pipe", stderr: "pipe" });
  return Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
}

test("the embedded runtime parses status, chat ids, hooks, and foreign panes", async () => {
  const { home, directory, runtime } = await runtimeHome();
  try {
    const check = Bun.spawn(["node", "--check", runtime], { stdout: "pipe", stderr: "pipe" });
    expect(await check.exited).toBe(0);
    const env = { ...process.env, HOME: home, PATH: `${home}/bin:${process.env.PATH}`, CURSOR_TEST_SESSION: "dev", TMUX_PANE: "%1" };
    expect((await runNode(runtime, ["auth-status"], await readFile(join(fixtureDir, "status-unauthenticated.json"), "utf8"), env))[0]).toBe(10);
    expect((await runNode(runtime, ["auth-status"], await readFile(join(fixtureDir, "status-authenticated-no-profile.json"), "utf8"), env))[0]).toBe(0);
    expect((await runNode(runtime, ["auth-status"], await readFile(join(fixtureDir, "status-partial.json"), "utf8"), env))[0]).toBe(10);
    expect((await runNode(runtime, ["auth-status"], '{"status":"error","message":"Status check error: boom"}', env))[0]).toBe(1);
    const [chatCode, chatOut] = await runNode(runtime, ["accept-chat-id"], `${sessionId}\n`, env);
    expect(chatCode).toBe(0);
    expect(chatOut).toBe(`${sessionId}\n`);
    expect((await runNode(runtime, ["accept-chat-id"], "-1\n", env))[0]).toBe(1);
    const rawHooks = JSON.stringify({ version: 1, hooks: { stop: [{ command: "./keep.sh" }, { command: "node /old/runtime.mjs hook stop" }] } });
    const [mergeCode, mergeOut] = await runNode(runtime, ["merge-hooks", owned.sessionStart, owned.beforeSubmitPrompt, owned.stop], rawHooks, env);
    expect(mergeCode).toBe(0);
    expect(JSON.parse(mergeOut)).toEqual(mergeCursorHooks(JSON.parse(rawHooks), owned));
    await writeFile(join(directory, "turn-signal.sh"), "#!/bin/sh\nprintf '%s\\n' \"$1\" >> \"$HOME/signals\"\nexit 1\n");
    const foreign = await runNode(runtime, ["hook", "prompt"], "{}\n", env);
    expect(foreign[0]).toBe(0);
    expect(JSON.parse(foreign[1])).toEqual({ continue: true });
    expect(await Bun.file(join(home, "signals")).exists()).toBe(false);
    const noPaneEnv = { ...env };
    delete noPaneEnv.TMUX_PANE;
    const noPane = await runNode(runtime, ["hook", "stop"], '{"status":"completed"}\n', noPaneEnv);
    expect(noPane[0]).toBe(0);
    expect(JSON.parse(noPane[1])).toEqual({});
    expect(noPane[2]).toContain("cursor hook: no TMUX_PANE");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("our pane signals turns, injects instructions, and bridges MCP with the session token", async () => {
  const { home, directory, runtime } = await runtimeHome();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 2988,
    async fetch(request) {
      if (new URL(request.url).pathname !== "/mcp") return new Response("nope", { status: 404 });
      if (request.headers.get("authorization") !== "Bearer sekret") return new Response("unauthorized", { status: 401 });
      const body = await request.json();
      if (body.method === "initialize") {
        return Response.json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "agents-in-the-cloud", version: "1.0.0" } } }, { headers: { "mcp-session-id": "sess-1" } });
      }
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (request.headers.get("mcp-session-id") !== "sess-1") return new Response("missing session", { status: 400 });
      if (request.headers.get("mcp-protocol-version") !== "2025-03-26") return new Response("missing protocol", { status: 400 });
      if (body.method === "tools/list") return Response.json({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "present" }] } });
      return new Response("unexpected", { status: 400 });
    },
  });
  try {
    await writeFile(join(directory, "cursor/instructions.txt"), "Guide \"the\" workspace.");
    await writeFile(join(directory, "cursor/connection.json"), JSON.stringify({ url: "http://127.0.0.1:2988/mcp", token: "sekret" }));
    await writeFile(join(directory, "turn-signal.sh"), "#!/bin/sh\nprintf '%s\\n' \"$1\" >> \"$HOME/signals\"\nexit 1\n");
    const env = { ...process.env, HOME: home, PATH: `${home}/bin:${process.env.PATH}`, CURSOR_TEST_SESSION: `cursor-${sessionId}`, TMUX_PANE: "%1" };
    const started = await runNode(runtime, ["hook", "prompt"], '{"prompt":"hi"}\n', env);
    expect(started[0]).toBe(0);
    expect(JSON.parse(started[1])).toEqual({ continue: true });
    expect(await readFile(join(home, "signals"), "utf8")).toBe("started\n");
    const context = await runNode(runtime, ["hook", "session-start"], '{"session_id":"other"}\n', env);
    expect(context[0]).toBe(0);
    expect(JSON.parse(context[1])).toEqual({ additional_context: "Guide \"the\" workspace." });
    const stopped = await runNode(runtime, ["hook", "stop"], '{"status":"completed","loop_count":0}\n', env);
    expect(stopped[0]).toBe(0);
    expect(JSON.parse(stopped[1])).toEqual({});
    expect(stopped[1]).not.toContain("followup_message");
    expect(await readFile(join(home, "signals"), "utf8")).toBe("started\nfinished\n");
    const unknown = await runNode(runtime, ["hook", "stop"], '{"status":"nope"}\n', env);
    expect(unknown[0]).toBe(1);
    expect(unknown[2]).toContain("Unknown Cursor stop status: nope");
    const foreignMcp = await runNode(runtime, ["mcp"], "", { ...env, CURSOR_TEST_SESSION: "dev" });
    expect(foreignMcp[0]).toBe(1);
    expect(foreignMcp[2]).toContain("cursor mcp: foreign pane");
    const child = Bun.spawn(["node", runtime, "mcp"], { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } } })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
    child.stdin.end();
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(stdout).not.toContain("sekret");
    expect(stdout.trim().split("\n").map(line => JSON.parse(line))).toEqual([
      { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "agents-in-the-cloud", version: "1.0.0" } } },
      { jsonrpc: "2.0", id: 2, result: { tools: [{ name: "present" }] } },
    ]);
  } finally {
    server.stop(true);
    await rm(home, { recursive: true, force: true });
  }
});

test("shared-home prepare rewrites hooks and MCP under the flock without the token", async () => {
  const home = await mkdtemp(join(tmpdir(), "cursor-home-"));
  const directory = join(home, "session");
  const session = { id: sessionId, directory, turnSignalCommand: `${directory}/turn-signal.sh` };
  try {
    await mkdir(join(home, ".cursor"), { recursive: true });
    await writeFile(join(home, ".cursor/hooks.json"), JSON.stringify({
      version: 1,
      hooks: { beforeSubmitPrompt: [{ command: "./hooks/audit.sh" }, { command: "node /old/runtime.mjs hook prompt" }] },
    }));
    await writeFile(join(home, ".cursor/mcp.json"), JSON.stringify({ mcpServers: { other: { command: "python", args: ["server.py"] } } }));
    const child = Bun.spawn(["sh", "-c", cursorSharedHomeScript(session)], {
      env: { ...process.env, HOME: home }, stdin: new Blob([cursorRuntimeScript()]), stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
    const runtime = join(home, ".cursor/agents-in-the-cloud/runtime.mjs");
    expect((await stat(runtime)).mode & 0o777).toBe(0o700);
    expect(await readFile(join(home, ".cursor/agents-in-the-cloud/sessions", sessionId), "utf8")).toBe(`${directory}\n`);
    const hooks = JSON.parse(await readFile(join(home, ".cursor/hooks.json"), "utf8"));
    expect(hooks).toEqual({
      version: 1,
      hooks: {
        beforeSubmitPrompt: [{ command: "./hooks/audit.sh" }, { command: `node ${runtime} hook prompt` }],
        sessionStart: [{ command: `node ${runtime} hook session-start` }],
        stop: [{ command: `node ${runtime} hook stop` }],
      },
    });
    expect(JSON.parse(await readFile(join(home, ".cursor/mcp.json"), "utf8"))).toEqual({
      mcpServers: {
        other: { command: "python", args: ["server.py"] },
        "agents-in-the-cloud": { command: "node", args: [runtime, "mcp"] },
      },
    });
    expect(await readFile(join(home, ".cursor/mcp.json"), "utf8")).not.toContain("sekret");
    expect((await stat(join(home, ".cursor/hooks.json"))).mode & 0o777).toBe(0o600);
    const again = Bun.spawn(["sh", "-c", cursorSharedHomeScript(session)], { env: { ...process.env, HOME: home }, stdin: new Blob([cursorRuntimeScript()]), stdout: "pipe", stderr: "pipe" });
    expect(await again.exited).toBe(0);
    expect(JSON.parse(await readFile(join(home, ".cursor/hooks.json"), "utf8"))).toEqual(hooks);
    await writeFile(join(home, ".cursor/hooks.json"), "{");
    const broken = Bun.spawn(["sh", "-c", cursorSharedHomeScript(session)], { env: { ...process.env, HOME: home }, stdin: new Blob([cursorRuntimeScript()]), stdout: "pipe", stderr: "pipe" });
    expect(await broken.exited).not.toBe(0);
    expect(await readFile(join(home, ".cursor/hooks.json"), "utf8")).toBe("{");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("prepareCursorSession returns no environment and keeps the token in the session file", async () => {
  const source = join(import.meta.dir, "../src/server/session.ts");
  const child = Bun.spawn([process.execPath, "-e", `
    import { expect, mock } from "bun:test";
    const cli = await import("@agents-in-the-cloud/cli-agent/server");
    const writes = [];
    const shells = [];
    mock.module("@agents-in-the-cloud/cli-agent/server", () => ({ ...cli, writeCliSessionFiles: async (...args) => { writes.push(args); }, checkedWorkspaceShell: async (...args) => { shells.push(args); } }));
    const { prepareCursorSession, cursorRuntimeScript } = await import(${JSON.stringify(source)});
    const session = { id: ${JSON.stringify(sessionId)}, directory: "/session", turnSignalCommand: "/session/turn-signal.sh" };
    expect(await prepareCursorSession("workspace", session, { url: "http://127.0.0.1:2988/mcp", token: "sekret", instructions: "Guide." })).toEqual({});
    expect(JSON.parse(writes[0][2]["cursor/connection.json"])).toEqual({ url: "http://127.0.0.1:2988/mcp", token: "sekret" });
    expect(writes[0][2]["cursor/instructions.txt"]).toBe("Guide.");
    expect(shells[0][0]).toBe("workspace");
    expect(shells[0][1]).toContain("flock 9");
    expect(shells[0][1]).not.toContain("sekret");
    expect(shells[0][2]).toBe(cursorRuntimeScript());
    expect(shells[0][2]).not.toContain("sekret");
  `], { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
});

test("readCursorChatId reads the workspace-private chat file", async () => {
  const root = await mkdtemp(join(tmpdir(), "cursor-chat-id-"));
  const previous = process.env.ATELIER_DATA_DIR;
  process.env.ATELIER_DATA_DIR = root;
  try {
    const session = { id: sessionId, directory: "/vm/session", turnSignalCommand: "/vm/session/turn-signal.sh" };
    expect(await readCursorChatId("workspace", session)).toBeUndefined();
    const path = join(root, "workspaces/workspace/home-local/.local/share/agents-in-the-cloud-agents", sessionId, "cursor/chat-id");
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, `${sessionId}\n`);
    expect(await readCursorChatId("workspace", session)).toBe(sessionId);
  } finally {
    if (previous === undefined) delete process.env.ATELIER_DATA_DIR;
    else process.env.ATELIER_DATA_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
