/**
 * Qwen subscription (chat.qwen.ai Plus/Pro) as a DSH provider, via OAuth.
 *
 * Qwen Code's "Qwen Account with Subscription" authorises through an RFC 8628
 * device flow against auth.qwen.ai and returns a short-lived access token plus a
 * refresh token. A hand-declared pi-ai route then calls the OpenAI-compatible
 * gateway at api.qwen.ai/compatible-mode/v1 with that bearer token.
 *
 * This plugin owns everything around that token:
 *
 * - on activation, when no refresh token is stored yet, it starts the device
 *   flow itself and prints the verification URL to the host console;
 * - `/qwen-login` shows the pending code (or starts a fresh flow), so the URL is
 *   reachable from the GUI without shell access;
 * - `/qwen-status` reports whether tokens are present and when they expire;
 * - a timer refreshes the access token before it expires and writes both tokens
 *   into the credential store, which LLM adapters re-read per request;
 * - it can register the pi-ai route through the config editor, so installing the
 *   bundle is enough for a fresh profile.
 *
 * @module @local/dsh-qwen-sub-oauth
 */

import { appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const AUTH_BASE = 'https://auth.qwen.ai'
const API_BASE = 'https://api.qwen.ai/compatible-mode/v1'
const CLIENT_ID = 'qwen-code-cli'
const SCOPE = 'model:invoke profile:read'
const USER_AGENT = 'QwenCode/0.15.0 (dsh-qwen-sub-oauth)'
/** Credential ref the LLM route names through `apiKeyEnv`. */
const ACCESS_REF = 'QWEN_SUB_OAUTH_TOKEN'
/** Credential ref holding the refresh token. */
const REFRESH_REF = 'QWEN_SUB_OAUTH_REFRESH'
const ROUTE = 'qwen-sub-oauth'
const ROUTE_MODELS = [
  { id: 'qwen3.8-max', name: 'Qwen3.8 Max', contextWindow: 1000000, maxTokens: 32768 },
  { id: 'qwen3.8-flash', name: 'Qwen3.8 Flash', contextWindow: 1000000, maxTokens: 32768 },
  { id: 'qwen4-max', name: 'Qwen4 Max', contextWindow: 1000000, maxTokens: 32768 },
]
/** Host-process log next to the harness home: the web UI has no console. */
const LOG_FILE = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'qwen-sub-oauth.log')
const CHAT_ORIGIN = 'https://chat.qwen.ai'
const DEFAULT_INTERVAL_MS = 10 * 60 * 1000
/** Refresh this long before the access token actually expires. */
const SKEW_MS = 10 * 60 * 1000
const TIMEOUT_MS = 30_000

export const name = 'qwen-sub-oauth'
export const inject = ['credentials']
// Optional surfaces reached through ctx.get: 'commands' (slash commands),
// 'userQuestions' (interactive cards), 'agents' (live-agent lookup).

/**
 * The approval page. The device-code response advertises `/device`, but the
 * deployed chat.qwen.ai SPA has no such route and falls back to the chat home,
 * so the CLI builds `/authorize` itself (qwen-code's qwen/subscription-oauth
 * client does exactly this). The two tracking params keep the flow attributed.
 */
function authorizationUrl(userCode) {
  const url = new URL('/authorize', CHAT_ORIGIN)
  url.searchParams.set('user_code', userCode)
  url.searchParams.set('client', 'cli')
  url.searchParams.set('entry', 'qwen_code')
  url.searchParams.set('paywallScene', 'cli')
  return url.toString()
}

function log(level, message) {
  try {
    appendFileSync(LOG_FILE, `${new Date().toISOString()} ${level} ${message}\n`)
  } catch {
    // logging must never break the plugin
  }
}

/** Decode a JWT payload without verifying it; `undefined` for opaque tokens. */
function jwtPayload(token) {
  const part = token.split('.')[1]
  if (part === undefined) return undefined
  try {
    const json = Buffer.from(part.replaceAll('-', '+').replaceAll('_', '/'), 'base64').toString('utf8')
    const payload = JSON.parse(json)
    return typeof payload === 'object' && payload !== null ? payload : undefined
  } catch {
    return undefined
  }
}

function expiresAt(token) {
  const exp = jwtPayload(token)?.exp
  return typeof exp === 'number' ? exp * 1000 : undefined
}

function formatLeft(ms) {
  const total = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(total / 60)} мин ${String(total % 60).padStart(2, '0')} с`
}

async function postForm(path, fields) {
  const response = await fetch(`${AUTH_BASE}${path}`, {
    method: 'POST',
    headers: {
      'user-agent': USER_AGENT,
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(fields).toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const body = await response.json().catch(() => undefined)
  return { status: response.status, ok: response.ok, body }
}

async function getUserInfo(accessToken) {
  try {
    const response = await fetch(`${AUTH_BASE}/api/oauth/userinfo`, {
      headers: { 'user-agent': USER_AGENT, accept: 'application/json', authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const body = await response.json().catch(() => undefined)
    return typeof body?.email === 'string' ? body.email : undefined
  } catch {
    return undefined
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason ?? new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Install the pi-ai route when the profile has none yet; never rewrites other providers. */
async function ensureRoute(ctx, warn) {
  const editor = ctx.get('configEditor')
  if (editor === undefined) {
    log('warn', 'configEditor недоступен, маршрут не регистрируется автоматически')
    return true
  }
  try {
    const entry = editor.entries().find(row => row.options?.name === '@deepseek-ai/dsh-llm-pi-ai')
    if (entry === undefined) return true
    const { override } = editor.configuration().find(row => row.entry.options.id === entry.options.id) ?? {}
    const providers = override?.providers
    if (providers !== null && typeof providers === 'object' && ROUTE in providers) return true
    await editor.edit(entry, current => ({
      ...current,
      providers: {
        ...(current.providers ?? {}),
        [ROUTE]: {
          displayName: 'Qwen (подписка OAuth)',
          api: 'openai-completions',
          baseURL: API_BASE,
          apiKeyEnv: ACCESS_REF,
          models: ROUTE_MODELS,
        },
      },
    }))
    log('info', `маршрут ${ROUTE} добавлен в llm-pi-ai`)
    console.info(`[qwen-sub-oauth] маршрут ${ROUTE} добавлен в llm-pi-ai`)
    return true
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    warn(`не удалось добавить маршрут ${ROUTE}: ${message}`)
    return !message.includes('cannot be nested')
  }
}

export function apply(ctx, config) {
  const intervalMs = Number.isSafeInteger(config?.intervalMs) && config.intervalMs > 0
    ? config.intervalMs
    : DEFAULT_INTERVAL_MS
  const autoLogin = config?.autoLogin !== false
  const configureRoute = config?.configureRoute !== false
  const warn = message => {
    log('warn', message)
    console.warn(`[qwen-sub-oauth] ${message}`)
  }

  /** Pending device flow, shared by the command and the background poll. */
  let pending
  let controller
  let email

  const stopPoll = () => {
    controller?.abort()
    controller = undefined
  }

  const storeTokens = async tokens => {
    await ctx.credentials.set(ACCESS_REF, tokens.access_token)
    if (typeof tokens.refresh_token === 'string' && tokens.refresh_token !== '') {
      await ctx.credentials.set(REFRESH_REF, tokens.refresh_token)
    }
  }

  /** Refresh only when the stored access token is missing or about to expire. */
  const rotate = async () => {
    const stored = await ctx.credentials.resolve(REFRESH_REF)
    const refreshToken = stored?.value
    if (refreshToken === undefined || refreshToken === '') return
    const current = await ctx.credentials.resolve(ACCESS_REF)
    const currentToken = current?.value
    if (currentToken !== undefined && currentToken !== '') {
      const expiry = expiresAt(currentToken)
      if (expiry !== undefined && expiry - Date.now() > SKEW_MS) return
    }
    const { ok, status, body } = await postForm('/api/oauth/token', {
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: refreshToken,
    })
    if (!ok) {
      warn(`token refresh failed (HTTP ${status}): ${body?.error ?? 'unknown error'}`)
      return
    }
    if (typeof body?.access_token !== 'string' || body.access_token === '') {
      warn('token refresh returned no access_token')
      return
    }
    await storeTokens(body)
  }

  const startFlow = async () => {
    stopPoll()
    const { ok, status, body } = await postForm('/api/oauth/device/code', {
      client_id: CLIENT_ID,
      scope: SCOPE,
    })
    if (!ok || typeof body?.device_code !== 'string') {
      throw new Error(`device/code failed (HTTP ${status}): ${body?.error ?? 'unknown error'}`)
    }
    pending = {
      ...body,
      verification_uri: authorizationUrl(body.user_code),
      verification_uri_complete: authorizationUrl(body.user_code),
      expiresAt: Date.now() + Number(body.expires_in ?? 600) * 1000,
    }
    log('info', `авторизация: ${pending.verification_uri_complete} (код ${pending.user_code})`)
    console.info(`[qwen-sub-oauth] авторизация: ${pending.verification_uri_complete} (код ${pending.user_code})`)
    void poll()
    return pending
  }

  const poll = async () => {
    const flow = pending
    if (flow === undefined) return
    controller?.abort()
    controller = new AbortController()
    const { signal } = controller
    let interval = Math.max(1, Number(flow.interval ?? 5)) * 1000
    try {
      while (!signal.aborted && Date.now() < flow.expiresAt && pending === flow) {
        await sleep(interval, signal)
        const { ok, status, body } = await postForm('/api/oauth/token', {
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          client_id: CLIENT_ID,
          device_code: flow.device_code,
        })
        if (ok && typeof body?.access_token === 'string') {
          await storeTokens(body)
          pending = undefined
          email = await getUserInfo(body.access_token)
          log('info', `авторизация завершена${email ? ` (${email})` : ''}`)
          console.info(`[qwen-sub-oauth] авторизация завершена${email ? ` (${email})` : ''}`)
          return
        }
        const code = body?.error
        if (code === 'authorization_pending') continue
        if (code === 'slow_down') {
          interval += 5000
          continue
        }
        if (code === 'expired_token' || code === 'access_denied') {
          pending = undefined
          warn(`авторизация не завершена: ${code}`)
          return
        }
        if (status === 429 || status >= 500) {
          interval = Math.min(interval * 2, 30_000)
          continue
        }
        warn(`token exchange failed (HTTP ${status}): ${code ?? 'unknown error'}`)
        return
      }
      if (pending === flow) pending = undefined
    } catch (error) {
      if (!signal.aborted) warn(`polling failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Markdown body for the interactive card: a labeled bare link stays clickable. */
  const flowDetail = flow =>
    `[Открыть страницу подтверждения](${flow.verification_uri_complete})\n\n`
    + `Код: \`${flow.user_code}\` · истекает через ${formatLeft(flow.expiresAt - Date.now())}`

  /** Plain-text fallback for the command result: keep the URL on its own line. */
  const flowMessage = flow =>
    `Подтвердите вход в браузере — откройте ссылку (нужна активная подписка Plus/Pro):\n\n`
    + `${flow.verification_uri_complete}\n\n`
    + `Код: ${flow.user_code} · истекает через ${formatLeft(flow.expiresAt - Date.now())}`

  const status = async () => {
    const access = await ctx.credentials.resolve(ACCESS_REF)
    const refresh = await ctx.credentials.resolve(REFRESH_REF)
    if (refresh?.value === undefined || refresh.value === '') return 'Авторизация не выполнена: /qwen-login'
    if (access?.value === undefined || access.value === '') return 'Refresh-токен есть, access-токен будет получен при первом обновлении'
    const expiry = expiresAt(access.value)
    const left = expiry === undefined ? 'срок неизвестен' : `истекает через ${formatLeft(expiry - Date.now())}`
    return `Авторизовано${email ? ` (${email})` : ''}, access-токен ${left}`
  }

  /** The exact live Agent instance registered in this Host (ask rejects foreign instances). */
  const liveAgent = agent => {
    const agents = ctx.get('agents')
    if (agents === undefined || agent === undefined) return undefined
    return agents.get(agent.session?.id) ?? undefined
  }

  /** Pending non-expired flow, clearing an expired one. */
  const describePendingFlow = () => {
    if (pending === undefined) return undefined
    if (Date.now() >= pending.expiresAt) {
      pending = undefined
      return undefined
    }
    return pending
  }

  /**
   * Show the approval link where the user can actually act on it. A command's
   * multi-line result collapses into a disclosure row and long URLs break on
   * wrapping there, so when the requesting agent is live the link goes out as
   * an interactive card in the chat instead.
   */
  const presentFlow = async (flow, invocation) => {
    const questions = ctx.get('userQuestions')
    const agent = liveAgent(invocation.agent)
    if (questions !== undefined && agent !== undefined) {
      void questions.ask({
        agent,
        signal: AbortSignal.any([invocation.signal, AbortSignal.timeout(flow.expiresAt - Date.now())]),
        questions: [{
          id: 'approve',
          question: 'Подтвердите вход в Qwen (аккаунт с активной подпиской Plus/Pro)',
          detail: flowDetail(flow),
          options: [{ label: 'Я подтвердил вход' }, { label: 'Отмена' }],
        }],
      }).then(answer => {
        if (answer.answers[0]?.selected[0] === 'Я подтвердил вход') {
          log('info', 'пользователь подтвердил вход в карточке')
        }
      }).catch(error => {
        if (!invocation.signal.aborted) warn(`карточка входа недоступна: ${error instanceof Error ? error.message : String(error)}`)
      })
      return { kind: 'success', text: `Карточка со ссылкой входа открыта в этом чате. Код: ${flow.user_code}, ${formatLeft(flow.expiresAt - Date.now())}` }
    }
    return { kind: 'success', text: flowMessage(flow) }
  }

  const commands = ctx.get('commands')
  if (commands !== undefined) {
    ctx.effect(() => commands.register({
      name: 'qwen-login',
      description: 'Вход в Qwen по подписке (OAuth device flow)',
      handler: async invocation => {
        try {
          let flow = describePendingFlow()
          if (flow === undefined) {
            const refresh = await ctx.credentials.resolve(REFRESH_REF)
            if (refresh?.value !== undefined && refresh.value !== '') {
              // Signed in already: re-auth only makes sense for a different account.
              const questions = ctx.get('userQuestions')
              const agent = liveAgent(invocation.agent)
              if (questions !== undefined && agent !== undefined) {
                const answer = await questions.ask({
                  agent,
                  signal: invocation.signal,
                  questions: [{
                    id: 'relogin',
                    question: `Вы уже авторизованы (${email ?? 'аккаунт без email'}). Начать новый вход для другой учётной записи?`,
                    options: [{ label: 'Начать новый вход' }, { label: 'Отмена' }],
                  }],
                })
                const item = answer.answers[0]
                if (item === undefined || item.selected[0] !== 'Начать новый вход') {
                  return { kind: 'success', text: await status() }
                }
              } else {
                return { kind: 'success', text: `Уже авторизовано. ${await status()}\nЧтобы войти заново, удалите ref ${REFRESH_REF}.` }
              }
            }
            flow = await startFlow()
          }
          return presentFlow(flow, invocation)
        } catch (error) {
          return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
        }
      },
    }))

    ctx.effect(() => commands.register({
      name: 'qwen-setup',
      description: 'Добавить маршрут qwen-sub-oauth в llm-pi-ai',
      handler: async () => {
        const applied = await ensureRoute(ctx, warn)
        return applied
          ? { kind: 'success', text: `Маршрут ${ROUTE} в llm-pi-ai настроен. Модели: ${ROUTE_MODELS.map(model => model.id).join(', ')}` }
          : { kind: 'error', text: `Не удалось изменить конфигурацию: см. ${LOG_FILE}. Добавьте провайдера в патч профиля вручную (см. README).` }
      },
    }))

    ctx.effect(() => commands.register({
      name: 'qwen-status',
      description: 'Состояние авторизации Qwen по подписке',
      handler: async () => ({ kind: 'success', text: await status() }),
    }))
  }

  const tick = () => rotate().catch(error => {
    warn(error instanceof Error ? error.message : String(error))
  })

  ctx.effect(() => {
    const timer = setInterval(tick, intervalMs)
    timer.unref?.()
    return () => {
      clearInterval(timer)
      stopPoll()
    }
  })

  // The config editor opens an HMR transaction, so an edit issued from inside
  // the plugin's own activation (whose async context still carries that
  // transaction) is refused: activation only tries once and points at
  // /qwen-setup, whose handler runs outside that context.
  if (configureRoute) {
    const timer = setTimeout(async () => {
      const applied = await ensureRoute(ctx, warn)
      if (!applied) log('warn', 'маршрут не добавлен автоматически: выполните /qwen-setup')
    }, 5000)
    timer.unref?.()
  }

  void (async () => {
    await tick()
    if (!autoLogin) return
    const refresh = await ctx.credentials.resolve(REFRESH_REF)
    if (refresh?.value !== undefined && refresh.value !== '') return
    try {
      const flow = await startFlow()
      // The host has no visible console on every deployment, so offer the link
      // as a card in each live chat; answering is optional — polling completes
      // the sign-in from any tab that gets the approval.
      const questions = ctx.get('userQuestions')
      const agents = ctx.get('agents')
      if (questions === undefined || agents === undefined) return
      for (const agent of agents.roots()) {
        void questions.ask({
          agent,
          signal: AbortSignal.timeout(flow.expiresAt - Date.now()),
          questions: [{
            id: 'approve',
            question: 'Qwen по подписке: подтвердите вход (аккаунт с активной подпиской Plus/Pro)',
            detail: flowDetail(flow),
            options: [{ label: 'Я подтвердил вход' }, { label: 'Отмена' }],
          }],
        }).catch(() => {})
      }
    } catch (error) {
      warn(`не удалось начать авторизацию: ${error instanceof Error ? error.message : String(error)}`)
    }
  })()
}
