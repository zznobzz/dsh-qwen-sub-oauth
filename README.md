# dsh-qwen-sub-oauth

Use a **Qwen Plus/Pro subscription** (chat.qwen.ai) as a model provider in [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — with OAuth, no API key.

The old free Qwen OAuth (`chat.qwen.ai/api/v1/oauth2/*`) was shut down on 2026-04-15. The subscription flow Qwen Code uses today is different, and this plugin speaks it: device flow against `auth.qwen.ai`, OpenAI-compatible gateway at `api.qwen.ai/compatible-mode/v1`, and automatic token rotation into the DSH credential store.

[Русская версия](README.ru.md)

## What it does

- Registers the provider route `qwen-sub-oauth` (`api.qwen.ai/compatible-mode/v1`, models `qwen3.8-max`, `qwen3.8-flash`, `qwen4-max`, 1M context) in `llm-pi-ai` through the DSH config editor. It tries on activation; if the host refuses the edit while the install transaction is still open, `/qwen-setup` completes it.
- Starts the OAuth device flow on activation when no refresh token is stored yet, and prints the verification URL to the host console.
- Exposes `/qwen-login` (opens an interactive card in the chat with the approval link, code and expiry; starts a fresh flow when needed), `/qwen-status` (token presence and expiry) and `/qwen-setup` (register the route again if the automatic attempt was refused). On activation the same card is offered to every live chat session, so the link is visible without opening logs.
- Refreshes the access token before it expires and writes `QWEN_SUB_OAUTH_TOKEN` / `QWEN_SUB_OAUTH_REFRESH` into the credential store. LLM adapters re-read the reference per request, so rotation needs no restart.

## Requirements

- A Qwen account with an active **Plus or Pro** subscription on chat.qwen.ai. OAuth alone grants no model access.
- DeepSeek Harness with the `llm-pi-ai` plugin (every shipped profile has it) and the local credential store.

## Install

```bash
dsh plugin --profile web add github:zznobzz/dsh-qwen-sub-oauth
```

The bundle activates live through HMR — no restart needed on a standard profile. (If your host runs with HMR disabled, restart the profile once.)

On first activation the plugin starts the device flow and logs a link such as:

```
[qwen-sub-oauth] авторизация: https://chat.qwen.ai/authorize?user_code=XXXX-XXXX&client=cli (код XXXX-XXXX)
```

Open it in a browser (you must already be signed in to chat.qwen.ai), approve the code, and wait for `авторизация завершена` in the log. Then run `/qwen-setup` to register the route. In the GUI, `/qwen-login` reprints the pending link or starts a new one, `/qwen-status` shows the current state.

## Usage

Pick **Qwen (подписка OAuth)** in the model selector and choose `qwen3.8-max`, `qwen3.8-flash` or `qwen4-max`.

```
/qwen-login     # pending verification link + code, or a fresh flow
/qwen-status    # authorized? when does the access token expire?
/qwen-setup     # add the provider route to llm-pi-ai again
```

## Configuration

```yaml
- insert:
    - id: qwen-sub-oauth
      name: dsh-qwen-sub-oauth
      config:
        autoLogin: true        # start the device flow on activation when not signed in
        configureRoute: true   # register the pi-ai route when it is absent
        intervalMs: 600000     # token refresh tick
```

If you prefer to declare the route yourself, disable `configureRoute` and add it to your profile patch:

```yaml
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      qwen-sub-oauth:
        displayName: Qwen (OAuth subscription)
        api: openai-completions
        baseURL: https://api.qwen.ai/compatible-mode/v1
        apiKeyEnv: QWEN_SUB_OAUTH_TOKEN
        models:
          - id: qwen3.8-max
            name: Qwen3.8 Max
            contextWindow: 1000000
            maxTokens: 32768
```

## How the flow works

| Step | Request |
|---|---|
| Device code | `POST https://auth.qwen.ai/api/oauth/device/code` — `client_id=qwen-code-cli`, `scope="model:invoke profile:read"` |
| User approves | `https://chat.qwen.ai/authorize?user_code=…&client=cli` (the advertised `/device` URI has no SPA route) |
| Token | `POST https://auth.qwen.ai/api/oauth/token` — `grant_type=urn:ietf:params:oauth:grant-type:device_code` |
| Refresh | `POST https://auth.qwen.ai/api/oauth/token` — `grant_type=refresh_token` |
| Profile | `GET https://auth.qwen.ai/api/oauth/userinfo` |
| Model calls | `POST https://api.qwen.ai/compatible-mode/v1/chat/completions` with `Authorization: Bearer <access_token>` |

A `User-Agent` of the `QwenCode/…` shape is mandatory: Aliyun WAF answers `405` and an HTML stub to default HTTP-client agents.

## Troubleshooting

- `MISSING_CREDENTIAL` / `PROXY_TOKEN_MISSING` — no token in the store: run `/qwen-login`.
- `invalid_grant` during refresh — the refresh token was revoked: rerun `/qwen-login` (delete `QWEN_SUB_OAUTH_REFRESH` first if the plugin still considers you signed in).
- `405` plus HTML instead of JSON — a request went out without the `QwenCode/…` User-Agent.
- The verification link lands on the chat home page — use the `/authorize` link this plugin prints. The `device` URI that the token endpoint advertises has no route in the deployed SPA; `/authorize?user_code=…&client=cli` is what Qwen Code itself opens.
- No route in the model selector — run `/qwen-setup`; if it reports a configuration error, add the provider block manually or restart the profile.

## Uninstall

```bash
dsh plugin --profile web remove dsh-qwen-sub-oauth
```

Remove the `qwen-sub-oauth` provider block from your profile patch and unset the stored credentials if you want the tokens gone.

## Security and terms

- Tokens live only in the DSH credential store (`$DSH_HOME/.credentials.yaml`, mode `0600`); nothing is written into configuration.
- `client_id=qwen-code-cli` is the public Qwen Code CLI client. Using its tokens from a third-party client is a grey area of Qwen's terms of service; quotas follow your subscription plan.
- Never send your Qwen password or account credentials to any "subscription proxy" service. Revoke access by removing the stored tokens.

MIT licensed.
