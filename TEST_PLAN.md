# Mini Rube — End-to-End Test Plan

Goal: validate the app against the five judging criteria in `criteria.md`, using
the real prompts **and variations** of them, exercised through the live web app
(Playwright) and the routing layer (programmatic).

## Environment under test

- App: `bun run dev` → API on `:3001`, Vite client on `:5173`.
- Connected account: a real Google + GitHub account is bound to user id
  `user_0c33aae0-...` (seeded into `localStorage.mini_rube_user_id` so the
  browser session is authenticated). Both toolkits report `connected: true`.
- Read-only tools execute immediately; mutating tools (send/create/update) are
  gated behind a confirmation card and only run on explicit approval.

## Safety rules during testing

- READ prompts: run fully live.
- MUTATION prompts (send email, create event): drive to the confirmation card
  and verify its contents, but only execute outward-facing actions (real email
  to a person) with explicit user sign-off.
- WORKFLOWS (issues→sheet, resumes→sheet): the output is a new Google Sheet in
  the user's Drive (benign + easily deleted), so run end-to-end where practical.

---

## Criteria → test mapping

| # | Criterion | How it's tested |
|---|-----------|-----------------|
| 1 | The prompts work (+ similar phrasings) | Run the 5 canonical prompts + 3-4 variations each, live |
| 2 | Generalization / tool discovery | Routing matrix incl. unknown toolkits (Slack/Linear); inspect selected tools per run |
| 3 | Product design (UX) | Playwright: onboarding, markdown/links, confirmation cards, connection flow, errors |
| 4 | Code quality / abstractions | Reviewed separately; here we check behavior of the router/workflow/recovery layers |
| 5 | Visual design | Light pass — screenshots, layout sanity |

---

## A. Routing & generalization matrix (programmatic)

For each prompt, capture: selected intent(s), selected tool slugs, routing mode,
whether a heavy workflow was triggered. Expectation = the toolset a human would
pick.

| Prompt | Expected | Result |
|--------|----------|--------|
| read my last 100 emails and show me the important ones | email read tools | |
| summarize my inbox from this week | email read tools | |
| any urgent emails I should look at? | email read tools | |
| what did I order from Amazon last month | email purchase/read tools | |
| schedule a calendar event tomorrow with karan | calendar + contacts + date | |
| set up a 30-min sync with priya next tuesday | calendar + contacts + date | |
| am I free thursday afternoon? | calendar read / free slots | |
| read all issues open and closed on composiohq/composio and make a google sheet | issues→sheet workflow | |
| export bugs from facebook/react into a spreadsheet | issues→sheet workflow | |
| take all the resumes in this drive folder <url> and make a sheet with name, uni, last job | resumes→sheet workflow | |
| send an email with the attached pdf | send email + contacts | |
| email this PDF to my manager | send email + contacts | |
| make a google sheet from this data | sheet create | |
| post a message to the #general slack channel | discovery (unknown toolkit) | |
| create a linear issue for this bug | discovery (unknown toolkit) | |
| what's the weather tomorrow | no tool / none | |

## B. Live read prompts (Playwright + real account)

| Prompt | Pass criteria | Result |
|--------|---------------|--------|
| read my last 100 emails, show important ones | returns a readable, markdown summary; no context overflow | |
| what's on my calendar this week | lists real events | |
| find the folder "…" in my drive / list a drive folder | lists files | |
| look up <name> in my contacts | resolves contact, redacts full email | |

## C. Live mutation prompts (to confirmation gate)

| Prompt | Pass criteria | Result |
|--------|---------------|--------|
| schedule a calendar event tomorrow 3pm with karan | confirmation card shows title/time/attendee, email redacted; not executed until confirmed | |
| send an email to <addr> saying hi | confirmation card shows To/Subject/Body; not auto-sent | |
| send an email with the attached pdf (after PDF upload) | attachment wired into send args | |

## D. Heavy workflows

| Prompt | Pass criteria | Result |
|--------|---------------|--------|
| issues (open+closed) on composiohq/composio → sheet | all issues fetched (paginated), one row each, one approval, sheet link returned | |
| resumes in drive folder → sheet (name, uni, last job) | all files become rows incl. parse failures, extracted fields populated | |

## E. UX checks (Playwright)

- [ ] Empty state shows example prompts + connect hint
- [ ] Clicking an example sends it
- [ ] Assistant output renders as markdown (lists/bold) with clickable links
- [ ] Connection buttons reflect connected state
- [ ] Confirmation card shows human-readable action (not a raw id)
- [ ] No editable run-id/job-id debug inputs in the product UI
- [ ] Run trace panel updates as tools execute
- [ ] Errors surface clearly (e.g., missing connection, tool failure)

---

## Findings log (2026-06-29)

### Environment note — OpenRouter credits
The bundled key's OpenRouter account is **free-tier with `total_credits: 0`** (`GET /api/v1/key` → `is_free_tier: true`; `/credits` → `total_credits: 0`, lifetime usage $0.19). On the free tier, paid models like `moonshotai/kimi-k2` are rejected when a request's token size exceeds the (near-zero) affordable amount ("can only afford 439 tokens", "prompt tokens limit exceeded 2721 > 1762"). This is **not** an exhausted balance from testing.
- For testing we switched the agent to a free model via env (`AGENT_MODEL/PLANNER_MODEL/EXTRACTOR_MODEL=openai/gpt-oss-120b:free`); revert by unsetting those once paid credits reflect.
- Free models are heavily **rate-limited upstream** (429s) and `gpt-oss` often returns empty final text after tool calls — so conversational *summarization* quality is not reliably testable on free tier. Tool **execution** works.

### A. Routing matrix — PASS
All 5 canonical prompts route deterministically with high confidence (email read 0.96, schedule 0.91, issues→sheet 0.86, resumes→sheet 0.86, send-with-pdf 0.92). Variations work: "what did I order from Amazon" → purchase history; "export bugs from facebook/react" → issues→sheet; "any urgent emails", "am I free thursday", "set up a sync with priya" → LLM discovery picks the right tool. Out-of-catalog ("post to slack", "create a linear issue") correctly return **none** (toolkit not loaded) rather than misfiring.

Fixes made from matrix findings:
- `FAST_PATH_CONFIDENCE` 0.3 → 0.4 so borderline keyword matches ("weather", "linear issue") go to discovery instead of misfiring.
- Discovery now **seeds candidates from the registry's curated tool bundles** of top-scoring intents, so supporting tools (contacts, date) are offered even when they don't match the prompt wording.
- Discovery that finds nothing returns **none** (not a weak keyword guess); model-unavailable degrades to lexical.
- Discovery prompt asks the model to include resolution/helper tools (contact lookup, current date).

### D. Heavy workflow: GitHub issues→sheet — PASS (live, end-to-end)
`composiohq/composio` (open+closed): paginated fetch climbed 97→274→…→**641 issues**, one workflow approval, batched writes (200/400/500/641), produced a real Google Sheet artifact (clickable link), 0 failures. Also ran `octocat/Hello-World` which paginated past **4,600 issues** before we cancelled it — `Cancel job` works and pagination scales to thousands. Uses **zero** OpenRouter credits (deterministic).

### B/C. Conversational read & mutation — PARTIAL (blocked by free-tier model)
- Email read: routed correctly and **executed `GOOGLESUPER_FETCH_EMAILS` live**, but the free model returned empty final text (no summary). Pending kimi-k2.
- Calendar read: the agent responded with a sensible clarifying question (timezone) and **markdown rendered live** (bold). Follow-up hit a free-tier 429.
- Calendar/email mutation confirmation card: not captured live (free-tier 429s), but the **workflow approval card** (same side-panel pattern) was validated, and the single-action card code was improved (title + redacted details).

### E. UX checks — PASS
- [x] Empty state: example prompts + connect hint
- [x] Clicking an example sends it
- [x] Assistant output renders as Markdown with clickable links (verified: bold inline + Sheet artifact link)
- [x] Connection buttons reflect connected state
- [x] Confirmation/approval card shows human text (workflow card now shows the summary, not a raw id)
- [x] No editable run-id/job-id debug inputs
- [x] Run trace panel updates as tools execute
- [x] Errors surface clearly — improved: rate-limit/credit failures now show a friendly, actionable message

### Additional fixes made during testing
- Empty assistant content now renders a neutral "…" instead of the misleading "Pending action requested.".
- Workflow approval card shows `approvalSummary` ("Create a Google Sheet with N … rows for …") instead of the raw job id.
- `getErrorMessage` maps provider rate-limit (429) and credit-rejection errors (walking RetryError `.errors[]`/`.lastError`) to clear guidance.

### Round 3 fixes (from live re-testing)
- **Attachment never delivered (blank email) — fixed.** `SEND_EMAIL.attachment` needs `{name, mimetype, s3key}` where `s3key` is the upload's S3 key. The agent was guessing `s3key = filename`, and the server *respected* the agent's value. Now the server ALWAYS overrides `attachment` with the real upload ref (name + `application/pdf` + the upload `key`). Verified: sent to self, fetched the message back, attachment `mini-rube-test.pdf` present.
- **No feedback after confirming — fixed.** After Confirm, the UI appends a chat note ("✅ Send email completed." / "❌ … failed: …"). This doubles as conversation history so the agent is aware of the result on the next turn.
- **No UI while the agent works — fixed.** Added an animated "Assistant is working" typing indicator shown before the first token and between tool calls.
- **Resume extraction quality — fixed.** Added `unpdf` to extract real PDF text (PARSE_FILE only downloads), so name/university/last-job now populate (verified: Charles Chen/Cornell/KPMG, Steven Moore/Northwestern/Morgan Stanley, John Harris/Purdue/Deloitte). Also fixed the sheet column-misalignment (read back the created header order before appending) and made the Drive lister FIND_FILE-primary.

### Known issues still open (not yet fixed)
- Run status can remain "running" if a model stream ends without a finish event (observed with gpt-oss free); cosmetic but the trace panel keeps polling.
- Workflow "Phase" shows "writing" after completion (should be a terminal phase); cosmetic.
- Connection button reads "Reconnect Google" when connected — label looks like an action rather than a status.
- Trace `detail` entries still contain raw `job_id:`/`pending_action:` tokens (internal diagnostics only; not shown in chat).

### To finish once paid credits reflect
Unset the free-model env vars (revert to `kimi-k2`) and re-run section B/C: email summarization, calendar read with results, send-email + calendar-event confirmation cards (verify redaction), and resumes→sheet on the assignment Drive folder (with `WORKFLOW_USE_LLM_EXTRACTION` on).

---

## Findings log — live conversational run with kimi-k2 (credits added)

### Email summary — PASS
"read my last 100 emails and show me the important ones" → fetched emails (paginated FETCH_EMAILS) and returned a real, categorized Markdown summary (Financial / Security / Work / Personal / Subscriptions + a summary list) from the live inbox. Markdown headings/bold/lists render. Two notes:
- The agent emits **Markdown tables** for tabular data; the renderer originally showed raw `| … |`. **Fixed**: added GFM table parsing/rendering to `src/app/markdown.tsx` (+ table CSS).
- Compaction caps how many emails fit context (~20/call), so the agent paginates and summarizes a representative set rather than literally all 100 in one pass — it surfaces the important ones as asked. (Heavy "all-N" coverage is handled by the deterministic workflows.)
- Multi-step narration concatenates without paragraph breaks ("…retrieve them now.I retrieved the first 23…") — minor.

### Calendar — PASS
- "schedule a calendar event tomorrow at 3pm titled Sync with karan" → GET_CURRENT_DATE_TIME → CREATE_EVENT pending action → **confirmation card shows "Create event" + Subject + Start** (not a raw id) → Confirm → "Confirmed action executed" (event created live).
- "set up a 30 minute meeting tomorrow at 4pm with karan" → SEARCH_PEOPLE resolved 3 "Karan" contacts, noted they only have phone numbers (no email to leak), and asked which one + for an email. Contact resolution + disambiguation + email-redaction-respect all correct.

### Email attachment flow — PASS (after a fix)
- Upload PDF → file chip appears (upload + Composio presigned PUT works).
- **Bug found + fixed:** the server auto-attaches the uploaded file to SEND_EMAIL args, but the agent wasn't told a file was attached, so it refused ("please upload the PDF first"). A first fix (system-prompt note) worked for single-turn but NOT multi-turn — when the file is uploaded mid-conversation, the model trusts its earlier "upload first" turns over the system note and asks to "re-upload so I can capture the file reference." **Final fix:** append the attachment fact to the latest user message (in-conversation, unmissable) + a stronger, imperative system note. Verified: multi-turn now reaches a SEND_EMAIL pending action with `attachment` wired and a card showing To/Subject/Body/Attachment. Single-turn send to self executed successfully end-to-end.
- Confirmation card improvements: added `recipient_email` to the "To" field and an "Attachment: N file(s)" line (the card previously omitted the recipient and would have dumped the raw ref).

### Resumes → sheet — PASS (mechanism), with notes
- Assignment Drive folder: listed **1,000 files**, parsed + LLM-extracted **all 1,000 with 0 failures**, reached the approval gate with the correct summary ("Create a Google Sheet with 1000 resume candidate rows…"). The approval-summary fix renders here too.
- **Listing inefficiency found + fixed:** `LIST_CHILDREN_V2` (then primary) returned files the resume filter rejected, causing a wasteful fallback re-listing via `FIND_FILE`. `FIND_FILE(folder_id)` reliably paginates the whole folder, so it's now the primary; success is judged on raw file count and the resume filter (now folder-exclusion only, to honor "all the resumes") is applied once at the end.
- Operational note: editing `src/**` during a live workflow triggers `bun --hot` to reload and orphans in-memory workflow state (the job then re-parses on resume — a documented limitation). Don't edit server source mid-run.
