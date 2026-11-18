# Changelog

## 1.3.7

- Restore the `export const inject = ['credentials']` line, lost in the 1.3.2 rewrite: without it the plugin exported no dependency declaration, so on a fresh boot the row mounted with an empty injection set and every service read threw 'cannot get property "credentials" without inject' until the host was patched by hand. The profile-layer override is no longer needed.

## 1.3.6

- Declare `engines.dsh: '>=0.2.1'`: the plugin's activation depends on the postmortem-0001-safe service reads and the config-editor/HMR behavior of recent runtimes; older hosts should stay on ≤1.2.x.

## 1.3.5

- Register the route with capabilities verified against api.qwen.ai: prompt-cache markers (`compat.cacheControlFormat: anthropic` + `cacheRetention: short`) — repeated turns now report ~2k cached prompt tokens; declared `reasoningEfforts` (low/medium/high/xhigh over `reasoning_effort`; off sends nothing).

## 1.3.4

- Declare `input: [text, image]` on the registered route models: without it a hand-declared entry defaults to text-only, so the GUI refused images on Qwen subscription chats even though the gateway serves vision (verified against qwen4-max).

## 1.3.3

- Fix the real activation crash: every `ctx.credentials` property read inside async continuations could resolve from a foreign shadow fiber whose ancestor walk misses the provider ('cannot get property "credentials" without inject' — see DSH postmortem 0001). All service reads now go through the topology-independent `ctx.get()`; child-fiber callbacks read their gated services the same way.

## 1.3.2

- Fix activation for real: Cordis has no `required`/`optional`/`any` inject forms — every declared service gates the row, so 1.3.0/1.3.1 stayed pending (`waiting for services`) on hosts lacking one of them. The row now requires only `credentials`; the slash commands and the system-prompt relay mount as child `ctx.inject` fibers that simply stay inactive when their surface is absent.
- `/qwen-login --force` starts a new sign-in over an existing session; the interactive re-auth question (which could not be answered from plugin context) is gone.

## 1.3.1

- Fix activation: the object-form `inject` added in 1.3.0 made the row stay pending (Cordis reads a bare array as all-required); now only `credentials` is required, with `commands`/`systemPrompt` as an `any` gate and `agents` optional.

## 1.3.0

- The approval link now reaches the user through a system-prompt section instead of an interactive card: `userQuestions.ask()` from a plugin fails with `NO_PROVIDER` in the Web profile (its answerer only accepts tool-scoped requests), so the previous "card" path never rendered for anyone but the answering model. While a sign-in is pending, the plugin contributes a prompt section that names the exact `/authorize` URL and instructs the assistant to relay it verbatim; the section is disposed once the flow completes, expires or unmounts. `/qwen-login` confirms the pending code and points at the relay.
- Activation auto-start keeps logging the link to `$DSH_HOME/qwen-sub-oauth.log`.

## 1.2.1

- `/qwen-login` now surfaces the approval link as an interactive question card in the chat (via `userQuestions`) instead of only the command result: a multi-line command outcome collapses into a disclosure row and long URLs break on wrapping there, which users could not act on. The card carries a clickable markdown link plus the code and expiry; answering it is optional — polling completes the sign-in regardless.
- Falls back to plain text when no live agent or user-questions service is available (headless, non-chat dispatch).

## 1.2.0

Verified end-to-end against a live Qwen Plus/Pro subscription.

- Removed the activation-time debug dump of the Loader entry catalog from the host log.
- README (EN/RU) corrected to match observed behavior: the approval link is `/authorize` (not the advertised `/device`), the bundle activates live via HMR without a restart, and route auto-registration may be refused while the install transaction is open — `/qwen-setup` completes it.

## 1.1.7

- Build the approval link as `https://chat.qwen.ai/authorize?user_code=…&client=cli` (plus `entry`/`paywallScene` tracking), the way Qwen Code's own subscription client does. The `/device` URI returned by the device-code endpoint has no route in the deployed SPA and bounced to the chat home, so no approval page ever opened.

## 1.1.6

- Added `/qwen-setup` to register the `llm-pi-ai` route from a command handler, which runs outside the plugin's activation context. The config editor refuses an edit issued from inside activation ("HMR transactions cannot be nested"), and that async context survives timers, so activation now tries once and points at the command.

## 1.1.3 – 1.1.5

- Host log file at `$DSH_HOME/qwen-sub-oauth.log` for activation diagnostics (the web host has no visible console).
- Route-registration retry schedule (later superseded by `/qwen-setup`).

## 1.1.1 – 1.1.2

- Declare only the `credentials` dependency; reach `commands`/`configEditor` via `ctx.get`.
- Address Loader entries through their `options` when locating `llm-pi-ai`.

## 1.1.0

- Auto-start the OAuth device flow on activation when no refresh token is stored.
- `/qwen-login` and `/qwen-status` commands.
- Register the `qwen-sub-oauth` pi-ai route through the config editor.
- Rotate `QWEN_SUB_OAUTH_TOKEN` / `QWEN_SUB_OAUTH_REFRESH` in the credential store.
- README in English and Russian, MIT license.

## 1.0.0

- Initial token-rotation plugin for a hand-declared `qwen-sub-oauth` route.
