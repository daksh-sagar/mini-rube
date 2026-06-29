#!/bin/bash

set -e

if [ -z "$COMPOSIO_API_KEY" ]; then
	echo "Error: COMPOSIO_API_KEY is not set" >&2
	exit 1
fi

OPENROUTER_API_KEY="${OPENROUTER_API_KEY:-}"

if [ -z "$OPENROUTER_API_KEY" ]; then
	echo "OPENROUTER_API_KEY is not set; .env will include a blank value for you to fill manually."
fi

echo "Creating or updating auth configs..."

# Use bun to run scaffold logic
bun -e "
import { Composio } from '@composio/core';
import { authToolsForToolkit } from './src/lib/auth-requirements.ts';

const composio = new Composio({ apiKey: process.env.COMPOSIO_API_KEY });
const googleSuperTools = authToolsForToolkit('googlesuper');
const githubTools = authToolsForToolkit('github');

async function readExistingEnv() {
  try {
    const text = await Bun.file('.env').text();
    return Object.fromEntries(
      text
        .split(/\\r?\\n/)
        .map((line) => line.match(/^([A-Z0-9_]+)=(.*)$/))
        .filter(Boolean)
        .map((match) => [match[1], match[2]])
    );
  } catch {
    return {};
  }
}

async function ensureAuthConfig(toolkit, name, tools, existingId) {
  if (existingId) {
    try {
      await composio.authConfigs.update(existingId, {
        type: 'default',
        toolAccessConfig: {
          toolsForConnectedAccountCreation: tools,
        },
      });
      console.log('updated auth config:', toolkit, existingId);
      return { id: existingId };
    } catch (error) {
      console.warn('could not update auth config; creating a new one:', toolkit, error?.message ?? error);
    }
  }

  const created = await composio.authConfigs.create(toolkit, {
    name,
    type: 'use_composio_managed_auth',
    toolAccessConfig: {
      toolsForConnectedAccountCreation: tools,
    },
  });
  console.log('created auth config:', toolkit, created.id);
  return created;
}

const existingEnv = await readExistingEnv();
const googleSuperAuthConfig = await ensureAuthConfig(
  'googlesuper',
  'Mini Rube Auth Config',
  googleSuperTools,
  process.env.GOOGLESUPER_AUTH_CONFIG_ID ?? existingEnv.GOOGLESUPER_AUTH_CONFIG_ID
);
const githubAuthConfig = await ensureAuthConfig(
  'github',
  'Mini Rube GitHub Auth Config',
  githubTools,
  process.env.GITHUB_AUTH_CONFIG_ID ?? existingEnv.GITHUB_AUTH_CONFIG_ID
);
const openRouterKey = process.env.OPENROUTER_API_KEY ?? existingEnv.OPENROUTER_API_KEY ?? '';

const envContent = \`COMPOSIO_API_KEY=\${process.env.COMPOSIO_API_KEY}
GOOGLESUPER_AUTH_CONFIG_ID=\${googleSuperAuthConfig.id}
GITHUB_AUTH_CONFIG_ID=\${githubAuthConfig.id}
OPENROUTER_API_KEY=\${openRouterKey}\`;

await Bun.write('.env', envContent);
console.log('env file created');
console.log('  googlesuper auth config:', googleSuperAuthConfig.id);
console.log('  github auth config:', githubAuthConfig.id);
"

echo ""
echo "Done! Add OPENROUTER_API_KEY to .env, then run: bun --hot src/server.ts"
