import { copyFile, mkdir, rm, writeFile } from "node:fs/promises"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"
import process from "node:process"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const outDir = join(root, "dist")
const bundle = join(outDir, "model-gateway.cjs")
const blob = join(outDir, "sea-prep.blob")
const exe = join(outDir, "model-gateway.exe")
const trayExe = join(outDir, "model-gateway-tray.exe")
const config = join(outDir, "sea-config.json")
const fuse = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"
const run = (command, args) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd: root, stdio: "inherit", shell: command.endsWith(".cmd") })
  child.on("error", reject); child.on("exit", (code) => code ? reject(new Error(`${command} exited with ${code}`)) : resolve())
})
const subsystem = (file) => { const bytes = readFileSync(file); const pe = bytes.readUInt32LE(0x3c); return bytes.readUInt16LE(pe + 0x5c) }

try {
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("build:win must run on Windows x64")
  await rm(outDir, { recursive: true, force: true }); await mkdir(outDir, { recursive: true })
  await run(join(root, "node_modules", ".bin", "esbuild.cmd"), ["src/cli.js", "--bundle", "--platform=node", "--format=cjs", `--outfile=${bundle}`])
  await writeFile(config, JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true, windowsSubsystem: "console", useSnapshot: false, useCodeCache: false }, null, 2))
  await run(process.execPath, ["--experimental-sea-config", config]); await copyFile(process.execPath, exe)
  await run(join(root, "node_modules", ".bin", "postject.cmd"), [exe, "NODE_SEA_BLOB", blob, "--sentinel-fuse", fuse])
  await run("dotnet", ["publish", join(root, "native", "TrayHelper", "TrayHelper.csproj"), "-c", "Release", "-r", "win-x64", "--self-contained", "true", "-p:PublishSingleFile=true", "-o", outDir])
  const gatewaySubsystem = subsystem(exe); const traySubsystem = subsystem(trayExe)
  if (gatewaySubsystem !== 3 || traySubsystem !== 2) throw new Error(`Unexpected PE subsystem: gateway=${gatewaySubsystem} tray=${traySubsystem}`)
  await rm(bundle, { force: true }); await rm(blob, { force: true }); await rm(config, { force: true }); await rm(join(outDir, "model-gateway-tray.pdb"), { force: true })
  console.log(`Built ${exe} and ${trayExe}`)
} catch (error) { console.error(error.stack || error.message); process.exitCode = 1 }
