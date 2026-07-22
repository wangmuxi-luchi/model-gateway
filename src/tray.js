import { randomBytes } from "node:crypto"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { appendFileSync, mkdirSync, readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { now } from "./time.js"

const runtimeDir = process.isSea ? dirname(process.execPath) : process.cwd()
const exe = join(runtimeDir, "model-gateway.exe")
const token = randomBytes(24).toString("hex")
const configFile = process.env.MODEL_GATEWAY_CONFIG || join(runtimeDir, "model-gateway.json")
let listen = "127.0.0.1:8787"
try { listen = JSON.parse(readFileSync(configFile, "utf8")).listen || listen } catch {}
const base = process.env.MODEL_GATEWAY_URL || `http://${listen}`
const portableDir = runtimeDir
const dataDir = join(portableDir, "data")
const debugFile = join(dataDir, "tray-debug.log")
mkdirSync(dataDir, { recursive: true })
const debug = (message) => { try { appendFileSync(debugFile, `${now()} ${message}\n`) } catch {} }
const psQuote = (value) => `'${String(value).replaceAll("'", "''")}'`
const pageUrl = `${base}/`
const logsDir = join(dataDir, "logs")
const ps = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $n=New-Object Windows.Forms.NotifyIcon; $n.Icon=[Drawing.SystemIcons]::Application; $n.Visible=$true; $m=New-Object Windows.Forms.ContextMenuStrip; $items=@{}; foreach($x in @('打开管理页面','查看状态','打开日志目录','退出')) { $items[$x]=$m.Items.Add($x) }; $n.ContextMenuStrip=$m; $items['打开管理页面'].add_Click({ try { Start-Process ${psQuote(pageUrl)}; [Console]::WriteLine('MENU open-page ok') } catch { [Console]::WriteLine(('MENU open-page error '+$_.Exception.Message)) } }); $items['查看状态'].add_Click({ try { $r=Invoke-RestMethod ${psQuote(`${base}/health`)}; [Console]::WriteLine(('MENU status ok '+$r.status)); [Windows.Forms.MessageBox]::Show(('网关状态：'+$r.status+'\n请求数：'+$r.requests+'\n失败数：'+$r.failures),'Model Gateway') } catch { [Console]::WriteLine(('MENU status error '+$_.Exception.Message)); [Windows.Forms.MessageBox]::Show('网关未运行','Model Gateway') } }); $items['打开日志目录'].add_Click({ try { Start-Process explorer.exe ${psQuote(logsDir)}; [Console]::WriteLine('MENU open-logs ok') } catch { [Console]::WriteLine(('MENU open-logs error '+$_.Exception.Message)) } }); $items['退出'].add_Click({ try { Invoke-WebRequest ${psQuote(`${base}/__control/shutdown`)} -Method Post -Headers @{'x-model-gateway-control'=${psQuote(token)}} -UseBasicParsing | Out-Null; [Console]::WriteLine('MENU exit shutdown-ok') } catch { [Console]::WriteLine(('MENU exit shutdown-error '+$_.Exception.Message)) }; $n.Visible=$false; $n.Dispose(); [Windows.Forms.Application]::Exit() }); [Console]::WriteLine('TRAY_READY'); [Windows.Forms.Application]::Run()`
if (!existsSync(exe)) throw new Error(`Missing ${exe}`)
debug(`START exe=${exe} base=${base} dataDir=${dataDir} debugFile=${debugFile}`)
const child = spawn(exe, ["start"], { env: { ...process.env, MODEL_GATEWAY_CONTROL_TOKEN: token }, stdio: "ignore", windowsHide: true })
child.on("error", (error) => debug(`GATEWAY error=${error.stack || error.message}`))
child.on("spawn", () => debug(`GATEWAY spawned pid=${child.pid}`))
child.on("exit", (code, signal) => debug(`GATEWAY exit code=${code} signal=${signal}`))
const ui = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-WindowStyle", "Hidden", "-Command", ps], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
ui.stdout.on("data", (data) => debug(`POWERSHELL stdout=${String(data).trim()}`))
ui.stderr.on("data", (data) => debug(`POWERSHELL stderr=${String(data).trim()}`))
ui.on("error", (error) => debug(`POWERSHELL error=${error.stack || error.message}`))
ui.on("spawn", () => debug(`POWERSHELL spawned pid=${ui.pid}`))
ui.on("exit", (code, signal) => debug(`POWERSHELL exit code=${code} signal=${signal}`))
setTimeout(() => { debug("AUTO_OPEN start"); const opener = spawn("explorer.exe", [pageUrl], { stdio: "ignore", windowsHide: true }); opener.on("error", (error) => debug(`AUTO_OPEN error=${error.message}`)); opener.on("exit", (code) => debug(`AUTO_OPEN exit code=${code}`)) }, 1500)
