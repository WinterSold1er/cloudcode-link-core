// Proxy-aware fetch for Google endpoints.
import { EnvHttpProxyAgent, ProxyAgent, fetch as undiciFetch } from 'undici'

const envAgent = new EnvHttpProxyAgent()
const perProxyAgents = new Map<string, ProxyAgent>()

function agentFor(proxyUrl?: string): EnvHttpProxyAgent | ProxyAgent {
  if (proxyUrl) {
    let agent = perProxyAgents.get(proxyUrl)
    if (!agent) {
      agent = new ProxyAgent(proxyUrl)
      perProxyAgents.set(proxyUrl, agent)
    }
    return agent
  }
  return envAgent
}

export interface AgyFetchOptions extends RequestInit {
  timeoutMs?: number | null
}

/** fetch() honoring env proxies, or an explicit per-account proxy URL. */
export function agyFetch(url: string, init: AgyFetchOptions = {}, proxyUrl?: string): Promise<Response> {
  let signal: AbortSignal | undefined = init.signal ?? undefined
  if (!signal && init.timeoutMs !== null && init.timeoutMs !== 0) {
    const isStream = url.includes('streamGenerateContent')
    const timeout = init.timeoutMs ?? (isStream ? 0 : 30_000)
    if (timeout > 0) {
      signal = AbortSignal.timeout(timeout)
    }
  }
  return undiciFetch(url, {
    ...(init as object),
    ...(signal ? { signal } : {}),
    dispatcher: agentFor(proxyUrl),
  }) as unknown as Promise<Response>
}
