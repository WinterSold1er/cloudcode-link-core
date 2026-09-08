// PoolAuthFlow: Google OAuth lifecycle for adding pool accounts.
import { randomBytes } from 'node:crypto'
import {
  buildAuthorizeUrl,
  exchangeCode,
  fetchUserEmail,
  generatePkce,
  openBrowser,
  parsePastedCode,
  startCallbackListener,
  writeAgyTokenFile,
  type CallbackHandle,
} from './oauth.ts'
import type { AccountPoolManager } from './pool.ts'
import type { QuotaService } from './quota.ts'

export type PoolAuthPhase = 'idle' | 'waiting' | 'exchanging' | 'done' | 'failed'

export interface PoolAuthStatus {
  phase: PoolAuthPhase
  stagingId?: string
  alias?: string
  url?: string
  mode?: 'auto' | 'manual'
  browserOpened?: boolean
  message?: string
}

interface ActiveFlow {
  stagingId: string
  dir: string
  alias?: string
  proxyUrl?: string
  verifier: string
  state: string
  url: string
  mode: 'auto' | 'manual'
  listener: CallbackHandle | null
  primary?: boolean
}

const DONE_STATUS_TTL_MS = 30_000

export interface PoolAuthFlowDeps {
  openBrowser?: (url: string) => Promise<boolean>
}

export class PoolAuthFlow {
  private flow: ActiveFlow | null = null
  private statusValue: PoolAuthStatus = { phase: 'idle' }
  private doneResetTimer: NodeJS.Timeout | null = null
  private readonly open: (url: string) => Promise<boolean>

  private readonly pool: AccountPoolManager
  private readonly quota: QuotaService
  private readonly log: (msg: string) => void

  constructor(
    pool: AccountPoolManager,
    quota: QuotaService,
    log: (msg: string) => void = () => {},
    deps: PoolAuthFlowDeps = {},
  ) {
    this.pool = pool
    this.quota = quota
    this.log = log
    this.open = deps.openBrowser ?? openBrowser
  }

  status(): PoolAuthStatus {
    return { ...this.statusValue }
  }

  private setStatus(patch: Partial<PoolAuthStatus> & { phase: PoolAuthPhase }): void {
    if (this.doneResetTimer) {
      clearTimeout(this.doneResetTimer)
      this.doneResetTimer = null
    }
    this.statusValue = { ...this.statusValue, ...patch }
    if (patch.phase === 'done') {
      this.doneResetTimer = setTimeout(() => {
        if (this.statusValue.phase === 'done') this.statusValue = { phase: 'idle' }
      }, DONE_STATUS_TTL_MS)
    }
  }

  private async startFlow(flow: Omit<ActiveFlow, 'verifier' | 'state' | 'url' | 'mode' | 'listener'>): Promise<PoolAuthStatus & { ok: boolean; dir?: string }> {
    await this.abortActive()

    const { verifier, challenge } = generatePkce()
    const state = randomBytes(16).toString('base64url')
    const url = buildAuthorizeUrl(challenge, state)

    let listener: CallbackHandle | null = startCallbackListener()
    let bindFailed = false
    await Promise.race([
      listener.result.then(
        () => {},
        () => {
          bindFailed = true
        },
      ),
      new Promise((resolve) => setTimeout(resolve, 300)),
    ])
    if (bindFailed) {
      await listener.close().catch(() => undefined)
      listener = null
    }
    const mode: 'auto' | 'manual' = listener ? 'auto' : 'manual'

    const browserOpened = await this.open(url)

    const active: ActiveFlow = { ...flow, verifier, state, url, mode, listener }
    this.flow = active
    this.setStatus({
      phase: 'waiting',
      stagingId: active.stagingId,
      alias: active.alias,
      url,
      mode,
      browserOpened,
      message: browserOpened
        ? undefined
        : '无法自动打开浏览器，请手动打开下方链接',
    })
    this.log(`pool auth begun (${mode} mode, browserOpened=${browserOpened}${active.primary ? ', primary' : ''})`)

    if (listener) {
      void listener.result
        .then(({ code, state: returnedState }) => this.finishWithCode(code, returnedState))
        .catch((err: unknown) => {
          if (!this.flow || this.flow.listener !== listener) return
          this.fail(`授权回调失败: ${err instanceof Error ? err.message : String(err)}`)
        })
    }

    return { ok: true, ...this.statusValue, dir: active.dir }
  }

  async begin(alias?: string, proxyUrl?: string): Promise<PoolAuthStatus & { ok: boolean; dir?: string }> {
    const staging = this.pool.createStagingSlot()
    return this.startFlow({ stagingId: staging.id, dir: staging.dir, alias, proxyUrl })
  }

  async beginPrimary(): Promise<PoolAuthStatus & { ok: boolean; dir?: string }> {
    const { homedir } = await import('node:os')
    return this.startFlow({ stagingId: 'acc_primary', dir: homedir(), primary: true })
  }

  async submitCode(input: string): Promise<PoolAuthStatus & { ok: boolean }> {
    const flow = this.flow
    if (!flow || this.statusValue.phase !== 'waiting') {
      return { ok: false, phase: this.statusValue.phase, message: '当前没有进行中的授权流程' }
    }
    const parsed = parsePastedCode(input)
    if (!parsed) {
      return { ok: false, phase: 'waiting', message: '无法识别的授权码，请粘贴授权码或完整的回调 URL' }
    }
    if (parsed.state && parsed.state !== flow.state) {
      return { ok: false, phase: 'waiting', message: 'state 校验失败：这段 URL 不属于本次授权流程' }
    }
    await this.finishWithCode(parsed.code, parsed.state ?? flow.state)
    const after = this.status()
    return { ...after, ok: after.phase === 'done' }
  }

  private async finishWithCode(code: string, returnedState: string): Promise<void> {
    const flow = this.flow
    if (!flow || this.statusValue.phase !== 'waiting') return
    if (returnedState !== flow.state) {
      this.fail('state 校验失败（可能的 CSRF 或过期回调）')
      return
    }
    this.setStatus({ phase: 'exchanging' })
    try {
      const tokens = await exchangeCode(code, flow.verifier, flow.proxyUrl)
      writeAgyTokenFile(flow.dir, tokens)
      const email = await fetchUserEmail(tokens.access_token, flow.proxyUrl)
      if (flow.primary) {
        const primary =
          this.pool.getAccount('acc_primary') ??
          this.pool.getAccounts().find((a) => a.systemHome) ??
          this.pool.getAccounts()[0]
        if (primary) {
          this.pool.updateAccountQuotas(primary.id, primary.quotas, email)
          void this.quota.refreshAccountQuota(primary).catch(() => undefined)
        }
        this.log(`primary account signed in${email ? ` <${email}>` : ''}`)
        this.flow = null
        if (flow.listener) void flow.listener.close().catch(() => undefined)
        this.setStatus({ phase: 'done', alias: email, message: `主账号已登录${email ? `: ${email}` : ''}` })
        return
      }
      const acc = this.pool.commitStagingAccount(flow.stagingId, flow.dir, flow.alias, email, flow.proxyUrl)
      this.log(`pool auth committed account ${acc.id}${email ? ` <${email}>` : ''}`)
      void this.quota.refreshAccountQuota(acc).catch(() => undefined)
      this.flow = null
      if (flow.listener) void flow.listener.close().catch(() => undefined)
      this.setStatus({ phase: 'done', alias: acc.alias, message: `账号 ${acc.alias} 已激活` })
    } catch (err) {
      this.fail(`授权码交换失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private fail(message: string): void {
    const flow = this.flow
    this.log('pool auth failed: ' + message)
    if (flow) {
      if (flow.listener) void flow.listener.close().catch(() => undefined)
      if (!flow.primary) this.pool.cleanupStagingSlot(flow.dir)
      this.flow = null
    }
    this.setStatus({ phase: 'failed', message })
  }

  async cancel(): Promise<PoolAuthStatus & { ok: boolean }> {
    await this.abortActive()
    this.setStatus({ phase: 'idle' })
    return { ok: true, phase: 'idle' }
  }

  private async abortActive(): Promise<void> {
    const flow = this.flow
    if (!flow) return
    this.flow = null
    if (flow.listener) await flow.listener.close().catch(() => undefined)
    if (!flow.primary) this.pool.cleanupStagingSlot(flow.dir)
  }
}
