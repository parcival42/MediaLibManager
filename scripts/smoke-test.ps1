<#
.SYNOPSIS
    End-to-end smoke test for MediaLibManager against the Docker container.

.DESCRIPTION
    Runs the full happy path and prints one compact, assertable summary so a
    human (or agent) only has to read the result instead of re-issuing API
    calls by hand:

        build (opt) -> fresh data (opt) -> wait health -> ensure media
        fixtures (opt) -> create/login user -> scan -> wait enrichment
        -> per-file table + enrichment summary -> PASS/FAIL verdict

    Uses PowerShell's Invoke-RestMethod (JSON -> objects, cookie session), so
    no curl/node plumbing is needed.

.PARAMETER Rebuild
    Rebuild the Docker image first (after code changes).

.PARAMETER Fresh
    Stop the container, wipe ./data, and start clean (new user + scan).

.PARAMETER Media
    (Re)generate the synthetic test-media fixtures inside the container via
    ffmpeg. Needed once, or after wiping ./testmedia.

.EXAMPLE
    pwsh scripts/smoke-test.ps1 -Rebuild -Fresh -Media   # full cold run
    pwsh scripts/smoke-test.ps1                          # quick re-check
#>
param(
    [switch]$Rebuild,
    [switch]$Fresh,
    [switch]$Media,
    [string]$BaseUrl = "http://localhost:8080",
    [string]$User = "test",
    [string]$Pass = "test123"
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

function Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "  PASS  $msg" -ForegroundColor Green }
function Fail($msg) { Write-Host "  FAIL  $msg" -ForegroundColor Red; $script:failures++ }
$script:failures = 0

# --- 1. Image / container lifecycle -----------------------------------------
if ($Rebuild) { Step "Building image"; docker compose build | Out-Null }

if ($Fresh) {
    Step "Fresh start (wiping ./data)"
    docker compose down | Out-Null
    if (Test-Path ./data) { Remove-Item -Recurse -Force ./data }
    docker compose up -d | Out-Null
} else {
    docker compose up -d | Out-Null
}

# --- 2. Wait for health ------------------------------------------------------
Step "Waiting for health"
$healthy = $false
foreach ($i in 1..30) {
    try {
        if ((Invoke-RestMethod "$BaseUrl/api/health" -TimeoutSec 3).status -eq "ok") {
            $healthy = $true; break
        }
    } catch { Start-Sleep -Milliseconds 800 }
}
if (-not $healthy) { Fail "backend did not become healthy"; exit 1 }
Ok "backend healthy"

# --- 3. Media fixtures (synthetic, generated in-container) -------------------
if ($Media) {
    Step "Generating synthetic media fixtures via container ffmpeg"
    $gen = @'
set -e
mkdir -p /media/CategoryA/PerformerX /media/CategoryB/SiteY /media/CategoryC/_unsorted
ffmpeg -y -v error -f lavfi -i testsrc=duration=2:size=320x240:rate=15 /media/CategoryA/PerformerX/clip1.mp4
ffmpeg -y -v error -f lavfi -i testsrc=duration=1:size=160x120:rate=10 -frames:v 1 /media/CategoryA/PerformerX/poster.jpg
ffmpeg -y -v error -f lavfi -i color=c=blue:size=200x200:duration=1 -frames:v 1 /media/CategoryB/SiteY/thumb.png
ffmpeg -y -v error -f lavfi -i testsrc=duration=2:size=256x144:rate=15 -c:v libvpx-vp9 /media/CategoryC/_unsorted/random.webm
# Intentionally broken files to exercise the error path:
printf 'dummy' > /media/CategoryA/PerformerX/clip2.mkv
printf 'dummy' > /media/CategoryB/SiteY/scene.mp4
printf 'dummy' > /media/CategoryC/_unsorted/note.txt
'@
    docker compose exec -T medialibmanager sh -c $gen
    Ok "fixtures generated (4 real, 3 broken/other)"
}

# --- 4. Session: setup-or-login ---------------------------------------------
Step "Authenticating"
$body = @{ username = $User; password = $Pass } | ConvertTo-Json
try {
    Invoke-RestMethod "$BaseUrl/api/auth/initial-setup" -Method Post -Body $body `
        -ContentType "application/json" -SessionVariable sess | Out-Null
    Ok "created first user '$User'"
} catch {
    # Setup already done -> log in instead.
    Invoke-RestMethod "$BaseUrl/api/login" -Method Post -Body $body `
        -ContentType "application/json" -SessionVariable sess | Out-Null
    Ok "logged in as '$User'"
}

# --- 5. Scan, wait for completion -------------------------------------------
Step "Scanning"
$scan = Invoke-RestMethod "$BaseUrl/api/scan" -Method Post -Body "{}" `
    -ContentType "application/json" -WebSession $sess
$task = $null
foreach ($i in 1..60) {
    $task = Invoke-RestMethod "$BaseUrl/api/tasks/$($scan.task_id)" -WebSession $sess
    if ($task.status -in @("done", "error", "interrupted")) { break }
    Start-Sleep -Milliseconds 500
}
if ($task.status -eq "done") { Ok "scan done: $($task.result | ConvertTo-Json -Compress)" }
else { Fail "scan ended with status '$($task.status)'" }

# --- 6. Wait for enrichment to drain ----------------------------------------
Step "Waiting for enrichment"
$enr = $null
foreach ($i in 1..60) {
    $enr = Invoke-RestMethod "$BaseUrl/api/enrichment/status" -WebSession $sess
    if ($enr.pending -eq 0 -and -not $enr.paused) { break }
    Start-Sleep -Milliseconds 500
}

# --- 7. Per-file report ------------------------------------------------------
Step "Library contents"
$lib = Invoke-RestMethod "$BaseUrl/api/library?limit=500" -WebSession $sess
$lib.items |
    Select-Object @{n="status";e={$_.enrich_status}}, @{n="stg";e={$_.enrich_stage}},
        type, @{n="dims";e={ if ($_.width) { "$($_.width)x$($_.height)" } else { "-" } }},
        @{n="dur";e={ if ($_.duration) { [math]::Round($_.duration,1) } else { "-" } }},
        @{n="thumb";e={ if ($_.thumbnail_b64) { "yes" } else { "no" } }},
        @{n="file";e={$_.filename}} |
    Format-Table -AutoSize | Out-String | Write-Host

Write-Host ("Enrichment: total={0} done={1} error={2} pending={3} percent={4}" -f `
    $enr.total, $enr.done, $enr.error, $enr.pending, $enr.percent) -ForegroundColor Yellow

# --- 8. Assertions -----------------------------------------------------------
Step "Assertions"
if ($enr.pending -eq 0) { Ok "no files left pending" } else { Fail "$($enr.pending) still pending" }

$video = $lib.items | Where-Object { $_.filename -eq "clip1.mp4" }
if ($video -and $video.enrich_status -eq "done" -and $video.duration -and $video.thumbnail_b64) {
    Ok "video enriched (duration + thumbnail)"
} else { Fail "video clip1.mp4 not fully enriched" }

$image = $lib.items | Where-Object { $_.filename -eq "poster.jpg" }
if ($image -and $image.enrich_status -eq "done" -and $image.width -and $image.thumbnail_b64) {
    Ok "image enriched (dimensions + thumbnail)"
} else { Fail "image poster.jpg not fully enriched" }

$broken = $lib.items | Where-Object { $_.filename -eq "clip2.mkv" }
if ($broken -and $broken.enrich_status -eq "error") {
    Ok "broken file recorded as error (did not block others)"
} else { Fail "broken file clip2.mkv not marked error" }

# --- Verdict -----------------------------------------------------------------
Write-Host ""
if ($script:failures -eq 0) {
    Write-Host "RESULT: PASS" -ForegroundColor Green
    exit 0
} else {
    Write-Host "RESULT: FAIL ($($script:failures) failed)" -ForegroundColor Red
    exit 1
}
