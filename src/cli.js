import { loadConfig } from "./config.js"
import { createGateway } from "./server.js"

const file = process.env.MODEL_GATEWAY_CONFIG ?? "model-gateway.json"
const cfg = await loadConfig(file, { allowEmpty: true })
cfg.configFile = file
const [command] = process.argv.slice(2)

if (command === "start") {
  const gateway = createGateway(cfg)
  await gateway.start()
  console.log(`model gateway listening on http://${cfg.host}:${cfg.port}`)
} else throw new Error("Usage: start")
