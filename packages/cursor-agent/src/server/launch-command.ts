import { shellQuote } from "@agents-in-the-cloud/core";
import { cliPromptText, type CliAgentSession } from "@agents-in-the-cloud/cli-agent/server";
import type { AgentWorkspaceParameters, WorkspaceAgentInput } from "@agents-in-the-cloud/shared";
import { workspaceRoot } from "@agents-in-the-cloud/workspace";

const installerUrl = "https://cursor.com/install";

export function cursorLaunchScript(input: WorkspaceAgentInput, imagePaths: string[], _settings: AgentWorkspaceParameters, session: CliAgentSession): string {
  const prompt = cliPromptText(input, imagePaths.map(path => `Read the attached image at ${JSON.stringify(path)}.`));
  const fixed = ["--force", "--approve-mcps", "--sandbox", "disabled"];
  const tail = prompt ? ["--", prompt] : [];
  const execArgs = `${fixed.map(shellQuote).join(" ")} '--resume' "$chat_id"${tail.length ? ` ${tail.map(shellQuote).join(" ")}` : ""}`;
  const chatFile = shellQuote(`${session.directory}/cursor/chat-id`);
  const discoverChat = `
mkdir -p "$(dirname ${chatFile})"
if [ -f ${chatFile} ]; then
  chat_id="$(node "$runtime" accept-chat-id < ${chatFile})"
else
  chat_tmp="$(mktemp)"
  setsid "$executable" create-chat > "$chat_tmp" < /dev/null &
  chat_pid=$!
  ready=0
  i=0
  # 0.1s * 1200: a slow first login can take longer than a few seconds, and a partial write is not an id.
  while [ "$i" -lt 1200 ]; do
    if [ -s "$chat_tmp" ] && tail -c 1 "$chat_tmp" | grep -q '^$'; then ready=1; break; fi
    if ! kill -0 "$chat_pid" 2>/dev/null; then
      if [ -s "$chat_tmp" ]; then ready=1; fi
      break
    fi
    i=$((i + 1))
    sleep 0.1
  done
  if [ "$ready" -ne 1 ]; then
    printf '%s\\n' 'Cursor create-chat did not print a chat id.' >&2
    exit 1
  fi
  if kill -0 "$chat_pid" 2>/dev/null; then
    kill -TERM -"$chat_pid" 2>/dev/null || true
    wait "$chat_pid" 2>/dev/null || true
  fi
  chat_pid=""
  chat_next=${chatFile}.next
  node "$runtime" accept-chat-id < "$chat_tmp" > "$chat_next"
  mv "$chat_next" ${chatFile}
  chat_next=""
  chmod 600 ${chatFile}
  chat_id="$(node "$runtime" accept-chat-id < ${chatFile})"
  rm -f "$chat_tmp"
  chat_tmp=""
fi`;
  return `set -eu
failure_message=${shellQuote("\nCursor failed (exit %s). See the error above.\n")}
chat_pid=""
status_err=""
chat_tmp=""
chat_next=""
trap 'code=$?; if [ -n "$chat_pid" ]; then kill -TERM -"$chat_pid" 2>/dev/null || true; fi; rm -f "$status_err" "$chat_tmp" "$chat_next"; if [ "$code" -ne 0 ]; then printf "$failure_message" "$code"; fi' EXIT
unset CURSOR_API_KEY
(
  flock 9
  cd "$HOME"
  executable="$HOME/.local/bin/agent"
  stamp="$HOME/.cursor-agent-update-check"
  now="$(date +%s)"
  checked=0
  if [ -f "$stamp" ]; then checked="$(cat "$stamp")"; fi
  if [ ! -x "$executable" ]; then
    printf '%s\\n' 'Installing latest Cursor into shared home…'
    staging="$(mktemp -d "$HOME/.cursor-agent-install.XXXXXX")"
    trap 'rm -rf "$staging"' EXIT
    curl -fsSL ${shellQuote(installerUrl)} -o "$staging/install.sh"
    PATH="$HOME/.local/bin:/usr/bin:/bin" setsid --wait sh "$staging/install.sh" </dev/null
    test -x "$executable"
    printf '%s\\n' "$now" > "$stamp"
  elif [ "$((now - checked))" -ge 86400 ]; then
    printf '%s\\n' 'Checking for Cursor updates…'
    if "$executable" update; then
      printf '%s\\n' "$now" > "$stamp"
    else
      printf '%s\\n' 'Cursor update failed. Starting the installed version; we’ll retry next launch.'
    fi
  fi
) 9>"$HOME/.cursor-agent-install.lock"
executable="$HOME/.local/bin/agent"
runtime="$HOME/.cursor/agents-in-the-cloud/runtime.mjs"
status_err="$(mktemp)"
status_rc=0
status_out="$("$executable" status --format json 2>"$status_err")" || status_rc=$?
auth_rc=0
printf '%s' "$status_out" | node "$runtime" auth-status || auth_rc=$?
if [ "$auth_rc" -eq 10 ]; then
  printf '%s\\n' 'Cursor needs a login. Finish it in this pane.'
  NO_OPEN_BROWSER=1 "$executable" login
elif [ "$auth_rc" -ne 0 ]; then
  printf '%s\\n' "Cursor status could not be read (agent exit $status_rc, helper exit $auth_rc)."
  printf '%s\\n' "$status_out"
  cat "$status_err" >&2
  exit 1
fi
rm -f "$status_err"
status_err=""
export PATH="$HOME/.local/bin:$PATH"
cd ${shellQuote(workspaceRoot)}
${discoverChat}
# A pipe on this process selects print mode.
exec "$executable" ${execArgs}
`;
}
