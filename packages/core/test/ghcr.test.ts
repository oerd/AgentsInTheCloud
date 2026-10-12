import { expect, test } from "bun:test";
import {
  appRepositoryFromImage,
  ghcrRepository,
  imageRepository,
  ownerFromRepository,
  parseRegistryOwner,
  requireGhcrRepository,
  upstreamImageRepository,
} from "../src/ghcr.ts";

test("upstream repositories are explicit defaults", () => {
  expect(String(upstreamImageRepository("app"))).toBe("ghcr.io/lucasmeijer/agents-in-the-cloud");
  expect(String(upstreamImageRepository("system"))).toBe("ghcr.io/lucasmeijer/agents-in-the-cloud-system");
});

test("publishing owners use GitHub's username rules", () => {
  expect(String(parseRegistryOwner("Oerd"))).toBe("oerd");
  expect(() => parseRegistryOwner("not a user")).toThrow("GitHub username");
  expect(() => parseRegistryOwner("-leading")).toThrow("GitHub username");
  expect(() => parseRegistryOwner("double--hyphen")).toThrow("GitHub username");
  expect(() => parseRegistryOwner("a".repeat(40))).toThrow("GitHub username");
});

test("image roles share an explicitly selected owner", () => {
  const owner = parseRegistryOwner("oerd");
  expect(String(imageRepository(owner, "app"))).toBe("ghcr.io/oerd/agents-in-the-cloud");
  expect(String(imageRepository(owner, "system"))).toBe("ghcr.io/oerd/agents-in-the-cloud-system");
  expect(String(imageRepository(owner, "workspace"))).toBe("ghcr.io/oerd/agents-in-the-cloud-workspace");
  expect(String(imageRepository(owner, "docker"))).toBe("ghcr.io/oerd/agents-in-the-cloud-docker");
});

test("GHCR references retain their full repository and drop tags or digests", () => {
  expect(String(ghcrRepository("ghcr.io/oerd/agents-in-the-cloud:latest"))).toBe("ghcr.io/oerd/agents-in-the-cloud");
  expect(String(ghcrRepository(`ghcr.io/oerd/agents-in-the-cloud:latest@sha256:${"a".repeat(64)}`))).toBe("ghcr.io/oerd/agents-in-the-cloud");
  expect(String(ghcrRepository("ghcr.io/myorg/team/agents-in-the-cloud:latest"))).toBe("ghcr.io/myorg/team/agents-in-the-cloud");
  expect(ghcrRepository("sha256:abc")).toBeUndefined();
  expect(() => requireGhcrRepository("registry.example/app")).toThrow("Not a GHCR repository");
});

test("runtime repository parsing does not impose publishing-owner rules", () => {
  expect(String(ghcrRepository("ghcr.io/foo-/agents-in-the-cloud:latest"))).toBe("ghcr.io/foo-/agents-in-the-cloud");
  expect(String(ghcrRepository("ghcr.io/my.org/agents-in-the-cloud:latest"))).toBe("ghcr.io/my.org/agents-in-the-cloud");
});

test("registry login reads the owner without rejecting nested repositories", () => {
  expect(String(ownerFromRepository("ghcr.io/oerd/agents-in-the-cloud"))).toBe("oerd");
  expect(String(ownerFromRepository("ghcr.io/myorg/team/agents-in-the-cloud"))).toBe("myorg");
});

test("an installed GHCR image chooses the complete update repository", () => {
  expect(String(appRepositoryFromImage("ghcr.io/oerd/agents-in-the-cloud-dev:sha-abc"))).toBe("ghcr.io/oerd/agents-in-the-cloud-dev");
  expect(String(appRepositoryFromImage("ghcr.io/myorg/team/agents-in-the-cloud:latest"))).toBe("ghcr.io/myorg/team/agents-in-the-cloud");
  expect(String(appRepositoryFromImage("local:dev"))).toBe("ghcr.io/lucasmeijer/agents-in-the-cloud");
});
