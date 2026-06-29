import { getTool, executeTool } from "./lib/tools";

const USER_ID = "candidate";

// load a single tool by slug
const tool = await getTool("GOOGLESUPER_SEND_EMAIL");
if (!tool) {
  console.error("Tool not found — is your COMPOSIO_API_KEY set?");
  process.exit(1);
}

console.log("Loaded tool:", tool.slug ?? tool.name);
console.log("Description:", tool.description?.slice(0, 120));
console.log("Parameters:", JSON.stringify(tool.inputParameters, null, 2).slice(0, 500));
