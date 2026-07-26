#Requires -Version 5.1
<#
Muster story gate - PowerShell dialect (Windows).

Behavioural twin of story-gate.sh. Installed per-project by Muster into
<project>\.claude\hooks\ and wired to the TaskCompleted and TeammateIdle events
with "shell": "powershell".

Blocks completion when a story is not actually done:
  * frontmatter has no `prd_ref` (no traceability to the PRD), or
  * the `acceptance` command exits nonzero.

Exit code contract (from the hooks reference):
  0  no opinion, carry on
  2  BLOCK; stderr is fed back to Claude as the reason
Any other code is a non-blocking notice, which is why internal failures below
exit 0 rather than surfacing: a broken gate must not wedge the squad.

Usage: story-gate.ps1 <TaskCompleted|TeammateIdle>   (payload on stdin)
#>

param([Parameter(Position = 0)][string]$Event)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($Event)) { exit 0 }

$payloadText = [Console]::In.ReadToEnd()
$payload = $null
if (-not [string]::IsNullOrWhiteSpace($payloadText)) {
    try { $payload = $payloadText | ConvertFrom-Json } catch { $payload = $null }
}

$projectDir = $env:CLAUDE_PROJECT_DIR
if ([string]::IsNullOrWhiteSpace($projectDir)) { $projectDir = $payload.cwd }
if ([string]::IsNullOrWhiteSpace($projectDir)) { $projectDir = (Get-Location).Path }

$storiesDir = Join-Path $projectDir 'stories'
if (-not (Test-Path -LiteralPath $storiesDir)) { exit 0 }  # Not a pipeline project.

$taskName = [string]$payload.task_name
$taskId   = [string]$payload.task_id
$teammate = [string]$payload.teammate_name

function Get-Frontmatter {
    param([string]$Path)

    $result = @{}
    try { $lines = Get-Content -LiteralPath $Path } catch { return $result }
    if ($lines.Count -eq 0 -or $lines[0].Trim() -ne '---') { return $result }

    for ($i = 1; $i -lt $lines.Count; $i++) {
        $line = $lines[$i]
        if ($line.Trim() -eq '---') { break }
        $idx = $line.IndexOf(':')
        if ($idx -lt 1) { continue }
        $key = $line.Substring(0, $idx).Trim()
        $value = $line.Substring($idx + 1).Trim().Trim('"').Trim("'")
        if (-not $result.ContainsKey($key)) { $result[$key] = $value }
    }
    return $result
}

$stories = @()
switch ($Event) {
    'TaskCompleted' {
        # A story matches when its id or filename stem appears in the task name
        # or id. Tasks mapping to no story are not gated.
        $needle = "$taskName$taskId"
        foreach ($file in Get-ChildItem -LiteralPath $storiesDir -Filter '*.md' -File) {
            $fm = Get-Frontmatter -Path $file.FullName
            $id = if ($fm.ContainsKey('id')) { $fm['id'] } else { $file.BaseName }
            if ($needle -like "*$id*" -or $needle -like "*$($file.BaseName)*") {
                $stories += $file.FullName
            }
        }
    }
    'TeammateIdle' {
        # No task to key off, so every story the squad marked finished is
        # re-checked. This event is the last moment to catch a story that was
        # marked done without passing its own acceptance check.
        foreach ($file in Get-ChildItem -LiteralPath $storiesDir -Filter '*.md' -File) {
            $fm = Get-Frontmatter -Path $file.FullName
            $status = if ($fm.ContainsKey('status')) { $fm['status'].ToLowerInvariant() } else { '' }
            if ('done', 'complete', 'completed', 'review' -contains $status) {
                $stories += $file.FullName
            }
        }
    }
    default { exit 0 }
}

if ($stories.Count -eq 0) { exit 0 }

$failures = New-Object System.Collections.Generic.List[string]

foreach ($story in $stories) {
    $name = Split-Path -Leaf $story
    $fm = Get-Frontmatter -Path $story

    $prdRef = if ($fm.ContainsKey('prd_ref')) { $fm['prd_ref'] } else { '' }
    if ([string]::IsNullOrWhiteSpace($prdRef)) {
        $failures.Add("  - ${name}: missing 'prd_ref' in frontmatter. Every story must trace to a section of docs/prd.md.")
        continue
    }

    $acceptance = if ($fm.ContainsKey('acceptance')) { $fm['acceptance'] } else { '' }
    if ([string]::IsNullOrWhiteSpace($acceptance)) {
        $failures.Add("  - ${name}: missing 'acceptance' in frontmatter. Add a command that exits 0 when the story is genuinely done.")
        continue
    }

    # Run from the project root so acceptance commands can use relative paths.
    Push-Location -LiteralPath $projectDir
    try {
        $output = & cmd.exe /c $acceptance 2>&1
        $code = $LASTEXITCODE
    } catch {
        $output = $_.Exception.Message
        $code = 1
    } finally {
        Pop-Location
    }

    if ($code -ne 0) {
        $tail = ($output | Select-Object -Last 20 | ForEach-Object { "      $_" }) -join "`n"
        $failures.Add("  - ${name}: acceptance command failed (exit $code)`n      `$ $acceptance`n$tail")
    }
}

if ($failures.Count -gt 0) {
    # stderr on exit 2 becomes the reason Claude sees, so this is written as
    # instructions to the agent rather than as an operator log line.
    $header = if ($Event -eq 'TeammateIdle') {
        $who = if ([string]::IsNullOrWhiteSpace($teammate)) { '' } else { " ($teammate)" }
        "Not finished yet$who. Stories marked complete are still failing their gates:"
    } else {
        $what = if ([string]::IsNullOrWhiteSpace($taskName)) { 'this task' } else { $taskName }
        "Cannot mark `"$what`" complete. Its story does not pass the gate:"
    }

    $message = @(
        $header,
        ($failures -join "`n"),
        '',
        'Fix the underlying problem and re-check. Do not edit the acceptance command to make it pass.'
    ) -join "`n"

    [Console]::Error.WriteLine($message)
    exit 2
}

exit 0
