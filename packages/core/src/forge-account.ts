import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cloudForge, cloudForges, type ForgeId } from "./cloud-forges.ts";
import { invalidArguments } from "./errors.ts";
import { getAgentsInTheCloudRuntimeContext } from "./runtime-context.ts";
import { Type } from "typebox";
import { Value } from "typebox/value";

declare const atlassianAccountEmailBrand: unique symbol;

export type AtlassianAccountEmail = string & { readonly [atlassianAccountEmailBrand]: true };

export type ForgeAccount =
  | { readonly forge: "github"; readonly token: string }
  | { readonly forge: "bitbucket"; readonly email: AtlassianAccountEmail; readonly token: string };

const bitbucketAccountFileSchema = Type.Object({
  email: Type.String(),
  token: Type.String(),
}, { additionalProperties: false });

function isAtlassianAccountEmail(value: string): value is AtlassianAccountEmail {
  if (!value || /\s/.test(value) || value.includes(":") || value.split("@").length !== 2) return false;
  const [local, domain] = value.split("@");
  return Boolean(local && domain);
}

export function parseAtlassianAccountEmail(value: string): AtlassianAccountEmail | undefined {
  const email = value.trim();
  return isAtlassianAccountEmail(email) ? email : undefined;
}

export function parseBitbucketToken(value: string): string | undefined {
  const token = value.trim();
  if (!token || /[\r\n]/.test(token)) return undefined;
  return token;
}

function workspaceFile(name: string): string {
  return join(getAgentsInTheCloudRuntimeContext().agentsInTheCloudDataDir, "workspace", name);
}

function readStoredBitbucketAccount(raw: string): ForgeAccount | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
  if (!Value.Check(bitbucketAccountFileSchema, parsed)) return undefined;
  const email = parseAtlassianAccountEmail(parsed.email);
  const token = parseBitbucketToken(parsed.token);
  if (!email || !token) return undefined;
  return { forge: "bitbucket", email, token };
}

export function bitbucketAccountFileIsUnreadable(): boolean {
  const path = workspaceFile(cloudForge("bitbucket").storeFile);
  if (!existsSync(path)) return false;
  const raw = readFileSync(path, "utf8");
  if (!raw.trim()) return false;
  return readStoredBitbucketAccount(raw) === undefined;
}

export function discoverForgeAccount(forgeId: ForgeId): ForgeAccount | undefined {
  const forge = cloudForge(forgeId);
  const path = workspaceFile(forge.storeFile);
  if (existsSync(path)) {
    const raw = readFileSync(path, "utf8");
    if (raw.trim()) {
      if (forge.id === "github") return { forge: "github", token: raw.trim() };
      return readStoredBitbucketAccount(raw);
    }
  }
  if (forge.id === "github") {
    if (existsSync(workspaceFile(forge.disabledFile))) return undefined;
    const token = process.env[forge.hostFallbackEnv]?.trim();
    return token ? { forge: "github", token } : undefined;
  }
  return undefined;
}

export function discoverForgeAccounts(): readonly ForgeAccount[] {
  return cloudForges.flatMap((forge) => {
    const account = discoverForgeAccount(forge.id);
    return account ? [account] : [];
  });
}

export function hasForgeAccount(forge: ForgeId): boolean {
  return Boolean(discoverForgeAccount(forge));
}

function writeTextAtomicSync(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${crypto.randomUUID()}`;
  try {
    writeFileSync(temporary, data, { mode: 0o600 });
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

export function setForgeAccount(account: ForgeAccount): void {
  switch (account.forge) {
    case "github": {
      const token = account.token.trim();
      if (!token) throw invalidArguments("GitHub token is empty.");
      const forge = cloudForge("github");
      const path = workspaceFile(forge.storeFile);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${token}\n`, { mode: 0o600 });
      rmSync(workspaceFile(forge.disabledFile), { force: true });
      return;
    }
    case "bitbucket": {
      const email = parseAtlassianAccountEmail(account.email);
      const token = parseBitbucketToken(account.token);
      if (!email || !token) throw invalidArguments("Bitbucket account is invalid.");
      const forge = cloudForge("bitbucket");
      writeTextAtomicSync(workspaceFile(forge.storeFile), `${JSON.stringify({ email, token }, null, 2)}\n`);
      return;
    }
    default: {
      const unreachable: never = account;
      throw new Error(`Unknown forge ${JSON.stringify(unreachable)}`);
    }
  }
}

export function clearForgeAccount(forgeId: ForgeId): void {
  const forge = cloudForge(forgeId);
  rmSync(workspaceFile(forge.storeFile), { force: true });
  if (forge.id !== "github") return;
  const disabledPath = workspaceFile(forge.disabledFile);
  mkdirSync(dirname(disabledPath), { recursive: true });
  writeFileSync(disabledPath, "", { mode: 0o600 });
}

export function clearForgeAccounts(): void {
  for (const forge of cloudForges) clearForgeAccount(forge.id);
}

export function forgeGitEnv(accounts: readonly ForgeAccount[]) {
  const connected = new Map(accounts.map((account) => [account.forge, account.token]));
  return {
    GH_TOKEN: connected.get("github") ?? "",
    BKT_TOKEN: connected.get("bitbucket") ?? "",
  };
}

export function forgePlainEnv(accounts: readonly ForgeAccount[]) {
  const env: Record<string, string> = {};
  for (const account of accounts) {
    if (account.forge === "github") continue;
    for (const entry of cloudForge(account.forge).plainEnv) {
      env[entry.name] = "literal" in entry ? entry.literal : account.email;
    }
  }
  return env;
}
