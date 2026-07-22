using System.Diagnostics;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text.Json;
using System;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using System.Drawing;

internal static class Program
{
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(3) };
    private static readonly string Root = AppContext.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
    private static string BaseUrl = "http://127.0.0.1:8787";
    private static readonly string Token = Convert.ToHexString(RandomNumberGenerator.GetBytes(24)).ToLowerInvariant();
    private static string LogFile => Path.Combine(Root, "data", "tray-debug.log");
    private static Process? Gateway;
    private static NotifyIcon? Icon;

    [STAThread]
    private static void Main()
    {
        Directory.CreateDirectory(Path.Combine(Root, "data"));
        Log($"START trayPid={Environment.ProcessId} tokenLength={Token.Length} root={Root}");
        var configFile = Environment.GetEnvironmentVariable("MODEL_GATEWAY_CONFIG") ?? Path.Combine(Root, "model-gateway.json");
        try
        {
            if (File.Exists(configFile))
            {
                using var json = JsonDocument.Parse(File.ReadAllText(configFile));
                if (json.RootElement.TryGetProperty("listen", out var listen)) BaseUrl = "http://" + listen.GetString();
            }
            Log("CONFIG base=" + BaseUrl);
        }
        catch (Exception ex) { Log("CONFIG error=" + ex.Message); }
        var exe = Path.Combine(Root, "model-gateway.exe");
        if (!File.Exists(exe)) { Log("GATEWAY missing=" + exe); MessageBox.Show("找不到 model-gateway.exe", "Model Gateway"); return; }
        LogPortUsage("before-spawn");
        try
        {
            var start = new ProcessStartInfo(exe, "start") { WorkingDirectory = Root, UseShellExecute = false, CreateNoWindow = true };
            start.Environment["MODEL_GATEWAY_CONTROL_TOKEN"] = Token;
            Gateway = Process.Start(start);
            if (Gateway == null) throw new InvalidOperationException("Process.Start returned null");
            Gateway.Exited += (_, _) => Log($"GATEWAY exit code={Gateway.ExitCode}"); Gateway.EnableRaisingEvents = true;
            Log("GATEWAY spawned pid=" + Gateway.Id);
            LogPortUsage("after-spawn");
        }
        catch (Exception ex) { Log("GATEWAY error=" + ex); MessageBox.Show(ex.Message, "Model Gateway"); return; }
        if (!WaitReady())
        {
            Log("READY failed; tray will not attach to an unrelated gateway");
            MessageBox.Show("网关未能在规定时间内启动，可能已有其他网关实例占用端口。请查看 data\\tray-debug.log。", "Model Gateway");
            Icon?.Dispose();
            return;
        }
        Icon = new NotifyIcon { Icon = LoadTrayIcon(), Visible = true, Text = "Model Gateway" };
        var menu = new ContextMenuStrip();
        menu.Items.Add("打开管理页面", null, (_, _) => Open(BaseUrl + "/"));
        menu.Items.Add("查看状态", null, (_, _) => Status());
        menu.Items.Add("打开日志目录", null, (_, _) => Open(Path.Combine(Root, "data", "logs")));
        menu.Items.Add("退出", null, async (_, _) => await ShutdownAsync());
        Icon.ContextMenuStrip = menu;
        Application.Run();
    }

    private static bool WaitReady()
    {
        for (var i = 1; i <= 30; i++)
        {
            if (Gateway?.HasExited == true) { Log($"READY child-exited code={Gateway.ExitCode}"); LogPortUsage("child-exited"); return false; }
            try
            {
                using var request = new HttpRequestMessage(HttpMethod.Get, BaseUrl + "/__control/health");
                request.Headers.Add("x-model-gateway-control", Token);
                using var response = Http.Send(request);
                if (response.IsSuccessStatusCode) { Log("READY attempt=" + i); Open(BaseUrl + "/"); return true; }
                Log($"READY attempt={i} status={(int)response.StatusCode}");
            }
            catch (Exception ex) { Log($"READY attempt={i} error={ex.Message}"); }
            Thread.Sleep(250);
        }
        return false;
    }
    private static void Open(string target) { try { Process.Start(new ProcessStartInfo(target) { UseShellExecute = true }); Log("MENU open ok"); } catch (Exception ex) { Log("MENU open error=" + ex.Message); } }
    private static void Status() { try { using var response = Http.GetAsync(BaseUrl + "/health").GetAwaiter().GetResult(); var text = response.Content.ReadAsStringAsync().GetAwaiter().GetResult(); Log("MENU status ok"); MessageBox.Show(text, "Model Gateway"); } catch (Exception ex) { Log("MENU status error=" + ex.Message); MessageBox.Show("网关未运行", "Model Gateway"); } }
    private static async Task ShutdownAsync()
    {
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, BaseUrl + "/__control/shutdown");
            request.Headers.Add("x-model-gateway-control", Token);
            using var response = await Http.SendAsync(request);
            Log($"MENU shutdown response={(int)response.StatusCode}");
            if (!response.IsSuccessStatusCode) MessageBox.Show("网关拒绝了退出请求，请查看托盘日志。", "Model Gateway");
            else if (Gateway != null) await Gateway.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(5));
        }
        catch (Exception ex) { Log("MENU shutdown error=" + ex.Message); }
        Icon!.Visible = false; Icon.Dispose(); Application.Exit();
    }
    private static System.Drawing.Icon LoadTrayIcon()
    {
        using var stream = typeof(Program).Assembly.GetManifestResourceStream("ModelGateway.TrayIcon.ico") ?? throw new InvalidOperationException("Embedded tray icon is missing");
        return new System.Drawing.Icon(stream);
    }
    private static void Log(string message) { try { File.AppendAllText(LogFile, DateTimeOffset.Now.ToString("yyyy-MM-dd'T'HH:mm:ss.fffzzz") + " " + message + Environment.NewLine); } catch { } }
    private static void LogPortUsage(string phase)
    {
        try
        {
            var port = new Uri(BaseUrl).Port;
            using var process = Process.Start(new ProcessStartInfo("netstat.exe", "-ano -p tcp")
            {
                UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true
            });
            if (process == null) { Log($"PORT phase={phase} error=process-start-failed"); return; }
            var output = process.StandardOutput.ReadToEnd(); process.WaitForExit(2000);
            var matches = output.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries)
                .Where(line => line.Contains("LISTENING", StringComparison.OrdinalIgnoreCase) && line.Contains($":{port}", StringComparison.Ordinal));
            var found = false;
            foreach (var line in matches)
            {
                found = true;
                var fields = line.Trim().Split(' ', StringSplitOptions.RemoveEmptyEntries);
                var local = fields.Length > 1 ? fields[1] : "?";
                var pid = fields.Length > 4 ? fields[4] : "?";
                Log($"PORT phase={phase} local={local} pid={pid} raw={line.Trim()}");
            }
            if (!found) Log($"PORT phase={phase} port={port} free");
        }
        catch (Exception ex) { Log($"PORT phase={phase} error={ex.Message}"); }
    }
}
