import { expect, test } from "bun:test";
import { ImageRepository, productImages } from "./image-reference.ts";

const digest = `sha256:${"a".repeat(64)}`;

test("product images are the Docker Hub app repository and its two suffixes", () => {
  expect(productImages.app.reference()).toBe("docker.io/oerd/agents-in-the-cloud");
  expect(productImages.workspace.reference()).toBe("docker.io/oerd/agents-in-the-cloud-workspace");
  expect(productImages.system.reference()).toBe("docker.io/oerd/agents-in-the-cloud-system");
  expect(ImageRepository.parse("ghcr.io/lucasmeijer/agents-in-the-cloud").workspace().reference()).toBe("ghcr.io/lucasmeijer/agents-in-the-cloud-workspace");
  expect(ImageRepository.parse("ghcr.io/lucasmeijer/agents-in-the-cloud").system().reference()).toBe("ghcr.io/lucasmeijer/agents-in-the-cloud-system");
});

test("parse accepts a host and name and rejects a tag, a digest, and a short name", () => {
  expect(ImageRepository.parse("docker.io/oerd/agents-in-the-cloud").reference()).toBe("docker.io/oerd/agents-in-the-cloud");
  expect(ImageRepository.parse("localhost:5000/org/app").reference()).toBe("localhost:5000/org/app");
  expect(() => ImageRepository.parse("docker.io/oerd/agents-in-the-cloud:latest")).toThrow("Image repository includes a tag: docker.io/oerd/agents-in-the-cloud:latest");
  expect(() => ImageRepository.parse(`docker.io/oerd/agents-in-the-cloud@${digest}`)).toThrow(`Image repository includes a digest: docker.io/oerd/agents-in-the-cloud@${digest}`);
  expect(() => ImageRepository.parse("oerd/agents-in-the-cloud")).toThrow("Image repository requires a registry host: oerd/agents-in-the-cloud");
  expect(() => ImageRepository.parse("docker.io/oerd/agents-in-the-cloud ")).toThrow('Image repository contains whitespace: "docker.io/oerd/agents-in-the-cloud "');
});

test("Docker Hub RepoDigests match with or without the registry host", () => {
  expect(productImages.app.matchesRepoDigest(`docker.io/oerd/agents-in-the-cloud@${digest}`)).toBe(true);
  expect(productImages.app.matchesRepoDigest(`oerd/agents-in-the-cloud@${digest}`)).toBe(true);
  expect(productImages.app.matchesRepoDigest(`docker.io/other/agents-in-the-cloud@${digest}`)).toBe(false);
  const ghcr = ImageRepository.parse("ghcr.io/lucasmeijer/agents-in-the-cloud");
  expect(ghcr.matchesRepoDigest(`ghcr.io/lucasmeijer/agents-in-the-cloud@${digest}`)).toBe(true);
  expect(ghcr.matchesRepoDigest(`lucasmeijer/agents-in-the-cloud@${digest}`)).toBe(false);
});

test("tags and digests are appended to the repository", () => {
  expect(productImages.app.tagged("latest")).toBe("docker.io/oerd/agents-in-the-cloud:latest");
  expect(productImages.system.tagged("latest")).toBe("docker.io/oerd/agents-in-the-cloud-system:latest");
  expect(productImages.app.withDigest(digest)).toBe(`docker.io/oerd/agents-in-the-cloud@${digest}`);
  expect(() => productImages.app.tagged("sha256:abc")).toThrow('Invalid image tag: "sha256:abc"');
  expect(() => productImages.app.withDigest("sha256:abc")).toThrow("Invalid image digest: sha256:abc");
});

test("only ghcr.io asks for a package token", () => {
  expect(productImages.app.pushAuth()).toEqual({ kind: "existing-login" });
  expect(productImages.workspace.pushAuth()).toEqual({ kind: "existing-login" });
  expect(productImages.system.pushAuth()).toEqual({ kind: "existing-login" });
  expect(ImageRepository.parse("example.com/org/name").pushAuth()).toEqual({ kind: "existing-login" });
  expect(ImageRepository.parse("ghcr.io/lucasmeijer/agents-in-the-cloud").pushAuth()).toEqual({
    kind: "ghcr-token",
    registry: "ghcr.io",
    username: "lucasmeijer",
  });
});
