# Mini Rube

Mini Rube is a local web app for chatting with a Composio-backed agent that can work across Google apps and GitHub. It uses Bun for the API server, Vite/React for the client, Composio direct tools for external actions, and the Vercel AI SDK with OpenRouter-hosted models for planning and chat.

## Run

1. Install dependencies:

   ```sh
   bun install
   ```

2. Create the Composio auth configs and `.env` file:

   ```sh
   COMPOSIO_API_KEY=your_composio_key sh scaffold.sh
   ```

   If you already exported the key in your shell, `sh scaffold.sh` is fine. The script does not fetch an OpenRouter key; add it to `.env` manually after the script runs:

   ```sh
   OPENROUTER_API_KEY=your_openrouter_key
   ```

3. Start the API server and Vite app:

   ```sh
   bun run dev
   ```

4. Open `http://localhost:5173`, connect Google and GitHub, then chat with the agent.

If Calendar or Sheets calls return an insufficient-scope error, recreate the auth configs by rerunning
`COMPOSIO_API_KEY=your_composio_key sh scaffold.sh`, restart the app, and reconnect Google. Older scaffolded
configs may only have requested Gmail/Drive scopes.

Useful scripts:

- `bun run server` starts only the Bun API server on `http://localhost:3001`.
- `bun test` runs the focused Bun tests.
- `bun run check` runs the TypeScript compiler without emitting files.

## Environment

`scaffold.sh` writes the required `.env` values:

- `COMPOSIO_API_KEY`: used by the Composio SDK and PDF upload flow.
- `GOOGLESUPER_AUTH_CONFIG_ID`: OAuth config for Gmail, Calendar, Drive, Sheets, and Contacts.
- `GITHUB_AUTH_CONFIG_ID`: OAuth config for GitHub tools.
- `OPENROUTER_API_KEY`: OpenRouter key used through the Vercel AI SDK OpenAI-compatible provider.

Optional model controls:

- `AGENT_MODEL`: chat agent model. Defaults to `anthropic/claude-haiku-4.5`.
- `PLANNER_MODEL`: router/discovery model. Defaults to `deepseek/deepseek-v4-flash`.
- `EXTRACTOR_MODEL`: structured extraction model used by JSON helpers. Defaults to `deepseek/deepseek-v4-flash`.
- `AGENT_MAX_TOKENS`: max output tokens per chat turn. Defaults to `2048`.
- `JSON_MAX_TOKENS`: max output tokens for JSON/planning helper calls. Defaults to `1024`.
- `BUN_IDLE_TIMEOUT`: Bun request idle timeout in seconds. Defaults to `120`.
- `TOOL_ROUTER_DISCOVERY`: set to `0` to disable LLM/lexical discovery over the full catalog (deterministic registry only). Enabled by default; it only fires when the registry match is low-confidence, so confident routes stay model-free.
- `TOOL_ROUTER_USE_LLM=1`: additionally lets an LLM refine among the deterministic candidate intents on confident routes.

## Architecture

- `src/server.ts` exposes the Bun API routes: session creation, connection status, OAuth connect/wait, PDF upload, chat, run trace lookup, and pending-action confirmation.
- `src/lib/intent-registry.ts` defines the supported user intents, examples, safety metadata, and tool bundles for email, calendar, Drive/resume, GitHub issue, and spreadsheet workflows.
- `src/lib/router.ts` is a hybrid tool router. It first scores the prompt against the intent registry (fast, deterministic, no model call). When that match is confident — and always for the heavy workflows — it uses it directly. Otherwise it falls back to LLM-driven discovery over the **entire live tool catalog** (candidates pre-ranked by description relevance), then to a pure lexical match if the model is unavailable. Because the discovery candidate pool is the live catalog rather than a hardcoded list, a newly enabled toolkit's tools become selectable without writing any new intents. `rankCatalogByPrompt` is the toolkit-agnostic relevance pass shared by both fallbacks.
- `src/lib/tool-catalog.ts` loads and filters Composio tools to the supported `googlesuper` and `github` toolkits, rejects `COMPOSIO_*` meta tools, caches schemas, and normalizes input schemas for the AI SDK.
- `src/lib/tool-errors.ts` and `src/lib/tool-recovery.ts` normalize Composio/API failures and apply broad retry policy by tool class, such as reducing page sizes and disabling verbose/full payload flags after payload-too-large errors.
- `src/lib/tool-results.ts` compacts large tool responses structurally by detecting collection-shaped payloads, projecting useful scalar and `name/value` fields, and truncating between whole items instead of slicing raw JSON mid-string.
- `src/lib/files.ts` validates PDF uploads, requests a Composio file upload URL, uploads bytes to the returned presigned URL, and stores a local file reference for later email attachment use.
- `src/lib/llm.ts` centralizes OpenRouter model creation and JSON parsing helpers.
- `src/lib/job-store.ts` provides local workflow persistence using Bun SQLite, with an in-memory implementation used by tests.
- `src/lib/workflows/` contains deterministic large-workflow executors for GitHub issues-to-Sheets and Drive resumes-to-Sheets.
- `src/app/` is the Vite/React client using `useChat` from `@ai-sdk/react`. It renders assistant replies as Markdown with clickable Sheet/Drive/GitHub links, offers example-prompt starters and a connect-first hint on the empty state, and shows confirmation cards with the human-readable action details. `src/app/markdown.tsx` is a small dependency-free Markdown renderer.

## LLM Choice

The app uses OpenRouter via `createOpenAI` from `@ai-sdk/openai`, so the rest of the server can use the Vercel AI SDK (`streamText`, `generateText`, `tool`, and `jsonSchema`) without provider-specific code. Models are picked **per role** from a head-to-head eval, and all stay under the brief's 500k-context ceiling:

- **AGENT** (chat + tool calling) → `anthropic/claude-haiku-4.5` (~200k ctx). Won the eval on quality and was the only candidate that safely refused a "delete all my emails" prompt; accepts Composio's tool schemas as-is.
- **PLANNER** (routing/discovery) and **EXTRACTOR** (bulk resume fields) → `deepseek/deepseek-v4-flash`. Extremely cheap and returns clean JSON for these narrow tasks (matched the agent model's routing/extraction quality in the eval), which matters because the extractor runs once per resume (≈1000×).

A note on the brief's "avoid models with >500k context" guideline: the AGENT model (Haiku, ~200k) is under it. `deepseek-v4-flash` has a ~1M window, which is *above* the guideline — but we use it only for **bounded** inputs (short routing prompts; per-resume `text.slice(0, 8000)`; capped page reads), so it never ingests a corpus and the underlying intent ("don't run out of context") is honored. This is a deliberate cost trade-off for the two narrow, high-volume roles; swap them to a sub-500k model (e.g. `deepseek/deepseek-chat` at ~128k, equal quality) via `PLANNER_MODEL` / `EXTRACTOR_MODEL` if strict adherence is preferred.

We deliberately avoid OpenAI `gpt-*` models here: their strict function-schema mode rejects Composio's tool schemas (a property must be listed in every `required` array), so they fail on every tool call without a schema sanitizer. Each role is overridable via `AGENT_MODEL` / `PLANNER_MODEL` / `EXTRACTOR_MODEL`.

## Auth And Sessions

The browser keeps a `mini_rube_user_id` in `localStorage`. On first load it asks `POST /api/session` for a user id; if that route is unavailable, the client falls back to a browser-local id so the UI still opens.

Connections are per user id. The client calls `POST /api/connect/:toolkit` with the current user id, opens the returned OAuth URL, then calls `POST /api/connect/:toolkit/wait`. The server tracks pending OAuth links in memory with a `userId:toolkit` key and reports connection status from Composio at `GET /api/connections?userId=...`.

## Confirmation Behavior

Read-only tools execute immediately. Mutating tools (email sending, calendar creation, sheet writes, and other create/update/delete-style actions) are intercepted by the server and converted into pending actions. Mutation is detected by scanning the slug for write-verb tokens **anywhere** in the name (so `GOOGLESUPER_SPREADSHEETS_VALUES_APPEND` and `..._SHEET_FROM_JSON` are correctly gated, not just prefix verbs), and any tool with no recognized read verb defaults to "needs confirmation" rather than executing silently. The assistant describes what it is about to do in natural language, and the server records the pending action on the run; the UI surfaces it as a confirmation card showing the action title and key fields (recipient, subject, time, …). The user confirms from that card, which calls `POST /api/actions/:id/confirm`; only then does the server execute the Composio tool.

For the "schedule with karan — don't give his full email" caveat, the calendar confirmation card mechanically redacts resolved email addresses (`***@domain`) before display, and the system prompt instructs the agent not to write a resolved address in its chat reply (refer to the person by name or mask it). Addresses the user typed themselves are shown as-is.

## Run Tracing

Each chat request creates an in-memory run and returns its id in the `x-run-id` response header (run/job ids are no longer embedded in the assistant text). `GET /api/runs/:id` returns selected tools, trace entries, pending actions, status, and discovered artifact URLs. The client reads the header, then polls the run and shows recent trace entries plus confirmation cards.

## Large Workflow Jobs

The two high-volume assignment workflows no longer depend on a single LLM tool-call loop:

- GitHub issues-to-Sheets uses deterministic owner/repo parsing, paginated `GITHUB_LIST_REPOSITORY_ISSUES` calls, one row per issue, workflow-level approval, and batched Google Sheets writes.
- Drive resumes-to-Sheets uses deterministic Drive folder-id parsing, paginated folder listing, one output row per discovered resume file, parse-failure rows instead of dropped files, workflow-level approval, and batched Google Sheets writes.

These workflows create local jobs and return the job id in an `x-job-id` response header (not embedded in the chat text). The UI polls `GET /api/jobs/:id`, shows progress counts, asks for one workflow confirmation through `POST /api/jobs/:id/confirm`, and renders generated Sheet artifacts.

Local workflow job metadata is stored in `.mini-rube/workflows.sqlite` by default. Override this with `WORKFLOW_DB_PATH`. Optional controls:

- `WORKFLOW_PAGE_SIZE`: page size for collection tools. Defaults to `100`.
- `WORKFLOW_SHEET_BATCH_SIZE`: rows per Sheets write batch. Defaults to `100`.
- `WORKFLOW_CONCURRENCY`: concurrent independent item reads/parses for large workflows. Defaults to `8`.
- `WORKFLOW_USE_LLM_EXTRACTION`: LLM-assisted resume field extraction (name/university/last job). Enabled by default since the resume prompt asks for these fields; set to `0` to use deterministic parsing only.

## Correctness Guarantees (the hard prompts)

The two high-volume prompts have explicit "all rows must land" caveats, so they are handled by deterministic executors rather than a model loop, with these guarantees:

- **One row per source item, nothing dropped.** Issues are de-duplicated by number; resumes are keyed by file id. A parse/extraction failure becomes a row with `status=parse_failed` and an error column instead of being silently dropped, so the row count always equals the source count.
- **Complete pagination.** GitHub issues page until `hasNextPage` is false (state `all`, PRs excluded); Drive files page by `pageToken` until exhausted.
- **Bounded context.** No model call ever ingests the corpus — pagination + bounded concurrency + batched Sheets writes + per-resume `text.slice(0, 8000)` keep every call small, and all default models are <500k context.
- **Verified by tests.** `tests/workflows.test.ts` asserts 550 unique issue rows and 1000 unique resume rows reach the sheet (including failed-parse rows). See `TEST_PLAN.md` for the full prompt/variation matrix exercised end-to-end.

## Product Thinking & Future Work

The design bet is **discovery over hardcoding**: a deterministic intent registry makes the known prompts fast and reliable, while a live-catalog discovery fallback (ranked by description relevance, then handed to the model) means new phrasings — and tools from newly enabled toolkits — work without per-prompt code. Mutations are gated behind explicit confirmation; long jobs run as tracked, cancellable background workflows with progress. Where a model could leak a resolved email, the server enforces redaction structurally rather than trusting the prompt.

Natural next steps:

- **Expand search / load more.** Read results already carry `itemCount`/`returnedCount`/`truncated`; surface them as quick-action chips ("show 100 more", "only unread", "broaden to all folders") so users can widen a search without retyping.
- **Account management.** Add disconnect / switch-account / new-session controls (the server already has `deleteConnectedAccount`).
- **Generalize the bulk engine.** Turn the two `collect → map → approve → write` workflows into one parameterized template (source tool + row mapper + headers from the route) so any "bulk read → sheet" task — for any connected toolkit — uses the deterministic path instead of the generic agent loop.
- **Durable sessions.** Persist runs/sessions/pending actions (today only workflow-job metadata survives a restart).

## Known Limitations

- Sessions, uploaded file references, runs, and single-tool pending actions are still process-local. Large workflow job metadata is persisted locally, but in-flight row data is regenerated if a waiting job is resumed after restart.
- The app ships `googlesuper` and `github` today. Adding a toolkit means registering it in `src/lib/tool-catalog.ts` (the catalog the router discovers over) plus an auth config in `scaffold.sh`/`composio.ts` — not writing per-prompt routing code.
- The router prefers the deterministic registry for the known intents and falls back to LLM/lexical discovery over the live catalog for everything else, so it generalizes to new toolkits and prompt phrasings rather than being limited to the registered intents.
- PDF upload supports files up to 25MB and is currently wired for email attachment workflows.
- Large GitHub/Drive jobs use deterministic pagination, bounded concurrent parsing, cancellation checks, and batched writes, but run in the local server process rather than an external worker queue.
- The test suite avoids live Composio/OpenRouter calls and focuses on pure helper behavior and pre-network validation.

## Submit

After testing locally, upload with:

```sh
sh upload.sh your_email@example.com
```

Use `--skip-session` only if you intentionally want to upload without local agent session traces.
