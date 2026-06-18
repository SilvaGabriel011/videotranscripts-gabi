#!/bin/bash
#
# YouTube Transcript Extractor — setup (macOS / Linux)
#
# Instala as dependências e prepara o ambiente para rodar localmente.
# Equivalente ao setup.ps1 (Windows).
#
# Uso:
#   ./setup.sh
#   (se der "Permission denied":  chmod +x setup.sh  e rode de novo)
#
# Depois de rodar:
#   Web :  npm run web   ->  http://localhost:3000
#   CLI :  npx tsx scripts/youtube-transcript.ts "<url do youtube>"

set -e

# Vai para a pasta do script e garante que os binários do Homebrew estejam no PATH
# (Apple Silicon usa /opt/homebrew, Intel usa /usr/local).
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

have() { command -v "$1" >/dev/null 2>&1; }

echo "== YouTube Transcript Extractor - setup =="

# 1. Node / npm (obrigatorio, >= 20.12 por causa de process.loadEnvFile)
if ! have node; then
  echo "[X] Node.js nao encontrado."
  if have brew; then
    echo "-> instalando Node via Homebrew ..."
    brew install node
  else
    echo "    Instale o Homebrew (https://brew.sh) e depois 'brew install node',"
    echo "    ou baixe o Node 20.12+ em https://nodejs.org . Rode este script de novo."
    exit 1
  fi
fi
echo "[ok] node $(node --version) / npm $(npm --version)"

# 2. Dependencias do projeto (Next, React, openai, youtube-transcript, jszip, etc.)
echo ""
echo "-> npm install ..."
npm install

# 3. yt-dlp (so para o fallback Whisper em videos SEM legenda)
if have yt-dlp; then
  echo "[ok] yt-dlp presente"
elif have brew; then
  echo "-> instalando yt-dlp via Homebrew (fallback Whisper) ..."
  brew install yt-dlp
elif have pip3; then
  echo "-> instalando yt-dlp via pip3 (fallback Whisper) ..."
  pip3 install yt-dlp
else
  echo "[aviso] yt-dlp ausente. Videos COM legenda funcionam mesmo assim;"
  echo "        so o fallback Whisper (videos sem legenda) precisa de yt-dlp."
fi

# 4. ffmpeg (so para o fallback Whisper)
if have ffmpeg; then
  echo "[ok] ffmpeg presente"
elif have brew; then
  echo "-> instalando ffmpeg via Homebrew ..."
  brew install ffmpeg
else
  echo "[aviso] ffmpeg ausente (so necessario p/ o fallback Whisper)."
  echo "        Instale o Homebrew (https://brew.sh) e rode 'brew install ffmpeg'."
fi

# 5. .env (chave da OpenAI - a SUA propria)
if [ ! -f .env ]; then
  cp .env.example .env
  echo "[ok] .env criado a partir do .env.example - edite e preencha OPENAI_API_KEY (a sua)."
else
  echo "[ok] .env ja existe"
fi

echo ""
echo "== Pronto! =="
echo "Web :  npm run web      ->  http://localhost:3000"
echo "CLI :  npx tsx scripts/youtube-transcript.ts \"https://www.youtube.com/watch?v=ID\""
echo "       flags:  --lang pt   |   --topics  (capitulos por tema, via OpenAI)"
echo "Test:  npm test"
echo ""
echo "Obs: legendas do YouTube funcionam SEM chave. OPENAI_API_KEY (no .env) so e"
echo "     necessaria p/ o fallback Whisper (videos sem legenda) e p/ --topics."
