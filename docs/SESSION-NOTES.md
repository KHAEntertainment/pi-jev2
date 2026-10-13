# Session notes and handoff

Running log for the pi-jev2 fork. Newest session first. Each entry records what
was asked, what was decided and why, what is verified, what is not, and exactly
where to pick up. Append a new entry when you stop.

---

## 2026-10-13: cloud session 1, review round on KHAEntertainment/pi-jev2#1

CodeRabbit raised six findings. All were verified against the code, and all six are fixed:

1. **A2A `COMPLETED` without a decision** now throws, so the local rule decides (`decisionFromTask`). Before, it approved.
2. **The `CONFIG_DIR_NAME` import is guarded.** It is now read off a namespace view with a `.pi` fallback, so a pre-0.79.7 host reaches the "needs pi 0.99" notice instead of crashing at load. This is the same bug as upstream issue #1.
3. **A project `.pi/pi-jev.json` can no longer set `escalation.a2a` or `escalation.traycer.command`.** Both are global-only, with a warning. Before, a cloned repo could send a token from `tokenEnv`/`tokenFile` to its own A2A server, have that server approve flagged calls, or pick the command `pi.exec` runs.
4. **The prose decision parser is strict.**
   - A one-word reply may be `yes`/`ok`/`no`/`n`, etc.
   - A leading word in longer prose must be an unambiguous word (approve, deny, block, escalate, ...) followed by punctuation.
   - "Run this past the user first", "OK, but deny" and "Allow me to check" are now no answer.
5. **The A2A per-request signal** uses `AbortSignal.any`. The manual listener on the session signal leaked one closure per poll.
6. **`PUBLISHING.md` and `AGENTS.md`** now describe the first authenticated publish that npm needs before a trusted publisher can be configured.

Tests: 97 pass (12 added). Typecheck and lint are clean.

---

## 2026-10-13: cloud session 1. Multi-provider classifiers and orchestrator escalation (0.4.0)

Branch: `claude/amazing-goodall-igyjjg`. Base: upstream 0.3.0 (`cbbc35d`).

### The ask

1. **Providers.** Go beyond TypeSafe: OpenRouter, Cloudflare, and "pretty much
   any System 1 model that can be put in the seat". Use OAuth where possible
   (certainly OpenRouter). Research Cloudflare OAuth and drop it if it needs a
   dashboard-registered application. API keys are the fallback.
2. **Orchestrator escalation.** When the Jev gate triggers, send the result
   upstream to a managing agent: a native Pi parent, or a multi-agent harness
   such as Traycer through its native agent-to-agent channel, exposed to Pi as
   a tool. The Pi agent must not resume until the orchestrator approves or
   escalates further, towards a human.
3. Take it as far as possible in the cloud, then hand off to a local session
   with detailed notes. This file is those notes.

### What shipped (summary)

- **`src/client.ts` is deleted.** Classification goes through pi's own
  classifier runtime (`ctx.modelRegistry.classify`, pi >= 0.99) via the new
  `src/classifier.ts`. `model` is `provider/id`, any classifier in pi's catalog.
  A bare id still means TypeSafe.
- **New gate mode `escalate`** (`src/escalation.ts`) with three transports:
  - `src/escalators/pi-rpc.ts`: a Pi parent over RPC.
  - `src/escalators/traycer.ts`: the Traycer CLI.
  - `src/escalators/a2a.ts`: an A2A v1.0 JSON-RPC client.
- **New tool `jev_escalate`**, so the model can ask the orchestrator itself.
- **Journal** records escalation outcomes.
- **Package renamed** to `@khaentertainment/pi-jev2` at 0.4.0. Repo URLs point at `KHAEntertainment/pi-jev2`.
- **Tooling:** `tsconfig.json`, bun tests (85 tests, including the real `pi` binary in RPC mode), `scripts/calibrate.ts`, `scripts/a2a-orchestrator.ts`.

### Decisions, with rationale

| # | Decision | Why |
|---|---|---|
| D1 | **Runtime only, pi >= 0.99** (user's choice). The fetch client is gone. | pi 0.99 already routes Jev and ~30 other System One classifiers to TypeSafe, OpenRouter, Cloudflare Workers AI, Vercel AI Gateway and OpenCode, with credentials pi holds. Re-implementing that would duplicate pi. Older hosts get a one-time "needs pi 0.99" notice and the extension stays inactive (fail open). |
| D2 | **OpenRouter OAuth = pi's built-in `/login openrouter`.** Nothing reimplemented. | pi ships OpenRouter PKCE (loopback callback on 127.0.0.1, key exchange at `POST https://openrouter.ai/api/v1/auth/keys`). It needs no app registration and stores a normal user key in `~/.pi/agent/auth.json`, which `classify()` picks up. |
| D3 | **Cloudflare: API key only. OAuth dropped** (the user's rule). | Cloudflare self-managed OAuth clients (launched 2026-06-03) must be registered (dashboard or `POST /accounts/{id}/oauth_clients`). They start private to the creating account; going public needs domain verification. Reusing Wrangler's client id would show "Wrangler" on the consent screen; rejected. See Q4 below for a possible no-registration route via `wrangler auth token`. |
| D4 | **Model spec `provider/id`, split at the first `/`.** | Provider ids have no slash, and model ids often do (`openrouter/typesafe/jev-1.13`, `cloudflare-workers-ai/@cf/cloudflare/clef`). A bare id keeps 0.3 configs working. |
| D5 | **Thresholds unchanged.** Non-Jev models warn once when mode is enforce/escalate. | AGENTS.md requires a measurement for a threshold change. Calibration was on Jev. `isCalibratedModel()` matches Jev ids on any provider. `npm run calibrate` produces rows for other models. No per-model `blockOn` yet (Next). |
| D6 | **`apiKey`/`apiKeyFile` became an explicit override only.** `TYPESAFE_API_KEY` is no longer read by the extension. | pi resolves each provider's own env var. If we read `TYPESAFE_API_KEY` first, it would be wrongly sent to OpenRouter or Cloudflare. pi still reads it for `typesafe/*`. |
| D7 | **`jev_ask` and `/jev check` send `{ "text": … }`** instead of a bare string. | pi's `ClassifierContext.state` is a JSON object. This is a small input-shape change for those two surfaces. They are not calibrated and the gate/output states are unchanged. |
| D8 | **Escalate is its own mode, not a flag on enforce.** On any escalation failure it runs the enforce rule. | It keeps fail-open (AGENTS.md) and keeps shadow the default. With no transport, escalate behaves exactly like enforce (warned once). |
| D9 | **Transport `auto` order:** Traycer env, then `a2a.url`, then RPC mode, then none. | Most specific signal first. Traycer sets `TRAYCER_EPIC_ID`/`TRAYCER_AGENT_ID` on every agent it launches. If Traycer drives Pi in RPC mode, Traycer still wins, which is what we want. |
| D10 | **pi-rpc uses the `input` dialog with the JSON request in `placeholder`.** | Of pi's four RPC dialogs only `input` carries a payload field *and* honours `timeout`/`signal`. `confirm` has no reply text and `editor` has no timeout. Documented in the README and in `src/escalators/pi-rpc.ts`. |
| D11 | **Transports own the "escalated to a human" wait.** | Re-sending would create duplicate Traycer messages or A2A tasks, so the transport calls `wait.onEscalated`, which extends the deadline once to `humanTimeoutSeconds`, and keeps waiting on the same thread. pi-rpc is the exception: it re-asks, because each RPC dialog is a fresh request/response. |
| D12 | **Decisions are not cached.** Identical *concurrent* calls share one escalation. | An approval is for this call, not every later call that looks the same. Parallel siblings from one assistant message must not each ping the orchestrator. |
| D13 | **A2A uses `returnImmediately` and polls `GetTask`.** No streaming, no push. | Zero-dependency and works through proxies. Streaming and push are listed under Next. |
| D14 | **A2A `COMPLETED` with no decision is no answer** (changed in review, see below). | Approving it would let a flagged call run on prose like "I reviewed the request", which is weaker than the local rule. `REJECTED` = deny. `FAILED`/`CANCELED`/`AUTH_REQUIRED` = no answer, so the fallback runs. |
| D15 | **Traycer via the `traycer` CLI** (`agent send --expect-reply`, then poll `agent inbox`), not its Host WebSocket. | The WebSocket RPC (`ws://127.0.0.1:<port>/rpc`, `agent.sendMessage`) is private and versioned. The CLI is the documented surface. Parsers search the CLI's JSON for field names rather than assume paths, because the exact shapes are unverified (see below). |
| D16 | **`jev_escalate` is registered `defaultActive: false`** and activated at `session_start` only when a transport resolves. | Tools are registered at load, before we know the mode, env or config. This keeps the tool out of the model's prompt for ordinary users. |
| D17 | **Package renamed** `@khaentertainment/pi-jev2` (user's choice). Not published. | The npm scope and trusted publisher need the owner (`PUBLISHING.md`). Install from git meanwhile. |
| D18 | **bun for tests**, plus devDependencies pinned to pi 1.2.0, typescript 5.9.3 and biome 2.4.11. | bun runs TS with extensionless imports and `Bun.serve` for the A2A mock. Biome is pinned to match the existing `biome.jsonc` schema. There are still zero runtime dependencies. |

### Research findings (sources)

- **pi 1.2.0 classifier runtime.** These come from reading the npm tarballs:
  - `ctx.modelRegistry.classify(model, {state, questions}, opts)` never rejects; check `stopReason`.
  - `findOfType("classifier", provider, id)` looks a model up.
  - Wire question types are `bool`/`choice`/`score`. `bool` answers are `{probability}`; `score` answers have no `legend`.
  - TypeSafe/OpenRouter/Vercel/OpenCode go to `POST {baseUrl}/systemone` with `{model, state, questions}`. Cloudflare goes to `POST …/accounts/{id}/ai/run` with `{model, input:{state,questions}}`.
  - Built-in classifiers: run the snippet below (34 as of 1.2.0).
  - Docs: `node_modules/@earendil-works/pi-ai/README.md#classification`, `node_modules/@earendil-works/pi-coding-agent/docs/{models,rpc-extension-ui,custom-provider}.md`.
- **Auth.**
  - Credentials live in `~/.pi/agent/auth.json`.
  - `/login` OAuth flows exist for anthropic, openai-codex, github-copilot, **openrouter**, and others.
  - `ctx.modelRegistry.getProviderAuthStatus(provider)` returns `{configured, source, label}`.
  - Extensions can add OAuth logins via `pi.registerProvider(name, {oauth:{login,refreshToken,getApiKey}})`. Not needed here.
- **OpenRouter OAuth PKCE** (https://openrouter.ai/docs/guides/overview/auth/oauth):
  - No client id. Any localhost port is accepted as `callback_url`.
  - Exchange: `POST /api/v1/auth/keys {code, code_verifier, code_challenge_method}` returns `{key}`.
- **Cloudflare OAuth:**
  - https://developers.cloudflare.com/changelog/post/2026-06-03-public-oauth-clients/ and https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/. Registration is required.
  - Workers AI REST: https://developers.cloudflare.com/workers-ai/get-started/rest-api/.
  - Jev on Cloudflare: https://developers.cloudflare.com/ai/models/typesafe/jev/.
  - Clef (Cloudflare's own Jev-compatible decision models, 2026-10-01): https://developers.cloudflare.com/workers-ai/models/clef/.
- **Traycer** (docs read from the source in `traycerai/traycer` `mintlify/`, because docs.traycer.ai was proxy-blocked; plus strings in the `@traycerai/cli@1.5.1` bundle):
  - There is no public Google A2A endpoint. Agent messaging is `traycer agent send --to <id> --message <text> [--expect-reply] [--response-id <id>] --json` and `traycer agent inbox [--after <cursor>] --json`.
  - `--json` prints NDJSON: progress lines, then one `result` line.
  - Messages arrive to chat agents as `[traycer:agent-message]`; they reply with the `traycer_send_message` tool.
  - Pi is a supported Traycer harness (chat interface).
  - Human approval exists only in Traycer's own UI. Issue https://github.com/traycerai/traycer/issues/1322 says the CLI cannot answer pending questions.
- **A2A v1.0.1** (https://github.com/a2aproject/A2A, `docs/specification.md`):
  - JSON-RPC methods are PascalCase: `SendMessage`, `GetTask`, `CancelTask`.
  - Send the header `A2A-Version: 1.0`.
  - The agent card lives at `/.well-known/agent-card.json` with `supportedInterfaces[{url, protocolBinding:"JSONRPC"}]`.
  - Task states are `TASK_STATE_*`. Interrupted states: `INPUT_REQUIRED`, `AUTH_REQUIRED`. Terminal states: `COMPLETED`, `FAILED`, `CANCELED`, `REJECTED`.
  - A Part is exactly one of `text`/`raw`/`url`/`data`.
- **Related Pi packages** (not used, but worth knowing):
  - `pi-subagents` (nicobailon): a `contact_supervisor` tool with `need_decision`. Closest to our parent flow.
  - `@bacnh85/pi-a2a`: an A2A v1.0 client and server for Pi.
  - `@agentapprove/pi`: a blocking HTTP approval gate.

```bash
# list every built-in classifier pi knows
node -e 'const fs=require("fs"),d="node_modules/@earendil-works/pi-ai/dist/providers/data";for(const f of fs.readdirSync(d)){const w=o=>{if(Array.isArray(o))return o.forEach(w);if(o&&typeof o==="object"){if(o.type==="classifier"&&o.id)console.log(f.replace(".json",""),o.id);else Object.values(o).forEach(w)}};w(JSON.parse(fs.readFileSync(d+"/"+f)))}'
```

### Verified in this session

- `npm run typecheck`, `npm run lint` and `npm test` (85 pass) are clean.
- **Unit tests:**
  - model specs and the calibrated-model check
  - classify adapter error mapping
  - config layering, the escalation block, and warnings for the 0.3 `endpoint` key and bad values
  - gate and output verdicts on `bool` answers
  - decision parsing
  - transport choice
  - the deadline extension on human escalation
  - poll timeout and abort
- **Transports:**
  - **A2A** against a local `Bun.serve` server: card discovery, `INPUT_REQUIRED` then `COMPLETED`, `REJECTED`, direct Message replies, JSON-RPC and HTTP errors, timeout plus `CancelTask`, unreachable server, auth header.
  - **Traycer** against a scripted fake CLI: parent lookup, a stale reply ignored, escalate then deny, the configured parent, a non-zero exit, timeout.
  - **pi-rpc** with a fake UI, plus the parent relay.
- **Fake-host integration** (`test/extension.test.ts`):
  - session_start readiness for no runtime, missing credentials, unknown model, and uncalibrated model
  - shadow, enforce, and escalate approve/deny/fallback
  - headless with no transport
  - Traycer through `pi.exec`
  - sibling dedupe
  - the output judge, `jev_ask`, `jev_escalate`
- **The real `pi` 1.2.0 binary in RPC mode** (`test/e2e/`). A scripted chat model (pi-ai `fauxProvider`) issues `rm -rf src && git push --force origin main`. A fake classifier, registered through `pi.registerProvider`, flags it. A parent process answers the child's escalation over pi's real extension-UI subprotocol:
  - **deny** blocks the call with the parent's reason in the tool result;
  - **approve** runs it;
  - **cancel** falls back to the local `confirm`, which the parent declines.
- **The real pi catalog** (smoke run, no fake classifier). The checks fire correctly for:
  - no TypeSafe key: "set TYPESAFE_API_KEY, run /login typesafe…";
  - no OpenRouter key: "run /login openrouter (OAuth)…";
  - `OPENROUTER_API_KEY` set: the extension goes active;
  - Cloudflare Clef: the "not a Jev model" warning;
  - a typo in `model`: "not in the model catalog".
- **`scripts/a2a-orchestrator.ts`** works with `a2aEscalator` end to end: escalated to a human, then denied with a reason.

### Not verified, and why

The egress policy of this cloud environment blocks `openrouter.ai`, `api.typesafe.ai` and `api.cloudflare.com` (CONNECT rejected), and there was no Traycer install. None of these were exercised live:

1. **Live classifier calls** on any provider: OpenRouter with a `/login` OAuth key, Cloudflare `typesafe/jev` and Clef, TypeSafe direct. The code path is pi's own; we only call `classify()`.
2. **Calibration of non-Jev models.** `npm run calibrate` exists but has never run against a live model. Its fixtures are reconstructions of the README rows, not upstream's exact probe states, so Jev numbers may differ slightly from the README table.
3. **Traycer, all of it.** In particular:
   - the exact JSON of `traycer agent send --json` (where `responseId` sits), `agent inbox --json` (message list, text field, cursor field) and `agent list --json` (the parent id field). The parsers search for `responseId|response_id`, `prompt|message|text|content|body`, `nextCursor|cursor`, and `parentAgentId|parentId|parent`;
   - whether `traycer` is on `PATH` for `pi.exec` inside a Traycer-launched Pi;
   - whether the managing agent replies with `responseId` set.
4. **`/login typesafe`.** The research said TypeSafe has an API-key `/login` entry; not tried.
5. **A2A against a third-party orchestrator.** Only our mock and our own manual orchestrator were used.
6. **Several parallel flagged calls with different inputs in RPC mode.** Each opens its own `input` dialog; the parent must handle concurrent dialogs by `id`.

### Local test plan (do these first)

```bash
npm install && npm run typecheck && npm run lint && npm test

# 1. Run pi with the working tree as the extension
pi -e ./src/index.ts            # or: pi install ./   (local path)

# 2. OpenRouter with OAuth
#    in pi:  /login openrouter     (browser opens, approve)
echo '{"model":"openrouter/typesafe/jev-1.13"}' > ~/.pi/agent/pi-jev.json
#    in pi:  /jev                  -> auth should read stored/OAuth, not missing
#            /jev check rm -rf src && git push --force origin main   -> should flag

# 3. Cloudflare (API key)
export CLOUDFLARE_API_KEY=... CLOUDFLARE_ACCOUNT_ID=...
echo '{"model":"cloudflare-workers-ai/typesafe/jev"}' > ~/.pi/agent/pi-jev.json
#    /jev check …  as above; then try cloudflare-workers-ai/@cf/cloudflare/clef

# 4. Calibrate, then paste the rows into README ## Calibration
npm run calibrate -- --model typesafe/jev-latest          # sanity: should match README
npm run calibrate -- --model openrouter/typesafe/jev-1.13
npm run calibrate -- --model cloudflare-workers-ai/typesafe/jev
npm run calibrate -- --model cloudflare-workers-ai/@cf/cloudflare/clef

# 5. A2A by hand
bun scripts/a2a-orchestrator.ts --port 9911
#    pi-jev.json: {"gate":{"mode":"escalate"},"escalation":{"transport":"a2a","a2a":{"url":"http://127.0.0.1:9911"}}}
#    ask pi to do something destructive; answer a / d / h in the orchestrator terminal

# 6. Pi parent over RPC (already automated; re-run against your local pi)
bun test/e2e/rpc-parent.ts deny        # or approve / silent

# 7. Traycer
#    a. Install pi-jev2 in the Pi that Traycer manages; set gate.mode escalate.
#    b. In a Traycer task, create a parent agent and a Pi child agent.
#    c. In the child's terminal env, capture real shapes first:
traycer agent list --json  > /tmp/list.ndjson
traycer agent inbox --json > /tmp/inbox.ndjson
#    d. Make the child run something destructive; watch the parent receive the
#       [pi-jev escalation] message; have it reply {"decision":"deny",...}.
#    e. If the parsers miss a field, fix src/escalators/traycer.ts (findString
#       keys / inboxMessages) and extend the fake CLI in test/escalators.test.ts
#       with the captured real output.
```

### Gotchas met

- **GitHub push protection** rejected the first push because a calibration fixture held a realistic Stripe-shaped key. Fixtures that must look like secrets are now assembled at runtime (`FAKE_STRIPE_KEY` in `scripts/calibrate.ts`). Keep new fixtures that way.
- **The egress proxy** in cloud sessions blocks the classifier providers, `docs.traycer.ai` and `a2a-protocol.org`. Use GitHub sources (raw files) for docs, and run live calls locally.
- **`biome.jsonc` declares schema 2.4.11.** Biome is pinned to that version; `biome migrate` is needed before upgrading it.

### Open questions for the owner

- **Q1.** Should escalate mode also forward **output-judge leak notices** upstream, as fire-and-forget notifications to the orchestrator? Today only gate verdicts and `jev_escalate` go upstream.
- **Q2.** (Resolved in review: `COMPLETED` without a decision is no answer.)
- **Q3.** Do you want per-model thresholds (`gate.blockOn` keyed by model) once Clef or other models are calibrated, or one threshold set per config file?
- **Q4.** Cloudflare OAuth without registration might be possible via pi's `!command` key syntax: run `wrangler login` once, then set the provider key to `!wrangler auth token` in `models.json` or `auth.json`. Wrangler's token scopes include `ai:write`. Untested. Worth checking whether pi re-runs the command when the ~1h token expires.
- **Q5.** Traycer exposes "interview"/question cards only through its private Host protocol. If Traycer publishes an API for that, pi-jev could put a real approval card in front of the human instead of messaging the parent agent.

### Next (queued)

1. Run the local test plan above. Fix the Traycer parsers against the real shapes.
2. Fill the README calibration table for OpenRouter Jev, Cloudflare Jev and Clef. Then decide Q3.
3. A2A streaming (`SendStreamingMessage`) or push notifications, instead of polling.
4. An optional `pi-subagents` transport (`contact_supervisor` with `reason: need_decision`) for parents that use that extension.
5. Publish: create the npm scope and trusted publisher (`PUBLISHING.md`), then cut a `v0.4.0` GitHub release.
6. Upstream's own queue in `NEXT.md` still applies: the taint-gated reply leak check, repeat-failure escalation, and so on.

### Where things are

| Concern | File |
|---|---|
| Classifier adapter, model specs, auth hints, redaction | `src/classifier.ts` |
| Config, including `escalation` | `src/config.ts` |
| Escalation core (request, decision parsing, transport choice, wait) | `src/escalation.ts` |
| Transports | `src/escalators/{pi-rpc,traycer,a2a}.ts` |
| Wiring (handlers, `jev_escalate`, `jev_ask`, `/jev`) | `src/index.ts` |
| Journal records, including `escalation` | `src/journal.ts` |
| Fakes for pi | `test/helpers.ts` |
| Real-binary RPC test, faux host, reference parent | `test/e2e/` |
| Calibration and a manual A2A orchestrator | `scripts/` |
