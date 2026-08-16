#Requires -Version 5.1
<#
Runs known-must-block payloads through the real Windows dispatchers.
Exit 0 means both guards blocked as expected; exit 1 means enforcement is not
operational and should be surfaced prominently in diagnostics.
#>

param([string]$ProjectDir)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($ProjectDir)) {
    $ProjectDir = $env:CLAUDE_PROJECT_DIR
}
if ([string]::IsNullOrWhiteSpace($ProjectDir)) {
    $ProjectDir = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
}

$hostExecutable = (Get-Process -Id $PID).Path
$writeDispatcher = Join-Path $PSScriptRoot 'agent-write-dispatch.ps1'
$shellDispatcher = Join-Path $PSScriptRoot 'agent-shell-dispatch.ps1'

if (-not (Test-Path -LiteralPath $writeDispatcher -PathType Leaf)) {
    [Console]::Error.WriteLine("Missing write dispatcher: $writeDispatcher")
    exit 1
}
if (-not (Test-Path -LiteralPath $shellDispatcher -PathType Leaf)) {
    [Console]::Error.WriteLine("Missing shell dispatcher: $shellDispatcher")
    exit 1
}

$writePayload = @{
    hook_event_name = 'PreToolUse'
    agent_type = 'builder'
    cwd = $ProjectDir
    tool_name = 'Write'
    tool_input = @{ file_path = (Join-Path $ProjectDir 'test\guard-self-test.test.ts') }
} | ConvertTo-Json -Depth 5 -Compress

$shellPayload = @{
    hook_event_name = 'PreToolUse'
    agent_type = 'builder'
    cwd = $ProjectDir
    tool_name = 'PowerShell'
    tool_input = @{ command = "Set-Content -LiteralPath 'guard-self-test.txt' -Value blocked" }
} | ConvertTo-Json -Depth 5 -Compress

$previousProjectDir = $env:CLAUDE_PROJECT_DIR
$previousErrorActionPreference = $ErrorActionPreference
$env:CLAUDE_PROJECT_DIR = $ProjectDir
try {
    # Windows PowerShell 5.1 promotes a native child's intentional stderr into
    # NativeCommandError. These canaries must inspect exit 2 without allowing
    # that expected block message to terminate the self-test first.
    $ErrorActionPreference = 'Continue'
    $writePayload | & $hostExecutable -NoProfile -NonInteractive -File $writeDispatcher 2>$null
    $writeCode = $LASTEXITCODE
    $shellPayload | & $hostExecutable -NoProfile -NonInteractive -File $shellDispatcher 2>$null
    $shellCode = $LASTEXITCODE
} finally {
    $ErrorActionPreference = $previousErrorActionPreference
    $env:CLAUDE_PROJECT_DIR = $previousProjectDir
}

if ($writeCode -ne 2 -or $shellCode -ne 2) {
    [Console]::Error.WriteLine(
        "Guard self-test failed: write dispatcher=$writeCode; shell dispatcher=$shellCode"
    )
    exit 1
}

Write-Output 'Guard self-test passed.'
exit 0
