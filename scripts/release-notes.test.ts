import { expect, test } from "bun:test";
import { parseReleaseArgs } from "./release.ts";
import { prepareReleaseNotes, publishReleaseNotes, readReleaseNotes } from "./release-notes.ts";
import { parseReleaseBody } from "../packages/update/src/server/release-history.ts";
import type { Run } from "./release-support.ts";

const revision = "a".repeat(40), digest = `sha256:${"b".repeat(64)}`;
const notes = { sourceRevision: revision, id: "2026-08-03-improvements", path: "release_notes/2026-08-03-improvements.md", notes: "# Improvements\n\n## Bugfixes\n- Moving tabs keeps terminals running." };
interface ReleaseFixture { id: number; tag_name: string; target_commitish: string; body: string; draft: boolean; }
type GithubFixture = ReleaseFixture | ReleaseFixture[] | { object: { type: string; sha: string } } | undefined;
const ok = (value: GithubFixture) => ({ code: 0, stdout: JSON.stringify(value), stderr: "" });
const absent = { code: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" };
function github() {
  let release: ReleaseFixture | undefined;
  let tagRevision: string | undefined;
  const calls: { method: string; path: string }[] = [];
  const run: Run = async (args, options) => {
    const path = args[2]!, method = args[args.indexOf("--method") + 1]!;
    calls.push({ path, method });
    if (path.includes("git/ref/")) return tagRevision ? ok({ object: { type: "commit", sha: tagRevision } }) : absent;
    if (method === "GET") return ok(release ? [release] : []);
    // SAFETY: The publisher passes its own JSON release mutation as command input.
    const input = JSON.parse(options!.input!) as { tag_name: string; target_commitish: string; body: string; draft: boolean };
    if (method === "POST") release = { id: 123, ...input };
    if (method === "PATCH") {
      release = { ...release!, ...input };
      tagRevision = release.target_commitish;
    }
    return ok(release);
  };
  return { run, calls, get release() { return release!; }, setTag(revision: string) { tagRevision = revision; } };
}

test("stable requires explicitly selected notes; latest needs none; checks can omit notes", () => {
  expect(() => parseReleaseArgs(["--stable"])).toThrow("require --notes");
  expect(() => parseReleaseArgs(["--notes", notes.path])).toThrow("only used with --stable");
  expect(() => parseReleaseArgs(["--stable", "--notes"])).toThrow("file path");
  expect(() => parseReleaseArgs(["--stable", "--notes", notes.path, "--notes", notes.path])).toThrow("only once");
  expect(parseReleaseArgs(["--stable", "--notes", notes.path]).notes).toBe(notes.path);
  expect(parseReleaseArgs(["--stable", "--check"]).check).toBe(true);
});

test("reads notes from the exact release commit, not the working directory", async () => {
  const calls: string[][] = [];
  const run: Run = async args => { calls.push(args); return { code: 0, stdout: notes.notes, stderr: "" }; };
  expect(await readReleaseNotes(run, revision, notes.path)).toEqual(notes);
  expect(calls).toEqual([["git", "show", `${revision}:${notes.path}`]]);
  await expect(readReleaseNotes(run, revision, "../notes.md")).rejects.toThrow("Use --notes");
  await expect(readReleaseNotes(async () => ({ code: 0, stdout: " \n", stderr: "" }), revision, notes.path)).rejects.toThrow("empty");
});

test("reserves a hidden draft, publishes the exact association, and safely reuses it on retry", async () => {
  const server = github();
  await prepareReleaseNotes(server.run, notes, revision);
  expect(server.release.draft).toBe(true);
  await prepareReleaseNotes(server.run, notes, revision);
  expect(server.calls.filter(call => call.method === "POST")).toHaveLength(1);
  await publishReleaseNotes(server.run, notes, revision, digest);
  expect(server.release.draft).toBe(false);
  expect(parseReleaseBody(server.release.body).record).toEqual({ id: notes.id, notesPath: notes.path, revision, notesRevision: revision, digest });
  await prepareReleaseNotes(server.run, notes, revision);
  await publishReleaseNotes(server.run, notes, revision, digest);
  expect(server.calls.filter(call => call.method === "PATCH")).toHaveLength(1);
});

test("reusing an ID for a different revision, notes, digest or tag fails", async () => {
  const server = github();
  await prepareReleaseNotes(server.run, notes, revision);
  await expect(prepareReleaseNotes(server.run, notes, "c".repeat(40))).rejects.toThrow("another revision");
  await expect(prepareReleaseNotes(server.run, { ...notes, notes: "different" }, revision)).rejects.toThrow("do not match");
  await publishReleaseNotes(server.run, notes, revision, digest);
  await expect(publishReleaseNotes(server.run, notes, revision, `sha256:${"c".repeat(64)}`)).rejects.toThrow("different image digest");
  server.setTag("d".repeat(40));
  await expect(prepareReleaseNotes(server.run, notes, revision)).rejects.toThrow("another revision");
});

test("GitHub network and permission failures are not treated as missing records", async () => {
  await expect(prepareReleaseNotes(async () => ({ code: 1, stdout: "", stderr: "HTTP 403" }), notes, revision)).rejects.toThrow("request failed");
});

test("a later notes commit is recorded without changing the released code tag", async () => {
  const server = github();
  const approved = { ...notes, sourceRevision: "d".repeat(40) };
  await prepareReleaseNotes(server.run, approved, revision);
  await publishReleaseNotes(server.run, approved, revision, digest);
  expect(server.release.target_commitish).toBe(revision);
  const record = parseReleaseBody(server.release.body).record;
  expect(record.revision).toBe(revision);
  expect(record.notesRevision).toBe(approved.sourceRevision);
  await expect(prepareReleaseNotes(server.run, { ...approved, sourceRevision: "e".repeat(40) }, revision)).rejects.toThrow("do not match");
});
