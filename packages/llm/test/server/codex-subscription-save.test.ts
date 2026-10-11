import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { CodexSubscription } from "../../src/server/codex-subscription.ts";
import { ProviderCatalogueRefreshError, saveCodexSubscription } from "../../src/server/pi-config-models.ts";

let directory: string | undefined;
let previous: string | undefined;

afterEach(async () => {
  if (previous === undefined) delete process.env.ATELIER_DATA_DIR;
  else process.env.ATELIER_DATA_DIR = previous;
  if (directory) await rm(directory, { recursive: true, force: true });
});

function jwt(account: string, exp: number): string {
  const payload = { exp, "https://api.openai.com/auth": { chatgpt_account_id: account } };
  return `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.real-signature`;
}

test("saveCodexSubscription keeps the credential when catalogue refresh fails and skips a repeat write", async () => {
  previous = process.env.ATELIER_DATA_DIR;
  directory = await mkdtemp(join(tmpdir(), "agents-in-the-cloud-codex-save-"));
  process.env.ATELIER_DATA_DIR = directory;
  const account = "acct_saved";
  const exp = 1_900_000_000;
  const access = jwt(account, exp);
  const subscription = CodexSubscription.parse(JSON.stringify({
    access_token: access,
    refresh_token: "refresh-saved",
    expires_in: 60,
  }));
  const original = ModelRuntime.prototype.refresh;
  let refreshes = 0;
  const refresh = spyOn(ModelRuntime.prototype, "refresh").mockImplementation(function (this: ModelRuntime, options?: Parameters<ModelRuntime["refresh"]>[0]) {
    refreshes += 1;
    if (refreshes === 1) return original.call(this, options);
    if (refreshes === 2) throw new Error("catalogue down");
    return { aborted: false, errors: new Map() };
  });
  const authPath = join(directory, "pi-config", "auth.json");
  try {
    let failure: unknown;
    try {
      await saveCodexSubscription(subscription);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ProviderCatalogueRefreshError);
    expect(JSON.parse(await readFile(authPath, "utf8"))["openai-codex"]).toEqual({
      type: "oauth",
      access,
      refresh: "refresh-saved",
      expires: 1_900_000_000_000,
      accountId: account,
    });
    const bytes = await readFile(authPath, "utf8");
    await saveCodexSubscription(subscription);
    expect(await readFile(authPath, "utf8")).toBe(bytes);
  } finally {
    refresh.mockRestore();
  }
});
