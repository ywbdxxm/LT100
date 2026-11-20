# LT100 browser console launcher
# Serves LT100/ over http://127.0.0.1:<port>/ and opens web/<Page>.
# Web Serial requires a secure context, so localhost is intentional.

[CmdletBinding()]
param(
    [int]$Port = 8770,
    [string]$Page = 'serial.html',
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
if ($Page -notmatch '^[A-Za-z0-9._-]+\.html$') { throw "Invalid page: $Page" }
$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$rootPrefix = $root.TrimEnd('\') + '\'
$url = "http://127.0.0.1:$Port/web/$Page"

$contentTypes = @{
    '.html' = 'text/html; charset=utf-8'
    '.css'  = 'text/css; charset=utf-8'
    '.js'   = 'application/javascript; charset=utf-8'
    '.json' = 'application/json; charset=utf-8'
    '.svg'  = 'image/svg+xml'
    '.png'  = 'image/png'
    '.jpg'  = 'image/jpeg'
    '.jpeg' = 'image/jpeg'
    '.ico'  = 'image/x-icon'
    '.woff2' = 'font/woff2'
}

$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add("http://127.0.0.1:$Port/")

try {
    $listener.Start()
    Write-Host "LT100 web console: $url" -ForegroundColor Green
    Write-Host 'Keep this window open. Press Ctrl+C to stop.' -ForegroundColor DarkGray
    if (-not $NoBrowser) {
        try { Start-Process $url } catch { Write-Host "Open this URL manually: $url" -ForegroundColor Yellow }
    }

    while ($listener.IsListening) {
        $context = $listener.GetContext()
        try {
            $requestPath = [Uri]::UnescapeDataString($context.Request.Url.AbsolutePath.TrimStart('/'))
            if ([string]::IsNullOrWhiteSpace($requestPath)) { $requestPath = "web/$Page" }
            $fullPath = [System.IO.Path]::GetFullPath((Join-Path $root $requestPath))

            if (-not $fullPath.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
                $context.Response.StatusCode = 403
                $context.Response.Close()
                continue
            }
            if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
                $bytes = [Text.Encoding]::UTF8.GetBytes('Not found')
                $context.Response.StatusCode = 404
                $context.Response.ContentType = 'text/plain; charset=utf-8'
                $context.Response.ContentLength64 = $bytes.Length
                $context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
                $context.Response.Close()
                continue
            }

            $extension = [System.IO.Path]::GetExtension($fullPath).ToLowerInvariant()
            $contentType = $contentTypes[$extension]
            if (-not $contentType) { $contentType = 'application/octet-stream' }

            $bytes = [System.IO.File]::ReadAllBytes($fullPath)
            $context.Response.StatusCode = 200
            $context.Response.ContentType = $contentType
            $context.Response.Headers['Cache-Control'] = 'no-store'
            $context.Response.ContentLength64 = $bytes.Length
            $context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
            $context.Response.Close()
        } catch {
            try {
                $context.Response.StatusCode = 500
                $context.Response.Close()
            } catch {}
        }
    }
} finally {
    try { $listener.Stop() } catch {}
    try { $listener.Close() } catch {}
}
