// Standalone Windows shell for Chord Sub.
// The web app (index.html, style.css, js/*) and the WebView2 SDK are embedded in the exe.
// Pages are served from those resources into an Edge WebView2 window; only the native
// WebView2Loader.dll is unpacked to %LOCALAPPDATA%\ChordSub (next to the browser profile).
// Built with the C# compiler that ships with .NET Framework 4.x (see build.ps1), so stick to C# 5.
using System;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Windows.Forms;

[assembly: AssemblyTitle("Chord Sub")]
[assembly: AssemblyProduct("Chord Sub")]
[assembly: AssemblyDescription("Finds the chords in melody clips and writes sub bass lines to fit")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]

namespace ChordSub
{
    static class Program
    {
        [DllImport("user32.dll")]
        static extern bool SetProcessDPIAware();

        public static string DataDir;

        [STAThread]
        static void Main()
        {
            // WebView2 managed assemblies live inside this exe as resources.
            AppDomain.CurrentDomain.AssemblyResolve += ResolveEmbedded;
            try { SetProcessDPIAware(); } catch { }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            DataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ChordSub");
            try
            {
                Unpack();
            }
            catch (Exception e)
            {
                MessageBox.Show("Could not unpack Chord Sub files:\n" + e.Message, "Chord Sub", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }
            Shell.Run();
        }

        static Assembly ResolveEmbedded(object sender, ResolveEventArgs args)
        {
            string name = new AssemblyName(args.Name).Name + ".dll";
            using (Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream("lib/" + name))
            {
                if (s == null) return null;
                byte[] bytes = new byte[s.Length];
                s.Read(bytes, 0, bytes.Length);
                return Assembly.Load(bytes);
            }
        }

        // Writes the native WebView2 loader to DataDir (it has to exist as a file to be loaded).
        static void Unpack()
        {
            Assembly asm = Assembly.GetExecutingAssembly();
            foreach (string res in asm.GetManifestResourceNames())
            {
                if (res != "native/WebView2Loader.dll") continue;
                string target = Path.Combine(DataDir, "WebView2Loader.dll");
                Directory.CreateDirectory(Path.GetDirectoryName(target));
                using (Stream s = asm.GetManifestResourceStream(res))
                using (MemoryStream ms = new MemoryStream())
                {
                    s.CopyTo(ms);
                    byte[] bytes = ms.ToArray();
                    if (File.Exists(target) && new FileInfo(target).Length == bytes.Length && SameBytes(File.ReadAllBytes(target), bytes)) continue;
                    try { File.WriteAllBytes(target, bytes); }
                    catch (IOException) { if (!File.Exists(target)) throw; } // loader DLL in use by another window
                }
            }
        }

        static bool SameBytes(byte[] a, byte[] b)
        {
            if (a.Length != b.Length) return false;
            for (int i = 0; i < a.Length; i++) if (a[i] != b[i]) return false;
            return true;
        }
    }

    // Kept separate from Program so no WebView2 type is touched before AssemblyResolve is hooked.
    static class Shell
    {
        public static void Run()
        {
            Application.Run(new MainForm());
        }
    }

    class MainForm : Form
    {
        Microsoft.Web.WebView2.WinForms.WebView2 web;

        public MainForm()
        {
            Text = "Chord Sub";
            Width = 1320;
            Height = 940;
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Color.FromArgb(26, 29, 35);
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

            web = new Microsoft.Web.WebView2.WinForms.WebView2();
            web.Dock = DockStyle.Fill;
            web.DefaultBackgroundColor = BackColor;
            Controls.Add(web);
            Load += OnLoad;
        }

        static string MimeType(string path)
        {
            string ext = Path.GetExtension(path).ToLowerInvariant();
            if (ext == ".html") return "text/html; charset=utf-8";
            if (ext == ".css") return "text/css; charset=utf-8";
            if (ext == ".js") return "text/javascript; charset=utf-8";
            if (ext == ".png") return "image/png";
            if (ext == ".svg") return "image/svg+xml";
            return "application/octet-stream";
        }

        async void OnLoad(object sender, EventArgs e)
        {
            try
            {
                Microsoft.Web.WebView2.Core.CoreWebView2Environment.SetLoaderDllFolderPath(Program.DataDir);
                var env = await Microsoft.Web.WebView2.Core.CoreWebView2Environment.CreateAsync(null, Path.Combine(Program.DataDir, "webview"));
                await web.EnsureCoreWebView2Async(env);
                var core = web.CoreWebView2;
                core.Settings.IsStatusBarEnabled = false;
                core.Settings.AreDevToolsEnabled = false;
                core.Settings.IsZoomControlEnabled = true;
                // Serve the app straight from the exe's embedded resources (no files on disk to
                // be locked, quarantined or blocked by folder permissions).
                core.AddWebResourceRequestedFilter("https://chordsub.local/*", Microsoft.Web.WebView2.Core.CoreWebView2WebResourceContext.All);
                core.WebResourceRequested += delegate (object s, Microsoft.Web.WebView2.Core.CoreWebView2WebResourceRequestedEventArgs args)
                {
                    string path = new Uri(args.Request.Uri).AbsolutePath.TrimStart('/');
                    if (path.Length == 0) path = "index.html";
                    Stream res = Assembly.GetExecutingAssembly().GetManifestResourceStream("web/" + Uri.UnescapeDataString(path));
                    if (res == null)
                    {
                        args.Response = env.CreateWebResourceResponse(null, 404, "Not Found", "");
                        return;
                    }
                    MemoryStream ms = new MemoryStream();
                    res.CopyTo(ms); res.Dispose(); ms.Position = 0;
                    args.Response = env.CreateWebResourceResponse(ms, 200, "OK", "Content-Type: " + MimeType(path) + "\r\nCache-Control: no-cache");
                };
                core.DocumentTitleChanged += delegate { Text = core.DocumentTitle; };
                core.Navigate("https://chordsub.local/index.html");
            }
            catch (Microsoft.Web.WebView2.Core.WebView2RuntimeNotFoundException)
            {
                if (MessageBox.Show("Chord Sub needs the Microsoft Edge WebView2 Runtime (built into Windows 11).\n\nOpen the download page?",
                    "Chord Sub", MessageBoxButtons.YesNo, MessageBoxIcon.Warning) == DialogResult.Yes)
                    System.Diagnostics.Process.Start("https://developer.microsoft.com/microsoft-edge/webview2/");
                Close();
            }
            catch (Exception ex)
            {
                MessageBox.Show("Could not start Chord Sub:\n" + ex.Message, "Chord Sub", MessageBoxButtons.OK, MessageBoxIcon.Error);
                Close();
            }
        }
    }
}
