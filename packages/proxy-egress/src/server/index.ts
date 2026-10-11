import { listWorkspaces } from "@agents-in-the-cloud/workspace";
import type { WorkspaceModule } from "@agents-in-the-cloud/shared";
import { ensureWorkspaceEgressProxy, registerWorkspaceProxyEvents } from "../egress/egress-proxy.ts";

export const proxyEgressServerModule: WorkspaceModule = {
  id: "proxy-egress",
  async initialize(context) {
    registerWorkspaceProxyEvents(context.events);
    for (const workspace of (await listWorkspaces({ inspectImages: false })).workspaces) await ensureWorkspaceEgressProxy(workspace.id);
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
