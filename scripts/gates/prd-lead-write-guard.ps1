#Requires -Version 5.1
<# Exit 0 allows the tool call; exit 2 blocks it. Every policy error fails closed. #>
param([string]$PayloadText)

. (Join-Path $PSScriptRoot '_guard-lib.ps1')

$agentType = 'prd-lead'
$label = 'PRD Lead'
$payload = $null

try {
    $payload = Get-GuardPayload -PayloadText $PayloadText
    $path = Resolve-GuardPath -Payload $payload -AgentLabel $label
    $reason = Get-GuardWriteBlockReason -AgentType $agentType -RelativePath $path.Relative -Payload $payload
} catch {
    $projectDir = if ($null -ne $payload) { Get-GuardProjectDir $payload } else { (Get-Location).Path }
    Write-GuardAudit $projectDir 'PreToolUse:Edit|Write' $agentType '' "BLOCK: $($_.Exception.Message)"
    [Console]::Error.WriteLine("$label write guard: $($_.Exception.Message). Blocked (fail closed).")
    exit 2
}

if ($null -ne $reason) {
    Write-GuardAudit $path.ProjectDir 'PreToolUse:Edit|Write' $agentType $path.Original "BLOCK: $reason"
    [Console]::Error.WriteLine($reason)
    exit 2
}

Write-GuardAudit $path.ProjectDir 'PreToolUse:Edit|Write' $agentType $path.Original 'ALLOW'
exit 0
