import { createServer } from "node:http"
import { randomUUID } from "node:crypto"
import { attempt, isRetryable } from "./fallback.js"
import { saveConfig, validateConfig } from "./config.js"
import { page } from "./ui.js"
import { HealthStore } from "./health.js"
import { listModels } from "./models.js"
import { now } from "./time.js"
import { appendFile, mkdir } from "node:fs/promises"
import { join } from "node:path"

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(JSON.stringify(body))
}

const body = async (req, max = 4 * 1024 * 1024) => {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > max) throw Object.assign(new Error("Request body too large"), { status: 413 })
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) } catch { throw Object.assign(new Error("Invalid JSON"), { status: 400 }) }
}

const headers = (key, request) => ({
  "content-type": "application/json",
  accept: request.stream ? "text/event-stream" : "application/json",
  authorization: key ? `Bearer ${key}` : undefined,
})

const clean = (value) => ({ error: value.message, attempts: value.attempts ?? [] })
const preview = (value) => typeof value === "string" ? value.slice(0, 2000) : value
const headersForLog = (headers) => Object.fromEntries(Object.entries(headers ?? {}).filter(([key]) => !["authorization", "cookie", "set-cookie"].includes(key.toLowerCase())))
const log = (message) => console.log(`${now()} ${message}`)

export function createGateway(config) {
  const records = []
  const downstreamLogs = []
  const upstreamLogs = []
  const modelCache = new Map()
  const recentRequestModels = new Map()
  const health = new HealthStore(config.dataDir, config)
  const stats = { requests: 0, failures: 0, retries: 0 }
  const controlToken = process.env.MODEL_GATEWAY_CONTROL_TOKEN
  const logFile = join(config.dataDir, "logs", "gateway.log")
  const writeLog = (entry) => appendFile(logFile, JSON.stringify(entry) + "\n").catch(() => {})
  log(`[gateway] CONTROL_TOKEN configured=${!!controlToken} length=${controlToken?.length ?? 0}`)
  writeLog({ at: now(), type: "control-token", configured: !!controlToken, length: controlToken?.length ?? 0 })
  mkdir(join(config.dataDir, "logs"), { recursive: true }).catch(() => {})
  const record = (item) => { records.unshift({ at: now(), ...item }); records.splice(100) }
  const trafficLog = (target, item) => {
    const entry = { at: now(), ...item }
    target.unshift(entry); target.splice(200)
    const side = item.direction === "upstream" ? "UPSTREAM" : "DOWNSTREAM"
    const node = item.type === "request" ? "SEND" : "RECV"
    const provider = item.providerName ? ` provider=${item.providerName}` : item.providerId ? ` provider=${item.providerId}` : ""
    const model = item.model ? ` model=${item.model}` : ""
    const status = item.status !== undefined ? ` status=${item.status}` : ""
    const duration = item.durationMs !== undefined ? ` duration=${item.durationMs}ms` : ""
    log(`[gateway] ${side} ${node}${provider}${model} ${item.method ?? ""} ${item.path ?? ""}${status}${duration}`.trim())
    writeLog({ ...entry, body: entry.body === undefined ? undefined : preview(entry.body) })
  }
  const findProvider = (id) => config.candidates.find((item) => item.id === id)
  const providerKey = async (item) => item.apiKey
  const probeModel = (item) => item.model || recentRequestModels.get(item.id) || health.latest(item)?.model || modelCache.get(item.id)?.models?.[0]?.id
  const server = createServer(async (req, res) => {
    const id = randomUUID()
    const halfOpen = new Set()
    let requestedModel
    try {
      if (req.method === "GET" && req.url === "/") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(page) }
      if (req.method === "GET" && req.url === "/favicon.ico") { res.writeHead(204); return res.end() }
      if (req.method === "GET" && req.url === "/health") return json(res, 200, { status: "ok", ...stats })
      if (req.method === "GET" && req.url === "/__control/health") {
        if (!controlToken || req.headers["x-model-gateway-control"] !== controlToken) return json(res, 401, { error: "Unauthorized" })
        return json(res, 200, { status: "ok", ...stats })
      }
      if (req.method === "POST" && req.url === "/__control/shutdown") {
        if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress)) return json(res, 403, { error: "Loopback only" })
        if (!controlToken || req.headers["x-model-gateway-control"] !== controlToken) return json(res, 401, { error: "Unauthorized" })
        json(res, 202, { ok: true }); setImmediate(() => server.close())
        return
      }
      if (req.url.startsWith("/admin/") && config.token && req.headers.authorization !== `Bearer ${config.token}`) return json(res, 401, { error: "Unauthorized" })
       if (req.method === "GET" && req.url === "/admin/providers") return json(res, 200, config.candidates.map(({ order, apiKey, ...item }) => ({ ...item, name: item.name ?? item.id, hasApiKey: !!apiKey, probeModel: probeModel(item) ?? null, health: health.get(item, item.model) ?? health.latest(item) ?? null, models: modelCache.get(item.id) ?? null })))
       if (req.method === "GET" && req.url === "/admin/config") return json(res, 200, { listen: `${config.host}:${config.port}`, maxAttempts: config.maxAttempts, requestTimeoutMs: config.requestTimeoutMs, token: config.token ?? "", baseUrl: `http://${config.host}:${config.port}/v1` })
       if (req.method === "PUT" && req.url === "/admin/config") {
         const input = await body(req)
         const next = validateConfig({ ...config, listen: typeof input.listen === "string" ? input.listen : `${config.host}:${config.port}`, maxAttempts: input.maxAttempts, requestTimeoutMs: input.requestTimeoutMs, token: input.token }, { allowEmpty: true, defaultDataDir: config.dataDir })
         const restartRequired = next.host !== config.host || next.port !== config.port
         Object.assign(config, { maxAttempts: next.maxAttempts, requestTimeoutMs: next.requestTimeoutMs, token: next.token })
         await saveConfig(config.configFile, { ...config, host: next.host, port: next.port })
         return json(res, 200, { ok: true, restartRequired })
       }
       if (req.method === "GET" && req.url === "/admin/records") return json(res, 200, records)
       if (req.method === "GET" && req.url === "/admin/logs") return json(res, 200, { downstream: downstreamLogs, upstream: upstreamLogs })
      if (req.method === "GET" && req.url === "/admin/health") return json(res, 200, health.snapshot())
       if (req.method === "GET" && req.url.startsWith("/admin/providers/") && new URL(req.url, "http://localhost").pathname.endsWith("/models")) {
         const url = new URL(req.url, "http://localhost"); const id = decodeURIComponent(url.pathname.slice("/admin/providers/".length, -"/models".length)); const candidate = findProvider(id)
        if (!candidate) throw Object.assign(new Error("Unknown candidate"), { status: 404 })
         const key = await providerKey(candidate); const cached = modelCache.get(id)
         if (cached && url.searchParams.get("refresh") !== "1") return json(res, 200, cached)
          const result = { provider: id, models: await listModels(candidate, key), refreshedAt: now(), error: null }; modelCache.set(id, result); return json(res, 200, result)
      }
       if (req.method === "GET" && req.url.startsWith("/admin/providers/") && req.url.endsWith("/history")) {
         const id = decodeURIComponent(req.url.slice("/admin/providers/".length, -"/history".length)); if (!findProvider(id)) throw Object.assign(new Error("Unknown provider"), { status: 404 })
         const communication = upstreamLogs.filter((item) => item.providerId === id).map((item) => ({
           at: item.at, providerId: id, providerName: findProvider(id).name ?? id, operation: item.type === "request" ? "upstream-request" : "upstream-response",
           model: item.model, result: item.status === undefined ? "sent" : item.status >= 200 && item.status < 300 ? "success" : "failure",
           status: item.status, durationMs: item.durationMs, requestId: item.requestId,
         }))
         const healthHistory = records.filter((item) => item.providerId === id)
         return json(res, 200, [...communication, ...healthHistory].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 100))
       }
       if (req.method === "POST" && req.url.startsWith("/admin/providers/") && req.url.endsWith("/probe")) {
        const id = decodeURIComponent(req.url.slice("/admin/providers/".length, -"/probe".length)); const candidate = findProvider(id); if (!candidate) throw Object.assign(new Error("Unknown provider"), { status: 404 })
          const models = modelCache.get(id)?.models ?? await listModels(candidate, await providerKey(candidate)); const model = probeModel(candidate) || models[0]?.id; if (!model) throw Object.assign(new Error("Configure a model or refresh models before probing"), { status: 400 })
          const started = Date.now(); trafficLog(upstreamLogs, { direction: "upstream", type: "request", requestId: id, providerId: id, providerName: candidate.name ?? id, model, method: "POST", path: `${candidate.baseUrl}/chat/completions`, body: { model, messages: [{ role: "user", content: "ping" }], max_tokens: 1 } }); const response = await fetch(`${candidate.baseUrl}/chat/completions`, { method: "POST", headers: headers(await providerKey(candidate), {}), body: JSON.stringify({ model, messages: [{ role: "user", content: "ping" }], max_tokens: 1 }) }); const latencyMs = Date.now() - started
         trafficLog(upstreamLogs, { direction: "upstream", type: "response", requestId: id, providerId: id, providerName: candidate.name ?? id, model, status: response.status, durationMs: latencyMs })
        if (response.ok) await health.success(candidate, model, latencyMs); else await health.failure(candidate, model, `http-${response.status}`); record({ providerId: id, model, operation: "health-probe", result: response.ok ? "success" : "failure", latencyMs, switched: false }); return json(res, response.ok ? 200 : 502, { providerId: id, model, result: response.ok ? "success" : "failure", latencyMs })
      }
      if (req.method === "POST" && req.url === "/admin/health/reset") { await health.reset(); return json(res, 200, { ok: true }) }
      if (req.method === "DELETE" && req.url === "/admin/records") { records.length = 0; return json(res, 200, { ok: true }) }
      if (req.url.startsWith("/admin/providers/") && req.method === "DELETE") {
         const id = decodeURIComponent(req.url.slice("/admin/providers/".length)); config.candidates = config.candidates.filter((item) => item.id !== id); modelCache.delete(id); await health.removeProvider(id)
        await saveConfig(config.configFile, config); return json(res, 200, { ok: true })
      }
      if (req.url.startsWith("/admin/providers/") && req.method === "PUT") {
        const id = decodeURIComponent(req.url.slice("/admin/providers/".length)); const item = await body(req); const old = config.candidates.find((candidate) => candidate.id === id)
        if (!old) throw Object.assign(new Error("Unknown provider"), { status: 404 })
         const next = validateConfig({ ...config, candidates: config.candidates.map((candidate) => candidate.id === id ? { ...item, id, apiKey: item.apiKey || old.apiKey } : candidate) })
        config.candidates = next.candidates; await saveConfig(config.configFile, config); return json(res, 200, { ok: true })
      }
       if (req.method === "POST" && req.url === "/admin/providers") {
         const item = await body(req); const next = validateConfig({ ...config, candidates: [...config.candidates, item] }); config.candidates = next.candidates; await saveConfig(config.configFile, config); return json(res, 201, { ok: true })
       }
       if (req.method === "GET" && new URL(req.url, "http://localhost").pathname === "/v1/models") {
         if (config.token && req.headers.authorization !== `Bearer ${config.token}`) return json(res, 401, { error: "Unauthorized" })
         const models = new Map(); const errors = []
         for (const candidate of config.candidates) {
           const cached = modelCache.get(candidate.id)
           try {
             const items = cached?.models ?? await listModels(candidate, await providerKey(candidate))
              if (!cached) modelCache.set(candidate.id, { provider: candidate.id, models: items, refreshedAt: now(), error: null })
             for (const model of items) if (!models.has(model.id)) models.set(model.id, { ...model, object: "model" })
           } catch (error) { errors.push({ providerId: candidate.id, error: error.message }) }
         }
         return json(res, models.size || !errors.length ? 200 : 502, { object: "list", data: [...models.values()], ...(errors.length ? { errors } : {}) })
       }
       if (req.method !== "POST" || req.url !== "/v1/chat/completions") return json(res, 404, { error: "Not found" })
      if (config.token && req.headers.authorization !== `Bearer ${config.token}`) return json(res, 401, { error: "Unauthorized" })
      if (!config.candidates.length) return json(res, 503, { error: "Gateway is not configured. Open / and add an API candidate." })
       const input = await body(req)
       trafficLog(downstreamLogs, { direction: "downstream", type: "request", requestId: id, method: req.method, path: req.url, headers: headersForLog(req.headers), body: preview(input) })
       health.touch()
      stats.requests++
       if (!Array.isArray(input.messages)) {
          log(`[gateway] REQUEST REJECTED request=${id} reason=messages-not-array`)
         return json(res, 400, { error: "messages must be an array" })
       }
      const stream = input.stream === true
      let output = false
       requestedModel = input.model
        const eligible = config.candidates.filter((candidate) => {
          const entry = health.get(candidate, candidate.model ?? requestedModel)
          if (!entry || entry.status === "unsupported") return !entry
          if (entry.nextProbeAt && entry.nextProbeAt > Date.now()) return false
          if (entry.status === "cooldown") {
            const model = candidate.model ?? requestedModel ?? entry.model
            if (!health.claimHalfOpen(candidate, model)) return false
            halfOpen.add(candidate.id)
          }
          return true
       })
       if (!eligible.length) {
          log(`[gateway] ROUTE BLOCKED request=${id} reason=no-eligible-provider model=${requestedModel ?? "(none)"}`)
         return json(res, 503, { error: "No eligible provider is available" })
       }
        log(`[gateway] ROUTE selected=${eligible.map((candidate) => candidate.name ?? candidate.id).join(",")} attempts=${Math.min(config.maxAttempts, eligible.length)}`)
       const result = await attempt(eligible, config.maxAttempts, config.requestTimeoutMs, async (candidate, signal) => {
          const model = candidate.model ?? requestedModel
         if (model) recentRequestModels.set(candidate.id, model)
        const started = Date.now()
        const account = { credential: { key: await providerKey(candidate) } }
         const request = { ...input, model }
          trafficLog(upstreamLogs, { direction: "upstream", type: "request", requestId: id, providerId: candidate.id, providerName: candidate.name ?? candidate.id, model, method: "POST", path: `${candidate.baseUrl}/chat/completions`, headers: { accept: headers(account.credential.key, request).accept, "content-type": "application/json" }, body: preview(request) })
         const upstreamStarted = Date.now()
         const upstream = await fetch(`${candidate.baseUrl}/chat/completions`, {
          method: "POST", headers: headers(account.credential.key, request), body: JSON.stringify(request), signal,
         })
          trafficLog(upstreamLogs, { direction: "upstream", type: "response", requestId: id, providerId: candidate.id, providerName: candidate.name ?? candidate.id, model, status: upstream.status, headers: headersForLog(Object.fromEntries(upstream.headers)), durationMs: Date.now() - upstreamStarted })
        if (!upstream.ok && !isRetryable(upstream.status)) {
          const error = Object.assign(new Error(`Upstream rejected request (${upstream.status})`), { status: upstream.status, nonRetry: true })
          throw error
        }
          if (!upstream.ok) { await health.failure(candidate, model, `http-${upstream.status}`); return upstream }
          await health.success(candidate, model, Date.now() - started)
         if (!stream) { upstream.gatewayBody = Buffer.from(await upstream.arrayBuffer()); return upstream }
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" })
        try {
          for await (const chunk of upstream.body) {
            output = true
            res.write(chunk)
          }
        } catch (error) {
          if (output) error.nonRetry = true
          throw error
        }
        res.end()
         return { ok: true, status: 200 }
       })
       for (const candidate of eligible) if (halfOpen.has(candidate.id)) health.release(candidate, candidate.model ?? requestedModel)
      if (result.errors.length) { stats.failures += result.errors.length; stats.retries += result.errors.length; record({ type: "fallback", request: id, selected: result.candidate.id, errors: result.errors }) }
      else record({ type: "success", request: id, selected: result.candidate.id })
        if (!stream && result.result.ok) {
          const responseBody = result.result.gatewayBody
         res.writeHead(result.result.status, { "content-type": "application/json" })
         res.end(responseBody)
         trafficLog(downstreamLogs, { direction: "downstream", type: "response", requestId: id, status: result.result.status, headers: { "content-type": "application/json" }, body: preview(responseBody.toString("utf8")) })
      }
      if (stream && !output && !res.writableEnded) json(res, 502, { error: "No stream output" })
     } catch (error) {
       for (const candidate of config.candidates) if (halfOpen.has(candidate.id)) health.release(candidate, candidate.model ?? requestedModel ?? health.latest(candidate)?.model)
       stats.failures++
        log(`[gateway] ERROR request=${id} status=${error.status ?? 502} message=${error.message}`)
      record({ type: "error", request: id, error: error.message, attempts: error.attempts ?? [] })
      if (res.headersSent) return res.destroy()
      json(res, error.status ?? 502, clean(error))
    }
  })
  return { server, records, downstreamLogs, upstreamLogs, stats, health, start: async () => { await health.load(); return new Promise((resolve, reject) => { server.once("error", reject); server.listen(config.port, config.host, () => { server.off("error", reject); resolve() }) }) }, stop: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) }
}
