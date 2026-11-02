param([Parameter(Mandatory = $true)][string]$Bundle, [Alias('Home')][string]$HomeDirectory)
$ErrorActionPreference = 'Stop'
# Pairing JSON stays out of process arguments.
$pairing = [Console]::In.ReadToEnd()
$cliArgs = @("$PSScriptRoot/cli.mjs", 'install', '--bundle', $Bundle)
if ($PSBoundParameters.ContainsKey('HomeDirectory')) { $cliArgs += @('--home', $HomeDirectory) }
$pairing | & node @cliArgs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
