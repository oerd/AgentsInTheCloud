const upstreamOwner = "lucasmeijer";

const ownerPattern = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/;

export type RegistryOwner = string & { readonly RegistryOwner: unique symbol };

export const imageNames = {
  app: "agents-in-the-cloud",
  system: "agents-in-the-cloud-system",
  workspace: "agents-in-the-cloud-workspace",
  docker: "agents-in-the-cloud-docker",
} as const;

export type ImageRole = keyof typeof imageNames;

export interface OwnerSources {
  ghcrOwner?: string;
  githubRepositoryOwner?: string;
  originUrl?: string;
}

function isRegistryOwner(value: string): value is RegistryOwner {
  return ownerPattern.test(value);
}

export function parseRegistryOwner(value: string): RegistryOwner {
  const owner = value.trim().toLowerCase();
  if (!isRegistryOwner(owner)) throw new Error(`GHCR owner must be a GitHub username, got ${JSON.stringify(value.trim())}`);
  return owner;
}

export function githubOwnerFromRemote(url: string): string | undefined {
  const trimmed = url.trim();
  if (!trimmed) return undefined;
  let path: string | undefined;
  const ssh = /^git@github\.com:(.+)$/.exec(trimmed);
  if (ssh?.[1]) path = ssh[1];
  else {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return undefined;
    }
    if (parsed.hostname !== "github.com") return undefined;
    path = parsed.pathname.replace(/^\//, "");
  }
  const owner = path.replace(/\.git$/, "").split("/")[0];
  if (!owner || !ownerPattern.test(owner.toLowerCase())) return undefined;
  return owner;
}

export function resolveRegistryOwner(sources: OwnerSources = {}): RegistryOwner {
  const explicit = sources.ghcrOwner?.trim();
  if (explicit) return parseRegistryOwner(explicit);
  const actions = sources.githubRepositoryOwner?.trim();
  if (actions) return parseRegistryOwner(actions);
  const fromOrigin = sources.originUrl ? githubOwnerFromRemote(sources.originUrl) : undefined;
  if (fromOrigin) return parseRegistryOwner(fromOrigin);
  return parseRegistryOwner(upstreamOwner);
}

export function registryOwnerFrom(env: { GHCR_OWNER?: string; GITHUB_REPOSITORY_OWNER?: string }, originUrl?: string): RegistryOwner {
  return resolveRegistryOwner({
    ghcrOwner: env.GHCR_OWNER,
    githubRepositoryOwner: env.GITHUB_REPOSITORY_OWNER,
    originUrl,
  });
}

export function imageRepository(owner: RegistryOwner, role: ImageRole): string {
  return `ghcr.io/${owner}/${imageNames[role]}`;
}

export function appPackagePath(owner: RegistryOwner): string {
  return `${owner}/${imageNames.app}`;
}

export function ghcrRepository(ref: string): string | undefined {
  const named = (ref.split("@")[0] ?? "").split(":")[0] ?? "";
  if (!/^ghcr\.io\/[^/]+\/[^/]+$/.test(named)) return undefined;
  return named;
}

export function ownerFromRepository(repository: string): RegistryOwner {
  const match = /^ghcr\.io\/([^/]+)\/[^/]+$/.exec(repository);
  if (!match?.[1]) throw new Error(`Not a GHCR repository: ${repository}`);
  return parseRegistryOwner(match[1]);
}

export function selectAppRepository(input: { appImage?: string; ghcrOwner?: string } = {}): string {
  const fromImage = input.appImage ? ghcrRepository(input.appImage) : undefined;
  if (fromImage) return fromImage;
  return imageRepository(resolveRegistryOwner({ ghcrOwner: input.ghcrOwner }), "app");
}

export function channelRepository(input: { remembered?: string; ghcrOwner?: string } = {}): string {
  if (input.remembered && ghcrRepository(input.remembered) === input.remembered) return input.remembered;
  return imageRepository(resolveRegistryOwner({ ghcrOwner: input.ghcrOwner }), "app");
}
