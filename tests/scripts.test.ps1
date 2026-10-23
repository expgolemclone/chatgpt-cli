#requires -Version 7.0
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$temporary = Join-Path 'C:/dev/tmp' ('gpt-message-scripts-' + [guid]::NewGuid().ToString('N'))
$previousRoot = $env:GPT_MESSAGE_TEST_ROOT

function Assert-That([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}
try {
    $usage = Join-Path $temporary 'upstream'
    $null = New-Item -ItemType Directory -Path (Join-Path $usage 'src'), (Join-Path $usage 'profiles') -Force
    $profiles = Join-Path $temporary 'profiles'
    foreach ($name in @('one', 'two')) { $null = New-Item -ItemType Directory -Path (Join-Path $profiles $name) -Force }
    $env:GPT_MESSAGE_TEST_ROOT = $profiles
    $registry = Join-Path $usage 'profiles/company.json'
    [IO.File]::WriteAllText($registry, '{}')
    $fakeModule = @'
$script:EdgeArguments = @('--no-first-run', '--no-default-browser-check')
function Get-GptUsageModel {
    param([Parameter(Mandatory)][string]$RegistryPath, [switch]$RequireEdge)
    if (-not $RequireEdge -or -not (Test-Path -LiteralPath $RegistryPath)) { throw 'Explicit registry and Edge validation are required.' }
    [pscustomobject]@{
        ProfileRoot = $env:GPT_MESSAGE_TEST_ROOT
        EdgePath = (Get-Command node -CommandType Application | Select-Object -First 1).Source
        Profiles = @(
            [pscustomobject]@{Id=('a' * 32);Name='one';Path=(Join-Path $env:GPT_MESSAGE_TEST_ROOT 'one')},
            [pscustomobject]@{Id=('b' * 32);Name='two';Path=(Join-Path $env:GPT_MESSAGE_TEST_ROOT 'two')},
            [pscustomobject]@{Id=('c' * 32);Name='archived';Path=$null}
        )
    }
}
function Invoke-GptUsageDeviceOperation {
    param($ProfileRoot, [scriptblock]$Action)
    $script:Held = $true
    try { & $Action } finally { $script:Held = $false }
}
function Invoke-GptUsageOpen {
    param($Model, $Profile, [scriptblock]$StartBrowser)
    if (-not $script:Held) { throw 'Device mutex must be held during discovery.' }
    $selected = @($Model.Profiles | Where-Object { $_.Path -and (-not $Profile -or $_.Name -ceq $Profile) })
    if ($Profile -and $selected.Count -ne 1) { throw 'Local profile not found.' }
    foreach ($entry in $selected) {
        & $StartBrowser $Model.EdgePath ('--no-first-run --user-data-dir="{0}" "https://chatgpt.com/#settings/Usage"' -f $entry.Path)
        Write-Host "Opened $($entry.Name)."
    }
}
Export-ModuleMember -Function Get-GptUsageModel
'@
    [IO.File]::WriteAllText((Join-Path $usage 'src/GptUsage.psm1'), $fakeModule)
    $send = Join-Path $root 'send-messages.ps1'
    $preview = ((& $send -RegistryPath $registry -DryRun -Seed test) -join "`n") | ConvertFrom-Json
    Assert-That ($preview.profiles.Count -eq 2) 'Dry run must select only local profiles.'
    Assert-That ($preview.profiles[0].prompts.Count -eq 2) 'Default must generate two questions.'
    $excluded = ((& $send -RegistryPath $registry -DryRun -ExcludeProfile one) -join "`n") | ConvertFrom-Json
    Assert-That ($excluded.profiles.Count -eq 1 -and $excluded.profiles[0].name -eq 'two') 'Completed profiles must be excludable.'
    $selected = ((& $send -RegistryPath $registry -DryRun -Profile two -QuestionCount 3 -Seed test) -join "`n") | ConvertFrom-Json
    Assert-That ($selected.profiles.Count -eq 1 -and $selected.profiles[0].name -eq 'two') 'Profile filter was lost.'
    Assert-That ($selected.profiles[0].prompts.Count -eq 3) 'Question count was lost.'
    foreach ($arguments in @(
        @{RegistryPath=$registry;Profile='missing'},
        @{RegistryPath=$registry;ExcludeProfile=@('one','two')},
        @{RegistryPath='relative.json'},
        @{RegistryPath=(Join-Path $usage 'profiles/missing.json')}
    )) {
        $rejected = $false
        try { & $send @arguments -DryRun }
        catch { $rejected = $true }
        Assert-That $rejected 'Invalid or empty selection must fail.'
    }
    $nodeFailure = Join-Path $temporary 'node-fails.cmd'
    [IO.File]::WriteAllText($nodeFailure, "@exit /b 7`r`n")
    $rejected = $false
    try { & $send -RegistryPath $registry -DryRun -NodePath $nodeFailure }
    catch { $rejected = $_.Exception.Message -match 'exit code 7' }
    Assert-That $rejected 'Node failures must propagate.'
    Write-Host 'PowerShell adapter tests: OK (offline only).'
}
finally {
    $env:GPT_MESSAGE_TEST_ROOT = $previousRoot
    Remove-Module GptUsage -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Recurse -Force }
}
