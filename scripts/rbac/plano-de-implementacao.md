# Plano de implementação do RBAC granular

Base: C:/Users/User/Desktop/devora-ent-rbac (branch ent/rbac, HEAD fb4c1118). Números calculados por `_consolidar.mjs` sobre `mapa-final.json`. Contagens de guardas legadas medidas por grep no HEAD (lidas, não executadas): core.ts tem 435 ocorrências de `requireProfile(` (1 definição em core.ts:939, 9 em comentário, 425 chamadas) e 111 de `abertaAo(` (definição em core.ts:1070); nfse.ts tem 8 chamadas da cópia (definição em nfse.ts:38); payment-terminals.ts tem 11 (definição em payment-terminals.ts:74); `requirePermission(` tem 76 chamadas vivas (auth.ts 3, index.ts 10 + 1 em comentário, logistics.ts 23, payment-terminals.ts 31, system-admin.ts 9). A F0 congela a base exata por AST; o número da catraca parte dela, não dos 83 do desenho.

## 0. O que muda em relação ao desenho

- Catálogo final: **141** capabilities (138 + `pdv.device_login`, `sales.quotes.cancel`, `sales.consignment.close`).
- Modelos de sistema derivados rota a rota (`modelos.json`): admin_geral 141, gestor 141, gerente_loja 107, gerente_oficina 104, estoquista 31, atendente 35, operador_caixa 14, operador_caixa_loja 22, operador_caixa_oficina 21, mecanico 18, contador 1. Mais 7 modelos de atalho sem vínculo.
- Pontos no mapa: 1255 (servico 170, atalho-admin 98, rota 607, publica 102, tela-rota 108, tela-menu 104, tela-botao 66). Rotas únicas 692: 606 guardadas (4 só autenticadas) e 86 públicas.
- Equivalência das rotas: igual 690, muda 2. Conflitos do solver: 1, todos resolvidos. Mudanças não listadas: 0.
- Mudanças deliberadas: D1–D8 do desenho, D3b, D9–D12 (conflitos.md §3).
- `soAutenticado('motivo')` entra no lint ao lado de `rotaPublica` para as rotas que exigem token e não pedem capability (auth.ts:296, 855, 869, 895 e `GET /core/permissions/catalog`).

## 1. Ordem

```
F0 (linha de base + catálogo) ─► F1 (servidor-base) ─┬─► F2 (tradução: f primeiro, depois a–e em paralelo) ─┐
                                                     ├─► F3 (tela-base) ─────────────────────────────────────┼─► F5 (remoção final) ─► liga a personalização
                                                     └─► F4 (Usuários e Modelos; depois de F3) ──────────────┘
F6 (testes) acompanha todas; F2(d) só começa depois da decisão D3b.
```

## 2. Frentes

### F0 — linha de base e catálogo (serial, pequena)

Congelar o acesso de hoje e publicar o catálogo final, sem mudar comportamento.

- `server/src/services/auth/Capabilities.ts` (novo; gerado de `catalogo-final.json`: CATALOGO, type Capability, CATALOG_VERSION=1, MODELOS_DE_SISTEMA de `modelos.json`)
- `server/tests/rbac/linha-de-base.json` (rota → perfis de hoje; é a coluna perfis_hoje de `mapa-final.json`)
- `server/tests/rbac/equivalencia.test.ts` (T0/T1)
- `server/tests/rbac/catalogo.test.ts` (T13)
- `scripts/rbac/` (este `_consolidar.mjs` e os geradores das fatias, para rodar sobre o HEAD da hora)

Pronta quando: T0 e T13 verdes; a catraca registra a base medida por AST.

### F1 — servidor-base (depois de F0)

Tabelas, semeadura, resolução do acesso, sessão, guardas novas, lint. Nenhuma rota muda.

- `server/src/db/schema.ts` (core_permission_templates, core_permission_template_capabilities, core_user_company_capabilities, core_user_company_terminals; colunas novas de core_user_companies; CORE_TABLES_IN_DELETE_ORDER em schema.ts:5437)
- `server/src/db/core-migrations.ts` (passo 86 com bancadas ATIVAS; CORE_TARGET_VERSION 85→86 em core-migrations.ts:86)
- `server/src/db/migracaoCompleta.ts` (ensurePermissionTemplates em prepararBanco, migracaoCompleta.ts:27-33)
- `server/src/services/auth/AcessoEfetivo.ts`, `Autorizacao.ts`, `AcessoService.ts` (novos)
- `server/src/services/auth/ContaDaSessao.ts` (consulta com o modelo; D2)
- `server/src/services/api/ApiAuthService.ts` (refresh confere empresa ativa, D2)
- `server/src/middleware/auth.ts` (req.auth.acesso, X-Acesso-Em-Vigor, `soAutenticado`, requirePermission vira tradutor POR ROTA, C8)
- `server/src/routes/v1/auth.ts` (só o `access` do login, dispositivo, sessão e troca)
- `server/src/services/auth/Permissions.ts` (vira reexport de Capabilities; módulos mortos fiscal/crm/corporate-bi saem)
- `server/eslint-rules/rota-declara-alcance.js` (GUARDAS novas em :110, capabilityDesconhecida, soAutenticado)

Pronta quando: T9, T10, T12 verdes; T2 igual à linha de base.

### F2 — tradução das guardas (depois de F1; (f) entra primeiro)

Cada rota passa a `requireCapability/requireAnyCapability/requireAllCapabilities` com a expressão `capability_final` de `mapa-final.json`; cada ponto de serviço recebe a `regra_final`. Cada PR baixa a catraca e mantém T1 verde para as suas rotas.

- (f) grupo, usuários, auditoria, alçada: 18 rotas de core.ts; `AuthorizationService.ts` (approval.<ação> exata no vínculo do liberador), `IdentityService.ts` (listGroupAdmins, temVinculoDeGestao → system.deploy.view no vínculo, C6), `AlcanceCruzado.ts` (operacoesOndeACapabilityAbre), `TitularService.ts`, `HierarquiaDePerfis.ts` (só leitura de capability; a régua nova é da F4), `RecuperacaoDeSenhaDaEquipe.ts` (conta de dono por assignable_by), helpers `comLiberacaoPontual` e `scope()` de core.ts
- (a) PDV, caixa, vendas, fiscal da venda, clientes: 102 rotas; `CashService.ts`, `SalesService.ts`, `QuoteService.ts`, `GavetaDoDinheiro.ts`, `TerminalRegistry.ts` (requireTerminalNoEscopo nos chamadores de terminalDoPedido: core.ts:1523/1547, 1653, 1675, 4183/4191, 4696/4706, 4714/4728, 6259/6279, 15164/15170, SEM 5505), `CobrancasSemVenda.ts`; capabilities novas sales.quotes.cancel/sales.consignment.close (C4); D1
- (b) produtos, estoque, compras, unidades: 161 rotas; `PoliticaDeGestaoService.ts` (can(dashboard.money.view)/can(inventory.cost.view) || política), hideCost de core.ts:3042, `ReportsService.ts` (R3, se o dono aprovar)
- (c) financeiro, fiscal, contábil, relatórios, painel: 99 rotas; `nfse.ts` inteiro (8 rotas, apaga a cópia de requireProfile em nfse.ts:38)
- (d) oficina, equipamento, plaquinhas, bancadas: 64 rotas; `bancadasDoVinculo` (resolveWorkshop/resolveWorkshopScope em core.ts:7284-7386), `WorkshopIntakeService.ts` (regra de entrada do C2), `WorkshopCoreService.ts` (voz; travas sem bypass, C7), `WorkshopPartsService.ts`, `EquipmentService.ts` (montador, C3), checkout com terminalDoPedido (D12)
- (e) e-commerce, CRM, locação, integrações, logística, sistema: 74 rotas de core.ts + auth.ts 7, index.ts 10, logistics.ts 23, payment-terminals.ts 31, system-admin.ts 9 rotas guardadas; `payment-terminals.ts` (apaga a cópia em :74, C12), `system-admin.ts` (C6), `auth.ts` (D9, D10), `implantacaoPorEmpresa.ts` e `ProntidaoDasComunicacoes.ts` (checklists por capability + assignable_by, C3)

Pronta quando: T1 = igual + D1 para todas as rotas; catraca = 0.

### F3 — tela-base (depois de F1, em paralelo com F2)

useCan, sessão com `access`, Protected com /sem-acesso, casa calculada, menu e rotas por capability.

- `src/hooks/useCan.ts` (novo); `src/hooks/useSession.ts` (useHasProfile e DONOS_DO_GRUPO saem na F5)
- `src/lib/api/client.ts` (StoredSession.access, X-Acesso-Em-Vigor)
- `src/router/Protected.tsx`, `src/router/gsRoutes.tsx` (pode obrigatório), `src/router/environments.ts` (vira só casas e porta)
- `src/components/gs/navItems.ts`, `src/components/gs/AppShell.tsx` (nome do modelo no topo)
- `src/pages/gs/AcessoNegadoPage.tsx` (novo)
- `src/lib/acesso/catalogo.gen.ts` (gerado de catalogo-final.json)
- as 34 telas com useHasProfile (64 chamadas); pontos de tela no mapa por arquivo: navItems.ts 107, gsRoutes.tsx 104, environments.ts 15, EquipamentoFichaPage.tsx 7, OrdemServicoPage.tsx 7, AppShell.tsx 6, Protected.tsx 5, EntradaNotasPage.tsx 5, OperacaoPages.tsx 5, OrcamentosPage.tsx 4, ContasPage.tsx 3, LoginPage.tsx 3…

Pronta quando: T4 e T-UI-1 verdes; D4/D6 congeladas por modelo na PR para o dono revisar.

### F4 — Usuários e Modelos (depois de F1 e F3)

Rotas e telas de acesso, régua de quem entrega o quê, auditoria antes/depois.

- `server/src/routes/v1/acesso.ts` (novo roteador, montado em index.ts; core.ts não é tocado)
- `server/src/services/core/HierarquiaDePerfis.ts` (régua §9 com assignable_by)
- `server/src/services/core/TeamService.ts` (fachada; D11)
- `src/pages/gs/EquipePage.tsx` → UsuariosPage; `src/pages/gs/ModelosPage.tsx` (nova); `src/lib/api/acesso.ts`; `src/components/gs/QuemLiberaAqui.tsx` (nome do modelo; lado grupo/operação por group.admin)
- `src/pages/gs/TerminaisPage.tsx` (lista de quem recebe token pela elegibilidade do servidor, C5)

Pronta quando: T3, T8, T11 verdes.

### F5 — remoção final (serial, depois de F2, F3 e F4)

Apagar o modelo antigo e ligar a personalização.

- apagar requireProfile, abertaAo, PERFIS_DO_AMBIENTE, CAIXAS/BALCAO_E_GERENCIA/AUX_EDITORES, AlcanceCruzado.PERFIS_QUE_PASSAM_EM_TUDO, temPermissao/Permissions.ts, QUEM_*, DONOS_DO_GRUPO, useHasProfile, X-Perfil-Em-Vigor, companies[].profileCode, fachadas /core/team*
- tirar as guardas legadas do lint
- ligar core_meta.rbac_personalizacao_liberada

Pronta quando: Busca por admin_geral/gestor em server/src e src só acha seed, bootstrap e rótulos de modelo.

### F6 — testes (contínua)

A matriz T0–T13 do desenho, com as fixtures A–J de equivalencia.md §5.

- `server/tests/rbac/` (T2 por modelo, um arquivo por modelo; T3 com as 25 sondas; T5; T6 com D12 e D10; T7; T8; T9; T10; T11)
- `src/**/__tests__/rbac/` (T4, T-UI-1)
- reescrever, não desligar: ambientes-dos-dois-lados, cinco-telas-que-batem-na-cara, o-menu-nao-promete-o-que-o-servidor-nega, permissions, rotas-abertura-declarada, regra-rota-declara-alcance, rodada-31-alcance-declarado, hierarquia-da-equipe, liberacao-pontual, alcada-sem-porta-dos-fundos, audit-portas, menu-e-rotas, environments, contador-no-navegador
- os 526 arquivos que provisionam por profile_code NÃO mudam: o código vira "modelo aplicado", e sem semeadura MODELOS_DE_SISTEMA responde (§3.4)

Pronta quando: A matriz inteira verde.

## 3. Pontos de serviço com regra própria, por arquivo (a F2 não pode esquecer nenhum)

- `core.ts`: 47
- `TeamService.ts`: 6
- `WorkshopCoreService.ts`: 6
- `IdentityService.ts`: 5
- `WorkshopIntakeService.ts`: 4
- `Permissions.ts`: 3
- `auth.ts`: 2
- `implantacaoPorEmpresa.ts`: 2
- `nfse.ts`: 1
- `payment-terminals.ts`: 1
- `RecuperacaoDeSenhaDaEquipe.ts`: 1
- `AuthorizationService.ts`: 1
- `WorkshopPartsService.ts`: 1
- `EquipmentService.ts`: 1
- `ProntidaoDasComunicacoes.ts`: 1

## 4. Riscos de execução

- core.ts tem 16 mil linhas: as fatias da F2 dependem de PRs pequenas; a atribuição é por capability (área), não por faixa de linha, porque as linhas andam. O script regenera o mapa sobre o HEAD da hora.
- A personalização e os modelos do dono só ligam com a catraca em 0: antes disso um vínculo com código `dono-…` levaria 403 em toda rota legada e teria o menu vazio (AppShell.tsx:31-39 com environmentOf nulo).
- Os testes que provisionam por profile_code seguem valendo porque o código vira modelo e o banco truncado resolve por MODELOS_DE_SISTEMA; qualquer capability nova precisa declarar os modelos em que nasce (T13), senão nasce 403 para o gerente.
