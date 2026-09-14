<#
.SYNOPSIS
  Remove as tarefas do Grupo Sampaio ERP registradas por instalar-servico.ps1.

.DESCRIPTION
  Primeiro pede a API que desca limpa, pelo canal do supervisor
  (server\dist\scripts\parar-api.js): ela termina o que esta em andamento,
  fecha as conexoes e o banco. So depois encerra e remove
  "Grupo Sampaio ERP - API" (e "Grupo Sampaio ERP - HTTPS", se existir).

  Encerrar a tarefa sem esse primeiro passo derrubaria a API na hora: no
  Windows ela esta no mesmo "job" do supervisor e morre junto.

  Nenhum dado e apagado: banco, fotos, backups e logs ficam onde estao.

  Rode num PowerShell aberto como Administrador.

.PARAMETER Pasta
  Raiz da instalacao. Padrao: duas pastas acima deste script.

.PARAMETER Ensaio
  Mostra o que faria, sem parar nem remover nada.
#>
[CmdletBinding()]
param(
  [string]$Pasta = '',
  [string]$Nome = 'Grupo Sampaio ERP - API',
  [switch]$Ensaio
)

$ErrorActionPreference = 'Stop'

if (-not $Pasta) { $Pasta = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path }
$parar = Join-Path $Pasta 'server\dist\scripts\parar-api.js'
$comandoNode = Get-Command node -ErrorAction SilentlyContinue

if ($Ensaio) {
  Write-Host "ENSAIO: pediria a parada limpa com `"$parar`"."
} elseif ($comandoNode -and (Test-Path $parar)) {
  Push-Location $Pasta
  try {
    & $comandoNode.Source $parar
  } finally {
    Pop-Location
  }
} else {
  Write-Host "Nao consegui pedir a parada limpa (node ou $parar ausente). A tarefa sera encerrada a forca." -ForegroundColor Yellow
}

foreach ($tarefa in @($Nome, 'Grupo Sampaio ERP - HTTPS')) {
  $existente = Get-ScheduledTask -TaskName $tarefa -ErrorAction SilentlyContinue
  if (-not $existente) {
    Write-Host "Tarefa '$tarefa' nao existe."
    continue
  }
  if ($Ensaio) {
    Write-Host "ENSAIO: removeria a tarefa '$tarefa'."
    continue
  }
  Stop-ScheduledTask -TaskName $tarefa -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $tarefa -Confirm:$false
  Write-Host "Tarefa '$tarefa' removida."
}
