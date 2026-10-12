const upstreamOwner = "lucasmeijer";

const ownerPattern = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/;
const repositorySegmentPattern = /^[a-z0-9][a-z0-9._-]*$/;

export type RegistryOwner = string & { readonly RegistryOwner: unique symbol };
export type GhcrRepository = string & { readonly GhcrRepository: unique symbol };

export const imageNames = {
  app: "agents-in-the-cloud",
  system: "agents-in-the-cloud-system",
  workspace: "agents-in-the-cloud-workspace",
  docker: "agents-in-the-cloud-docker",
} as const;

export const appRepositoryLabel = "agents-in-the-cloud.app-repository";

export type ImageRole = keyof typeof imageNames;

function isRegistryOwner(value: string): value is RegistryOwner {
  return ownerPattern.test(value);
}

export function parseRegistryOwner(value: string): RegistryOwner {
  const owner = value.trim().toLowerCase();
  if (!isRegistryOwner(owner)) throw new Error(`GHCR owner must be a GitHub username, got ${JSON.stringify(value.trim())}`);
  return owner;
}

export function imageRepository(owner: RegistryOwner, role: ImageRole): GhcrRepository {
  // SAFETY: RegistryOwner and the fixed image names satisfy the GHCR repository grammar.
  return `ghcr.io/${owner}/${imageNames[role]}` as GhcrRepository;
}

export function upstreamImageRepository(role: ImageRole): GhcrRepository {
  return imageRepository(parseRegistryOwner(upstreamOwner), role);
}

function repositoryName(reference: string): string {
  let named = reference.trim().split("@", 1)[0] ?? "";
  const tag = named.lastIndexOf(":");
  if (tag > named.lastIndexOf("/")) named = named.slice(0, tag);
  return named;
}

/** Returns a normalized GHCR repository, without a tag or digest. */
export function ghcrRepository(reference: string): GhcrRepository | undefined {
  const named = repositoryName(reference);
  if (!named.startsWith("ghcr.io/")) return undefined;
  const segments = named.slice("ghcr.io/".length).split("/");
  if (segments.length < 2 || segments.some((segment) => !repositorySegmentPattern.test(segment))) return undefined;
  // SAFETY: The registry prefix and every path segment were validated above.
  return named as GhcrRepository;
}

export function requireGhcrRepository(reference: string): GhcrRepository {
  const repository = ghcrRepository(reference);
  if (!repository) throw new Error(`Not a GHCR repository: ${reference}`);
  return repository;
}

/** Registry login uses the namespace, while image identity keeps the full repository. */
export function ownerFromRepository(repository: string): RegistryOwner {
  const normalized = requireGhcrRepository(repository);
  return parseRegistryOwner(normalized.slice("ghcr.io/".length).split("/", 1)[0]!);
}

/** Non-GHCR development images keep the established upstream update line. */
export function appRepositoryFromImage(reference: string): GhcrRepository {
  return ghcrRepository(reference) ?? upstreamImageRepository("app");
}
