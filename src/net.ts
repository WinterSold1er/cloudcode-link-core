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

/** fetch() honoring env proxies, or an explicit per-account proxy URL. */
export function agyFetch(url: string, init: RequestInit = {}, proxyUrl?: string): Promise<Response> {
  const signal = init.signal ?? AbortSignal.timeout(30_000)
  return undiciFetch(url, {
    ...(init as object),
    signal,
    dispatcher: agentFor(proxyUrl),
  }) as unknown as Promise<Response>
}
