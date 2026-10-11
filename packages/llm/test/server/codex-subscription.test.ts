import { expect, test } from "bun:test";
import { CodexPasteError, CodexSubscription } from "../../src/server/codex-subscription.ts";

function jwt(account: string, exp?: number): string {
  const claims = { "https://api.openai.com/auth": { chatgpt_account_id: account } };
  const payload = exp === undefined ? claims : { exp, ...claims };
  return `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.real-signature`;
}

function parseError(pasted: string): CodexPasteError {
  try {
    CodexSubscription.parse(pasted);
  } catch (error) {
    if (error instanceof CodexPasteError) return error;
    throw error;
  }
  throw new Error("CodexSubscription.parse returned a subscription");
}

test("an OAuth token response expires from the access token exp claim", () => {
  const exp = 1_700_000_000;
  const account = "acct_chatgpt";
  const access = jwt(account, exp);
  const pasted = JSON.stringify({ access_token: access, refresh_token: "refresh-1", expires_in: 1, token_type: "bearer" });
  const now = Date.now;
  Date.now = () => 50_000;
  try {
    const first = CodexSubscription.parse(pasted);
    const second = CodexSubscription.parse(pasted);
    expect(second).toEqual(first);
    expect(first.expiresAtMs).toBe(1_700_000_000_000);
    expect(first.access).toBe(access);
    expect(first.refresh).toBe("refresh-1");
    expect(first.accountId).toBe(account);
  } finally {
    Date.now = now;
  }
});

test("an auth.json openai-codex entry keeps its millisecond expiry beside another provider", () => {
  const account = "acct_file";
  const access = jwt(account, 1_800_000_000);
  const pasted = JSON.stringify({
    "openai-codex": { type: "oauth", access, refresh: "refresh-codex", expires: 1_713_000_000_000, accountId: account },
    anthropic: { type: "oauth", access: "sibling-access", refresh: "sibling-refresh", expires: 1 },
  });
  const subscription = CodexSubscription.parse(pasted);
  expect(subscription).toEqual(CodexSubscription.parse(pasted));
  expect(subscription.expiresAtMs).toBe(1_713_000_000_000);
  expect(subscription.access).toBe(access);
  expect(subscription.refresh).toBe("refresh-codex");
  expect(subscription.accountId).toBe(account);
});

test("a Codex CLI tokens object uses the access token exp claim", () => {
  const exp = 1_750_000_000;
  const account = "acct_cli";
  const access = jwt(account, exp);
  const pasted = JSON.stringify({
    auth_mode: "chatgpt",
    tokens: { id_token: "id", access_token: access, refresh_token: "refresh-cli", account_id: account },
    last_refresh: "2099-01-01T00:00:00Z",
  });
  const subscription = CodexSubscription.parse(pasted);
  expect(subscription.expiresAtMs).toBe(1_750_000_000_000);
  expect(subscription.access).toBe(access);
  expect(subscription.refresh).toBe("refresh-cli");
  expect(subscription.accountId).toBe(account);
});

test("a pasted account id that disagrees with the access token is rejected", () => {
  const pasted = JSON.stringify({
    tokens: { access_token: jwt("acct_real", 1_760_000_000), refresh_token: "refresh-cli", account_id: "acct_other" },
  });
  const error = parseError(pasted);
  expect(error.name).toBe("CodexPasteError");
  expect(error.message).toBe("The account id in that JSON doesn't match the access token.");
});

test("openai-codex and tokens in one object are rejected", () => {
  const access = jwt("acct_mixed", 1_760_000_000);
  const pasted = JSON.stringify({
    "openai-codex": { access, refresh: "refresh-codex", expires: 1_713_000_000_000 },
    tokens: { access_token: access, refresh_token: "refresh-cli" },
  });
  expect(parseError(pasted).message).toBe("That JSON mixes two sign-ins. Paste one.");
});

test("invalid JSON is rejected without echoing the paste", () => {
  const pasted = "{not-json secret-marker";
  const error = parseError(pasted);
  expect(error.message).toBe("That isn't JSON.");
  expect(error.message.includes(pasted)).toBe(false);
});

test("an empty paste and a sign-in with no envelope ask for a ChatGPT sign-in", () => {
  expect(parseError("  ").message).toBe("Paste a ChatGPT sign-in.");
  expect(parseError("{}").message).toBe("Paste a ChatGPT sign-in.");
});

test("a paste over 256 KiB is rejected", () => {
  expect(parseError("x".repeat(256 * 1024 + 1)).message).toBe("That JSON is too large to be a ChatGPT sign-in.");
});

test("a bad openai-codex entry does not fall through to another reading", () => {
  const pasted = JSON.stringify({ "openai-codex": { type: "api_key", key: "secret" } });
  expect(parseError(pasted).message).toBe("That ChatGPT entry isn't a sign-in.");
});

test("a seconds expiry and a token with no exp claim are rejected", () => {
  const access = jwt("acct_exp", 1_760_000_000);
  expect(parseError(JSON.stringify({ access_token: access, refresh_token: "refresh-1", expires: 1_760_000_000 })).message).toBe("That sign-in's expiry isn't a millisecond timestamp.");
  expect(parseError(JSON.stringify({ access_token: jwt("acct_exp"), refresh_token: "refresh-1" })).message).toBe("That access token has no expiry.");
});

test("a response missing a refresh token is rejected", () => {
  expect(parseError(JSON.stringify({ access_token: jwt("acct_exp", 1_760_000_000) })).message).toBe("Paste a ChatGPT sign-in with an access token and a refresh token.");
});
