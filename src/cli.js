import { loadConfig } from "./config.js"
import { createGateway } from "./server.js"
import { dirname, join } from "node:path"
import { now } from "./time.js"

async function main() {
  const portableDir = process.isSea ? dirname(process.execPath) : process.cwd()
  const file = process.env.MODEL_GATEWAY_CONFIG ?? join(portableDir, "model-gateway.json")
  const cfg = await loadConfig(file, { allowEmpty: true, baseDir: portableDir, defaultDataDir: join(portableDir, "data") })
  cfg.configFile = file
  const [command = "start"] = process.argv.slice(2)

  if (command === "start") {
    const gateway = createGateway(cfg)
    await gateway.start()
    const address = gateway.server.address()
    console.log(`${now()} model gateway listening on http://${address.address}:${address.port}`)
    await new Promise((resolve) => gateway.server.once("close", resolve))
  } else throw new Error("Usage: start")
}

main().catch((error) => {
  console.error(error.stack || error.message)
  process.exitCode = 1
})
