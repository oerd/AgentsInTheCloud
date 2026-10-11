import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseAtlassianAccountEmail, setForgeAccount } from "@agents-in-the-cloud/core";
import { validateForgeAccount } from "../src/server/forge-auth.ts";
import { renderForgeSection } from "../src/server/settings/git-host.ts";
import { createWorkspaceTemplateRoutes } from "../src/server/workspace-template-routes.ts";

const originalFetch = globalThis.fetch;

function fetchStub(
  implementation: (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => ReturnType<typeof fetch>,
): typeof fetch {
  return Object.assign(implementation, { preconnect: originalFetch.preconnect });
}

describe("forge auth", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("rejects blank tokens without calling GitHub", async () => {
    let called = false;
    globalThis.fetch = fetchStub(() => {
      called = true;
      throw new Error("unexpected fetch");
    });

    expect(await validateForgeAccount({ forge: "github", token: "  " })).toEqual({ ok: false, message: "Enter a GitHub token." });
    expect(called).toBe(false);
  });

  test("validates tokens against the GitHub user API", async () => {
    let auth = "";
    globalThis.fetch = fetchStub((url, init) => {
      auth = new Headers(init?.headers).get("authorization") ?? "";
      if (url === "https://api.github.com/user") return Promise.resolve(Response.json({ id: 583231, login: "octocat", name: "Mona Lisa", email: null }));
      if (url === "https://api.github.com/user/emails") return Promise.resolve(Response.json([{ email: "octocat@github.com", primary: true, verified: true }]));
      throw new Error(`unexpected fetch ${String(url)}`);
    });

    expect(await validateForgeAccount({ forge: "github", token: " gh_cli_token_test " })).toEqual({
      ok: true,
      account: { forge: "github", token: "gh_cli_token_test" },
      commitName: "Mona Lisa",
      commitEmail: "octocat@github.com",
    });
    expect(auth).toBe("Bearer gh_cli_token_test");
  });

  test("falls back to the GitHub noreply email when private emails are unavailable", async () => {
    globalThis.fetch = fetchStub((url) => {
      if (url === "https://api.github.com/user") return Promise.resolve(Response.json({ id: 583231, login: "octocat", name: "" }));
      if (url === "https://api.github.com/user/emails") return Promise.resolve(new Response("forbidden", { status: 403 }));
      throw new Error(`unexpected fetch ${String(url)}`);
    });

    expect(await validateForgeAccount({ forge: "github", token: "token" })).toEqual({
      ok: true,
      account: { forge: "github", token: "token" },
      commitName: "octocat",
      commitEmail: "583231+octocat@users.noreply.github.com",
    });
  });

  test("reports rejected tokens", async () => {
    globalThis.fetch = fetchStub(() => Promise.resolve(new Response("bad", { status: 401 })));

    expect(await validateForgeAccount({ forge: "github", token: "bad-token" })).toEqual({ ok: false, message: "GitHub rejected that token. Check that it is active and has repository read access." });
  });

  test("rejects malformed GitHub user responses", async () => {
    globalThis.fetch = fetchStub(() => Promise.resolve(Response.json({ id: "583231", login: "octocat" })));

    expect(await validateForgeAccount({ forge: "github", token: "token" })).toEqual({ ok: false, message: "GitHub returned an invalid user response. Try again." });
  });

  test("rejects a blank Bitbucket token or a token with a newline before calling Bitbucket", async () => {
    let called = false;
    globalThis.fetch = fetchStub(() => {
      called = true;
      throw new Error("unexpected fetch");
    });

    expect(await validateForgeAccount({ forge: "bitbucket", email: "ada@example.com", token: "  " })).toEqual({ ok: false, message: "Enter a Bitbucket API token." });
    expect(await validateForgeAccount({ forge: "bitbucket", email: "ada@example.com", token: "tok\nen" })).toEqual({ ok: false, message: "Enter a Bitbucket API token." });
    expect(called).toBe(false);
  });

  test("rejects an Atlassian email that is blank, has whitespace, lacks one @, or contains a colon", async () => {
    let called = false;
    globalThis.fetch = fetchStub(() => {
      called = true;
      throw new Error("unexpected fetch");
    });

    for (const email of ["", "ada example.com", "ada.example.com", "a@", "@b", "ada:token@example.com"]) {
      expect(await validateForgeAccount({ forge: "bitbucket", email, token: "api-token" })).toEqual({ ok: false, message: "Use the Atlassian account email for that token." });
    }
    expect(called).toBe(false);
  });

  test("validates Bitbucket with Basic auth and prefers the display name", async () => {
    let auth = "";
    globalThis.fetch = fetchStub((url, init) => {
      auth = new Headers(init?.headers).get("authorization") ?? "";
      const href = String(url);
      if (href.startsWith("https://api.bitbucket.org/2.0/repositories")) return Promise.resolve(Response.json({ values: [] }));
      if (href === "https://api.bitbucket.org/2.0/user") return Promise.resolve(Response.json({ display_name: "Ada Lovelace", username: "ada" }));
      throw new Error(`unexpected fetch ${href}`);
    });

    const email = parseAtlassianAccountEmail("ada@example.com");
    if (!email) throw new Error("Atlassian email did not parse");
    expect(await validateForgeAccount({ forge: "bitbucket", email: " ada@example.com ", token: " api-token " })).toEqual({
      ok: true,
      account: { forge: "bitbucket", email, token: "api-token" },
      commitName: "Ada Lovelace",
      commitEmail: "ada@example.com",
    });
    expect(auth).toBe(`Basic ${Buffer.from("ada@example.com:api-token").toString("base64")}`);
  });

  test("falls back from Bitbucket display name to username, then the email local part", async () => {
    globalThis.fetch = fetchStub(() => Promise.resolve(Response.json({ username: "ada" })));
    const named = await validateForgeAccount({ forge: "bitbucket", email: "ada@example.com", token: "api-token" });
    if (!named.ok) throw new Error(named.message);
    expect(named.commitName).toBe("ada");

    globalThis.fetch = fetchStub(() => Promise.resolve(Response.json({})));
    const local = await validateForgeAccount({ forge: "bitbucket", email: "ada@example.com", token: "api-token" });
    if (!local.ok) throw new Error(local.message);
    expect(local.commitName).toBe("ada");
    expect(local.commitEmail).toBe("ada@example.com");
  });

  test("accepts a Bitbucket token that can read repositories when the user profile is forbidden", async () => {
    const urls: string[] = [];
    globalThis.fetch = fetchStub((url) => {
      urls.push(String(url));
      if (String(url).startsWith("https://api.bitbucket.org/2.0/repositories")) return Promise.resolve(Response.json({ values: [] }));
      if (url === "https://api.bitbucket.org/2.0/user") return Promise.resolve(new Response("forbidden", { status: 403 }));
      throw new Error(`unexpected fetch ${String(url)}`);
    });

    const result = await validateForgeAccount({ forge: "bitbucket", email: "ada@example.com", token: "repo-token" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.commitName).toBe("ada");
    expect(result.commitEmail).toBe("ada@example.com");
    expect(urls[0]).toContain("/2.0/repositories");
    expect(urls[0]).toContain("role=member");
  });

  test("reports rejected Bitbucket credentials", async () => {
    globalThis.fetch = fetchStub(() => Promise.resolve(new Response("bad", { status: 401 })));

    expect(await validateForgeAccount({ forge: "bitbucket", email: "ada@example.com", token: "api-token" })).toEqual({
      ok: false,
      message: "Bitbucket rejected that email and token. Check that the token is active and can read repositories.",
    });
  });

  test("a malformed Bitbucket profile falls back to the email local part", async () => {
    globalThis.fetch = fetchStub((url) => {
      if (String(url).startsWith("https://api.bitbucket.org/2.0/repositories")) return Promise.resolve(Response.json({ values: [] }));
      return Promise.resolve(Response.json({ display_name: 12 }));
    });

    const result = await validateForgeAccount({ forge: "bitbucket", email: "ada@example.com", token: "api-token" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.commitName).toBe("ada");
    expect(result.commitEmail).toBe("ada@example.com");
  });

  test("an unreadable Bitbucket account file still offers Disconnect", async () => {
    const previous = process.env.ATELIER_DATA_DIR;
    const dataDir = await mkdtemp(join(tmpdir(), "agents-in-the-cloud-bitbucket-file-"));
    process.env.ATELIER_DATA_DIR = dataDir;
    try {
      const path = join(dataDir, "workspace", "bitbucket-account");
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "{");
      const html = await renderForgeSection("bitbucket");
      expect(html).toContain("Disconnect");
      expect(html).toContain("can&#39;t be read");
      expect(html).not.toContain("bkt auth login");
    } finally {
      if (previous === undefined) delete process.env.ATELIER_DATA_DIR;
      else process.env.ATELIER_DATA_DIR = previous;
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("the Bitbucket connect form says where the token comes from", async () => {
    const html = await renderForgeSection("bitbucket");
    expect(html).toContain("https://id.atlassian.com/manage-profile/security/api-tokens");
    expect(html).toContain("repository");
    expect(html).not.toContain("bkt auth login");
  });

  test("Add a template mentions Bitbucket search only as something you connect", async () => {
    const previous = process.env.ATELIER_DATA_DIR;
    const dataDir = await mkdtemp(join(tmpdir(), "agents-in-the-cloud-template-copy-"));
    process.env.ATELIER_DATA_DIR = dataDir;
    try {
      const html = await createWorkspaceTemplateRoutes({
        referencingWorkspaces: () => [],
        invalidatePresentation: () => {},
        createAgentWorkspace: () => Promise.resolve(new Response()),
      }).editorHtml({ kind: "new" });
      expect(html).toContain("Connect Bitbucket in Settings to search it too.");
      expect(html).not.toContain("search GitHub and Bitbucket");
      const email = parseAtlassianAccountEmail("ada@example.com");
      if (!email) throw new Error("Atlassian email did not parse");
      setForgeAccount({ forge: "bitbucket", email, token: "api-token" });
      const connected = await createWorkspaceTemplateRoutes({
        referencingWorkspaces: () => [],
        invalidatePresentation: () => {},
        createAgentWorkspace: () => Promise.resolve(new Response()),
      }).editorHtml({ kind: "new" });
      expect(connected).toContain("search GitHub and Bitbucket.");
    } finally {
      if (previous === undefined) delete process.env.ATELIER_DATA_DIR;
      else process.env.ATELIER_DATA_DIR = previous;
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("reports a Bitbucket network failure", async () => {
    globalThis.fetch = fetchStub(() => Promise.reject(new Error("offline")));

    expect(await validateForgeAccount({ forge: "bitbucket", email: "ada@example.com", token: "api-token" })).toEqual({
      ok: false,
      message: "Could not reach Bitbucket. Check your network and try again.",
    });
  });
});
