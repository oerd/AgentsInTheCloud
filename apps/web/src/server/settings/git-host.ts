import { buttonHtml } from "@agents-in-the-cloud/design-system/button";
import { destructiveConfirmationHtml } from "@agents-in-the-cloud/design-system/destructive-confirmation";
import { cloudForge, cloudForges, type ForgeId } from "@agents-in-the-cloud/core/cloud-forges";
import { clearForgeAccount, hasForgeAccount, setForgeAccount } from "@agents-in-the-cloud/proxy-egress";
import { getStoredCommitIdentity, setCommitIdentity } from "@agents-in-the-cloud/workspace-templates";
import { validateForgeAccount, type ForgeAccountInput } from "../forge-auth.ts";
import { renderOnboardingDialog } from "../onboarding/routes.ts";
import { replace, stream, update } from "@agents-in-the-cloud/shared/http";
import { renderCommitIdentityForm } from "./page.ts";
import { domId, escapeHtml, providerBadgeHtml } from "@agents-in-the-cloud/shared";
import { registerSettingsContribution } from "./registry.ts";

export type SettingsSurface = "settings" | "onboarding";

const forgeSettingsPath = /^\/settings\/([a-z]+)\/(connect|disconnect)$/;

export function parseForgeSettingsPath(pathname: string): { forge: ForgeId; action: "connect" | "disconnect" } | undefined {
  const match = forgeSettingsPath.exec(pathname);
  if (!match) return undefined;
  const forge = cloudForges.find((candidate) => candidate.id === match[1])?.id;
  const action = match[2];
  if (!forge || (action !== "connect" && action !== "disconnect")) return undefined;
  return { forge, action };
}

export function forgeSectionId(forge: ForgeId): string {
  return `settings-sec-${forge}`;
}

export function forgeAccountInput(forge: ForgeId, form: FormData): ForgeAccountInput {
  const token = String(form.get("token") ?? "");
  switch (forge) {
    case "github":
      return { forge, token };
    case "bitbucket":
      return { forge, email: String(form.get("email") ?? ""), token };
    default: {
      const unreachable: never = forge;
      throw new Error(`Unknown forge ${String(unreachable)}`);
    }
  }
}

export function renderForgeConnectButton(forge: ForgeId, surface: SettingsSurface): string {
  return buttonHtml({
    type: "submit",
    variant: "primary",
    content: { kind: "caption", caption: "Connect" },
    attributesHtml: `form="${domId(surface, `${forge}-connect-form`)}"`,
  });
}

function forgeAction(forge: ForgeId, surface: SettingsSurface, action: "connect" | "disconnect"): string {
  const path = `/settings/${forge}/${action}`;
  return forge === "github" && surface === "onboarding" ? `${path}?surface=onboarding` : path;
}

function githubConnectionForm(surface: SettingsSurface, error: string): string {
  const rowClass = surface === "settings" ? " git-host-connect-form--row" : "";
  const connectButton = surface === "onboarding" ? "" : renderForgeConnectButton("github", surface);
  return `<form id="${domId(surface, "github-connect-form")}" class="git-host-connect-form${rowClass} form-stack" method="post" action="${forgeAction("github", surface, "connect")}" data-turbo="true">
    <p>Run these commands on your own computer:</p>
    <pre class="settings-command">gh auth login
gh auth token</pre>
    <p>Paste the token below. AgentsInTheCloud keeps it outside Agent sandboxes, so Agents can access your GitHub repositories without seeing the token.</p>
    ${error ? `<p class="settings-error">${escapeHtml(error)}</p>` : ""}
    <div class="git-host-connect-controls"><input class="settings-input text-field" type="password" data-1p-ignore name="token" placeholder="Paste output from gh auth token" aria-label="GitHub token" autocomplete="off" required>${connectButton}</div>
  </form>`;
}

function bitbucketConnectionForm(surface: SettingsSurface, error: string): string {
  const connectButton = renderForgeConnectButton("bitbucket", surface);
  return `<form id="${domId(surface, "bitbucket-connect-form")}" class="git-host-connect-form git-host-connect-form--row form-stack" method="post" action="${forgeAction("bitbucket", surface, "connect")}" data-turbo="true">
    <p>Create an API token with Bitbucket scopes on your Atlassian account. Then run this on your own computer:</p>
    <pre class="settings-command">${escapeHtml("bkt auth login https://bitbucket.org --kind cloud --username you@example.com --token <api-token>")}</pre>
    <p>Paste that email and token here. The token stays outside Agent sandboxes, so Agents can use your Bitbucket repositories without seeing it.</p>
    ${error ? `<p class="settings-error">${escapeHtml(error)}</p>` : ""}
    <input class="settings-input text-field" type="email" name="email" placeholder="Atlassian email" aria-label="Atlassian email" autocomplete="off" data-1p-ignore required>
    <div class="git-host-connect-controls"><input class="settings-input text-field" type="password" data-1p-ignore name="token" placeholder="API token" aria-label="API token" autocomplete="off" required>${connectButton}</div>
  </form>`;
}

function connectionForm(forge: ForgeId, surface: SettingsSurface, error: string): string {
  switch (forge) {
    case "github":
      return githubConnectionForm(surface, error);
    case "bitbucket":
      return bitbucketConnectionForm(surface, error);
    default: {
      const unreachable: never = forge;
      throw new Error(`Unknown forge ${String(unreachable)}`);
    }
  }
}

export function renderForgeConnection(forge: ForgeId, surface: SettingsSurface = "settings", error = ""): string {
  const connected = hasForgeAccount(forge);
  const id = domId(surface, "provider", forge);
  const label = cloudForge(forge).label;
  if (forge === "github" && surface === "onboarding" && !connected) return `<div class="git-host-connection" id="${id}">${connectionForm(forge, surface, error)}</div>`;
  const disconnectAction = forgeAction(forge, surface, "disconnect");
  const confirmation = destructiveConfirmationHtml({
    id: `disconnect_${forge}`,
    trigger: { type: "button", variant: "danger", content: { kind: "caption", caption: "Disconnect" } },
    confirmCaption: `Disconnect ${label}`,
    cancelCaption: "Cancel",
  });
  return `<div class="git-host-connection" id="${id}"><div class="managed-list" data-controller="managed-list"><div class="managed-list__item">
    ${providerBadgeHtml(forge, label, "settings-provider-icon managed-list__visual")}
    <div class="managed-list__content"><div class="managed-list__label"><span class="managed-list__label-text">${escapeHtml(label)}</span></div>${connected ? "" : connectionForm(forge, surface, error)}</div>
    ${connected ? `<div class="managed-list__actions"><form method="post" action="${disconnectAction}" data-turbo="true">${confirmation}</form></div>` : ""}
  </div></div></div>`;
}

export async function renderForgeSection(forge: ForgeId): Promise<string> {
  return `<section class="settings-sec settings-sec-git-host" id="${forgeSectionId(forge)}">${renderForgeConnection(forge)}</section>`;
}

export async function handleForgeSettingsRequest(request: Request, url: URL): Promise<Response | undefined> {
  const parsed = parseForgeSettingsPath(url.pathname);
  if (!parsed || request.method !== "POST") return undefined;
  const surface = parsed.forge === "github" && url.searchParams.get("surface") === "onboarding" ? "onboarding" : "settings";

  if (parsed.action === "disconnect") {
    clearForgeAccount(parsed.forge);
    if (surface === "onboarding") return stream(update("onboarding_modal_host", await renderOnboardingDialog()));
    return stream(replace(forgeSectionId(parsed.forge), await renderForgeSection(parsed.forge)));
  }

  const validation = await validateForgeAccount(forgeAccountInput(parsed.forge, await request.formData()));
  if (!validation.ok) {
    return stream(replace(domId(surface, "provider", parsed.forge), renderForgeConnection(parsed.forge, surface, validation.message)));
  }
  setForgeAccount(validation.account);
  if (!await getStoredCommitIdentity()) await setCommitIdentity({ name: validation.commitName, email: validation.commitEmail });
  if (surface === "onboarding") return stream(update("onboarding_modal_host", await renderOnboardingDialog({ resumeAfter: "github" })));
  return stream(
    `${replace(forgeSectionId(parsed.forge), await renderForgeSection(parsed.forge))}`
    + `${replace("settings_commit_identity", await renderCommitIdentityForm())}`
    + `${update("onboarding_modal_host", await renderOnboardingDialog())}`,
  );
}

for (const [index, forge] of cloudForges.entries()) {
  registerSettingsContribution({
    id: forge.id,
    label: forge.label,
    order: 30 + index,
    render: () => renderForgeSection(forge.id),
  });
}
