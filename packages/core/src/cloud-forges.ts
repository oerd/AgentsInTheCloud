export type GitHubForge = {
  readonly id: "github";
  readonly label: "GitHub";
  readonly gitHost: "github.com";
  readonly apiHost: "api.github.com";
  readonly gitUsername: "x-access-token";
  readonly tokenEnv: "GH_TOKEN";
  readonly hostFallbackEnv: "GH_TOKEN";
  readonly storeFile: "github-token";
  readonly disabledFile: "github-token-disabled";
  readonly plainEnv: readonly [];
};

export type BitbucketForge = {
  readonly id: "bitbucket";
  readonly label: "Bitbucket";
  readonly gitHost: "bitbucket.org";
  readonly apiHost: "api.bitbucket.org";
  readonly gitUsername: "x-bitbucket-api-token-auth";
  readonly tokenEnv: "BKT_TOKEN";
  readonly hostFallbackTokenEnv: "BKT_TOKEN";
  readonly hostFallbackEmailEnv: "BKT_USERNAME";
  readonly storeFile: "bitbucket-account";
  readonly disabledFile: "bitbucket-account-disabled";
  readonly plainEnv: readonly [
    { readonly name: "BKT_HOST"; readonly literal: "https://bitbucket.org" },
    { readonly name: "BKT_USERNAME"; readonly field: "email" },
    { readonly name: "BKT_AUTH_METHOD"; readonly literal: "basic" },
  ];
};

export type CloudForge = GitHubForge | BitbucketForge;

export const cloudForges: readonly [GitHubForge, BitbucketForge] = [
  {
    id: "github",
    label: "GitHub",
    gitHost: "github.com",
    apiHost: "api.github.com",
    gitUsername: "x-access-token",
    tokenEnv: "GH_TOKEN",
    hostFallbackEnv: "GH_TOKEN",
    storeFile: "github-token",
    disabledFile: "github-token-disabled",
    plainEnv: [],
  },
  {
    id: "bitbucket",
    label: "Bitbucket",
    gitHost: "bitbucket.org",
    apiHost: "api.bitbucket.org",
    gitUsername: "x-bitbucket-api-token-auth",
    tokenEnv: "BKT_TOKEN",
    hostFallbackTokenEnv: "BKT_TOKEN",
    hostFallbackEmailEnv: "BKT_USERNAME",
    storeFile: "bitbucket-account",
    disabledFile: "bitbucket-account-disabled",
    plainEnv: [
      { name: "BKT_HOST", literal: "https://bitbucket.org" },
      { name: "BKT_USERNAME", field: "email" },
      { name: "BKT_AUTH_METHOD", literal: "basic" },
    ],
  },
];

export type ForgeId = CloudForge["id"];

const shellToken = /^[A-Za-z0-9_-]+$/;
const shellHost = /^[A-Za-z0-9.-]+$/;

export function cloudForge(id: ForgeId): CloudForge {
  const forge = cloudForges.find((candidate) => candidate.id === id);
  if (!forge) throw new Error(`Unknown forge ${id}`);
  return forge;
}

export function isSchemeLessCloudForgeSpec(value: string): boolean {
  const trimmed = value.trim().toLowerCase();
  return cloudForges.some((forge) => trimmed.startsWith(`${forge.gitHost}/`));
}

/** Submodule URLs are repository-controlled, so the helper answers only the git host from the tuple. */
export function forgeCredentialHelperShellBody(): string {
  const arms = cloudForges.map((forge) => {
    if (!shellToken.test(forge.gitUsername) || !shellToken.test(forge.tokenEnv) || !shellHost.test(forge.gitHost)) {
      throw new Error(`Forge ${forge.id} cannot be interpolated into the credential helper`);
    }
    return `  ${forge.gitHost}|${forge.gitHost}:443)
    [ -n "\${${forge.tokenEnv}:-}" ] || exit 0
    echo username=${forge.gitUsername}
    echo password="$${forge.tokenEnv}"
    ;;`;
  }).join("\n");
  return `test "$1" = get || exit 0
protocol=
host=
while IFS='=' read -r key value; do
  case "$key" in
    protocol) protocol="$value" ;;
    host) host="$value" ;;
  esac
done
[ "$protocol" = https ] || exit 0
case "$host" in
${arms}
  *) exit 0 ;;
esac`;
}

export function forgeCredentialHelperCommand(): string {
  return `!f() { ${forgeCredentialHelperShellBody()}; }; f`;
}
