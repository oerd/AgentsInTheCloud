import { parseAtlassianAccountEmail, parseBitbucketToken, type ForgeAccount } from "@agents-in-the-cloud/core";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

export type ForgeAccountInput =
  | { readonly forge: "github"; readonly token: string }
  | { readonly forge: "bitbucket"; readonly email: string; readonly token: string };

export type ForgeAccountValidation =
  | { readonly ok: true; readonly account: ForgeAccount; readonly commitName: string; readonly commitEmail: string }
  | { readonly ok: false; readonly message: string };

const githubUserResponseSchema = Type.Object({
  id: Type.Integer(),
  login: Type.String({ minLength: 1, pattern: "\\S" }),
  name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  email: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

const githubEmailResponseSchema = Type.Array(Type.Object({
  email: Type.String({ minLength: 1, pattern: "\\S" }),
  primary: Type.Boolean(),
  verified: Type.Boolean(),
}));

const bitbucketUserResponseSchema = Type.Object({
  display_name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  username: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

function optionalTrimmed(value: string | null | undefined): string | undefined {
  return value?.trim() || undefined;
}

async function decodeJsonResponse<Schema extends TSchema>(response: Response, schema: Schema): Promise<Static<Schema> | undefined> {
  try {
    const encoded: unknown = await response.json();
    return Value.Parse(schema, encoded);
  } catch {
    return undefined;
  }
}

function githubHeaders(token: string): HeadersInit {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "user-agent": "agents-in-the-cloud",
    "x-github-api-version": "2022-11-28",
  };
}

async function fetchPrimaryGitHubEmail(token: string): Promise<string | undefined> {
  try {
    const response = await fetch("https://api.github.com/user/emails", { headers: githubHeaders(token) });
    if (!response.ok) return undefined;
    const emails = await decodeJsonResponse(response, githubEmailResponseSchema);
    if (!emails) return undefined;
    for (const email of emails) {
      if (email.primary && email.verified) return email.email.trim();
    }
    return undefined;
  } catch {
    return undefined;
  }
}

async function validateGitHubAccount(token: string): Promise<ForgeAccountValidation> {
  const trimmed = token.trim();
  if (!trimmed) return { ok: false, message: "Enter a GitHub token." };

  let response: Response;
  try {
    response = await fetch("https://api.github.com/user", { headers: githubHeaders(trimmed) });
  } catch {
    return { ok: false, message: "Could not reach GitHub. Check your network and try again." };
  }

  if (response.status === 401 || response.status === 403) return { ok: false, message: "GitHub rejected that token. Check that it is active and has repository read access." };
  if (!response.ok) return { ok: false, message: `GitHub token validation failed (${response.status}). Try again.` };

  const body = await decodeJsonResponse(response, githubUserResponseSchema);
  if (!body) return { ok: false, message: "GitHub returned an invalid user response. Try again." };
  const login = body.login.trim();
  const commitName = optionalTrimmed(body.name) ?? login;
  const commitEmail = optionalTrimmed(body.email) ?? await fetchPrimaryGitHubEmail(trimmed) ?? `${body.id}+${login}@users.noreply.github.com`;
  return { ok: true, account: { forge: "github", token: trimmed }, commitName, commitEmail };
}

async function validateBitbucketAccount(emailInput: string, tokenInput: string): Promise<ForgeAccountValidation> {
  const token = parseBitbucketToken(tokenInput);
  if (!token) return { ok: false, message: "Enter a Bitbucket API token." };
  const email = parseAtlassianAccountEmail(emailInput);
  if (!email) return { ok: false, message: "Use the Atlassian account email for that token." };

  let response: Response;
  try {
    response = await fetch("https://api.bitbucket.org/2.0/user", {
      headers: {
        accept: "application/json",
        authorization: `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`,
      },
    });
  } catch {
    return { ok: false, message: "Could not reach Bitbucket. Check your network and try again." };
  }

  if (response.status === 401 || response.status === 403) return { ok: false, message: "Bitbucket rejected that email and token. Check that the token is active and can read repositories." };
  if (!response.ok) return { ok: false, message: `Bitbucket token validation failed (${response.status}). Try again.` };

  const body = await decodeJsonResponse(response, bitbucketUserResponseSchema);
  if (!body) return { ok: false, message: "Bitbucket returned an invalid user response. Try again." };
  const localPart = email.split("@")[0] ?? email;
  const commitName = optionalTrimmed(body.display_name) ?? optionalTrimmed(body.username) ?? localPart;
  return { ok: true, account: { forge: "bitbucket", email, token }, commitName, commitEmail: email };
}

export async function validateForgeAccount(input: ForgeAccountInput): Promise<ForgeAccountValidation> {
  switch (input.forge) {
    case "github":
      return validateGitHubAccount(input.token);
    case "bitbucket":
      return validateBitbucketAccount(input.email, input.token);
    default: {
      const unreachable: never = input;
      throw new Error(`Unknown forge ${JSON.stringify(unreachable)}`);
    }
  }
}
