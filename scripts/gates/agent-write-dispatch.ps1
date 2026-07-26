#Requires -Version 5.1
<#
Settings-level dispatcher for Edit and Write.

Unknown or absent agent_type is allowed so a normal user session is not gated.
Once a guarded agent is recognized, malformed input and missing guard scripts
fail closed.
#>

param([string]$PayloadText)

. (Join-Path $PSScriptRoot '_guard-lib.ps1')

if ([string]::IsNullOrWhiteSpace($PayloadText)) {
    $PayloadText = [Console]::In.ReadToEnd()
}

try {
    $payload = Get-GuardPayload -PayloadText $PayloadText
} catch {
    # No agent identity can be established. This is indistinguishable from a
    # human session, so the settings-level dispatcher defaults to allow.
    exit 0
}

$agentType = [string](Get-GuardProperty -InputObject $payload -Name 'agent_type')
$guardName = switch ($agentType) {
    'builder' { 'builder-write-guard.ps1' }
    'test-engineer' { 'test-engineer-write-guard.ps1' }
    'prd-lead' { 'prd-lead-write-guard.ps1' }
    default { $null }
}

if ([string]::IsNullOrWhiteSpace($guardName)) { exit 0 }

$guard = Join-Path $PSScriptRoot $guardName
if (-not (Test-Path -LiteralPath $guard -PathType Leaf)) {
    $projectDir = Get-GuardProjectDir $payload
    Write-GuardAudit $projectDir 'PreToolUse:Edit|Write' $agentType '' 'BLOCK: guard script missing'
    [Console]::Error.WriteLine(
        "$agentType write guard is missing ($guard). Blocking to fail closed."
    )
    exit 2
}

& $guard -PayloadText $PayloadText
exit $LASTEXITCODE
