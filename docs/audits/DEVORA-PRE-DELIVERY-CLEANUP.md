# DEVORA ERP — Preparação final para entrega

**Limpeza da demonstração, administrador inicial e acesso granular (escopo reduzido)**

| | |
|---|---|
| Data | 2026-09-13 |
| Árvore | `devora-int-b`, branch `int/b` |
| HEAD antes | `fb4c111` (reauditoria final de prontidão) |
| HEAD depois | o commit deste relatório, sobre `90d10cc`; código auditado e passado no portão: `90d10cc` |
| Banco vivo do dono | **não foi alterado**. Só foi lido, em modo somente leitura, para gerar os clones descartáveis |
| Infraestrutura | nada foi feito: nenhum deploy, DNS, push nem servidor real |

## Resposta curta

| Pergunta | Resposta | Prova |
|---|---|---|
| Quick login removido? | **SIM** | As rotas `POST /auth/quick-login` e `GET /auth/quick-login/users` foram retiradas; E2E H.14 responde 404 nas duas. As duas variáveis do acesso sem senha estão aposentadas (`config/acessoSemSenhaAposentado.ts`): ligada em produção, a API **se recusa a subir**; fora de produção, só um aviso no log. A conferência da implantação aponta a variável presente, o `secret:scan` recusa a variável ligada, e `nome-aposentado-nao-volta` impede o nome de voltar ao código. |
| Usuários demonstrativos removidos? | **SIM** no código e no bootstrap; no banco vivo, **depois do procedimento** | O bootstrap de produção não cria conta de demonstração. As 12 contas de demonstração só existem no seed de desenvolvimento, que recusa produção e o banco operacional. No clone do banco vivo, **13 → 0 contas** (seção 3). |
| Admin criado? | **SIM** | Clone: bootstrap → 1 conta, `admin`/"Administrador", `admin_geral` nas 6 empresas. A segunda execução não cria nem altera nada (o hash é o mesmo). |
| Login utilizado | **`admin`** | Aceita maiúsculas (`ADMIN` também entra: 200). |
| Hash only? | **SIM** | `$argon2id$…`. A senha vem só de `DEVORA_BOOTSTRAP_ADMIN_PASSWORD`: não está no código versionado nem nos exemplos, que trazem a variável vazia. A varredura dos bytes do banco e do WAL do clone não encontra a senha (nem em UTF-8, nem em UTF-16), e nenhuma saída de comando a contém. |
| Must change? | **SIM** | `must_change_password = 1`. O login provisório dá 200 com `mustChangePassword: true`, e as rotas `/core` respondem 403 (`API_PASSWORD_CHANGE_REQUIRED`) até a troca. A troca responde 204. Depois dela, a senha antiga dá 401 e a nova entra com o catálogo inteiro (141 capabilities). |
| RBAC no backend? | **SIM** | Os 5 cenários foram provados pela API (`tests/rbac/cenarios-da-entrega.test.ts`, 9 testes), mais 124 testes de RBAC do servidor (equivalência rota a rota, catraca, varredura por modelo, contador, lint de rota). E2E H.11–H.12 no stack descartável. |
| Tenant scope? | **SIM** | Fora do vínculo, o login e a troca de empresa respondem 403 (cenários 1 e 4; E2E C.7 e H.13). |
| PDV scope? | **SIM** | Cenário 2: um caixa fora do escopo responde 403 `CORE_TERMINAL_OUT_OF_SCOPE`, com o nome do caixa, na leitura e na abertura. |
| Página/capability scope? | **SIM** | Cenários 3 e 4. O gerente de loja com Fiscal e Usuários desmarcados recebe 403 no Fiscal e em Usuários: **a retirada vale no servidor**. |
| URL direta protegida? | **SIM** | A tela mostra **"Acesso negado"** (`acesso-granular-guarda.test.tsx`, 6 testes), e o servidor responde 403 em cada chamada. |
| API direta protegida? | **SIM** | Toda rota passa pela guarda no servidor. Esconder o menu é só conveniência: o menu por capability está coberto em `acesso-granular-menu.test.tsx`, 3 testes. |
| Produtos demo restantes | **0** no código e no seed de produção. **19** no banco vivo **até o procedimento**; no clone, 19 → 0 | seção 3 |
| Estoque demo restante | **0** depois do procedimento: 8 saldos e 32 movimentos → 0 | seção 3 |
| E-commerce vazio? | **SIM** depois do procedimento | 0 produtos e 0 pedidos (3 pedidos de demonstração saem). Fica só a configuração da loja (`core_storefront_settings`, 2 linhas). |
| PDVs vazios? | **SIM** depois do procedimento | 0 vendas, 0 sessões de caixa e 0 terminais. A numeração de venda recomeça do 1. Fica a impressora cadastrada (configuração). |
| Production seed recria demos? | **NÃO** | `db:seed` é o bootstrap: empresas e o `admin`, nada mais. `db:seed:dev` recusa produção, homologação e qualquer `grupo-sampaio.db`. Testes: `bootstrap-de-producao`, `seed-de-desenvolvimento`. |

## 1. O que mudou desde `fb4c111`

Cinco frentes, integradas por merge `--no-ff` em `int/b`:

| Merge | Frente | O que entrega |
|---|---|---|
| `d5aeb7b` | login | Remove o acesso rápido: rotas, botões da tela e variáveis. A variável ligada em produção trava o boot. |
| `1bcd2b4` | bootstrap | Separa bootstrap de produção, seed de desenvolvimento e fixtures de teste. Cria o `admin` pela variável de ambiente, com Argon2id, troca obrigatória e idempotência. Uma conta existente nunca tem a senha alterada. |
| `e3e46dd` | produto | Excluir um produto sem histórico; arquivar (inativar) um produto com histórico. |
| `02132b9` | RBAC | F0 + F1 do acesso granular, mais o escopo reduzido (seção 2). |
| `1b1a08d` | limpeza | O comando `db:limpar-demonstracao` (seção 3). |
| `5919859` | ajuste | O aviso da limpeza lê as variáveis aposentadas da lista central. |
| `90d10cc` | ajuste | O portão achou três cadastros que faltavam: `/sem-acesso` entra como slug reservado (uma empresa não pode nascer com esse endereço), e `/acesso` entra como prefixo com dono declarado e como prefixo vivo da tela. |

## 2. Acesso granular — o escopo reduzido

Foi reaproveitado o RBAC da F1: catálogo de 141 capabilities, 18 modelos de sistema, personalização por vínculo, escopo de caixa e acesso efetivo lido do banco a cada requisição. **Não há segundo sistema, e as rotas não foram reescritas.** A F2–F5 não foi executada.

- **A ponte** (`server/src/services/auth/PonteDaRota.ts`). As guardas por perfil de hoje continuam valendo. Um vínculo com um dos atalhos da tela (Somente PDV, PDV + Painel, Estoque…) passa quando tem a capability da rota. A capability de cada rota fica em `CapabilityDaRota.ts`, gerada do mapa rota a rota, com 606 rotas.
- **O vínculo personalizado decide só pela capability.** A página retirada fecha mesmo para o perfil que a lista de hoje deixaria passar.
- **Os perfis de hoje não mudam.** A equivalência modelo × rota continua exata (T0/T1).
- **Não existe "admin = bypass".** O administrador passa porque o modelo dele tem o catálogo inteiro, e cada rota continua perguntando pela capability.
- **`/api/v1/acesso`**, a API da tela:
  - catálogo por área e modelos;
  - o retrato do acesso de uma pessoa nas 6 empresas;
  - gravação por empresa: vínculo, modelo, páginas e caixas.

  As regras de quem mexe em quê:
  - é preciso `users.manage` **em cada empresa** em que se mexe;
  - só se entrega o que se tem, e o modelo de dono do grupo exige `group.admin`;
  - ninguém edita o próprio acesso;
  - toda mudança vai para a auditoria (`access.*`, com autor, antes e depois).
- **A tela.** O botão **"Acesso"** em *Usuários e equipe* abre o editor, onde se escolhem as empresas, os PDVs de cada uma (todos ou só os marcados) e as páginas e módulos por área, a partir de um modelo. Para o acesso granular, o menu e o guarda de rota seguem as capabilities. A URL direta de uma página não liberada mostra **"Acesso negado"**, e `/sem-acesso` é a casa de quem ainda não tem página nenhuma. A casa depois do login vem do servidor.
- **A alçada pontual continua** como estava.

Os cinco cenários pedidos:

| # | Cenário | Como se monta na tela | Provado |
|---|---|---|---|
| 1 | Só o PDV da Preço Justo | Preço Justo ✓, modelo **Somente PDV** | O PDV abre. Painel, Estoque, Fiscal, Usuários e a API de acesso dão 403. Login e troca para a Gringa dão 403. Há trilha de auditoria. |
| 2 | Dois PDVs específicos | Somente PDV, com **"Somente os PDVs marcados"** e 2 caixas | Os 2 caixas passam; o 3º dá 403 `CORE_TERMINAL_OUT_OF_SCOPE`. |
| 3 | Todos os PDVs + Painel, sem Fiscal e sem Usuários | **PDV + Painel**, com "Todos os PDVs", nas empresas escolhidas; ou um gerente com Fiscal e Usuários desmarcados | PDV e Painel abrem; Fiscal e Usuários dão 403, nas duas formas. |
| 4 | Só o Estoque da Preço Justo | Preço Justo ✓, modelo **Estoque** | O Estoque abre. PDV, Painel, Fiscal e Usuários dão 403. A Gringa recusa. |
| 5 | Admin com acesso total | o `admin` do bootstrap | Todas as rotas dos cenários e a API de acesso respondem 200. |

## 3. Limpeza da demonstração — prova no clone do banco vivo, com o código final

**O que é o comando** (`npm run db:limpar-demonstracao --prefix server`):
- sem argumentos, só **simula** e imprime uma impressão digital;
- `--aplicar <impressão>` só roda com a mesma impressão da simulação, e com a API parada;
- antes de aplicar, tira uma cópia de segurança conferida;
- aplica numa transação com FK ligada;
- confere, tabela a tabela, que saiu exatamente o plano e que toda linha que fica ficou igual; se não, faz ROLLBACK;
- move as fotos para a quarentena (não apaga);
- grava uma linha de auditoria só com contagens;
- recomeça as numerações de venda, produto, pedido, orçamento, pré-venda, OS e inventário.

**A prova.** O banco vivo foi aberto somente para leitura e copiado por `VACUUM INTO` para uma pasta temporária. Todo o resto rodou sobre o clone, com o código `5919859`. De `5919859` para `90d10cc` só mudaram a lista de slugs reservados e dois testes estruturais; nada da limpeza, do bootstrap ou do login. A pasta foi apagada no fim. A senha de teste do admin foi gerada na hora e nunca impressa.

| Passo | Resultado |
|---|---|
| Clone | núcleo v84, 340 tabelas, `integrity_check` ok, FK 0. 13 contas, 23 vínculos, 19 produtos, 8 saldos, 32 movimentos, 7 vendas, 3 sessões de caixa, 6 empresas, 623 linhas de auditoria. |
| Simulação | saída 0. Impressão `6d52c57c…8f30`, a mesma da prova anterior (o dado não mudou). 2 fotos; bloqueios: nenhum. |
| Impressão errada | saída 1: "não bate… Nada foi apagado". Nenhuma cópia foi tirada. A contagem de linhas de todas as tabelas, antes e depois, só difere na tabela da trava de instância, criada vazia. **Nenhum dado mudou.** |
| Aplicação | saída 0. Cópia conferida (341 tabelas). **COMMIT de 675 linhas em 45 tabelas, exatamente o plano.** `integrity_check` ok, FK 0. Contas 0, produtos 0, saldo 0, movimentos 0, vendas 0, caixas 0; empresas 6; auditoria 623 → 624. As 2 fotos foram para a quarentena. |
| De novo | a simulação e a aplicação dizem "Nada a fazer" (saída 0). |
| Migração | **v84 → v86**, `EM_DIA`, `integrity_check` ok, FK 0. |
| Bootstrap ×2 | 1ª: cria o `admin` (6 empresas, `admin_geral`, Argon2id, troca obrigatória). 2ª: "nenhuma conta foi criada nem alterada" (o hash é o mesmo) e avisa para apagar a variável. |
| Texto puro | a senha não está nos bytes do banco nem do WAL. |
| Login pela aplicação | provisório 200 → `/core` 403 → troca 204 → login 200 (sem troca pendente, 141 capabilities, casa `/sistema/painel`). A senha antiga dá 401. Produtos: total 0. Equipe: `["admin"]`. Catálogo de acesso: 17 modelos e 22 áreas. |
| Cenário "a API subiu antes da limpeza" | Outro clone, migrado **primeiro** (v84 → v86, com os 18 modelos de permissão): a mesma impressão `6d52c57c…`, bloqueios nenhum, **COMMIT de 675 linhas em 45 tabelas, exatamente o plano**, sem ROLLBACK; `integrity_check` ok, FK 0; contas, produtos, saldo, vendas e caixas 0; empresas 6. **A ordem recomendada é limpar antes de subir, mas as duas ordens terminam iguais.** |

**O que fica no banco limpo** (30 tabelas com linhas, todas configuração ou rastro legítimo):
- empresas (6) e bancadas (2);
- configuração fiscal, séries, grupo tributário e a referência do certificado;
- integrações, com segredos cifrados, e a caixa de e-mail;
- 45 categorias financeiras, 7 categorias de produto, 15 unidades, 3 locais de estoque;
- 2 programas de fidelidade, 2 configurações da loja online, 1 impressora;
- os 18 modelos de permissão;
- a auditoria, `core_meta`, `core_outbox` e os logs de requisição;
- o rastro de homologação do Asaas em sandbox;
- **2 clientes e 1 fornecedor**, que ficam por decisão padrão (seção 5).

## 4. Testes e portão

- **Direcionados**, antes do portão:
  - RBAC do servidor: 124/124 (20 arquivos);
  - limpeza, bootstrap, seed de desenvolvimento, variável aposentada, conferência e RBAC na integração: 241/241;
  - telas do roteador: 309/309;
  - suíte inteira do navegador em `ent/rbac`: 2550/2550.
- **Portão final único** (`int/b` em `90d10cc`): **15 de 16 portões na rodada inteira; a árvore limpa, conferida de novo, fecha 16/16.**

  | Portão | Resultado |
  |---|---|
  | Árvore limpa | passou na conferência de novo, depois de devolver `auto-imports.d.ts` (gerado, só fim de linha, regravado pelo build da rodada anterior): git status vazio |
  | Typecheck (tela, node e servidor) | passou |
  | Lint (`--max-warnings 0`) | passou |
  | Build (vite + tsc) | passou; 0 `.map`, maior pedaço 434 kB |
  | Varredura de segredos | limpa (770 arquivos rastreados) |
  | Suíte do servidor, inteira | **554 arquivos, 7418 testes passaram** (18 pulados) |
  | Suíte de tela, inteira | **274 arquivos, 2550 testes passaram** |
  | Instalação limpa | clone, `npm ci` offline, build, migração (EM_DIA) e **bootstrap (admin criado)**; a API respondeu `/health` 200; banco v86, integrity ok, FK 0 |
  | Backup e restauração | contagens iguais, integrity ok |
  | Upgrade de um banco criado por `dc48841` (v84) | migra até v86, EM_DIA, nenhuma tabela perdeu linhas |
  | Clone só-leitura do banco real, migrado | v84 → v86, EM_DIA, contagens de negócio iguais |
  | Tenant | 97 arquivos, 1676 testes |
  | Permissões | 7 arquivos, 82 testes |
  | Idempotência | 92 arquivos, 1284 testes |
  | Concorrência | 25 arquivos, 568 testes |
  | Banco operacional intocado | `api_request_logs` 5669 → 5669; versão 84 → 84 |

  A primeira rodada do portão (em `5919859`) ficou vermelha em três testes estruturais: slug reservado, prefixo com dono e prefixo vivo. Os três foram registrados em `90d10cc`, e o portão rodou de novo por inteiro.
- **E2E** no stack descartável: bootstrap mais o seed de desenvolvimento, em portas próprias, nunca 8787/3000. **114/114 passaram** (164 requisições, só para a pilha descartável). A seção H, nova, prova a entrega pela API real: o `admin` do bootstrap entra com a senha provisória, é barrado em `/core`, troca a senha e passa nas 6 empresas; lê o catálogo de acesso; cadastra uma pessoa e dá a ela "Somente PDV" no Preço Justo; essa pessoa abre o PDV, recebe 403 no Painel, Fiscal, Usuários, Estoque e na API de acesso, e 403 no login da Gringa; `/auth/quick-login` e `/auth/quick-login/users` respondem 404.

## 5. Decisões tomadas pelo padrão mais conservador (confirme ou mude)

**Acesso**

| Tema | Padrão | Como mudar |
|---|---|---|
| Mecânico sem bancada ativa | passa a não ver bancada nenhuma (falha fechada) | vincular a uma bancada ativa |
| Token de computador do caixa | só modelos de caixa e os atalhos de PDV; conta de dono nunca | decisão de produto |
| "Gestor" | continua par do administrador do grupo (catálogo inteiro) | para gerente de loja, usar "Gerente de Loja" |
| Emitir a nota da própria venda | `fiscal.sale.emit` conta como PDV: o caixa emite a nota da própria venda. O **módulo** Fiscal continua fechado para quem não tem `fiscal.view`. | desmarcar a capability |
| Demais alcances de hoje | iguais, sem estreitar | editar o modelo |

**Limpeza**

| Tema | Padrão | Como mudar |
|---|---|---|
| 2 clientes citados pela demonstração | ficam | `--incluir-clientes` |
| 1 fornecedor (CNPJ aparentemente real) | fica | `--incluir-fornecedor` |
| Rastro do Asaas em sandbox | fica; credenciais e chaves nunca são tocadas | — |
| Numeração de código de barras e de plaquinha | fica, porque etiquetas impressas podem estar em uso | `--reiniciar-sequencias-de-etiqueta` |
| Momento | antes de subir o código novo (banco na v84), com a API parada | — |

## 6. Fora do banco local (é com o dono)

- **A central (Supabase)** e os **744 backups antigos** continuam com a demonstração.
- **`.env` do dono**: define 1 variável aposentada do acesso rápido. **Apague a linha.** Com ela ligada, a API nova não sobe em produção; em desenvolvimento, só avisa.
- **`.claude/settings.local.json`** (local, fora do repositório): 7 linhas de permissão com chamadas ao acesso rápido. Podem ser apagadas; a rota não existe mais.
- **Os computadores de caixa**: limpar os dados do site no navegador. A fila offline e a espera F7 moram lá.

## 7. Procedimento no banco vivo (depende da confirmação do dono)

A API do dono roda hoje pela pasta `Grupo Sampaio`, com `tsx watch` (código `dc48841`, banco na v84). **O `tsx watch` reinicia sozinho quando o código muda, e uma API nova que sobe MIGRA o banco.** Por isso, a ordem abaixo começa parando a API:

1. **Pare a API e a tela.** Ctrl+C nos terminais do `tsx watch` (porta 8787) e do Vite (3000). Confira que a 8787 não responde.
2. **Traga o código da branch `int/b`** para a pasta, sem subir nada, e rode `npm ci` na raiz e em `server/`.
3. **No `.env`:**
   - apague a linha da variável aposentada do acesso rápido;
   - defina `DEVORA_BOOTSTRAP_ADMIN_PASSWORD` com a senha inicial combinada.
4. **Simule:** `npm run db:limpar-demonstracao --prefix server`. Confira a lista: 19 produtos, 13 contas, 675 linhas em 45 tabelas. A impressão hoje é `6d52c57c…8f30`; ela muda se o sistema foi usado desde então.
5. **Aplique:** `npm run db:limpar-demonstracao --prefix server -- --aplicar <impressão>`. Guarde o caminho da cópia de segurança que ele imprime.
6. **Suba a API.** Ela migra v84 → v86 e o bootstrap cria o `admin`. Depois, suba a tela.
7. **Entre como `admin`** com a senha inicial e **troque a senha** (a troca é obrigatória).
8. **Apague `DEVORA_BOOTSTRAP_ADMIN_PASSWORD`** do `.env`.
9. **Cadastre as pessoas** em *Usuários e equipe* e monte o acesso de cada uma pelo botão **Acesso**.

**Voltar atrás:** `npm run db:restore` com a cópia do passo 5, com a API parada.

---

O DEVORA está limpo para entrega: não existem logins rápidos ou usuários demonstrativos, o único administrador inicial possui acesso total, usuários futuros podem receber permissões granulares por empresa/PDV/página/capability, nenhum produto demonstrativo permanece e o production bootstrap não recria dados fictícios.
