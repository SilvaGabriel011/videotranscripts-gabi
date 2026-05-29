# YouTube Transcript Extractor — Plano de Implementação

## Contexto

O usuário quer um utilitário que receba uma URL do YouTube e gere o transcript do vídeo em `.txt`. O projeto já tem uma pasta `scripts/` com scripts utilitários em TypeScript executados via `tsx` — este script segue exatamente esse padrão.

---

## Abordagem

Script standalone em `scripts/youtube-transcript.ts` que aceita **uma ou várias URLs**
e as processa **em fila (sequencial)**. Para cada URL, dois modos:

1. **Modo principal**: busca as legendas do YouTube (sem API key) via `youtube-transcript`
2. **Fallback automático**: se o vídeo não tiver legenda, baixa o áudio com `yt-dlp` e transcreve via **OpenAI Whisper API** (requer `OPENAI_API_KEY` + `yt-dlp` instalado)

Timestamps **dinâmicos**: agrupados pelos silêncios naturais da fala (gap > 1.5s entre segmentos = novo parágrafo com novo timestamp), não por blocos fixos.

**Nome do arquivo de saída** = título do vídeo (obtido via YouTube oEmbed, sem API key),
sanitizado para nome de arquivo válido. Fallback para o video ID se oEmbed falhar.

**Tolerância a falhas**: se uma URL da fila falhar, registra o erro e continua com as
próximas. No fim, imprime um resumo (✓ sucessos / ✗ falhas com motivo).

---

## Arquivos a criar/modificar

| Arquivo | Ação |
|---------|------|
| `scripts/youtube-transcript.ts` | Criar (script principal) |
| `package.json` | Adicionar dependências + script npm |

---

## Dependências

```bash
npm install youtube-transcript openai
# yt-dlp: ferramenta externa (Python), instalada separadamente pelo usuário
# pip install yt-dlp  OU  brew install yt-dlp
```

Adicionar ao `package.json` scripts:
```json
"transcript:youtube": "tsx scripts/youtube-transcript.ts"
```

---

## Script: `scripts/youtube-transcript.ts`

### Estrutura geral

```typescript
import * as fs from 'fs'
import * as path from 'path'
import * as cp from 'child_process'
import { YoutubeTranscript } from 'youtube-transcript'
import OpenAI from 'openai'
```

### Helpers reutilizáveis

**`extractVideoId(url)`** — extrai o ID das três formas de URL do YouTube.

**`decodeHtmlEntities(text)`** — decodifica `&#39;` → `'`, `&amp;` → `&` etc.

**`formatTimestamp(ms)`** — converte milissegundos em `[MM:SS]`.

**`getVideoTitle(videoId)`** — busca o título via oEmbed (sem API key):
`fetch('https://www.youtube.com/oembed?url=https://youtu.be/' + videoId + '&format=json')`
→ retorna `.title`. Se falhar, retorna `null`.

**`sanitizeFilename(title)`** — remove `/ \ : * ? " < > |` e acentos problemáticos,
limita tamanho (~120 chars), troca espaços por `-`. Ex: `"Nunca Vou Te Dar Up!"`
→ `"Nunca-Vou-Te-Dar-Up.txt"`. Se já existir arquivo, anexa ` (2)`, ` (3)` etc.

**`buildTimestampedText(segments)`** — DINÂMICO: agrupa segmentos por silêncios naturais.

```
lógica: para cada segmento, calcula o gap até o próximo
  gap = segments[i+1].offset - (segments[i].offset + segments[i].duration)
  se gap > 1500ms → fecha parágrafo atual, abre novo com timestamp
resultado: um parágrafo por "fala contínua", timestamp somente no início
```

Exemplo de output:
```
[00:00] Olá pessoal, seja bem-vindo a mais um vídeo do canal, hoje vamos falar sobre...
[00:32] Mas antes de começar, não esquece de se inscrever e ativar o sininho
[00:45] Então vamos lá! Primeiro ponto importante é que...
```

**`buildPlainText(segments)`** — texto corrido sem timestamps, sem quebras artificiais.

---

### Fluxo principal

```
0. Parse args: separar flags (--lang pt) das URLs. Coletar TODAS as URLs.
   Se nenhuma URL → mensagem de uso.

1. FILA: para cada URL (sequencial), executar processOne(url) num try/catch.
   Acumular { url, status: 'ok'|'erro', arquivo?, motivo? } em results[].
   Log de progresso: "[2/5] Processando https://...".

=== processOne(url) ===
2. Extrair videoId da URL (se inválida → throw, fila continua)
3. Buscar título via getVideoTitle(videoId) → define nome do arquivo
4. [MODO 1] Tentar YoutubeTranscript.fetchTranscript(videoId, { lang })
   └── sucesso → formatar e salvar
   └── falha (sem legenda) → [MODO 2] Whisper fallback

4. [MODO 2 - Fallback Whisper]
   a. Checar se OPENAI_API_KEY está definida (senão erro claro)
   b. Checar se yt-dlp e ffmpeg estão instalados (senão erro claro)
   c. Baixar áudio comprimido: yt-dlp -x --audio-format mp3 --audio-quality 9 -o /tmp/[videoId].mp3 [url]
   d. CHUNKING (limite 25MB do Whisper):
      - Se arquivo > 24MB, dividir com ffmpeg em pedaços de N minutos:
        ffmpeg -i input.mp3 -f segment -segment_time 600 -c copy /tmp/[videoId]-chunk-%03d.mp3
        (600s = 10 min por pedaço; mantém folga abaixo de 25MB)
      - Se <= 24MB, usar o arquivo único como "pedaço 0"
   e. Para cada pedaço i (em ordem):
      openai.audio.transcriptions.create({
        file: fs.createReadStream(chunkPath),
        model: 'whisper-1',
        response_format: 'verbose_json',
        language: lang ?? undefined
      })
      - Somar offset acumulado: cada segmento do pedaço i tem seu start/end
        deslocado por (i * segment_time) para manter timeline contínua
   f. Mapear TODOS os segmentos → { text, offset (start*1000), duration ((end-start)*1000) }
      ATENÇÃO: Whisper usa SEGUNDOS, YouTube usa MILISSEGUNDOS — converter ×1000
   g. Deletar arquivos temporários (/tmp/[videoId]*.mp3)
   h. Formatar e salvar igual ao modo 1

5. Salvar [Título-do-Vídeo].txt com header + seções (fallback: [videoId].txt)
6. Imprimir prévia no terminal e retornar nome do arquivo
=== fim processOne ===

7. Após a fila: imprimir RESUMO
   ✓ N vídeos transcritos: lista de arquivos gerados
   ✗ M falhas: lista de URL + motivo
```

### Pontos de atenção (verificar ao codar)

- **API `youtube-transcript`**: confirmar assinatura real após instalar (`fetchTranscript`
  estático vs instância). Ajustar se necessário.
- **Unidades de tempo**: YouTube = ms, Whisper = segundos. Centralizar a normalização
  para `{ text, offset(ms), duration(ms) }` antes de formatar.
- **ffmpeg**: necessário tanto pro yt-dlp extrair mp3 quanto pro chunking. Adicionar
  à checagem de pré-requisitos.
- **Custo Whisper**: ~US$0.006/min de áudio. Avisar no log quantos minutos serão enviados.

---

### Output format

```
YouTube Transcript
Video ID : dQw4w9WgXcQ
URL      : https://youtu.be/dQw4w9WgXcQ
Fonte    : YouTube Captions | OpenAI Whisper
Idioma   : pt
Segmentos: 47
Extraído : 2026-05-28T...

============================================================

## TEXTO CORRIDO

Olá pessoal seja bem-vindo a mais um vídeo do canal hoje vamos falar...

============================================================

## COM TIMESTAMPS

[00:00] Olá pessoal, seja bem-vindo a mais um vídeo do canal, hoje vamos falar sobre
[00:32] Mas antes de começar, não esquece de se inscrever e ativar o sininho
...
```

---

## Como usar

```bash
# Instalar dependências (uma vez)
npm install youtube-transcript openai
pip install yt-dlp          # ou: brew install yt-dlp
# ffmpeg também necessário: apt install ffmpeg / brew install ffmpeg

# Configurar API key da OpenAI (para fallback Whisper)
export OPENAI_API_KEY="sk-..."

# Um vídeo
npx tsx scripts/youtube-transcript.ts "https://youtu.be/VIDEO_ID"

# VÁRIOS vídeos (fila sequencial)
npx tsx scripts/youtube-transcript.ts "https://youtu.be/ID1" "https://youtu.be/ID2" "https://youtu.be/ID3"

# Com idioma específico (PT-BR) — aplica a todos
npx tsx scripts/youtube-transcript.ts --lang pt "https://youtu.be/ID1" "https://youtu.be/ID2"

# Ou via npm script
npm run transcript:youtube "https://youtu.be/ID1" "https://youtu.be/ID2"
```

**Output**: Um arquivo `.txt` por vídeo, nomeado pelo **título do vídeo**
(ex: `Nunca-Vou-Te-Dar-Up.txt`), no diretório atual, com duas seções:
- Texto corrido (para leitura/cópia)
- Texto com timestamps `[MM:SS]` (para referência)

---

## Verificação

1. Rodar com vídeo com legenda → gera `.txt` com timestamps dinâmicos seguindo pausas da fala
2. Rodar com vídeo sem legenda (com `OPENAI_API_KEY` + `yt-dlp` + `ffmpeg`) → baixa áudio, transcreve via Whisper, gera `.txt`
3. Vídeo longo sem legenda (> 24MB de áudio) → divide em pedaços, transcreve cada um, timestamps contínuos
4. Rodar com vídeo sem legenda e sem `OPENAI_API_KEY` → erro claro pedindo a chave
5. Rodar com vídeo sem legenda e sem `yt-dlp`/`ffmpeg` → erro claro pedindo instalação
6. Rodar sem argumento → mensagem de uso
7. Rodar com URL inválida → erro claro
8. `--lang pt` em vídeo com legenda em inglês → erro explicando idiomas disponíveis
9. **Várias URLs em fila** → processa todas em ordem, um `.txt` por vídeo
10. **Uma URL falha no meio da fila** → registra erro, continua as outras, mostra resumo final
11. **Nome do arquivo** → usa título do vídeo sanitizado; colisão de nome → ` (2)`
