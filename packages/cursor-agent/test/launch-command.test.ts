import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliAgentSession } from "@agents-in-the-cloud/cli-agent/server";
import type { WorkspaceAgentInput } from "@agents-in-the-cloud/shared";
import { cursorLaunchScript } from "../src/server/launch-command.ts";
import { cursorRuntimeScript } from "../src/server/session.ts";

const sessionId = "11111111-2222-4333-8444-555555555555";
const empty: WorkspaceAgentInput = { text: "", images: [], attachmentNotes: [] };
const authenticated = join(import.meta.dir, "fixtures/status-authenticated-no-profile.json");
const unauthenticated = join(import.meta.dir, "fixtures/status-unauthenticated.json");
let home: string;
let session: CliAgentSession;

const agentProgram = `#!/bin/sh
printf '%s\\n' "$*" >> "$HOME/argv-log"
if [ "$1" = status ]; then cat "$HOME/status.json"; exit 0; fi
if [ "$1" = login ]; then printf 'LOGIN\\n'; exit 0; fi
if [ "$1" = update ]; then
  printf '%s\\n' "$*" >> "$HOME/updates"
  if [ -f "$HOME/fail-update" ]; then echo update-failed >&2; exit 42; fi
  exit 0
fi
if [ "$1" = create-chat ]; then
  printf '%s\\n' create-chat >> "$HOME/created"
  if [ -f "$HOME/partial-create-chat" ]; then
    printf '%s' '11111111'
    sleep 0.4
    printf '%s\\n' '-2222-4333-8444-555555555555'
    sleep 30
    exit 0
  fi
  if [ -f "$HOME/exit-create-chat" ]; then
    printf '%s' '${sessionId}'
    exit 0
  fi
  if [ -f "$HOME/bad-create-chat" ]; then
    printf '%s\\n' 'not-a-uuid'
    exit 0
  fi
  printf '%s\\n' '${sessionId}'
  if [ -f "$HOME/hang-create-chat" ]; then sleep 30; fi
  exit 0
fi
printf '%s\\0' "$@"
printf '%s' "\${CURSOR_API_KEY-unset}" > "$HOME/api-key"
`;

async function executable(path: string, content: string) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content);
  await chmod(path, 0o755);
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "cursor-launch-"));
  session = { id: sessionId, directory: `${home}/session`, turnSignalCommand: `${home}/session/turn-signal.sh` };
  await executable(`${home}/.local/bin/agent`, agentProgram);
  await executable(`${home}/agent-template`, agentProgram);
  await writeFile(`${home}/installer-template`, `#!/bin/sh
mkdir -p "$HOME/.local/bin"
cp "$HOME/agent-template" "$HOME/.local/bin/agent"
chmod +x "$HOME/.local/bin/agent"
`);
  await executable(`${home}/tools/curl`, `#!/bin/sh
printf '%s\\n' "$*" >> "$HOME/installs"
dest=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "-o" ]; then dest=$arg; fi
  prev=$arg
done
cp "$HOME/installer-template" "$dest"
`);
  await mkdir(`${home}/.cursor/agents-in-the-cloud`, { recursive: true });
  await writeFile(`${home}/.cursor/agents-in-the-cloud/runtime.mjs`, cursorRuntimeScript());
  await writeFile(`${home}/status.json`, await readFile(authenticated));
  await writeFile(`${home}/.cursor-agent-update-check`, String(Math.floor(Date.now() / 1000)));
  await mkdir(`${home}/tmp`);
});
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

function run(script: string) {
  const child = Bun.spawn(["bash", "-c", script], {
    env: { ...process.env, HOME: home, PATH: `${home}/tools:${process.env.PATH}`, TMPDIR: `${home}/tmp`, CURSOR_API_KEY: "secret-key" },
    stdout: "pipe", stderr: "pipe",
  });
  return Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
}

function argsOf(output: string): string[] {
  const body = output.startsWith("LOGIN\n") ? output.slice("LOGIN\n".length) : output;
  const start = body.indexOf("--force");
  return body.slice(start).split("\0").slice(0, -1);
}

test("logged-in launch unsets the API key, resumes a created chat, and bans print flags", async () => {
  await writeFile(`${home}/hang-create-chat`, "");
  const text = `--help 'quoted' $(touch ${home}/injected)\nsecond line`;
  const [code, output, error] = await run(cursorLaunchScript({ ...empty, text }, ["/tmp/pic 1.png"], { model: "cursor::composer", thinkingLevel: "high" }, session));
  expect({ code, error }).toEqual({ code: 0, error: "" });
  expect(output).not.toContain("LOGIN");
  expect(argsOf(output)).toEqual(["--force", "--approve-mcps", "--sandbox", "disabled", "--resume", sessionId, "--", `${text}\n\nRead the attached image at "/tmp/pic 1.png".`]);
  expect(await readFile(`${home}/api-key`, "utf8")).toBe("unset");
  expect(await readFile(`${home}/session/cursor/chat-id`, "utf8")).toBe(`${sessionId}\n`);
  expect(await Bun.file(`${home}/injected`).exists()).toBe(false);
  expect(await Bun.file(`${home}/updates`).exists()).toBe(false);
  expect(await readdir(`${home}/tmp`)).toEqual([]);
});

test("a missing login runs agent login and an unreadable status stops before the agent", async () => {
  await writeFile(`${home}/status.json`, await readFile(unauthenticated));
  const [code, output] = await run(cursorLaunchScript(empty, [], {}, session));
  expect(code).toBe(0);
  expect(output).toContain("Cursor needs a login. Finish it in this pane.");
  expect(output).toContain("LOGIN");
  expect(argsOf(output)).toEqual(["--force", "--approve-mcps", "--sandbox", "disabled", "--resume", sessionId]);
  expect(await Bun.file(`${home}/created`).exists()).toBe(true);
  await writeFile(`${home}/status.json`, '{"status":"authenticated"}');
  const drifted = await run(cursorLaunchScript(empty, [], {}, session));
  expect(drifted[0]).not.toBe(0);
  expect(drifted[1]).toContain("Cursor status could not be read");
  expect(drifted[1]).toContain('{"status":"authenticated"}');
  expect(drifted[1]).toContain("Cursor failed");
  expect(drifted[1]).not.toContain("--force");
  expect(await readdir(`${home}/tmp`)).toEqual([]);
});

test("an existing chat id is resumed without create-chat", async () => {
  await mkdir(`${home}/session/cursor`, { recursive: true });
  await writeFile(`${home}/session/cursor/chat-id`, `${sessionId}\n`);
  const [code, output] = await run(cursorLaunchScript(empty, [], {}, session));
  expect(code).toBe(0);
  expect(argsOf(output)).toEqual(["--force", "--approve-mcps", "--sandbox", "disabled", "--resume", sessionId]);
  expect(await Bun.file(`${home}/created`).exists()).toBe(false);
  const script = cursorLaunchScript(empty, [], {}, session);
  expect(script).toContain("unset CURSOR_API_KEY");
  expect(script).toContain("https://cursor.com/install");
  expect(script).toContain(`'--resume' "$chat_id"`);
  for (const flag of ["--print", "--api-key", "--model", "--continue", "--resume=-1"]) expect(script).not.toContain(flag);
  expect(await readdir(`${home}/tmp`)).toEqual([]);
});

test("create-chat waits for a full line or process exit and removes temps when the id is rejected", async () => {
  await writeFile(`${home}/partial-create-chat`, "");
  const started = Date.now();
  const partial = await run(cursorLaunchScript(empty, [], {}, session));
  const elapsed = Date.now() - started;
  expect({ code: partial[0], error: partial[2] }).toEqual({ code: 0, error: "" });
  expect(elapsed).toBeGreaterThan(300);
  expect(elapsed).toBeLessThan(5000);
  expect(await readFile(`${home}/session/cursor/chat-id`, "utf8")).toBe(`${sessionId}\n`);
  expect(await readdir(`${home}/tmp`)).toEqual([]);
  await rm(`${home}/session/cursor/chat-id`);
  await rm(`${home}/partial-create-chat`);
  await writeFile(`${home}/exit-create-chat`, "");
  const exited = await run(cursorLaunchScript(empty, [], {}, session));
  expect(exited[0]).toBe(0);
  expect(await readFile(`${home}/session/cursor/chat-id`, "utf8")).toBe(`${sessionId}\n`);
  await rm(`${home}/session/cursor/chat-id`);
  await rm(`${home}/exit-create-chat`);
  await writeFile(`${home}/bad-create-chat`, "");
  const rejected = await run(cursorLaunchScript(empty, [], {}, session));
  expect(rejected[0]).not.toBe(0);
  expect(rejected[2]).toContain("not a UUID");
  expect(rejected[1]).toContain("Cursor failed");
  expect(await Bun.file(`${home}/session/cursor/chat-id`).exists()).toBe(false);
  expect(await Bun.file(`${home}/session/cursor/chat-id.next`).exists()).toBe(false);
  expect(await readdir(`${home}/tmp`)).toEqual([]);
});

test("first launch installs once, and a failed daily update still starts the installed agent", async () => {
  await mkdir(`${home}/session/cursor`, { recursive: true });
  await writeFile(`${home}/session/cursor/chat-id`, `${sessionId}\n`);
  await rm(`${home}/.local/bin/agent`);
  const results = await Promise.all([run(cursorLaunchScript(empty, [], {}, session)), run(cursorLaunchScript(empty, [], {}, session))]);
  for (const [code, output, error] of results) {
    expect({ code, error }).toEqual({ code: 0, error: "" });
    expect(argsOf(output)).toEqual(["--force", "--approve-mcps", "--sandbox", "disabled", "--resume", sessionId]);
  }
  expect(results.filter(([, output]) => output.includes("Installing latest Cursor into shared home…")).length).toBe(1);
  const installs = (await readFile(`${home}/installs`, "utf8")).trim().split("\n");
  expect(installs).toHaveLength(1);
  expect(installs[0]?.startsWith("-fsSL https://cursor.com/install -o ")).toBe(true);
  await writeFile(`${home}/fail-update`, "");
  await writeFile(`${home}/.cursor-agent-update-check`, String(Math.floor(Date.now() / 1000) - 90_000));
  const [code, output, error] = await run(cursorLaunchScript(empty, [], {}, session));
  expect(code).toBe(0);
  expect(error).toContain("update-failed");
  expect(output).toContain("Cursor update failed. Starting the installed version");
  expect(argsOf(output)).toEqual(["--force", "--approve-mcps", "--sandbox", "disabled", "--resume", sessionId]);
});
