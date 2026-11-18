# Changelog

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
