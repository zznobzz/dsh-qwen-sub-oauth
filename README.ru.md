# dsh-qwen-sub-oauth

Подписка **Qwen Plus/Pro** (chat.qwen.ai) как провайдер моделей в [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — через OAuth, без API-ключа.

Старый бесплатный Qwen OAuth (`chat.qwen.ai/api/v1/oauth2/*`) закрыт 15.04.2026. Подписочный flow, который использует Qwen Code, другой — этот плагин его и реализует: device flow у `auth.qwen.ai`, OpenAI-совместимый шлюз `api.qwen.ai/compatible-mode/v1` и автоматическая ротация токена в хранилище кредов DSH.

[English version](README.md)

## Что делает

- Регистрирует маршрут провайдера `qwen-sub-oauth` (`api.qwen.ai/compatible-mode/v1`, модели `qwen3.8-max`, `qwen3.8-flash`, `qwen4-max`, контекст 1M) в `llm-pi-ai` — через конфигурационный редактор DSH, поэтому достаточно установить бандл.
- При активации сам запускает OAuth device flow, если refresh-токена ещё нет, и печатает ссылку подтверждения в консоль хоста.
- Добавляет в GUI команды `/qwen-login` (показать ожидающую ссылку/код или начать новый вход), `/qwen-status` (наличие токена и срок жизни) и `/qwen-setup` (повторная регистрация маршрута, если автоматическая попытка отклонена).
- Обновляет access-токен до истечения и пишет `QWEN_SUB_OAUTH_TOKEN` / `QWEN_SUB_OAUTH_REFRESH` в хранилище кредов. LLM-адаптер читает ref на каждый запрос, поэтому перезапуск для ротации не нужен.

## Требования

- Аккаунт Qwen с действующей подпиской **Plus или Pro** на chat.qwen.ai. Сам OAuth доступа к моделям не даёт.
- DeepSeek Harness с плагином `llm-pi-ai` (есть в любом штатном профиле) и локальным хранилищем кредов.

## Установка

```bash
dsh plugin --profile web add github:zznobzz/dsh-qwen-sub-oauth
```

Затем перезапустите профиль, если хост не подхватил бандл автоматически:

```bash
sudo systemctl restart dsh-web   # или та команда, которой вы запускаете dsh web
```

При первой активации плагин начинает device flow и пишет в лог ссылку:

```
[qwen-sub-oauth] авторизация: https://chat.qwen.ai/device?user_code=XXXX-XXXX (код XXXX-XXXX)
```

Откройте её в браузере, войдите аккаунтом с подпиской и дождитесь `authorization completed` в консоли. В GUI `/qwen-login` покажет ожидающую ссылку или начнёт новый вход, `/qwen-status` покажет текущее состояние.

## Использование

Выберите в выборе модели **Qwen (подписка OAuth)** и модель `qwen3.8-max`, `qwen3.8-flash` или `qwen4-max`.

```
/qwen-login     # ожидающая ссылка и код либо новый flow
/qwen-status    # авторизовано? когда истекает access-токен?
/qwen-setup     # добавить маршрут провайдера в llm-pi-ai повторно
```

## Конфигурация

```yaml
- insert:
    - id: qwen-sub-oauth
      name: dsh-qwen-sub-oauth
      config:
        autoLogin: true        # запускать device flow при активации, если вход не выполнен
        configureRoute: true   # регистрировать маршрут pi-ai, если его нет
        intervalMs: 600000     # период проверки/обновления токена
```

Если маршрут нужно объявить вручную, выключите `configureRoute` и добавьте в патч профиля:

```yaml
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      qwen-sub-oauth:
        displayName: Qwen (подписка OAuth)
        api: openai-completions
        baseURL: https://api.qwen.ai/compatible-mode/v1
        apiKeyEnv: QWEN_SUB_OAUTH_TOKEN
        models:
          - id: qwen3.8-max
            name: Qwen3.8 Max
            contextWindow: 1000000
            maxTokens: 32768
```

## Как устроен flow

| Шаг | Запрос |
|---|---|
| Код устройства | `POST https://auth.qwen.ai/api/oauth/device/code` — `client_id=qwen-code-cli`, `scope="model:invoke profile:read"` |
| Подтверждение | `https://chat.qwen.ai/device?user_code=…` |
| Токен | `POST https://auth.qwen.ai/api/oauth/token` — `grant_type=urn:ietf:params:oauth:grant-type:device_code` |
| Обновление | `POST https://auth.qwen.ai/api/oauth/token` — `grant_type=refresh_token` |
| Профиль | `GET https://auth.qwen.ai/api/oauth/userinfo` |
| Вызовы моделей | `POST https://api.qwen.ai/compatible-mode/v1/chat/completions` с `Authorization: Bearer <access_token>` |

`User-Agent` вида `QwenCode/…` обязателен: Aliyun WAF отвечает `405` и HTML-заглушкой на дефолтные агенты HTTP-клиентов.

## Диагностика

- `MISSING_CREDENTIAL` / `PROXY_TOKEN_MISSING` — токена в хранилище нет: выполните `/qwen-login`.
- `invalid_grant` при refresh — refresh-токен отозван: повторите `/qwen-login` (если плагин считает вас авторизованным, сначала удалите `QWEN_SUB_OAUTH_REFRESH`).
- `405` и HTML вместо JSON — запрос ушёл без `User-Agent` `QwenCode/…`.
- Ссылка подтверждения открывает главную чата — используйте ссылку `/authorize`, которую печатает плагин. У URI `device`, который рекламирует token-эндпоинт, в развёрнутой SPA нет маршрута; Qwen Code сам открывает `/authorize?user_code=…&client=cli`.
- В выборе модели нет маршрута — выполните `/qwen-setup`; если он сообщает об ошибке конфигурации, добавьте блок провайдера вручную или перезапустите профиль.

## Удаление

```bash
dsh plugin --profile web remove dsh-qwen-sub-oauth
```

Уберите блок провайдера `qwen-sub-oauth` из патча профиля и очистите креды, если токены больше не нужны.

## Безопасность и условия использования

- Токены лежат только в хранилище кредов DSH (`$DSH_HOME/.credentials.yaml`, режим `0600`); в конфигурацию они не попадают.
- `client_id=qwen-code-cli` — публичный клиент Qwen Code CLI. Использование его токенов сторонним клиентом — серая зона условий Qwen; квоты идут по вашему тарифу подписки.
- Никогда не передавайте пароль от Qwen или данные аккаунта «сервисам, которые оплатят подписку за вас». Отозвать доступ можно удалением сохранённых токенов.

Лицензия MIT.
