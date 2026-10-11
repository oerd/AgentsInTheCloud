export type PushAuth =
  | { readonly kind: "existing-login" }
  | { readonly kind: "ghcr-token"; readonly registry: "ghcr.io"; readonly username: "lucasmeijer" };

export class ImageRepository {
  readonly #host: string;
  readonly #name: string;

  private constructor(host: string, name: string) {
    this.#host = host;
    this.#name = name;
  }

  static parse(reference: string): ImageRepository {
    if (reference.length === 0) throw new Error("Image repository is empty");
    if (/\s/.test(reference)) throw new Error(`Image repository contains whitespace: ${JSON.stringify(reference)}`);
    if (reference.includes("@")) throw new Error(`Image repository includes a digest: ${reference}`);
    const slash = reference.indexOf("/");
    const host = slash === -1 ? "" : reference.slice(0, slash);
    const name = slash === -1 ? reference : reference.slice(slash + 1);
    const explicitHost = host.includes(".") || host.includes(":") || host === "localhost";
    if (!explicitHost || slash <= 0) throw new Error(`Image repository requires a registry host: ${reference}`);
    if (!name.includes("/")) throw new Error(`Image repository name requires a slash: ${reference}`);
    if (name.includes(":")) throw new Error(`Image repository includes a tag: ${reference}`);
    return new ImageRepository(host, name);
  }

  reference(): string {
    return `${this.#host}/${this.#name}`;
  }

  tagged(tag: string): string {
    if (tag.length === 0 || /[\s@:/]/.test(tag)) throw new Error(`Invalid image tag: ${JSON.stringify(tag)}`);
    return `${this.reference()}:${tag}`;
  }

  withDigest(digest: string): string {
    if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error(`Invalid image digest: ${digest}`);
    return `${this.reference()}@${digest}`;
  }

  matchesRepoDigest(repoDigest: string): boolean {
    const at = repoDigest.lastIndexOf("@");
    if (at <= 0) return false;
    const repository = repoDigest.slice(0, at);
    const digest = repoDigest.slice(at + 1);
    if (!/^sha256:[a-f0-9]{64}$/.test(digest)) return false;
    if (repository === this.reference()) return true;
    // Docker Hub lists RepoDigests without the docker.io host.
    return this.#host === "docker.io" && repository === this.#name;
  }

  pushAuth(): PushAuth {
    if (this.#host === "ghcr.io") return { kind: "ghcr-token", registry: "ghcr.io", username: "lucasmeijer" };
    return { kind: "existing-login" };
  }

  workspace(): ImageRepository {
    return this.#withSuffix("workspace");
  }

  system(): ImageRepository {
    return this.#withSuffix("system");
  }

  #withSuffix(suffix: "workspace" | "system"): ImageRepository {
    return ImageRepository.parse(`${this.reference()}-${suffix}`);
  }
}

const app = ImageRepository.parse("docker.io/oerd/agents-in-the-cloud");

export const productImages = {
  app,
  workspace: app.workspace(),
  system: app.system(),
} satisfies {
  readonly app: ImageRepository;
  readonly workspace: ImageRepository;
  readonly system: ImageRepository;
};
