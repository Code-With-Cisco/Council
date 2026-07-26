#Requires -Version 5.1
<#
Decagram Council story gate for Windows.

The hook is synchronous. Exit 0 allows completion; exit 2 blocks and sends the
stderr reason back to Claude Code.

The gate validates PRD traceability, runs the story's PowerShell acceptance
command, and checks the git worktree for paths the completing agent was not
allowed to modify. Git-based detection complements the construct-level shell
guard; neither layer is an operating-system security boundary.
#>

param(
    [Parameter(Position = 0)][string]$Event,
    [string]$PayloadText
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_guard-lib.ps1')

if ([string]::IsNullOrWhiteSpace($Event)) { exit 0 }

try {
    $payload = Get-GuardPayload -PayloadText $PayloadText
} catch {
    [Console]::Error.WriteLine("Story gate received an unparseable payload. Blocked (fail closed).")
    exit 2
}

$projectDir = Get-GuardProjectDir $payload
$storiesDir = Join-Path $projectDir 'stories'
if (-not (Test-Path -LiteralPath $storiesDir)) { exit 0 }

$taskName = [string](Get-GuardProperty -InputObject $payload -Name 'task_name')
$taskId = [string](Get-GuardProperty -InputObject $payload -Name 'task_id')
$teammate = [string](Get-GuardProperty -InputObject $payload -Name 'teammate_name')
$agentType = [string](Get-GuardProperty -InputObject $payload -Name 'agent_type')

function Get-Frontmatter {
    param([string]$Path)

    $result = @{}
    try { $lines = Get-Content -LiteralPath $Path } catch { return $result }
    if ($lines.Count -eq 0 -or $lines[0].Trim() -ne '---') { return $result }

    for ($index = 1; $index -lt $lines.Count; $index++) {
        $line = $lines[$index]
        if ($line.Trim() -eq '---') { break }
        $separator = $line.IndexOf(':')
        if ($separator -lt 1) { continue }
        $key = $line.Substring(0, $separator).Trim()
        $value = $line.Substring($separator + 1).Trim().Trim('"').Trim("'")
        if (-not $result.ContainsKey($key)) { $result[$key] = $value }
    }
    return $result
}

function Test-WindowsAcceptance {
    param([string]$Command)

    if ($Command -match '(?i)(^|[;&|]\s*)(bash|sh|zsh)\b') { return $false }
    if ($Command -match '(^|\s)\./') { return $false }
    if ($Command -match '(?i)/bin/') { return $false }
    if ($Command -match '(?i)(\|\|\s*(true|:)|;\s*(true|:)\s*$)') { return $false }
    if ($Command.Trim() -match '^(?i:true|:|exit\s+0|return\s+0)$') { return $false }
    return $true
}

$stories = @()
switch ($Event) {
    'TaskCompleted' {
        $needle = "$taskName$taskId"
        foreach ($file in Get-ChildItem -LiteralPath $storiesDir -Filter '*.md' -File) {
            $frontmatter = Get-Frontmatter -Path $file.FullName
            $id = if ($frontmatter.ContainsKey('id')) {
                $frontmatter['id']
            } else {
                $file.BaseName
            }
            if ($needle -like "*$id*" -or $needle -like "*$($file.BaseName)*") {
                $stories += $file.FullName
            }
        }
    }
    'TeammateIdle' {
        foreach ($file in Get-ChildItem -LiteralPath $storiesDir -Filter '*.md' -File) {
            $frontmatter = Get-Frontmatter -Path $file.FullName
            $status = if ($frontmatter.ContainsKey('status')) {
                $frontmatter['status'].ToLowerInvariant()
            } else {
                ''
            }
            if ('done', 'complete', 'completed', 'review' -contains $status) {
                $stories += $file.FullName
            }
        }
    }
    default { exit 0 }
}

if ($stories.Count -eq 0) { exit 0 }

$failures = New-Object System.Collections.Generic.List[string]

if ('builder', 'test-engineer', 'prd-lead' -contains $agentType) {
    try {
        $changedPaths = Get-GuardChangedPaths -ProjectDir $projectDir
        foreach ($changedPath in $changedPaths) {
            $reason = Get-GuardWriteBlockReason -AgentType $agentType -RelativePath $changedPath
            if ($null -ne $reason) {
                $failures.Add("  - forbidden worktree change by ${agentType}: $changedPath ($reason)")
            }
        }
    } catch {
        $failures.Add("  - forbidden-path detection could not run: $($_.Exception.Message)")
    }
}

$powershellHost = (Get-Process -Id $PID).Path

foreach ($story in $stories) {
    $name = Split-Path -Leaf $story
    $frontmatter = Get-Frontmatter -Path $story

    $prdRef = if ($frontmatter.ContainsKey('prd_ref')) { $frontmatter['prd_ref'] } else { '' }
    if ([string]::IsNullOrWhiteSpace($prdRef)) {
        $failures.Add("  - ${name}: missing 'prd_ref' in frontmatter.")
        continue
    }

    $acceptance = if ($frontmatter.ContainsKey('acceptance')) {
        $frontmatter['acceptance']
    } else {
        ''
    }
    if ([string]::IsNullOrWhiteSpace($acceptance)) {
        $failures.Add("  - ${name}: missing 'acceptance' in frontmatter.")
        continue
    }
    if (-not (Test-WindowsAcceptance -Command $acceptance)) {
        $failures.Add(
            "  - ${name}: acceptance must be a Windows PowerShell command without POSIX-only syntax or status masking."
        )
        continue
    }

    Push-Location -LiteralPath $projectDir
    try {
        $output = & $powershellHost -NoProfile -NonInteractive -Command $acceptance 2>&1
        $code = $LASTEXITCODE
    } catch {
        $output = $_.Exception.Message
        $code = 1
    } finally {
        Pop-Location
    }

    if ($code -ne 0) {
        $tail = ($output | Select-Object -Last 20 | ForEach-Object { "      $_" }) -join "`n"
        $failures.Add(
            "  - ${name}: acceptance command failed (exit $code)`n      PS> $acceptance`n$tail"
        )
    }
}

if ($failures.Count -gt 0) {
    $header = if ($Event -eq 'TeammateIdle') {
        $who = if ([string]::IsNullOrWhiteSpace($teammate)) { '' } else { " ($teammate)" }
        "Not finished yet$who. Completed stories still fail their gates:"
    } else {
        $what = if ([string]::IsNullOrWhiteSpace($taskName)) { 'this task' } else { $taskName }
        "Cannot mark `"$what`" complete. Its story does not pass the gate:"
    }

    $message = @(
        $header,
        ($failures -join "`n"),
        '',
        'Fix the underlying problem and re-check. Do not weaken the acceptance command.'
    ) -join "`n"

    Write-GuardAudit $projectDir $Event $agentType ($stories -join ',') "BLOCK: $message"
    [Console]::Error.WriteLine($message)
    exit 2
}

Write-GuardAudit $projectDir $Event $agentType ($stories -join ',') 'ALLOW'
exit 0
