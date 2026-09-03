param([int]$Port = 8080, [string]$Root = "E:\English vocab\english-vocab-learning")
$root = (Resolve-Path $Root).Path
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
Write-Output "Serving $root on http://localhost:$Port/"
$mime = @{
  ".html" = "text/html; charset=utf-8"
  ".js"   = "application/javascript"
  ".css"  = "text/css"
  ".json" = "application/json"
  ".png"  = "image/png"
  ".jpg"  = "image/jpeg"
  ".jpeg" = "image/jpeg"
  ".gif"  = "image/gif"
  ".svg"  = "image/svg+xml"
  ".ico"  = "image/x-icon"
  ".woff" = "font/woff"
  ".woff2"= "font/woff2"
  ".mp3"  = "audio/mpeg"
  ".wav"  = "audio/wav"
  ".txt"  = "text/plain; charset=utf-8"
  ".md"   = "text/plain; charset=utf-8"
}
while ($listener.IsListening) {
  $ctx = $null
  try {
    $ctx = $listener.GetContext()
    $reqPath = [System.Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath)
    if ($reqPath -eq "/") { $reqPath = "/index.html" }
    $rel = $reqPath.TrimStart("/").Replace("/", "\")
    $filePath = [System.IO.Path]::GetFullPath((Join-Path $root $rel))
    if (-not $filePath.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) { throw "path traversal blocked" }
    if (Test-Path $filePath -PathType Leaf) {
      $bytes = [System.IO.File]::ReadAllBytes($filePath)
      $ext = [System.IO.Path]::GetExtension($filePath).ToLower()
      if ($mime.ContainsKey($ext)) { $ctx.Response.ContentType = $mime[$ext] } else { $ctx.Response.ContentType = "application/octet-stream" }
      $ctx.Response.StatusCode = 200
      $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
      $ctx.Response.StatusCode = 404
      $body = [System.Text.Encoding]::UTF8.GetBytes("Not Found")
      $ctx.Response.OutputStream.Write($body, 0, $body.Length)
    }
  } catch {
    Write-Output ("ERR: " + $_.Exception.Message)
  } finally {
    if ($ctx -ne $null) { try { $ctx.Response.Close() } catch {} }
  }
}
