import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAtlassianAccountEmail, setForgeAccount } from "@agents-in-the-cloud/core";
import { shouldSearchRepositories } from "@agents-in-the-cloud/shared";
import { repositorySearchIsRateLimited, searchRepositories, type RepositoryHit, type RepositorySearchResults } from "../src/server/repository-search.ts";

const originalFetch = globalThis.fetch;
let previousDataDir: string | undefined;
let previousToken: string | undefined;
let previousBitbucketToken: string | undefined;
let previousBitbucketUsername: string | undefined;
let dataDir: string;
let queries: string[];
let requests: URL[];

beforeEach(async () => {
  previousDataDir = process.env.ATELIER_DATA_DIR;
  previousToken = process.env.GH_TOKEN;
  previousBitbucketToken = process.env.BKT_TOKEN;
  previousBitbucketUsername = process.env.BKT_USERNAME;
  dataDir = await mkdtemp(join(tmpdir(), "agents-in-the-cloud-repo-search-"));
  process.env.ATELIER_DATA_DIR = dataDir;
  process.env.GH_TOKEN = crypto.randomUUID();
  delete process.env.BKT_TOKEN;
  delete process.env.BKT_USERNAME;
  queries = [];
  requests = [];
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  if (previousDataDir === undefined) delete process.env.ATELIER_DATA_DIR;
  else process.env.ATELIER_DATA_DIR = previousDataDir;
  if (previousToken === undefined) delete process.env.GH_TOKEN;
  else process.env.GH_TOKEN = previousToken;
  if (previousBitbucketToken === undefined) delete process.env.BKT_TOKEN;
  else process.env.BKT_TOKEN = previousBitbucketToken;
  if (previousBitbucketUsername === undefined) delete process.env.BKT_USERNAME;
  else process.env.BKT_USERNAME = previousBitbucketUsername;
  await rm(dataDir, { recursive: true, force: true });
});

function repository(fullName: string, privateRepo = false) {
  return { full_name: fullName, description: null, private: privateRepo, clone_url: `https://github.com/${fullName}.git` };
}

function repositoriesIn(results: RepositorySearchResults): RepositoryHit[] {
  return results.groups.flatMap((group) => [...group.repositories]);
}

function notice(results: RepositorySearchResults, heading: string): string | undefined {
  return results.groups.find((group) => group.heading === heading)?.notice;
}

function stubSearch(search: (query: string) => ReturnType<typeof repository>[], orgs: (page: number) => { login: string }[] = () => [{ login: "my-org" }]) {
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push(url);
    expect(url.hostname).toBe("api.github.com");
    expect(new Headers(init?.headers).get("Authorization")).toBe(process.env.GH_TOKEN ? `Bearer ${process.env.GH_TOKEN}` : null);
    if (url.pathname === "/user") return Response.json({ login: "me" });
    if (url.pathname === "/user/orgs") {
      expect(url.searchParams.get("per_page")).toBe("100");
      return Response.json(orgs(Number(url.searchParams.get("page"))));
    }
    expect(url.searchParams.get("per_page")).toBe("25");
    expect(url.pathname).toBe("/search/repositories");
    const query = url.searchParams.get("q")!;
    queries.push(query);
    return Response.json({ items: search(query) });
  }, { preconnect: originalFetch.preconnect });
}

function connectBitbucket(token = "bb-token"): void {
  const email = parseAtlassianAccountEmail("ada@example.com");
  if (!email) throw new Error("Atlassian email did not parse");
  setForgeAccount({ forge: "bitbucket", email, token });
}

test("explicit forge URLs bypass search while repository names remain searchable", () => {
  expect(shouldSearchRepositories("github.com/octocat/Hello-World")).toBe(false);
  expect(shouldSearchRepositories(" GitHub.com/octocat/Hello-World.git#main ")).toBe(false);
  expect(shouldSearchRepositories("https://github.com/octocat/Hello-World")).toBe(false);
  expect(shouldSearchRepositories("bitbucket.org/workspace/repo")).toBe(false);
  expect(shouldSearchRepositories(" Bitbucket.org/workspace/repo#main ")).toBe(false);
  expect(shouldSearchRepositories("Hello-World")).toBe(true);
});

test("owner-scoped search puts personal and org repos first, including public ones, and deduplicates", async () => {
  stubSearch((q) => q.includes("user:") ? [repository("me/widget"), repository("my-org/widget", true)] : [
    ...Array.from({ length: 24 }, (_, index) => repository(`random/widget-${index}`)),
    repository("me/widget"),
  ]);
  const results = await searchRepositories("widget");
  const repositories = repositoriesIn(results);
  expect(repositories).toHaveLength(26);
  expect(repositories.slice(0, 2).map((repo) => [repo.fullName, repo.personal])).toEqual([["me/widget", true], ["my-org/widget", true]]);
  expect(repositories.slice(2).every((repo) => !repo.personal)).toBe(true);
  expect(results.groups.map((group) => group.heading)).toEqual(["Your GitHub repositories", "Public GitHub repositories"]);
  expect(queries).toEqual(["widget is:public", "widget user:me user:my-org"]);
  await searchRepositories(" WIDGET ");
  expect(queries).toHaveLength(2);
});

test("general search preserves GitHub relevance rather than filtering to name substrings", async () => {
  stubSearch((q) => q.includes("user:") ? [] : [repository("other/relevant-description"), repository("other/widget")]);
  const results = await searchRepositories("widget language:typescript");
  expect(repositoriesIn(results).map((repo) => repo.fullName)).toEqual(["other/relevant-description", "other/widget"]);
  expect(queries[0]).toBe("widget language:typescript is:public");
});

test("anonymous searches use one request and explain that account search is unavailable", async () => {
  delete process.env.GH_TOKEN;
  stubSearch(() => [repository("public/anonymous-widget")]);
  const results = await searchRepositories("anonymous-widget");
  expect(repositoriesIn(results)).toHaveLength(1);
  expect(notice(results, "Your GitHub repositories")).toContain("Connect GitHub");
  expect(results.groups.some((group) => group.forge === "bitbucket")).toBe(false);
  expect(queries).toEqual(["anonymous-widget is:public"]);
  expect(requests).toHaveLength(1);
});

test("organization discovery follows pagination and is cached for the credential", async () => {
  stubSearch(() => [], (page) => page === 1 ? Array.from({ length: 100 }, (_, i) => ({ login: `org${i}` })) : [{ login: "last-org" }]);
  await searchRepositories("first");
  expect(queries[1]).toContain("user:last-org");
  await searchRepositories("second");
  expect(requests.filter((url) => url.pathname === "/user")).toHaveLength(1);
  expect(requests.filter((url) => url.pathname === "/user/orgs")).toHaveLength(2);
});

test("different credentials do not share cached private results or owners", async () => {
  stubSearch((q) => q.includes("user:") ? [repository("me/private", true)] : []);
  await searchRepositories("private");
  process.env.GH_TOKEN = crypto.randomUUID();
  await searchRepositories("private");
  expect(queries).toHaveLength(4);
  expect(requests.filter((url) => url.pathname === "/user")).toHaveLength(2);
});

test("failed account discovery leaves public search usable with an explicit notice", async () => {
  stubSearch(() => [repository("public/widget")]);
  const searchFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (new URL(String(input)).pathname === "/user") return new Response("Bad credentials", { status: 401 });
    return searchFetch(input, init);
  }, { preconnect: originalFetch.preconnect });
  const results = await searchRepositories("widget");
  expect(repositoriesIn(results).map((repo) => repo.fullName)).toEqual(["public/widget"]);
  expect(notice(results, "Your GitHub repositories")).toContain("could not be searched");
});

test("rate limits remain explicit and preserve the retry delay", async () => {
  globalThis.fetch = Object.assign(async () => new Response("rate limited", { status: 429, headers: { "retry-after": "30" } }), { preconnect: originalFetch.preconnect });
  const results = await searchRepositories("limited");
  expect(repositorySearchIsRateLimited(results)?.retryAfterSeconds).toBe(30);
  expect(results.groups.every((group) => group.repositories.length === 0 && group.rateLimit)).toBe(true);
});

test("Bitbucket search uses Basic auth and role=member, and strips clone userinfo", async () => {
  connectBitbucket();
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push(url);
    if (url.hostname === "api.bitbucket.org") {
      expect(url.pathname).toBe("/2.0/repositories");
      expect(url.searchParams.get("role")).toBe("member");
      expect(url.searchParams.get("pagelen")).toBe("25");
      expect(url.searchParams.get("q")).toBe('name~"say \\"hi\\""');
      expect(url.searchParams.has("is_private")).toBe(false);
      expect(new Headers(init?.headers).get("authorization")).toBe(`Basic ${Buffer.from("ada@example.com:bb-token").toString("base64")}`);
      return Response.json({
        values: [{
          full_name: "team/widget",
          description: "A widget",
          is_private: true,
          links: { clone: [{ name: "https", href: "https://ada@example.com:secret@bitbucket.org/team/widget.git" }] },
        }],
      });
    }
    expect(url.hostname).toBe("api.github.com");
    if (url.pathname === "/user") return Response.json({ login: "me" });
    if (url.pathname === "/user/orgs") return Response.json([]);
    return Response.json({ items: [repository("public/widget")] });
  }, { preconnect: originalFetch.preconnect });

  const results = await searchRepositories('say "hi"');
  const bitbucket = results.groups.find((group) => group.forge === "bitbucket");
  expect(bitbucket?.heading).toBe("Your Bitbucket repositories");
  expect(bitbucket?.repositories.map((repo) => [repo.fullName, repo.cloneUrl, repo.private, repo.personal])).toEqual([
    ["team/widget", "https://bitbucket.org/team/widget.git", true, true],
  ]);
  expect(repositoriesIn(results).some((repo) => repo.fullName === "public/widget")).toBe(true);
  expect(requests.filter((url) => url.hostname === "api.bitbucket.org")).toHaveLength(1);
});

test("a Bitbucket rate limit keeps GitHub hits and does not rate-limit the whole menu", async () => {
  connectBitbucket("other-token");
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(String(input));
    requests.push(url);
    if (url.hostname === "api.bitbucket.org") return new Response("slow", { status: 429, headers: { "retry-after": "12" } });
    if (url.pathname === "/user") return Response.json({ login: "me" });
    if (url.pathname === "/user/orgs") return Response.json([]);
    return Response.json({ items: [repository("public/still-here")] });
  }, { preconnect: originalFetch.preconnect });

  const results = await searchRepositories("still-here");
  expect(repositoriesIn(results).map((repo) => repo.fullName)).toContain("public/still-here");
  expect(notice(results, "Your Bitbucket repositories")).toContain("Bitbucket is rate limited");
  expect(repositorySearchIsRateLimited(results)).toBeUndefined();
  expect(results.groups.some((group) => group.notice?.includes("Connect Bitbucket"))).toBe(false);
});

test("a Bitbucket network failure keeps the GitHub results", async () => {
  connectBitbucket();
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(String(input));
    if (url.hostname === "api.bitbucket.org") throw new TypeError("network down");
    if (url.pathname === "/user") return Response.json({ login: "me" });
    if (url.pathname === "/user/orgs") return Response.json([]);
    return Response.json({ items: [repository("public/survives")] });
  }, { preconnect: originalFetch.preconnect });

  const results = await searchRepositories("survives-net");
  expect(repositoriesIn(results).map((repo) => repo.fullName)).toContain("public/survives");
  expect(notice(results, "Your Bitbucket repositories")).toContain("could not be searched");
});

test("a Bitbucket response that does not match the schema keeps the GitHub results", async () => {
  connectBitbucket();
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(String(input));
    if (url.hostname === "api.bitbucket.org") return Response.json({ values: [{ full_name: 1 }] });
    if (url.pathname === "/user") return Response.json({ login: "me" });
    if (url.pathname === "/user/orgs") return Response.json([]);
    return Response.json({ items: [repository("public/survives-schema")] });
  }, { preconnect: originalFetch.preconnect });

  const results = await searchRepositories("survives-schema");
  expect(repositoriesIn(results).map((repo) => repo.fullName)).toContain("public/survives-schema");
  expect(notice(results, "Your Bitbucket repositories")).toContain("could not be searched");
});

test("anonymous GitHub rate limits stay a retry delay", async () => {
  delete process.env.GH_TOKEN;
  globalThis.fetch = Object.assign(async () => new Response("rate limited", { status: 429, headers: { "retry-after": "30" } }), { preconnect: originalFetch.preconnect });

  const results = await searchRepositories("anon-limited");
  expect(repositorySearchIsRateLimited(results)?.retryAfterSeconds).toBe(30);
});

test("a Bitbucket service error is not cached", async () => {
  connectBitbucket();
  let bitbucketCalls = 0;
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(String(input));
    if (url.hostname === "api.bitbucket.org") {
      bitbucketCalls += 1;
      if (bitbucketCalls === 1) return new Response("bad gateway", { status: 502 });
      return Response.json({ values: [] });
    }
    if (url.pathname === "/user") return Response.json({ login: "me" });
    if (url.pathname === "/user/orgs") return Response.json([]);
    return Response.json({ items: [repository("public/again")] });
  }, { preconnect: originalFetch.preconnect });

  await searchRepositories("retry-bb");
  await searchRepositories("retry-bb");
  expect(bitbucketCalls).toBe(2);
});

test("an empty GitHub search does not turn a Bitbucket rate limit into a menu rate limit", async () => {
  connectBitbucket();
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(String(input));
    if (url.hostname === "api.bitbucket.org") return new Response("slow", { status: 429, headers: { "retry-after": "12" } });
    if (url.pathname === "/user") return Response.json({ login: "me" });
    if (url.pathname === "/user/orgs") return Response.json([]);
    return Response.json({ items: [] });
  }, { preconnect: originalFetch.preconnect });

  const results = await searchRepositories("empty-bb-limited");
  expect(repositorySearchIsRateLimited(results)).toBeUndefined();
  expect(notice(results, "Your Bitbucket repositories")).toContain("Bitbucket is rate limited");
});

test("a bad GitHub user response keeps Bitbucket results", async () => {
  connectBitbucket();
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(String(input));
    if (url.hostname === "api.bitbucket.org") return Response.json({ values: [{ full_name: "team/kept", is_private: false }] });
    if (url.pathname === "/user") return Response.json({ login: 1 });
    if (url.pathname === "/user/orgs") return Response.json([]);
    return Response.json({ items: [repository("public/kept")] });
  }, { preconnect: originalFetch.preconnect });

  const results = await searchRepositories("kept-user");
  expect(repositoriesIn(results).map((repo) => repo.fullName)).toContain("team/kept");
  expect(repositoriesIn(results).map((repo) => repo.fullName)).toContain("public/kept");
  expect(notice(results, "Your GitHub repositories")).toContain("could not be searched");
});

test("an invalid GitHub clone URL is an error", async () => {
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(String(input));
    if (url.pathname === "/user") return Response.json({ login: "me" });
    if (url.pathname === "/user/orgs") return Response.json([]);
    return Response.json({ items: [{ full_name: "me/bad", description: null, private: false, clone_url: "not a url" }] });
  }, { preconnect: originalFetch.preconnect });

  await expect(searchRepositories("bad-clone-url")).rejects.toBeInstanceOf(TypeError);
});

test("Bitbucket repositories are listed with personal results before public GitHub", async () => {
  connectBitbucket();
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(String(input));
    if (url.hostname === "api.bitbucket.org") {
      return Response.json({ values: [{ full_name: "team/mine", is_private: true }] });
    }
    if (url.pathname === "/user") return Response.json({ login: "me" });
    if (url.pathname === "/user/orgs") return Response.json([]);
    const query = url.searchParams.get("q") ?? "";
    const items = query.includes("user:") ? [repository("me/mine")] : [repository("public/other")];
    return Response.json({ items });
  }, { preconnect: originalFetch.preconnect });

  const results = await searchRepositories("personal-order");
  expect(results.groups.map((group) => group.heading)).toEqual([
    "Your GitHub repositories",
    "Your Bitbucket repositories",
    "Public GitHub repositories",
  ]);
});

test("omits Bitbucket when no account is stored", async () => {
  stubSearch(() => [repository("public/widget")]);
  const results = await searchRepositories("no-bitbucket");
  expect(requests.every((url) => url.hostname === "api.github.com")).toBe(true);
  expect(results.groups.some((group) => group.forge === "bitbucket")).toBe(false);
  expect(results.groups.some((group) => group.notice?.includes("Connect Bitbucket"))).toBe(false);
});
