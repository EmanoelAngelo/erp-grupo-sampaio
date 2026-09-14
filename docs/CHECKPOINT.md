# CHECKPOINT — Grupo Sampaio ERP

> **A fonte de verdade passou a ser** [`ESTADO-ATUAL.md`](./ESTADO-ATUAL.md).
> Este arquivo continua útil como HISTÓRICO detalhado — por que cada decisão
> foi tomada, o que quebrou e como foi consertado — mas ele descreve o projeto
> ao longo do caminho, e partes dele envelheceram. Onde os dois divergirem,
> vale o `ESTADO-ATUAL`.

Quatro documentos deste repositório já disseram coisas diferentes sobre os
mesmos módulos ao mesmo tempo. Ter um só respondendo pelo estado é o que evita
que alguém decida com base no que envelheceu.

Branch: `finalization/grupo-sampaio-enterprise`

---

## Como rodar

```bash
npm install && npm install --prefix server
npm run db:migrate --prefix server && npm run db:bootstrap --prefix server
npm run db:seed:dev --prefix server   # contas de demonstração (banco de bancada)
npm run dev:api      # API  :8787
npm run dev          # front:5173
```

O bootstrap cria as seis operações e o `admin`, com a senha de
`DEVORA_BOOTSTRAP_ADMIN_PASSWORD`. O seed de desenvolvimento cria as contas de
demonstração com as senhas de `GRUPO_SAMPAIO_*_PASSWORD` (ou gera uma por conta
e a imprime uma vez) e recusa o banco operacional: aponte
`DEVORA_DATABASE_PATH` para um banco de bancada (ver README). Nenhuma senha
fica escrita no repositório; todas nascem provisórias, e nenhum dos dois
reescreve conta existente. Todo login exige senha — o acesso rápido por card
foi removido.

---

## Arquitetura vigente

```
React (cache/offline) → API Express /api/v1 → services transacionais
                                            → SQLite central (WAL)
                                            → core_audit_log
```

- Banco central: `server/data/grupo-sampaio.db`, caminho ancorado na raiz do
  repositório (não depende do cwd).
- `server/src/db/schema.ts` cria o formato atual (banco novo).
- `server/src/db/core-migrations.ts` leva banco existente até o formato atual
  (`CORE_TARGET_VERSION = 25`, com marca por passo). Nunca apagar banco para
  corrigir schema.
- `reconcileCoreSchema()` confere o banco real contra a DDL canônica a cada
  partida e **acrescenta** coluna faltante. Nunca remove, nunca muda tipo,
  nunca toca em dado.

### Invariantes impostos pelo banco

| Invariante | Mecanismo |
| --- | --- |
| Estoque nunca negativo | `CHECK (quantity >= 0)` |
| Reserva nunca negativa | `CHECK (reserved >= 0)` |
| Baixa única por referência | `UNIQUE` em `core_stock_movements` |
| Um fato econômico por origem | `UNIQUE (origin_type, origin_id, direction)` |
| Venda/pedido não duplica | `UNIQUE (company_id, idempotency_key)` |
| NF-e não entra 2× | `UNIQUE (company_id, access_key)` |
| Webhook não processa 2× | `UNIQUE (provider, event_id)` |
| Um caixa aberto por terminal | índice parcial `WHERE status='open'` |

---

## PRONTO (implementado, testado, verificado no navegador)

- **Auth**: Argon2id, refresh com rotação, lockout server-side, RBAC,
  `companyId` sempre derivado do vínculo — nunca do corpo da requisição.
- **Senha obrigatória**: gestão, balcão e bancada entram com usuário e senha. O
  acesso rápido por card foi removido — o único caminho sem digitar senha é o
  token de terminal, que é registrado por um administrador e é revogável. A
  bancada tem porta própria em `/oficina/login`.
- **6 operações** (Preço Justo, Gringa, Me Mimei, Conceito, PJ Motors,
  Oficina). Nenhuma filial fictícia.
- **2 oficinas sem 7ª empresa**: `oficina-mobilidade` (Oficina) e
  `oficina-celulares` (Preço Justo). Escopo `company_id + workshop_id`.
- **Produtos, estoque, caixa, vendas, financeiro, clientes**.
- **OS/Kanban**: 6 colunas, regra de assumir (comentário obrigatório, OS passa
  a pertencer ao técnico), timeline append-only, peça baixa estoque uma vez,
  OS com custo só finaliza pela baixa no PDV.
- **Equipamentos**: `INTERNAL_PJ_MOTORS` / `EXTERNAL_CUSTOMER`, `#0001`
  sequencial global, token opaco para QR, venda preserva histórico.
- **Entrada por XML de NF-e**: parser real, conferência antes do estoque,
  idempotente na importação e na confirmação.
- **Código de barras e etiquetas**: EAN-13 interno (prefixo 2) com digito
  verificador real; etiqueta comercial com barras e plaquinha de oficina com
  QR + #ID. O balcao (PDV) tambem cadastra produto, da entrada e importa XML.
- **E-commerce**: portal do grupo, vitrine sobre o estoque real, promoções
  (PDV + site), carrinho, checkout multiloja (um pedido por operação),
  reserva no pedido, baixa só no pagamento, OMS até expedição/rastreio.

## PARCIAL

- **Asaas — configuração por operação: PRONTO. Cobrança online: PARCIAL.**
  A credencial vem do cofre da operação (`AsaasCredentialService`), não mais
  do ambiente: cada empresa recebe no CNPJ dela. Produção depende de cinco
  travas (pedido, flag do processo, credencial de produção, conexão testada,
  homologação sandbox) — faltando uma, o ambiente efetivo é sandbox e a tela
  diz qual falta. Tela em `/sistema/integracoes/asaas`; a chave nunca volta
  pela API (verificado no navegador). Webhook por operação, com token próprio,
  idempotente por `event_id`, com tabela de eventos e posto que impede
  regressão por evento atrasado; estorno e chargeback andam para trás de
  propósito. **Sem API key o estado é `unconfigured`** — não inventa QR nem
  aprova. Falta para homologar: chave sandbox real do dono e URL pública de
  webhook.
- **Preço promocional** vale no PDV e na loja (mesma funcao em PricingService).
- **Retrofit visual**: casca (topbar 72px, sidebar 268px com 11 grupos e
  ícones), painel, PDV, oficina, produtos, estoque, clientes, caixa, vendas,
  financeiro, entrada de notas e loja pública estão no design system.
  **Restam ~1.100 literais de cor escura** nas telas legadas.

- **Fechamento de venda**: pagamento dividido entre 5 meios com atalhos, troco
  (só sobre dinheiro; gaveta fica com o líquido; troco não é receita),
  autorização gerencial sem sair do PDV, clique duplo não duplica nada.
- **Grade de produto**: variante é produto-filho com EAN próprio; vender o P
  não consome o G; modelo com grade não é vendável e some da busca do PDV.
- **Orçamento e pré-venda, até a tela**: `/sistema/orcamentos` cria, aprova
  (orçamento → pré-venda, reservando estoque), cancela e expira. No PDV, `F9`
  abre as pré-vendas reservadas e carrega os itens sem redigitar. Finalizar um
  carrinho de pré-venda fatura pela CONVERSÃO — é ela que solta a reserva antes
  da baixa.
- **Maquininha no PDV**: `PdvTerminalService` é ponte para `payment-terminal/`,
  não substituto. Cartão só entra na venda após confirmação da operadora.
  Estados na tela: AGUARDANDO TERMINAL → AGUARDANDO CLIENTE → PROCESSANDO →
  APROVADO, mais RECUSADO / CANCELADO / STATUS NÃO CONFIRMADO / ERRO.
  Status não confirmado **desabilita o Finalizar** e vai para
  `/sistema/conferencia-maquininha`, onde só gerente resolve, com motivo, e o
  desfecho é gravado (senão a cobrança voltaria à fila para sempre).
- **Razão de estoque completa**: `quantity_before` em todo movimento (anterior
  + delta = posterior) e 21 tipos semânticos (XML_RECEIPT, SALE, SALE_CANCEL,
  WORKSHOP_PART_CONSUMPTION, PRE_SALE_RESERVATION…). Tela em
  `/sistema/estoque/movimentacoes` com entrada e saída em colunas separadas e
  filtros por período, produto, tipo e documento. Mecânico não recebe custo —
  o campo é removido da resposta.
- **Cadastro de produto em seções**: dados gerais, preços (com margem só
  quando calculável), estoque (saldo não editável — passa por movimento),
  fiscal, e-commerce e variantes. Subcategoria e descrição de vitrine.
- **Foto de produto**: arquivo no disco do backend (`server/data/uploads/`),
  servido em `/uploads/produtos`. Normalização no navegador (canvas, 1600px).
  Galeria com principal, excluir e reordenar. **Sem foto, o produto fica sem
  imagem** — nunca uma genérica no lugar.
- **PrintEngine**: fila com estados, renderização (cupom 80mm, A4, etiqueta
  50×30) e segunda via que **não refaz o fato**. Impressoras por operação.
  Orçamento, pré-venda e comprovante do PDV imprimem.
- **NF-e por e-mail**: `/sistema/compras/nfe-email`. Outra porta para o mesmo
  `NfeImportService` — receber não dá entrada, a nota vai para conferência.
  Mesmo XML por upload e por e-mail = uma nota só. Anexo que não é XML é
  registrado e ignorado. Senha de aplicativo cifrada no cofre, nunca devolvida
  pela API. Sem credencial real: `READY_FOR_CREDENTIAL`.
- **Certificado A1 por operação**: `/sistema/fiscal/certificado` carrega,
  substitui e desativa; mostra NÃO CONFIGURADO / VÁLIDO / PRÓXIMO DO
  VENCIMENTO / VENCIDO com dias restantes (aviso a partir de 30 dias).
  Reusa `FiscalCertificateService` + `FiscalSecretVault`. O `.pfx`, a chave e a
  senha nunca saem pela API — há teste para isso.

## PARCIAL — existe módulo com teste, falta ligação com a tela

`nfe/`, `nfce/`, `logistics/`, `crm/`. **Não recriar**: o que falta neles é
interface e credencial, não fundação.

## NÃO INICIADO

Compras além do XML, fidelidade, locação, BI, automações, portal do
proprietário (rota e autorização existem; falta tela e conta de proprietário
no seed), agente local de impressão.

---

## Dependências externas — nada homologado

| Provedor | Estado | O que falta do usuário |
| --- | --- | --- |
| Asaas | `READY_FOR_CREDENTIAL` | API key sandbox + URL pública de webhook |
| NF-e | `READY_FOR_CERTIFICATE` | A1 (.pfx) + senha, CNPJ, IE, CRT, série |
| NFC-e | `READY_FOR_CERTIFICATE` | CSC + CSC ID por operação |
| Correios / Jadlog | `NOT_IMPLEMENTED` (sem integração direta) | Nada — os serviços saem pelo Melhor Envio; contrato direto exigiria programação |
| Melhor Envio | `READY_FOR_CREDENTIAL` (cotação, etiqueta e rastreio) | Token de produção pela tela Loja → Logística + `LOGISTICS_PRODUCTION_ENABLED=true` + saldo na carteira para a etiqueta — ver ESTADO-ATUAL |
| TEF | `READY_FOR_HARDWARE` | SDK do provedor + PinPad |
| Impressora | `READY_FOR_HARDWARE` | Modelo + agente local |

`GET /api/v1/core/integrations/status` devolve isso em tempo de execução.

---

## Onde continuar (ordem sugerida)

1. **Fiscal** — consolidar UMA arquitetura (`Frontend → API → FiscalService →
   Vault → SEFAZ`) e neutralizar os caminhos paralelos legados. Config por
   operação já tem lugar no schema.
2. **Impressão** — `PrintEngine` com fila (`pending/printing/printed/failed`)
   + contrato do agente local. Sem impressora: `READY_FOR_HARDWARE`, nunca
   marcar `printed`.
3. **Logística** — cotação no checkout (origem, CEP, peso, dimensões) e
   `shipment/label/tracking` ligados ao OMS que já existe.
4. **Retrofit** — converter tela a tela usando `src/components/gs/ui.tsx`.
   Não fazer replace cego de cor: cada troca de fundo exige a do texto.
5. **CRM / fidelidade / locação / BI / automações**.

### Arquivos-chave

| Assunto | Arquivo |
| --- | --- |
| Conexão/transações | `server/src/db/sqlite.ts` |
| Schema atual | `server/src/db/schema.ts` |
| Migrations | `server/src/db/core-migrations.ts` |
| Estoque (ledger/reserva) | `server/src/services/core/InventoryService.ts` |
| Vendas | `server/src/services/core/SalesService.ts` |
| Oficina | `server/src/services/core/WorkshopCoreService.ts` |
| Equipamentos | `server/src/services/core/EquipmentService.ts` |
| XML NF-e | `server/src/services/core/NfeImportService.ts` |
| Loja online | `server/src/services/core/StorefrontService.ts` |
| Pagamentos | `server/src/services/core/PaymentService.ts` |
| Rotas do núcleo | `server/src/routes/v1/core.ts` |
| Loja pública | `server/src/routes/v1/storefront.ts` |
| Design tokens | `src/design/tokens.css` |
| Casca | `src/components/gs/AppShell.tsx` |

### Regras que não podem regredir

- **Nunca usar `crypto.randomUUID()` direto** — use `uuid()` de `src/lib/uuid.ts`.
  A API nativa só existe em contexto seguro; pelo IP da rede em HTTP ela não
  existe e derruba a tela inteira.

- `@import` dos tokens **antes** dos `@tailwind` em `src/index.css` — invertido,
  o CSS inteiro some.
- CORS aceita localhost e rede privada fora de produção (PDV pela LAN).
- Caminho do banco ancorado na raiz do repo, nunca em `process.cwd()`.
- Nenhum endpoint aceita `companyId` do cliente.

- **Índice sobre coluna adicionada por migração NÃO entra na DDL canônica.**
  `ensureCoreSchema` roda ANTES das migrations; num banco existente a coluna
  ainda não existe e o `CREATE INDEX` derruba a subida inteira com
  "no such column". O índice pertence ao passo da migração, depois do ALTER.
- **Tabela nova entra em `CORE_TABLES_IN_DELETE_ORDER`** respeitando as
  dependências — inclusive quando a tabela ganha uma FK nova para outra que já
  existia (foi o caso de `core_stock_movements` → `core_workshops`).
- **UPDATE monta as colunas a partir das chaves do objeto**, nunca de lista
  fixa: acrescentar um campo com lista fixa desalinha `Object.values` e grava
  cada valor na coluna errada, em silêncio.
- **Migration já aplicada é imutável.** Correção de passo antigo entra como
  passo NOVO. Cada passo tem marca própria (`core_migration_step_N`) gravada na
  mesma transação — o número global `core_schema_version` é só informativo.
  Isso existe porque o marcador único mentia: era gravado no fim mesmo quando
  nenhum passo tinha efeito, e salvar o arquivo entre duas edições (o `tsx
  watch` recarrega a cada gravação) já bastava para o banco ficar "atualizado"
  sem estar. Aconteceu **duas vezes** — uma coluna e uma chave única — e as
  duas só apareceram ao fechar uma venda.
- **Reconstrução de tabela roda FORA da transação geral.** `PRAGMA
  foreign_keys` é ignorado dentro de transação, e derrubar uma tabela com
  filhos apontando para ela quebra a integridade. Procedimento do SQLite:
  desligar as chaves, reconstruir, `PRAGMA foreign_key_check`, só então
  confirmar. Ver `rebuildQuotesForKindNumbering`.
- **Tabela nova precisa entrar em `CORE_TABLES_IN_DELETE_ORDER`**, na ordem
  certa das dependências — senão a limpeza entre testes falha por chave
  estrangeira.
- **`reconcileCoreSchema()` é rede de segurança, não a regra.** Compara o banco
  real com a DDL canônica de `schema.ts` e ADICIONA coluna faltante. Nunca
  remove coluna, muda tipo nem toca em dado — reparo silencioso destrutivo é
  pior que o problema que ele resolve.
- **Um único lançamento de gaveta por venda.** A UNIQUE
  `(session_id, reference_type, reference_id, movement_type)` é o que impede
  clique duplo de creditar o caixa duas vezes. As entradas em dinheiro são
  somadas e o troco é descontado uma vez só.
- **Troco não é receita.** A gaveta fica com o líquido; o financeiro liquida o
  total da venda.
- **Alçada mora no servidor.** Desconto acima do limite do operador é recusado
  pela API, não apenas escondido na tela.

---

## ESCOPO ATIVO — a operação não muda sozinha

**ACTIVE_SCOPE ISSUE: NOT REPRODUCED — caminhos fechados.**

Na rodada anterior, PJ Motors virou Me Mimei uma vez, sem escolha. Não foi
reproduzido. Em vez de caçar o caso, a troca silenciosa foi tornada impossível
(`src/lib/activeScope.ts`):

- toda mudança de sessão declara um MOTIVO;
- só `LOGIN`, `DEVICE_LOGIN` e `EXPLICIT_OPERATION_CHANGE`
  podem trocar de operação. `TOKEN_REFRESH` e `SESSION_RESTORE_VALIDATED` não
  podem — são os dois caminhos que rodam sozinhos. Se mudarem, estoura;
- a operação exibida tem de ser a mesma do token;
- diário em memória com previous/new de company, unit, PDV e oficina, motivo,
  origem, usuário e horário. Sem token, sem senha — há teste cobrando.

A auditoria dos caminhos (session restore, localStorage, IndexedDB, select,
login, quick access, navegação, refresh, guards, autocomplete, cross-tab,
storage event) achou **dois buracos reais**, nenhum deles o caso observado:

1. `switchCompany` tinha `target ?? current.company`: emitia token para uma
   empresa e continuava exibindo outra. A pessoa lia "PJ Motors" e vendia na
   Me Mimei.
2. A restauração lia o `localStorage` como verdade, sem conferir se a empresa
   exibida era a do token.

Fora do `client.ts` **nada escreve `gs.session`**. Os dois `addEventListener
('storage')` do repositório estão na árvore legada inalcançável e não tocam a
sessão.

## Gates (última execução)

Backend: 90 arquivos, **1123 testes passando**, 22 skipped — três execuções
seguidas com `npm run test:capture`, todas verdes.

### A falha da suíte agora deixa rastro

Uma execução falhou e a saída foi embora com o terminal: sem arquivo, sem
stack, sem nome do teste. `npm run test:capture --prefix server` grava a saída
**no momento da falha** em `server/.test-failures/ultima-falha.log` — arquivo,
teste, stack, duração, node e plataforma. Execução verde apaga o log anterior.

Provado por falsificação: com um teste que falha de propósito o arquivo saiu
com o nome do teste, a asserção e a linha; removido o teste, a pasta ficou
limpa. A falha original segue **NÃO REPRODUZIDA** em ~20 execuções.
Frontend: 135 arquivos, **1891 testes passando**, 3 skipped.

**Teste de tela não era coletado — corrigido e provado.** O `vitest.config.ts`
nomeava duas pastas (`src/lib/__tests__`, `src/components/__tests__`). Teste em
`src/pages`, `src/guards`, `src/hooks` ou `src/stores` ficaria verde por nunca
ter rodado. O padrão agora é por **extensão** (`src/**/*.test.ts(x)`).

Provado por falsificação: com uma falha proposital em `src/pages`, a suíte foi
de 131 arquivos verdes para `1 failed | 131 passed (132)`. Removida, voltou a
131 verdes. Um gate que não quebra quando deveria não é gate.

### Reserva de estoque — a caracterização anterior estava errada

O checkpoint anterior registrou "seed grava `reserved: 1` sem movimento". Está
corrigido: as duas reservas **têm origem** — dois pedidos reais em
`aguardando_pagamento` (Gringa #1 e PJ Motors #1) segurando uma peça cada. Não
vêm do seed.

O que existe de verdade é menor: o Patinete tem reserva sem movimento
correspondente no razão, resquício anterior ao razão de reserva do e-commerce.
Saldo coerente, história incompleta.

`inventoryReconciliation` passa a conferir — e só conferir, porque conserto
automático de saldo esconde a causa. Três verificações:
`STOCK_RESERVATION_WITHOUT_SOURCE` (crítica), `OPEN_ORDER_WITHOUT_RESERVATION`
(crítica) e `RESERVATION_WITHOUT_LEDGER` (aviso). Base operacional hoje: **zero
críticas nas seis operações**, um aviso no Patinete.
Lint, type-check e build limpos nos dois lados. Secret scan OK.

### O flake foi reproduzido e corrigido

Reproduzido na nona execução: `ecommerce-jornada > dez cliques em pagar`
estourou os 5 s (6302 ms). Não era lentidão de máquina — era desperdício real
no código. `montarRetorno` buscava o copia-e-cola do PIX no provedor a **cada**
leitura da cobrança; dez leituras, dez idas ao Asaas, por um dado já gravado
que não muda enquanto a cobrança existir.

Em produção isso era latência para o comprador toda vez que ele abria a tela do
pedido, e consumo de limite de requisições por nada. Com o payload guardado, a
leitura é local: o teste caiu para 1173 ms e ganhou uma asserção — o QR é
buscado **uma** vez. Seis execuções seguidas depois da correção, todas verdes.

### O gate de tipos do frontend não checava nada

`npx tsc --noEmit -p tsconfig.json` na raiz **sai com código zero sem compilar
uma linha**: o arquivo tem `files: []` e só referências, e sem `--build` o
compilador não entra nos projetos referenciados. O comando correto é
`npm run type-check` (que roda `tsconfig.app.json`, `tsconfig.node.json` e o
servidor). `vite build` também não serve: usa esbuild, que transpila sem
checar tipo.

Estavam represados **45 erros reais**, todos da mesma causa — `subtitle`
passado a `Card` e `PageHeader`, que não aceitavam a propriedade. O React
descarta prop desconhecida em silêncio, então o texto explicativo de 45 telas
simplesmente não existia: a chave de acesso no diálogo de cancelamento, o
aviso "numeração inutilizada não volta a ser emitida", os subtítulos de todos
os cards. Componentes corrigidos, `tsconfig.json` da raiz documentado.

---

## ROUTES_MIGRATED — domínios que saíram de "em breve"

Cada um seguiu a mesma ordem: backend central → tela nova → rota → menu →
RBAC → navegador. Nenhuma rota legada foi liberada pelo guard novo.

| Domínio | Rota nova | Backend | Estado |
| --- | --- | --- | --- |
| Equipamentos | `/sistema/equipamentos` | `EquipmentService` (já existia) | IMPLEMENTADO |
| Mecânicos e técnicos | `/sistema/oficina/mecanicos` | `TeamService` (novo) | IMPLEMENTADO |
| Usuários e equipe | `/sistema/usuarios` | `TeamService` (novo) | IMPLEMENTADO |
| Contas a receber | `/sistema/financeiro/contas-a-receber` | `FinanceService` (novo) | IMPLEMENTADO |
| Contas a pagar | `/sistema/financeiro/contas-a-pagar` | `FinanceService` (novo) | IMPLEMENTADO |

Mecânicos e Usuários são a MESMA tela: a pessoa é uma só, o que muda é o
perfil. Entrando pela Oficina, a lista já vem filtrada em quem atende bancada.
Contas a receber e a pagar também: o lançamento é o mesmo, muda a direção.

---

## CENTRAL_DOMAINS — o que é autoridade hoje

`core_users` + `core_user_companies` (perfil) + `core_workshop_members`
(oficina) — não existe entidade "mecânico" paralela.
`core_finance_entries` + `core_finance_settlements` — receber e pagar são o
mesmo domínio com `direction` in/out.
`core_equipment`, `core_products`, `core_stock_movements`, `core_sales`,
`core_customers`, `core_suppliers`, `core_quotes`, `core_print_jobs`,
`core_mail_inboxes`.

**Correção ao relatório anterior**: AR/AP foi classificado como "sem API
central". Estava errado — `core_finance_entries` já existia e já era alimentada
pelas vendas. O que faltava era o *writer* (baixa, baixa parcial, estorno), não
o domínio.

---

## EM_BREVE_STATUS

**Antes desta rodada:** 21 · **Agora:** 15 entradas (14 conceitos —
*Fornecedores* aparece em dois menus).

| Item | Classe | Por quê |
| --- | --- | --- |
| Fornecedores | **B** | `core_suppliers` existe, mas só com nome/documento/contato. Falta writer, condições comerciais e histórico de compras. |
| Pedidos de compra | **B** | Depende de Fornecedores. Fluxo mínimo: fornecedor → pedido → recebimento → XML → estoque/AP. |
| Peças | **B** | `InventoryService` existe; falta o recorte por oficina e a visão do mecânico (sem custo, sem margem). |
| Conciliação | **B** | Depende de extrato bancário; hoje só há conferência de maquininha. |
| Ajustes e inventário | **B** | A razão de estoque existe; falta a tela de contagem. |
| Cancelamentos e devoluções | **B** | Não existe writer de devolução. |
| Leads e oportunidades | **B** | `core_customers` é autoridade; falta Lead/Opportunity. |
| Fidelidade | **B** | Domínio inexistente no core. |
| Contratos | **B** | Domínio inexistente no core. |
| Logística | **C** | Depende do token Melhor Envio (Correios e Jadlog saem por ele). |
| BI | **B** | O dashboard cobre o básico; BI de verdade é outro escopo. |
| Automações | **D** | Não deve existir como item de menu antes de haver o que automatizar. |
| NF-e | **C** | Depende de certificado A1 real + SEFAZ de homologação. |
| NFC-e | **C** | Depende de CSC + CSC ID. |

Nenhum item classe **A** (falta apenas UI) restou: tudo que tinha backend
pronto foi entregue nesta rodada.

---

## LEGACY_ROUTES_REMAINING

350 rotas em `src/router/config.tsx`, todas inalcançáveis: ficam atrás de
`AuthGuard` lendo o `useAuthStore` antigo, que a sessão atual não satisfaz.

**Não foram liberadas, e não devem ser.** Elas escrevem em IndexedDB e stores
legados; ligá-las ao guard novo criaria writers paralelos ao núcleo. Servem
como fonte de requisitos e UX, não como implementação.

As rotas legadas homônimas das migradas (`/sistema/equipamentos`,
`/sistema/usuarios`) continuam declaradas, mas as novas vêm ANTES em
`src/router/index.ts` e vencem o match. Não há duas telas oficiais concorrentes.

---

## FISCAL — estado real

### O autorizador falso (corrigido)

`authorizeNfceDocumentBackend` **inventava a autorização**: montava protocolo
com `135${Date.now()}`, chave de acesso com `6526${Date.now()}` e gravava
`status: 'authorized'`. Nenhum XML, nenhuma assinatura, nenhuma consulta à
SEFAZ. A tela mostraria AUTORIZADA e o cupom sairia com uma chave inexistente.

Havia um **teste guardando essa fabricação** — afirmava `status: 'authorized'`.
A suíte ficava verde porque exigia que a mentira acontecesse. Ambos corrigidos:
o serviço recusa (409 `CORE_FISCAL_NOT_AUTHORIZED`) e o teste cobra a recusa.

### A trava é permanente

`server/tests/session-switch.test.ts` cobra, em três níveis, que ninguém
reintroduza a fabricação:

1. a rota legada não devolve autorização (barra na permissão);
2. o serviço recusa **quando chamado diretamente**, não só pela rota;
3. invariante de banco: nenhum documento fica `AUTHORIZED` sem `protocol`.

**Não reative** `authorizeNfceDocumentBackend`. Ele existe apenas para lançar
`CORE_FISCAL_NOT_AUTHORIZED`.

### O que foi construído

| Peça | Estado |
| --- | --- |
| Domínio fiscal central (5 tabelas em SQLite) | IMPLEMENTADO |
| Chave de acesso 44 dígitos + DV módulo 11 | IMPLEMENTADO, testado |
| Numeração server-side por (empresa, modelo, série) | IMPLEMENTADO, testado |
| Configuração fiscal por operação | IMPLEMENTADO |
| Validação de CNPJ (dois DVs) | IMPLEMENTADO, testado |
| Readiness / portão de emissão | IMPLEMENTADO, testado |
| Tela de configuração e checklist | IMPLEMENTADO, verificado |
| RBAC fiscal (mecânico → 403) | IMPLEMENTADO, testado na API |
| Pendências fiscais de produtos (lista + correção) | IMPLEMENTADO, verificado |
| Troca de sessão (5 pares, validada pelo token) | TESTADO — sem defeito |
| XML NFC-e (modelo 65) | IMPLEMENTADO, 26 testes |
| Validação pré-transmissão | IMPLEMENTADO — **sem XSD** (ver abaixo) |
| Assinatura XMLDSig | IMPLEMENTADO, 13 testes criptográficos |
| Máquina de estados + idempotência | IMPLEMENTADO, 17 testes |
| Adapter SEFAZ + parser de cStat | IMPLEMENTADO, 30 testes |
| Provider de teste (bloqueado em produção) | IMPLEMENTADO |
| Fila, single-flight, retry, backoff | IMPLEMENTADO |
| Consulta pós-timeout / recovery | IMPLEMENTADO |
| **Endpoints das UFs** | **VAZIOS — preencher com a tabela oficial** |
| DANFCE (a partir do documento fiscal) | IMPLEMENTADO, 12 testes |
| Reconciliação (11 checagens, não destrutiva) | IMPLEMENTADO, 18 testes |
| Pipeline venda → autorização (idempotente) | IMPLEMENTADO, 19 testes |
| Tela Fiscal › Documentos + detalhe + timeline | IMPLEMENTADO, verificado |
| Reconciliação na UI | IMPLEMENTADO |
| Painel fiscal DENTRO do PDV | IMPLEMENTADO, verificado no navegador |
| Cenários de teste selecionáveis (só fora de produção) | IMPLEMENTADO |
| E2E navegador: AUTHORIZED / REJECTED / TIMEOUT | **3/3 PASS** |
| Contingência — infraestrutura | `CONTINGENCY_FOUNDATION_READY`, 20 testes |
| Contingência — regra legal | **`EXTERNAL_RULES_PENDING`** (ver abaixo) |
| Contador de pendências no PDV | IMPLEMENTADO, verificado |
| Readiness fiscal no PDV | IMPLEMENTADO, verificado |
| Contingência | **NÃO IMPLEMENTADO** |
| Testes automatizados do painel do PDV | IMPLEMENTADO, 13 testes |
| XML NF-e (modelo 55) | IMPLEMENTADO, 21 testes |
| Criação da NF-e 55 (numeração própria, idempotente) | IMPLEMENTADO, 16 testes |
| DANFE A4 (lê o XML do documento) | IMPLEMENTADO, verificado |
| Cancelamento NF-e (com evidência) | IMPLEMENTADO, 24 testes |
| Carta de correção (política conservadora) | IMPLEMENTADO |
| Inutilização de faixa (sequência pula) | IMPLEMENTADO |
| UI de NF-e / inutilizações / E2E do 55 | **NÃO IMPLEMENTADOS** |

**Limite declarado da CC-e:** a lista legal completa de alterações vedadas
exige a norma vigente, que não está no projeto. A política implementada é
conservadora — bloqueia valor, quantidade, tributação, identidade das partes e
data de emissão, e pode recusar textos que a norma permitiria. Ver
`CCE_LIMITATION_NOTICE`.
| SOAP/transport | **NÃO IMPLEMENTADO** |

### Suíte instável — RESOLVIDO

**Causa: `PRAGMA synchronous = FULL`.** Cada commit espera fsync; com os
arquivos de teste em paralelo, dezenas de `beforeEach` disputando o disco
estouravam o timeout de 10s do hook. Aparecia como instabilidade em arquivos
sem defeito, e a cascata escondia a origem.

FULL segue sendo o padrão em operação — já salvou os dados numa queda de
energia real. Em teste o banco é temporário, então a durabilidade não compra
nada e custava o portão.

**Backend: 5/5 PASS. Frontend: 129 arquivos, 1818 testes, verde.**

Registrado no código: a hipótese de que o gargalo fossem as 264 chamadas
`DELETE` separadas foi **medida e descartada** (26,9 ms contra 27,0 ms).
| QR Code NFC-e | Existe helper legado; não integrado ao domínio novo |
| Transmissão SEFAZ | **NÃO IMPLEMENTADO** (clients legados não consolidados) |
| DANFCE / DANFE | **NÃO IMPLEMENTADO** |
| Cancelamento / inutilização / CC-e | Schema pronto (`core_fiscal_events`), writer não |
| Contingência | Schema pronto (`contingency_mode`, tpEmis 9 na chave), fluxo não |
| Fila / retry / recovery / reconciliação | Schema pronto (`core_fiscal_queue`), worker não |

### Duas dependências técnicas registradas (não são credenciais suas)

**1. XSDs da SEFAZ ausentes.** `validateAgainstSchema` devolve `validated:
false` e só confirma boa formação. XML bem formado **não** é XML conforme o
layout: ordem de elementos, cardinalidade e domínio de valor só são checados
pelo schema. Falta adicionar o pacote oficial (PL_009 ou o vigente) e ligar um
validador XSD.

**2. Canonicalização simplificada no XMLDSig.** Cobre o XML que este projeto
gera, que é determinístico. Não é C14N completo (namespaces herdados,
comentários, ordenação de atributos em documento externo). Antes da
homologação, trocar por biblioteca XMLDSig dedicada. Registrado em
`SIGNER_LIMITATIONS`.

**3. Endereços dos web services por UF ausentes.** `SEFAZ_ENDPOINTS` está vazio
e `resolveEndpoint` recusa a transmissão dizendo o que falta. Não existe URL
nacional única para NFC-e: cada UF publica as próprias, e alguns estados
delegam a autorizadores diferentes. Preencher exige a tabela oficial para as
UFs onde o Grupo opera. **Nada foi inventado.**

**4. Teste instável — CORRIGIDO.** A hipótese registrada antes (cache de
`loadEnv()`) estava **errada**: o cache já era resetado nesses blocos. Faltava
`resetDbForTests()` — os checklists de homologação leem estado persistido, e o
resultado dependia de qual arquivo tinha rodado antes no mesmo worker. Não
havia bug novo; havia uma dependência de ordem latente que os arquivos da
rodada anterior passaram a exercitar. `tests/env-isolation.test.ts` cobre o
isolamento de env nos dois sentidos. **Suíte completa: 3/3 PASS.**

**5. Contingência — o que falta é regra externa, não código.** A NFC-e usa a
contingência OFFLINE (`tpEmis = 9`), que a infraestrutura já carrega na chave e
no XML. Não implementado, por falta de fonte: o **prazo** de transmissão do
documento offline (varia por UF); se a UF de operação **admite** offline ou
exige **EPEC** (`tpEmis = 4`); os **dizeres obrigatórios** do DANFCE em
contingência; e o **QR offline**, que depende do CSC. Ver
`FiscalContingencyService.CONTINGENCY_EXTERNAL_DEPENDENCIES`.

### A1_STATUS

Há um certificado carregado para o Preço Justo. **Não serve para emitir**: o
emissor é `AC SOLUTI Multipla v5 (TESTE)` — hierarquia de teste, que a SEFAZ
recusa. A senha do .pfx não é guardada (por desenho), então assinar exige que
o usuário a informe a cada operação.

### CSC_STATUS
Não configurado em nenhuma operação. Sem CSC não há QR, e sem QR o cupom não
vale.

### SEFAZ_STATUS
Nenhuma transmissão real executada. O item fica `PENDING` no checklist e o
readiness é `READY_FOR_CERTIFICATE`.

### PRODUÇÃO
Bloqueada. `production_unlocked` nasce 0 e não é ligada pela tela nem por
variável de ambiente.

---

## FISCAL — situação após a macro-rodada 1

| Frente | Estado |
| --- | --- |
| NFC-e 65 — núcleo interno | **FECHADO** |
| NF-e 55 — núcleo interno | **FECHADO** |
| Eventos fiscais (cancelamento, CC-e, inutilização) | **FECHADO** |
| Telas fiscais (Documentos, Inutilizações) | **FECHADO** |
| SEFAZ real | **NÃO TESTADO** |
| Homologação | **NÃO** |

"Fechado" quer dizer: o caminho existe do começo ao fim, tem teste, e foi
percorrido no navegador. Não quer dizer homologado — todo protocolo hoje
começa com `TEST-`, que é a marca do provider de teste. Nenhuma nota deste
sistema foi apresentada a uma SEFAZ real.

### E2E no navegador — o que foi percorrido

Fixture isolada (`server/scripts/e2e-fiscal-fixture.ts`, série 99, prefixo
`e2e55-`) sobre a base operacional, com limpeza e conferência ao final:
`integrity_check` ok, `foreign_key_check` vazio, nenhum resto, sequências
devolvidas.

1. NF-e autorizada aparece na lista, com selo TESTE e cStat.
2. DANFE abre com o layout do modelo 55.
3. Reimpressão devolve o mesmo documento.
4. Cancelamento autorizado pela tela: aviso obrigatório, justificativa,
   protocolo, documento passa a Cancelada.
5. Cancelamento recusado: documento **continua autorizado**, e a recusa fica
   visível com cStat e motivo.
6. Carta de correção nº 1.
7. Carta de correção nº 2, com a sequência correta.
8. Inutilização de 900 a 905, com confirmação em duas etapas.
9. Faixa sobreposta recusada; a sequência da série saltou para 906 — número
   inutilizado não volta a ser emitido, e isso está no dado, não na intenção.
10. Isolamento entre operações: a nota da Me Mimei nunca apareceu na lista da
    PJ Motors.

Cinco defeitos apareceram nesse percurso com a suíte inteira verde. Estão
descritos no commit `b8f9742` e cobertos por
`server/tests/fiscal-tela-regressoes.test.ts`.

## MACRO-RODADA 2 — o que ficou de pé e o que não foi tocado

| Frente | Estado |
| --- | --- |
| ACTIVE_SCOPE | NOT REPRODUCED — caminhos fechados, com teste |
| ASAAS AUDIT | FEITA — ver classificação abaixo |
| ASAAS CONFIG por operação | PRONTO (backend + tela) |
| ASAAS VAULT | PRONTO — chave nunca volta pela API |
| ASAAS REAL CONNECTION | TRANSPORTE EXERCITADO, credencial recusada (401) |
| ASAAS HOMOLOGATED | NÃO |
| WEBHOOK | PRONTO — por operação, idempotente, fora de ordem coberto |
| REFUND / CHARGEBACK | Registrado na intenção e na linha do tempo do pedido |
| CUSTOMER MAPPING | PRONTO — vínculo por operação e ambiente |
| CHECKOUT → COBRANÇA | PRONTO — PIX e boleto na conta da operação |
| RESERVA / FINANCEIRO | PRONTO — já eram; agora com teste de ponta a ponta |
| PROMOÇÃO PDV × LOJA | PRONTO — regressão coberta |
| CARTÃO ONLINE | `PENDING_PROVIDER_FLOW` |
| NF-e BRIDGE | DIAGNÓSTICO apenas — emissão não implementada |
| OMS / FULFILLMENT | PRONTO — no `core`, com invariantes provados |
| RETIRADA × ENTREGA | PRONTO — cada caminho recusa a etapa do outro |
| COTAÇÃO DE FRETE | PRONTA — recusa sem pacote real |
| SHIPMENT / LABEL / TRACKING externos | NÃO IMPLEMENTADOS |
| E-COMMERCE UI (home, loja, produto, carrinho, checkout, painel) | NÃO TOCADO |

## BANCO CENTRAL (SUPABASE) — FASE 2: **PRONTA**

Cobertura, schema central, projetor, carga inicial e worker. Tudo provado com
central de TESTE — o projeto continua desenvolvível sem credencial real.

### REGRA ZERO — o banco operacional agora se defende

`db/safety.ts`, com **duas barreiras independentes**:

1. **Positiva** — o banco precisa estar marcado como descartável (`:memory:`
   ou o caminho exato anunciado em `TEST_DATABASE_PATH`). Sem heurística de
   nome: um arquivo chamado `producao-teste.db` NÃO vira descartável por causa
   da palavra "teste".
2. **Negativa** — mesmo marcado, o caminho do banco operacional é recusado.
   Se alguém apontar `TEST_DATABASE_PATH` para a base real, a primeira
   barreira passaria e esta segura.

`NODE_ENV=test` não é aceito sozinho: qualquer ferramenta o define, e ele não
diz nada sobre QUAL arquivo será apagado. Provado por falsificação em
`tests/db-safety.test.ts` — script fora da suíte apontando para a base real é
recusado **antes de qualquer DELETE**, e as contagens ficam intactas.

**Snapshot antes de migração estrutural** (`db/backup.ts`), via `VACUUM INTO` —
não cópia de arquivo, que com WAL produz um backup que parece íntegro e está
desatualizado. Só o banco operacional é copiado: teste não tem o que proteger.

### Dois defeitos reais encontrados nesta rodada

**1. Toda venda falharia em banco que viveu a v23.** O passo 24 só ADICIONA
colunas — o SQLite não afrouxa constraint por ALTER —, então `entity_type` e
`entity_id` continuavam NOT NULL e o INSERT novo não as preenche. A suíte não
pegou porque banco de teste nasce do DDL canônico, já sem elas; o defeito
apareceu ao aplicar a migração no banco operacional real. Corrigido no **passo
25**, que reconstrói a tabela preservando o conteúdo, com teste de drift
provado por falsificação.

**2. Índice canônico sobre coluna que só a migração adiciona.** `ix_outbox_*`
referenciava `status`/`aggregate_type`, e `ensureCoreSchema()` roda ANTES dos
passos: o banco travava sem chegar na migração que resolveria. Os índices
saíram da DDL canônica para o passo 24. O projeto já tinha teste sobre
exatamente esta armadilha — ela voltou por outro caminho.

### Envelope versionado

`recordDomainEvent` é a **porta única**; `enqueue` solto não é usado por
writer nenhum. O envelope carrega `eventId`, `eventType`, `aggregateType`,
`aggregateId`, `companyId`, `operationalUnitId`, `occurredAt`, `schemaVersion`
e `payload`. Sem versão no envelope, evoluir o payload depois quebraria a
leitura de todo evento antigo — e evento de venda não se regenera.

Estados da fila: `pending` → `processing` → `synced`, com `retry` e `dead`.
`processing` existe para distinguir "morreu no meio do envio" de "nunca saiu".

### Cobertura por domínio

Produto, variante, cliente, movimento de estoque, reserva, venda, pagamento,
lançamento financeiro, pedido, status do pedido, documento fiscal, evento
fiscal, ordem de serviço e equipamento — todos DENTRO da transação do fato.

A trava do outbox encontrou **quatro writers que gravavam fora de transação**
(`createCustomer`, `updateProduct`, `addOrderEvent`, `recordFiscalEvent`).
Todos passaram a ser transacionais; aninhados, viram SAVEPOINT.

### Projetor e ordenação

`Projector.ts` traduz fato bruto em linha de negócio. Duas propriedades:
**upsert por chave** (replay completo não duplica) e **guarda de ordem** por
`node_seq` — um "pedido criado" atrasado não reverte um "pedido entregue".
Histórico (razão de estoque, timeline do pedido) é imutável e não usa guarda.
Cadastro nunca é apagado: produto desativado vira tombstone.

### Carga inicial

`bootstrapCentralFromLocal()` com id **derivado** do fato
(`bootstrap:<agregado>:<id>`), não aleatório — dez execuções, uma linha.
Checkpoint persistido para retomar sem duplicar; lotes com transação própria,
porque uma transação única sobre dezenas de milhares de linhas travaria o PDV.
`compareLocalWithCentral()` reporta MATCH/MISMATCH por domínio e **nunca**
altera o banco operacional para fazer bater.

### Schema central versionado

`docs/supabase/01-landing.sql` e `02-central-schema.sql`, com
`erp_central_migrations` — versão da central **independente** da versão local.
RLS ligada e **sem política** em todas as tabelas: só a `service_role` alcança,
nunca o navegador. Guia operacional completo em `docs/supabase/README.md`.

### O que falta

1. **Credencial do servidor** — `DEVORA_SUPABASE_URL` + `DEVORA_SUPABASE_SERVICE_KEY`.
   **Depende do dono.**
2. **Central real NÃO testada.** Tudo foi provado com transporte de teste; o
   PostgREST real nunca foi exercido.
3. Projeção rodando na central (hoje o projetor existe e é testado, mas quem
   escreve nas tabelas de negócio ainda é o `InMemoryCentral`).
4. Worker automático existe (`startSyncWorker`) mas não é ligado no boot.
5. Legado morto da Supabase antiga no frontend (14 arquivos) segue
   inalcançável e não foi removido.

---

## BANCO CENTRAL (SUPABASE) — FASE 1

### A decisão, e por que ela é essa

O SQLite local **não** foi substituído. Ele deixou de ser "o banco" e passou a
ser o **nó operacional**: o PDV precisa vender com a internet caída, e uma loja
que para de faturar porque o link oscilou é um problema maior do que qualquer
relatório consolidado resolve. A Supabase é a **central**, que recebe os fatos
quando a conexão volta.

Isso também eliminou o obstáculo técnico que tornava a troca direta inviável:
`node:sqlite` é síncrono e todo cliente Postgres é assíncrono. Trocar o driver
transformaria **212 das 231 funções** dos services em `async`, com o `await`
subindo por 429 rotas e pela suíte inteira — cada uma dessas funções segurando
invariante de dinheiro ou de estoque. Na arquitetura híbrida, o envio roda em
segundo plano e **nada no caminho da venda vira assíncrono**.

O frontend NÃO fala com a Supabase para estoque, venda, financeiro ou fiscal.
A API Express continua sendo a única autoridade de negócio.

### O que sustenta a corretude

**O evento vive e morre com o fato.** `enqueue` só funciona dentro da transação
que grava o fato e **recusa** chamada fora dela. É isso que fecha o buraco
clássico do padrão — "gravou a venda e caiu antes de publicar", que faz a
central divergir para sempre sem ninguém perceber. Rollback da venda leva o
evento junto; há teste cobrando.

**Reenvio não duplica.** O `id` do evento é chave primária no destino e o envio
é UPSERT. O mesmo lote saindo dez vezes resulta em uma linha — nunca em dez
vendas. Provado no teste.

**Nada sai da fila sem confirmação da central**, e só os ids que ela disse ter
aceitado. Lote parcialmente aceito é caso normal: o resto continua pendente.
Central fora do ar mantém a fila intacta, com motivo e backoff exponencial
(teto de 5 min).

**Segredo não sai do nó.** Hash de senha, certificado, senha do certificado,
chave de API, token de webhook, token de sessão e dado de cartão são removidos
do payload em qualquer profundidade; tabelas que existem só para guardar
segredo não são sincronizáveis de forma alguma. Há teste para os dois casos.

**Sem credencial, nada é inventado.** O estado é `READY_FOR_CREDENTIAL`, a fila
acumula, e a tela nomeia as variáveis que faltam.

### Onde está

- `server/src/services/sync/OutboxService.ts` — fila, redação de segredo,
  identidade do nó.
- `server/src/services/sync/SyncService.ts` — transporte plugável, PostgREST da
  Supabase com `resolution=merge-duplicates`.
- `core_outbox` (migração 23, `CORE_TARGET_VERSION = 23`). Banco que já operava
  começa com a fila **vazia** de propósito: carga inicial da central é trabalho
  à parte, com conferência, não algo que uma migração dispara no meio do
  expediente.
- `/sistema/integracoes/central` — situação da fila, atraso do fato mais
  antigo, última falha e "Sincronizar agora".
- `docs/supabase/01-landing.sql` — DDL da tabela de aterrissagem, com RLS
  ligada e **sem política**: só a `service_role` alcança, nunca o navegador.

### O que falta (fases seguintes)

1. **Credencial do servidor** — `DEVORA_SUPABASE_URL` + `DEVORA_SUPABASE_SERVICE_KEY`.
   **Depende do dono.** A chave publicável que já está no `.env` é do navegador
   e não serve: escrever a central com ela seria confiar no cliente.
2. **Cobertura dos demais escritores.** Hoje só a venda (`core_sales`) enfileira
   — é o padrão provado, não a cobertura completa. Faltam estoque, financeiro,
   pedidos, fiscal e cadastros.
3. **Projeções na central**: da tabela de aterrissagem para tabelas de negócio.
4. **Carga inicial** do histórico que já existe no nó.
5. **Ciclo de fundo**: hoje o envio é manual pela tela ou por chamada; falta o
   agendamento automático.
6. Legado morto da Supabase antiga no frontend (`src/lib/supabase.ts` e 14
   arquivos) segue inalcançável. Não foi removido nesta rodada.

---

## ELO 2/3 — LADO DO CLIENTE: **FECHADO**

Cancelar e o que acontece quando o dinheiro chega atrasado. Percorrido no
navegador com pedido real da Conceito, e a fixture removida com
`integrity_check` e `foreign_key_check` limpos ao final.

**Um buraco real foi encontrado e fechado.** `cancelOrder` só barrava
`cancelado` e `pago`. Um pedido em `separacao`, `embalado` ou `expedido`
passava direto: o caminho liberava uma reserva que o pagamento já tinha
consumido — devolução de estoque que na verdade saiu da prateleira, e sem
devolver um centavo ao cliente. Agora responde `CORE_ORDER_IN_FULFILLMENT`.
Depois do pagamento o caminho é devolução, não cancelamento.

**Webhook tardio não ressuscita pedido cancelado.** O PIX pago segundos antes
do cancelamento chega depois dele. O pedido continua cancelado — a reserva já
foi liberada e a peça pode ter sido vendida a outra pessoa. E o dinheiro não
some: a intenção vira `paid_after_cancel`, um evento
`pagamento_apos_cancelamento` fica no pedido, e a tela do cliente mostra um
aviso com o valor, dizendo que ele **não precisa pagar de novo**. Cinco
reenvios do mesmo aviso geram **uma** pendência, não cinco.

**Cancelamento é idempotente na prática, não só no papel:** dez cliques
liberam a reserva uma vez. Sem isso, um pedido de 2 peças levaria o `reserved`
a −18 — estoque livre maior que o físico.

**A cobrança é cancelada antes do pedido.** Um PIX que continua válido depois
do cancelamento é dinheiro entrando sem nada para entregar. Falha do provedor
não impede o cancelamento: prender estoque por causa da API de terceiro seria
pior.

**O botão só aparece quando cancelar é possível de verdade** (`status ===
'aguardando_pagamento'`). Botão que sempre dá erro faz o cliente concluir que
cancelou — e sumir. Confirmação obrigatória, com o custo dito em português:
os itens voltam ao estoque, o PIX deixa de valer, e refazer o pedido pode
custar outro preço.

**Testes de tela do portal: a dívida P1 morreu.**
`src/pages/gs/__tests__/MinhaContaPage.test.tsx`, 16 testes — entrar, sessão
recusada voltando para o login (e não para uma lista vazia que parece "sua
compra sumiu"), senha ausente do `localStorage` e do DOM, pedido alheio em
404, botão presente/ausente por estado, "Manter pedido" sem chamar a API, e o
aviso de pagamento após cancelamento. Backend: `portal-cancelamento.test.ts`,
10 testes.

**A pendência chega à operação.** `/sistema/pedidos` avisa no topo quantos
pedidos cancelados receberam pagamento e lista os números, e marca a linha com
"Pago após cancelar". `listOrders` deriva o campo dos intents — não há coluna
duplicada para desincronizar. Sem isso, a pendência existiria só no portal do
cliente: ele veria o dinheiro preso e ninguém do outro lado saberia.
**Ressalva honesta:** esse aviso está coberto por teste de tela e de serviço,
mas NÃO foi percorrido no navegador — não há sessão administrativa disponível
nesta máquina para abrir `/sistema/pedidos` com dados reais.

Falta desta trilha: o resto do **Order Management** (filtro por situação,
detalhe do pedido, cancelamento pelo gestor) e o **painel do gestor com KPIs**.
O lado do cliente está fechado.

---

## MACRO-RODADA E-COMMERCE: **OPEN**

A loja pública **funciona de ponta a ponta**: portal do grupo, filtro por loja,
catálogo real com promoção, carrinho agrupado por operação, checkout com CPF, e
o PIX na tela com copia-e-cola e estado honesto. Verificado no navegador com as
lojas reais — dois itens de operações diferentes viram dois pedidos, com
estoque reservado, e o painel de pagamento diz a verdade quando a operação não
tem credencial.

**O checkout não pedia CPF** até esta rodada — e sem ele o provedor recusa a
cobrança. Todo pedido nascia sem como ser pago: era o defeito que separava
"API funciona" de "cliente compra".

**Página de produto: PRONTA.** `/loja/{loja}/produto/{id}`, com a loja
conferida **no servidor** — produto da Gringa pela URL do Preço Justo responde
404, verificado no navegador. Traz foto/galeria, marca, categoria,
subcategoria, descrição de vitrine (não a anotação interna), preço com
promoção, variantes com saldo e EAN próprios, e o estado de entrega.

**Medidas de envio: PRONTAS**, com convenção única — peso em **gramas**,
dimensões em **centímetros**. Zero, negativo e texto são recusados; vazio
continua válido (retirada não precisa). Atualizar sem informar preserva a
medida anterior.

**`shippingReadiness` é derivado** das quatro medidas — não há status
duplicado para desincronizar. Sem elas a página diz "entrega indisponível",
lista o que falta e mantém a retirada. Nenhuma cotação com caixa inventada.

**Produtos publicados sem dados de envio: 5 de 5** (Gringa 2, Me Mimei 1,
Conceito 1, PJ Motors 1). Contagem real, via
`listProductsMissingShippingData` — não há número fixo no código.

**Simulação de frete na página: PRONTA.** Campo de CEP, normalização para oito
dígitos (com ou sem hífen) e resposta honesta quando falta algo:
`SHIPPING_DATA_REQUIRED` (produto sem medidas), `INVALID_ZIP` (CEP torto, sem
gastar chamada) ou `ORIGIN_NOT_CONFIGURED` (a loja não cadastrou o endereço —
pendência do gestor, não erro do cliente). É **estimativa** declarada: o frete
que vale é o do checkout, e opção simulada é rotulada SIMULAÇÃO.

**Medidas no cadastro admin: PRONTAS.** Seção "Dados de envio" na aba
E-commerce, com a unidade no rótulo (Peso em g, dimensões em cm). Selo
`ENVIO PRONTO` / `DADOS DE ENVIO INCOMPLETOS` derivado, nunca gravado. Campo
vazio preserva a medida anterior.

**ELO 1/3: CLOSED** — incluindo o filtro administrativo "sem dados de envio",
com contador clicável e contagem calculada. A regra fica em um lugar só
(`SEM_DADOS_DE_ENVIO`), compartilhada com a vitrine e a cotação.

O que ainda falta para a macro-rodada:

**Portal do cliente: PRONTO.** `/minha-conta` e `/minha-conta/pedidos/:id`.
Identidade em tabela própria (`core_customer_accounts`, migration 22), com
e-mail como identidade e vínculo a quantos cadastros a pessoa tiver — mesmo
CPF na Gringa e no Preço Justo são dois cadastros, a pessoa é uma só.

**Método: senha com Argon2id.** Não existe envio de e-mail no sistema (só
leitura de caixa para NF-e), então OTP ou magic link nasceriam sem canal de
entrega. **Limitação declarada:** sem SMTP o cadastro não confirma a
titularidade do e-mail; criar acesso exige e-mail E documento usados numa
compra. O documento não é a senha.

**Sessão separada da administrativa:** `core_customer_sessions`, token opaco,
header `x-portal-token`, chave de storage própria. Conhecer o id de um pedido
não dá acesso — o filtro é por `customer_id` da sessão, e pedido alheio
responde 404.

O que ainda falta:

1. **Cancelamento pelo cliente** e a política de webhook atrasado depois de
   cancelar.
3. **Painel do gestor de e-commerce** — KPIs por operação, gestão de pedidos,
   produtos online, pendência de frete, estado das integrações.
4. **Peso e dimensões no formulário de produto** — as colunas existem
   (migration 21) e o gestor ainda não tem onde preencher.
5. **Shipment, etiqueta e rastreio com transportadora** — o pedido chega a
   "expedido" com rastreio digitado; não há postagem nem etiqueta.
6. **NF-e a partir do pedido** — ver abaixo.

### OMS: onde ele realmente está

`services/oms/OmsService.ts` é **PARALELO/DESLIGADO**: CRUD sobre
`oms_orders`, id por `Date.now()`, sem escopo de tenant na escrita, e
**ninguém o chama**. Não foi reativado, de propósito.

O OMS vivo é `core_orders` + `core_order_events` + `advanceFulfillment`, com
as etapas `pago → separacao → conferencia → embalado → expedido |
pronto_para_retirada → entregue`. Não foi criado enum paralelo.

**Invariantes provados:** atravessar a esteira inteira não altera estoque,
financeiro nem razão de movimento — a reserva virou baixa no pagamento e o
lançamento é único. Pedido não pago não entra em separação; operação vizinha
não avança pedido alheio.

### Frete: o pacote inventado

`backendLogisticsQuote` assumia 500 g numa caixa 10×15×20 e R$ 100 declarados
quando faltava dado — e `core_products` **não tinha** peso nem dimensão, então
toda cotação usava a caixa imaginária. Havia um teste exigindo esse
comportamento (mandava dois CEPs e cobrava opções de frete); foi corrigido.

Hoje: produto tem `weight_grams`, `height_cm`, `width_cm`, `length_cm`
(migration 21); a cotação recusa sem eles com `SHIPPING_DATA_REQUIRED` e a
lista do que falta; `buildOrderPackage` monta o volume do pedido somando peso,
empilhando alturas e tomando a maior base — nunca subestima, porque
subestimar é o que gera cobrança extra na entrega.

### Transportadoras — estado honesto

| Provider | Estado |
| --- | --- |
| Melhor Envio | Adapter REAL, sandbox **e** produção pelo ambiente do token · cotação (`/shipment/calculate`), etiqueta (`/cart`, `/shipment/checkout`, `/generate`, `/print`, `/cancel`) e rastreio (`/shipment/tracking`) `READY_FOR_CREDENTIAL` |
| Correios | `NOT_IMPLEMENTED` — só simulação, nenhuma chamada externa |
| Jadlog | `NOT_IMPLEMENTED` — só simulação, nenhuma chamada externa |
| Genérico | Simulação declarada (`simulated: true`) |

Nenhum foi chamado com credencial real nesta rodada. **LOGISTICS REAL: NOT
TESTED.**

### A jornada online, do carrinho ao pedido pago

O que faltava não era peça, era COSTURA: pedido, credencial por operação e
webhook existiam, e ninguém chamava o provedor. O checkout criava uma intenção
com a chave global e parava ali.

- **Cliente oficial no pedido.** O checkout gravava nome e CPF como texto solto
  e deixava `customer_id` nulo. Agora resolve em `core_customers`, com ou sem
  pontuação no documento, e contato vazio não apaga o que já estava. Cliente é
  **da operação**: mesmo CPF na Gringa e no Preço Justo são dois cadastros.
- **Vínculo com o Asaas** (`core_asaas_customers`, migration 20), com UNIQUE por
  `(empresa, cliente, ambiente)`. O provedor não é dono do cadastro; guarda uma
  cópia do mínimo para cobrar. Ambiente entra na chave porque sandbox e produção
  são contas distintas.
- **PIX** com copia-e-cola e imagem; **boleto** com linha digitável. Uma cobrança
  por pedido e método: dez cliques em pagar geram **uma** chamada ao provedor —
  há teste contando as chamadas. Gerar QR **não** é receber.
- **Estorno tira o pedido de pago.** Deixá-lo pago faria a expedição separar
  mercadoria de um pedido desfeito. O estoque **não** volta sozinho (a mercadoria
  pode estar com o cliente, a caminho ou no depósito) e a reversão financeira
  **não** é automática — mexe em competência e fechamento de mês.

### Por que a NF-e do pedido online ainda não sai

`createNfeForSale` parte de uma **venda**. Pedido online não é venda: tem
financeiro próprio, já lançado em `markOrderPaid`. Transformar pedido em venda
para poder emitir criaria o **segundo lançamento de receita do mesmo dinheiro**.
A ponte correta é uma NF-e que parta do pedido — trabalho de uma rodada própria.
`orderFiscalStatus` devolve `FISCAL_PENDING` com a lista do que falta, em vez de
deixar o gestor descobrir sozinho que a nota não saiu.

### Classificação da infraestrutura Asaas encontrada

| Peça | Classificação |
| --- | --- |
| `AsaasHttpClient` | REAL — endpoints, retry 429, timeout, trava de produção |
| `AsaasCredentialService` | REAL — cofre por empresa/unidade, fallback env |
| `AsaasIntegrationStateService` | REAL — ambiente e homologação por empresa |
| `AsaasHomologationService` | REAL, não ligado ao caminho vivo |
| `PaymentService` (core) | REAL e VIVO — era o que usava chave global |
| `StorefrontService` (core) | REAL e VIVO — é o e-commerce de verdade |
| `services/ecommerce/EcommerceService` | PARALELO/LEGADO — coleções de documentos |
| `src/modules/asaas/*` | LEGADO — árvore de frontend inalcançável |

**Política multiloja (item 15): SEPARAR POR OPERAÇÃO.** Já era o comportamento
de `StorefrontService.checkout`, que agrupa os itens por empresa dona do
produto e emite **um pedido por operação**. Financeiro de duas empresas nunca
se mistura num pedido só. Fica documentado aqui porque a decisão estava no
código sem estar escrita.

## NEXT_FISCAL_ROUND

O que falta é **do usuário**, e só isso: certificado A1 (.pfx) + senha, CNPJ,
IE, CRT, série e CSC + CSC ID para NFC-e, mais os dados fiscais dos produtos
reais (NCM, CFOP, origem, CST/CSOSN). Documentação pública — XSD, endpoints,
contratos SOAP — não é dependência do dono e já está integrada.

Sem resposta real de uma SEFAZ de homologação, nada será marcado como
homologado.

---

## As telas antigas não são alcançáveis (achado, não suposição)

O plano de "retrofit visual" partia de ~1.100 literais escuros em 293 arquivos.
Medindo no navegador, **nenhum deles aparece para o usuário**.

O que foi medido, rota a rota, com a luminância real do fundo (descartando
`rgba(0,0,0,0)`, que é transparente e não escuro — a primeira medição confundiu
os dois e precisou ser refeita):

- as 26 rotas do design system: **zero** elementos escuros opacos;
- as rotas legadas (`/sistema/equipamentos`, `/sistema/fornecedores`,
  `/sistema/usuarios`, `/sistema/crm`, `/sistema/locacoes`…): **caem na tela de
  login**, não na tela antiga.

A causa está em `src/router/guards.tsx`: as 350 rotas de `config.tsx` ficam atrás
de `AuthGuard`, que lê o `useAuthStore` **antigo**. Quem entra pelo login atual
não satisfaz esse store, então toda rota legada redireciona para `/login`.

Consequência prática: **não há retrofit de cor a fazer.** O que existe é código
morto e menu prometendo o que não abre. Trocar cor nesses arquivos seria pintar
parede de casa demolida.

O trabalho real, portanto, é outro: onde o backend já funciona e o menu diz
"em breve", construir a tela no design system. Foi o que se fez em Equipamentos.

---

## Menu — o que ainda diz "EM BREVE"

Depois de Equipamentos, restam 21. Divididos pelo que de fato existe atrás:

**Backend pronto, falta só a tela** (candidatos imediatos, mesmo caminho de
Equipamentos): Mecânicos e técnicos.

**Sem backend no core** — a tela legada existia mas nunca falou com a API
central; construir significa construir o domínio inteiro, não "converter":
Fornecedores, Usuários, Contas a receber, Contas a pagar, Conciliação, Pedidos
de compra, Logística, Leads e oportunidades, Fidelidade, Contratos, BI,
Automações, Cancelamentos e devoluções, Peças.

**Depende de credencial** (não dá para marcar como pronto sem SEFAZ): NF-e,
NFC-e.

O "EM BREVE" nesses casos **não é mentira** — é o estado honesto. O que era
mentira, e foi corrigido, era Equipamentos: backend pronto e testado, menu
dizendo que não existia.

---

## Fila (ordem sugerida)

> Itens 1, 2 e 3 desta lista foram CONCLUIDOS ate a tela. Ver secao
> "Concluido ate a interface" acima.

1. **Maquininha ligada ao modal de pagamento.** `payment-terminal/` já tem
   transação, adaptador e o estado de *timeout incerto* — que é o caso difícil.
   Falta o operador ver o andamento na tela em vez de esperar às cegas.
   Sem equipamento: `READY_FOR_HARDWARE`.
2. **Tela de certificado A1 por operação.** `fiscal/FiscalCertificateService`
   e `FiscalSecretVault` já existem e cifram o segredo. Falta upload e aviso de
   vencimento. Sem certificado real: `READY_FOR_CERTIFICATE`.
3. **Tipos nomeados de movimento + quantidade anterior.** Barato, e é o que faz
   a auditoria de estoque contar a história certa.
4. **XML por e-mail.** Só a porta de entrada; a conferência e o casamento de
   itens já estão prontos em `NfeImportService`.
5. **Tela de orçamento/pré-venda no PDV.** A API está pronta e testada
   (`QuoteService` + `/core/quotes`); falta a interface.

### Não recriar

`fiscal/`, `nfe/`, `nfce/`, `payment-terminal/`, `logistics/`, `crm/` existem e
têm teste. O que falta neles é ligação com a tela, não fundação.

### Reference dos vídeos

O documento funcional dos 12 vídeos **não está salvo no repositório**. Se ele
voltar, gravar em `docs/REFERENCIA-FUNCIONAL.md` antes de trabalhar em cima.

---

## Fila desta rodada — o que ficou de fora

Pedidos que NÃO foram feitos, para a próxima execução pegar daqui:

4. **Cadastro de produto em seções** — dados gerais / comercial / estoque /
   fiscal / e-commerce / variantes. Hoje o formulário é plano e não tem
   subcategoria. A grade já existe (`VariantService`); falta a aba.
5. **Foto do produto** — upload e vínculo com produto/variante, consumido pela
   vitrine. Não existe hoje. **Nunca substituir por imagem fake.**
6. **Movimentação de estoque profissional** — o ledger guarda
   `balance_after`, mas **não** guarda `quantity_before`, e os tipos são
   `in/out/adjust` genéricos em vez de semânticos (`XML_RECEIPT`, `SALE`,
   `WORKSHOP_CONSUMPTION`…). A tela do produto precisa mostrar a história:
   data, tipo, documento, entrada, saída, saldo anterior, saldo posterior,
   usuário.
7. **Impressão** — **`PrintEngine` NÃO EXISTE**. Foi auditado e não há
   infraestrutura de impressão no repositório: é construção, não integração.
   Precisa de fila (`pending/printing/printed/failed`), contrato do agente
   local e tela de seleção de impressora (cupom / etiqueta). Sem hardware:
   `READY_FOR_HARDWARE`, e nunca marcar `printed`.
8. **XML por e-mail** — só a porta de entrada; `NfeImportService` já faz o
   resto. Recebimento não pode movimentar estoque: continua
   IMPORTAR → CONFERIR → CONFIRMAR.

---

## Rodada de estoque/produto/impressão — o que ficou de fora

**XML POR E-MAIL — CONCLUÍDO** (`MailInboxService` + tela). Falta apenas uma
credencial real de provedor para sair de `READY_FOR_CREDENTIAL`. A leitura é
sob demanda ("Ler agora"); não há agendamento automático ainda.

### Impressão — o que falta

- **Agente local não existe.** Só o contrato está pensado
  (`health/listPrinters/print/jobStatus`). Sem ele o navegador abre a caixa de
  diálogo do sistema — impressão silenciosa não é possível, e o
  `printReadiness` diz isso em vez de prometer.
- Layouts ainda sem renderizador: `WORKSHOP_OS`, `CASH_CLOSING`,
  `EQUIPMENT_QR_TAG` (a plaquinha com QR existe em `/sistema/etiquetas`, mas
  ainda não passa pelo PrintEngine).
- Tela de configuração de impressoras: a API existe
  (`/core/print/printers`), a tela não.

---

## O que falta para o ERP operar de verdade

Ordenado por bloqueio real, não por tamanho:

1. **NF-e e NFC-e não chegam à SEFAZ.** É o único impedimento *legal*. O
   pipeline interno está fechado — chave, numeração, assinatura, fila,
   recovery, DANFE/DANFCE, cancelamento, CC-e e inutilização, tudo com tela e
   percorrido no navegador. O que falta é credencial: certificado A1 real +
   senha, CNPJ, IE, CRT, série, CSC + CSC ID, e os dados fiscais dos 15
   produtos reais. **Depende do usuário**, e só disso.
2. **Agente local de impressão** não existe. Sem ele o navegador abre a caixa
   de diálogo; impressão silenciosa é impossível. **Depende do usuário**:
   impressora física.
3. **Telas que o menu ainda não entrega** — ver a seção "Menu — o que ainda diz
   EM BREVE". A mais próxima é Mecânicos e técnicos, cujo backend já existe.
4. **Código legado morto**: 350 rotas e ~293 arquivos inalcançáveis atrás do
   `AuthGuard` antigo. Não afetam o usuário; afetam quem lê o repositório e
   qualquer busca por texto. Remover é limpeza, não funcionalidade.

Itens 2 e 3 da lista anterior (categorias/marcas e tela de impressoras) foram
concluídos. O retrofit visual saiu da lista pelo motivo explicado acima: não
havia tela escura visível para converter.

### Credenciais que só o usuário pode fornecer

| O que | Para quê |
| --- | --- |
| Certificado A1 (.pfx) + senha | Emitir NF-e e NFC-e |
| CSC + CSC ID | NFC-e |
| API key Asaas + URL pública de webhook | Cobrança online |
| Senha de aplicativo do e-mail | Ler NF-e dos fornecedores |
| Token Melhor Envio (+ saldo na carteira) | Frete, etiqueta e rastreio |
| SDK do provedor + PinPad | TEF real |
| Impressora + agente local | Impressão silenciosa |
