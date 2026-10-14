import { expect, test } from "bun:test";
import { fetchReleaseHistory, parseReleaseBody, releaseBody, type ReleaseRecord } from "../../src/server/release-history.ts";

const sha = (n: number) => n.toString(16).padStart(40, "0");
const record = (n: number): ReleaseRecord => ({ id: `2026-08-${String(n).padStart(2, "0")}-improvements`, revision: sha(n), digest: `sha256:${"a".repeat(64)}`, notesPath: `release_notes/2026-08-${String(n).padStart(2, "0")}-improvements.md` });
function entry(n: number) {
  return { tag_name: `stable-${record(n).id}`, body: releaseBody(record(n), `# Release ${n}\n\n## Bugfixes\n- Fixed a problem.`), draft: false, prerelease: false, published_at: `2026-08-${String(n).padStart(2, "0")}T12:00:00Z` };
}
function fetcher(entries: ReturnType<typeof entry>[]) {
  return async (input: string | URL) => {
    const url = new URL(input);
    if (url.pathname.endsWith("/releases")) return Response.json(url.searchParams.get("page") === "1" ? entries : []);
    const match = url.pathname.match(/compare\/([a-f0-9]+)\.\.\.([a-f0-9]+)$/)!;
    const left = parseInt(match[1]!, 16), right = parseInt(match[2]!, 16);
    return Response.json({ status: left === right ? "identical" : left < right ? "ahead" : "behind", commits: left < right ? Array.from({ length: right - left }, (_, i) => ({ sha: sha(left + i + 1) })) : [] });
  };
}

test("publication metadata round trips without showing its marker in notes", () => {
  const notes = "# Release\n\n- A benefit.";
  expect(parseReleaseBody(releaseBody(record(1), notes))).toEqual({ record: record(1), notes });
  expect(() => parseReleaseBody(notes)).toThrow("publication record");
  expect(() => parseReleaseBody(releaseBody({ ...record(1), notesPath: "other.md" }, notes))).toThrow("path");
});

test("six missed releases are shown newest first, excluding installed and future releases", async () => {
  const history = await fetchReleaseHistory(sha(1), sha(7), fetcher(Array.from({ length: 8 }, (_, i) => entry(i + 1))));
  expect(history.releases.map(release => release.revision)).toEqual([7, 6, 5, 4, 3, 2].map(sha));
  expect(history.targetHasNotes).toBe(true);
});

test("latest shows only crossed stable milestones, never drafts or prereleases", async () => {
  const history = await fetchReleaseHistory(sha(3), sha(8), fetcher([entry(2), entry(4), { ...entry(5), draft: true }, { ...entry(6), prerelease: true }, entry(7)]));
  expect(history.releases.map(release => release.revision)).toEqual([sha(7), sha(4)]);
  expect(history.targetHasNotes).toBe(false);
  expect(history.compareUrl).toEndWith(`${sha(3)}...${sha(8)}`);
});

test("history paginates rather than silently losing older notes", async () => {
  let pages = 0;
  const base = fetcher([entry(2)]);
  const history = await fetchReleaseHistory(sha(1), sha(2), async (url) => {
    if (new URL(url).pathname.endsWith("/releases") && ++pages === 1) return Response.json(Array.from({ length: 100 }, () => ({ ...entry(3), tag_name: "unrelated" })));
    if (new URL(url).pathname.endsWith("/releases")) return Response.json([entry(2)]);
    return base(url);
  });
  expect(pages).toBe(2);
  expect(history.releases).toHaveLength(1);
});

test("commit comparison paginates beyond GitHub's default 250-commit window", async () => {
  const published = { ...entry(2), body: releaseBody({ ...record(2), revision: sha(301) }, "# Last milestone") };
  const pages: number[] = [];
  const history = await fetchReleaseHistory(sha(1), sha(301), async input => {
    const url = new URL(input);
    if (url.pathname.endsWith("/releases")) return Response.json([published]);
    const page = Number(url.searchParams.get("page"));
    pages.push(page);
    const start = (page - 1) * 100 + 2;
    return Response.json({ status: "ahead", commits: Array.from({ length: Math.max(0, Math.min(100, 302 - start)) }, (_, i) => ({ sha: sha(start + i) })) });
  });
  expect(pages).toEqual([1, 2, 3, 4]);
  expect(history.releases.map(release => release.revision)).toEqual([sha(301)]);
});

test("downgrades, divergent histories, bad revisions, and external failures are explicit", async () => {
  await expect(fetchReleaseHistory(sha(7), sha(1), fetcher([]))).rejects.toThrow("not newer");
  await expect(fetchReleaseHistory(sha(1), sha(7), async () => Response.json({ status: "diverged", commits: [] }))).rejects.toThrow("not newer");
  await expect(fetchReleaseHistory("invalid", sha(7), fetcher([]))).rejects.toThrow();
  await expect(fetchReleaseHistory(sha(1), sha(7), async () => new Response("", { status: 403 }))).rejects.toThrow("GitHub 403");
});
