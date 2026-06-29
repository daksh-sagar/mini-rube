# build a mini version of [rube](https://rube.app)

we want to build a general agent on top of composio that you can chat with and task over gmail, google calendar, etc.

this is not a whiteboard-style leetcode interview. this is a real-world problem that reflects the kind of work you would actually do on the job. you can use any environment, tools, or resources you like — including AI coding tools like Copilot, Cursor, Claude, etc. we care about the end result, not how you get there.

this assignment is intentionally unbounded and usually takes around 4-5 hours.

### prompts that should work (all of these must work)

- read my last 100 emails and show me the important ones
- schedule a calendar event tomorrow with karan (don't give his full email)
- read all the issues (open and closed) on composiohq/composio and make a google sheet with the problems people are reporting
- can you take all the resumes in this drive and make a google sheet with candidates names, uni and last job https://drive.google.com/drive/folders/1bOEE3JXX-iFqbY99VTRq1ak-UOQULc5r?usp=sharing
- send an email with the attached pdf

caveats on the prompts:
- the 1k resumes should all be in the sheet
- all the issues issues (at the time of writing 550) should be in the sheet
- you should not run out of context length on any of the prompts, avoid using models with >500k context windows.

### how this project should be presented
build a web app where we can try this agent. does not have to be deployed.

### other requirements/constraints
- build this on top of composio https://docs.composio.dev, without using `composio.create`, `tool-router`, or `COMPOSIO_` meta tools (ideally you don't even take inspiration from these directly)
- you only need these two toolkits from composio:
  - https://docs.composio.dev/toolkits/googlesuper - combined google apps
  - https://docs.composio.dev/toolkits/github - github
- the system should be generalizable to other toolkits in the future, not limited to these
- you have to manage auth for the users — i should be able to connect my gmail to it and try the product

## how we judge
1. **the prompts work** — similar prompts should also work, not just the exact ones listed. the system should generalize to variations of the prompts, not just handle the exact wording above.
2. **generalization** — is this a general agent system that could work with new toolkits (e.g., Slack, Linear) without code changes, or is it stitched together for 6 specific prompts? how does the agent discover and select the right tools for a given request?
3. **product design (UX)** — is it easy for a user to use, did you think about future features (expanding search, etc.)
4. **code quality** — did you make good abstractions
5. **visual design (UI)** — not super important for this interview

## how to submit
submit a working codebase i can run to test your app, with a readme that shows me how to run it and explains your thinking around abstractions, tech stack, and product thinking.

## getting started

1. get an api key from https://dashboard.composio.dev
2. run `COMPOSIO_API_KEY=PUT_YOUR_KEY_HERE sh scaffold.sh` to scaffold the project
3. run `bun run dev` to start the server + vite dev server
4. open http://localhost:5173, click "Connect Google" to link your account, then try chatting

the scaffold gives you a working chat app that can send emails via chat. it only loads one tool (`GOOGLESUPER_SEND_EMAIL`) — your job is to build the router that picks the right tools for any given prompt.

## composio key concepts

auth configs hold auth state for toolkits that need OAuth. `scaffold.sh` creates auth configs for `googlesuper` and `github`. `composio_search` doesn't need one.

users connect via connected accounts to an auth config. `src/lib/auth.ts` handles this for you — see `src/connect.ts` for how to connect accounts and `src/lib/tools.ts` for discovery and execution.

**what's already scaffolded for you:**
- `src/server.ts` — Bun API server using Vercel AI SDK (`streamText`, `tool`, `jsonSchema`)
- `src/app/` — Vite + React frontend using `useChat` from `@ai-sdk/react`
- `src/lib/composio.ts` — initialized client + auth config IDs
- `src/lib/auth.ts` — connect accounts, check connection status
- `src/lib/tools.ts` — discover tools, execute tools

**what you need to build:**
- a tool router — the scaffold hardcodes one tool (`GOOGLESUPER_SEND_EMAIL`). you need to figure out how to dynamically select the right tools for any given prompt
- make it work for the prompts listed above (and similar ones)
- improve the UI/UX as you see fit

## submit

once you are done use `sh upload.sh <your_email> [--skip-session]`

## agent session tracing (required by default)

- `upload.sh` collects recent local agent sessions into `agent-sessions/` before creating your submission zip.
- It includes recent activity from this task folder for Codex, Claude Code, OpenCode, and Cursor (90-minute window).
- If no recent sessions are found, interactive runs prompt you before continuing.
- Use `--skip-session` only if you explicitly want to upload without session tracing.

examples:

- `sh upload.sh your_email@example.com`
- `sh upload.sh your_email@example.com --skip-session`
