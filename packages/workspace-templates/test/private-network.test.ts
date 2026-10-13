import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addWorkspaceTemplate, getConfiguration, globalWorkspaceConfiguration } from "../src/workspace-template.ts";
import { effectivePrivateNetworkAccess, setPrivateNetworkAccess } from "../src/private-network.ts";

async function withStore(run: (file: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "agents-in-the-cloud-private-network-"));
  try { await run(join(directory, "projects.json")); } finally { await rm(directory, { recursive: true, force: true }); }
}

test("destinations are saved one host:port per line and combine global and template entries", () => withStore(async (file) => {
  const { workspaceTemplate } = await addWorkspaceTemplate("https://github.com/example/app.git", file);
  expect(await setPrivateNetworkAccess(globalWorkspaceConfiguration, "# shared services\nDB.Internal:5432\n\n  192.168.1.20:22  \ndb.internal:5432\n", file)).toEqual(["db.internal:5432", "192.168.1.20:22"]);
  expect(await setPrivateNetworkAccess(workspaceTemplate.id, "[FD00::5]:443\ndb.internal:5432", file)).toEqual(["[fd00::5]:443", "db.internal:5432"]);
  expect((await getConfiguration(workspaceTemplate.id, file)).privateNetworkAccess).toEqual(["[fd00::5]:443", "db.internal:5432"]);
  expect(await effectivePrivateNetworkAccess(workspaceTemplate.id, file)).toEqual([{ host: "db.internal", port: 5432 }, { host: "192.168.1.20", port: 22 }, { host: "fd00::5", port: 443 }]);
  expect(await effectivePrivateNetworkAccess(undefined, file)).toEqual([{ host: "db.internal", port: 5432 }, { host: "192.168.1.20", port: 22 }]);
  expect(await setPrivateNetworkAccess(globalWorkspaceConfiguration, "\n", file)).toEqual([]);
  expect((await getConfiguration(globalWorkspaceConfiguration, file)).privateNetworkAccess).toEqual([]);
}));

test("only exact private destinations are accepted", () => withStore(async (file) => {
  for (const [input, message] of [
    ["db.internal", "Use host:port"],
    ["db.internal:0", "Use host:port"],
    ["db.internal:70000", "Use host:port"],
    ["*.internal:80", "isn’t a valid hostname"],
    ["10.0.0.0/8:80", "isn’t a valid hostname"],
    ["172.17.0.1:80", "isn’t on a private network"],
    ["127.0.0.1:3000", "isn’t on a private network"],
    ["169.254.169.254:80", "isn’t on a private network"],
    ["8.8.8.8:53", "isn’t on a private network"],
    ["[db.internal]:80", "isn’t an IPv6 address"],
  ] as const) await expect(setPrivateNetworkAccess(globalWorkspaceConfiguration, `ok.internal:1\n${input}`, file), input).rejects.toThrow(message);
  expect((await getConfiguration(globalWorkspaceConfiguration, file)).privateNetworkAccess).toEqual([]);
}));
