# Push annotated tags to GitHub through the API.
#
# Why not `git push --tags`: on the author's Windows host the outbound TLS
# path to github.com fails for git's schannel and openssl backends: the
# proxy CONNECT succeeds and the TLS handshake is then dropped, while GitHub's
# API is reachable through `gh` (Go's own TLS stack). Push the branch with git
# when it works; use this script for the tags.
#
# The tag object omits `tagger` on purpose: GitHub fills it from the token, and
# sending our own copy is what produced a 400 "Problems parsing JSON".
#
# Usage: powershell -File scripts/push-tags-api.ps1 -Repo Awenforever/dsh-loci
param(
    [string]$Repo = "Awenforever/dsh-loci",
    [string[]]$Tags = @("v1.0.0", "v1.1.0", "v1.2.0")
)

$ErrorActionPreference = "Continue"
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Invoke-GhApi {
    param([string]$Method, [string]$Path, [string]$Body, [string]$Jq)
    $arguments = @('api', '-X', $Method, $Path)
    if ($Body) { $arguments += @('--input', $Body) }
    if ($Jq) { $arguments += @('--jq', $Jq) }

    for ($attempt = 1; $attempt -le 3; $attempt++) {
        $output = & gh @arguments 2>&1
        if ($LASTEXITCODE -eq 0) { return ($output | Out-String).Trim() }
        $text = ($output | Out-String)
        if ($text -match 'already exists|HTTP 422') { return 'exists' }
        if ($text -match 'HTTP 404|"status":"404"') { return 'missing' }
        if ($attempt -eq 3) { throw "gh api $Method $Path failed: $text" }
        Start-Sleep -Seconds 3
    }
}

foreach ($name in $Tags) {
    $commit = (git rev-parse "$name^{commit}").Trim()
    $existing = Invoke-GhApi -Method 'GET' -Path "repos/$Repo/git/ref/tags/$name" -Jq '.ref'
    if ($existing -ne 'missing' -and $existing -ne '') {
        Write-Host "exists  $name -> $commit"
        continue
    }

    $subject = (git tag -l --format="%(subject)" $name).Trim().Replace('"', '\"')
    $bodyFile = [System.IO.Path]::GetTempFileName()
    [System.IO.File]::WriteAllText(
        $bodyFile,
        "{`"tag`":`"$name`",`"message`":`"$subject`",`"object`":`"$commit`",`"type`":`"commit`"}",
        $Utf8NoBom
    )
    $tagSha = Invoke-GhApi -Method 'POST' -Path "repos/$Repo/git/tags" -Body $bodyFile -Jq '.sha'
    Remove-Item -LiteralPath $bodyFile -Force

    $refFile = [System.IO.Path]::GetTempFileName()
    [System.IO.File]::WriteAllText($refFile, "{`"ref`":`"refs/tags/$name`",`"sha`":`"$tagSha`"}", $Utf8NoBom)
    $ref = Invoke-GhApi -Method 'POST' -Path "repos/$Repo/git/refs" -Body $refFile -Jq '.ref'
    Remove-Item -LiteralPath $refFile -Force

    Write-Host "created $name -> $commit (tag $tagSha, ref $ref)"
}
