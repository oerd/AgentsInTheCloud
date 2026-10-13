import { listWorkspaces } from "@agents-in-the-cloud/workspace";
import type { WorkspaceModule } from "@agents-in-the-cloud/shared";
import { ensureWorkspaceEgressProxy, registerWorkspaceProxyEvents } from "../egress/egress-proxy.ts";
import { startPrivateNetworkFirewallSync } from "../egress/private-network-firewall.ts";

export const proxyEgressServerModule: WorkspaceModule = {
  id: "proxy-egress",
  async initialize(context) {
    registerWorkspaceProxyEvents(context.events);
    const { workspaces } = await listWorkspaces({ inspectImages: false });
    for (const workspace of workspaces) await ensureWorkspaceEgressProxy(workspace.id);
    startPrivateNetworkFirewallSync(context.events, workspaces);
  },
};

export { proxyEgressServerModule as agentsInTheCloudServerModule };
export {
  registerWorkspaceSubscriptionSecrets,
  registerWorkspaceRequestTransform,
  registerWorkspaceResponseTransform,
  clearForgeAccount,
  clearForgeAccounts,
  createWorkspaceSecretContext,
  discoverForgeAccount,
  discoverForgeAccounts,
  hasForgeAccount,
  setForgeAccount,
} from "../secrets/workspace-secrets.ts";
export { HttpRequestBlockedError } from "../secrets/errors.ts";

export type { SecretRequestTransform } from "../secrets/placeholder-hooks.ts";
