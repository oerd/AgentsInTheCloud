import { createHash } from "node:crypto";
import { contentRowHtml } from "@agents-in-the-cloud/design-system/content-row";
import { autocompleteHtml } from "@agents-in-the-cloud/design-system/autocomplete";
import { discoverForgeAccounts, type ForgeAccount, type ForgeId } from "@agents-in-the-cloud/core";
import { escapeHtml } from "@agents-in-the-cloud/shared";
import { Type, type Static, type TSchema } from "typebox";
import { bitbucketBasicAuthorization, decodeResponseJson } from "./forge-http.ts";

export interface RepositoryHit {
  readonly forge: ForgeId;
  readonly fullName: string;
  readonly description: string | null;
  readonly private: boolean;
  readonly cloneUrl: string;
  readonly personal: boolean;
}

export interface RepositorySearchGroup {
  readonly forge: ForgeId;
  readonly heading: string;
  readonly repositories: readonly RepositoryHit[];
  readonly notice?: string;
  readonly attempted: boolean;
  readonly rateLimit?: { readonly retryAfterSeconds?: number };
}

export interface RepositorySearchResults {
  readonly groups: readonly RepositorySearchGroup[];
}

const githubRepositorySearchResponseSchema = Type.Object({
  items: Type.Array(Type.Object({
    full_name: Type.String(),
    description: Type.Union([Type.String(), Type.Null()]),
    private: Type.Boolean(),
    clone_url: Type.String(),
  })),
});

const bitbucketRepositorySearchResponseSchema = Type.Object({
  values: Type.Array(Type.Object({
    full_name: Type.String(),
    description: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    is_private: Type.Boolean(),
    links: Type.Optional(Type.Object({
      clone: Type.Optional(Type.Array(Type.Object({
        name: Type.Optional(Type.String()),
        href: Type.Optional(Type.String()),
      }))),
    })),
  })),
});

const searchCacheMs = 60_000;

class RepositorySearchRateLimitError extends Error {
  constructor(message: string, readonly retryAfterSeconds?: number) {
    super(message);
    this.name = "RepositorySearchRateLimitError";
  }
}

class RepositorySearchRejectedError extends Error {}

type PageOutcome =
  | { kind: "hits"; repositories: RepositoryHit[] }
  | { kind: "notice"; notice: string; attempted: boolean; rateLimit?: { retryAfterSeconds?: number } };

const pageCache = new Map<string, { expiresAt: number; outcome: PageOutcome }>();
const ownerCache = new Map<string, { expiresAt: number; owners: string[] }>();

function credentialKey(token: string | undefined): string {
  return token ? createHash("sha256").update(token).digest("hex") : "public";
}

function pageCacheKey(forge: ForgeId, credential: string, query: string, kind: "personal" | "public"): string {
  return `${forge}:${credential}:${query.trim().toLowerCase()}:${kind}`;
}

function remember(key: string, outcome: PageOutcome): PageOutcome {
  const now = Date.now();
  for (const [cacheKey, entry] of pageCache) if (entry.expiresAt <= now) pageCache.delete(cacheKey);
  pageCache.set(key, { expiresAt: now + searchCacheMs, outcome });
  return outcome;
}

function cachedPage(key: string): PageOutcome | undefined {
  const cached = pageCache.get(key);
  if (!cached || cached.expiresAt <= Date.now()) return undefined;
  return cached.outcome;
}

function stripCloneUserinfo(cloneUrl: string): string {
  const url = new URL(cloneUrl);
  url.username = "";
  url.password = "";
  return url.toString();
}

function bitbucketCloneUrl(fullName: string, links: { clone?: { name?: string; href?: string }[] } | undefined): string {
  const fallback = `https://bitbucket.org/${fullName}.git`;
  const href = links?.clone?.find((link) => link.name === "https")?.href
    ?? links?.clone?.find((link) => link.href?.startsWith("https://"))?.href;
  if (!href) return fallback;
  try {
    const url = new URL(href);
    if (url.protocol !== "https:") return fallback;
    return stripCloneUserinfo(url.toString());
  } catch {
    return fallback;
  }
}

function bitbucketNameQuery(query: string): string {
  const escaped = query.replace(/\r\n|[\r\n]/g, " ").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `name~"${escaped}"`;
}

function retryAfterSeconds(response: Response): number | undefined {
  return Number(response.headers.get("retry-after") ?? undefined) || undefined;
}

async function fetchSearch(url: URL, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (error) {
    if (error instanceof TypeError) throw new RepositorySearchRejectedError(error.message);
    throw error;
  }
}

async function fetchGitHub(url: URL, token: string | undefined): Promise<Response> {
  const headers: HeadersInit = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetchSearch(url, { headers });
  if (!response.ok) {
    const message = await response.text();
    if (response.status === 429 || (response.status === 403 && (response.headers.get("x-ratelimit-remaining") === "0" || /rate limit/i.test(message)))) {
      throw new RepositorySearchRateLimitError(`GitHub repository search failed: ${response.status} ${message}`, retryAfterSeconds(response));
    }
    throw new RepositorySearchRejectedError(`GitHub repository search failed: ${response.status} ${message}`);
  }
  return response;
}

async function repositoryOwners(token: string): Promise<string[]> {
  const key = credentialKey(token);
  const cached = ownerCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.owners;
  const userSchema = Type.Object({ login: Type.String() });
  const user = await readSearchBody(await fetchGitHub(new URL("https://api.github.com/user"), token), userSchema, "GitHub account lookup returned an unreadable response.");
  const owners = [user.login];
  for (let page = 1; ; page++) {
    const url = new URL("https://api.github.com/user/orgs");
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(page));
    const orgs = await readSearchBody(await fetchGitHub(url, token), Type.Array(userSchema), "GitHub account lookup returned an unreadable response.");
    owners.push(...orgs.map((org) => org.login));
    if (orgs.length < 100) break;
  }
  for (const [cacheKey, entry] of ownerCache) if (entry.expiresAt <= Date.now()) ownerCache.delete(cacheKey);
  ownerCache.set(key, { expiresAt: Date.now() + searchCacheMs, owners });
  return owners;
}

async function searchGitHubRepositoryPage(query: string, token: string | undefined, personal: boolean): Promise<RepositoryHit[]> {
  const url = new URL("https://api.github.com/search/repositories");
  url.searchParams.set("q", query);
  url.searchParams.set("per_page", "25");
  const response = await fetchGitHub(url, token);
  const body = await readSearchBody(response, githubRepositorySearchResponseSchema, "GitHub repository search returned an unreadable response.");
  return body.items.map((repo) => ({
    forge: "github",
    fullName: repo.full_name,
    description: repo.description,
    private: repo.private,
    cloneUrl: stripCloneUserinfo(repo.clone_url),
    personal,
  }));
}

function caughtPage(error: RepositorySearchRateLimitError | RepositorySearchRejectedError, rejectedNotice: string, rateLimitNotice: string): PageOutcome {
  if (error instanceof RepositorySearchRateLimitError) {
    return { kind: "notice", notice: rateLimitNotice, attempted: true, rateLimit: { retryAfterSeconds: error.retryAfterSeconds } };
  }
  return { kind: "notice", notice: rejectedNotice, attempted: true };
}

async function readSearchBody<Schema extends TSchema>(response: Response, schema: Schema, message: string): Promise<Static<Schema>> {
  const body = await decodeResponseJson(response, schema);
  if (!body) throw new RepositorySearchRejectedError(message);
  return body;
}

async function githubPersonalPage(query: string, token: string | undefined): Promise<PageOutcome> {
  const key = pageCacheKey("github", credentialKey(token), query, "personal");
  const cached = cachedPage(key);
  if (cached) return cached;
  if (!token) return remember(key, { kind: "notice", notice: "Connect GitHub to search your personal and organization repositories.", attempted: false });
  try {
    const owners = await repositoryOwners(token);
    const repositories = await searchGitHubRepositoryPage(`${query} ${owners.map((owner) => `user:${owner}`).join(" ")}`, token, true);
    return remember(key, { kind: "hits", repositories });
  } catch (error) {
    if (error instanceof RepositorySearchRateLimitError || error instanceof RepositorySearchRejectedError) {
      return caughtPage(
        error,
        "Your repositories could not be searched. Check your GitHub connection and organization access.",
        "Your repositories could not be searched: GitHub is rate limited. Try again shortly.",
      );
    }
    throw error;
  }
}

async function githubPublicPage(query: string, token: string | undefined): Promise<PageOutcome> {
  const key = pageCacheKey("github", credentialKey(token), query, "public");
  const cached = cachedPage(key);
  if (cached) return cached;
  try {
    const repositories = await searchGitHubRepositoryPage(`${query} is:public`, token, false);
    return remember(key, { kind: "hits", repositories });
  } catch (error) {
    if (error instanceof RepositorySearchRateLimitError || error instanceof RepositorySearchRejectedError) {
      return caughtPage(
        error,
        "Public repositories could not be searched. Check your GitHub connection.",
        "Public repositories could not be searched: GitHub is rate limited. Try again shortly.",
      );
    }
    throw error;
  }
}

async function bitbucketPersonalPage(query: string, account: Extract<ForgeAccount, { forge: "bitbucket" }>): Promise<PageOutcome> {
  const key = pageCacheKey("bitbucket", credentialKey(`${account.email}\0${account.token}`), query, "personal");
  const cached = cachedPage(key);
  if (cached) return cached;
  const rejected = "Your Bitbucket repositories could not be searched. Check your Bitbucket connection.";
  const limited = "Your Bitbucket repositories could not be searched: Bitbucket is rate limited. Try again shortly.";
  const url = new URL("https://api.bitbucket.org/2.0/repositories");
  url.searchParams.set("role", "member");
  url.searchParams.set("pagelen", "25");
  url.searchParams.set("q", bitbucketNameQuery(query));
  let response: Response;
  try {
    response = await fetchSearch(url, {
      headers: {
        Accept: "application/json",
        Authorization: bitbucketBasicAuthorization(account.email, account.token),
      },
    });
  } catch (error) {
    if (error instanceof RepositorySearchRejectedError) return { kind: "notice", notice: rejected, attempted: true };
    throw error;
  }
  if (response.status === 429) return { kind: "notice", notice: limited, attempted: true, rateLimit: { retryAfterSeconds: retryAfterSeconds(response) } };
  if (!response.ok) return { kind: "notice", notice: rejected, attempted: true };
  let body: Static<typeof bitbucketRepositorySearchResponseSchema>;
  try {
    body = await readSearchBody(response, bitbucketRepositorySearchResponseSchema, "Bitbucket repository search returned an unreadable response.");
  } catch (error) {
    if (error instanceof RepositorySearchRejectedError) return { kind: "notice", notice: rejected, attempted: true };
    throw error;
  }
  const repositories = body.values.map((repo) => ({
    forge: "bitbucket" as const,
    fullName: repo.full_name,
    description: repo.description ?? null,
    private: repo.is_private,
    cloneUrl: bitbucketCloneUrl(repo.full_name, repo.links),
    personal: true,
  }));
  return remember(key, { kind: "hits", repositories });
}

function unseen(repositories: readonly RepositoryHit[], seen: Set<string>): RepositoryHit[] {
  return repositories.filter((repo) => {
    const key = repo.fullName.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function deduped(personal: readonly RepositoryHit[], rest: readonly RepositoryHit[]) {
  const seen = new Set<string>();
  return { personal: unseen(personal, seen), rest: unseen(rest, seen) };
}

function groupFrom(forge: ForgeId, heading: string, outcome: PageOutcome): RepositorySearchGroup {
  if (outcome.kind === "hits") return { forge, heading, repositories: outcome.repositories, attempted: true };
  return { forge, heading, repositories: [], notice: outcome.notice, attempted: outcome.attempted, rateLimit: outcome.rateLimit };
}

export async function searchRepositories(query: string): Promise<RepositorySearchResults> {
  const trimmed = query.trim();
  const accounts = discoverForgeAccounts();
  const github = accounts.find((account): account is Extract<ForgeAccount, { forge: "github" }> => account.forge === "github");
  const bitbucket = accounts.find((account): account is Extract<ForgeAccount, { forge: "bitbucket" }> => account.forge === "bitbucket");
  const [personal, publicPage, bitbucketPage] = await Promise.all([
    githubPersonalPage(trimmed, github?.token),
    githubPublicPage(trimmed, github?.token),
    bitbucket ? bitbucketPersonalPage(trimmed, bitbucket) : undefined,
  ]);
  const githubHits = deduped(
    personal.kind === "hits" ? personal.repositories : [],
    publicPage.kind === "hits" ? publicPage.repositories : [],
  );
  const groups = [
    groupFrom("github", "Your GitHub repositories", personal.kind === "hits" ? { kind: "hits", repositories: githubHits.personal } : personal),
    bitbucketPage ? groupFrom("bitbucket", "Your Bitbucket repositories", bitbucketPage) : undefined,
    groupFrom("github", "Public GitHub repositories", publicPage.kind === "hits" ? { kind: "hits", repositories: githubHits.rest } : publicPage),
  ].filter((group) => group !== undefined);
  return { groups };
}

export function repositorySearchIsRateLimited(results: RepositorySearchResults): { retryAfterSeconds?: number } | undefined {
  const attempted = results.groups.filter((group) => group.attempted);
  if (attempted.length === 0) return undefined;
  if (attempted.some((group) => group.repositories.length > 0 || !group.rateLimit)) return undefined;
  const waits = attempted.flatMap((group) => group.rateLimit?.retryAfterSeconds === undefined ? [] : [group.rateLimit.retryAfterSeconds]);
  return waits.length > 0 ? { retryAfterSeconds: Math.max(...waits) } : {};
}

export function renderRepositorySearchRateLimitMenu(results: RepositorySearchResults, retryAfterSeconds?: number): string {
  const forges = new Set(results.groups.map((group) => group.forge));
  const subject = forges.size === 1 && forges.has("github") ? "GitHub search" : "Repository search";
  const wait = retryAfterSeconds ? ` Try again in ${retryAfterSeconds} seconds.` : " Try again in a few minutes.";
  return autocompleteHtml({ kind: "message", content: { kind: "text", text: `${subject} is rate limited.${wait}` } });
}

export function renderRepositorySearchMenu(results: RepositorySearchResults): string {
  const rendered = results.groups.map((group) => {
    const notice = group.notice ? autocompleteHtml({ kind: "message", role: "status", content: { kind: "text", text: group.notice } }) : "";
    if (group.repositories.length === 0) return notice;
    const heading = `<div class="workspace-template-repository-heading">${escapeHtml(group.heading)}</div>`;
    const rows = autocompleteHtml({
      kind: "results",
      label: group.heading,
      contentHtml: group.repositories.map((repo) => {
        const title = [repo.fullName, repo.description, repo.private ? "Private repository" : undefined].filter(Boolean).join(" — ");
        return contentRowHtml({
          width: "fill",
          kind: "compact",
          label: { kind: "text", text: repo.fullName },
          trailingHtml: repo.private ? "<span>Private</span>" : undefined,
          element: {
            tag: "button",
            attributesHtml: `type="button" role="option" aria-selected="false" data-git-url="${escapeHtml(repo.cloneUrl)}" title="${escapeHtml(title)}"`,
          },
        });
      }).join(""),
    });
    return `${notice}${heading}${rows}`;
  }).join("");
  if (results.groups.some((group) => group.repositories.length > 0)) return rendered;
  return `${rendered}${autocompleteHtml({ kind: "message", content: { kind: "text", text: "No repositories" } })}`;
}
