# libr4

Biblioteca JavaScript/CSS sem dependências: interface, formulários, gráficos, tema e mídia (áudio, vídeo, imagem, piano roll, editor de linha do tempo). Funciona por JS (`R4.x(...)`) ou por tags `<r4-...>`. Tudo é código próprio, sem bibliotecas de terceiros.

Demonstração de todos os elementos: link da vitrine em breve.

## Uso rápido

Baixe `dist/libr4.min.js` e `dist/libr4.min.css` (ou use o CDN abaixo) e inclua na página:

```html
<link rel="stylesheet" href="libr4.min.css">
<script src="libr4.min.js"></script>
```

Pelo CDN (jsDelivr), fixando uma versão e verificando a integridade (os hashes `sha384` estão em `dist/manifest.json`):

```html
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/Otavio1661/libr4@v2.1.0/dist/libr4.min.css">
<script src="https://cdn.jsdelivr.net/gh/Otavio1661/libr4@v2.1.0/dist/libr4.min.js"
        integrity="sha384-..." crossorigin="anonymous"></script>
```

| Arquivo | Conteúdo |
|---|---|
| `dist/libr4.min.js` / `.css` | tudo, minificado (~981 KB JS, ~327 KB com gzip) |
| `dist/modules/<nome>.min.js` | um arquivo por módulo |
| `dist/manifest.json` | versão, módulos, tamanhos e hashes SRI |
| `src/` | fontes legíveis |

## Usar só o que precisa

Os módulos de mídia são a maior parte do peso. Para gerar um pacote sob medida (as dependências entre módulos entram sozinhas):

```sh
php tools/build.php --list                      # módulos disponíveis
php tools/build.php --modules=core,ui,form      # gera dist-custom/ (~100 KB com gzip)
```

Sem PHP instalado: `docker run --rm -v "$PWD":/app -w /app php:8.3-cli php tools/build.php --modules=core,ui,form`.

Também dá para incluir à mão os arquivos de `dist/modules/`, na ordem de `php tools/build.php --list` (cada módulo exige os anteriores dos quais depende, listados em `src/deps.json`).

## Ligar tags entre si (`r4-on`)

Um componente pode comandar outro só com HTML, sem JavaScript: `r4-on="evento:#alvo.metodo; outro:#alvo2.metodo2"`. Quando o evento dispara, a biblioteca chama o método público do componente de id `alvo` (o primeiro argumento do evento, o próprio componente, é descartado; o resto é repassado).

```html
<r4-recorder id="rec" r4-on="done:#editor.load"></r4-recorder>
<r4-audioeditor id="editor" format="wav"></r4-audioeditor>
<button class="r4-btn" r4-click="download:#editor">Baixar</button>
```

- Argumentos fixos em JSON: `click:#piano.noteOn("C4")`.
- Ações globais: `done:toast:Pronto`, `done:download:#id`.
- Funciona também em elementos comuns (`<button r4-on="click:#editor.play">`), com eventos do DOM.
- O alvo pode montar depois (a chamada espera até 5 s). Só métodos públicos: nomes com `_`, `constructor` e `__proto__` são recusados; nada é avaliado como código.
- `r4-click="download:#id"` baixa o `.blob`/`getBlob()` do alvo.

Os componentes de mídia aceitam o resultado uns dos outros em `load()` / `add()` (arquivo, `Blob` ou `{ blob, name }`) e avisam o fim com `done(cmp, blob, info)`: `recorder`, `audioeditor` (`apply()`), `imageeditor` (`apply()`), `videoeditor`, `converter`, `pianoroll` (exportar WAV) e `timelineeditor`.

## Gravador (`<r4-recorder>`)

```html
<r4-recorder source="mic"></r4-recorder>      <!-- mic (padrão), screen ou camera -->
```

Gravar, pausar, parar, cronômetro, medidor de nível ao vivo, lista de gravações com player, baixar e descartar. Eventos `start`, `pause`, `resume`, `stop`, `done` e `error`; falha com mensagem clara sem permissão, sem microfone ou fora de HTTPS/localhost. Nada é enviado a servidor.

## Tema "r4site"

Visual escuro, quadrado e denso. Inclua o CSS normal e marque o elemento:

```html
<html data-r4-theme="r4site">
```

O tema só troca as variáveis `--r4-*` (fundo, linhas, cor de destaque, raio zero, fonte Inter), então vale também para um trecho da página.

## Build

```sh
php tools/build.php
```

Só PHP (CLI), sem Node nem npm. Gera `dist/` de forma determinística e valida a minificação.

## Licença

[MIT](LICENSE). Uso livre em projetos pessoais e comerciais; é obrigatório manter o aviso de copyright e a licença (crédito a R4dev) nas cópias e em trabalhos derivados. Os arquivos em `dist/` já trazem esse aviso na primeira linha, não o remova.

## Contribuir

Veja [CONTRIBUTING.md](CONTRIBUTING.md).
