import { createCliAgentModule, emptyAgentInput } from "@agents-in-the-cloud/cli-agent/server";
import { providerBrandIconHtml } from "@agents-in-the-cloud/shared";
import { cursorLaunchScript } from "./launch-command.ts";
import { cursorAgentId, prepareCursorSession } from "./session.ts";

export const agentsInTheCloudServerModule = createCliAgentModule({
  id: cursorAgentId,
  label: "Cursor",
  iconHtml: providerBrandIconHtml("cursor", "Cursor"),
  async requireSetup() {},
  settings: {
    async renderFooter() { return ""; },
    async prepare() { return {}; },
  },
  prepareSession: prepareCursorSession,
  launchScript: (input, imagePaths, settings, session) => cursorLaunchScript(input, imagePaths, settings, session),
  resumeScript: async (_workspaceId, settings, session) => cursorLaunchScript(emptyAgentInput(), [], settings, session),
});
