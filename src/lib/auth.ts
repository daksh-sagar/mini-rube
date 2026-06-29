import { composio, AUTH_CONFIGS } from "./composio";

export type ConnectAccountOptions = {
  callbackUrl?: string;
  forceReconnect?: boolean;
};

/**
 * Connect a user's account for a given toolkit.
 * Returns the OAuth URL the user needs to visit, and waits for the connection to complete.
 */
export async function connectAccount(userId: string, toolkit: string, options: ConnectAccountOptions = {}) {
  const authConfigId = AUTH_CONFIGS[toolkit];
  if (!authConfigId) {
    throw new Error(
      `No auth config for toolkit "${toolkit}". Available: ${Object.keys(AUTH_CONFIGS).join(", ")}`
    );
  }

  if (options.forceReconnect) {
    await deleteConnectedAccountsForToolkit(userId, toolkit);
  }

  const link = await composio.connectedAccounts.link(userId, authConfigId, {
    callbackUrl: options.callbackUrl,
  });
  return link;
}

/**
 * Connect a user to all configured toolkits that need auth.
 * Returns an array of { toolkit, link } objects.
 */
export async function connectAllAccounts(userId: string) {
  const results = [];
  for (const [toolkit, authConfigId] of Object.entries(AUTH_CONFIGS)) {
    const link = await composio.connectedAccounts.link(userId, authConfigId);
    results.push({ toolkit, link });
  }
  return results;
}

/**
 * Get all connected accounts for a user.
 */
export async function getConnectedAccounts(userId: string) {
  return composio.connectedAccounts.list({ userIds: [userId] });
}

export async function getConnectedAccountsForToolkit(userId: string, toolkit: string) {
  const authConfigId = AUTH_CONFIGS[toolkit];
  if (!authConfigId) {
    return [];
  }
  const response = await composio.connectedAccounts.list({
    userIds: [userId],
    authConfigIds: [authConfigId],
  });
  return normalizeConnectionList(response);
}

export async function deleteConnectedAccountsForToolkit(userId: string, toolkit: string) {
  const accounts = await getConnectedAccountsForToolkit(userId, toolkit);
  await Promise.all(
    accounts.map((account) => {
      const id = typeof account.id === "string" ? account.id : "";
      return id ? composio.connectedAccounts.delete(id).catch(() => undefined) : undefined;
    })
  );
}

export async function deleteConnectedAccount(connectionId: string) {
  if (!connectionId) {
    return;
  }
  await composio.connectedAccounts.delete(connectionId).catch(() => undefined);
}

function normalizeConnectionList(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    return value.filter(isRecord);
  }
  if (!isRecord(value)) {
    return [];
  }
  for (const key of ["items", "data", "connectedAccounts", "connected_accounts"]) {
    const candidate = value[key];
    if (Array.isArray(candidate)) {
      return candidate.filter(isRecord);
    }
  }
  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
