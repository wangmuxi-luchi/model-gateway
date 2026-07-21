import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"

const pathOf = (value) => {
  if (value.startsWith("~/")) return join(homedir(), value.slice(2))
  return isAbsolute(value) ? value : resolve(value)
}

export function validateConfig(input, options = {}) {
  if (!input || typeof input !== "object") throw new Error("Gateway config must be an object")
  const listen = typeof input.listen === "string" ? input.listen : "127.0.0.1:8787"
  const [host, portText] = listen.split(":")
  const port = Number(portText)
  if (!host || !Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid listen address")
  const candidates = Array.isArray(input.candidates) ? input.candidates : []
  if (!candidates.length && !options.allowEmpty) throw new Error("At least one candidate is required")
  const seen = new Set()
  const normalized = candidates.map((item, index) => {
    if (!item || typeof item !== "object") throw new Error(`Invalid candidate at index ${index}`)
    if (typeof item.id !== "string" || !item.id || seen.has(item.id)) throw new Error(`Invalid or duplicate candidate id at index ${index}`)
    seen.add(item.id)
    if (Object.hasOwn(item, "service")) throw new Error(`Unknown legacy field service for ${item.id}`)
    if (typeof item.baseUrl !== "string") throw new Error(`Candidate ${item.id} needs baseUrl`)
    const url = new URL(item.baseUrl)
    if (!["http:", "https:"].includes(url.protocol)) throw new Error(`Candidate ${item.id} needs http(s) baseUrl`)
    if (item.model !== undefined && item.model !== "" && (typeof item.model !== "string" || !item.model)) throw new Error(`Invalid model for candidate ${item.id}`)
    const priority = item.priority === undefined || item.priority === "" ? 100 : item.priority
    if (!Number.isInteger(priority) || priority < 0) throw new Error(`Invalid priority for candidate ${item.id}`)
    return { ...item, baseUrl: item.baseUrl.replace(/\/$/, ""), priority, order: index }
  }).sort((a, b) => a.priority - b.priority || a.order - b.order)
  return {
    host,
    port,
    dataDir: pathOf(typeof input.dataDir === "string" ? input.dataDir : "~/.local/share/model-gateway"),
    maxAttempts: Number.isInteger(input.maxAttempts) && input.maxAttempts > 0 ? input.maxAttempts : normalized.length,
    requestTimeoutMs: Number.isInteger(input.requestTimeoutMs) && input.requestTimeoutMs > 0 ? input.requestTimeoutMs : 60000,
     token: typeof input.token === "string" ? input.token : undefined,
     activeWindowMs: Number.isInteger(input.activeWindowMs) && input.activeWindowMs > 0 ? input.activeWindowMs : 300000,
     queueTimeoutMs: Number.isInteger(input.queueTimeoutMs) && input.queueTimeoutMs >= 0 ? input.queueTimeoutMs : 2000,
     healthStateMaxAgeMs: Number.isInteger(input.healthStateMaxAgeMs) && input.healthStateMaxAgeMs > 0 ? input.healthStateMaxAgeMs : 7200000,
     health: { degradedAfter: 1, cooldownAfter: 2, maxBackoffMs: 7200000, ...(input.health ?? {}) },
    candidates: normalized,
  }
}

export async function loadConfig(file, options = {}) {
  try { return validateConfig(JSON.parse(await readFile(file, "utf8")), options) }
  catch (error) {
    if (error.code !== "ENOENT" || !options.allowEmpty) throw error
    return validateConfig({ listen: "127.0.0.1:8787", dataDir: "~/.local/share/model-gateway", candidates: [] }, options)
  }
}

export async function saveConfig(file, config) {
  if (!file) throw new Error("Gateway config file is not configured")
  await mkdir(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  const output = {
    listen: `${config.host}:${config.port}`,
    dataDir: config.dataDir,
    maxAttempts: config.maxAttempts,
    requestTimeoutMs: config.requestTimeoutMs,
    activeWindowMs: config.activeWindowMs,
    queueTimeoutMs: config.queueTimeoutMs,
    healthStateMaxAgeMs: config.healthStateMaxAgeMs,
    health: config.health,
    ...(config.token ? { token: config.token } : {}),
    candidates: config.candidates.map(({ order, ...item }) => item),
  }
  await writeFile(temp, JSON.stringify(output, null, 2) + "\n")
  await rename(temp, file)
}
