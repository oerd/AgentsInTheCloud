import { expect, test } from "bun:test";
import {
  appPackagePath,
  channelRepository,
  ghcrRepository,
  imageRepository,
  ownerFromRepository,
  resolveRegistryOwner,
  selectAppRepository,
} from "../src/ghcr.ts";

const tokenRemote = "https://x-access-token:ghp_secret@github.com/oerd/AgentsInTheCloud.git";

test("upstream owner is lucasmeijer when nothing names a fork", () => {
  expect(String(resolveRegistryOwner())).toBe("lucasmeijer");
  expect(imageRepository(resolveRegistryOwner(), "app")).toBe("ghcr.io/lucasmeijer/agents-in-the-cloud");
  expect(appPackagePath(resolveRegistryOwner())).toBe("lucasmeijer/agents-in-the-cloud");
});

test("explicit owner wins over Actions and the git remote", () => {
  expect(String(resolveRegistryOwner({
    ghcrOwner: "Explicit",
    githubRepositoryOwner: "ActionsUser",
    originUrl: "git@github.com:Oerd/AgentsInTheCloud.git",
  }))).toBe("explicit");
});

test("Actions owner wins over the git remote", () => {
  expect(String(resolveRegistryOwner({
    githubRepositoryOwner: "ActionsUser",
    originUrl: "git@github.com:Oerd/AgentsInTheCloud.git",
  }))).toBe("actionsuser");
});

test("git remote owner is lowercased and drops credentials", () => {
  expect(String(resolveRegistryOwner({ originUrl: "git@github.com:Oerd/AgentsInTheCloud.git" }))).toBe("oerd");
  expect(String(resolveRegistryOwner({ originUrl: tokenRemote }))).toBe("oerd");
  expect(JSON.stringify(resolveRegistryOwner({ originUrl: tokenRemote }))).not.toContain("ghp_secret");
});

test("a non-GitHub remote keeps the upstream owner", () => {
  expect(String(resolveRegistryOwner({ originUrl: "https://gitlab.com/oerd/AgentsInTheCloud.git" }))).toBe("lucasmeijer");
  expect(String(resolveRegistryOwner({ ghcrOwner: "  ", originUrl: "" }))).toBe("lucasmeijer");
});

test("owner rejects characters GitHub would reject", () => {
  expect(() => resolveRegistryOwner({ ghcrOwner: "not a user" })).toThrow("GitHub username");
  expect(() => resolveRegistryOwner({ ghcrOwner: "-leading" })).toThrow("GitHub username");
  expect(() => resolveRegistryOwner({ ghcrOwner: "double--hyphen" })).toThrow("GitHub username");
});

test("image roles share one owner", () => {
  const owner = resolveRegistryOwner({ ghcrOwner: "oerd" });
  expect(imageRepository(owner, "system")).toBe("ghcr.io/oerd/agents-in-the-cloud-system");
  expect(imageRepository(owner, "workspace")).toBe("ghcr.io/oerd/agents-in-the-cloud-workspace");
  expect(imageRepository(owner, "docker")).toBe("ghcr.io/oerd/agents-in-the-cloud-docker");
});

test("a ghcr ref keeps its repository and drops the tag or digest", () => {
  expect(ghcrRepository("ghcr.io/oerd/agents-in-the-cloud:latest")).toBe("ghcr.io/oerd/agents-in-the-cloud");
  expect(ghcrRepository(`ghcr.io/oerd/agents-in-the-cloud@sha256:${"a".repeat(64)}`)).toBe("ghcr.io/oerd/agents-in-the-cloud");
  expect(ghcrRepository("sha256:abc")).toBeUndefined();
  expect(String(ownerFromRepository("ghcr.io/oerd/agents-in-the-cloud"))).toBe("oerd");
});

test("the installed app image chooses the repository updates pull", () => {
  expect(selectAppRepository({ appImage: "ghcr.io/oerd/agents-in-the-cloud:sha-abc", ghcrOwner: "lucasmeijer" })).toBe("ghcr.io/oerd/agents-in-the-cloud");
  expect(selectAppRepository({ appImage: "local:dev", ghcrOwner: "oerd" })).toBe("ghcr.io/oerd/agents-in-the-cloud");
  expect(channelRepository({ remembered: "ghcr.io/oerd/agents-in-the-cloud", ghcrOwner: "lucasmeijer" })).toBe("ghcr.io/oerd/agents-in-the-cloud");
  expect(channelRepository({ remembered: "nope", ghcrOwner: "oerd" })).toBe("ghcr.io/oerd/agents-in-the-cloud");
  expect(channelRepository()).toBe("ghcr.io/lucasmeijer/agents-in-the-cloud");
});
