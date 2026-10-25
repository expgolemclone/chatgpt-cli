#requires -Version 7.0
param([Parameter(Mandatory)][int]$MaxPrompts)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$temporary = Join-Path 'C:/dev/tmp' ('gpt-message-scripts-' + [guid]::NewGuid().ToString('N'))
$previousRoot = $env:GPT_MESSAGE_TEST_ROOT

function Assert-That([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}
try {
    $usage = Join-Path $temporary 'gpt-usage'
    $product = Join-Path $temporary 'gpt-send-messages'
    $null = New-Item -ItemType Directory -Path (Join-Path $usage 'src'), $product -Force
    Copy-Item -LiteralPath (Join-Path $root 'send-messages.ps1') -Destination $product
    $null = New-Item -ItemType Directory -Path (Join-Path $product 'dist')
    Copy-Item -LiteralPath (Join-Path $root 'dist/src') -Destination (Join-Path $product 'dist/src') -Recurse
    $null = New-Item -ItemType Junction -Path (Join-Path $product 'node_modules') -Target (Join-Path $root 'node_modules')
    $profiles = Join-Path $temporary 'profiles'
    foreach ($name in @('one', 'two')) { $null = New-Item -ItemType Directory -Path (Join-Path $profiles $name) -Force }
    $env:GPT_MESSAGE_TEST_ROOT = $profiles
    $fakeModule = @'
$script:EdgeArguments = @('--no-first-run', '--no-default-browser-check')
function Get-GptUsageModel {
    param([switch]$RequireEdge)
    if (-not $RequireEdge) { throw 'Edge validation is required.' }
    [pscustomobject]@{
        ProfileRoot = $env:GPT_MESSAGE_TEST_ROOT
        EdgePath = (Get-Command node -CommandType Application | Select-Object -First 1).Source
        Profiles = @(
            [pscustomobject]@{Id=('a' * 32);Name='one';Path=(Join-Path $env:GPT_MESSAGE_TEST_ROOT 'one')},
            [pscustomobject]@{Id=('b' * 32);Name='two';Path=(Join-Path $env:GPT_MESSAGE_TEST_ROOT 'two')}
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
    $selected = @($Model.Profiles | Where-Object { -not $Profile -or $_.Name -ceq $Profile })
    if ($Profile -and $selected.Count -ne 1) { throw 'Local profile not found.' }
    foreach ($entry in $selected) {
        & $StartBrowser $Model.EdgePath ('--no-first-run --user-data-dir="{0}" "https://chatgpt.com/#settings/Usage"' -f $entry.Path)
        Write-Host "Opened $($entry.Name)."
    }
}
Export-ModuleMember -Function Get-GptUsageModel
'@
    [IO.File]::WriteAllText((Join-Path $usage 'src/GptUsage.psm1'), $fakeModule)
    $send = Join-Path $product 'send-messages.ps1'
    $preview = ((& $send -DryRun -Seed test) -join "`n") | ConvertFrom-Json
    Assert-That ($preview.profiles.Count -eq 2) 'Dry run must select only local profiles.'
    Assert-That ($preview.profiles[0].prompts.Count -eq 2) 'Default must generate two prompts.'
    $excluded = ((& $send -DryRun -ExcludeProfile one) -join "`n") | ConvertFrom-Json
    Assert-That ($excluded.profiles.Count -eq 1 -and $excluded.profiles[0].name -eq 'two') 'Completed profiles must be excludable.'
    $selected = ((& $send -DryRun -Profile two -QuestionCount 7 -Seed test) -join "`n") | ConvertFrom-Json
    Assert-That ($selected.profiles.Count -eq 1 -and $selected.profiles[0].name -eq 'two') 'Profile filter was lost.'
    Assert-That ($selected.profiles[0].prompts.Count -eq 7) 'Counts above the old limit must reach the generator.'
    $sample = ((& $send -DryRun -Profile one -QuestionCount 100 -Seed test) -join "`n") | ConvertFrom-Json
    Assert-That ($sample.profiles[0].prompts.Count -eq 100) 'Larger batches must reach the generator.'
    Assert-That (@($sample.profiles[0].prompts | Where-Object text -Like '@create image*').Count -gt 0) 'Image prompt text was lost.'
    Assert-That (@($sample.profiles[0].prompts | Where-Object text -Like 'Codexを社内で導入検討している.*').Count -gt 0) 'Codex adoption prompt text was lost.'
    foreach ($prompt in $sample.profiles[0].prompts) {
        Assert-That (($prompt.text -split ', ').Count -eq 4) 'Prompts must contain four comma-separated parts.'
    }
    foreach ($arguments in @(
        @{Profile='missing'},
        @{ExcludeProfile=@('one','two')},
        @{QuestionCount=0},
        @{QuestionCount=-1},
        @{QuestionCount=1.5},
        @{QuestionCount='NaN'},
        @{QuestionCount='Infinity'},
        @{QuestionCount='invalid'},
        @{QuestionCount=($MaxPrompts + 1)}
    )) {
        $rejected = $false
        try { & $send @arguments -DryRun }
        catch { $rejected = $true }
        Assert-That $rejected 'Invalid or empty selection must fail.'
    }
    $nodeFailure = Join-Path $temporary 'node-fails.cmd'
    [IO.File]::WriteAllText($nodeFailure, "@exit /b 7`r`n")
    $rejected = $false
    try { & $send -DryRun -NodePath $nodeFailure }
    catch { $rejected = $_.Exception.Message -match 'exit code 7' }
    Assert-That $rejected 'Node failures must propagate.'
    Write-Host 'PowerShell adapter tests: OK (offline only).'
}
finally {
    $env:GPT_MESSAGE_TEST_ROOT = $previousRoot
    Remove-Module GptUsage -Force -ErrorAction SilentlyContinue
    $junction = Join-Path $temporary 'gpt-send-messages/node_modules'
    if (Test-Path -LiteralPath $junction) { Remove-Item -LiteralPath $junction }
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Recurse -Force }
}
