import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"

export class HealthStore {
  constructor(dir, config) { this.file = join(dir, "health.json"); this.dir = dir; this.config = config; this.entries = new Map(); this.lastActivity = 0 }
  async load() {
    try {
      const data = JSON.parse(await readFile(this.file, "utf8"))
      for (const [key, value] of Object.entries(data.entries ?? {})) if (Date.now() - value.updatedAt <= this.config.healthStateMaxAgeMs) this.entries.set(key, value)
    } catch (error) { if (error.code !== "ENOENT") throw error }
  }
  key(candidate, model) { return `${candidate.id}\u0000${candidate.baseUrl}\u0000${model}` }
  get(candidate, model) { return this.entries.get(this.key(candidate, model)) }
  latest(candidate) {
    return [...this.entries.values()]
      .filter((value) => value.candidateId === candidate.id)
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0]
  }
  touch() { this.lastActivity = Date.now() }
  snapshot() { return [...this.entries].map(([key, value]) => ({ key, ...value, inFlight: value.inFlight ?? 0 })) }
  async save() {
    await mkdir(this.dir, { recursive: true }); const temp = `${this.file}.${process.pid}.tmp`
    await writeFile(temp, JSON.stringify({ version: 1, entries: Object.fromEntries(this.entries) }) + "\n", { mode: 0o600 }); await rename(temp, this.file)
  }
  async success(candidate, model, latencyMs) { const key = this.key(candidate, model); const old = this.get(candidate, model) ?? {}; this.entries.set(key, { ...old, model, candidateId: candidate.id, status: "healthy", consecutiveFailures: 0, lastErrorCategory: undefined, lastLatencyMs: latencyMs, updatedAt: Date.now(), nextProbeAt: 0, inFlight: old.inFlight ?? 0 }); await this.save() }
  async failure(candidate, model, category, retryAfter = 0) { const key = this.key(candidate, model); const old = this.get(candidate, model) ?? {}; const failures = (old.consecutiveFailures ?? 0) + 1; const h = this.config.health; const cooldown = failures >= h.cooldownAfter ? Math.min(h.maxBackoffMs, Math.max(30000, 30000 * 4 ** (failures - h.cooldownAfter))) : 0; this.entries.set(key, { ...old, model, candidateId: candidate.id, status: cooldown ? "cooldown" : "degraded", consecutiveFailures: failures, lastErrorCategory: category, updatedAt: Date.now(), nextProbeAt: cooldown ? Date.now() + Math.max(cooldown, retryAfter) : 0, inFlight: old.inFlight ?? 0 }); await this.save() }
  async reset(key) { if (key) this.entries.delete(key); else this.entries.clear(); await this.save() }
  async removeProvider(id) {
    for (const [key, value] of this.entries) if (value.candidateId === id) this.entries.delete(key)
    await this.save()
  }
}
