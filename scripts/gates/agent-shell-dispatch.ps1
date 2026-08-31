#Requires -Version 5.1
<#
Construct-level PowerShell guard for Council agents.

Exit 0 allows the tool call and exit 2 blocks it. Repository authorship checks
apply to every agent type. Additional shell-mutation restrictions apply to the
Builder and Test Engineer. Any parser or policy failure after one of those
protected roles is identified fails closed.

This does not attempt containment or infer every path a program may write.
Edit and Write remain the intentional path-gated file-changing tools.
#>

param(
    [string]$PayloadText,
    [ValidateSet('', 'builder', 'test-engineer')][string]$AgentType = ''
)

. (Join-Path $PSScriptRoot '_guard-lib.ps1')

$RepositoryAuthorName = 'Cisco'
$RepositoryAuthorEmail = '115424057+Code-With-Cisco@users.noreply.github.com'

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
$projectDir = Get-GuardProjectDir $payload
$toolInput = Get-GuardProperty -InputObject $payload -Name 'tool_input'
$command = [string](Get-GuardProperty -InputObject $toolInput -Name 'command')

if ([string]::IsNullOrWhiteSpace($command)) {
    if ('builder', 'test-engineer' -contains $agentType) {
        Write-GuardAudit $projectDir 'PreToolUse:PowerShell' $agentType '' 'BLOCK: missing command'
        [Console]::Error.WriteLine(
            "$agentType shell guard could not read tool_input.command. Blocked (fail closed)."
        )
        exit 2
    }
    exit 0
}

# Repository-wide authorship boundary. Agent/model/vendor identities and
# attribution trailers are never permitted to become repository authorship.
$looksLikeGitCommit = $command -match '(?i)\bgit(?:\.exe)?\b[^\r\n;&|]*\bcommit\b'
if ($looksLikeGitCommit) {
    $forbiddenCommitMetadata = @(
        @{ Name = 'explicit commit author'; Pattern = '(?i)(?:--author(?:=|\s)|-c\s+user\.(?:name|email)\s*=|GIT_(?:AUTHOR|COMMITTER)_(?:NAME|EMAIL))' },
        @{ Name = 'co-author trailer'; Pattern = '(?i)Co-authored-by\s*:' },
        @{ Name = 'generated-by attribution'; Pattern = '(?i)Generated-by\s*:' },
        @{ Name = 'commit sign-off flag'; Pattern = '(?i)\bgit(?:\.exe)?\b[^\r\n;&|]*\bcommit\b[^\r\n;&|]*(?:--signoff\b|(?:^|\s)-s(?:\s|$))' }
    )

    foreach ($rule in $forbiddenCommitMetadata) {
        if ($command -match $rule.Pattern) {
            $reason = "Repository authorship policy blocked $($rule.Name). Commits must remain solely under the repository owner's identity."
            Write-GuardAudit $projectDir 'PreToolUse:PowerShell' $agentType $command "BLOCK: $reason"
            [Console]::Error.WriteLine($reason)
            exit 2
        }
    }

    try {
        $configuredName = (& git.exe -C $projectDir config --get user.name 2>$null | Select-Object -First 1).Trim()
        $configuredEmail = (& git.exe -C $projectDir config --get user.email 2>$null | Select-Object -First 1).Trim()
    } catch {
        $configuredName = ''
        $configuredEmail = ''
    }

    if ($configuredName -ne $RepositoryAuthorName -or $configuredEmail -ne $RepositoryAuthorEmail) {
        $reason = "Git commit blocked because repository identity is not $RepositoryAuthorName <$RepositoryAuthorEmail>. Configure the owner identity before committing; do not substitute an agent or bot identity."
        Write-GuardAudit $projectDir 'PreToolUse:PowerShell' $agentType $command "BLOCK: $reason"
        [Console]::Error.WriteLine($reason)
        exit 2
    }
}

# The remaining construct restrictions intentionally apply only to the protected
# native implementation/test roles. Other agent types are still subject to the
# repository-wide authorship check above and to their host capability profile.
if ('builder', 'test-engineer' -notcontains $agentType) { exit 0 }

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
