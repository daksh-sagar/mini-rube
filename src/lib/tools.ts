import { composio } from "./composio";

/**
 * Get a single tool by slug.
 */
export async function getTool(slug: string) {
  const results = await composio.tools.getRawComposioTools({ tools: [slug] });
  return results[0] ?? null;
}

/**
 * List all available tool slugs for the given toolkits.
 */
export async function listToolSlugs(
  toolkits: string[] = ["googlesuper", "github", "composio_search"]
) {
  const bySlug = new Map<string, { slug: string; description: string }>();

  for (const toolkit of toolkits) {
    const tools = await composio.tools.getRawComposioTools({ toolkits: [toolkit], limit: 500 });
    for (const tool of tools) {
      const slug = String(tool.slug ?? tool.name ?? "").trim();
      if (!slug) continue;
      bySlug.set(slug, { slug, description: String(tool.description ?? "") });
    }
  }

  return [...bySlug.values()];
}

/**
 * Execute a Composio tool by name.
 */
export async function executeTool(
  toolName: string,
  userId: string,
  args: Record<string, unknown> = {}
) {
  return composio.tools.execute(toolName, {
    userId,
    dangerouslySkipVersionCheck: true,
    arguments: args,
  });
}
