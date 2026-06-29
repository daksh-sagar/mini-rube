# Mini Rube

Mini Rube is a local web app for chatting with an agent that can use Google apps
and GitHub through Composio.

It can read Gmail, draft or send emails after confirmation, work with Calendar,
Drive, Sheets, and GitHub issues, and run larger workflows such as writing GitHub
issues or Drive resumes into a Google Sheet.

## Quick Start

### 1. Install Bun

This app runs on Bun.

```sh
bun --version
```

If Bun is not installed, install it from <https://bun.sh>.

### 2. Install dependencies

```sh
bun install
```

### 3. Create `.env`

You need two accounts/keys:

- a Composio API key
- an OpenRouter API key

The easiest setup is to let the scaffold script create the Composio auth configs:

```sh
COMPOSIO_API_KEY=your_composio_key sh scaffold.sh
```

Then open `.env` and add:

```sh
OPENROUTER_API_KEY=your_openrouter_key
```

At minimum, `.env` should contain:

```sh
COMPOSIO_API_KEY=...
OPENROUTER_API_KEY=...
GOOGLESUPER_AUTH_CONFIG_ID=...
GITHUB_AUTH_CONFIG_ID=...
```

You usually do not need to set anything else. The app has defaults for models,
token limits, tool selection, workflow page sizes, and concurrency.

### 4. Run the app

```sh
bun run dev
```

Open:

```txt
http://localhost:5173
```

Click `Connect Google` and/or `Connect GitHub`, finish OAuth, then send a prompt.

## Useful Commands

```sh
bun run dev      # Run Bun API server and Vite frontend
bun run server   # Run only the Bun API server on localhost:3001
bun run build    # Build the frontend for production
bun run start    # Run the production Bun server
bun run check    # Type-check the project
bun test         # Run tests
```

## Environment Variables

Required:

- `COMPOSIO_API_KEY`: used to call Composio and upload files.
- `OPENROUTER_API_KEY`: used by the agent models.
- `GOOGLESUPER_AUTH_CONFIG_ID`: Composio auth config for Gmail, Calendar, Drive,
  Sheets, and related Google tools.
- `GITHUB_AUTH_CONFIG_ID`: Composio auth config for GitHub tools.

Optional settings you can override:

- `AGENT_MODEL`: main chat/tool-calling model. Default:
  `anthropic/claude-haiku-4.5`.
- `PLANNER_MODEL`: model used for some JSON routing/planning helpers. Default:
  `deepseek/deepseek-v4-flash`.
- `EXTRACTOR_MODEL`: model used for structured extraction helpers. Default:
  `deepseek/deepseek-v4-flash`.
- `AGENT_MAX_TOKENS`: max length for normal assistant responses. Default: `2048`.
  Use `4096` if you expect longer email or issue summaries.
- `JSON_MAX_TOKENS`: max length for internal JSON helper outputs. Default: `1024`.
- `WORKFLOW_PAGE_SIZE`: page size for large read workflows. Default: `100`.
- `WORKFLOW_SHEET_BATCH_SIZE`: rows per Google Sheets write batch. Default: `100`.
- `WORKFLOW_CONCURRENCY`: parallel work for large workflows. Default: `8`.
- `WORKFLOW_USE_LLM_EXTRACTION`: set to `0` to disable LLM-assisted resume
  extraction. Default: enabled.
- `WORKFLOW_DB_PATH`: local SQLite path for workflow job metadata. Default:
  `.mini-rube/workflows.sqlite`.
- `PORT`: Bun server port. Default: `3001`.
- `BUN_IDLE_TIMEOUT`: Bun server idle timeout in seconds. Default: `120`.

Advanced routing/debug settings:

- `CHAT_TOOL_SELECTION_MODE`: which tool schemas are exposed to the chat model.
  Default: `all_connected`, which exposes every supported tool for connected
  accounts while still using the router for workflow, safety, and mutation
  gating. Set to `routed` to roll back to only the routed tool bundle.
- `TOOL_ROUTER_STRATEGY`: first-layer router strategy. Valid values:
  `llm_first`, `deterministic`, or `shadow`. Default: `llm_first`.
- `TOOL_ROUTER_DISCOVERY`: set to `0` to disable live-catalog discovery in the
  deterministic router path.
- `TOOL_ROUTER_USE_LLM`: set to `0` to force deterministic routing; set to `1`
  to enable LLM refinement when using the deterministic/discovery path.

## How It Works

Mini Rube has two main parts:

- `src/app/`: the React frontend served by Vite in development.
- `src/server.ts`: the Bun backend that talks to Composio and OpenRouter.

In development, Vite serves the frontend on `localhost:5173` and proxies `/api`
requests to the Bun server on `localhost:3001`.

In production, the Bun server also serves the built frontend from
`src/app/dist`.

## Request Flow

1. The browser asks `POST /api/session` for a local user id and stores it in
   `localStorage`.
2. When you click `Connect Google` or `Connect GitHub`, the frontend calls
   `POST /api/connect/:toolkit`.
3. The server asks Composio for an OAuth URL and the browser opens it.
4. After OAuth finishes, the frontend checks connection status through
   `GET /api/connections`.
5. When you send a chat message, the frontend calls `POST /api/chat`.
6. The backend routes the prompt to understand the current task, loads the
   supported tools for the user's connected accounts, calls the model through
   OpenRouter, and streams the response back to the UI.

## Tool Routing

The app does not expose every Composio tool blindly to the model.

The tool surface is first filtered to the Mini Rube product surface: Gmail,
Calendar, Contacts, Drive, Sheets, and GitHub issues. Unsupported tools from the
same Composio toolkits are not exposed.

For common tasks, the app uses an intent registry:

- read Gmail
- send Gmail
- schedule Calendar events
- work with Sheets
- summarize GitHub issues
- process Drive folders of resumes

For normal chat turns, the model gets all supported tools for accounts that are
currently connected. The router is still used as a control layer: it decides
whether the request is a workflow, whether a missing connection should block the
turn, what task context is active, and which mutating tools are authorized.

That last part is important: a read-only prompt may have sheet-writing tools
available in the model's schema list, but the server will block mutating tool
calls unless the latest routed request explicitly allows that exact write.

If the prompt is less obvious, the router can fall back to discovery over the
live Composio tool catalog. This keeps known tasks reliable while still allowing
new phrasing to work.

The main files are:

- `src/lib/intent-registry.ts`: known intents and their preferred tools.
- `src/lib/router.ts`: prompt-to-tool routing.
- `src/lib/tool-catalog.ts`: loads and filters Composio tool schemas.
- `src/lib/tool-selection.ts`: decides which connected tools chat can see and
  which routed mutations are allowed.
- `src/lib/tools.ts`: executes selected Composio tools.

## Confirmations And Safety

Read-only tools can run immediately.

Actions that send, create, update, delete, append, or otherwise mutate external
state are not executed right away. The server turns them into pending actions and
the UI shows a confirmation card.

Only after the user clicks confirm does the backend call the real Composio tool.

This protects actions such as:

- sending email
- creating calendar events
- writing to Google Sheets
- bulk updates or deletes

The relevant code is in `src/server.ts` and `src/lib/tool-recovery.ts`.

## Large Workflows

Some tasks are too large to leave entirely to a chat loop. Mini Rube has
deterministic workflow code for those.

Supported workflows:

- GitHub issues to Google Sheets
- Drive resumes to Google Sheets

These workflows:

- paginate through all source items
- keep one row per source item
- write errors as rows instead of silently dropping failed items
- ask for one workflow-level confirmation before writing to Sheets
- store workflow job metadata in local SQLite

The main files are:

- `src/lib/workflows/index.ts`
- `src/lib/job-store.ts`

## Files And Attachments

PDF uploads are validated locally, uploaded through Composio's file upload flow,
and stored as short-lived local references. Those references can then be attached
to email-send actions after the user confirms.

The main file is:

- `src/lib/files.ts`

## Local State

This app is intentionally simple for local use.

Stored in the browser:

- the local Mini Rube user id

Stored in the Bun process:

- active chat runs
- pending single-action confirmations
- uploaded file references
- pending OAuth handshakes

Stored in SQLite:

- large workflow job metadata

Because much of the state is process-local, restarting the server can clear
active chat runs, pending confirmations, and uploaded file references. Connected
Google/GitHub accounts live in Composio and survive server restarts.

If an account is disconnected mid-chat, the next chat turn checks connection
state again. Tools for that disconnected account are not exposed, and a request
that needs the account asks the user to reconnect before running anything.

## Deployment

The repo includes a Dockerfile that builds the Vite frontend and runs the Bun
server in production mode. A deployed service needs the same required environment
variables as local development:

```sh
COMPOSIO_API_KEY=...
OPENROUTER_API_KEY=...
GOOGLESUPER_AUTH_CONFIG_ID=...
GITHUB_AUTH_CONFIG_ID=...
```

On Render, this app is deployed as a web service from this repository. Useful
commands:

```sh
render deploys create <service-id> --commit <commit-sha> --wait
render logs --resources <service-id> --tail
```

The app exposes a lightweight health check:

```txt
/healthz
```

Free hosting plans can sleep when idle. A cron ping can hit `/healthz`, but this
does not replace proper error handling for long-running workflows.

## Troubleshooting

### The app says a Google or GitHub connection is missing

Click the relevant connect button again. The connection is tied to the local user
id in your browser.

### OAuth succeeds but tools still fail with insufficient scope

Recreate the auth configs:

```sh
COMPOSIO_API_KEY=your_composio_key sh scaffold.sh
```

Restart the app and reconnect Google/GitHub.

### The model response is too short

Set this in `.env`:

```sh
AGENT_MAX_TOKENS=4096
```

### JSON helper or extraction output is truncated

Set this in `.env`:

```sh
JSON_MAX_TOKENS=2048
```

Most local runs should not need this.

### The agent picks stale tools from the previous task

The current default exposes all supported tools for connected accounts while the
latest prompt controls task context and mutation authorization. If you need to
debug or roll back to the older narrower behavior, set:

```sh
CHAT_TOOL_SELECTION_MODE=routed
```

### The frontend opens but API calls fail

Make sure `bun run dev` is still running. In development, the frontend depends on
the Bun API server on `localhost:3001`.

## Tests

The tests avoid live Composio/OpenRouter calls. They focus on routing, tool
argument normalization, result compaction, workflow guarantees, and validation.

```sh
bun test
```
