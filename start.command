#!/bin/bash
#
# YouTube Transcript Extractor — launcher (macOS)
#
# DUPLO-CLIQUE neste arquivo para subir o app e abrir o navegador.
# Na 1a vez ele instala as dependencias automaticamente.
#
# Se o macOS reclamar ("nao foi possivel verificar o desenvolvedor"):
#   clique com o BOTAO DIREITO no arquivo -> Abrir -> Abrir.
#   (ou rode no Terminal: xattr -dr com.apple.quarantine "<pasta do projeto>")

# O Finder abre o script em $HOME, entao volta para a pasta do projeto.
cd "$(dirname "$0")"
# Scripts abertos pelo Finder nao herdam o PATH do shell: garante Homebrew/Node.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

echo "== YouTube Transcript Extractor =="

# Bootstrap na 1a vez: sem dependencias ou sem .env -> roda o setup.
if [ ! -d node_modules ] || [ ! -f .env ]; then
  echo "Primeira execucao: instalando dependencias..."
  bash ./setup.sh
  echo ""
  echo ">> Edite o arquivo .env e coloque sua OPENAI_API_KEY antes de usar os"
  echo "   recursos de IA (capitulos / videos sem legenda). Depois rode de novo."
fi

URL="http://localhost:3000"

# Abre o navegador assim que o servidor responder (em paralelo ao 'npm run web').
(
  for _ in $(seq 1 60); do
    if curl -s -o /dev/null "$URL"; then
      open "$URL"
      break
    fi
    sleep 1
  done
) &

echo ""
echo "Subindo o servidor... o navegador abre sozinho em $URL"
echo "(Para encerrar: feche esta janela ou pressione Ctrl-C)"
echo ""

# Servidor em foreground: os logs ficam visiveis e Ctrl-C encerra.
npm run web
