<#
.SYNOPSIS
  Instala a API do Grupo Sampaio ERP como tarefa do Windows que sobe com a
  maquina e se levanta sozinha quando cai (GAP-PRD-013).

.DESCRIPTION
  Registra a tarefa agendada "Grupo Sampaio ERP - API", que roda na partida do
  Windows, como SYSTEM, o supervisor do sistema:

      node server\dist\scripts\supervisionar-api.js

  O supervisor sobe a API, a levanta de novo quando ela cai (espera crescente,
  1 s ate 60 s) e grava o log em server\data\logs, um arquivo por dia.
  Encerrar a tarefa pede a API que desca limpa (fecha conexoes e o banco).

  Antes de registrar, roda a conferencia da implantacao
  (server\dist\scripts\conferir-implantacao.js) e PARA se algo bloqueia.

  Opcional: -Caddy <caminho do caddy.exe> registra tambem a tarefa
  "Grupo Sampaio ERP - HTTPS", que roda o Caddy com deploy\caddy\Caddyfile.

  Rode num PowerShell aberto como Administrador, depois de:
    1. npm ci ; npm ci --prefix server
    2. definir VITE_API_BASE_URL=/ e rodar npm run build
    3. copiar .env.production.example para .env e preencher
       (DEVORA_SERVIR_FRONTEND=true para a API servir as telas)

.PARAMETER Pasta
  Raiz da instalacao (onde estao o .env e server\dist). Padrao: duas pastas
  acima deste script.

.PARAMETER Nome
  Nome da tarefa. Padrao: "Grupo Sampaio ERP - API".

.PARAMETER Caddy
  Caminho do caddy.exe, para registrar tambem o HTTPS. Opcional.

.PARAMETER Ensaio
  Mostra o que faria e confere os pre-requisitos, sem registrar nada.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File deploy\windows\instalar-servico.ps1 -Ensaio

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File deploy\windows\instalar-servico.ps1 -Caddy C:\caddy\caddy.exe
#>
[CmdletBinding()]
param(
  [string]$Pasta = '',
  [string]$Nome = 'Grupo Sampaio ERP - API',
  [string]$Caddy = '',
  [switch]$Ensaio
)

$ErrorActionPreference = 'Stop'

if (-not $Pasta) { $Pasta = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path }

$problemas = New-Object System.Collections.Generic.List[string]

$comandoNode = Get-Command node -ErrorAction SilentlyContinue
if (-not $comandoNode) {
  $problemas.Add('Node nao encontrado no PATH. Instale o Node 24 LTS.')
  $node = 'node.exe'
} else {
  $node = $comandoNode.Source
}

$supervisor = Join-Path $Pasta 'server\dist\scripts\supervisionar-api.js'
$conferencia = Join-Path $Pasta 'server\dist\scripts\conferir-implantacao.js'
$arquivoEnv = Join-Path $Pasta '.env'

if (-not (Test-Path $supervisor)) { $problemas.Add("Nao achei $supervisor. Rode 'npm run build' em $Pasta.") }
if (-not (Test-Path $arquivoEnv)) { $problemas.Add("Nao achei $arquivoEnv. Copie .env.production.example para .env e preencha.") }

$caddyfile = Join-Path $Pasta 'deploy\caddy\Caddyfile'
if ($Caddy) {
  if (-not (Test-Path $Caddy)) { $problemas.Add("Nao achei o Caddy em $Caddy.") }
  if (-not (Test-Path $caddyfile)) { $problemas.Add("Nao achei $caddyfile. Copie deploy\caddy\Caddyfile.example e troque o dominio.") }
}

Write-Host "Instalacao : $Pasta"
Write-Host "Node       : $node"
Write-Host "Tarefa     : $Nome (na partida do Windows, como SYSTEM)"
Write-Host "Comando    : `"$node`" `"$supervisor`""
if ($Caddy) { Write-Host "HTTPS      : `"$Caddy`" run --config `"$caddyfile`"" }
Write-Host ''

# A conferencia roda na pasta da instalacao, lendo o .env como a API le.
if (Test-Path $conferencia) {
  Push-Location $Pasta
  try {
    & $node $conferencia
    $codigo = $LASTEXITCODE
  } finally {
    Pop-Location
  }
  if ($codigo -ne 0) { $problemas.Add('A conferencia da implantacao BLOQUEIA (ver acima).') }
  Write-Host ''
}

if ($problemas.Count -gt 0) {
  Write-Host 'Pre-requisitos que faltam:' -ForegroundColor Yellow
  foreach ($p in $problemas) { Write-Host "  - $p" -ForegroundColor Yellow }
  if (-not $Ensaio) { throw 'Nada foi instalado. Resolva os itens acima e rode de novo.' }
}

if ($Ensaio) {
  Write-Host 'ENSAIO: nada foi registrado.'
  return
}

$identidade = [Security.Principal.WindowsIdentity]::GetCurrent()
$papel = New-Object Security.Principal.WindowsPrincipal($identidade)
if (-not $papel.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Rode este script num PowerShell aberto como Administrador.'
}

function Registrar-Tarefa([string]$nomeDaTarefa, [string]$executavel, [string]$argumentos, [string]$descricao) {
  $acao = New-ScheduledTaskAction -Execute $executavel -Argument $argumentos -WorkingDirectory $Pasta
  $gatilho = New-ScheduledTaskTrigger -AtStartup
  # Sem limite de tempo; se a propria tarefa falhar, o Windows tenta de novo a
  # cada minuto. Quem levanta a API quando ELA cai e o supervisor.
  $config = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  Register-ScheduledTask -TaskName $nomeDaTarefa -Action $acao -Trigger $gatilho -Settings $config `
    -Principal $principal -Description $descricao -Force | Out-Null
  Start-ScheduledTask -TaskName $nomeDaTarefa
  Write-Host "Tarefa '$nomeDaTarefa' registrada e iniciada."
}

Registrar-Tarefa $Nome $node "`"$supervisor`"" 'Grupo Sampaio ERP: a API, sob o supervisor que a levanta quando cai.'

if ($Caddy) {
  Registrar-Tarefa 'Grupo Sampaio ERP - HTTPS' $Caddy "run --config `"$caddyfile`"" 'Grupo Sampaio ERP: HTTPS (Caddy) na frente da API.'
}

Write-Host ''
Write-Host 'Pronto. O log fica em server\data\logs (um arquivo por dia).'
Write-Host 'Confira em Configuracoes > Implantacao, no sistema, que a API esta sob o supervisor.'
Write-Host 'Para remover: deploy\windows\remover-servico.ps1'
