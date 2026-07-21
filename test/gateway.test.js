import { afterEach, test } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { validateConfig } from "../src/config.js"
import { createGateway } from "../src/server.js"

const servers = []
afterEach(async () => { for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve)) })

const upstream = (handler) => new Promise((resolve) => {
  const server = createServer(handler)
  servers.push(server)
  server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}/v1`))
})

const gateway = async (baseUrl, dataDir, extra = {}) => {
  const config = validateConfig({ listen: "127.0.0.1:0", dataDir, candidates: [{ id: "one", apiKey: "secret", baseUrl, model: "chosen", priority: 1, timeoutMs: 1000 }, ...(extra.candidates ?? [])] })
  config.port = Number(config.port) || 0
  const app = createGateway(config)
  await app.start()
  const port = app.server.address().port
  return { app, url: `http://127.0.0.1:${port}` }
}

test("falls through 503 and injects selected key and model", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gateway-"))
  let calls = 0
  const first = await upstream((_req, res) => { calls++; res.writeHead(503); res.end("busy") })
  const second = await upstream(async (req, res) => {
    let raw = ""
    for await (const chunk of req) raw += chunk
    assert.equal(req.headers.authorization, "Bearer secret")
    assert.equal(JSON.parse(raw).model, "backup")
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ id: "ok", choices: [{ message: { content: "done" } }] }))
  })
  const app = await gateway(first, dir, { candidates: [{ id: "two", apiKey: "secret", baseUrl: second, model: "backup", priority: 2, timeoutMs: 1000 }] })
  const response = await fetch(`${app.url}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }) })
  assert.equal(response.status, 200)
  assert.equal(calls, 1)
  assert.equal((await response.json()).id, "ok")
  await app.app.stop()
})

test("does not fail over after SSE output begins", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gateway-"))
  const first = await upstream((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.write("data: first\n\n")
    setTimeout(() => res.destroy(), 10)
  })
  let backupCalls = 0
  const second = await upstream((_req, res) => { backupCalls++; res.end("unexpected") })
  const app = await gateway(first, dir, { candidates: [{ id: "two", apiKey: "secret", baseUrl: second, model: "backup", priority: 2, timeoutMs: 1000 }] })
  const response = await fetch(`${app.url}/v1/chat/completions`, { method: "POST", body: JSON.stringify({ stream: true, messages: [] }) })
  assert.equal(response.status, 200)
  await response.text().catch(() => {})
  assert.equal(backupCalls, 0)
  await app.app.stop()
})

test("does not fail over non-retryable upstream errors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gateway-"))
  let backupCalls = 0
  const first = await upstream((_req, res) => { res.writeHead(400); res.end(JSON.stringify({ error: "bad request" })) })
  const second = await upstream((_req, res) => { backupCalls++; res.end("unexpected") })
  const app = await gateway(first, dir, { candidates: [{ id: "two", apiKey: "secret", baseUrl: second, model: "backup", priority: 2, timeoutMs: 1000 }] })
  const response = await fetch(`${app.url}/v1/chat/completions`, { method: "POST", body: JSON.stringify({ messages: [] }) })
  assert.equal(response.status, 400)
  assert.equal(backupCalls, 0)
  await app.app.stop()
})

test("falls through an upstream timeout without exposing it to the client", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gateway-"))
  const slow = await upstream((_req, res) => res.destroy())
  const fast = await upstream((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ id: "recovered", choices: [] }))
  })
  const config = validateConfig({
    listen: "127.0.0.1:0",
    dataDir: dir,
    requestTimeoutMs: 1000,
    candidates: [
      { id: "one", apiKey: "secret", baseUrl: slow, model: "chosen", priority: 1 },
      { id: "two", apiKey: "secret", baseUrl: fast, model: "backup", priority: 2, timeoutMs: 1000 },
    ],
  })
  const recovered = createGateway(config)
  await recovered.start()
  const response = await fetch(`http://127.0.0.1:${recovered.server.address().port}/v1/chat/completions`, {
    method: "POST", body: JSON.stringify({ messages: [] }),
  })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).id, "recovered")
  await recovered.stop()
})

test("serves the management UI and redacts provider keys", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gateway-"))
  const upstreamUrl = await upstream((_req, res) => res.end("ok"))
  const config = validateConfig({ listen: "127.0.0.1:0", dataDir: dir, candidates: [{ id: "one", apiKey: "do-not-return", baseUrl: upstreamUrl, model: "test" }] })
  const app = createGateway(config)
  await app.start()
  const root = `http://127.0.0.1:${app.server.address().port}`
  assert.equal((await fetch(root)).status, 200)
  const response = await fetch(`${root}/admin/providers`)
  assert.equal(response.status, 200)
  assert.doesNotMatch(await response.text(), /do-not-return/)
  await app.stop()
})

test("allows first start with empty config and adds candidates from UI API", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gateway-"))
  const config = validateConfig({ listen: "127.0.0.1:0", dataDir: dir, candidates: [] }, { allowEmpty: true })
  config.configFile = join(dir, "model-gateway.json")
  const app = createGateway(config)
  await app.start()
  const root = `http://127.0.0.1:${app.server.address().port}`
  assert.equal((await fetch(`${root}/v1/chat/completions`, { method: "POST", body: "{}" })).status, 503)
  const upstreamUrl = await upstream((_req, res) => res.end("ok"))
  const response = await fetch(`${root}/admin/providers`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "one", baseUrl: upstreamUrl, model: "test" }) })
  assert.equal(response.status, 201)
  assert.equal((await app.records).length, 0)
  await app.stop()
})

test("manages a provider as one URL and key entry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gateway-"))
  const config = validateConfig({ listen: "127.0.0.1:0", dataDir: dir, candidates: [] }, { allowEmpty: true })
  config.configFile = join(dir, "model-gateway.json")
  const app = createGateway(config); await app.start()
  const root = `http://127.0.0.1:${app.server.address().port}`
  let response = await fetch(`${root}/admin/providers`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "one", name: "Primary", baseUrl: "http://127.0.0.1:1", apiKey: "secret" }) })
  assert.equal(response.status, 201)
  response = await fetch(`${root}/admin/providers`); const providers = await response.json()
  assert.equal(providers[0].name, "Primary"); assert.equal(providers[0].hasApiKey, true); assert.doesNotMatch(JSON.stringify(providers), /secret/)
  response = await fetch(`${root}/admin/providers/one`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Renamed", baseUrl: "http://127.0.0.1:2" }) })
  assert.equal(response.status, 200)
  const saved = JSON.parse(await readFile(join(dir, "model-gateway.json")))
  assert.equal(saved.candidates[0].apiKey, "secret"); assert.equal(saved.candidates[0].name, "Renamed")
  await app.stop()
})

test("lists models through a provider URL without exposing its key", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gateway-")); let auth
  const baseUrl = await upstream((req, res) => { auth = req.headers.authorization; res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ data: [{ id: "model-a" }] })) })
  const config = validateConfig({ listen: "127.0.0.1:0", dataDir: dir, candidates: [{ id: "one", baseUrl, apiKey: "secret" }] })
  const app = createGateway(config); await app.start(); const root = `http://127.0.0.1:${app.server.address().port}`
  const response = await fetch(`${root}/admin/providers/one/models?refresh=1`); assert.equal(response.status, 200); assert.deepEqual((await response.json()).models.map((x) => x.id), ["model-a"]); assert.equal(auth, "Bearer secret")
  const list = await (await fetch(`${root}/admin/providers`)).text(); assert.doesNotMatch(list, /secret/); await app.stop()
})

test("exposes redacted downstream and upstream traffic logs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gateway-"))
  const baseUrl = await upstream((req, res) => { res.writeHead(200, { "content-type": "application/json", "x-upstream": "yes" }); res.end(JSON.stringify({ ok: true })) })
  const config = validateConfig({ listen: "127.0.0.1:0", dataDir: dir, candidates: [{ id: "one", baseUrl, apiKey: "secret" }] })
  const app = createGateway(config); await app.start(); const root = `http://127.0.0.1:${app.server.address().port}`
  const response = await fetch(`${root}/v1/chat/completions`, { method: "POST", headers: { authorization: "Bearer client", "content-type": "application/json" }, body: JSON.stringify({ model: "test", messages: [] }) })
  assert.equal(response.status, 200)
  const logs = await (await fetch(`${root}/admin/logs`)).json()
  assert.ok(logs.downstream.some((item) => item.type === "request" && item.path === "/v1/chat/completions"))
  assert.ok(logs.upstream.some((item) => item.type === "request" && item.providerId === "one"))
  assert.doesNotMatch(JSON.stringify(logs), /secret|Bearer client/)
  await app.stop()
})

test("probes the most recently requested model before the models-list first item", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gateway-")); const probed = []
  const baseUrl = await upstream(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk
    if (req.url === "/v1/models") return res.end(JSON.stringify({ data: [{ id: "listed-first" }, { id: "requested-model" }] }))
    if (req.url === "/v1/chat/completions") probed.push(JSON.parse(raw).model); res.end(JSON.stringify({ ok: true }))
  })
  const config = validateConfig({ listen: "127.0.0.1:0", dataDir: dir, candidates: [{ id: "one", baseUrl, apiKey: "secret" }] })
  const app = createGateway(config); await app.start(); const root = `http://127.0.0.1:${app.server.address().port}`
  await fetch(`${root}/v1/chat/completions`, { method: "POST", body: JSON.stringify({ model: "requested-model", messages: [] }) })
  const response = await fetch(`${root}/admin/providers/one/probe`, { method: "POST" })
  assert.equal(response.status, 200); assert.equal(probed.at(-1), "requested-model")
  await app.stop()
})

test("aggregates downstream models from cached and uncached providers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gateway-")); let modelCalls = 0
  const first = await upstream((req, res) => { if (req.url === "/v1/models") modelCalls++; res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ data: [{ id: "shared" }, { id: "first-only" }] })) })
  const second = await upstream((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ data: [{ id: "shared" }, { id: "second-only" }] })) })
  const config = validateConfig({ listen: "127.0.0.1:0", dataDir: dir, candidates: [{ id: "one", baseUrl: first }, { id: "two", baseUrl: second }] })
  const app = createGateway(config); await app.start(); const root = `http://127.0.0.1:${app.server.address().port}`
  const response = await fetch(`${root}/v1/models`); assert.equal(response.status, 200); assert.deepEqual((await response.json()).data.map((item) => item.id), ["shared", "first-only", "second-only"])
  await fetch(`${root}/v1/models`); assert.equal(modelCalls, 1); await app.stop()
})
