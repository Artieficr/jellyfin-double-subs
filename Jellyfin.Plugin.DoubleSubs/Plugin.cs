using System.Text;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Plugins;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.DependencyInjection;

namespace Jellyfin.Plugin.DoubleSubs;

/// <summary>Double Subs: the server side only delivers the client script (web/doublesubs.js) to the web client.</summary>
public class Plugin : BasePlugin<BasePluginConfiguration>
{
    public Plugin(IApplicationPaths applicationPaths, IXmlSerializer xmlSerializer)
        : base(applicationPaths, xmlSerializer)
    {
    }

    public override string Name => "Double Subs";

    public override Guid Id => Guid.Parse("fb1def4b-4cd2-4c2d-b728-0ea67d10c0fd");

    public override string Description => "Two subtitle languages at once, a pause history of recent lines, and click-to-rewind.";
}

public class ServiceRegistrator : IPluginServiceRegistrator
{
    public void RegisterServices(IServiceCollection serviceCollection, IServerApplicationHost applicationHost)
        => serviceCollection.AddTransient<IStartupFilter, ScriptInjection>();
}

/// <summary>
/// Adds the script tag to the web client's index.html while it is served. The file on disk is never
/// touched, so it survives server updates and read-only installs (Docker).
/// </summary>
public class ScriptInjection : IStartupFilter
{
    private static readonly string Tag =
        $"<script defer src=\"../DoubleSubs/doublesubs.js?v={typeof(Plugin).Assembly.GetName().Version}\"></script>";

    public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next) => app =>
    {
        app.Use(async (context, nextMiddleware) =>
        {
            var path = context.Request.Path.Value ?? string.Empty;
            if (!HttpMethods.IsGet(context.Request.Method)
                || !(path.EndsWith("/web/", StringComparison.OrdinalIgnoreCase) || path.EndsWith("/web/index.html", StringComparison.OrdinalIgnoreCase)))
            {
                await nextMiddleware().ConfigureAwait(false);
                return;
            }

            // Always produce the full, uncompressed page: a 304 or a gzipped body can't be edited.
            context.Request.Headers.Remove("If-None-Match");
            context.Request.Headers.Remove("If-Modified-Since");
            context.Request.Headers.Remove("Accept-Encoding");

            // Capture the body. A feature without a "prior" one keeps the real response from starting
            // (static files are sent with SendFileAsync, which would otherwise bypass a swapped Body stream).
            var realBody = context.Features.Get<IHttpResponseBodyFeature>()!;
            using var buffer = new MemoryStream();
            context.Features.Set<IHttpResponseBodyFeature>(new StreamResponseBodyFeature(buffer));
            try
            {
                await nextMiddleware().ConfigureAwait(false);
            }
            finally
            {
                context.Features.Set(realBody);
            }

            var bytes = buffer.ToArray();
            var html = Encoding.UTF8.GetString(bytes);
            var end = html.LastIndexOf("</body>", StringComparison.OrdinalIgnoreCase);
            if (context.Response.StatusCode == StatusCodes.Status200OK && end >= 0 && !html.Contains("DoubleSubs/doublesubs.js", StringComparison.Ordinal))
            {
                bytes = Encoding.UTF8.GetBytes(html.Insert(end, Tag));
                // The page no longer matches the file, so drop its validators: otherwise a browser that
                // cached the page before the plugin was installed keeps getting "304, use your copy".
                context.Response.Headers.Remove("ETag");
                context.Response.Headers.Remove("Last-Modified");
                context.Response.Headers.CacheControl = "no-cache";
            }

            context.Response.ContentLength = bytes.Length;
            await context.Response.Body.WriteAsync(bytes).ConfigureAwait(false);
        });
        next(app);
    };
}

/// <summary>Serves the client script embedded in this DLL.</summary>
[ApiController]
[Route("DoubleSubs")]
public class ScriptController : ControllerBase
{
    [HttpGet("doublesubs.js")]
    [AllowAnonymous] // loaded by the page before sign-in; it's the same public script for everyone
    public ActionResult GetScript()
        => File(typeof(Plugin).Assembly.GetManifestResourceStream("doublesubs.js")!, "application/javascript; charset=utf-8");
}
