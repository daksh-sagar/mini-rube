import { connectAllAccounts } from "./lib/auth";

const USER_ID = "candidate";

console.log("Connecting accounts for all configured toolkits...\n");

const connections = await connectAllAccounts(USER_ID);

for (const { toolkit, link } of connections) {
  const url = (link as any).redirectUrl ?? (link as any).url;
  console.log(`${toolkit}: ${url ?? "already connected"}`);
}

console.log("\nVisit the URLs above to authorize, then wait...\n");

for (const { toolkit, link } of connections) {
  await link.waitForConnection();
  console.log(`${toolkit}: connected`);
}

console.log("\nAll accounts connected! Run `bun src/example.ts` to verify.");
