# libr4

Biblioteca JavaScript/CSS sem dependências: interface, formulários, gráficos, tema e mídia (áudio, vídeo, imagem, piano roll, editor de linha do tempo). Funciona por JS (`R4.x(...)`) ou por tags `<r4-...>`. Tudo é código próprio, sem bibliotecas de terceiros.

Demonstração de todos os elementos: _adicione aqui o link da vitrine_.

## Uso rápido

Baixe `dist/libr4.min.js` e `dist/libr4.min.css` (ou use o CDN abaixo) e inclua na página:

```html
<link rel="stylesheet" href="libr4.min.css">
<script src="libr4.min.js"></script>
```

Pelo CDN (jsDelivr), fixando uma versão e verificando a integridade (os hashes `sha384` estão em `dist/manifest.json`):

```html
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/Otavio1661/libr4@v2.0.0/dist/libr4.min.css">
<script src="https://cdn.jsdelivr.net/gh/Otavio1661/libr4@v2.0.0/dist/libr4.min.js"
        integrity="sha384-..." crossorigin="anonymous"></script>
```

| Arquivo | Conteúdo |
|---|---|
| `dist/libr4.min.js` / `.css` | tudo, minificado (~962 KB JS, ~321 KB com gzip) |
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

## Build

```sh
php tools/build.php
```

Só PHP (CLI), sem Node nem npm. Gera `dist/` de forma determinística e valida a minificação.

## Licença

[MIT](LICENSE). Uso livre em projetos pessoais e comerciais; é obrigatório manter o aviso de copyright e a licença (crédito a R4dev) nas cópias e em trabalhos derivados. Os arquivos em `dist/` já trazem esse aviso na primeira linha, não o remova.

## Contribuir

Veja [CONTRIBUTING.md](CONTRIBUTING.md).
