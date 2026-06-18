<#
  YouTube Transcript Extractor — setup (Windows / PowerShell)

  Instala as dependências e prepara o ambiente para rodar localmente.

  Uso:
    powershell -ExecutionPolicy Bypass -File .\setup.ps1

  Depois de rodar:
    Web :  npm run web   ->  http://localhost:3000
    CLI :  npx tsx scripts/youtube-transcript.ts "<url do youtube>"

  (Mac/Linux: os passos manuais equivalentes são
     npm install  &&  pip install yt-dlp  &&  cp .env.example .env  &&  npm run web)
#>

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

function Have([string]$cmd) { return [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

Write-Host "== YouTube Transcript Extractor - setup ==" -ForegroundColor Cyan

# 1. Node / npm (obrigatorio)
if (-not (Have node)) {
  Write-Host "[X] Node.js nao encontrado. Instale o Node 18+ (https://nodejs.org) e rode de novo." -ForegroundColor Red
  exit 1
}
Write-Host "[ok] node $(node --version) / npm $(npm --version)"

# 2. Dependencias do projeto (Next, React, openai, youtube-transcript, jszip, etc.)
Write-Host "`n-> npm install ..." -ForegroundColor Cyan
npm install
if ($LASTEXITCODE -ne 0) {
  Write-Host "[X] npm install falhou (codigo $LASTEXITCODE)." -ForegroundColor Red
  exit 1
}

# 3. yt-dlp (opcional - so para o fallback Whisper em videos SEM legenda)
if (Have yt-dlp) {
  Write-Host "[ok] yt-dlp presente"
} elseif (Have pip) {
  Write-Host "-> instalando yt-dlp via pip (fallback Whisper) ..." -ForegroundColor Cyan
  pip install yt-dlp
} else {
  Write-Host "[aviso] yt-dlp e pip ausentes. Videos COM legenda funcionam mesmo assim;" -ForegroundColor Yellow
  Write-Host "        so o fallback Whisper (videos sem legenda) precisa de yt-dlp." -ForegroundColor Yellow
}

# 4. ffmpeg (opcional - so para o fallback Whisper)
if (Have ffmpeg) {
  Write-Host "[ok] ffmpeg presente"
} else {
  Write-Host "[aviso] ffmpeg ausente (so necessario p/ o fallback Whisper)." -ForegroundColor Yellow
  Write-Host "        Instale com:  winget install Gyan.FFmpeg   (ou https://ffmpeg.org)" -ForegroundColor Yellow
}

# 5. .env (chave da OpenAI)
if (-not (Test-Path .env)) {
  Copy-Item .env.example .env
  Write-Host "[ok] .env criado a partir do .env.example - edite e preencha OPENAI_API_KEY." -ForegroundColor Yellow
} else {
  Write-Host "[ok] .env ja existe"
}

Write-Host "`n== Pronto! ==" -ForegroundColor Green
Write-Host "Web :  npm run web      ->  http://localhost:3000"
Write-Host "CLI :  npx tsx scripts/youtube-transcript.ts `"https://www.youtube.com/watch?v=ID`""
Write-Host "       flags:  --lang pt   |   --topics  (capitulos por tema, via OpenAI)"
Write-Host "Test:  npm test"
Write-Host ""
Write-Host "Obs: legendas do YouTube funcionam SEM chave. OPENAI_API_KEY (no .env) so e"
Write-Host "     necessaria p/ o fallback Whisper (videos sem legenda) e p/ --topics."
