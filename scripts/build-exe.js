import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"
import process from "node:process"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const outDir = join(root, "dist")
const bundle = join(outDir, "model-gateway.cjs")
const blob = join(outDir, "sea-prep.blob")
const exe = join(outDir, "model-gateway.exe")
const trayBundle = join(outDir, "model-gateway-tray.cjs")
const trayBlob = join(outDir, "tray-prep.blob")
const trayExe = join(outDir, "model-gateway-tray.exe")
const config = join(outDir, "sea-config.json")
const run = (command, args) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd: root, stdio: "inherit", shell: command.endsWith(".cmd") })
  child.on("error", reject); child.on("exit", (code) => code ? reject(new Error(`${command} exited with ${code}`)) : resolve())
})

try {
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("build:win must run on Windows x64")
  await rm(outDir, { recursive: true, force: true }); await mkdir(outDir, { recursive: true })
  await run(join(root, "node_modules", ".bin", "esbuild.cmd"), ["src/cli.js", "--bundle", "--platform=node", "--format=cjs", `--outfile=${bundle}`])
  await writeFile(config, JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true, windowsSubsystem: "console", useSnapshot: false, useCodeCache: false }, null, 2))
  await run(process.execPath, ["--experimental-sea-config", config])
  await copyFile(process.execPath, exe)
  await run(join(root, "node_modules", ".bin", "postject.cmd"), [exe, "NODE_SEA_BLOB", blob, "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"])
  await run(join(root, "node_modules", ".bin", "esbuild.cmd"), ["src/tray.js", "--bundle", "--platform=node", "--format=cjs", `--outfile=${trayBundle}`])
  await writeFile(config, JSON.stringify({ main: trayBundle, output: trayBlob, disableExperimentalSEAWarning: true, windowsSubsystem: "windows", useSnapshot: false, useCodeCache: false }, null, 2))
  await run(process.execPath, ["--experimental-sea-config", config]); await copyFile(process.execPath, trayExe)
  await run(join(root, "node_modules", ".bin", "postject.cmd"), [trayExe, "NODE_SEA_BLOB", trayBlob, "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"])
  await rm(bundle, { force: true }); await rm(blob, { force: true }); await rm(trayBundle, { force: true }); await rm(trayBlob, { force: true }); await rm(config, { force: true })
  console.log(`Built ${exe} and ${trayExe}`)
} catch (error) {
  console.error(error.stack || error.message); process.exitCode = 1
}
