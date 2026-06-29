import { Composio } from "@composio/core";

export const composio = new Composio();

export const AUTH_CONFIGS: Record<string, string> = {};

const googleSuperAuthConfigId = process.env.GOOGLESUPER_AUTH_CONFIG_ID;
const githubAuthConfigId = process.env.GITHUB_AUTH_CONFIG_ID;

if (!googleSuperAuthConfigId) {
  throw new Error(
    "GOOGLESUPER_AUTH_CONFIG_ID is not set. Run `COMPOSIO_API_KEY=... sh scaffold.sh` first."
  );
}

if (!githubAuthConfigId) {
  throw new Error(
    "GITHUB_AUTH_CONFIG_ID is not set. Run `COMPOSIO_API_KEY=... sh scaffold.sh` first."
  );
}

AUTH_CONFIGS["googlesuper"] = googleSuperAuthConfigId;
AUTH_CONFIGS["github"] = githubAuthConfigId;
