import { createCliAgentModule } from "@agents-in-the-cloud/cli-agent/server";
import { providerBrandIconHtml } from "@agents-in-the-cloud/shared";

export const agentsInTheCloudServerModule = createCliAgentModule({
  id: "cursor",
  label: "Cursor",
  iconHtml: providerBrandIconHtml("cursor", "Cursor"),
  async requireSetup() {},
  settings: {
    async renderFooter() { return ""; },
    async prepare() { return {}; },
  },
  async prepareSession() { return {}; },
  launchScript() { return "printf '%s\\n' 'Cursor is not installed yet'\nexit 1\n"; },
  async resumeScript() { return "printf '%s\\n' 'Cursor is not installed yet'\nexit 1\n"; },
});
