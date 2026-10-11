import { isJsonObject, type JsonObject, type JsonValue } from "@agents-in-the-cloud/core";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { codexAccountId, codexTokenClaims } from "./codex-token.ts";

export const codexProviderId = "openai-codex" as const;

const emptyPaste = "Paste a ChatGPT sign-in.";
const notJson = "That isn't JSON.";
const tooLarge = "That JSON is too large to be a ChatGPT sign-in.";
const mixedPaste = "That JSON mixes two sign-ins. Paste one.";
const badCodexEntry = "That ChatGPT entry isn't a sign-in.";
const accountMismatch = "The account id in that JSON doesn't match the access token.";
const missingAccount = "That access token has no ChatGPT account.";
const badExpires = "That sign-in's expiry isn't a millisecond timestamp.";
const missingExpiry = "That access token has no expiry.";
const missingTokens = "Paste a ChatGPT sign-in with an access token and a refresh token.";

const maxPasteBytes = 256 * 1024;
const earliestMillisecondTimestamp = 1e12;
const expClaim = Type.Object({ exp: Type.Number() });
const nonEmptyString = Type.String({ minLength: 1 });
const finiteNumber = Type.Number();

type CodexEnvelope = "codex" | "tokens" | "response" | "direct";

const foreignKeys = {
  codex: ["tokens", "access", "refresh", "access_token", "refresh_token"],
  tokens: ["access_token", "refresh_token", "access", "refresh"],
  response: ["tokens", "access", "refresh"],
  direct: [],
} as const;

export class CodexPasteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexPasteError";
  }
}

export class CodexSubscription {
  private constructor(
    readonly access: string,
    readonly refresh: string,
    readonly expiresAtMs: number,
    readonly accountId: string,
  ) {}

  static parse(pasted: string): CodexSubscription {
    if (Buffer.byteLength(pasted) > maxPasteBytes) throw new CodexPasteError(tooLarge);
    if (pasted.trim() === "") throw new CodexPasteError(emptyPaste);
    let parsed: unknown;
    try {
      parsed = JSON.parse(pasted);
    } catch {
      throw new CodexPasteError(notJson);
    }
    if (!isJsonObject(parsed)) throw new CodexPasteError(emptyPaste);
    const envelope = chooseEnvelope(parsed);
    if (envelope === "codex") return fromCodexEntry(parsed[codexProviderId]);
    if (envelope === "tokens") return fromTokens(parsed);
    if (envelope === "response") return fromFields(parsed, "access_token", "refresh_token");
    return fromFields(parsed, "access", "refresh");
  }
}

function chooseEnvelope(root: JsonObject): CodexEnvelope {
  const envelopes = indicatedEnvelopes(root);
  if (envelopes.length > 1) throw new CodexPasteError(mixedPaste);
  if (envelopes.length === 0) throw new CodexPasteError(emptyPaste);
  const envelope = envelopes[0]!;
  if (foreignKeys[envelope].some((key) => key in root)) throw new CodexPasteError(mixedPaste);
  return envelope;
}

function indicatedEnvelopes(root: JsonObject): CodexEnvelope[] {
  const envelopes: CodexEnvelope[] = [];
  if (isJsonObject(root[codexProviderId])) envelopes.push("codex");
  const tokens = root.tokens;
  if (isJsonObject(tokens) && "access_token" in tokens && "refresh_token" in tokens) envelopes.push("tokens");
  if ("access_token" in root || "refresh_token" in root) envelopes.push("response");
  if (("access" in root || "refresh" in root) && (!("type" in root) || root.type === "oauth")) envelopes.push("direct");
  return envelopes;
}

function fromCodexEntry(value: JsonValue | undefined): CodexSubscription {
  if (!isJsonObject(value)) throw new CodexPasteError(badCodexEntry);
  const access = token(value.access);
  const refresh = token(value.refresh);
  if ((!("type" in value) || value.type === "oauth") && access && refresh) return finish(access, refresh, value, ["accountId"]);
  throw new CodexPasteError(badCodexEntry);
}

function fromTokens(root: JsonObject): CodexSubscription {
  const tokens = root.tokens;
  if (!isJsonObject(tokens)) throw new CodexPasteError(missingTokens);
  const access = token(tokens.access_token);
  const refresh = token(tokens.refresh_token);
  if (!access || !refresh) throw new CodexPasteError(missingTokens);
  return finish(access, refresh, tokens, ["account_id", "accountId"]);
}

function fromFields(root: JsonObject, accessKey: string, refreshKey: string): CodexSubscription {
  const access = token(root[accessKey]);
  const refresh = token(root[refreshKey]);
  if (!access || !refresh) throw new CodexPasteError(missingTokens);
  return finish(access, refresh, root, ["accountId"]);
}

function finish(access: string, refresh: string, envelope: JsonObject, accountKeys: readonly string[]): CodexSubscription {
  return new CodexSubscription(access, refresh, expiresAt(envelope, access), account(access, present(envelope, accountKeys)));
}

function present(record: JsonObject, keys: readonly string[]): JsonValue[] {
  const values: JsonValue[] = [];
  for (const key of keys) if (key in record) values.push(record[key]);
  return values;
}

function account(access: string, pasted: readonly JsonValue[]): string {
  let accountId: string;
  try {
    accountId = codexAccountId(access);
  } catch {
    throw new CodexPasteError(missingAccount);
  }
  if (pasted.some((candidate) => candidate !== accountId)) throw new CodexPasteError(accountMismatch);
  return accountId;
}

function expiresAt(envelope: JsonObject, access: string): number {
  if (!("expires" in envelope)) return expiresFromAccess(access);
  const expires = envelope.expires;
  if (Value.Check(finiteNumber, expires) && Number.isFinite(expires) && expires >= earliestMillisecondTimestamp) return expires;
  throw new CodexPasteError(badExpires);
}

function expiresFromAccess(access: string): number {
  let exp: number;
  try {
    exp = codexTokenClaims(access, expClaim).exp;
  } catch {
    throw new CodexPasteError(missingExpiry);
  }
  if (!Number.isFinite(exp)) throw new CodexPasteError(missingExpiry);
  return exp * 1000;
}

function token(value: JsonValue | undefined): string | undefined {
  return Value.Check(nonEmptyString, value) ? value : undefined;
}
