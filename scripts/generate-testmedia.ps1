<#
.SYNOPSIS
    Generate a complete synthetic test-media set in ./testmedia.

.DESCRIPTION
    Produces, inside the running container (so the container's ffmpeg is used),
    a fixed and reproducible fixture set under /media (= ./testmedia on the host):

      * real files        — distinct synthetic videos, images, an audio file
      * broken / other     — dummy bytes that fail ffprobe (error path) + a .txt
      * duplicates         — one pair for every detection kind:
            exact   (byte-identical copy)
            visual  (re-encoded / scaled image, same pHash)
            video   (re-encoded video, 5 sample frames still match)
            deep    (trimmed video; sample positions shift, edge blocks match)

    All sources are lavfi-generated, so nothing real is committed and the set is
    identical on every machine. ffmpeg uses -y, so re-running overwrites in place.

    Expected result after a scan + full enrichment + duplicate rebuild:
        exact: 2 groups   visual: 1   video: 1   deep: 1   |   2 files in error

.PARAMETER Clean
    Wipe ./testmedia before generating, so no stray files from earlier runs
    remain (otherwise generation is additive / overwrite-in-place).

.EXAMPLE
    pwsh scripts/generate-testmedia.ps1            # (re)create the fixtures
    pwsh scripts/generate-testmedia.ps1 -Clean     # wipe first, then create
#>
param(
    [switch]$Clean
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

function Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }

if ($Clean -and (Test-Path ./testmedia)) {
    Step "Wiping ./testmedia"
    Get-ChildItem ./testmedia -Force | Remove-Item -Recurse -Force
}

Step "Ensuring container is up"
docker compose up -d | Out-Null

# Everything below runs inside the container. /media is the ./testmedia mount,
# so the generated files land on the host and survive container restarts.
$gen = @'
set -e
ROOT=/media
mkdir -p "$ROOT/CategoryA/PerformerX" "$ROOT/CategoryB/SiteY" "$ROOT/CategoryC/_unsorted"

# --- real, visually distinct sources ---
ffmpeg -y -v error -f lavfi -i testsrc=duration=4:size=320x240:rate=10  -pix_fmt yuv420p "$ROOT/CategoryA/PerformerX/scene_a.mp4"
ffmpeg -y -v error -f lavfi -i testsrc2=duration=4:size=320x240:rate=10 -pix_fmt yuv420p "$ROOT/CategoryA/PerformerX/scene_b.mp4"
ffmpeg -y -v error -f lavfi -i mandelbrot=size=320x240:rate=10 -t 6      -pix_fmt yuv420p "$ROOT/CategoryA/PerformerX/scene_c.mp4"
ffmpeg -y -v error -f lavfi -i sine=frequency=440:duration=3 "$ROOT/CategoryA/PerformerX/tone.m4a"
ffmpeg -y -v error -f lavfi -i testsrc=size=200x200:rate=1    -frames:v 1 "$ROOT/CategoryB/SiteY/photo_a.jpg"
ffmpeg -y -v error -f lavfi -i rgbtestsrc=size=200x200:rate=1 -frames:v 1 "$ROOT/CategoryB/SiteY/photo_b.jpg"
ffmpeg -y -v error -f lavfi -i color=c=blue:size=240x180      -frames:v 1 "$ROOT/CategoryB/SiteY/cover.png"
ffmpeg -y -v error -f lavfi -i testsrc2=duration=2:size=256x144:rate=10 -c:v libvpx-vp9 "$ROOT/CategoryC/_unsorted/clip.webm"

# --- broken (fail ffprobe -> error) and a plain "other" file ---
printf 'not a real video' > "$ROOT/CategoryA/PerformerX/broken.mkv"
printf 'not a real video' > "$ROOT/CategoryB/SiteY/broken.mp4"
printf 'just a note'      > "$ROOT/CategoryC/_unsorted/readme.txt"

# --- duplicates: one independent pair per detection kind ---
# exact: byte-identical copies
cp "$ROOT/CategoryB/SiteY/photo_a.jpg"        "$ROOT/CategoryB/SiteY/photo_a_copy.jpg"
cp "$ROOT/CategoryA/PerformerX/scene_a.mp4"   "$ROOT/CategoryC/_unsorted/scene_a_copy.mp4"
# visual: scaled + re-encoded image (same pHash, different bytes)
ffmpeg -y -v error -i "$ROOT/CategoryB/SiteY/photo_b.jpg" -vf scale=300:300 "$ROOT/CategoryC/_unsorted/photo_b_scaled.jpg"
# video (5-frame): re-encoded at a lower bitrate
ffmpeg -y -v error -i "$ROOT/CategoryA/PerformerX/scene_b.mp4" -b:v 80k -an -pix_fmt yuv420p "$ROOT/CategoryB/SiteY/scene_b_reenc.mp4"
# deep: trimmed by an integer second so the 1 fps edge frames realign with the original
ffmpeg -y -v error -ss 2 -i "$ROOT/CategoryA/PerformerX/scene_c.mp4" -an -pix_fmt yuv420p "$ROOT/CategoryC/_unsorted/scene_c_trim.mp4"

echo "---generated---"
find "$ROOT" -type f | sort
'@

Step "Generating fixtures via container ffmpeg"
docker compose exec -T medialibmanager sh -c $gen

Write-Host ""
Write-Host "Done. Scan + enrich, then 'Find duplicates' should yield:" -ForegroundColor Green
Write-Host "  exact: 2   visual: 1   video: 1   deep: 1   (and 2 files in error)" -ForegroundColor Green
