import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cursorMcpAuthorization, cursorRuntimeScript, cursorSessionDirEnv, cursorSessionFiles, cursorSharedHomeScript, acceptCursorChatId, cursorAuthDecision, cursorMcpTokenEnv, cursorPromptReply, cursorSessionStartReply, cursorStopBoundary, cursorStopReply, cursorTurnBoundary, mergeCursorHooks, mergeCursorMcp, parseCursorStopStatus, prepareCursorSession, type CursorOwnedHooks } from "../src/server/session.ts";

const sessionId = "11111111-2222-4333-8444-555555555555";
const relayUrl = "http://127.0.0.1:9/mcp";
const owned: CursorOwnedHooks = {
  sessionStart: "node /rt/runtime.mjs hook session-start",
  beforeSubmitPrompt: "node /rt/runtime.mjs hook prompt",
  stop: "node /rt/runtime.mjs hook stop",
};
const freshHooks = {
  version: 1,
  hooks: {
    sessionStart: [{ command: owned.sessionStart }],
    beforeSubmitPrompt: [{ command: owned.beforeSubmitPrompt }],
    stop: [{ command: owned.stop }],
  },
};
const httpServer = { url: relayUrl, headers: { Authorization: cursorMcpAuthorization } };
const fixtureDir = join(import.meta.dir, "fixtures");

test("chat ids accept only a single UUID line", () => {
  expect(acceptCursorChatId(`${sessionId}\n`)).toBe(sessionId);
  expect(acceptCursorChatId(sessionId)).toBe(sessionId);
  expect(() => acceptCursorChatId("-1\n")).toThrow("not a UUID");
  expect(() => acceptCursorChatId("\n")).toThrow("empty");
  expect(() => acceptCursorChatId(`${sessionId}\n\n`)).toThrow("newline");
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

test("status decisions use the required flags and ignore unknown profile fields", async () => {
  const unauthenticated = JSON.parse(await readFile(join(fixtureDir, "status-unauthenticated.json"), "utf8"));
  const authenticated = JSON.parse(await readFile(join(fixtureDir, "status-authenticated-no-profile.json"), "utf8"));
  const partial = JSON.parse(await readFile(join(fixtureDir, "status-partial.json"), "utf8"));
  expect(cursorAuthDecision(unauthenticated)).toBe("logged-out");
  expect(cursorAuthDecision(authenticated)).toBe("logged-in");
  expect(cursorAuthDecision(partial)).toBe("logged-out");
  expect(cursorAuthDecision({ ...authenticated, endpoint: "https://api2.cursor.sh" })).toBe("logged-in");
  expect(cursorAuthDecision({
    status: "authenticated",
    isAuthenticated: true,
    hasAccessToken: true,
    hasRefreshToken: true,
    userInfo: { email: "ada@example.com", userId: 42, teamName: "Analytical", plan: "pro", teamId: null },
  })).toBe("logged-in");
  expect(() => cursorAuthDecision({ status: "error", message: "Status check error: boom" })).toThrow("not the captured document");
  expect(() => cursorAuthDecision({
    status: "authenticated",
    isAuthenticated: false,
    hasAccessToken: true,
    hasRefreshToken: true,
    message: "Logged in (unable to fetch user details)",
  })).toThrow("do not match the captured schema");
  expect(() => cursorAuthDecision({ status: "authenticated" })).toThrow("not the captured document");
});

test("hook and MCP merges keep foreign entries and replace only our server", () => {
  const existingHooks = {
    version: 1,
    disableAllHooks: false,
    extra: { keep: true },
    hooks: {
      beforeSubmitPrompt: [{ command: "./hooks/audit.sh", timeout: 30, loop_limit: 2 }, { command: "node /old/runtime.mjs hook prompt" }],
      stop: [{ command: "node /old/runtime.mjs hook stop" }],
      preToolUse: [{ command: "./hooks/allow.sh" }],
    },
  };
  const mergedHooks = {
    version: 1,
    disableAllHooks: false,
    extra: { keep: true },
    hooks: {
      beforeSubmitPrompt: [{ command: "./hooks/audit.sh", timeout: 30, loop_limit: 2 }, { command: owned.beforeSubmitPrompt }],
      preToolUse: [{ command: "./hooks/allow.sh" }],
      sessionStart: [{ command: owned.sessionStart }],
      stop: [{ command: owned.stop }],
    },
  };
  expect(mergeCursorHooks(existingHooks, owned)).toEqual(mergedHooks);
  expect(mergeCursorHooks(mergedHooks, owned)).toEqual(mergedHooks);
  expect(mergeCursorHooks(undefined, owned)).toEqual(freshHooks);
  expect(() => mergeCursorHooks(JSON.parse('{"version":1,"hooks":{"stop":["nope"]}}'), owned)).toThrow("event stop is invalid");
  expect(() => mergeCursorHooks("{", owned)).toThrow("hooks.json is invalid");
  const existingMcp = {
    extra: true,
    mcpServers: { other: { command: "python", args: ["server.py"], envFile: "/tmp/env", auth: { CLIENT_ID: "abc" } } },
  };
  const mergedMcp = {
    extra: true,
    mcpServers: {
      other: { command: "python", args: ["server.py"], envFile: "/tmp/env", auth: { CLIENT_ID: "abc" } },
      "agents-in-the-cloud": httpServer,
    },
  };
  expect(mergeCursorMcp(existingMcp, relayUrl)).toEqual(mergedMcp);
  expect(mergeCursorMcp(mergedMcp, relayUrl)).toEqual(mergedMcp);
  expect(mergeCursorMcp(undefined, relayUrl)).toEqual({ mcpServers: { "agents-in-the-cloud": httpServer } });
  expect(() => mergeCursorMcp(JSON.parse('{"mcpServers":{"other":"nope"}}'), relayUrl)).toThrow("server other is invalid");
  expect(cursorMcpAuthorization).toBe("Bearer ${env:AGENTS_IN_THE_CLOUD_MCP_TOKEN}");
});

test("session files store the connection URL and keep the token out of the shared-home script", () => {
  const files = cursorSessionFiles({ url: relayUrl, token: "sekret", instructions: "Guide the workspace." });
  expect(JSON.parse(files["cursor/connection.json"])).toEqual({ url: relayUrl, token: "sekret" });
  expect(files["cursor/instructions.txt"]).toBe("Guide the workspace.");
  const script = cursorSharedHomeScript(relayUrl);
  expect(script).not.toContain("sekret");
  expect(script).toContain(relayUrl);
  expect(script).not.toContain("/proc/");
  expect(script).not.toContain("sessions/");
  const runtime = cursorRuntimeScript();
  expect(runtime).not.toContain("sekret");
  expect(runtime).not.toContain("/proc/");
  expect(runtime).not.toContain("TMUX_PANE");
  expect(runtime).toContain(cursorMcpAuthorization);
});

async function runtimeHome() {
  const home = await mkdtemp(join(tmpdir(), "cursor-runtime-"));
  const directory = join(home, "session");
  await mkdir(join(directory, "cursor"), { recursive: true });
  const runtime = join(home, "runtime.mjs");
  await writeFile(runtime, cursorRuntimeScript());
  return { home, directory, runtime };
}

function runNode(runtime: string, args: string[], stdin: string, env: NodeJS.ProcessEnv) {
  const child = Bun.spawn(["node", runtime, ...args], { env, stdin: new Blob([stdin]), stdout: "pipe", stderr: "pipe" });
  return Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
}

function foreignEnv(home: string): NodeJS.ProcessEnv {
  const env = { ...process.env, HOME: home };
  delete env[cursorSessionDirEnv];
  delete env.TMUX_PANE;
  return env;
}

test("the embedded runtime parses status and chat ids, and a pane without our session env is foreign", async () => {
  const { home, runtime } = await runtimeHome();
  try {
    const check = Bun.spawn(["node", "--check", runtime], { stdout: "pipe", stderr: "pipe" });
    expect(await check.exited).toBe(0);
    const env = foreignEnv(home);
    expect((await runNode(runtime, ["auth-status"], await readFile(join(fixtureDir, "status-unauthenticated.json"), "utf8"), env))[0]).toBe(10);
    expect((await runNode(runtime, ["auth-status"], await readFile(join(fixtureDir, "status-authenticated-no-profile.json"), "utf8"), env))[0]).toBe(0);
    const drifted = JSON.parse(await readFile(join(fixtureDir, "status-authenticated-no-profile.json"), "utf8"));
    expect((await runNode(runtime, ["auth-status"], JSON.stringify({ ...drifted, endpoint: "https://api2.cursor.sh", userInfo: { plan: "pro", teamId: null } }), env))[0]).toBe(0);
    expect((await runNode(runtime, ["auth-status"], await readFile(join(fixtureDir, "status-partial.json"), "utf8"), env))[0]).toBe(10);
    expect((await runNode(runtime, ["auth-status"], '{"status":"error","message":"Status check error: boom"}', env))[0]).toBe(1);
    const [chatCode, chatOut] = await runNode(runtime, ["accept-chat-id"], `${sessionId}\n`, env);
    expect(chatCode).toBe(0);
    expect(chatOut).toBe(`${sessionId}\n`);
    expect((await runNode(runtime, ["accept-chat-id"], "-1\n", env))[0]).toBe(1);
    const rawHooks = JSON.stringify({
      version: 1,
      extra: { keep: true },
      hooks: { stop: [{ command: "./keep.sh", loop_limit: 3 }, { command: "node /old/runtime.mjs hook stop" }] },
    });
    const [mergeCode, mergeOut] = await runNode(runtime, ["merge-hooks", owned.sessionStart, owned.beforeSubmitPrompt, owned.stop], rawHooks, env);
    expect(mergeCode).toBe(0);
    expect(JSON.parse(mergeOut)).toEqual(mergeCursorHooks(JSON.parse(rawHooks), owned));
    const rawMcp = JSON.stringify({ extra: true, mcpServers: { other: { command: "python", envFile: "/tmp/env" } } });
    const [mcpCode, mcpOut] = await runNode(runtime, ["merge-mcp", relayUrl], rawMcp, env);
    expect(mcpCode).toBe(0);
    expect(JSON.parse(mcpOut)).toEqual(mergeCursorMcp(JSON.parse(rawMcp), relayUrl));
    expect(mcpOut).not.toContain("sekret");
    const foreign = await runNode(runtime, ["hook", "prompt"], "{}\n", env);
    expect(foreign[0]).toBe(0);
    expect(JSON.parse(foreign[1])).toEqual({ continue: true });
    expect(foreign[2]).toBe("");
    expect(await Bun.file(join(home, "signals")).exists()).toBe(false);
    const inheritedPane = await runNode(runtime, ["hook", "stop"], '{"status":"completed"}\n', { ...env, TMUX_PANE: "%0" });
    expect(inheritedPane[0]).toBe(0);
    expect(JSON.parse(inheritedPane[1])).toEqual({});
    expect(inheritedPane[2]).toBe("");
    expect(await Bun.file(join(home, "signals")).exists()).toBe(false);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("our session env signals turns and injects instructions without reading the pane", async () => {
  const { home, directory, runtime } = await runtimeHome();
  try {
    await writeFile(join(directory, "cursor/instructions.txt"), "Guide \"the\" workspace.");
    await writeFile(join(directory, "turn-signal.sh"), "#!/bin/sh\nprintf '%s\\n' \"$1\" >> \"$HOME/signals\"\nexit 1\n");
    await chmod(join(directory, "turn-signal.sh"), 0o755);
    const env = { ...foreignEnv(home), [cursorSessionDirEnv]: directory, TMUX_PANE: "%0" };
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
    expect((await runNode(runtime, ["mcp"], "", env))[0]).toBe(1);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("shared-home prepare rewrites hooks and HTTP MCP under the flock without the token", async () => {
  const home = await mkdtemp(join(tmpdir(), "cursor-home-"));
  const url = relayUrl;
  try {
    await mkdir(join(home, ".cursor"), { recursive: true });
    await writeFile(join(home, ".cursor/hooks.json"), JSON.stringify({
      version: 1,
      extra: { keep: true },
      hooks: { beforeSubmitPrompt: [{ command: "./hooks/audit.sh", loop_limit: 2 }, { command: "node /old/runtime.mjs hook prompt" }] },
    }));
    await writeFile(join(home, ".cursor/mcp.json"), JSON.stringify({
      extra: true,
      mcpServers: { other: { command: "python", args: ["server.py"], envFile: "/tmp/env" } },
    }));
    const child = Bun.spawn(["sh", "-c", cursorSharedHomeScript(url)], {
      env: { ...process.env, HOME: home }, stdin: new Blob([cursorRuntimeScript()]), stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
    const runtime = join(home, ".cursor/agents-in-the-cloud/runtime.mjs");
    expect((await stat(runtime)).mode & 0o777).toBe(0o700);
    expect(await Bun.file(join(home, ".cursor/agents-in-the-cloud/sessions", sessionId)).exists()).toBe(false);
    const hooks = JSON.parse(await readFile(join(home, ".cursor/hooks.json"), "utf8"));
    expect(hooks).toEqual({
      version: 1,
      extra: { keep: true },
      hooks: {
        beforeSubmitPrompt: [{ command: "./hooks/audit.sh", loop_limit: 2 }, { command: `node ${runtime} hook prompt` }],
        sessionStart: [{ command: `node ${runtime} hook session-start` }],
        stop: [{ command: `node ${runtime} hook stop` }],
      },
    });
    expect(JSON.parse(await readFile(join(home, ".cursor/mcp.json"), "utf8"))).toEqual({
      extra: true,
      mcpServers: {
        other: { command: "python", args: ["server.py"], envFile: "/tmp/env" },
        "agents-in-the-cloud": { url, headers: { Authorization: cursorMcpAuthorization } },
      },
    });
    expect(await readFile(join(home, ".cursor/mcp.json"), "utf8")).not.toContain("sekret");
    expect((await stat(join(home, ".cursor/hooks.json"))).mode & 0o777).toBe(0o600);
    const again = Bun.spawn(["sh", "-c", cursorSharedHomeScript(url)], { env: { ...process.env, HOME: home }, stdin: new Blob([cursorRuntimeScript()]), stdout: "pipe", stderr: "pipe" });
    expect(await again.exited).toBe(0);
    expect(JSON.parse(await readFile(join(home, ".cursor/hooks.json"), "utf8"))).toEqual(hooks);
    await writeFile(join(home, ".cursor/hooks.json"), "{");
    const broken = Bun.spawn(["sh", "-c", cursorSharedHomeScript(url)], { env: { ...process.env, HOME: home }, stdin: new Blob([cursorRuntimeScript()]), stdout: "pipe", stderr: "pipe" });
    expect(await broken.exited).not.toBe(0);
    expect(await readFile(join(home, ".cursor/hooks.json"), "utf8")).toBe("{");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("prepareCursorSession returns the pane env and stores the given connection URL", async () => {
  const source = join(import.meta.dir, "../src/server/session.ts");
  const child = Bun.spawn([process.execPath, "-e", `
    import { expect, mock } from "bun:test";
    const cli = await import("@agents-in-the-cloud/cli-agent/server");
    const writes = [];
    const shells = [];
    mock.module("@agents-in-the-cloud/cli-agent/server", () => ({ ...cli, writeCliSessionFiles: async (...args) => { writes.push(args); }, checkedWorkspaceShell: async (...args) => { shells.push(args); } }));
    const { prepareCursorSession, cursorRuntimeScript, cursorSessionDirEnv, cursorMcpTokenEnv } = await import(${JSON.stringify(source)});
    const session = { id: ${JSON.stringify(sessionId)}, directory: "/session", turnSignalCommand: "/session/turn-signal.sh" };
    expect(await prepareCursorSession("workspace", session, { url: ${JSON.stringify(relayUrl)}, token: "sekret", instructions: "Guide." })).toEqual({
      [cursorSessionDirEnv]: "/session",
      [cursorMcpTokenEnv]: "sekret",
    });
    expect(JSON.parse(writes[0][2]["cursor/connection.json"])).toEqual({ url: ${JSON.stringify(relayUrl)}, token: "sekret" });
    expect(writes[0][2]["cursor/instructions.txt"]).toBe("Guide.");
    expect(shells[0][0]).toBe("workspace");
    expect(shells[0][1]).toContain("flock 9");
    expect(shells[0][1]).toContain(${JSON.stringify(relayUrl)});
    expect(shells[0][1]).not.toContain("sekret");
    expect(shells[0][1]).not.toContain("sessions/");
    expect(shells[0][2]).toBe(cursorRuntimeScript());
    expect(shells[0][2]).not.toContain("sekret");
    expect(shells[0][2]).not.toContain("/proc/");
  `], { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
});
