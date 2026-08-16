#Requires -Version 5.1
<#
Construct-level PowerShell guard for Builder and Test Engineer.

Exit 0 allows the tool call and exit 2 blocks it. Any parser or policy failure
after a guarded agent is identified exits 2; unexpected codes never pass.

This does not attempt containment or infer every path a program may write.
It blocks use of PowerShell itself as an editor and rejects constructs that
defeat reliable token inspection. Edit and Write remain the intentional,
path-gated file-changing tools.
#>

param(
    [string]$PayloadText,
    [ValidateSet('', 'builder', 'test-engineer')][string]$AgentType = ''
)

. (Join-Path $PSScriptRoot '_guard-lib.ps1')

if ([string]::IsNullOrWhiteSpace($PayloadText)) {
    $PayloadText = [Console]::In.ReadToEnd()
}

try {
    $payload = Get-GuardPayload -PayloadText $PayloadText
} catch {
    exit 0
}

$payloadAgentType = [string](Get-GuardProperty -InputObject $payload -Name 'agent_type')
$agentType = if ([string]::IsNullOrWhiteSpace($AgentType)) { $payloadAgentType } else { $AgentType }
if ('builder', 'test-engineer' -notcontains $agentType) { exit 0 }

$projectDir = Get-GuardProjectDir $payload
$toolInput = Get-GuardProperty -InputObject $payload -Name 'tool_input'
$command = [string](Get-GuardProperty -InputObject $toolInput -Name 'command')
if ([string]::IsNullOrWhiteSpace($command)) {
    Write-GuardAudit $projectDir 'PreToolUse:PowerShell' $agentType '' 'BLOCK: missing command'
    [Console]::Error.WriteLine(
        "$agentType shell guard could not read tool_input.command. Blocked (fail closed)."
    )
    exit 2
}

$blocked = @(
    @{ Name = 'file redirection'; Pattern = '(^|[^<])(?:>>|>)' },
    @{ Name = 'file-content cmdlet'; Pattern = '(?i)\b(?:Out-File|Set-Content|Add-Content)\b' },
    @{ Name = 'filesystem mutation cmdlet'; Pattern = '(?i)\b(?:Copy-Item|Move-Item|Remove-Item|New-Item|Rename-Item)\b' },
    @{ Name = 'Tee-Object'; Pattern = '(?i)\bTee-Object\b' },
    @{ Name = '.NET file write'; Pattern = '(?i)\[(?:System\.)?IO\.File\]::(?:Write|Append|Create|Delete|Move|Copy)' },
    @{ Name = 'dynamic evaluation'; Pattern = '(?i)\b(?:Invoke-Expression|iex)\b' },
    @{ Name = 'encoded command'; Pattern = '(?i)(?:-EncodedCommand|-enc\b|FromBase64String)' },
    @{ Name = 'dynamic script block'; Pattern = '(?i)\[ScriptBlock\]::Create' },
    @{ Name = 'nested process'; Pattern = '(?i)\b(?:Start-Process|Invoke-Command)\b' },
    @{ Name = 'inline interpreter'; Pattern = '(?i)(?:^|[|;&]\s*|\s)(?:node(?:\.exe)?\s+(?:-e|--eval)|python(?:\.exe)?\s+-c|py(?:\.exe)?\s+-c|cmd(?:\.exe)?\s+/(?:c|k)|powershell(?:\.exe)?\s+-(?:command|c)\b)' },
    @{ Name = 'here-string'; Pattern = '(?s)@["''].*?["'']@' },
    @{ Name = 'variable call operator'; Pattern = '(?i)&\s*\$' }
)

foreach ($rule in $blocked) {
    if ($command -match $rule.Pattern) {
        $reason = "PowerShell construct blocked: $($rule.Name). Use Edit or Write for intentional file changes."
        Write-GuardAudit $projectDir 'PreToolUse:PowerShell' $agentType $command "BLOCK: $reason"
        [Console]::Error.WriteLine($reason)
        exit 2
    }
}

Write-GuardAudit $projectDir 'PreToolUse:PowerShell' $agentType $command 'ALLOW'
exit 0
