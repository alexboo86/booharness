param([Alias('Home')][string]$HomeDirectory)
$ErrorActionPreference = 'Stop'
$cliArgs = @("$PSScriptRoot/cli.mjs", 'uninstall')
if ($PSBoundParameters.ContainsKey('HomeDirectory')) { $cliArgs += @('--home', $HomeDirectory) }
& node @cliArgs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
