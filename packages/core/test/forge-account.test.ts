import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { forgeCredentialHelperShellBody } from "../src/cloud-forges.ts";
import {
  bitbucketAccountFileIsUnreadable,
  clearForgeAccount,
  discoverForgeAccount,
  discoverForgeAccounts,
  forgeGitEnv,
  forgePlainEnv,
  hasForgeAccount,
  parseAtlassianAccountEmail,
  setForgeAccount,
  type ForgeAccount,
} from "../src/forge-account.ts";

async function runCredentialHelper(input: string, env: Record<string, string>): Promise<string> {
  const proc = Bun.spawn(["sh", "-c", forgeCredentialHelperShellBody(), "agents-in-the-cloud-git-credential", "get"], {
    env: { ...process.env, ...env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(input);
  proc.stdin.end();
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (exitCode !== 0) throw new Error(stderr);
  return stdout;
}

function bitbucketAccount(email: string, token: string): Extract<ForgeAccount, { forge: "bitbucket" }> {
  const parsed = parseAtlassianAccountEmail(email);
  if (!parsed) throw new Error(`not an Atlassian email: ${email}`);
  setForgeAccount({ forge: "bitbucket", email: parsed, token });
  const stored = discoverForgeAccount("bitbucket");
  if (!stored || stored.forge !== "bitbucket") throw new Error("expected a stored Bitbucket account");
  return stored;
}

let previousDataDir: string | undefined;
let previousGitHubToken: string | undefined;
let previousBitbucketToken: string | undefined;
let previousBitbucketUsername: string | undefined;
let dataDir: string;

describe("forge accounts", () => {
  beforeEach(async () => {
    previousDataDir = process.env.ATELIER_DATA_DIR;
    previousGitHubToken = process.env.GH_TOKEN;
    previousBitbucketToken = process.env.BKT_TOKEN;
    previousBitbucketUsername = process.env.BKT_USERNAME;
    dataDir = await mkdtemp(join(tmpdir(), "agents-in-the-cloud-forge-account-"));
    process.env.ATELIER_DATA_DIR = dataDir;
    delete process.env.GH_TOKEN;
    delete process.env.BKT_TOKEN;
    delete process.env.BKT_USERNAME;
  });

  afterEach(async () => {
    clearForgeAccount("github");
    clearForgeAccount("bitbucket");
    if (previousDataDir === undefined) delete process.env.ATELIER_DATA_DIR;
    else process.env.ATELIER_DATA_DIR = previousDataDir;
    if (previousGitHubToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previousGitHubToken;
    if (previousBitbucketToken === undefined) delete process.env.BKT_TOKEN;
    else process.env.BKT_TOKEN = previousBitbucketToken;
    if (previousBitbucketUsername === undefined) delete process.env.BKT_USERNAME;
    else process.env.BKT_USERNAME = previousBitbucketUsername;
    await rm(dataDir, { recursive: true, force: true });
  });

  test("uses a stored GitHub token before the environment token", () => {
    process.env.GH_TOKEN = "env-token";
    setForgeAccount({ forge: "github", token: "stored-token" });

    expect(discoverForgeAccount("github")).toEqual({ forge: "github", token: "stored-token" });
    expect(hasForgeAccount("github")).toBe(true);
  });

  test("falls back to GH_TOKEN when no GitHub token is stored", () => {
    process.env.GH_TOKEN = " env-token ";

    expect(discoverForgeAccount("github")).toEqual({ forge: "github", token: "env-token" });
    expect(hasForgeAccount("github")).toBe(true);
  });

  test("disconnect suppresses a discovered GH_TOKEN until a token is connected again", () => {
    process.env.GH_TOKEN = "env-token";

    clearForgeAccount("github");
    expect(discoverForgeAccount("github")).toBeUndefined();
    expect(hasForgeAccount("github")).toBe(false);

    setForgeAccount({ forge: "github", token: "reconnected-token" });
    expect(discoverForgeAccount("github")).toEqual({ forge: "github", token: "reconnected-token" });
    expect(hasForgeAccount("github")).toBe(true);
  });

  test("falls back to GH_TOKEN when the stored GitHub token file is blank", async () => {
    const tokenPath = join(dataDir, "workspace", "github-token");
    await mkdir(dirname(tokenPath), { recursive: true });
    await writeFile(tokenPath, "\n");
    process.env.GH_TOKEN = "env-token";

    expect(discoverForgeAccount("github")).toEqual({ forge: "github", token: "env-token" });
  });

  test("treats a blank GH_TOKEN as missing", () => {
    process.env.GH_TOKEN = "  ";

    expect(discoverForgeAccount("github")).toBeUndefined();
    expect(hasForgeAccount("github")).toBe(false);
  });

  test("stored Bitbucket JSON wins over the environment pair", () => {
    process.env.BKT_TOKEN = "env-token";
    process.env.BKT_USERNAME = "env@example.com";
    const first = bitbucketAccount("ada@example.com", "first-token");
    setForgeAccount({ forge: "bitbucket", email: first.email, token: "second-token" });

    expect(discoverForgeAccount("bitbucket")).toEqual({ forge: "bitbucket", email: first.email, token: "second-token" });
    const file = readFileSync(join(dataDir, "workspace", "bitbucket-account"), "utf8");
    expect(JSON.parse(file)).toEqual({ email: "ada@example.com", token: "second-token" });
    expect(statSync(join(dataDir, "workspace", "bitbucket-account")).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(dataDir, "workspace")).some((name) => name.includes(".tmp-"))).toBe(false);
  });

  test("a Bitbucket disable marker suppresses the environment pair", () => {
    process.env.BKT_TOKEN = "env-token";
    process.env.BKT_USERNAME = "ada@example.com";

    clearForgeAccount("bitbucket");
    expect(discoverForgeAccount("bitbucket")).toBeUndefined();
    expect(hasForgeAccount("bitbucket")).toBe(false);

    clearForgeAccount("bitbucket");
    expect(discoverForgeAccount("bitbucket")).toBeUndefined();
  });

  test("a Bitbucket token without an email is not an account", () => {
    process.env.BKT_TOKEN = "env-token";

    expect(discoverForgeAccount("bitbucket")).toBeUndefined();
  });

  test("a Bitbucket email without a token is not an account", () => {
    process.env.BKT_USERNAME = "ada@example.com";

    expect(discoverForgeAccount("bitbucket")).toBeUndefined();
  });

  test("an environment pair that fails the email parser is not an account", () => {
    process.env.BKT_TOKEN = "env-token";
    process.env.BKT_USERNAME = "ada:example.com";

    expect(discoverForgeAccount("bitbucket")).toBeUndefined();
  });

  test("a blank Bitbucket account file is not an account", () => {
    const path = join(dataDir, "workspace", "bitbucket-account");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "\n");
    process.env.BKT_TOKEN = " env-token ";
    process.env.BKT_USERNAME = " ada@example.com ";

    expect(discoverForgeAccount("bitbucket")).toBeUndefined();
    expect(bitbucketAccountFileIsUnreadable()).toBe(false);
  });

  test("a corrupt Bitbucket account file leaves GitHub discovery working", () => {
    setForgeAccount({ forge: "github", token: "gh-token" });
    const path = join(dataDir, "workspace", "bitbucket-account");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{");

    expect(discoverForgeAccount("github")).toEqual({ forge: "github", token: "gh-token" });
    expect(discoverForgeAccounts().map((account) => account.forge)).toEqual(["github"]);
    expect(discoverForgeAccount("bitbucket")).toBeUndefined();
    expect(bitbucketAccountFileIsUnreadable()).toBe(true);
  });

  test("Bitbucket does not take an account from BKT_TOKEN and BKT_USERNAME", () => {
    process.env.BKT_TOKEN = "env-token";
    process.env.BKT_USERNAME = "ada@example.com";

    expect(discoverForgeAccount("bitbucket")).toBeUndefined();
    expect(hasForgeAccount("bitbucket")).toBe(false);
  });

  test("malformed Bitbucket JSON is not an account", () => {
    const path = join(dataDir, "workspace", "bitbucket-account");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{");

    expect(discoverForgeAccount("bitbucket")).toBeUndefined();
    expect(bitbucketAccountFileIsUnreadable()).toBe(true);
  });

  test("a Bitbucket account file that fails the schema is not an account", () => {
    const path = join(dataDir, "workspace", "bitbucket-account");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ email: "ada@example.com", token: "tok", extra: true })}\n`);

    expect(discoverForgeAccount("bitbucket")).toBeUndefined();
    expect(bitbucketAccountFileIsUnreadable()).toBe(true);
  });

  test("refuses an empty GitHub token and an invalid Bitbucket account", () => {
    expect(() => setForgeAccount({ forge: "github", token: "  " })).toThrow("GitHub token is empty.");
    expect(discoverForgeAccount("github")).toBeUndefined();
    const stored = bitbucketAccount("ada@example.com", "token");
    expect(() => setForgeAccount({ forge: "bitbucket", email: stored.email, token: "bad\ntoken" })).toThrow("Bitbucket account is invalid.");
    expect(discoverForgeAccount("bitbucket")).toEqual(stored);
  });

  test("credential helper supplies each token only to that forge's HTTPS git host", async () => {
    const env = { GH_TOKEN: "secret-token", BKT_TOKEN: "bkt-secret", BKT_USERNAME: "ada@example.com" };
    expect(await runCredentialHelper("protocol=https\nhost=github.com\n\n", env)).toBe("username=x-access-token\npassword=secret-token\n");
    expect(await runCredentialHelper("protocol=https\nhost=github.com:443\n\n", env)).toBe("username=x-access-token\npassword=secret-token\n");
    expect(await runCredentialHelper("protocol=https\nhost=bitbucket.org\n\n", env)).toBe("username=x-bitbucket-api-token-auth\npassword=bkt-secret\n");
    expect(await runCredentialHelper("protocol=https\nhost=bitbucket.org:443\n\n", env)).toBe("username=x-bitbucket-api-token-auth\npassword=bkt-secret\n");
    expect(await runCredentialHelper("protocol=https\nhost=api.bitbucket.org\n\n", env)).toBe("");
    expect(await runCredentialHelper("protocol=https\nhost=example.com\n\n", env)).toBe("");
    expect(await runCredentialHelper("protocol=ssh\nhost=bitbucket.org\n\n", env)).toBe("");
    expect(await runCredentialHelper("protocol=https\nhost=Bitbucket.org\n\n", env)).toBe("");
  });

  test("host git env carries tokens and Bitbucket plain env carries the email", () => {
    setForgeAccount({ forge: "github", token: "gh-secret" });
    const bitbucket = bitbucketAccount("ada@example.com", "bkt-secret");
    const accounts = discoverForgeAccounts();

    expect(accounts.map((account) => account.forge)).toEqual(["github", "bitbucket"]);
    expect(forgeGitEnv(accounts)).toEqual({ GH_TOKEN: "gh-secret", BKT_TOKEN: "bkt-secret" });
    expect(forgePlainEnv(accounts)).toEqual({
      BKT_HOST: "https://bitbucket.org",
      BKT_USERNAME: "ada@example.com",
      BKT_AUTH_METHOD: "basic",
    });
    expect(forgePlainEnv([bitbucket])).not.toHaveProperty("BKT_TOKEN");
    expect(forgeGitEnv([])).toEqual({});
  });
});
