# Deploy — Grupo Sampaio ERP 1.0.0

## Node

**Node 24 LTS** (mínimo técnico: 22.5, por causa do `node:sqlite`). O
`package.json` declara `engines >= 22.5`, o `.nvmrc` diz 24, o Dockerfile e o
CI usam 24 — é uma versão só, de propósito. Node 20 **não sobe**: o servidor
morre no `import` de `node:sqlite`.

## Os dois artefatos

`npm run build` produz DOIS artefatos independentes, e o deploy é dos dois:

| Artefato | Sai em | Vai para |
| --- | --- | --- |
| Frontend (SPA estática) | `out/` | a própria API (`DEVORA_SERVIR_FRONTEND=true`) **ou** um host estático/nginx/CDN **com fallback de SPA** (`try_files $uri /index.html`) — sem ele, abrir `/login` ou `/pdv` direto responde 404 |
| API (Node) | `server/dist/` | processo Node persistente, porta `DEVORA_API_PORT` (8787), sob um supervisor que o levanta quando cai |

Com `DEVORA_SERVIR_FRONTEND=true` a API entrega o `out/` com o fallback de
SPA, cache longo só no `assets/` com hash e `no-cache` no `index.html` e no
`sw.js` — um processo e uma porta, e o proxy HTTPS encaminha tudo para ela. É
o desenho da imagem Docker e da publicação de referência abaixo. Ligada sem
`out/index.html`, a API **recusa subir** dizendo o que falta. Desligada (o
padrão), outro host serve as telas e encaminha `/api/v1` e `/uploads`.

### O que o build do frontend publica (GAP-PRD-210)

- **Sem mapa de fonte.** `vite build` não gera `.map` por padrão — o `.map`
  (6,4 MB) entregava o código-fonte inteiro do frontend a quem abrisse o
  DevTools. `DEVORA_BUILD_SOURCEMAP=hidden npm run build:frontend` gera os
  mapas SEM o comentário que os anuncia, para subir à ferramenta de erros:
  **não publique os `.map`** — apague-os de `out/` depois de subir. Qualquer
  outro valor (`true`, `inline`…) recusa o build. A variável é do BUILD, lida
  pelo `vite.config.ts` na máquina de quem builda: não vai no `.env` da
  instalação. A API responde 404 para todo `*.map` — inclusive `%2emap`,
  `.MAP`, `x.map.`, `x.map::$DATA`, `x.map/` e `x.map%5C.`, que o disco do
  Windows leria como o mesmo arquivo —, e os exemplos de `deploy/nginx` e
  `deploy/caddy` fazem o mesmo.
- **Uma tela por pedaço.** O pacote inicial leva a casca, as duas telas de
  login e o PDV (que vende sem rede e não pode depender de um pedaço à parte);
  as outras telas vêm cada uma no seu pedaço, baixado quando alguém a abre
  (`src/router/telas.tsx`). Medido no mesmo código: antes, um pacote único de
  1.723,77 kB (423,63 kB gzip) com o aviso de pedaço acima de 500 kB; depois,
  106 pedaços, o maior com 400,50 kB (115,85 kB gzip), sem o aviso.
- **Offline.** O build escreve `out/sw-precache.json` com todos os pedaços; o
  service worker (`public/sw.js`) guarda a lista inteira na instalação e a
  cada abertura com rede — é isso que traz os pedaços de um deploy novo antes
  de a rede cair — e descarta os do build anterior. Publique o
  `sw-precache.json` junto com o resto de `out/`, sem cache (como o `sw.js` e
  o `index.html`; a API e os exemplos já fazem assim).

## Publicação de referência (GAP-PRD-013)

Tudo o que é preciso para pôr no ar está em `deploy/`. O roteiro:

1. **Conferir.** Na raiz da instalação, com o `.env` preenchido:
   `node server/dist/scripts/conferir-implantacao.js` (na bancada:
   `npm run implantacao:conferir`). Responde item por item — ambiente, acesso
   rápido, chaves, origem das telas, HTTPS, proxy, quem serve as telas, banco,
   fotos, backup, log, variáveis sem efeito — e sai com 1 se algo BLOQUEIA.
2. **Buildar** para a mesma origem: `VITE_API_BASE_URL=/ npm run build`, e
   `DEVORA_SERVIR_FRONTEND=true` no `.env`.
3. **Serviço** — quem levanta a API quando ela cai:
   - **Windows (a loja):** `deploy/windows/instalar-servico.ps1`, num
     PowerShell de administrador (`-Ensaio` mostra o que faria). Registra a
     tarefa "Grupo Sampaio ERP - API", que sobe com o Windows e roda
     `server/dist/scripts/supervisionar-api.js`: o supervisor levanta a API
     quando ela cai (espera de 1 s dobrando até 60 s, que volta ao começo depois
     de 5 min estável — nunca desiste) e grava o log em
     `server/data/logs/api-AAAA-MM-DD.log`, um arquivo por dia da loja, com a
     hora em cada linha, guardando `DEVORA_LOG_RETENCAO_DIAS` dias (30).
     `-Caddy C:\caddy\caddy.exe` registra também o HTTPS.
   - **Linux:** `deploy/linux/grupo-sampaio-api.service` (systemd,
     `Restart=always`; o log fica no `journalctl`).
   - **Docker:** `docker-compose.yml` (`restart: unless-stopped`).
4. **HTTPS** no proxy da frente — ver a seção HTTPS.
5. **Conferir de novo com a API no ar:** Configurações › Implantação (só
   `admin_geral` e `gestor`) mostra a mesma conferência e mais o que só a API
   no ar sabe: se a página chegou por HTTPS, se há proxy na frente e se há
   supervisor. Nada deve BLOQUEAR.

### Parar e atualizar

`node server/dist/scripts/parar-api.js` pede ao supervisor, por um canal
local (pipe nomeado no Windows, socket no Linux), que a API desça limpa:
termina o que está em andamento, fecha as conexões e o banco, e só então o
supervisor sai. É o primeiro passo de uma atualização (parar → trocar os
arquivos → `npm run build` → `Start-ScheduledTask "Grupo Sampaio ERP - API"`)
e o que `deploy/windows/remover-servico.ps1` faz antes de remover a tarefa.
Encerrar a tarefa à força **não** é a mesma coisa: no Windows a API está no
mesmo "job" do supervisor e morre junto, na hora (nenhum dado confirmado se
perde — WAL com `synchronous FULL` —, mas a requisição em andamento recebe
erro). O mesmo canal impede um segundo supervisor de subir em cima do
primeiro.

### Uma instância por arquivo de banco (GAP-PRD-137)

O sistema roda **uma** API por arquivo SQLite — nunca duas apontando para o
mesmo `DEVORA_DATABASE_PATH`, nem em portas diferentes. Dois processos no mesmo
arquivo "quase" funcionam, e isso é pior que recusar: a escrita serializa, mas
uma espera de mais de 5 s vira `database is locked` na venda; os trabalhadores
de fundo dobram (o mesmo e-mail sai duas vezes); e dois boots juntos aplicam o
mesmo passo de migração. Escala horizontal exigiria fila com lease em todos os
trabalhadores e trava de migração — não é a topologia suportada.

A trava é o próprio banco: a tabela `core_instancia` guarda o dono (tipo, pid,
máquina, desde quando, última batida a cada 10 s).

- A API assume o banco **antes** de migrar e antes de abrir a porta. Se já há
  dono vivo, espera até 12 s (o desligamento limpo do anterior leva até 8 s) e
  sai com código 1 e a frase `Outra instância já usa este banco: …`, com o pid
  e a máquina do dono.
- Dono morto na mesma máquina (queda, tarefa encerrada à força, `tsx watch`
  que matou o filho) **não** trava a próxima subida: o pid não existe mais, e
  ela assume na hora. Na mesma máquina, o pid manda; noutra (banco em pasta de
  rede, que o SQLite com WAL nem suporta), vale a batida — 30 s sem bater é
  dono morto.
- `npm run db:migrate`, `npm run db:bootstrap --prefix server` (o mesmo
  `npm run db:seed --prefix server`), `npm run db:seed:dev --prefix server` e
  `rotacionar-chave --confirmar`
  também assumem o banco: com a API no ar, recusam e dizem quem está usando.
  Pare a API antes (`parar-api`), rode o comando, suba de novo.
- Configurações › Sistema mostra o dono na linha **Instância** (verde: é este
  processo; vermelho: o banco é de outro; alerta: o processo subiu por fora do
  boot oficial e não tem trava).

### Tabelas aposentadas no banco antigo (GAP-PRD-141)

Instalação nova só cria as coleções que o código lê ou escreve. Um banco
anterior ainda carrega as que saíram (as 81 da rodada 36 — `oms_*`,
`workshop_*`, `rental_*`, `promotion*`, `ecommerce_*` — e as 90 do
GAP-PRD-141). Nada depende de elas saírem; para tirá-las:

- `npm run db:podar-legado` — ensaio: lista o que sairia, o que fica por ter
  linha e o que esta versão não conhece. Não escreve nada.
- `npm run db:podar-legado -- --aplicar` — com a API **parada** (recusa com
  ela no ar): copia o banco antes (sem cópia, não apaga) e apaga só a
  aposentada **vazia**. Aposentada com linha fica, e o relatório diz quantas.

### Preparar a entrega: limpar a demonstração

O banco da loja nasceu como bancada de demonstração: produtos de exemplo, as
treze contas do seed, vendas, caixas abertos, OS, pedido online, nota de
entrada de teste, artefatos `ZZ-TESTE`/`ZZ-VERIF` e a maquininha `mock`. Na
entrega, isso sai — e o que o dono já configurou fica **exatamente** como está:
configuração fiscal, certificado, séries, grupo tributário, CSC, cofre de
chaves e estado das integrações, rastro da homologação do Asaas, caixa IMAP,
empresas, bancadas, categorias de sistema, `core_meta` e a auditoria.

O momento recomendado é **antes** de subir a versão nova sobre o banco (o
núcleo ainda na versão em que está). Depois da migração o comando também roda:
tabela que não existe é pulada, e os vínculos novos das contas caem junto com
elas. O roteiro, na ordem:

1. **Pare a API** — `node server/dist/scripts/parar-api.js`. Com ela no ar, a
   aplicação recusa (a trava de uma instância por banco).
2. **Simule** — `npm run db:limpar-demonstracao --prefix server` (no servidor,
   `node server/dist/scripts/limpar-demonstracao.js`). Só lê. Diz, tabela a
   tabela, quantas linhas saem e por quê (direto ou em cascata de qual tabela);
   os produtos (nome e código) e as contas (login e nome) que saem; o que fica
   em dúvida; o que fica, com a contagem; as fotos que vão para a quarentena; e
   termina com a **impressão digital** e o comando de aplicação já com ela.
   Outro arquivo: `--banco <arquivo>`.
3. **Confira.** As dúvidas ficam por padrão; para tirar, simule de novo com a
   flag — `--incluir-clientes` (os clientes citados pelos documentos da
   demonstração), `--incluir-fornecedor` (o fornecedor da nota de teste),
   `--reiniciar-sequencias-de-etiqueta` (código de barras e plaquinha, só se
   nenhuma etiqueta impressa com esses números estiver em uso). Credenciais,
   cofre de chaves e o rastro do Asaas nunca saem, com flag nenhuma.
4. **Aplique com a impressão** — `npm run db:limpar-demonstracao --prefix server -- --aplicar <impressão>`,
   com as MESMAS flags da simulação. O comando assume o banco; refaz o plano e
   recusa se a impressão não bater (o dado mudou desde a simulação: simule de
   novo) ou se houver documento fiscal de produção; tira a cópia de segurança
   (`grupo-sampaio-<data>-antes_da_limpeza.db` na pasta de backup, conferida
   com `integrity_check`) e diz onde ficou; roda tudo numa transação com
   `foreign_keys` ligado, na ordem do plano, e confere tabela a tabela que saiu
   exatamente o planejado e que toda linha que fica está igual — senão
   ROLLBACK, e nada muda; recomeça a numeração de venda, código de produto,
   pedido online, orçamento, pré-venda, OS e inventário; apaga todas as sessões
   e as tentativas de login; grava uma linha de auditoria
   `implantacao.limpeza_demonstracao` só com contagens; move (não apaga) as
   fotos dos produtos para `data/quarentena/<data>-limpeza-demonstracao/`; e
   imprime as provas (`integrity_check`, `foreign_key_check`, zero produtos,
   saldo e movimentos, zero contas da demonstração, as empresas, a
   configuração igual a antes, a auditoria antiga intacta). Rodar de novo:
   "nada a fazer".
5. **Defina `DEVORA_BOOTSTRAP_ADMIN_PASSWORD`** no `.env`. Depois da limpeza não
   sobra conta nenhuma: ninguém entra até a próxima subida com a variável — é
   ela que cria o `admin`, com senha provisória. Confira também que
   `DEVORA_DEV_QUICK_LOGIN` NÃO está no `.env`: o acesso rápido foi removido
   e a variável, aposentada — ligada em produção, a API se recusa a subir; em
   qualquer outro lugar, só um aviso no log. Apague a linha.
6. **Suba** a API (`Start-ScheduledTask "Grupo Sampaio ERP - API"`). Versão
   nova migra ao subir.
7. **Entre como `admin`** e **troque a senha** (a troca é obrigatória).
8. **Apague a variável** `DEVORA_BOOTSTRAP_ADMIN_PASSWORD` do `.env`.
9. **Nos computadores de caixa, limpe os dados do site** no navegador
   (Configurações › Privacidade › dados do site): a fila offline e a espera F7
   do PDV moram lá, não no banco.

Voltar atrás: a cópia do passo 4 volta com `npm run db:restore`, com a API
parada. O que a limpeza não alcança — e continua com a demonstração: a
central (Supabase), os backups antigos (restaurar um deles a traz de volta), a
conta sandbox do Asaas e as etiquetas e cupons já impressos.

### Como a API cai, e como desce (GAP-PRD-063)

- Promessa rejeitada sem `catch` vira linha de log
  (`processo_rejeicao_nao_tratada`, com a causa e a pilha) e o processo
  **segue**.
- Exceção não tratada vira log (`processo_excecao_nao_tratada`) e a API
  **desliga com código 1** — o supervisor sobe de novo.
- SIGINT, SIGTERM, Ctrl+Break e o pedido do supervisor desligam com prazo de
  **8 s**: para os trabalhadores de fundo, fecha o servidor, derruba as
  conexões ociosas, corta as que não terminaram no prazo, **fecha o banco** e
  sai.

## O contrato de variáveis — quem lê o quê, e quando

**BUILD do frontend** (na máquina que builda, ANTES de `npm run build:frontend`):

- `VITE_API_BASE_URL` — a ÚNICA variável que o frontend lê
  (`src/lib/api/client.ts`). É **embutida no bundle**; trocar depois exige
  rebuildar. Preencha com a origem da API vista do navegador
  (ex.: `https://erp.seudominio.com.br`). Em branco, o bundle deriva
  `host-da-página:8787` — serve para balcão/LAN sem proxy, não para domínio
  público atrás de 443.

**RUNTIME da API** (no servidor, ao subir): a API lê as variáveis reais do
ambiente e o arquivo chamado **`.env`** (na pasta do processo ou na pasta
pai). **Não existe carregamento de `.env.production`** — o modelo
`.env.production.example` é copiado para `.env` no servidor:

```bash
cp .env.production.example .env   # no servidor, e preencher lá
```

Variáveis críticas (o boot **recusa subir** produção sem as duas primeiras
fortes):

- `DEVORA_JWT_SECRET` / `DEVORA_ENCRYPTION_KEY` — próprias, longas; valores
  publicados no repositório são rejeitados
- `DEVORA_API_ENV=production` (e/ou `NODE_ENV=production` — as travas valem
  pelos dois nomes)
- `DEVORA_DATABASE_PATH` — disco persistente definitivo
- `DEVORA_FRONTEND_ORIGIN` — domínio real do frontend (CORS é allowlist
  estrito em produção; sem isto, nenhuma tela carrega)
- `DEVORA_TRUST_PROXY` — número de saltos de proxy na frente (1 no caso
  normal; 0 se servido direto). O mesmo valor decide o limite de taxa e a
  origem do bloqueio de login por par. Conferir depois de publicar:
  `GET /api/v1/core/system/secrets-readiness` → `publicacao.estado` deve ser
  `PROXY_DECLARADO` (ou `SERVIDO_DIRETO` sem proxy). `PROXY_NAO_DECLARADO`
  (chegou `X-Forwarded-For` com o valor em 0) e
  `PROXY_DECLARADO_MAS_ACESSO_DIRETO` (a API responde a quem não passa pelo
  proxy) também saem uma vez no log, como `publicacao_proxy_nao_declarado` /
  `publicacao_proxy_contornado`
- `DEVORA_SUPABASE_URL` / `DEVORA_SUPABASE_SERVICE_KEY` /
  `DEVORA_SUPABASE_BUCKET` — sincronia com a central e cópia remota do backup
- `DEVORA_BACKUP_DIR` — idealmente outro disco/volume
- `DEVORA_BOOTSTRAP_ADMIN_PASSWORD` — só na primeira subida: a senha
  provisória da conta `admin` que o bootstrap cria num banco sem administrador
  do grupo (ver "O administrador inicial"). Segredo; apague depois da troca

Integrações externas: ver `.env.production.example` (seções EXTERNAL
OPTIONAL / PRODUCTION SAFETY) — ficam desligadas até homologação, e as telas
dizem o que falta.

**O contrato é conferido a cada rodada** (GAP-PRD-153,
`server/tests/o-contrato-de-variaveis.test.ts`): toda chave escrita num dos
três `.env.*.example` tem leitor no código, e toda chave que o código lê está
nos três. `LOG_LEVEL` filtra o log estruturado (`debug` < `info` < `warn` <
`error`; o padrão é `info`). `DEVORA_PUBLIC_BASE_URL` saiu — nunca teve leitor;
o endereço público do QR é `GRUPO_SAMPAIO_PUBLIC_URL`. Se um `.env` antigo
ainda a trouxer, a conferência da implantação a aponta como "variável sem
efeito".

### Variáveis que só a suíte lê

Estas não são configuração da instalação e **não** moram em nenhum
`.env.*.example`: nenhum código do servidor as lê. Só os testes de
homologação/sandbox as leem — e a suíte **não** lê o `.env` (roda com
`DEVORA_IGNORE_DOTENV=true`), então elas vão no ambiente do shell de quem roda
o teste, na hora:

| Variável | Quem lê |
| --- | --- |
| `NFCE_TEST_CSC_ID`, `NFCE_TEST_CSC_TOKEN` | `server/tests/nfce.homologation.test.ts` |
| `LOGISTICS_MELHOR_ENVIO_TOKEN` | `server/tests/logistics.homologation.test.ts` |
| `ASAAS_SANDBOX_TESTS` | `server/tests/asaas.sandbox.test.ts`, `server/tests/asaas-integration.test.ts` |
| `LOGISTICS_JADLOG_TOKEN`, `LOGISTICS_CORREIOS_USERNAME`, `LOGISTICS_CORREIOS_PASSWORD` | ninguém — nem a suíte. Estavam no exemplo de produção sem leitor nenhum |

Na operação, o CSC entra pela tela Fiscal e as credenciais das transportadoras
pela Central de Integrações — as duas guardam no cofre. Preencher estas
variáveis no `.env` do servidor não liga nada (a conferência avisa).

### Mexer no `.env`: o que vale na hora e o que só vale no próximo boot

**Vale na hora, sem reiniciar** (GAP-PRD-065): as credenciais que o dono cola
meses depois da entrega com o servidor no ar —

- `EMAIL_ENABLED`, `EMAIL_FROM`, `EMAIL_SMTP_HOST`, `EMAIL_SMTP_PORT`,
  `EMAIL_SMTP_USER`, `EMAIL_SMTP_PASSWORD` (o carteiro de e-mail);
- `DEVORA_SUPABASE_URL`, `DEVORA_SUPABASE_SERVICE_KEY` (a sincronização com a
  central).

O servidor relê essas chaves do `.env` a cada batida do carteiro e a cada ciclo
da sincronização, e as telas de E-mails e de Sincronização dizem isso. Salvou o
arquivo, a próxima batida já usa o valor novo; a fila que esperava sai sozinha.
A exceção: se a variável estiver definida no **ambiente do sistema** (unidade do
systemd, `docker compose`, painel da hospedagem), é ela que manda — como no boot
— e aí trocar o valor exige reiniciar o processo.

**Todo o resto** a API lê **uma vez, ao subir**, e guarda em memória. Colar um
valor com o servidor no ar não muda nada: o processo continua vendo o que leu
quando nasceu. (De propósito: `DEVORA_DATABASE_PATH`, por exemplo, trocado no
meio do dia, faria o servidor mudar de banco atendendo.)

Depois de editar qualquer outra variável do `.env`, **reinicie o processo da API** — no Windows,
`node server/dist/scripts/parar-api.js` e depois
`Start-ScheduledTask "Grupo Sampaio ERP - API"`; no Linux,
`systemctl restart grupo-sampaio-api`; no Docker, `docker compose restart api`;
à mão, encerrando e repetindo o comando da seção "Build e subida". Os
supervisores de referência estão em `deploy/` (seção "Publicação de
referência").

A fila não se perde no caminho: e-mail que não saiu ficou em `pending` no banco,
e o carteiro entrega no primeiro tique depois da volta.

O que **não** basta reiniciar: `VITE_API_BASE_URL` é embutida no bundle do
frontend e exige **rebuildar**, como diz a seção acima. Os segredos do cofre
(certificado A1, CSC, chave do Asaas) são outra história — eles moram no banco,
entram pela tela e valem na hora, sem reinício.

## Build e subida

```bash
npm ci && npm ci --prefix server
VITE_API_BASE_URL=/ npm run build           # a API serve as telas (mesma origem)
MSYS_NO_PATHCONV=1 VITE_API_BASE_URL=/ npm run build   # no Git Bash do Windows: sem isso o "/" vira "C:/Program Files/Git/" e o build recusa
node server/dist/scripts/conferir-implantacao.js
node server/dist/scripts/supervisionar-api.js   # ou o serviço de deploy/
```

`node server/dist/index.js` sobe a API sem supervisor — serve para
diagnóstico, não para operar: uma queda para as seis empresas até alguém
digitar o comando de novo.

As migrações rodam **no próprio boot**, e também por comando — para um
upgrade "a frio", com a API desligada, antes de subir a build nova. Os dois
caminhos chamam a mesma função (`prepararBanco`: documentos, núcleo com
snapshot quando há passo pendente, e as bancadas oficiais):

```bash
node server/dist/db/migrate.js     # no servidor (npm run db:migrate na bancada)
node server/dist/db/status.js      # só lê; sai com 0 se EM_DIA (npm run db:status)
```

O número que importa é o do **núcleo** (`core_meta.core_schema_version`)
contra o alvo desta build (`CORE_TARGET_VERSION`, hoje 84). O status diz uma
de cinco situações: `EM_DIA`, `ATRASADO` (a API migra ao subir),
`ADIANTADO` (o banco é de uma build mais nova — rollback de aplicação:
suba a build que migrou, não esta), `NUNCA_MIGRADO` e `SEM_BANCO`. A camada
de documentos herdada aparece ao lado, rotulada; ela parou em 19 e não anda.
O mesmo número está em `GET /api/v1/system/readiness` (`schema`), em
`GET /api/v1/version` (`databaseVersion`) e na tela Configurações › Sistema.

### O administrador inicial (bootstrap)

Depois das migrações, o boot roda o **bootstrap de produção** — o mesmo de
`node server/dist/db/bootstrap-cli.js` no servidor e de
`npm run db:bootstrap --prefix server` (ou `npm run db:seed --prefix server`)
na bancada. Ele garante as seis operações e as bancadas oficiais e, num banco
sem administrador do grupo, cria a conta `admin` (nome "Administrador",
administradora em todas as operações) com a senha de
`DEVORA_BOOTSTRAP_ADMIN_PASSWORD`, provisória. Roteiro da primeira subida:

1. preencha `DEVORA_BOOTSTRAP_ADMIN_PASSWORD` no `.env` (no Docker, no
   ambiente do host) — ao menos 8 caracteres, própria desta instalação; as
   senhas de desenvolvimento são recusadas em produção e homologação, e a API
   não sobe com elas;
2. suba a API e confira no log `BOOTSTRAP_ADMIN_CRIADO`;
3. entre como `admin` e troque a senha (a troca é obrigatória);
4. apague a variável do `.env` e reinicie.

A variável nunca altera conta existente: com administrador de pé ela não faz
nada, e a conferência da implantação fica em ATENÇÃO até ela sair. Sem ela e
sem administrador, a API sobe, o log diz `BOOTSTRAP_SEM_ADMINISTRADOR` e a
conferência dá BLOQUEIA em "Administrador inicial". O login `admin` não
distingue maiúsculas: um `ADMIN` que já exista ocupa o nome, e o bootstrap não
cria outro ao lado dele. A senha nunca vai para log, auditoria (a criação fica
como `bootstrap.admin_created`, feita pelo sistema) nem tela.

Nenhuma conta de demonstração nasce em produção. Elas moram no seed de
desenvolvimento (`npm run db:seed:dev --prefix server`), que recusa produção,
homologação e o banco operacional.

Confira no log `API_SERVER_STARTED`, e nas sondas públicas:

- `GET /api/v1/health` — vivacidade
- `GET /api/v1/readiness` — o banco abre de verdade (503 se não)

## Comandos do operador

Na máquina de desenvolvimento, pelos aliases (`npm run backup`,
`backup:verify`, `db:backups`, `db:restore`, `db:bucket`, `db:baixar`,
`db:restaurar-uploads`, `db:restaurar-do-bucket`, `secret:scan`). No servidor
de produção (onde só as `dependencies` estão instaladas), pelas versões
compiladas:

```bash
node server/dist/scripts/backup-agora.js
node server/dist/scripts/verificar-backup.js
node server/dist/scripts/listar-backups.js
node server/dist/scripts/restaurar-backup.js <backup> <destino-novo>
node server/dist/scripts/listar-bucket.js
node server/dist/scripts/baixar-backup.js <nome | --ultimo> <destino-novo.db>
node server/dist/scripts/restaurar-uploads.js <manifesto | pacote | --ultimo> <pasta-nova>
node server/dist/scripts/restaurar-do-bucket.js <pasta-nova> [--banco <nome>] [--fotos <manifesto>]
node server/dist/scripts/conferir-central.js
node server/dist/scripts/conferir-certificado.js
node server/dist/scripts/podar-bucket.js --ensaio
node server/dist/scripts/limpar-demonstracao.js [--aplicar <impressão>]
node server/dist/scripts/carregar-municipios-ibge.js --baixar
```

Os comandos do bucket leem `DEVORA_SUPABASE_URL`, `DEVORA_SUPABASE_SERVICE_KEY`
e `DEVORA_SUPABASE_BUCKET` do `.env` — rode-os da pasta da instalação. A chave
nunca é impressa.

**A tabela de municípios do IBGE** — uma vez, depois que o banco existir (a
primeira subida o cria): `node server/dist/scripts/carregar-municipios-ibge.js --baixar`
busca a lista oficial em `servicodados.ibge.gov.br` e grava numa transação
(idempotente; pode rodar com a API no ar). Servidor sem internet: baixe
`https://servicodados.ibge.gov.br/api/v1/localidades/municipios` noutra máquina
e rode com `--arquivo municipios.json` (ou um CSV `codigo;nome;uf`). Na
bancada: `npm run ibge:municipios -- --baixar`. Com a tabela, o endereço da
loja e o cadastro fiscal do emitente escolhem a cidade pelo nome e o código
IBGE vem junto; sem ela, o cliente digita o código à mão. A conferência da
implantação diz PRONTA (com a contagem) ou PENDENTE.

## Backup — o que roda, onde ver, e a volta do bucket

**O diário** (GAP-PRD-058) roda ao subir a API (se não houver cópia diária de
menos de 20 h) e todo dia na hora de `DEVORA_BACKUP_HORA` (vazio = 03:00, pelo
relógio da loja). Três etapas, cada uma com resultado próprio:

1. cópia local do banco em `DEVORA_BACKUP_DIR`, numa worker thread — a API
   segue atendendo durante a cópia;
2. envio dessa cópia ao bucket (raiz);
3. envio das fotos (produto, loja, OS), **uma a uma**, só o que ainda não está
   lá: cada arquivo vira `uploads/objetos/<sha256>`, e um manifesto
   `uploads/manifesto-<carimbo>.json` (versão 2) diz qual caminho tem qual
   conteúdo. Não há teto de tamanho e nada passa inteiro pela memória. Os
   pacotes antigos `uploads/uploads-*.json.gz` (versão 1) continuam
   restauráveis.

Só o banco **declarado descartável** (`:memory:` ou o caminho de
`TEST_DATABASE_PATH`) é pulado. Até esta rodada, qualquer banco fora de
`server/data/grupo-sampaio.db` era pulado calado — quem seguia esta página e
punha o banco no disco definitivo ficava sem diário.

**Onde ver** (GAP-PRD-011): Configurações › Backup (só `admin_geral` e
`gestor`; `GET /api/v1/system/backup/status`). Cada item diz PRONTO, PENDENTE
ou FALHOU, com a data e o como resolver: cópia diária do banco (atrasada com
mais de 26 h), backup em outro disco, cópia no bucket, fotos, e a última
**conferência do bucket** — o botão "Conferir o bucket agora" lê o bucket e
confere se o último `.db` enviado e todas as fotos do último conjunto estão
lá ("enviou" não é "está lá"). As falhas dos últimos 30 dias ficam listadas
com o motivo.

**Outro disco** (GAP-PRD-068): `DEVORA_BACKUP_DIR` apontando para outro disco,
pen drive ou volume. A tela confere pelo volume de verdade (o `dev` do
sistema de arquivos), e a conferência da implantação acusa quando a letra do
disco do backup é a mesma do banco. Uma partição do mesmo HD físico passa
como outro volume: contra disco morto, a proteção é a cópia remota.

### Disco morto: a volta a partir do bucket (GAP-PRD-012)

Tudo por comando, sem desenvolvedor:

1. Numa máquina (ou disco) nova, instale o sistema e o build como na seção
   Build e subida — **sem** subir a API ainda.
2. Crie o `.env` da instalação com `DEVORA_SUPABASE_URL`,
   `DEVORA_SUPABASE_SERVICE_KEY`, `DEVORA_SUPABASE_BUCKET` e as chaves do
   cofre. `DEVORA_ENCRYPTION_KEY` precisa ser **a mesma** de antes: é ela que
   abre o certificado, as chaves do Asaas e a senha do e-mail gravados no
   banco. Guarde-a fora do servidor (cofre de senhas do dono).
3. Veja o que há no bucket:
   `node server/dist/scripts/listar-bucket.js`
4. Traga o banco e as fotos mais novos para uma pasta nova:
   `node server/dist/scripts/restaurar-do-bucket.js D:/grupo-sampaio-dados`
   (ou escolha a cópia com `--banco <nome.db>` e o conjunto com
   `--fotos <manifesto-....json>`). O banco só é gravado se passar no
   `integrity_check`; cada foto é conferida pelo sha256; nada é escrito por
   cima de pasta que não esteja vazia.
5. Cole no `.env` as duas linhas que o comando imprime
   (`DEVORA_DATABASE_PATH=...` e `DEVORA_UPLOADS_DIR=...`) e aponte
   `DEVORA_BACKUP_DIR` para outro disco.
6. Suba a API. A migração leva o banco restaurado ao esquema atual sem apagar
   nada. Confira em Configurações › Backup e em Configurações › Implantação.

Para trazer só um dos dois: `baixar-backup.js <nome | --ultimo> <arquivo-novo.db>`
e `restaurar-uploads.js <manifesto | pacote | --ultimo> <pasta-nova>` — a
pasta das fotos pode ser retomada (arquivo igual é pulado).

## Docker

`Dockerfile` / `docker-compose.yml` (produção) e `docker-compose.staging.yml`
(homologação). O que eles garantem, e o teste que segura cada coisa
(`server/tests/a-imagem-docker-guarda-o-que-e-dado.test.ts`):

- **O contexto do build é só código.** `.dockerignore` deixa de fora banco,
  `-wal`, backups, fotos, `.env` (e toda cópia dele), certificados e os
  `node_modules`. Sem ele, o `COPY . .` levava gigabytes de dado de cliente e
  os segredos para a cache de quem builda.
- **Todo dado mora em volume.** A imagem declara `DEVORA_DATABASE_PATH` e
  `DEVORA_UPLOADS_DIR` dentro de `/app/server/data` (volume `devora-dados`) e
  `DEVORA_BACKUP_DIR` em `/app/backups` (volume `devora-backups`). Antes, as
  fotos iam para `/app/data/uploads`, fora do volume, e sumiam a cada
  `docker compose up --build`.
- **Volume nomeado, nunca a pasta do host.** Não monte o `server/data` de uma
  instalação existente: ali mora o banco da loja, e o boot o migraria. Para
  levar uma instalação para o container, restaure um backup dentro do volume.
- **Sem root, com sonda de verdade.** O processo roda como `node`, e o
  `HEALTHCHECK` bate em `/api/v1/readiness` (o banco abre), não em `/health`.
- **Produção pelos dois nomes.** `NODE_ENV=production` e
  `DEVORA_API_ENV=production` na imagem; o compose declara de novo. Entrada
  sem senha não existe: não há variável para escrever como desligada, e a
  linha antiga de um atalho ligada no ambiente faz a API recusar subir.
- **Nenhum segredo no arquivo.** `DEVORA_JWT_SECRET`, `DEVORA_ENCRYPTION_KEY` e
  `DEVORA_FRONTEND_ORIGIN` vêm do ambiente do host (shell, ou o `.env` ao lado
  do compose, que ele lê para interpolar) e o compose recusa subir sem eles.
  Os valores que os compose publicaram até o lote D1 estão na lista de
  publicados: o servidor os recusa em produção e homologação, e
  `npm run secret:scan` agora abre `.yml` e reprova segredo literal.

As duas chaves são geradas na própria máquina (o comando está em
`.env.production.example`) e postas no `.env` ao lado do compose — nunca
escritas neste repositório, neste arquivo ou num chat. Depois:

```bash
export DEVORA_FRONTEND_ORIGIN=https://erp.seudominio.com.br
docker compose up -d --build
```

## HTTPS

Obrigatório em produção real. A API não fala TLS: termine o HTTPS no proxy
reverso e declare `DEVORA_TRUST_PROXY=1` e o domínio em
`DEVORA_FRONTEND_ORIGIN`. Exemplos prontos:

- `deploy/caddy/Caddyfile.example` — o mais simples, sobretudo no Windows: o
  Caddy tira e renova o certificado sozinho (precisa do domínio apontando para
  a máquina e das portas 80/443). Traz HSTS, o modo em que a API serve as
  telas e o modo em que o Caddy as serve com `try_files`. Também o caso "só
  rede local", com `tls internal`.
- `deploy/nginx/grupo-sampaio.conf.example` — redirecionamento 80→443, HSTS,
  `try_files` para as telas, `/api/` e `/uploads/` para a 8787 com
  `X-Forwarded-Proto`, e `client_max_body_size 10m` (as fotos viajam em
  base64; o padrão do nginx corta em 1 MB).
- Docker: `docker compose --profile https up -d` sobe o Caddy de
  `deploy/caddy/Caddyfile.docker` com `DEVORA_DOMINIO`.

A tela Configurações › Implantação diz se a página chegou por HTTPS e se a API
confia no proxy.

## Cabeçalhos de segurança (CSP e HSTS)

- **API**: já manda os seus em toda resposta
  (`server/src/middleware/cabecalhosDeSeguranca.ts`): CSP de API
  (`default-src 'none'; frame-ancestors 'none'…`), `nosniff`,
  `X-Frame-Options: DENY` e — quando a requisição chega por HTTPS, o que atrás
  do proxy exige `DEVORA_TRUST_PROXY` e `X-Forwarded-Proto` — HSTS de 180 dias.
- **Frontend**: o build injeta a CSP da tela no `out/index.html` como
  `<meta http-equiv="Content-Security-Policy">`
  (`src/lib/seguranca/politicaDeConteudo.ts`): só o JavaScript do próprio
  pacote executa, e `fetch` só fala com a própria origem e com a API. Com
  `VITE_API_BASE_URL` preenchida no build, a API liberada é exatamente aquela
  origem; em branco (modo LAN), é a porta 8787 de qualquer host.
- **O que só o host estático pode fazer** (uma `<meta>` não consegue): o
  servidor que entrega o `index.html` deve mandar
  `Strict-Transport-Security: max-age=15552000` e
  `Content-Security-Policy: frame-ancestors 'none'` (ou
  `X-Frame-Options: DENY`). No nginx:
  `add_header Strict-Transport-Security "max-age=15552000" always;` e
  `add_header Content-Security-Policy "frame-ancestors 'none'" always;` no
  `location /` do frontend. No Caddy, o bloco `header` equivalente.
- Quem acrescentar provedor externo à tela (login do Google, widget de
  pagamento) acrescenta o domínio na diretiva certa de
  `politicaDeConteudo.ts` — a CSP recusa em silêncio para o usuário e com
  aviso no console.

## Depois de subir

1. Health + readiness
2. Login admin + PDV smoke
3. Checklist: `docs/GO_LIVE_CHECKLIST.md` e `docs/POST_DEPLOY_CHECKLIST.md`
4. Operação: `docs/OPERATIONS.md` · Rollback: `docs/GO_LIVE_ROLLBACK.md`
