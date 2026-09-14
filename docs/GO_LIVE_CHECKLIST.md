# Go-Live — Grupo Sampaio ERP

O estado de cada módulo está em [`ESTADO-ATUAL.md`](./ESTADO-ATUAL.md). Aqui é
só a ordem das coisas no dia.

A regra que atravessa esta lista: **integração externa pendente não bloqueia o
go-live do núcleo.** O balcão vende, o estoque baixa, o caixa fecha e o
financeiro lança sem nenhuma credencial de terceiro. O que depende de terceiro
liga depois, uma de cada vez, e a tela diz o que falta enquanto isso.

---

## 1. Antes de subir

- [ ] Node **24** no servidor (mínimo 22.5 — Node 20 não sobe, `node:sqlite`)
- [ ] O `.env` do servidor nasce de `.env.production.example` — o runtime lê o
      arquivo chamado **`.env`**, não `.env.production` (ver `DEPLOY.md`)
- [ ] `DEVORA_API_ENV=production` **e** `NODE_ENV=production` escritos no
      `.env` (GAP-PRD-151: o `.env` da máquina da loja não declarava
      ambiente nenhum — o padrão é `development`)
- [ ] Configurações › Implantação (ou o comando da conferência) sem
      "Variável aposentada presente": entrada sem senha não existe, e a linha
      antiga de um atalho no `.env` faz a API recusar subir em produção
- [ ] `DEVORA_JWT_SECRET` e `DEVORA_ENCRYPTION_KEY` de produção, longos e
      próprios desta instalação — os padrões locais e os valores escritos no
      repositório (inclusive os dos compose antigos) são **bloqueados** em
      produção e homologação
- [ ] `DEVORA_BOOTSTRAP_ADMIN_PASSWORD` preenchida para a **primeira** subida:
      a senha provisória do administrador inicial (`admin`), própria desta
      instalação, com ao menos 8 caracteres (as de desenvolvimento são
      recusadas). Sem ela, a conferência dá BLOQUEIA em "Administrador
      inicial" e ninguém entra
- [ ] `DEVORA_DATABASE_PATH` apontando para o disco definitivo
- [ ] `DEVORA_FRONTEND_ORIGIN` com o domínio real (CORS) e
      `DEVORA_TRUST_PROXY` com o número de saltos do proxy
- [ ] Frontend buildado com `VITE_API_BASE_URL=/` e `DEVORA_SERVIR_FRONTEND=true`
      (a API serve as telas) — ou apontando para a API, se outro host servir
- [ ] `node server/dist/scripts/conferir-implantacao.js` **sem nenhum
      BLOQUEIA** (ele confere tudo acima pelo nome das variáveis)
- [ ] Tabela de municípios do IBGE carregada **uma vez**, com o banco já
      criado: `node server/dist/scripts/carregar-municipios-ibge.js --baixar`
      (ou `--arquivo municipios.json`, baixado de
      `servicodados.ibge.gov.br/api/v1/localidades/municipios`). A conferência
      passa a dizer "Tabela de municípios do IBGE" PRONTA; sem ela, o cliente
      da loja digita o código IBGE da cidade à mão
- [ ] Com a tabela carregada, "Município do emitente na tabela do IBGE" em OK.
      Em ATENÇÃO, o código IBGE do emitente de alguma operação não existe, é
      de outra UF ou é de outra cidade: o checklist fiscal barra a NF-e, a
      NFC-e e a NFS-e dela antes de numerar até que, em Fiscal › Emitente, a
      UF e o município sejam escolhidos na lista (o código vem junto). Pedido
      fechado antes da tabela com código errado no endereço: a ficha do pedido
      (Nota fiscal do pedido) aponta e corrige ali mesmo
- [ ] Na mesma conferência, "Sobras do sistema anterior" em OK: cópia de
      `.env` (`.env.bak-*`) guardada no cofre de senhas e apagada da pasta;
      `server/data/devora-api.json` e `server/backups/*.json` (formato do
      sistema anterior, que nada lê) conferidos e apagados (GAP-PRD-154)
- [ ] HTTPS ativo — `deploy/caddy/Caddyfile.example` ou `deploy/nginx/`
- [ ] Serviço instalado: `deploy/windows/instalar-servico.ps1` (Windows),
      `deploy/linux/grupo-sampaio-api.service` (Linux) ou o compose (Docker)
- [ ] Backup do banco **antes** da primeira subida, e `npm run backup:verify`
- [ ] `DEVORA_BACKUP_DIR` em **outro disco** (pen drive, segundo HD, volume) e
      `DEVORA_SUPABASE_URL`/`DEVORA_SUPABASE_SERVICE_KEY`/`DEVORA_SUPABASE_BUCKET`
      preenchidos; depois de subir, Configurações › Backup **sem nenhum FALHOU**
      e "Conferir o bucket agora" em PRONTO
- [ ] `DEVORA_ENCRYPTION_KEY` guardada **fora** do servidor (cofre de senhas):
      sem ela, um banco restaurado do bucket não abre os segredos
- [ ] Ensaio da volta: `restaurar-do-bucket.js <pasta-nova>` numa pasta de
      teste, conferir que o banco abre e as fotos voltaram (roteiro em
      `docs/DEPLOY.md`, "Disco morto")
- [ ] `npm run lint && npm run type-check && npm run test && npm run build` verdes

## 2. Primeira subida

- [ ] Subir a API e conferir no log: `API_SERVER_STARTED` (no Windows, em
      `server/data/logs/api-AAAA-MM-DD.log`)
- [ ] Configurações › Implantação sem nenhum BLOQUEIA, com HTTPS e
      "Quem levanta a API" em OK
- [ ] Migrations aplicadas sozinhas no boot (ou antes, a frio, com
      `node server/dist/db/migrate.js`); conferir com
      `node server/dist/db/status.js` (`npm run db:status` na bancada):
      `"situacao": "EM_DIA"`, com `nucleo.versao` igual a `nucleo.alvo`
      (84 nesta build). A tela Configurações › Sistema mostra o mesmo número.
      O `documentos` (19) é a camada herdada e não é a versão do sistema
- [ ] As duas oficinas oficiais existem (Mobilidade na Oficina, Celulares na
      Preço Justo)
- [ ] No log, `BOOTSTRAP_ADMIN_CRIADO`: o bootstrap roda sozinho na subida e
      cria as seis operações e só a conta `admin` (provisória,
      `must_change_password = 1`) — nenhuma conta de demonstração. A frio, o
      mesmo é `node server/dist/db/bootstrap-cli.js`
      (`npm run db:bootstrap --prefix server` na bancada, o mesmo `db:seed`).
      Rodar de novo nunca altera conta existente
- [ ] Entrar como `admin` com a senha inicial e trocá-la — o primeiro login só
      abre a etapa de troca; a API recusa todo o resto até lá
      (`API_PASSWORD_CHANGE_REQUIRED`)
- [ ] `DEVORA_BOOTSTRAP_ADMIN_PASSWORD` **apagada** do `.env` depois da troca
      ("Administrador inicial" volta a OK na conferência)
- [ ] Gerentes, PDVs e mecânicos cadastrados pelo admin em Pessoas › Usuários
      e equipe, cada um com senha provisória; cada pessoa trocou a própria no
      primeiro acesso (a coluna "troca no 1º acesso" some da tela)
- [ ] Usuários, perfis e vínculos revisados operação por operação

## 3. Antes de abrir o balcão

- [ ] Produtos com preço, e os que vão para a loja com **NCM, CFOP e origem** —
      sem eles a nota não sai, e o aviso aparece na tela de produtos
- [ ] Estoque inicial lançado (inventário, não ajuste solto)
- [ ] Um caixa completo de teste: abrir → vender → sangria → fechar com
      diferença zero
- [ ] Impressoras cadastradas em Configurações → Impressoras — uma de cupom por
      balcão, nas seis operações. A de agente local com o caixa e o endereço, o
      agente rodando no computador do caixa e a **página de teste** confirmada
      (passo a passo em `docs/OPERATIONS.md`)
- [ ] Taxa e prazo de cada operadora de cartão em Financeiro → Operadoras de
      cartão, por operação. Sem elas o cartão entra como recebido no dia, pelo
      valor cheio. A lista do que falta por operação está em `/system/go-live`
      (`configurationPending`)
- [ ] Nenhuma maquininha de TESTE ligada (Vendas › Conferência de maquininha)
- [ ] Auditoria abrindo e registrando

## 4. Fiscal (quando o certificado chegar)

- [ ] Certificado A1 (.pfx) carregado por operação, com senha
- [ ] CNPJ, IE, CRT, endereço completo e **código IBGE** do município
- [ ] Série de NFC-e e de NF-e configuradas
- [ ] CSC e CSC ID por operação (só NFC-e; sem eles não há QR, e sem QR o cupom
      não vale)
- [ ] Ambiente em **homologação** primeiro. A tela mostra tarja de teste em
      documento que não vale para o fisco
- [ ] Emitir uma NFC-e de homologação pelo PDV e conferir o DANFCE
- [ ] Só então virar para produção

> Enquanto faltar certificado, o botão de emitir **não aparece** e a tela lista
> a pendência. Isso é o comportamento correto, não uma falha.

## 5. Asaas (quando a chave chegar)

- [ ] API key de sandbox em Integrações → Asaas
- [ ] `GRUPO_SAMPAIO_PUBLIC_URL` do servidor com o endereço **HTTPS público** da
      API (ou `ASAAS_WEBHOOK_PUBLIC_URL`, se o webhook entrar por outro
      endereço). Com `http://localhost` o Asaas não alcança, e a tela avisa
- [ ] URL do webhook **desta operação** cadastrada no painel do Asaas dela —
      a URL exata aparece em Integrações → Asaas → "Webhook", com botão de
      copiar: `https://<endereço>/api/v1/loja/webhooks/payments/asaas/<id da operação>`.
      Cada operação cadastra a sua, no painel da conta Asaas dela
- [ ] Quem já tinha cadastrado o endereço antigo (`/api/v1/webhooks/asaas`)
      não precisa trocar: ele passa pelo mesmo processamento e a operação é
      reconhecida pelo token
- [ ] Depois de uma cobrança de teste, conferir no card "Webhook" que o
      "último aviso" chegou e foi **processado**
- [ ] Token do webhook configurado — **sem token configurado o webhook recusa
      tudo com 503**, de propósito: webhook que aceita sem conferir é porta
      aberta para pagamento falso
- [ ] Uma cobrança de teste ponta a ponta
- [ ] Conciliação Asaas rodada e sem divergência
- [ ] Só então a chave de produção — e depois dela, **"Testar conexão"**: a
      trava de produção só abre com a chave de PRODUÇÃO testada em
      `api.asaas.com` (o selo "Produção: chave testada"). O teste do sandbox
      não abre essa trava, e guardar a chave de produção não desfaz a
      homologação do sandbox. A ordem dos passos não importa
- [ ] "Pedir produção" — a homologação não desfaz mais o pedido

## 6. Banco central

> **✔ Já concluído nesta instalação (30/08/2026):** esquema aplicado, carga
> inicial feita e reconciliada (199/199 projetados), ciclo automático rodando.
> No servidor de produção só falta repetir a credencial no `.env`. Os passos
> abaixo ficam para uma instalação nova.

- [ ] `DEVORA_SUPABASE_URL` e `DEVORA_SUPABASE_SERVICE_KEY` no ambiente do **servidor** —
      a chave publicável do navegador não serve e não é usada
- [ ] Os três arquivos de `docs/supabase/` aplicados **na ordem** — de
      preferência com `node server/dist/scripts/aplicar-sql-central.js`, que
      confere o catálogo antes e depois (o SQL Editor já executou parcialmente
      em silêncio duas vezes). O terceiro não é opcional: sem ele os fatos
      chegam e não viram tabela de negócio
- [ ] Tela → Conferir schema → **Carga inicial**
- [ ] Conferir na tela que o **ciclo automático está rodando** (ele só liga com
      credencial; sem ela a fila acumula, que é o certo)

## 7. Logística e maquininha (quando houver contrato)

- [ ] CEP da operação preenchido em Fiscal → Configuração — é de lá que sai a
      cotação
- [ ] Melhor Envio: em Loja → Logística, ambiente **Produção**, token de
      produção colado e **Testar conexão** respondendo OK (o de sandbox é
      opcional e só confere — nunca vira preço no checkout)
- [ ] No servidor: `LOGISTICS_PRODUCTION_ENABLED=true` no ambiente da API.
      Sem ela o token fica guardado e a tela mostra a trava pelo nome
- [ ] A tarja do topo da tela diz **TRANSPORTADORA NO CHECKOUT**, e a cotação
      de conferência sai sem **COTAÇÃO SIMULADA** e sem **COTAÇÃO DE SANDBOX**
- [ ] Endereço do REMETENTE completo em Fiscal → Configuração (razão social,
      CNPJ, rua, número, bairro, cidade, UF, CEP e telefone) — é o que vai na
      etiqueta
- [ ] Saldo na carteira do Melhor Envio: a etiqueta é paga com ele
- [ ] Com o contador: envio só com NF-e (padrão) ou também com declaração de
      conteúdo — a escolha fica em Loja → Logística → Envio e etiqueta
- [ ] Se for usar serviço Jadlog: a agência de postagem (número do Melhor
      Envio) em Loja → Logística → Envio e etiqueta
- [ ] Primeira etiqueta de verdade: um pedido real e barato, na ficha do
      pedido → **Comprar etiqueta**; imprimir, despachar e conferir o link de
      rastreio no portal do cliente (é a homologação: gasta saldo)
- [ ] Correios / Jadlog diretos: sem integração HTTP programada — cotação,
      etiqueta e rastreio dos serviços deles saem pelo Melhor Envio. Contrato
      direto exigiria programação nova
- [ ] TEF: SDK do provedor e PinPad físico; sem os dois o estado honesto
      continua `READY_FOR_HARDWARE`

## 8. Fechamento do dia 1

- [ ] Percorrer: Painel, PDV, Oficina, Loja, Pedidos, BI e Integrações
- [ ] Conferir que a venda do balcão apareceu no painel, no estoque e no
      financeiro
- [ ] Backup do fim do dia

---

## Pós-deploy e rollback

- [`POST_DEPLOY_CHECKLIST.md`](./POST_DEPLOY_CHECKLIST.md)
- [`GO_LIVE_ROLLBACK.md`](./GO_LIVE_ROLLBACK.md)
- [`MONITORING_FIRST_HOURS.md`](./MONITORING_FIRST_HOURS.md)

**Não** faça rollback porque um provedor externo opcional falhou. O núcleo não
depende de nenhum deles.
