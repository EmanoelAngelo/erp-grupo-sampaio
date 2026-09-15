/**
 * Esquema relacional do núcleo do Grupo Sampaio ERP.
 *
 * Diferente das coleções de documentos (`database.ts`), aqui os invariantes de
 * negócio são impostos pelo próprio banco:
 *
 *  - estoque nunca fica negativo          -> CHECK (quantity >= 0)
 *  - venda baixa estoque UMA vez          -> UNIQUE no ledger de movimentos
 *  - um fato econômico por origem         -> UNIQUE (origin_type, origin_id)
 *  - isolamento multiempresa              -> company_id em toda tabela + FK
 *
 * Esses invariantes não dependem de disciplina do código de aplicação: duas
 * requisições concorrentes que violem qualquer um deles falham no commit.
 */
import { getConnection, withTransaction } from './sqlite.js';

/*
  Aqui existiu um `CORE_SCHEMA_VERSION = 1` exportado e sem leitor. O número de
  versão que VALE é `CORE_TARGET_VERSION` em core-migrations.ts — manter um
  segundo, congelado em 1, era a resposta errada esperando ser lida.
*/

/**
 * O DONO DO BANCO (GAP-PRD-137): uma linha só (`papel = 'dono'`) dizendo qual
 * processo usa este arquivo — API, migração ou manutenção —, com pid, máquina
 * e a última batida. Ver `services/implantacao/instanciaUnica.ts`. Exportada
 * porque a trava roda ANTES das migrações (é ela que as protege) e cria a
 * própria tabela com esta mesma DDL.
 */
export const DDL_DA_INSTANCIA = `CREATE TABLE IF NOT EXISTS core_instancia (
     papel       TEXT PRIMARY KEY,
     token       TEXT NOT NULL,
     tipo        TEXT NOT NULL,
     pid         INTEGER NOT NULL,
     host        TEXT NOT NULL,
     iniciado_em TEXT NOT NULL,
     batida_em   TEXT NOT NULL
   );`;

/**
 * OS MUNICÍPIOS DO IBGE (IBGE-MUNICIPIOS, resíduo do GAP-PRD-028). O endereço
 * de entrega exige o código IBGE do município, e o cliente não sabe o que é
 * isso: com esta tabela, o formulário acha a cidade pelo nome e o código vem
 * junto, e o servidor confere que o código existe e é da UF do endereço.
 *
 * NASCE VAZIA — nada de dado inventado. Quem a enche é o comando do dono
 * (`scripts/carregar-municipios-ibge`), com a lista OFICIAL do IBGE. Vazia, o
 * sistema faz o que fazia: o código é digitado e só o formato é conferido.
 * `nome_busca` é o nome sem acento, em minúsculas e sem pontuação — "Sant'Ana
 * do Livramento" vira "sant ana do livramento" —, para a busca não depender de
 * como a pessoa digita. Exportada porque o comando cria SÓ esta tabela num
 * banco que ainda não subiu nesta versão, sem rodar o esquema inteiro.
 */
export const DDL_DOS_MUNICIPIOS_IBGE = `CREATE TABLE IF NOT EXISTS core_ibge_municipios (
     codigo        TEXT PRIMARY KEY CHECK (length(codigo) = 7),
     nome          TEXT NOT NULL,
     uf            TEXT NOT NULL,
     nome_busca    TEXT NOT NULL,
     atualizado_em TEXT NOT NULL
   );`;

/**
 * DDL canônica do núcleo.
 *
 * Exportada para que a reconciliação de schema possa montar um banco de
 * referência em memória e comparar coluna a coluna com o banco real. É esta
 * lista, e não o número da versão, que define o formato correto.
 */
export const STATEMENTS: string[] = [
  // Versão do schema do núcleo. Criada aqui para que exista mesmo antes da
  // primeira migração rodar.
  `CREATE TABLE IF NOT EXISTS core_meta (
     key   TEXT PRIMARY KEY,
     value TEXT NOT NULL
   );`,

  // ---------------------------------------------------------------- empresas
  `CREATE TABLE IF NOT EXISTS core_companies (
     id           TEXT PRIMARY KEY,
     slug         TEXT NOT NULL UNIQUE,
     legal_name   TEXT NOT NULL,
     trade_name   TEXT NOT NULL,
     cnpj         TEXT,
     ie           TEXT,
     tax_regime   TEXT NOT NULL DEFAULT 'simples',
     kind         TEXT NOT NULL DEFAULT 'retail',
     -- A REGRA DE OURO DO DONO, como DADO e nao como lista no codigo.
     --
     -- Plaquinha com QR e numero e coisa de PJ Motors e da Oficina: sao as
     -- duas operacoes que lidam com a maquina fisica que fica parada no
     -- patio por dias. Loja de roupa e de maquiagem usa etiqueta comercial
     -- (codigo de barras e preco), que e outro sistema.
     --
     -- Fica aqui, e nao numa lista de slugs no codigo, porque slug se
     -- renomeia e empresa nova nasce toda semana. O padrao e ZERO: quem
     -- entra depois nao ganha de brinde o que consome numero do grupo.
     uses_equipment_tags INTEGER NOT NULL DEFAULT 0,
     -- QUE TIPO DE LOJA ESTA E — para a vitrine saber como se arrumar.
     --
     -- Nao e o mesmo que a coluna kind, e a diferenca importa: kind responde "isto
     -- e loja ou oficina"; isto aqui responde "que negocio esta loja faz". Uma
     -- importadora de variedades e uma loja de moda sao as duas 'retail' e nao
     -- podem ter a mesma vitrine — a primeira vive de busca e densidade, a
     -- segunda de foto grande e poucas pecas por linha.
     --
     -- Ate a rodada 56 a UNICA diferenca entre as cinco lojas do grupo, na
     -- vitrine, era a paleta de cores. Mesma ordem de secoes, mesma grade,
     -- mesmo card. O tipo e o dado que faltava para a pagina conseguir ser
     -- outra coisa.
     --
     -- NULO e resposta legitima: "ninguem declarou ainda". A tela cai num
     -- arranjo neutro em vez de vestir a loja nova de um negocio que nao e o
     -- dela. Os valores validos vivem em StorefrontPresets.ts, um lugar so.
     storefront_preset TEXT,
     active       INTEGER NOT NULL DEFAULT 1,
     created_at   TEXT NOT NULL,
     updated_at   TEXT NOT NULL
   );`,

  // --------------------------------------------------------------- usuários
  `CREATE TABLE IF NOT EXISTS core_users (
     id              TEXT PRIMARY KEY,
     login           TEXT NOT NULL UNIQUE,
     display_name    TEXT NOT NULL,
     email           TEXT,
     password_hash   TEXT NOT NULL,
     hash_algorithm  TEXT NOT NULL DEFAULT 'argon2id',
     -- Conta de proprietário: liga o login ao cliente cujos equipamentos ele
     -- pode acompanhar. Nulo para usuários internos.
     customer_id     TEXT REFERENCES core_customers(id),
     must_rehash     INTEGER NOT NULL DEFAULT 0,
     -- Senha definida por um gestor é provisória: quem recebe troca no primeiro
     -- acesso, para que ninguém além do dono conheça a senha em uso.
     must_change_password INTEGER NOT NULL DEFAULT 0,
     -- Último acesso bem-sucedido. Fica aqui, e não derivado de
     -- core_login_attempts, porque aquela tabela é expurgável (é controle de
     -- força bruta) e o gestor precisa deste dado para desativar conta parada.
     last_login_at   TEXT,
     active          INTEGER NOT NULL DEFAULT 1,
     session_version INTEGER NOT NULL DEFAULT 1,
     created_at      TEXT NOT NULL,
     updated_at      TEXT NOT NULL
   );`,

  // Vínculo usuário<->empresa com perfil. É a fonte de verdade do escopo:
  // o cliente nunca escolhe o tenant, ele é derivado deste vínculo.
  //
  // RBAC granular (F1): `profile_code` continua NOT NULL e passa a significar
  // "o código do MODELO aplicado" (sem FK para core_permission_templates, de
  // propósito: código sem modelo resolve para nenhuma capability — falha
  // fechada — e os testes provisionam por código). As cinco colunas do fim têm
  // DEFAULT ou aceitam nulo, e o passo 86 grava o escopo de bancada de hoje:
  //   all_terminals  1 = todos os caixas da empresa (inclusive os futuros);
  //                  0 = só os de core_user_company_terminals;
  //   all_workshops  NULL = segue o padrão do modelo; 1 = todas; 0 = as de que é membro;
  //   access_version sobe a cada mudança de acesso do vínculo (chave do cache da sessão).
  `CREATE TABLE IF NOT EXISTS core_user_companies (
     id            TEXT PRIMARY KEY,
     user_id       TEXT NOT NULL REFERENCES core_users(id) ON DELETE CASCADE,
     company_id    TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     profile_code  TEXT NOT NULL,
     is_default    INTEGER NOT NULL DEFAULT 0,
     created_at    TEXT NOT NULL,
     all_terminals  INTEGER NOT NULL DEFAULT 1,
     all_workshops  INTEGER,
     access_version INTEGER NOT NULL DEFAULT 1,
     updated_at     TEXT,
     updated_by     TEXT,
     UNIQUE (user_id, company_id)
   );`,

  // MODELOS DE PERMISSÃO (RBAC granular, F1). O perfil de hoje vira um modelo
  // com o MESMO código; o dono cria os seus (origin 'dono'). O CATÁLOGO de
  // capabilities mora no código (`services/auth/Capabilities.ts`): aqui fica só
  // o que o dono muda. Escritor único: `services/auth/AcessoService.ts` (a
  // semeadura de toda subida e a edição).
  `CREATE TABLE IF NOT EXISTS core_permission_templates (
     id                     TEXT PRIMARY KEY,
     code                   TEXT NOT NULL UNIQUE,
     name                   TEXT NOT NULL,
     description            TEXT,
     origin                 TEXT NOT NULL CHECK (origin IN ('sistema', 'dono')),
     full_catalog           INTEGER NOT NULL DEFAULT 0,
     assignable_by          TEXT NOT NULL DEFAULT 'subconjunto'
                              CHECK (assignable_by IN ('gestao_da_empresa', 'grupo', 'subconjunto')),
     default_workshops      TEXT NOT NULL DEFAULT 'membro' CHECK (default_workshops IN ('todas', 'membro')),
     hidden                 INTEGER NOT NULL DEFAULT 0,
     owner_edited           INTEGER NOT NULL DEFAULT 0,
     seeded_catalog_version INTEGER,
     version                INTEGER NOT NULL DEFAULT 1,
     archived_at            TEXT,
     created_by             TEXT,
     updated_by             TEXT,
     created_at             TEXT NOT NULL,
     updated_at             TEXT NOT NULL
   );`,
  `CREATE TABLE IF NOT EXISTS core_permission_template_capabilities (
     template_id TEXT NOT NULL REFERENCES core_permission_templates(id) ON DELETE CASCADE,
     capability  TEXT NOT NULL,
     PRIMARY KEY (template_id, capability)
   );`,

  // A PERSONALIZAÇÃO do vínculo: o que se ACRESCENTA ou se TIRA do modelo
  // aplicado. Delta, e não cópia — quem edita o modelo muda todos os que o
  // usam; o personalizado conserva só a sua diferença.
  `CREATE TABLE IF NOT EXISTS core_user_company_capabilities (
     user_company_id TEXT NOT NULL REFERENCES core_user_companies(id) ON DELETE CASCADE,
     capability      TEXT NOT NULL,
     effect          TEXT NOT NULL CHECK (effect IN ('grant', 'revoke')),
     granted_by      TEXT,
     granted_at      TEXT NOT NULL,
     PRIMARY KEY (user_company_id, capability)
   );`,

  // Lockout e rate limit ficam no servidor — nunca só no browser.
  `CREATE TABLE IF NOT EXISTS core_login_attempts (
     id           INTEGER PRIMARY KEY AUTOINCREMENT,
     login        TEXT NOT NULL,
     ip           TEXT,
     succeeded    INTEGER NOT NULL,
     attempted_at TEXT NOT NULL
   );`,
  `CREATE INDEX IF NOT EXISTS ix_login_attempts_login
     ON core_login_attempts (login, attempted_at);`,

  /*
    O ACCESS TOKEN ENCERRADO NO LOGOUT (item SESSAO, OWASP ASVS 3.3.1).

    O logout só revogava o refresh; o access token de antes continuava valendo
    até vencer (uma hora). Cada access token nasce com um `jti` aleatório e NÃO
    secreto (`issueSession`), e o logout grava aqui o `jti` de quem o chamou,
    com o vencimento do PRÓPRIO token (claim `exp`). A conferência de toda
    requisição (`ContaDaSessao.ts`) recusa `jti` presente nesta tabela.

    Por que o `jti` e não o refresh token: o payload do JWT é legível por quem
    tem o access token, e o refresh dentro dele daria a esse portador o poder
    de renovar para sempre.

    Sem chave estrangeira de propósito: a linha vive no máximo o que o token
    vive (uma hora), e quem grava apaga as vencidas (`TokensRevogados.ts`).
    Escritor único: `services/auth/TokensRevogados.ts`.
  */
  `CREATE TABLE IF NOT EXISTS core_tokens_revogados (
     jti        TEXT PRIMARY KEY,
     user_id    TEXT NOT NULL,
     company_id TEXT NOT NULL,
     expires_at TEXT NOT NULL,
     revoked_at TEXT NOT NULL
   );`,

  // --------------------------------------------------------------- terminais
  // O caixa (PDV) da operação: cada um tem a sua gaveta. O escritor é
  // `TerminalService` (GAP-PRD-039/146). `code` é UNIQUE no banco inteiro, e
  // por isso nasce com o slug da empresa na frente (`gringa-cx1`). As colunas
  // do fim são anuláveis: `reconcileCoreSchema` as acrescenta em banco antigo.
  `CREATE TABLE IF NOT EXISTS core_terminals (
     id          TEXT PRIMARY KEY,
     company_id  TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     code        TEXT NOT NULL UNIQUE,
     name        TEXT NOT NULL,
     active      INTEGER NOT NULL DEFAULT 1,
     created_at  TEXT NOT NULL,
     created_by          TEXT,
     updated_at          TEXT,
     deactivated_at      TEXT,
     deactivated_by      TEXT,
     deactivation_reason TEXT
   );`,

  // O ESCOPO DE CAIXA do vínculo (RBAC granular, F1): vale quando
  // core_user_companies.all_terminals = 0. Caixa desativado continua na lista;
  // a operação é que recusa (`assertTerminalDaEmpresa`).
  `CREATE TABLE IF NOT EXISTS core_user_company_terminals (
     user_company_id TEXT NOT NULL REFERENCES core_user_companies(id) ON DELETE CASCADE,
     terminal_id     TEXT NOT NULL REFERENCES core_terminals(id) ON DELETE CASCADE,
     granted_by      TEXT,
     granted_at      TEXT NOT NULL,
     PRIMARY KEY (user_company_id, terminal_id)
   );`,
  `CREATE INDEX IF NOT EXISTS ix_uc_terminals_terminal ON core_user_company_terminals (terminal_id);`,

  // ---------------------------------------------------------------- clientes
  // Entidade Customer única de todo o ERP (item 54 da especificação).
  `CREATE TABLE IF NOT EXISTS core_customers (
     id           TEXT PRIMARY KEY,
     company_id   TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     code         TEXT,
     name         TEXT NOT NULL,
     document     TEXT,
     email        TEXT,
     phone        TEXT,
     address      TEXT,
     notes        TEXT,
     active       INTEGER NOT NULL DEFAULT 1,
     -- ------------------------------------------------- convite do portal
     --
     -- O caminho de acesso do dono ao portal, entregue no balcão.
     --
     -- Sem isto o portal nasce inacessível para quem ele serve: a conta exige
     -- e-mail E documento no cadastro, e o cliente de oficina é cadastrado com
     -- nome e telefone. O convite troca essa prova por outra — um código que
     -- só quem estava no balcão recebeu.
     --
     -- Guarda-se o SHA-256, nunca o código. É credencial, e este banco também
     -- guarda CPF; um vazamento de arquivo não pode virar acesso às contas.
     portal_invite_hash       TEXT,
     portal_invite_expires_at TEXT,
     portal_invite_used_at    TEXT,
     -- ------------------------------------------- por qual tabela ele compra
     --
     -- O ELO QUE FALTAVA. O cadastro de tabela de preço existia inteiro — tela,
     -- percentual, exceção por item — e não era lido por ninguém, porque não
     -- havia como dizer QUEM compra por ela. O revendedor com 15% combinado era
     -- atendido digitando desconto à mão em cada venda.
     --
     -- NULO = preço de tabela normal, e é o que todo cliente que já existe
     -- significa. A coluna nasce nullable por isso, e não por preguiça: um
     -- DEFAULT apontando para alguma tabela colocaria a operação inteira em
     -- atacado de uma vez.
     --
     -- Uma tabela por cliente, e só uma. Tabela por faixa de quantidade ou com
     -- validade ficou de fora desta rodada de propósito — as duas mudam a conta
     -- do preço, e a conta é o que esta rodada está pondo de pé.
     price_table_id TEXT REFERENCES core_price_tables(id),
     -- ------------------------------------------------ anonimização (LGPD)
     --
     -- QUANDO o titular foi anonimizado (GAP-PRD-073). Nulo = cadastro vivo.
     -- A linha não se apaga: venda, nota, OS e título continuam apontando
     -- para ela; o que sai são os dados de contato.
     anonymized_at TEXT,
     -- ------------------------------------------ quem escreveu o documento
     --
     -- 'balcao' = cadastro feito por gente da loja, com a pessoa na frente
     -- (createCustomer). 'loja_online' = cadastro que o checkout público
     -- criou com o CPF que alguém DIGITOU. Nulo = anterior à regra, ou
     -- caminho automático. É o que decide se o documento deste cadastro
     -- pode ligar a conta do portal a cadastros de OUTRAS operações
     -- (GAP-PRD-006): só o documento escrito no balcão é prova; o digitado
     -- num checkout, não.
     origin       TEXT,
     created_at   TEXT NOT NULL,
     updated_at   TEXT NOT NULL,
     UNIQUE (company_id, document)
   );`,
  `CREATE INDEX IF NOT EXISTS ix_customers_company ON core_customers (company_id, name);`,

  // LEAD — contato que ainda não comprou.
  //
  // A tentação aqui é guardar o lead como se fosse cliente, e ela sai cara: o
  // cadastro de clientes passaria a conter gente que nunca comprou, e todo
  // relatório que conta clientes — ticket médio, recompra, aniversariantes —
  // passaria a dividir por um número inflado.
  //
  // Então lead é entidade própria, e quando ele COMPRA vira cliente apontando
  // para `core_customers`, que continua sendo a autoridade. Se já houver
  // cliente com o mesmo documento, o lead se liga ao que existe em vez de criar
  // um segundo cadastro da mesma pessoa.
  `CREATE TABLE IF NOT EXISTS core_leads (
     id           TEXT PRIMARY KEY,
     company_id   TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     name         TEXT NOT NULL,
     phone        TEXT,
     email        TEXT,
     document     TEXT,
     source       TEXT,
     -- novo | em_contato | qualificado | convertido | perdido
     status       TEXT NOT NULL DEFAULT 'novo',
     notes        TEXT,
     -- Preenchido na conversão. É o vínculo com o cadastro de verdade.
     customer_id  TEXT REFERENCES core_customers(id),
     converted_at TEXT,
     lost_reason  TEXT,
     idempotency_key TEXT,
     created_by   TEXT,
     created_at   TEXT NOT NULL,
     updated_at   TEXT NOT NULL,
     -- O QUE A CHAVE PEDIU (RES-IDEM-VIZ): v1 + SHA-256 do lead pedido (nome,
     -- contato, documento, origem, nota). A mesma chave com outra pessoa e
     -- recusada (422 CORE_IDEMPOTENCY_KEY_REUSED) em vez de devolver este lead
     -- calado. Nula = lead anterior a coluna: o reenvio segue a regra antiga.
     idempotency_fingerprint TEXT,
     UNIQUE (company_id, idempotency_key)
   );`,
  `CREATE INDEX IF NOT EXISTS ix_leads_company ON core_leads (company_id, status);`,

  // OPORTUNIDADE — negociação em andamento.
  //
  // Vale por si: um cliente antigo pode ter oportunidade sem ser lead, e um
  // lead pode ter mais de uma. O valor aqui é ESTIMADO — não é receita, não
  // entra no financeiro e não aparece em faturamento. Vira dinheiro de verdade
  // quando a venda acontece, e aí a oportunidade aponta para ela.
  `CREATE TABLE IF NOT EXISTS core_opportunities (
     id            TEXT PRIMARY KEY,
     company_id    TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     lead_id       TEXT REFERENCES core_leads(id),
     customer_id   TEXT REFERENCES core_customers(id),
     title         TEXT NOT NULL,
     amount_cents  INTEGER NOT NULL DEFAULT 0,
     -- aberta | ganha | perdida
     status        TEXT NOT NULL DEFAULT 'aberta',
     expected_close_at TEXT,
     lost_reason   TEXT,
     -- A venda que realizou esta oportunidade. É o que fecha o ciclo entre a
     -- previsão e o faturamento.
     won_sale_id   TEXT REFERENCES core_sales(id),
     closed_at     TEXT,
     created_by    TEXT,
     created_at    TEXT NOT NULL,
     updated_at    TEXT NOT NULL
   );`,
  `CREATE INDEX IF NOT EXISTS ix_opportunities_company
     ON core_opportunities (company_id, status);`,

  // FIDELIDADE — ponto acumulado é DÍVIDA da loja, não receita.
  //
  // Cada ponto que o cliente junta é desconto que a loja vai dar depois. Tratar
  // isso como faturamento infla o resultado hoje e cria um buraco no dia do
  // resgate. Por isso o ponto não encosta em `core_finance_entries`: ele tem
  // razão própria, e o que entra no financeiro é a venda, pelo valor que o
  // cliente pagou de verdade.
  `CREATE TABLE IF NOT EXISTS core_loyalty_programs (
     company_id        TEXT PRIMARY KEY REFERENCES core_companies(id) ON DELETE CASCADE,
     active            INTEGER NOT NULL DEFAULT 1,
     -- Quantos centavos de compra valem 1 ponto.
     cents_per_point   INTEGER NOT NULL DEFAULT 100,
     -- Quanto 1 ponto vale de desconto no resgate.
     point_value_cents INTEGER NOT NULL DEFAULT 1,
     min_points_to_redeem INTEGER NOT NULL DEFAULT 0,
     created_at        TEXT NOT NULL,
     updated_at        TEXT NOT NULL
   );`,

  // Razão de pontos: uma linha por fato, com sinal. O saldo é a soma — nunca um
  // número guardado à parte, que poderia divergir do histórico que o explica.
  `CREATE TABLE IF NOT EXISTS core_loyalty_entries (
     id           TEXT PRIMARY KEY,
     company_id   TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     customer_id  TEXT NOT NULL REFERENCES core_customers(id) ON DELETE CASCADE,
     -- earn | redeem | reversal | adjustment
     kind         TEXT NOT NULL,
     -- Positivo acumula, negativo consome. O saldo nunca fica negativo.
     points       INTEGER NOT NULL,
     sale_id      TEXT REFERENCES core_sales(id),
     return_id    TEXT REFERENCES core_sale_returns(id),
     description  TEXT NOT NULL,
     created_by   TEXT,
     created_at   TEXT NOT NULL,
     -- Acumular duas vezes pela mesma venda daria ponto de graça; estornar duas
     -- vezes cobraria ponto que o cliente não usou.
     UNIQUE (company_id, kind, sale_id, return_id)
   );`,
  `CREATE INDEX IF NOT EXISTS ix_loyalty_customer
     ON core_loyalty_entries (company_id, customer_id);`,

  // CRÉDITO DE LOJA — o vale que a devolução concede e a venda seguinte gasta.
  //
  // MESMO DESENHO DA RAZÃO DE PONTOS, e pelo mesmo motivo: uma linha por fato,
  // com sinal, e o saldo é a SOMA. Guardar o total numa coluna criaria duas
  // versões da mesma verdade, e a divergência apareceria no balcão, com o
  // cliente afirmando ter mais crédito do que a tela mostra.
  //
  // A DIFERENÇA PARA O PONTO É O QUE CADA UM É. Ponto é benefício que a loja
  // concede e pode reprecificar; crédito é DINHEIRO QUE A LOJA DEVE. Ele nasce
  // de uma devolução em que o cliente entregou a mercadoria e NÃO levou o
  // dinheiro — passivo, não cortesia. Por isso o valor é em centavos inteiros,
  // e não em pontos convertidos por uma tabela que alguém pode editar depois.
  //
  // Antes desta tabela o passivo não existia em lugar nenhum: a devolução
  // gravava refund_method='credito', o DRE nomeava o valor numa ressalva, e o
  // saldo do cliente vivia no papel do balcão.
  `CREATE TABLE IF NOT EXISTS core_customer_credits (
     id           TEXT PRIMARY KEY,
     company_id   TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     customer_id  TEXT NOT NULL REFERENCES core_customers(id) ON DELETE CASCADE,
     -- grant (a devolução concede) | redeem (a venda gasta) | reversal (o
     -- cancelamento desfaz um dos dois, no sentido contrário).
     kind         TEXT NOT NULL,
     -- COM SINAL: positivo concede, negativo consome. O saldo é a soma disto,
     -- e nunca uma coluna à parte.
     amount_cents INTEGER NOT NULL,
     -- De onde veio o fato: 'sale_return' concede, 'sale' consome. Guardar os
     -- dois em colunas separadas (return_id, sale_id) deixaria a chave única
     -- com NULL de um lado, e no SQLite NULL não colide com NULL — a trava
     -- contra o dobro passaria a não travar nada.
     origin_type  TEXT NOT NULL,
     origin_id    TEXT NOT NULL,
     description  TEXT NOT NULL,
     created_by   TEXT,
     created_at   TEXT NOT NULL,
     -- Conceder duas vezes pela mesma devolução daria crédito de graça; gastar
     -- duas vezes pela mesma venda cobraria crédito que o cliente não usou.
     UNIQUE (company_id, kind, origin_type, origin_id)
   );`,
  `CREATE INDEX IF NOT EXISTS ix_customer_credits_customer
     ON core_customer_credits (company_id, customer_id);`,

  // LOCAÇÃO — o bem sai da loja sem sair do patrimônio.
  //
  // A diferença para a venda é essa: na venda a mercadoria vira de outro; aqui
  // ela continua sendo da loja e volta. Por isso locar NÃO dá baixa de estoque
  // — RESERVA. O item continua no saldo (é da loja) e some do disponível
  // (está fora), e assim o balcão não vende o que já está com um cliente.
  //
  // Devolver solta a reserva. Cancelar também: contrato que não aconteceu não
  // pode manter mercadoria presa.
  `CREATE TABLE IF NOT EXISTS core_rental_contracts (
     id            TEXT PRIMARY KEY,
     company_id    TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     number        INTEGER NOT NULL,
     customer_id   TEXT NOT NULL REFERENCES core_customers(id),
     -- aberto | devolvido | cancelado
     status        TEXT NOT NULL DEFAULT 'aberto',
     starts_at     TEXT NOT NULL,
     -- Data combinada de devolução. Passou e não voltou: está atrasado, e a
     -- tela mostra — o cálculo é sobre esta data, não um estado gravado que
     -- envelheceria sozinho.
     ends_at       TEXT NOT NULL,
     returned_at   TEXT,
     total_cents   INTEGER NOT NULL DEFAULT 0,
     -- Caução: entra como garantia e volta na devolução. NÃO é receita.
     deposit_cents INTEGER NOT NULL DEFAULT 0,
     notes         TEXT,
     cancel_reason TEXT,
     created_by    TEXT,
     created_at    TEXT NOT NULL,
     updated_at    TEXT NOT NULL,
     UNIQUE (company_id, number)
   );`,
  `CREATE INDEX IF NOT EXISTS ix_rental_company
     ON core_rental_contracts (company_id, status);`,

  `CREATE TABLE IF NOT EXISTS core_rental_contract_items (
     id                TEXT PRIMARY KEY,
     contract_id       TEXT NOT NULL REFERENCES core_rental_contracts(id) ON DELETE CASCADE,
     company_id        TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     product_id        TEXT NOT NULL REFERENCES core_products(id),
     quantity          REAL NOT NULL CHECK (quantity > 0),
     -- Devolução pode ser parcial: o cliente traz duas das três cadeiras.
     returned_quantity REAL NOT NULL DEFAULT 0,
     unit_cents        INTEGER NOT NULL DEFAULT 0,
     created_at        TEXT NOT NULL
   );`,

  // ---------------------------------------------------------------- produtos
  `CREATE TABLE IF NOT EXISTS core_products (
     id              TEXT PRIMARY KEY,
     company_id      TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     internal_code   TEXT NOT NULL,
     sku             TEXT,
     barcode         TEXT,
     name            TEXT NOT NULL,
     description     TEXT,
     category        TEXT,
     brand           TEXT,
     unit            TEXT NOT NULL DEFAULT 'UN',
     cost_cents      INTEGER NOT NULL DEFAULT 0,
     price_cents     INTEGER NOT NULL DEFAULT 0,
     min_stock       REAL NOT NULL DEFAULT 0,
     supplier_id     TEXT,
     ncm             TEXT,
     cest            TEXT,
     cfop            TEXT,
     origin          TEXT,
     tax_profile     TEXT,
     image_url       TEXT,
     active          INTEGER NOT NULL DEFAULT 1,
     -- Só aparece no e-commerce quando marcado explicitamente. Peça de
     -- oficina não vira vitrine pública por acidente.
     publish_online  INTEGER NOT NULL DEFAULT 0,
     -- Destaque da vitrine. Fica no produto, e não numa lista separada de
     -- "destaques": lista paralela divergiria do cadastro no primeiro produto
     -- despublicado, e a loja passaria a destacar o que não se pode vender.
     -- Só vale para quem já está publicado.
     featured_online INTEGER NOT NULL DEFAULT 0,
     -- 'retail' (varejo) ou 'part' (peça de oficina). Peça pertence a uma
     -- oficina específica, e é isso que separa o estoque de peças de
     -- celulares do de mobilidade.
     kind            TEXT NOT NULL DEFAULT 'retail',
     workshop_id     TEXT REFERENCES core_workshops(id),
     -- Grade (tamanho/cor). Uma variante É um produto, com pai: assim estoque,
     -- movimento, código de barras, venda, reserva e vitrine continuam valendo
     -- sem nenhuma tabela paralela. Cada variante tem o próprio EAN, que é
     -- como o varejo funciona de verdade — o leitor do PDV cai na peça exata.
     -- NULL = produto solto ou produto-modelo.
     parent_id       TEXT REFERENCES core_products(id) ON DELETE CASCADE,
     -- JSON dos atributos que definem a variante: {"tamanho":"M","cor":"Azul"}.
     variant_attributes TEXT,
     -- Dados de envio. Sem eles NÃO se cota frete: um pacote de 500 g
     -- inventado vira um preço que o transportador não cobra, e a diferença
     -- aparece no balcão com o cliente na frente.
     weight_grams    INTEGER,
     height_cm       REAL,
     width_cm        REAL,
     length_cm       REAL,
     subcategory     TEXT,
     -- Descrição da vitrine, separada da interna: o que o vendedor anota para
     -- si não é o que o cliente lê na loja.
     online_description TEXT,
     -- Código do fabricante ou do fornecedor. Não é o interno nem o de barras:
     -- é o número pelo qual se PEDE a peça, e o balcão procura por ele.
     reference       TEXT,
     -- ONDE A PEÇA MORA: "Prateleira A3 - Caixa 2". É endereço de CADASTRO, e
     -- não dimensão do razão — a pergunta que responde é "onde eu vou pegar",
     -- feita por quem está com a chave na mão e a moto aberta.
     --
     -- NÃO É o location_id de core_stock_movements, e a diferença é deliberada.
     -- Aquele é o local do MOVIMENTO, e a porta de gravá-lo por padrão está
     -- fechada de propósito (ver InboundConfigService): só a entrada passaria a
     -- registrar local, toda saída continuaria nula, e o saldo por local
     -- mentiria. Este aqui não entra em conta nenhuma — é a etiqueta da gaveta.
     --
     -- Texto livre, como no sistema anterior, porque cada oficina organiza do
     -- seu jeito e impor formato faz ninguém preencher. O que o anterior não
     -- fazia, e aqui se faz, é DEIXAR PROCURAR por ele: "o que tem na F1?" era
     -- pergunta sem resposta lá.
     storage_location TEXT,
     -- Piso de preço. Markup e margem NÃO ficam aqui: derivam de custo e
     -- preço, e uma cópia gravada divergiria no primeiro reajuste. O que se
     -- guarda é a política — abaixo disto não vende.
     min_price_cents    INTEGER NOT NULL DEFAULT 0,
     min_markup_percent REAL,
     min_margin_percent REAL,
     -- Preço digitado na venda, não no cadastro. Serve para serviço e para o
     -- que se combina no balcão.
     open_price      INTEGER NOT NULL DEFAULT 0,
     -- Kit: vende como um, baixa estoque como vários. Desmembrar na venda é o
     -- padrão porque é o que dá baixa correta em cada componente.
     is_kit                   INTEGER NOT NULL DEFAULT 0,
     kit_explode_on_sale      INTEGER NOT NULL DEFAULT 1,
     kit_cost_from_components INTEGER NOT NULL DEFAULT 0,
     -- BALANÇA. Produto vendido por peso, e o número que a balança usa para
     -- achá-lo (PLU). São duas coisas separadas de propósito: existe produto
     -- pesável que não está na balança (ainda não foi cadastrado nela), e o
     -- arquivo de exportação precisa saber distinguir um do outro.
     weighable       INTEGER NOT NULL DEFAULT 0,
     -- Curto por natureza: balança de varejo costuma aceitar 4 a 6 dígitos.
     -- Fica TEXT para não perder zero à esquerda, que a balança lê como parte
     -- do código.
     plu_code        TEXT,
     -- Tara da embalagem em gramas — a balança desconta do peso bruto. Sem
     -- isto o cliente paga pelo pote.
     tare_grams      INTEGER,
     -- SERIALIZADO: cada unidade tem identidade própria (chassi, IMEI, número
     -- de série). Moto e celular têm; camiseta tamanho M não tem. Excludente
     -- com weighable: o que se pesa não se conta uma a uma.
     serialized      INTEGER NOT NULL DEFAULT 0,
     -- CONTROLA ESTOQUE? (GAP-V02) O serviço de balcão — ajuste de roupa,
     -- instalação, aplicação de película — é vendido e não sai de prateleira
     -- nenhuma. Até esta rodada não havia como dizer isso: TODA linha de venda
     -- que não fosse kit desmembrado baixava estoque, e o CHECK (quantity >= 0)
     -- de core_stock recusava a venda por falta de saldo de uma coisa que nunca
     -- teve saldo. O contorno real era lançar entrada fictícia, que suja o
     -- razão para sempre.
     --
     -- POR QUE UMA FLAG, E NÃO kind = 'service': kind é a lista fechada
     -- 'retail' | 'part', com rota de conversão própria, invariante de bancada
     -- e três consultas que a filtram por complemento (kind <> 'part'). Um
     -- terceiro valor entraria calado em todas elas — serviço apareceria onde
     -- peça aparece e sumiria onde peça some, sem ninguém decidir isso. A flag
     -- responde à pergunta que importa ("isto sai da prateleira?") e nasce em 1
     -- para toda linha que já existe, que é a verdade de todas elas.
     stock_control   INTEGER NOT NULL DEFAULT 1,
     -- EMBALAGEM DE COMPRA (GAP-V06): "caixa com 12". O fator já existia por
     -- LINHA DE NOTA (core_inbound_note_items.conversion_factor) e era
     -- redigitado a cada entrada — um 1 no lugar de 12 multiplica estoque e
     -- custo em silêncio. Aqui ele é atributo do CADASTRO e serve de PADRÃO
     -- sugerido na conferência seguinte; a linha da nota continua mandando,
     -- porque o fornecedor pode mudar a caixa sem avisar.
     pack_factor     REAL,
     -- Como a embalagem se chama na nota do fornecedor ("CX", "FD"). Texto,
     -- e não FK para core_units: é a sigla que VEM no XML de terceiro, que não
     -- tem obrigação de existir no cadastro desta loja.
     pack_unit       TEXT,
     -- LOTE E VALIDADE (GAP-V35). Iogurte tem; parafuso não tem.
     --
     -- OPT-IN, e o DEFAULT 0 é a regra dura do módulo: produto sem controle
     -- não ganha nenhum campo obrigatório novo, não muda de caminho na venda,
     -- não entra em alerta e não paga uma consulta a mais. Quem nunca marcar
     -- esta coluna vende exatamente como vendia ontem — a mesma trava de
     -- segurança de serialized e da operadora de cartão.
     --
     -- Excludente com serialized, e a decisão está por extenso em
     -- BatchService: a unidade serializada JÁ tem identidade individual, e
     -- sobrepor lote criaria DUAS escolhas concorrentes para a mesma saída
     -- (qual peça sai × de qual lote sai) sem que nenhuma mande.
     tracks_batches  INTEGER NOT NULL DEFAULT 0,
     -- ================================================================
     -- A PROCEDÊNCIA DA CLASSIFICAÇÃO FISCAL
     -- ================================================================
     --
     -- NCM, CEST e origem podem chegar por dois caminhos que NÃO valem o
     -- mesmo: alguém digitou no cadastro, ou o XML do fornecedor declarou. O
     -- segundo é matéria-prima excelente e não é decisão da casa — e sem estas
     -- três colunas os dois ficavam indistinguíveis dentro das MESMAS colunas
     -- ncm/cest/origin, de modo que um valor lido de arquivo de terceiro
     -- passava por escolha do contador.
     --
     -- NULO É O ESTADO HONESTO do que nunca passou por confirmação humana, e é
     -- por isso que nenhuma das três tem DEFAULT: carimbar o catálogo que já
     -- existe como "confirmado" seria assinar, em nome de gente que não
     -- assinou, uma classificação que ninguém revisou.
     --
     -- Quem confirmou, e quando. Vazio = ninguém confirmou ainda.
     fiscal_confirmed_at     TEXT,
     fiscal_confirmed_by     TEXT,
     -- De onde veio o valor CONFIRMADO: 'cadastro' (digitado) ou
     -- 'xml_fornecedor' (sugerido pelo arquivo e aceito por gente).
     fiscal_classification_source TEXT,
     created_at      TEXT NOT NULL,
     updated_at      TEXT NOT NULL,
     UNIQUE (company_id, internal_code)
   );`,
  // O índice único de `plu_code` NÃO fica aqui, pelo mesmo motivo do índice de
  // `location_id` em core_stock_movements: esta lista roda ANTES das migrações
  // e, em banco que já existe, o CREATE TABLE acima é no-op — a coluna ainda
  // não teria sido adicionada e o índice derrubaria a subida da API. Ele nasce
  // no passo 42, junto das colunas.
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_products_company_barcode
     ON core_products (company_id, barcode) WHERE barcode IS NOT NULL;`,
  // SKU único por empresa, sem diferenciar maiúsculas (auditoria da Preço Justo,
  // A-produto-24). O serviço já recusa o repetido (CORE_SKU_DUPLICATE); o índice
  // fecha a corrida entre dois cadastros simultâneos, que a checagem não vê.
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_products_company_sku
     ON core_products (company_id, upper(sku)) WHERE sku IS NOT NULL AND trim(sku) <> '';`,

  // A declaração da etiqueta da balança da operação (D-pdv-teclado-16). O
  // serviço (CatalogAuxService.DDL_DA_ETIQUETA_DA_BALANCA) cria a mesma tabela,
  // com o MESMO texto, na primeira gravação; aqui ela entra no esquema canônico
  // para a limpeza dos testes e a reconciliação do esquema a conhecerem.
  `CREATE TABLE IF NOT EXISTS core_scale_label_settings (
     company_id     TEXT PRIMARY KEY REFERENCES core_companies(id) ON DELETE CASCADE,
     -- Os dois primeiros dígitos da etiqueta. 21 a 29: a faixa 2x do GS1 é de
     -- circulação interna, e o 20 é a dos códigos que o próprio sistema gera
     -- para produto sem EAN — declarar o 20 faria a etiqueta interna de um
     -- produto qualquer ser lida como PLU e peso.
     prefix         TEXT NOT NULL CHECK (prefix GLOB '2[1-9]'),
     -- Quantos dígitos do PLU vêm depois do prefixo. O valor ocupa o resto até
     -- o verificador: 6 dígitos com PLU de 4, 5 com PLU de 5.
     plu_digits     INTEGER NOT NULL CHECK (plu_digits IN (4, 5)),
     -- 'peso': gramas (0,352 kg vem como 000352). 'preco': centavos do total
     -- que a balança calculou (R$ 19,90 vem como 001990).
     embedded_value TEXT NOT NULL CHECK (embedded_value IN ('peso', 'preco')),
     updated_at     TEXT NOT NULL,
     updated_by     TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS ix_products_company_name ON core_products (company_id, name);`,

  // --------------------------------------------------- categorias e marcas
  //
  // Vocabulário controlado do catálogo. Existe porque categoria e marca eram
  // texto livre: quem digitasse "Masculino" e "masculino" criava duas, e o
  // filtro da vitrine passava a mentir.
  //
  // O produto CONTINUA guardando o texto (`core_products.category`), e não uma
  // chave estrangeira. Não é preguiça: `PricingService` casa promoção por
  // categoria em texto, e trocar isso agora desligaria silenciosamente as
  // promoções por categoria que já existem. Aqui a tabela é a lista do que
  // PODE ser escolhido; o texto gravado no produto é o nome canônico dela.
  `CREATE TABLE IF NOT EXISTS core_categories (
     id          TEXT PRIMARY KEY,
     company_id  TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     name        TEXT NOT NULL,
     -- NULL = categoria raiz; preenchido = subcategoria daquela categoria.
     parent_id   TEXT REFERENCES core_categories(id) ON DELETE CASCADE,
     active      INTEGER NOT NULL DEFAULT 1,
     created_at  TEXT NOT NULL,
     updated_at  TEXT NOT NULL,
     UNIQUE (company_id, parent_id, name)
   );`,
  'CREATE INDEX IF NOT EXISTS ix_categories_company ON core_categories (company_id, parent_id, name);',

  `CREATE TABLE IF NOT EXISTS core_brands (
     id          TEXT PRIMARY KEY,
     company_id  TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     name        TEXT NOT NULL,
     active      INTEGER NOT NULL DEFAULT 1,
     created_at  TEXT NOT NULL,
     updated_at  TEXT NOT NULL,
     UNIQUE (company_id, name)
   );`,

  // ------------------------------------------------- auxiliares do catálogo
  //
  // Três vocabulários controlados, no MESMO desenho de `core_categories`: a
  // tabela é a lista do que pode ser escolhido, e o produto guarda o CÓDIGO em
  // texto. Não é preguiça de normalizar — é o que mantém o cadastro legível e
  // não quebra quem já lê `core_products.unit` e `.tax_profile` como texto.
  // A junção é por `(company_id, code)`, que é único.

  // Unidade de medida.
  //
  // `decimals` é a informação que só existe aqui e muda o comportamento do
  // balcão: arroba vende com 3 casas, caixa vende inteira. Sem isto o PDV
  // aceitava 2,5 caixas — e o estoque passava a ter meia caixa para sempre.
  `CREATE TABLE IF NOT EXISTS core_units (
     id          TEXT PRIMARY KEY,
     company_id  TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     code        TEXT NOT NULL,
     name        TEXT NOT NULL,
     decimals    INTEGER NOT NULL DEFAULT 0 CHECK (decimals BETWEEN 0 AND 3),
     active      INTEGER NOT NULL DEFAULT 1,
     created_at  TEXT NOT NULL,
     updated_at  TEXT NOT NULL,
     UNIQUE (company_id, code)
   );`,

  // Grupo tributário: o conjunto de regras fiscais que vários produtos
  // compartilham. Trocar a regra de um grupo alcança todos de uma vez, que é
  // exatamente o que se quer quando a legislação muda.
  `CREATE TABLE IF NOT EXISTS core_tax_groups (
     id            TEXT PRIMARY KEY,
     company_id    TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     code          TEXT NOT NULL,
     name          TEXT NOT NULL,
     -- Enquadramento: 'simples' | 'simples_excesso' | 'normal'.
     regime        TEXT NOT NULL DEFAULT 'simples',
     ncm           TEXT,
     cest          TEXT,
     cfop_internal TEXT,
     cfop_external TEXT,
     origin        TEXT,
     cst_icms      TEXT,
     csosn         TEXT,
     -- Alíquota de crédito do Simples, em percentual ("2.50").
     --
     -- CSOSN 101 e 201 são "tributada COM permissão de crédito", e o layout
     -- exige pCredSN e vCredICMSSN junto. Sem a alíquota o XML falha no
     -- schema — e inventá-la seria inventar imposto. Nulo é legítimo: os
     -- CSOSN sem crédito (102, 103, 300, 400, 500, 900) não a usam.
     p_cred_sn     TEXT,
     cst_pis       TEXT,
     cst_cofins    TEXT,
     -- IPI (GAP-V08). Até esta rodada o XML levava <vIPI>0.00</vIPI> cravado
     -- no total e nenhum bloco <IPI> nos itens — e core_tax_rates aceitava
     -- kind = 'ipi' sem NINGUÉM ler na emissão: cadastro com escritor e sem
     -- leitor. Estas duas colunas são o leitor.
     --
     -- Nulo é o padrão e é a verdade do varejo do Simples: quem não industrializa
     -- não destaca IPI, e o XML continua exatamente como sai hoje. Preenchido,
     -- o CST vai para o bloco <IPI> de cada item.
     cst_ipi       TEXT,
     -- O CÓDIGO da alíquota em core_tax_rates (kind = 'ipi'), e não o número.
     -- Guardar o percentual aqui criaria uma segunda cópia da alíquota, que
     -- divergiria da cadastrada no primeiro reajuste — o mesmo motivo pelo qual
     -- o produto guarda o CÓDIGO do grupo e não os campos dele.
     ipi_rate_code TEXT,
     -- ICMS PRÓPRIO do regime normal (GAP-PRD-021). O CÓDIGO da alíquota em
     -- core_tax_rates (kind = 'icms') que os CST 00, 20 e 90 destacam — pelo
     -- mesmo motivo do IPI: o ICMS varia por mercadoria, e guardar o número
     -- aqui criaria uma segunda cópia da alíquota.
     icms_rate_code TEXT,
     -- Percentual de redução da base do ICMS ("41.18"): obrigatório no CST 20,
     -- opcional no 90. Texto, como o pCredSN — o contador informa com até 4
     -- casas, e cortar mudaria a base.
     p_red_bc      TEXT,
     -- Fundo de combate à pobreza: o CÓDIGO da alíquota (kind = 'fcp') que se
     -- soma ao ICMS próprio nas mercadorias em que a UF o cobra.
     fcp_rate_code TEXT,
     -- Código de benefício fiscal da UF (cBenef): 8 ou 10 caracteres da tabela
     -- da SEFAZ, exigido pela UF nos CST com benefício. Sai no <prod>.
     c_benef       TEXT,
     active        INTEGER NOT NULL DEFAULT 1,
     created_at    TEXT NOT NULL,
     updated_at    TEXT NOT NULL,
     UNIQUE (company_id, code)
   );`,

  // Alíquota nomeada, para não repetir o número em cada grupo tributário.
  `CREATE TABLE IF NOT EXISTS core_tax_rates (
     id          TEXT PRIMARY KEY,
     company_id  TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     code        TEXT NOT NULL,
     name        TEXT NOT NULL,
     -- 'icms' | 'pis' | 'cofins' | 'ipi'
     kind        TEXT NOT NULL DEFAULT 'icms',
     percent     REAL NOT NULL DEFAULT 0 CHECK (percent >= 0),
     active      INTEGER NOT NULL DEFAULT 1,
     created_at  TEXT NOT NULL,
     updated_at  TEXT NOT NULL,
     UNIQUE (company_id, code)
   );`,

  // --------------------------------------------------------- tabela de preços
  //
  // Preço diferenciado por tabela (atacado, cliente especial). Duas formas, e
  // a específica ganha da geral: um percentual vale para a tabela inteira, e
  // um item pode fixar o próprio preço. Sem a exceção por item, toda tabela
  // vira "menos 5% em tudo", que não é como se negocia de verdade.
  `CREATE TABLE IF NOT EXISTS core_price_tables (
     id            TEXT PRIMARY KEY,
     company_id    TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     name          TEXT NOT NULL,
     percent_off   REAL NOT NULL DEFAULT 0,
     active        INTEGER NOT NULL DEFAULT 1,
     created_at    TEXT NOT NULL,
     updated_at    TEXT NOT NULL,
     UNIQUE (company_id, name)
   );`,

  `CREATE TABLE IF NOT EXISTS core_price_table_items (
     id             TEXT PRIMARY KEY,
     company_id     TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     price_table_id TEXT NOT NULL REFERENCES core_price_tables(id) ON DELETE CASCADE,
     product_id     TEXT NOT NULL REFERENCES core_products(id) ON DELETE CASCADE,
     price_cents    INTEGER NOT NULL CHECK (price_cents >= 0),
     created_at     TEXT NOT NULL,
     updated_at     TEXT NOT NULL,
     UNIQUE (price_table_id, product_id)
   );`,

  // ------------------------------------------- códigos de barras adicionais
  //
  // Um produto tem MAIS DE UM código na prática: o do fabricante, o do fardo,
  // o da etiqueta antiga que ainda circula. `core_products.barcode` continua
  // sendo o principal — o que a etiqueta imprime —, e estes são os que o
  // leitor do PDV também precisa reconhecer.
  //
  // O UNIQUE é por empresa e alcança os dois lugares: um código não pode
  // apontar para dois produtos, senão o leitor escolhe por sorte.
  `CREATE TABLE IF NOT EXISTS core_product_barcodes (
     id          TEXT PRIMARY KEY,
     company_id  TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     product_id  TEXT NOT NULL REFERENCES core_products(id) ON DELETE CASCADE,
     barcode     TEXT NOT NULL,
     created_at  TEXT NOT NULL,
     UNIQUE (company_id, barcode)
   );`,
  `CREATE INDEX IF NOT EXISTS ix_product_barcodes_product
     ON core_product_barcodes (product_id);`,

  // ---------------------------------------------------------- kit de produtos
  //
  // O kit é um produto que se vende como um, e que baixa estoque como vários.
  // As peças ficam aqui, com quantidade — é o que permite montar o kit sem
  // duplicar cadastro e sem inventar um segundo conceito de composição.
  `CREATE TABLE IF NOT EXISTS core_kit_components (
     id            TEXT PRIMARY KEY,
     company_id    TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     kit_id        TEXT NOT NULL REFERENCES core_products(id) ON DELETE CASCADE,
     component_id  TEXT NOT NULL REFERENCES core_products(id) ON DELETE RESTRICT,
     quantity      REAL NOT NULL CHECK (quantity > 0),
     created_at    TEXT NOT NULL,
     updated_at    TEXT NOT NULL,
     UNIQUE (kit_id, component_id),
     -- Kit que contém a si mesmo é laço infinito na baixa de estoque.
     CHECK (kit_id <> component_id)
   );`,
  `CREATE INDEX IF NOT EXISTS ix_kit_components_kit ON core_kit_components (kit_id);`,

  // Fotos do produto.
  //
  // Ficam em tabela própria porque um produto tem várias, com ordem e uma
  // principal — e porque a vitrine consome exatamente estas, sem catálogo
  // paralelo. O arquivo em si vai para o disco do backend; aqui guarda-se o
  // caminho público.
  `CREATE TABLE IF NOT EXISTS core_product_images (
     id          TEXT PRIMARY KEY,
     company_id  TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     product_id  TEXT NOT NULL REFERENCES core_products(id) ON DELETE CASCADE,
     url         TEXT NOT NULL,
     file_name   TEXT,
     byte_size   INTEGER,
     position    INTEGER NOT NULL DEFAULT 0,
     is_primary  INTEGER NOT NULL DEFAULT 0,
     created_at  TEXT NOT NULL
   );`,
  'CREATE INDEX IF NOT EXISTS ix_product_images_product ON core_product_images (product_id, position);',

  // Impressoras configuradas por operação.
  `CREATE TABLE IF NOT EXISTS core_printers (
     id            TEXT PRIMARY KEY,
     company_id    TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     name          TEXT NOT NULL,
     -- 'cupom' (58/80mm), 'etiqueta', 'a4'
     kind          TEXT NOT NULL,
     -- 'browser' imprime pelo navegador; 'agent' exige o agente local.
     transport     TEXT NOT NULL DEFAULT 'browser',
     paper_width_mm INTEGER,
     is_default    INTEGER NOT NULL DEFAULT 0,
     active        INTEGER NOT NULL DEFAULT 1,
     created_at    TEXT NOT NULL,
     updated_at    TEXT NOT NULL,
     -- GAP-PRD-082: a impressora de AGENTE LOCAL mora num computador de caixa.
     -- pdv_terminal_id: o caixa (core_terminals) cujo agente imprime nela;
     --                  nulo = o agente da operação inteira (sem caixa).
     -- agent_device:    onde o agente escreve os bytes ESC/POS naquele
     --                  computador: tcp:IP:porta, o compartilhamento de rede da
     --                  impressora no Windows, COMn ou LPTn.
     pdv_terminal_id TEXT,
     agent_device    TEXT
   );`,

  // MODELOS DE ETIQUETA da operação (preparação da Preço Justo): a GEOMETRIA do
  // papel e o que vai dentro, editáveis pelo gestor — os sete formatos fixos de
  // LabelFormats.ts viram só pontos de partida. O modelo não é a impressora:
  // `printer_id` é a preferida, e o mesmo modelo sai em qualquer outra.
  //   midia        'rolo' (uma linha de etiquetas por página) | 'folha'
  //   fields       JSON: os campos que aparecem (nome, preco, barras, codigo…)
  //   orientation  'retrato' | 'paisagem' (conteúdo girado 90° no adesivo)
  `CREATE TABLE IF NOT EXISTS core_label_templates (
     id              TEXT PRIMARY KEY,
     company_id      TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     name            TEXT NOT NULL,
     midia           TEXT NOT NULL DEFAULT 'rolo',
     paper_width_mm  REAL NOT NULL,
     paper_height_mm REAL,
     width_mm        REAL NOT NULL,
     height_mm       REAL NOT NULL,
     colunas         INTEGER NOT NULL DEFAULT 1,
     linhas          INTEGER,
     gap_x_mm        REAL NOT NULL DEFAULT 0,
     gap_y_mm        REAL NOT NULL DEFAULT 0,
     margin_top_mm   REAL NOT NULL DEFAULT 0,
     margin_left_mm  REAL NOT NULL DEFAULT 0,
     orientation     TEXT NOT NULL DEFAULT 'retrato',
     scale_percent   INTEGER NOT NULL DEFAULT 100,
     -- Resolução da impressora do modelo (203, 300 ou 600 dpi): o módulo do código
     -- de barras é arredondado para os pontos dela, senão a barra sai borrada.
     dpi             INTEGER NOT NULL DEFAULT 203,
     fields          TEXT NOT NULL,
     price_highlight INTEGER NOT NULL DEFAULT 1,
     complement_text TEXT,
     printer_id      TEXT REFERENCES core_printers(id) ON DELETE SET NULL,
     is_default      INTEGER NOT NULL DEFAULT 0,
     created_by      TEXT,
     created_at      TEXT NOT NULL,
     updated_at      TEXT NOT NULL,
     UNIQUE (company_id, name)
   );`,

  // ---------------------------------------------------------------- impressão

  // ------------------------------------------------- entrada de XML por e-mail
  //
  // O fornecedor manda a NF-e por e-mail; esta é apenas OUTRA PORTA para o
  // mesmo `NfeImportService`. Receber não movimenta estoque: continua
  // IMPORTAR → CONFERIR → CONFIRMAR.
  //
  // A senha/token NUNCA fica aqui em claro — vai cifrada pelo mesmo cofre do
  // certificado A1, e a tela só mostra endereço e situação.
  `CREATE TABLE IF NOT EXISTS core_mail_inboxes (
     id             TEXT PRIMARY KEY,
     company_id     TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     address        TEXT NOT NULL,
     host           TEXT NOT NULL,
     port           INTEGER NOT NULL DEFAULT 993,
     secure         INTEGER NOT NULL DEFAULT 1,
     username       TEXT NOT NULL,
     -- Segredo cifrado. Nunca sai pela API, nem em log.
     secret_cipher  TEXT,
     folder         TEXT NOT NULL DEFAULT 'INBOX',
     active         INTEGER NOT NULL DEFAULT 1,
     last_check_at  TEXT,
     last_error     TEXT,
     -- Leitura automática. Roda no BACKEND: depender de alguém deixar uma
     -- tela aberta não é automação, é sorte.
     auto_enabled     INTEGER NOT NULL DEFAULT 0,
     interval_minutes INTEGER NOT NULL DEFAULT 5,
     next_run_at      TEXT,
     -- Trava de execução única. Duas instâncias do servidor lendo a mesma
     -- caixa ao mesmo tempo baixariam a mesma nota duas vezes; a chave da
     -- NF-e barraria a segunda, mas o trabalho e a conexão seriam
     -- desperdiçados — e o log ficaria ilegível.
     locked_until     TEXT,
     locked_by        TEXT,
     last_run_at      TEXT,
     last_success_at  TEXT,
     last_error_at    TEXT,
     last_result      TEXT,
     -- ONDE PAROU (GAP-PRD-035). A leitura buscava as 25 não lidas mais
     -- antigas e nunca marcava nada: a 26ª não entrava nunca. Agora cada
     -- mensagem é lida uma vez e a próxima leitura começa depois do último
     -- UID processado — válido só enquanto a pasta tiver o mesmo UIDVALIDITY.
     imap_uid_validity TEXT,
     imap_last_uid     INTEGER,
     -- Quantas ficaram na caixa para a próxima leitura (o lote é limitado).
     imap_pending      INTEGER,
     -- O que fazer com a mensagem depois de processada: 'lida' (marca como
     -- lida, o padrão), 'mover' (para processed_folder) ou 'manter'.
     after_read        TEXT NOT NULL DEFAULT 'lida',
     processed_folder  TEXT,
     -- Tipo da última falha (GAP-PRD-128): 'credencial', 'pasta', 'conexao'.
     -- É o que separa "senha recusada" de "provedor fora do ar" na tela.
     last_error_kind   TEXT,
     last_ok_at        TEXT,
     created_at     TEXT NOT NULL,
     updated_at     TEXT NOT NULL,
     UNIQUE (company_id, address)
   );`,

  // Mensagens já vistas. O UID do provedor evita reprocessar o mesmo e-mail;
  // a chave da NF-e continua sendo a defesa contra entrada duplicada.
  `CREATE TABLE IF NOT EXISTS core_mail_messages (
     id            TEXT PRIMARY KEY,
     company_id    TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     inbox_id      TEXT NOT NULL REFERENCES core_mail_inboxes(id) ON DELETE CASCADE,
     provider_uid  TEXT NOT NULL,
     subject       TEXT,
     sender        TEXT,
     received_at   TEXT,
     -- 'importado', 'duplicado', 'sem_xml', 'invalido', 'recusado', 'frete', 'ilegivel'
     -- provider_uid: '<UIDVALIDITY>:<UID>@<pasta>' desde o GAP-PRD-035 (o UID
     -- sozinho só vale dentro de uma validade e de uma pasta).
     outcome       TEXT NOT NULL,
     detail        TEXT,
     note_id       TEXT REFERENCES core_inbound_notes(id),
     access_key    TEXT,
     created_at    TEXT NOT NULL,
     UNIQUE (inbox_id, provider_uid)
   );`,
  'CREATE INDEX IF NOT EXISTS ix_mail_messages_company ON core_mail_messages (company_id, created_at);',

  //
  // Um job por PEDIDO DE IMPRESSÃO, não por documento. Reimprimir cria um job
  // novo apontando para o MESMO documento — nunca uma segunda venda, um
  // segundo documento fiscal ou uma segunda baixa de estoque.
  //
  // O estado só chega a `printed` quando o transporte confirma. Marcar antes
  // faria o sistema afirmar que o cupom saiu quando a impressora estava sem
  // papel — e o cliente iria embora sem comprovante.
  `CREATE TABLE IF NOT EXISTS core_print_jobs (
     id             TEXT PRIMARY KEY,
     company_id     TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     document_type  TEXT NOT NULL,
     document_id    TEXT NOT NULL,
     printer_id     TEXT REFERENCES core_printers(id),
     status         TEXT NOT NULL DEFAULT 'pending',
     copies         INTEGER NOT NULL DEFAULT 1,
     attempts       INTEGER NOT NULL DEFAULT 0,
     -- Documento renderizado, guardado para reimprimir exatamente o que saiu
     -- da primeira vez, mesmo que o preço mude depois.
     payload        TEXT,
     error          TEXT,
     /** Job que originou este, quando é reimpressão. */
     reprint_of     TEXT REFERENCES core_print_jobs(id),
     created_by     TEXT,
     created_at     TEXT NOT NULL,
     printed_at     TEXT,
     -- GAP-PRD-082: por onde este papel sai. 'agent' = o agente local do
     -- caixa retira, imprime e confirma; 'browser' (ou nulo, nos jobs antigos)
     -- = a caixa de diálogo do navegador. fallback_reason diz por que um job
     -- de impressora de agente saiu pelo navegador (agente fora do ar...).
     transport       TEXT,
     open_drawer     INTEGER NOT NULL DEFAULT 0,
     pdv_terminal_id TEXT,
     agent_id        TEXT,
     claimed_at      TEXT,
     fallback_reason TEXT,
     -- Motivo declarado de abrir a gaveta SEM venda (troco, sangria).
     reason          TEXT
   );`,
  'CREATE INDEX IF NOT EXISTS ix_print_jobs_company ON core_print_jobs (company_id, status, created_at);',
  'CREATE INDEX IF NOT EXISTS ix_print_jobs_document ON core_print_jobs (document_type, document_id);',

  // ----------------------------------------------------------------- estoque
  // Saldo por empresa+produto. O CHECK é a barreira final contra estoque
  // negativo: dois PDVs vendendo o último item -> o segundo COMMIT falha.
  `CREATE TABLE IF NOT EXISTS core_stock (
     company_id  TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     product_id  TEXT NOT NULL REFERENCES core_products(id) ON DELETE CASCADE,
     quantity    REAL NOT NULL DEFAULT 0 CHECK (quantity >= 0),
     reserved    REAL NOT NULL DEFAULT 0 CHECK (reserved >= 0),
     updated_at  TEXT NOT NULL,
     PRIMARY KEY (company_id, product_id)
   );`,

  // ------------------------------------------------------ locais de estoque
  //
  // ONDE a mercadoria está, sem tocar em QUANTO existe.
  //
  // A tentação era pôr o local na chave de `core_stock`, transformando o saldo
  // em uma linha por local. Isso mudaria o significado do `CHECK
  // (quantity >= 0)`: de "o total nunca fica negativo" para "nenhum local fica
  // negativo" — e obrigaria a revisar os vinte pontos que leem o saldo, mais o
  // projetor da central e o espelho do bootstrap. Alto risco para um ganho que
  // dá para ter de outro jeito.
  //
  // O local é dimensão do RAZÃO, não do cache. `core_stock_movements` ganha
  // `location_id`, e o saldo por local sai da soma dos movimentos. Uma fonte de
  // verdade, o total continua onde sempre esteve, e o invariante não muda.
  //
  // O local PADRÃO existe para o movimento antigo não ficar órfão: tudo que foi
  // lançado antes desta tabela pertence a ele, e quem não escolhe local também
  // cai nele.
  `CREATE TABLE IF NOT EXISTS core_stock_locations (
     id          TEXT PRIMARY KEY,
     company_id  TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     code        TEXT NOT NULL,
     name        TEXT NOT NULL,
     -- Endereço interno: corredor, prateleira, gaveta. Texto livre porque cada
     -- loja organiza do seu jeito, e impor um formato faria ninguém preencher.
     note        TEXT,
     is_default  INTEGER NOT NULL DEFAULT 0,
     active      INTEGER NOT NULL DEFAULT 1,
     created_at  TEXT NOT NULL,
     updated_at  TEXT NOT NULL,
     UNIQUE (company_id, code)
   );`,
  // Um padrão por empresa, garantido pelo banco: dois padrões fariam o
  // movimento sem local escolhido cair ora num, ora noutro.
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_stock_location_default
     ON core_stock_locations (company_id) WHERE is_default = 1;`,

  // INVENTÁRIO — a contagem, e o acerto que sai dela.
  //
  // O ajuste é a ÚNICA entrada de estoque sem documento de origem: não há nota,
  // não há venda, não há OS. Alguém afirma que o saldo é outro. Por isso o
  // rastro aqui é mais forte que nos demais: fica registrado quem abriu, quem
  // contou cada item, quanto o sistema esperava naquele instante e quanto foi
  // achado. Sem isso, "acerto de inventário" vira a porta por onde mercadoria
  // some sem explicação.
  `CREATE TABLE IF NOT EXISTS core_inventory_counts (
     id           TEXT PRIMARY KEY,
     company_id   TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     number       INTEGER NOT NULL,
     -- aberta | aplicada | cancelada
     status       TEXT NOT NULL DEFAULT 'aberta',
     scope_note   TEXT,
     opened_by    TEXT,
     opened_at    TEXT NOT NULL,
     applied_by   TEXT,
     applied_at   TEXT,
     apply_reason TEXT,
     cancel_reason TEXT,
     created_at   TEXT NOT NULL,
     -- O LOCAL CONTADO (GAP-PRD-167). Nulo = a empresa inteira, como sempre
     -- foi: o esperado é o saldo total. Preenchido, o esperado é o saldo
     -- DAQUELE local (derivado do razão) e o acerto sai no mesmo local — a
     -- Vitrine se conta sem somar o depósito de cabeça. Anulável, então o
     -- boot a acrescenta em banco existente (REGRAS §5).
     location_id  TEXT REFERENCES core_stock_locations(id),
     UNIQUE (company_id, number)
   );`,

  `CREATE TABLE IF NOT EXISTS core_inventory_count_items (
     id             TEXT PRIMARY KEY,
     count_id       TEXT NOT NULL REFERENCES core_inventory_counts(id) ON DELETE CASCADE,
     company_id     TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     product_id     TEXT NOT NULL REFERENCES core_products(id),
     -- Saldo no instante em que o item entrou na contagem, congelado.
     --
     -- Comparar com o saldo do momento de APLICAR faria o acerto absorver tudo
     -- o que foi vendido no intervalo: a venda legítima entre contar e aplicar
     -- viraria "diferença de inventário", e o buraco real ficaria escondido
     -- dentro dela.
     expected_quantity REAL NOT NULL,
     -- NULO enquanto ninguém contou. Nulo NÃO é zero: produto que a contagem
     -- não alcançou não pode ser tratado como "achei nenhum" -- isso zeraria o
     -- estoque de tudo que ficou de fora.
     counted_quantity  REAL,
     counted_at     TEXT,
     counted_by     TEXT,
     created_at     TEXT NOT NULL,
     UNIQUE (count_id, product_id)
   );`,

  // ------------------------------------------------------- lotes e validade
  //
  // QUANDO vence, e não quanto existe (GAP-V35).
  //
  // O grupo vende produto pesável — `weighable`, `plu_code` e `tare_grams`
  // existem desde a rodada da balança —, e alimento sem controle de validade é
  // perda invisível ao gestor, mercadoria vencida vendável no PDV sem trava e
  // exposição sanitária. Não havia UMA coluna de lote ou validade em nenhuma
  // das três tabelas de estoque.
  //
  // ## Por que o saldo continua sendo o saldo
  //
  // Mesma escolha do local de estoque e das unidades serializadas, pelo mesmo
  // motivo, e é a terceira vez que ela se paga: o lote é DIMENSÃO DO RAZÃO, e
  // não uma segunda tabela de saldo. `core_stock_movements` ganha `batch_id`, e
  // o saldo POR LOTE é a SOMA dos movimentos daquele lote. Uma fonte de verdade
  // só; o `CHECK (quantity >= 0)` de `core_stock` não muda de significado; os
  // vinte pontos que leem saldo continuam lendo o que sempre leram.
  //
  // Pôr o lote na chave de `core_stock` transformaria "o total nunca fica
  // negativo" em "nenhum lote fica negativo" e obrigaria a revisar o projetor
  // da central e o espelho do bootstrap junto. Alto risco por um ganho que a
  // soma já dá.
  //
  // ## O lote é um CADASTRO, não um evento
  //
  // Esta tabela guarda a IDENTIDADE do lote — código, fabricação, validade,
  // onde ele mora e quem o conferiu. Ela não guarda quantidade nenhuma, de
  // propósito: quantidade aqui seria o segundo cache que o parágrafo acima
  // recusa, e o primeiro estorno o faria divergir do razão em silêncio.
  //
  // O CÓDIGO É ÚNICO POR PRODUTO, e não por empresa: o mesmo "L2409" do
  // fornecedor pode aparecer em dois produtos diferentes na mesma semana, e
  // uni-los faria a validade de um contaminar o outro.
  `CREATE TABLE IF NOT EXISTS core_product_batches (
     id             TEXT PRIMARY KEY,
     company_id     TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     product_id     TEXT NOT NULL REFERENCES core_products(id) ON DELETE CASCADE,
     -- O código impresso na embalagem. Texto, e não número: lote de fornecedor
     -- vem com letra, traço e zero à esquerda, e nada disso é aritmética.
     code           TEXT NOT NULL,
     -- Datas de CALENDÁRIO (AAAA-MM-DD), nunca instante. Validade é o dia
     -- impresso no rótulo: guardá-la como timestamp faria a comparação recuar
     -- um dia conforme o fuso de quem lê, que é defeito conhecido desta casa.
     manufactured_on TEXT,
     -- NULO é legítimo e não é "não vence": é "ninguém declarou". Lote sem
     -- validade declarada NÃO entra em alerta nenhum e NÃO é recusado na
     -- venda — inventar vencimento seria pior que não ter.
     expires_on     TEXT,
     -- Onde este lote está. Nulo cai no padrão da empresa, como no razão.
     location_id    TEXT REFERENCES core_stock_locations(id),
     -- CONFERÊNCIA: quem olhou a caixa e disse "é este lote, esta validade".
     -- Nulo enquanto ninguém conferiu, e nulo NÃO é "reprovado" — é o mesmo
     -- desenho de counted_quantity na contagem de inventário.
     checked_at     TEXT,
     checked_by     TEXT,
     note           TEXT,
     created_by     TEXT,
     created_at     TEXT NOT NULL,
     updated_at     TEXT NOT NULL,
     UNIQUE (company_id, product_id, code)
   );`,
  // Estes índices PODEM ficar na DDL canônica — ao contrário dos de
  // `location_id`, `plu_code` e `batch_id` — porque a tabela nasce nesta mesma
  // lista e as colunas já existem quando o índice roda.
  `CREATE INDEX IF NOT EXISTS ix_product_batches_produto
     ON core_product_batches (company_id, product_id, expires_on);`,
  // A pergunta do alerta: "o que vence primeiro nesta empresa". A validade
  // manda na ordenação, e é por ela que a varredura das faixas entra.
  `CREATE INDEX IF NOT EXISTS ix_product_batches_validade
     ON core_product_batches (company_id, expires_on);`,

  // Razão (ledger) imutável de movimentações. A UNIQUE abaixo é o que impede
  // baixa dupla: reprocessar a mesma venda viola a constraint em vez de
  // debitar o estoque de novo.
  // Razão imutável do estoque.
  //
  // `product_id` aponta para a VARIANTE quando o produto tem grade — variante é
  // uma linha de core_products com `parent_id`, então não existe coluna
  // separada de variante e o histórico já cai na peça exata.
  //
  // Três eixos são guardados, e eles não se confundem:
  //   quantity        saldo FÍSICO (on hand)
  //   reserved        mercadoria prometida (pré-venda, e-commerce, OMS)
  //   disponível      quantity - reserved, calculado
  //
  // Reserva NÃO reduz o físico: a linha de reserva tem delta 0 em `quantity` e
  // delta em `reserved`. Assim o histórico mostra o evento sem mentir sobre o
  // que existe na prateleira.
  `CREATE TABLE IF NOT EXISTS core_stock_movements (
     id              TEXT PRIMARY KEY,
     company_id      TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     product_id      TEXT NOT NULL REFERENCES core_products(id) ON DELETE CASCADE,
     -- Direção crua: in / out / adjust. Faz parte da chave de idempotência.
     movement_type   TEXT NOT NULL,
     -- POR QUE o saldo mudou: XML_RECEIPT, SALE, WORKSHOP_PART_CONSUMPTION…
     -- É isto que o gestor lê na tela; a direção sozinha não explica nada.
     kind            TEXT,
     quantity        REAL NOT NULL,
     -- Saldo ANTES do movimento. Sem ele o histórico não fecha a conta
     -- (anterior + delta = posterior) e a auditoria vira adivinhação.
     quantity_before REAL,
     reserved_before REAL,
     reserved_delta  REAL NOT NULL DEFAULT 0,
     reserved_after  REAL,
     unit_cost_cents INTEGER,
     reference_type  TEXT NOT NULL,
     reference_id    TEXT NOT NULL,
     -- Número do documento de origem (NF-e, venda, OS), para o gestor achar
     -- o papel correspondente sem decorar id técnico.
     document_number TEXT,
     workshop_id     TEXT REFERENCES core_workshops(id),
     balance_after   REAL NOT NULL,
     user_id         TEXT,
     reason          TEXT,
     note            TEXT,
     -- ONDE o movimento aconteceu. O saldo POR LOCAL sai da soma daqui — não
     -- há um segundo cache a manter em dia. Nulo significa o local padrão da
     -- empresa, que é como todo movimento anterior a esta coluna é lido.
     location_id     TEXT REFERENCES core_stock_locations(id),
     -- DE QUAL LOTE saiu, ou em qual lote entrou (GAP-V35). Mesma natureza de
     -- location_id: dimensão do razão, e o saldo por lote é a SOMA daqui.
     --
     -- NULO tem significado próprio e não é buraco: ou o produto não controla
     -- lote (a esmagadora maioria), ou controla e a mercadoria entrou sem o
     -- lote declarado — o balde "sem lote", que a tela de Validade nomeia como
     -- pendência para que ele DIMINUA em vez de crescer calado.
     batch_id        TEXT REFERENCES core_product_batches(id),
     -- Saldo DO LOTE antes e depois, pelo mesmo motivo do par do produto: a
     -- linha tem de fechar a conta sozinha (anterior + delta = posterior) sem
     -- que quem lê precise refazer a soma do razão inteiro. Preenchidos só
     -- para produto que controla lote — para o resto seriam duas colunas de
     -- nada em toda linha do histórico.
     batch_quantity_before REAL,
     batch_balance_after   REAL,
     created_at      TEXT NOT NULL,
     -- O QUE O PEDIDO COM CHAVE DO CLIENTE PEDIU (RES-IDEM-VIZ). So a rota
     -- manual (a referencia e a chave de quem chama) e a entrada de peca de
     -- bancada (Idempotency-Key) gravam: v1 + SHA-256 de quantidade, custo,
     -- local, lote, unidades. A mesma referencia com outra carga e recusada
     -- (422 CORE_IDEMPOTENCY_KEY_REUSED) em vez de responder "duplicado".
     -- Nula = movimento interno (venda, nota, OS), ou anterior a coluna: o
     -- reenvio segue a regra antiga.
     idempotency_fingerprint TEXT,
     UNIQUE (company_id, reference_type, reference_id, product_id, movement_type)
   );`,
  // O índice de `location_id` NÃO fica aqui: esta lista roda ANTES das
  // migrações, e em banco que já existe o `CREATE TABLE IF NOT EXISTS` acima é
  // no-op — a coluna ainda não teria sido adicionada e o índice quebraria a
  // subida. Ele é criado no passo 41, junto da coluna.

  // ------------------------------------------------ operadora de cartão
  //
  // O DINHEIRO DO CARTÃO NÃO CAI HOJE, NEM CAI INTEIRO.
  //
  // Uma venda de R$ 100 no crédito nascia como R$ 100 quitados no mesmo dia.
  // Na prática são ~R$ 96,50 daqui a trinta dias. O sistema confundia
  // faturamento com dinheiro em caixa, e o fluxo de caixa mentia para cima
  // justamente no meio de pagamento que a loja mais usa.
  //
  // ## A trava de segurança
  //
  // Sem operadora cadastrada, NADA muda: a venda no cartão continua nascendo
  // quitada, como sempre. O comportamento novo só liga quando alguém cadastra
  // a operadora e a taxa — mesma ideia do produto serializado, que fica inerte
  // até ser marcado.
  `CREATE TABLE IF NOT EXISTS core_acquirers (
     id          TEXT PRIMARY KEY,
     company_id  TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     name        TEXT NOT NULL,
     -- Onde a operadora deposita. Nulo cai na conta padrão da empresa.
     account_id  TEXT REFERENCES core_finance_accounts(id),
     active      INTEGER NOT NULL DEFAULT 1,
     created_at  TEXT NOT NULL,
     updated_at  TEXT NOT NULL,
     UNIQUE (company_id, name)
   );`,

  // A TAXA E O PRAZO, por forma de pagamento e por número de parcelas.
  //
  // Taxa em BASIS POINTS pelo mesmo motivo da comissão: 3,5% guardado como
  // decimal acumula erro de arredondamento em milhares de vendas, e taxa que
  // não fecha na conferência com o extrato da operadora é discussão garantida.
  //
  // `installments` é o número EXATO de parcelas daquela regra: débito é 1,
  // crédito à vista é 1, crédito em 3x é 3. Faixa de "3 a 6 parcelas" foi
  // recusada porque a operadora cobra por número exato, e aproximar aqui faria
  // a conciliação nunca fechar.
  `CREATE TABLE IF NOT EXISTS core_acquirer_rates (
     id            TEXT PRIMARY KEY,
     company_id    TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     acquirer_id   TEXT NOT NULL REFERENCES core_acquirers(id) ON DELETE CASCADE,
     -- O código do catálogo de PaymentMethods: 'debito', 'credito', 'pix'.
     payment_method TEXT NOT NULL,
     installments  INTEGER NOT NULL DEFAULT 1,
     fee_bps       INTEGER NOT NULL DEFAULT 0,
     -- Dias até o dinheiro cair. Débito costuma ser 1; crédito, 30 por parcela.
     settlement_days INTEGER NOT NULL DEFAULT 0,
     created_at    TEXT NOT NULL,
     UNIQUE (company_id, payment_method, installments),
     CHECK (installments >= 1),
     CHECK (fee_bps >= 0),
     CHECK (settlement_days >= 0)
   );`,

  // --------------------------------------------------------------- comissões
  //
  // GRUPO E FAIXA — a regra de quanto se paga.
  //
  // A faixa é por VALOR DA VENDA, e não por acumulado do mês. Meta mensal
  // parece a mesma coisa e não é: ela faz o percentual de uma venda de
  // segunda-feira mudar por causa de uma venda de sexta, o que torna toda
  // apuração retroativa. Se for pedida, a resposta é lançamento de ajuste no
  // fechamento — não trocar a faixa.
  `CREATE TABLE IF NOT EXISTS core_commission_groups (
     id          TEXT PRIMARY KEY,
     company_id  TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     name        TEXT NOT NULL,
     active      INTEGER NOT NULL DEFAULT 1,
     created_at  TEXT NOT NULL,
     updated_at  TEXT NOT NULL,
     UNIQUE (company_id, name)
   );`,
  // Percentual em BASIS POINTS (250 = 2,5%), não em decimal: um `REAL` de 2,5%
  // aplicado a milhares de vendas acumula erro de arredondamento, e comissão
  // que não fecha na conferência do vendedor é briga garantida.
  `CREATE TABLE IF NOT EXISTS core_commission_tiers (
     id           TEXT PRIMARY KEY,
     company_id   TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     group_id     TEXT NOT NULL REFERENCES core_commission_groups(id) ON DELETE CASCADE,
     -- A partir de quanto esta faixa vale.
     min_cents    INTEGER NOT NULL DEFAULT 0,
     rate_bps     INTEGER NOT NULL,
     created_at   TEXT NOT NULL,
     UNIQUE (group_id, min_cents),
     CHECK (min_cents >= 0),
     CHECK (rate_bps >= 0)
   );`,
  `CREATE TABLE IF NOT EXISTS core_commission_members (
     company_id  TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     user_id     TEXT NOT NULL REFERENCES core_users(id) ON DELETE CASCADE,
     group_id    TEXT NOT NULL REFERENCES core_commission_groups(id) ON DELETE CASCADE,
     created_at  TEXT NOT NULL,
     PRIMARY KEY (company_id, user_id)
   );`,

  // O QUE FOI APURADO — fato gravado, não conta refeita.
  //
  // ## Por que gravado, e não derivado
  //
  // O saldo por local (rodada 6) e o saldo da conta (rodada 9) são derivados,
  // e por bons motivos. Comissão é diferente por uma razão só, e ela decide:
  // A REGRA MUDA COM O TEMPO. Se o dono subir o percentual em março, uma
  // apuração derivada recalcularia fevereiro — que já foi pago. Dinheiro que
  // saiu não pode mudar de valor depois.
  //
  // Por isso `base_cents` e `rate_bps` são copiados para a linha: ela responde
  // sozinha, para sempre, sem depender do cadastro de hoje.
  //
  // ## O estorno é linha, não exclusão
  //
  // Venda cancelada e devolução geram linha NEGATIVA, com a mesma origem. A
  // linha positiva original fica onde está — foi o que aconteceu. Apagar
  // esconderia do vendedor por que a comissão dele mudou.
  `CREATE TABLE IF NOT EXISTS core_commission_entries (
     id           TEXT PRIMARY KEY,
     company_id   TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     seller_id    TEXT NOT NULL,
     sale_id      TEXT REFERENCES core_sales(id),
     -- sale | sale_cancel | sale_return | ajuste
     origin_type  TEXT NOT NULL,
     origin_id    TEXT NOT NULL,
     -- Sobre quanto se calculou, e a que percentual. Congelados na linha.
     base_cents   INTEGER NOT NULL,
     rate_bps     INTEGER NOT NULL,
     -- Negativo em estorno. É o que faz a soma do período fechar sozinha.
     amount_cents INTEGER NOT NULL,
     -- aberto | fechado
     status       TEXT NOT NULL DEFAULT 'aberto',
     closing_id   TEXT,
     -- Data do FATO, que é por onde o período agrupa.
     competence_date TEXT NOT NULL,
     note         TEXT,
     created_at   TEXT NOT NULL,
     -- Cancelar duas vezes não estorna duas vezes.
     UNIQUE (company_id, origin_type, origin_id, seller_id),
     CHECK (status IN ('aberto', 'fechado'))
   );`,
  `CREATE INDEX IF NOT EXISTS ix_commission_period
     ON core_commission_entries (company_id, seller_id, competence_date, status);`,

  // O FECHAMENTO — quando a comissão vira conta a pagar de verdade.
  `CREATE TABLE IF NOT EXISTS core_commission_closings (
     id            TEXT PRIMARY KEY,
     company_id    TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     seller_id     TEXT NOT NULL,
     period_from   TEXT NOT NULL,
     period_to     TEXT NOT NULL,
     total_cents   INTEGER NOT NULL,
     -- Nulo quando o saldo do período foi zero ou negativo: não se cria conta
     -- a pagar de valor negativo, ela viraria um crédito confuso.
     finance_entry_id TEXT REFERENCES core_finance_entries(id),
     closed_by     TEXT,
     created_at    TEXT NOT NULL,
     -- A trava contra pagar duas vezes o mesmo período.
     UNIQUE (company_id, seller_id, period_from, period_to)
   );`,

  // ------------------------------------------------- unidades serializadas
  //
  // QUAL peça, e não quantas.
  //
  // Moto e celular têm identidade individual: chassi, número do motor, IMEI.
  // Vender "uma moto" não diz nada — o que se vende é AQUELA moto, e o cliente
  // leva um documento com o chassi. Camiseta tamanho M não tem disso.
  //
  // ## Por que o saldo continua sendo o saldo
  //
  // A tentação era fazer `core_stock.quantity` virar a CONTAGEM de unidades em
  // estoque. Isso trocaria o significado do `CHECK (quantity >= 0)` — de "o
  // total nunca fica negativo" para "nenhuma unidade sai duas vezes" — logo
  // para os itens de maior valor do negócio, e faria os quinze pontos que leem
  // saldo terem duas semânticas conforme uma coluna do produto. Pior: o
  // `balance_after` que vai para a central passaria a ter duas origens, uma
  // soma e uma contagem, na mesma coluna.
  //
  // Aqui a unidade é uma DIMENSÃO DE IDENTIDADE ao lado do saldo. `core_stock`
  // não muda de dono nem de significado; o acoplamento mora num lugar só —
  // dentro de `applyMovement` —, que é o único escritor do saldo. Nenhum
  // caminho move estoque de serializado sem virar o status da unidade na mesma
  // transação, então o rollback que desfaz um desfaz o outro.
  //
  // O catálogo é misto e vai continuar misto: a mesma empresa, no mesmo PDV,
  // vende camiseta e moto. Um eixo novo que só quem precisa enxerga custa
  // menos que dois motores de saldo convivendo para sempre.
  `CREATE TABLE IF NOT EXISTS core_product_units (
     id            TEXT PRIMARY KEY,
     company_id    TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     product_id    TEXT NOT NULL REFERENCES core_products(id) ON DELETE CASCADE,
     -- in_stock | sold | baixada
     --
     -- "baixada" é a unidade que saiu sem venda: perda, quebra, devolução ao
     -- fornecedor. Ela NÃO some da tabela, porque o chassi já circulou em
     -- documento e alguém vai perguntar por ele daqui a dois anos.
     status        TEXT NOT NULL DEFAULT 'in_stock',
     -- As cinco identidades. Todas nulas ao nascer: a nota de entrada traz a
     -- quantidade muito antes de alguém ler o chassi na peça.
     serial_number TEXT,
     imei          TEXT,
     chassis       TEXT,
     motor_number  TEXT,
     plate         TEXT,
     location_id   TEXT REFERENCES core_stock_locations(id),
     cost_cents    INTEGER,
     -- Por onde entrou e por onde saiu. O par de saída espelha a chave do
     -- movimento que a tirou do estoque: é assim que o estorno acha exatamente
     -- as unidades que saíram, sem reler a venda.
     entry_reference_type TEXT,
     entry_reference_id   TEXT,
     exit_reference_type  TEXT,
     exit_reference_id    TEXT,
     sale_item_id  TEXT,
     -- A ponte com a oficina: a moto que a loja comprou para revender é uma
     -- unidade de estoque E um equipamento com plaquinha.
     equipment_id  TEXT REFERENCES core_equipment(id),
     note          TEXT,
     created_at    TEXT NOT NULL,
     updated_at    TEXT NOT NULL
   );`,
  // Estes índices PODEM ficar na DDL canônica — ao contrário dos de
  // `location_id` e `plu_code` — porque a tabela nasce nesta mesma lista, e as
  // colunas já existem quando o índice roda.
  `CREATE INDEX IF NOT EXISTS ix_product_units_product
     ON core_product_units (company_id, product_id, status);`,
  `CREATE INDEX IF NOT EXISTS ix_product_units_location
     ON core_product_units (company_id, location_id);`,
  // Uma identidade não se repete na empresa: dois celulares com o mesmo IMEI
  // significam que alguém digitou errado, e descobrir isso na garantia é tarde.
  // Parciais porque a identidade nasce nula e vários nulos não colidem.
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_product_units_serial
     ON core_product_units (company_id, serial_number) WHERE serial_number IS NOT NULL;`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_product_units_imei
     ON core_product_units (company_id, imei) WHERE imei IS NOT NULL;`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_product_units_chassis
     ON core_product_units (company_id, chassis) WHERE chassis IS NOT NULL;`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_product_units_motor
     ON core_product_units (company_id, motor_number) WHERE motor_number IS NOT NULL;`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_product_units_plate
     ON core_product_units (company_id, plate) WHERE plate IS NOT NULL;`,
  // Um equipamento é uma unidade só: a moto no pátio não pode estar em duas
  // linhas de estoque.
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_product_units_equipment
     ON core_product_units (equipment_id) WHERE equipment_id IS NOT NULL;`,

  // ATENÇÃO: o índice sobre `kind` NÃO fica aqui.
  //
  // `ensureCoreSchema` roda ANTES das migrations. Num banco que já existe, a
  // tabela ainda não tem a coluna quando estas instruções são executadas, e o
  // CREATE INDEX derruba a subida inteira com "no such column: kind". Índice
  // que depende de coluna adicionada por migração pertence ao passo da
  // migração, depois do ALTER. Ver o passo 9 em core-migrations.ts.
  //
  // UM ÍNDICE POR PERGUNTA (GAP-PRD-144). Havia um segundo, `ix_stock_mov_product`,
  // com as MESMAS colunas na mesma ordem: o custo de escrita dobrava a cada
  // movimento de estoque sem ganho nenhum de leitura. Banco novo já não o cria;
  // no banco existente, o `DROP INDEX` vai no passo de consolidação
  // (docs/audits/remediacao/migracoes/DEP.md) — o boot não derruba índice.
  'CREATE INDEX IF NOT EXISTS ix_stock_movements_product ON core_stock_movements (company_id, product_id, created_at);',

  // ------------------------------------------------------------------- caixa
  //
  // A REABERTURA NÃO APAGA A CONFERÊNCIA — ela a ARQUIVA (`closing_trail`).
  //
  // Reabrir um turno obriga a decidir o que acontece com o esperado, o contado
  // e a diferença que o fechamento gravou como FATO. Havia duas saídas ruins:
  // deixá-los na linha (a gaveta volta a estar ABERTA exibindo a contagem de um
  // fechamento que foi desfeito — estado que mente) ou apagá-los (a conferência
  // de R$ 40 de falta que alguém já explicou some do sistema).
  //
  // A saída é a terceira: o fechamento desfeito é EMPILHADO em `closing_trail`
  // (JSON, um objeto por fechamento: quem fechou, quando, esperado, contado,
  // diferença, e quem reabriu e por quê) e as colunas vivas voltam a nulo, que
  // é a verdade de uma gaveta aberta. O fechamento seguinte recalcula o
  // esperado dos movimentos — inclusive os que entraram depois da reabertura —
  // e a trilha guarda quantas vezes aquele turno foi reaberto.
  //
  // `reopen_count` fica em coluna própria, e não derivado do tamanho do JSON:
  // é o que a tela lê para marcar o turno, e contar elementos de um texto a
  // cada linha da lista seria pagar parse por linha para responder um inteiro.
  `CREATE TABLE IF NOT EXISTS core_cash_sessions (
     id                TEXT PRIMARY KEY,
     company_id        TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     terminal_id       TEXT REFERENCES core_terminals(id),
     opened_by         TEXT NOT NULL,
     closed_by         TEXT,
     opening_cents     INTEGER NOT NULL DEFAULT 0,
     counted_cents     INTEGER,
     expected_cents    INTEGER,
     difference_cents  INTEGER,
     status            TEXT NOT NULL DEFAULT 'open',
     opened_at         TEXT NOT NULL,
     closed_at         TEXT,
     note              TEXT,
     reopened_at       TEXT,
     reopened_by       TEXT,
     reopen_reason     TEXT,
     reopen_count      INTEGER NOT NULL DEFAULT 0,
     closing_trail     TEXT,
     closed_with_pending TEXT
   );`,
  // Só uma sessão aberta por terminal.
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_cash_open_per_terminal
     ON core_cash_sessions (company_id, terminal_id) WHERE status = 'open';`,

  `CREATE TABLE IF NOT EXISTS core_cash_movements (
     id             TEXT PRIMARY KEY,
     session_id     TEXT NOT NULL REFERENCES core_cash_sessions(id) ON DELETE CASCADE,
     company_id     TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     movement_type  TEXT NOT NULL,
     amount_cents   INTEGER NOT NULL,
     payment_method TEXT,
     reference_type TEXT,
     reference_id   TEXT,
     user_id        TEXT,
     note           TEXT,
     created_at     TEXT NOT NULL,
     UNIQUE (session_id, reference_type, reference_id, movement_type)
   );`,

  // ------------------------------------------------------------------ vendas
  `CREATE TABLE IF NOT EXISTS core_sales (
     id                TEXT PRIMARY KEY,
     company_id        TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     number            INTEGER NOT NULL,
     terminal_id       TEXT REFERENCES core_terminals(id),
     cash_session_id   TEXT REFERENCES core_cash_sessions(id),
     customer_id       TEXT REFERENCES core_customers(id),
     seller_id         TEXT,
     status            TEXT NOT NULL DEFAULT 'completed',
     subtotal_cents    INTEGER NOT NULL DEFAULT 0,
     discount_cents    INTEGER NOT NULL DEFAULT 0,
     surcharge_cents   INTEGER NOT NULL DEFAULT 0,
     total_cents       INTEGER NOT NULL DEFAULT 0,
     -- Troco devolvido ao cliente. Não é desconto nem receita: é dinheiro que
     -- entrou na gaveta e saiu de volta, e a gaveta só fica com o líquido.
     change_cents      INTEGER NOT NULL DEFAULT 0,
     idempotency_key   TEXT NOT NULL,
     origin            TEXT NOT NULL DEFAULT 'pdv',
     note              TEXT,
     -- ------------------------------- por qual tabela esta venda foi cobrada
     --
     -- FOTOGRAFIA, NUNCA PONTEIRO. Guarda-se o NOME e o PERCENTUAL que valiam
     -- no instante do INSERT, e não o id da tabela.
     --
     -- Ler por LEFT JOIN na hora da consulta seria mais barato e estaria
     -- errado: a tabela "Atacado" muda de 10% para 5% em junho e a venda de
     -- março passa a CONTAR OUTRA HISTÓRIA — o mesmo cupom, reimpresso, diz que
     -- o cliente teve 5%. É o tipo de divergência que só aparece quando alguém
     -- contesta um valor, e aí não há como provar qual dos dois números era o
     -- verdadeiro.
     --
     -- Nulo = venda sem tabela (o balcão comum), e também toda venda anterior a
     -- esta rodada: ninguém sabe por qual condição elas saíram, e inventar zero
     -- ali seria afirmar algo que não foi medido.
     price_table_name        TEXT,
     price_table_percent_off REAL,
     created_at        TEXT NOT NULL,
     cancelled_at      TEXT,
     cancelled_by      TEXT,
     -- ------------------------------ o que a chave de idempotencia vendeu
     --
     -- A impressao digital da MERCADORIA do pedido que criou esta venda:
     -- prefixo v1 mais o SHA-256 do JSON canonico de itens (produto,
     -- quantidade, unidades), pecas ja baixadas da OS, linhas e valor do
     -- servico. Sem ordem, sem pagamento, sem gaveta. O reenvio com a mesma
     -- chave e outra mercadoria e recusado (422 CORE_IDEMPOTENCY_KEY_REUSED)
     -- em vez de devolver esta venda calado. Ver ImpressaoDigitalDaVenda.ts.
     --
     -- Nula = venda anterior a esta coluna: nao ha com o que comparar, e o
     -- reenvio segue a regra antiga (devolve a venda). Anulavel tambem porque
     -- o reconcile a acrescenta em banco antigo.
     idempotency_fingerprint TEXT,
     UNIQUE (company_id, idempotency_key),
     UNIQUE (company_id, number)
   );`,
  `CREATE INDEX IF NOT EXISTS ix_sales_company_date ON core_sales (company_id, created_at);`,

  // Orçamento e pré-venda ficam FORA de core_sales de propósito. Venda é fato
  // consumado: alimenta receita, caixa e estoque. Orçamento é intenção. Se os
  // dois morassem na mesma tabela, toda consulta de faturamento passaria a
  // depender de um filtro, e esquecer o filtro uma vez só já dá relatório
  // errado. Aqui é impossível confundir.
  `CREATE TABLE IF NOT EXISTS core_quotes (
     id                TEXT PRIMARY KEY,
     company_id        TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     number            INTEGER NOT NULL,
     -- 'orcamento' não segura estoque; 'pre_venda' segura.
     kind              TEXT NOT NULL DEFAULT 'orcamento',
     status            TEXT NOT NULL DEFAULT 'aberto',
     customer_id       TEXT REFERENCES core_customers(id),
     seller_id         TEXT,
     valid_until       TEXT,
     discount_cents    INTEGER NOT NULL DEFAULT 0,
     total_cents       INTEGER NOT NULL DEFAULT 0,
     note              TEXT,
     -- Preenchido na conversão. É ele que impede converter duas vezes.
     converted_sale_id TEXT REFERENCES core_sales(id),
     converted_at      TEXT,
     -- QUANTO A LOJA ABRIU MÃO QUANDO ESTE DOCUMENTO FOI ESCRITO.
     --
     -- É aqui que a alçada passa a morar para o orçamento e a pré-venda. O
     -- preço rebaixado é DIGITADO na criação do documento — que é onde não há
     -- cliente esperando no caixa — e conferido ali. Na conversão, o que vale
     -- é este número: se a concessão de hoje não passou dele, ninguém precisa
     -- ser chamado de novo. Sem guardá-lo, a conversão só teria duas saídas
     -- ruins: pedir gestor toda vez que o preço de tabela mudasse, ou não
     -- conferir nada (que era o contorno).
     --
     -- Nulo = documento anterior a esta rodada: a concessão dele nunca foi
     -- medida, e a conversão o trata como não conferido em vez de fingir zero.
     concession_cents       INTEGER,
     concession_gross_cents INTEGER,
     -- A liberação de gestor que cobriu a concessão deste documento, quando
     -- houve. É por ela que a conferência de caixa liga o desconto ao nome.
     authorization_id       TEXT,
     -- QUEM ASSINOU O PREÇO ABAIXO DO PISO (auditoria da Preço Justo,
     -- A-produto-17). O gerente que escreve a pré-venda abaixo do piso tem
     -- alçada e não gasta liberação — sem guardar a assinatura, o caixa que
     -- converte seria barrado pedindo de novo o que o gerente já decidiu. Nulo =
     -- nenhuma linha abaixo do piso, ou documento escrito por quem não tem alçada.
     floor_authorized_by    TEXT,
     -- ------------------ a condição comercial sob a qual ESTE papel foi escrito
     --
     -- O orçamento é aprovado hoje e convertido semanas depois. Sem guardar a
     -- condição, a conversão precificaria pela tabela COMO ELA ESTÁ NO DIA DA
     -- CONVERSÃO: o cliente aprovou um número e paga outro, e quem assinou o
     -- papel tem razão na discussão.
     --
     -- Aqui vai o ID junto com o percentual, e é a diferença deliberada em
     -- relação a core_sales: o documento ainda VAI virar venda, e a conversão
     -- precisa saber de qual tabela ele falava para explicar a diferença quando
     -- ela existir. A venda, essa já aconteceu — para ela só a fotografia
     -- importa.
     price_table_id         TEXT REFERENCES core_price_tables(id),
     price_table_percent_off REAL,
     created_by        TEXT,
     created_at        TEXT NOT NULL,
     updated_at        TEXT NOT NULL,
     -- Numeração é por TIPO: existe o orçamento nº 1 e a pré-venda nº 1, e são
     -- documentos diferentes. É assim que o balcão fala ("orçamento 47").
     UNIQUE (company_id, kind, number)
   );`,

  `CREATE TABLE IF NOT EXISTS core_quote_items (
     id               TEXT PRIMARY KEY,
     quote_id         TEXT NOT NULL REFERENCES core_quotes(id) ON DELETE CASCADE,
     company_id       TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     product_id       TEXT REFERENCES core_products(id),
     description      TEXT NOT NULL,
     quantity         REAL NOT NULL CHECK (quantity > 0),
     unit_price_cents INTEGER NOT NULL,
     total_cents      INTEGER NOT NULL,
     -- DE ONDE VEIO O PREÇO DESTA LINHA QUANDO O DOCUMENTO FOI ESCRITO
     -- (auditoria da Preço Justo, A-produto-R01). A promoção, a tabela do
     -- cliente e a faixa por quantidade são preço da GESTÃO, e o piso as aceita
     -- sem liberação; se elas acabam antes da conversão, é por esta coluna que a
     -- recusa diz que a promoção acabou, em vez de culpar o documento. Valores:
     -- a fonte do preço vigente ('cadastro', 'promocao', 'tabela', 'faixa',
     -- 'aberto') quando a linha foi escrita por ele, 'digitado' quando alguém
     -- escreveu outro preço. Nulo = linha anterior a esta coluna.
     price_source     TEXT
   );`,

  'CREATE INDEX IF NOT EXISTS ix_quote_items_quote ON core_quote_items (quote_id);',
  'CREATE INDEX IF NOT EXISTS ix_quotes_company ON core_quotes (company_id, status, created_at);',

  // A MOTO SEGURADA PARA O CLIENTE DO SINAL (GAP-PRD-111).
  //
  // `core_stock.reserved` segura QUANTIDADE: "uma Honda CG 160 está prometida".
  // A concessionária promete AQUELA moto — a vermelha, o chassi que o cliente
  // viu no pátio. Esta tabela diz qual unidade a pré-venda segura.
  //
  // Tabela própria, e não um status novo na unidade: a unidade continua
  // `in_stock` (ela ESTÁ na prateleira), e a reserva só vale enquanto o
  // documento dela estiver aberto e dentro da validade — quem lê junta com
  // `core_quotes`, então pré-venda vencida solta a moto sem varredura nenhuma.
  // `unit_id` é único: uma moto, um documento.
  `CREATE TABLE IF NOT EXISTS core_product_unit_holds (
     id             TEXT PRIMARY KEY,
     company_id     TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     unit_id        TEXT NOT NULL REFERENCES core_product_units(id) ON DELETE CASCADE,
     product_id     TEXT NOT NULL,
     -- 'pre_venda' + o id do documento. O tipo existe para a próxima origem.
     reference_type TEXT NOT NULL DEFAULT 'pre_venda',
     reference_id   TEXT NOT NULL,
     created_by     TEXT,
     created_at     TEXT NOT NULL
   );`,
  'CREATE UNIQUE INDEX IF NOT EXISTS ux_product_unit_holds_unit ON core_product_unit_holds (unit_id);',
  `CREATE INDEX IF NOT EXISTS ix_product_unit_holds_reference
     ON core_product_unit_holds (company_id, reference_type, reference_id);`,

  // ================================================================
  // CONSIGNAÇÃO / CONDICIONAL (GAP-V65)
  // ================================================================
  //
  // A mercadoria SAI DA LOJA sem venda, volta em parte e é faturada em parte.
  // Gringa e Me Mimei mandam roupa no condicional todo dia; PJ Motors manda
  // peça para o mecânico testar. Não havia NADA disso no sistema, e os dois
  // contornos disponíveis mentiam sobre o estoque: a pré-venda diz que a peça
  // continua na prateleira (ela reserva, não retira) e não aceita retorno
  // parcial; o caderno não diz nada a ninguém.
  //
  // ---------------------------------------------------------------
  // POR QUE ISTO NÃO É UMA RESERVA DE LONGO PRAZO
  // ---------------------------------------------------------------
  //
  // Nesta casa, core_stock.reserved significa "está aqui, prometida a alguém":
  // é o que a pré-venda faz, o que a peça prometida a uma OS faz e o que a
  // vitrine faz — e nos tres casos a mercadoria está dentro da loja. Consignada,
  // ela NÃO está: está na casa da cliente.
  //
  // Modelar com reserva deixaria quantity contando peças que não estão na
  // prateleira, e a contagem de inventário acusaria falta todo mês nas mesmas
  // tres empresas — que é exatamente o estrago que este gap descreve. Por isso
  // a remessa é uma SAÍDA de verdade (o razão registra CONSIGNMENT_OUT) e o
  // saldo cai. Quem conta a prateleira encontra o que o sistema diz.
  //
  // O que está com o cliente vive AQUI, e é o que estas tres tabelas
  // respondem: quanto saiu, quanto voltou, quanto virou venda — e o que sobra
  // é a custódia de terceiros, que não é estoque da loja.
  //
  // ---------------------------------------------------------------
  // O FATURAMENTO PASSA PELO RETORNO SIMBÓLICO
  // ---------------------------------------------------------------
  //
  // Quando parte vira venda, a peça já saiu: a venda não pode baixar de novo.
  // O par gravado é RETORNO SIMBÓLICO (+) e VENDA (−), na mesma transação — que
  // é a operação fiscal brasileira da consignação, não um truque de saldo. O
  // razão passa a falar a língua do contador.
  `CREATE TABLE IF NOT EXISTS core_consignments (
     id                TEXT PRIMARY KEY,
     company_id        TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     number            INTEGER NOT NULL,
     -- OBRIGATÓRIO, ao contrário do orçamento: mercadoria que sai da loja sem
     -- venda precisa ter dono conhecido, senão ninguém sabe de quem cobrar nem
     -- para onde ligar quando o prazo vencer.
     customer_id       TEXT NOT NULL REFERENCES core_customers(id),
     seller_id         TEXT,
     -- 'aberta' enquanto houver mercadoria com o cliente; 'fechada' quando
     -- tudo voltou ou virou venda. Não existe 'cancelada': consignação não se
     -- cancela, ela se resolve — o que saiu volta ou é faturado.
     status            TEXT NOT NULL DEFAULT 'aberta',
     -- Até quando foi combinado devolver. Não expira sozinha: expirar
     -- devolveria ao saldo mercadoria que continua na casa do cliente, que é a
     -- mentira que este módulo existe para não contar. Serve para a tela
     -- cobrar.
     valid_until       TEXT,
     note              TEXT,
     created_by        TEXT,
     created_at        TEXT NOT NULL,
     updated_at        TEXT NOT NULL,
     closed_at         TEXT,
     UNIQUE (company_id, number)
   );`,

  `CREATE TABLE IF NOT EXISTS core_consignment_items (
     id               TEXT PRIMARY KEY,
     consignment_id   TEXT NOT NULL REFERENCES core_consignments(id) ON DELETE CASCADE,
     company_id       TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     product_id       TEXT NOT NULL REFERENCES core_products(id),
     description      TEXT NOT NULL,
     delivered_qty    REAL NOT NULL CHECK (delivered_qty > 0),
     returned_qty     REAL NOT NULL DEFAULT 0 CHECK (returned_qty >= 0),
     sold_qty         REAL NOT NULL DEFAULT 0 CHECK (sold_qty >= 0),
     -- O preço VIGENTE no dia da entrega, resolvido pelo SERVIDOR (com a
     -- tabela do cliente e a promoção do dia) e congelado aqui. A cliente
     -- levou o vestido por R$ 200 e paga R$ 200 — não R$ 240 porque a tabela
     -- subiu enquanto a peça estava no armário dela. É o mesmo congelamento do
     -- orçamento, pelo mesmo motivo.
     --
     -- E é por ele NÃO vir de tela nenhuma que a consignação não abre a porta
     -- dos fundos que o cabeçalho de convertQuote descreve: não existe campo de
     -- preço na remessa nem no faturamento, então não há concessão digitada
     -- para a alçada deixar passar. O desconto continua onde tem alçada: no
     -- balcão.
     unit_price_cents INTEGER NOT NULL,
     -- O INVARIANTE NO BANCO, e não na disciplina do código: não volta nem se
     -- vende mais do que saiu. É o CHECK que impede o retorno em dobro de
     -- inventar saldo do nada.
     CHECK (returned_qty + sold_qty <= delivered_qty),
     UNIQUE (consignment_id, product_id)
   );`,

  // A RAZÃO DA CUSTÓDIA: cada remessa, retorno, faturamento e fechamento vira
  // uma linha. Sem ela, "voltaram 2" seria um número sem data, sem autor e sem
  // como conferir contra o razão de estoque.
  //
  // `idempotency_key` é o que impede o clique duplo de devolver a mesma peça
  // duas vezes — o CHECK acima recusaria só quando estourasse o total, e um
  // retorno parcial repetido passaria caladinho por baixo dele. Nula nas
  // remessas e nos fechamentos, que já são únicos por construção; no SQLite,
  // NULL não colide com NULL numa UNIQUE.
  `CREATE TABLE IF NOT EXISTS core_consignment_events (
     id              TEXT PRIMARY KEY,
     consignment_id  TEXT NOT NULL REFERENCES core_consignments(id) ON DELETE CASCADE,
     company_id      TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     kind            TEXT NOT NULL,
     sale_id         TEXT REFERENCES core_sales(id),
     idempotency_key TEXT,
     detail          TEXT,
     user_id         TEXT,
     created_at      TEXT NOT NULL,
     -- O QUE A CHAVE PEDIU (RES-IDEM-VIZ): v1 + SHA-256 do tipo do evento, da
     -- consignacao, dos itens e (no faturamento) dos pagamentos. A mesma chave
     -- com outro pedido e recusada (422 CORE_IDEMPOTENCY_KEY_REUSED) em vez de
     -- devolver este evento calado. Nula = evento anterior a coluna.
     idempotency_fingerprint TEXT,
     UNIQUE (company_id, idempotency_key)
   );`,

  'CREATE INDEX IF NOT EXISTS ix_consignments_company ON core_consignments (company_id, status, created_at);',
  'CREATE INDEX IF NOT EXISTS ix_consignment_items_doc ON core_consignment_items (consignment_id);',
  'CREATE INDEX IF NOT EXISTS ix_consignment_events_doc ON core_consignment_events (consignment_id, created_at);',

  `CREATE TABLE IF NOT EXISTS core_sale_items (
     id              TEXT PRIMARY KEY,
     sale_id         TEXT NOT NULL REFERENCES core_sales(id) ON DELETE CASCADE,
     company_id      TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     -- NULL para linha de serviço (mão de obra de OS), que não tem produto
     -- de catálogo e não movimenta estoque.
     product_id      TEXT REFERENCES core_products(id),
     description     TEXT NOT NULL,
     quantity        REAL NOT NULL CHECK (quantity > 0),
     unit_price_cents INTEGER NOT NULL,
     discount_cents  INTEGER NOT NULL DEFAULT 0,
     total_cents     INTEGER NOT NULL,
     -- O CUSTO FOTOGRAFADO NA HORA DA VENDA — GAP-V28.
     --
     -- É o custo UNITÁRIO, o mesmo significado de core_products.cost_cents,
     -- de onde ele é copiado no momento do fechamento. Sem esta coluna o DRE
     -- não tinha de onde tirar o CMV: o custo do cadastro muda a cada nota de
     -- entrada, e calcular a margem de março com o custo de agosto faria todo
     -- mês fechado mudar de resultado sozinho.
     --
     -- NULLABLE de propósito, e o nulo tem DOIS significados legítimos, que
     -- ficam separados por quem lê: venda anterior a esta rodada (o passado
     -- não tem conserto — inventar custo retroativo seria escrever ficção) e
     -- linha de SERVIÇO, que não sai de prateleira nenhuma e nunca terá custo
     -- de mercadoria. Zero é diferente das duas: é "vendido com o cadastro
     -- sem custo", e também fica fora do CMV — custo zero devolveria 100% de
     -- margem, que é o número bonito e falso que este projeto já recusou em
     -- marginWhereReliable.
     cost_cents      INTEGER,
     -- A PROMOÇÃO QUE DEU O PREÇO DESTA LINHA (GAP-PRD-194), quando foi ela.
     -- É o que conta o saldo da promoção com teto de unidades
     -- (core_promotions.max_units) nos dois canais. Nula = linha que não saiu
     -- pela promoção, ou venda anterior à regra. Sem REFERENCES de propósito:
     -- coluna acrescentada por ALTER não ganha FK, e a DDL fica igual nos dois
     -- caminhos.
     promotion_id    TEXT
   );`,
  `CREATE INDEX IF NOT EXISTS ix_sale_items_sale ON core_sale_items (sale_id);`,

  // DEVOLUÇÃO — a venda aconteceu, e continua tendo acontecido.
  //
  // Não confundir com cancelamento. Cancelar é desfazer: a venda passa a não
  // valer, e é o que se faz no mesmo dia, antes de o dinheiro assentar.
  // Devolver é outro fato, posterior: o cliente comprou, levou, e voltou com
  // parte da mercadoria. A venda permanece inteira no histórico -- ela está no
  // fechamento do mês, na comissão paga e, quando houver, na nota fiscal
  // emitida. Reescrevê-la faria o passado mudar de forma.
  //
  // Por isso a devolução é registro NOVO, que aponta para a venda, e nunca uma
  // alteração dela.
  `CREATE TABLE IF NOT EXISTS core_sale_returns (
     id            TEXT PRIMARY KEY,
     company_id    TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     number        INTEGER NOT NULL,
     sale_id       TEXT NOT NULL REFERENCES core_sales(id),
     reason        TEXT NOT NULL,
     total_cents   INTEGER NOT NULL DEFAULT 0,
     -- dinheiro | credito | estorno_cartao | pix — como o dinheiro voltou.
     -- 'em_etapas' na devolução em duas etapas: o dinheiro volta pelos
     -- registros de core_sale_return_refunds, um ou mais, cada um no seu meio.
     refund_method TEXT NOT NULL DEFAULT 'dinheiro',
     cash_session_id TEXT REFERENCES core_cash_sessions(id),
     created_by    TEXT,
     created_at    TEXT NOT NULL,
     -- 'duas_etapas' quando o reembolso é registrado à parte; nulo = imediato.
     refund_flow   TEXT,
     -- O motivo em lista (defeito, produto_incorreto, desistencia, troca,
     -- outro) e a observação — "outro" exige observação. A coluna reason
     -- continua sendo a frase inteira, que é o que os relatórios já leem.
     reason_code   TEXT,
     reason_note   TEXT,
     -- Quem APROVOU: o gestor da liberação, ou o próprio gestor que registrou.
     approved_by   TEXT,
     UNIQUE (company_id, number)
   );`,
  `CREATE INDEX IF NOT EXISTS ix_sale_returns_sale ON core_sale_returns (sale_id);`,

  // A DEVOLUÇÃO NÃO SE REPETE PELO REENVIO (E-venda-servidor-09). `POST
  // /sale-returns` não tinha chave de idempotência: a resposta perdida depois de
  // o servidor gravar virava, no reenvio, uma SEGUNDA devolução — e mais dinheiro
  // saindo da gaveta. A chave do pedido aponta para a devolução que ela criou, e a
  // impressão digital do corpo recusa a mesma chave com outro conteúdo.
  `CREATE TABLE IF NOT EXISTS core_sale_return_requests (
     company_id      TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     idempotency_key TEXT NOT NULL,
     return_id       TEXT NOT NULL REFERENCES core_sale_returns(id) ON DELETE CASCADE,
     fingerprint     TEXT NOT NULL,
     created_at      TEXT NOT NULL,
     PRIMARY KEY (company_id, idempotency_key)
   );`,

  // O REEMBOLSO DA DEVOLUÇÃO EM DUAS ETAPAS — o que de fato voltou ao cliente.
  //
  // A devolução diz o que a loja DEVE ao cliente (total_cents); cada linha
  // daqui diz o que foi PAGO, em qual meio, por quem e quando. Dinheiro sai da
  // gaveta (movimento vinculado, que baixa o esperado do fechamento); PIX e
  // estorno no cartão são confirmação de algo feito FORA do sistema — nada
  // aqui finge integração bancária nem TEF. A soma nunca passa da devolução,
  // e a chave do pedido impede o mesmo reembolso duas vezes. Reembolso não
  // mexe em estoque: a mercadoria já foi tratada na devolução.
  `CREATE TABLE IF NOT EXISTS core_sale_return_refunds (
     id                   TEXT PRIMARY KEY,
     company_id           TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     return_id            TEXT NOT NULL REFERENCES core_sale_returns(id) ON DELETE CASCADE,
     sale_id              TEXT NOT NULL REFERENCES core_sales(id),
     -- dinheiro | pix | debito | credito | vale
     method               TEXT NOT NULL,
     amount_cents         INTEGER NOT NULL CHECK (amount_cents > 0),
     -- Como a venda foi paga, quando o meio do reembolso é outro — e o porquê.
     original_method      TEXT,
     method_justification TEXT,
     -- NSU, id do PIX, número do comprovante — opcional.
     reference            TEXT,
     note                 TEXT,
     cash_session_id      TEXT REFERENCES core_cash_sessions(id),
     finance_entry_id     TEXT REFERENCES core_finance_entries(id),
     idempotency_key      TEXT NOT NULL,
     fingerprint          TEXT NOT NULL,
     created_by           TEXT NOT NULL,
     created_at           TEXT NOT NULL,
     UNIQUE (company_id, idempotency_key)
   );`,
  `CREATE INDEX IF NOT EXISTS ix_sale_return_refunds_return
     ON core_sale_return_refunds (return_id);`,
  `CREATE INDEX IF NOT EXISTS ix_sale_return_refunds_sale
     ON core_sale_return_refunds (sale_id);`,

  `CREATE TABLE IF NOT EXISTS core_sale_return_items (
     id               TEXT PRIMARY KEY,
     return_id        TEXT NOT NULL REFERENCES core_sale_returns(id) ON DELETE CASCADE,
     company_id       TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     sale_item_id     TEXT NOT NULL REFERENCES core_sale_items(id),
     product_id       TEXT REFERENCES core_products(id),
     quantity         REAL NOT NULL CHECK (quantity > 0),
     -- Preço PRATICADO na venda, não o do cadastro hoje. Devolver pelo preço
     -- atual pagaria a mais depois de um aumento e a menos depois de uma
     -- promoção — nos dois casos com dinheiro real.
     unit_price_cents INTEGER NOT NULL,
     total_cents      INTEGER NOT NULL,
     -- Mercadoria com defeito NÃO volta para o estoque vendável. Somar peça
     -- quebrada ao saldo cria estoque que não existe, e a falta só aparece
     -- quando alguém for vender e não achar.
     restock          INTEGER NOT NULL DEFAULT 1,
     created_at       TEXT NOT NULL,
     -- A condição em que a mercadoria voltou: intacto | defeituoso | quebrado |
     -- avariado | improprio. Só o intacto pode voltar ao estoque disponível.
     item_condition   TEXT
   );`,

  `CREATE TABLE IF NOT EXISTS core_sale_payments (
     id             TEXT PRIMARY KEY,
     sale_id        TEXT NOT NULL REFERENCES core_sales(id) ON DELETE CASCADE,
     company_id     TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     method         TEXT NOT NULL,
     amount_cents   INTEGER NOT NULL,
     status         TEXT NOT NULL DEFAULT 'settled',
     provider       TEXT,
     provider_ref   TEXT,
     created_at     TEXT NOT NULL,
     -- PIX do balcão via Asaas (GAP-PRD-077): a cobrança que esta linha
     -- espera (ou que a liquidou), e QUANDO a linha pendente foi liquidada.
     -- É por ela que o webhook acha a linha, e é a data em que a conciliação
     -- a conta. Nulas nas linhas que não passam pelo provedor de cobrança.
     payment_intent_id TEXT,
     settled_at     TEXT
   );`,

  // RASTRO DO ITEM CANCELADO NO CARRINHO — prevenção de perda do balcão.
  //
  // O rodapé do PDV dizia "Itens cancelados: 0" com um literal fixo: bipar,
  // mostrar o total ao cliente, remover a linha e fechar por menos não deixava
  // registro em lugar NENHUM. Cada linha aqui é um retrato do que saiu do
  // carrinho antes do Finalizar: o produto, a quantidade, o preço que estava
  // valendo, quem operava e a hora — congelados, como os itens da venda.
  //
  // product_id é NULLABLE de propósito: o rastro é trilha, não razão. Produto
  // apagado depois (ou um id que não é desta empresa) não pode derrubar nem
  // sujar o vínculo — o retrato em texto é o que a auditoria lê.
  //
  // Venda ABANDONADA sem finalizar não chega aqui, e é decisão documentada: o
  // carrinho vive na tela, e o servidor só fica sabendo da venda no Finalizar.
  `CREATE TABLE IF NOT EXISTS core_sale_removed_items (
     id               TEXT PRIMARY KEY,
     sale_id          TEXT NOT NULL REFERENCES core_sales(id) ON DELETE CASCADE,
     company_id       TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     product_id       TEXT REFERENCES core_products(id),
     name             TEXT NOT NULL,
     quantity         REAL NOT NULL CHECK (quantity > 0),
     unit_price_cents INTEGER NOT NULL DEFAULT 0,
     removed_by       TEXT,
     removed_at       TEXT NOT NULL,
     reason           TEXT,
     created_at       TEXT NOT NULL
   );`,
  `CREATE INDEX IF NOT EXISTS ix_sale_removed_items_sale
     ON core_sale_removed_items (sale_id);`,

  // --------------------------------------------------------------- financeiro
  //
  // PLANO DE CONTAS — para que serve o dinheiro.
  //
  // Árvore rasa de propósito: um nível de pai e um de filho. Plano de contas
  // profundo é o que faz o lojista desistir de classificar, e categoria não
  // preenchida vale menos que categoria nenhuma — dá a impressão de relatório
  // sem o conteúdo dele.
  `CREATE TABLE IF NOT EXISTS core_finance_categories (
     id          TEXT PRIMARY KEY,
     company_id  TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     -- 'in' | 'out': categoria de receita não aparece em conta a pagar. Sem
     -- isto a lista de escolha vira um paiol de opções erradas.
     direction   TEXT NOT NULL,
     name        TEXT NOT NULL,
     parent_id   TEXT REFERENCES core_finance_categories(id) ON DELETE CASCADE,
     -- Categoria de sistema não se apaga: é a que os lançamentos automáticos
     -- usam, e apagá-la deixaria venda sem classificação.
     system_code TEXT,
     active      INTEGER NOT NULL DEFAULT 1,
     created_at  TEXT NOT NULL,
     updated_at  TEXT NOT NULL,
     CHECK (direction IN ('in', 'out'))
   );`,
  // A unicidade do nome usa COALESCE, e não uma UNIQUE de tabela.
  //
  // No SQLite vários NULL NÃO colidem em índice único. Com `parent_id` na
  // chave e nulo nas categorias principais, duas categorias de mesmo nome
  // conviveriam alegremente — que é a mesma armadilha documentada em
  // `installment_number` do lançamento. O COALESCE dá ao nulo um valor
  // concreto e a regra passa a valer para a raiz também.
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_finance_categories_name
     ON core_finance_categories (company_id, direction, name, COALESCE(parent_id, ''));`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_finance_categories_system
     ON core_finance_categories (company_id, system_code) WHERE system_code IS NOT NULL;`,

  // CENTRO DE CUSTO — de qual operação saiu.
  //
  // Por EMPRESA, e não por grupo: o rateio entre PJ Motors e Preço Justo já é
  // feito pelo `company_id`, e um centro compartilhado entre empresas faria o
  // relatório de uma somar despesa da outra.
  `CREATE TABLE IF NOT EXISTS core_cost_centers (
     id          TEXT PRIMARY KEY,
     company_id  TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     code        TEXT NOT NULL,
     name        TEXT NOT NULL,
     active      INTEGER NOT NULL DEFAULT 1,
     created_at  TEXT NOT NULL,
     updated_at  TEXT NOT NULL,
     UNIQUE (company_id, code)
   );`,

  // ONDE O DINHEIRO ESTÁ — conta bancária, caixinha, carteira digital.
  //
  // O caixa do PDV NÃO vira uma conta aqui. Ele já tem tabela própria
  // (`core_cash_sessions`), abre e fecha por turno e é conferido por sangria e
  // suprimento. Modelá-lo como conta criaria dois donos do mesmo saldo, que é
  // exatamente o erro que as rodadas 6 e 8 recusaram. O que existe é o
  // caminho de mão dupla: a sangria do caixa VIRA um lançamento com
  // `account_id` do cofre ou do banco.
  `CREATE TABLE IF NOT EXISTS core_finance_accounts (
     id            TEXT PRIMARY KEY,
     company_id    TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     name          TEXT NOT NULL,
     -- banco | caixinha | carteira
     kind          TEXT NOT NULL DEFAULT 'banco',
     bank_code     TEXT,
     agency        TEXT,
     account_number TEXT,
     -- Saldo de PARTIDA, do dia em que a conta entrou no sistema. O saldo
     -- corrente é este mais os lançamentos quitados — derivado, nunca gravado,
     -- pelo mesmo motivo do saldo por local na rodada 6.
     opening_balance_cents INTEGER NOT NULL DEFAULT 0,
     opening_date  TEXT,
     is_default    INTEGER NOT NULL DEFAULT 0,
     active        INTEGER NOT NULL DEFAULT 1,
     created_at    TEXT NOT NULL,
     updated_at    TEXT NOT NULL,
     UNIQUE (company_id, name),
     CHECK (kind IN ('banco', 'caixinha', 'carteira'))
   );`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_finance_accounts_default
     ON core_finance_accounts (company_id) WHERE is_default = 1;`,

  // UM fato econômico por origem. Vendas, caixa, Asaas e fiscal REFERENCIAM
  // este lançamento — não criam receita própria (item 26 da especificação).
  //
  // ## A tabela abre UMA VEZ
  //
  // Uma auditoria deste plano descobriu que esta tabela aparecia em QUATRO
  // rodadas diferentes, cada uma orçando a reconstrução como se fosse dona
  // única — o projeto pagaria o turno de maior risco quatro vezes. Por isso as
  // colunas de TODO o financeiro entram aqui de uma vez, mesmo as que ainda
  // não têm consumidor: crediário, comissão, prazos de recebimento, DRE.
  //
  // ## Por que parcela é LINHA IRMÃ, e não tabela filha
  //
  // A parcela do carnê é um lançamento com vencimento próprio, valor próprio e
  // baixa própria — ou seja, é exatamente um lançamento. Pô-la numa tabela
  // filha criaria um terceiro nível (lançamento → parcela → baixa), obrigaria
  // `settleEntry` a mudar de sujeito, faria a conciliação bancária e a do Asaas
  // atravessarem mais um join, e criaria a invariante "soma das parcelas é
  // igual ao total do pai" para alguém policiar.
  //
  // Como linha irmã, no dia em que o crediário entrar, a tela de contas, o
  // filtro de vencimento, a baixa parcial, o estorno e as duas conciliações já
  // funcionam sobre parcela sem uma linha de código nova.
  //
  // `installment_number` é NOT NULL DEFAULT 1 de propósito: no SQLite vários
  // NULL não colidem em índice único, e um nulo aqui devolveria a duplicidade
  // de receita pela porta dos fundos — que é justamente o que esta UNIQUE
  // existe para impedir.
  `CREATE TABLE IF NOT EXISTS core_finance_entries (
     id             TEXT PRIMARY KEY,
     company_id     TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     direction      TEXT NOT NULL,
     amount_cents   INTEGER NOT NULL,
     status         TEXT NOT NULL DEFAULT 'open',
     due_date       TEXT,
     settled_at     TEXT,
     settled_cents  INTEGER NOT NULL DEFAULT 0,
     customer_id    TEXT REFERENCES core_customers(id),
     -- Contraparte do que se PAGA. A coluna customer_id responde pelo que se
     -- recebe e não diz nada sobre a conta a pagar.
     supplier_id    TEXT REFERENCES core_suppliers(id),
     description    TEXT NOT NULL,
     origin_type    TEXT NOT NULL,
     origin_id      TEXT NOT NULL,
     -- Classificação. Nulo é permitido: exigir categoria quebraria os cinco
     -- pontos que já inserem sem ela, e um lançamento sem categoria é melhor
     -- que uma venda recusada no balcão.
     category_id    TEXT REFERENCES core_finance_categories(id),
     cost_center_id TEXT REFERENCES core_cost_centers(id),
     -- Em que conta o dinheiro caiu ou saiu. Nulo até alguém dizer.
     account_id     TEXT REFERENCES core_finance_accounts(id),
     -- Parcela. Sem crediário, todo lançamento é 1 de 1.
     installment_number INTEGER NOT NULL DEFAULT 1,
     installment_total  INTEGER NOT NULL DEFAULT 1,
     -- DECLARADAS E AINDA SEM CONSUMIDOR — entram agora para a tabela não
     -- precisar reabrir nas rodadas de crediário, comissão e prazos.
     payment_method TEXT,
     document_number TEXT,
     -- Juros e multa de atraso, desconto de antecipação. Somam à baixa, não ao
     -- valor original: o que se devia continua sendo o que se devia.
     interest_cents INTEGER NOT NULL DEFAULT 0,
     fine_cents     INTEGER NOT NULL DEFAULT 0,
     discount_cents INTEGER NOT NULL DEFAULT 0,
     -- Data de COMPETÊNCIA, diferente do vencimento e do pagamento. É por ela
     -- que o DRE separa o mês; sem ela, aluguel pago com atraso vira despesa
     -- do mês errado.
     competence_date TEXT,
     -- QUANDO O FATO FOI CANCELADO — e por que não basta a coluna status.
     --
     -- O status é DERIVADO: aplicarStatus o recalcula a partir do saldo a
     -- cada baixa e a cada estorno. Dar baixa num lançamento cancelado
     -- devolvia o status para 'open' ou 'settled', e a receita de uma venda
     -- cancelada voltava para o relatório sem ninguém descancelar nada.
     -- Carimbo de data não se recalcula: quem cancelou, cancelou. É por ele
     -- que o DRE decide o que entra.
     cancelled_at   TEXT,
     note           TEXT,
     created_at     TEXT NOT NULL,
     -- A parcela entra na chave. Sem ela, a segunda parcela da mesma venda
     -- colidiria com a primeira e sumiria em silêncio pelo ON CONFLICT.
     UNIQUE (origin_type, origin_id, direction, installment_number),
     -- Esta tabela não tinha NENHUM CHECK, enquanto o resto do schema usa
     -- dezessete. Sem eles, nada impedia um lançamento com direção inventada,
     -- valor negativo ou status que nenhuma tela sabe ler.
     CHECK (direction IN ('in', 'out')),
     CHECK (status IN ('open', 'settled', 'cancelled')),
     CHECK (amount_cents >= 0),
     CHECK (settled_cents >= 0),
     CHECK (installment_number >= 1),
     CHECK (installment_total >= 1),
     CHECK (installment_number <= installment_total)
   );`,
  `CREATE INDEX IF NOT EXISTS ix_finance_company
     ON core_finance_entries (company_id, status, due_date);`,

  // EXTRATO BANCÁRIO — o que o banco diz que aconteceu.
  //
  // É a terceira verdade sobre o mesmo dinheiro: a venda diz que recebeu, o
  // financeiro diz que baixou, e o banco diz o que caiu na conta. Enquanto as
  // três não se olham, a diferença só aparece quando alguém confere o saldo no
  // fim do mês e não bate — sem saber de qual dia veio.
  //
  // A linha guarda `external_id` (o FITID do OFX, quando houver) porque
  // importar o mesmo extrato duas vezes é o caso NORMAL: quem concilia baixa o
  // arquivo de novo para pegar os últimos dias.
  `CREATE TABLE IF NOT EXISTS core_bank_statements (
     id            TEXT PRIMARY KEY,
     company_id    TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     account_label TEXT NOT NULL,
     period_start  TEXT,
     period_end    TEXT,
     source_name   TEXT,
     imported_by   TEXT,
     created_at    TEXT NOT NULL
   );`,

  `CREATE TABLE IF NOT EXISTS core_bank_statement_lines (
     id           TEXT PRIMARY KEY,
     statement_id TEXT NOT NULL REFERENCES core_bank_statements(id) ON DELETE CASCADE,
     company_id   TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     occurred_at  TEXT NOT NULL,
     description  TEXT NOT NULL,
     -- Com sinal: positivo entrou, negativo saiu. Guardar o sinal separado do
     -- valor faria toda consulta ter de lembrar de aplicá-lo.
     amount_cents INTEGER NOT NULL,
     document     TEXT,
     external_id  TEXT,
     -- Baixa do financeiro que esta linha representa, quando alguém casou as
     -- duas. Nulo é o estado normal de quem ainda não foi conferido.
     matched_settlement_id TEXT REFERENCES core_finance_settlements(id),
     matched_at   TEXT,
     matched_by   TEXT,
     created_at   TEXT NOT NULL,
     UNIQUE (company_id, external_id)
   );`,
  `CREATE INDEX IF NOT EXISTS ix_bank_lines_company
     ON core_bank_statement_lines (company_id, occurred_at);`,

  `CREATE TABLE IF NOT EXISTS core_finance_settlements (
     id             TEXT PRIMARY KEY,
     entry_id       TEXT NOT NULL REFERENCES core_finance_entries(id) ON DELETE CASCADE,
     company_id     TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     amount_cents   INTEGER NOT NULL,
     method         TEXT,
     settled_at     TEXT NOT NULL,
     user_id        TEXT,
     note           TEXT,
     -- Estorno não apaga a baixa: marca a original e grava a contrapartida
     -- negativa apontando para ela. Apagar faria o extrato do mês fechar
     -- diferente do que fechou no dia.
     reversed_at    TEXT,
     reverses_id    TEXT
   );`,

  // O PEDIDO DE BAIXA JÁ ATENDIDO — a memória do Idempotency-Key (GAP-PRD-173).
  //
  // Dois POST /finance/entries/:id/settle iguais (clique duplo, rede lenta que
  // reenvia, dois caixas na mesma conta) viravam DUAS baixas parciais: o teto
  // do devido segura o total, mas não a repetição de uma parcial. Com a chave,
  // o segundo pedido devolve a baixa do primeiro em vez de gravar outra.
  //
  // A chave é da empresa (a PK) e grava o QUE foi pedido (título e valor):
  // a mesma chave reaproveitada para outro título ou outro valor é erro de
  // quem chamou, e a resposta diz isso em vez de devolver a baixa errada.
  `CREATE TABLE IF NOT EXISTS core_finance_settle_requests (
     company_id      TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     idempotency_key TEXT NOT NULL,
     entry_id        TEXT NOT NULL,
     amount_cents    INTEGER NOT NULL,
     settlement_id   TEXT NOT NULL,
     user_id         TEXT,
     created_at      TEXT NOT NULL,
     -- v1 + SHA-256 de titulo, valor e forma (RES-IDEM-VIZ). Nula = pedido
     -- anterior a coluna: vale a regra antiga (titulo e valor).
     idempotency_fingerprint TEXT,
     PRIMARY KEY (company_id, idempotency_key)
   );`,

  // ------------------------------------------------------- compras / entradas
  // O fornecedor nascia como efeito da importação de XML, com nome e documento
  // e nada mais — servia para a nota ter de quem veio, não para comprar.
  // Comprar exige saber em quantos dias ele entrega e em quantos se paga: sem
  // isso não há como planejar reposição nem prever o caixa.
  `CREATE TABLE IF NOT EXISTS core_suppliers (
     id          TEXT PRIMARY KEY,
     company_id  TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     -- Razão social. trade_name é o nome de fantasia; quando vazio, usa este.
     name        TEXT NOT NULL,
     trade_name  TEXT,
     document    TEXT,
     -- Inscrição estadual: é ela que decide se a compra gera crédito de ICMS.
     state_registration TEXT,
     email       TEXT,
     phone       TEXT,
     contact_name TEXT,
     zip         TEXT,
     street      TEXT,
     number      TEXT,
     complement  TEXT,
     district    TEXT,
     city        TEXT,
     state       TEXT,
     -- Código IBGE do município (GAP-PRD-181), vindo do <cMun> do XML do
     -- emitente. Só anda junto com a cidade dele: mudar a cidade o apaga.
     city_ibge   TEXT,
     -- Dias para pagar depois do recebimento. Alimenta o vencimento da dívida.
     payment_term_days INTEGER NOT NULL DEFAULT 0,
     -- Dias entre o pedido e a entrega. Alimenta a data prevista do pedido.
     delivery_days INTEGER NOT NULL DEFAULT 0,
     notes       TEXT,
     active      INTEGER NOT NULL DEFAULT 1,
     created_at  TEXT NOT NULL,
     updated_at  TEXT,
     UNIQUE (company_id, document)
   );`,

  // CONFIGURAÇÃO DA ENTRADA — o que a loja decide uma vez e vale para toda nota.
  //
  // Uma linha por empresa, no molde de `core_fiscal_configs`: a chave primária
  // é a própria empresa, sem id técnico, porque não existe "a segunda
  // configuração de entrada".
  //
  // ## Por que só um campo
  //
  // A rodada previa três: CFOP de venda, local de estoque padrão e tabela de
  // preço padrão. Os outros dois foram recusados por quebrarem em produção, e
  // a recusa fica escrita aqui para não ser refeita por engano:
  //
  // LOCAL PADRÃO. Só a ENTRADA passaria a gravar local. Toda SAÍDA — PDV, OS,
  // devolução, contagem — continua gravando nulo, e o `COALESCE` de
  // `balanceByLocation` joga essas saídas no local `is_default`. Receber 10 no
  // Depósito e vender 3 no balcão deixaria +10 num local e -3 no outro, e a
  // transferência passaria a oferecer peça já vendida. Enquanto a venda não
  // souber de onde a peça saiu, posição por local só fecha com TODO mundo
  // gravando nulo — que é como está hoje, e é coerente.
  //
  // TABELA DE PREÇO PADRÃO. O assistente de reprecificação avaliaria a margem
  // pelo preço da tabela e continuaria sugerindo e gravando o preço BASE
  // (`applyPrices` escreve `core_products.price_cents`). O alerta nasceria
  // impossível de zerar, e clicar em "Aplicar os preços" ABAIXARIA o preço de
  // prateleira. Ligar tabela de preço de verdade é entrar no cálculo da venda,
  // e isso não se faz numa rodada de entrada.
  `CREATE TABLE IF NOT EXISTS core_inbound_configs (
     company_id  TEXT PRIMARY KEY REFERENCES core_companies(id) ON DELETE CASCADE,
     -- O CFOP com que a LOJA VENDE, gravado no produto que a entrada cria.
     --
     -- Hoje o produto novo herda o CFOP do ITEM DA NOTA, que é o do
     -- fornecedor. Comprando de outro estado a nota traz 6102 (venda
     -- interestadual, na ótica dele), o produto herda, e a venda de balcão da
     -- loja sai com código de operação interestadual — FiscalXmlNfce lê
     -- p.cfop e o joga direto no XML.
     --
     -- Nulo mantém exatamente o comportamento de hoje. E o CFOP do ITEM da
     -- nota NUNCA é reescrito: aquele é o que o fornecedor declarou, e mexer
     -- nele seria falsificar o documento dele.
     default_sale_cfop TEXT,
     created_at  TEXT NOT NULL,
     updated_at  TEXT NOT NULL
   );`,

  // A POLÍTICA DO BALCÃO — o que o operador pode fazer sem chamar o dono.
  //
  // ## O critério de entrada desta tabela, e ele é estreito de propósito
  //
  // Só entra aqui a regra que satisfaz as QUATRO condições ao mesmo tempo:
  //   1. é decisão COMERCIAL do dono sobre o que o BALCÃO pode fazer sozinho
  //      (não é regra fiscal, nem de estoque, nem de layout de tela);
  //   2. o número dela hoje está CRAVADO no código, e o dono não alcança;
  //   3. tem LEITOR no servidor no mesmo commit em que a coluna nasce;
  //   4. número que BARRA só entra junto com o FLUXO de quem é chamado quando
  //      ele é ultrapassado.
  //
  // A quarta nasceu do teto de sangria e é a que segura a próxima pessoa. Teto
  // sem "quem libera" tem dois desfechos e os dois são ruins: ou é PAREDE — a
  // loja para, porque ninguém pode passar — ou é ENFEITE, porque o código não
  // lê. É por causa dela que a tolerância de diferença no fechamento de caixa
  // continua fora: recusar o FECHAMENTO deixaria a gaveta aberta às 22h sem
  // gerente ao alcance, e uma gaveta aberta é pior que uma diferença anotada.
  //
  // A terceira condição é a que mais dói e a que mais se esquece. Este projeto
  // já gravou payment_term_days do fornecedor, exibiu "30 dias" na tela, e
  // NUNCA leu o campo em lugar nenhum: toda dívida de compra nascia vencida no
  // dia, e o painel financeiro acusava atraso que não existia. Coluna com
  // escritor e sem leitor não é configuração — é uma mentira com formulário.
  //
  // ## Por que uma tabela tipada, e não core_settings(company_id, key, value)
  //
  // Chave/valor foi RECUSADO, e a recusa fica escrita para não ser refeita:
  //
  // O SILÊNCIO. Chave digitada errada vira configuração que ninguém lê. O
  // sintoma é o dono jurando que configurou 5% enquanto o balcão dá 10%, e não
  // há nada no sistema que contradiga nenhum dos dois.
  //
  // O TEXTO. O argumento de cada regra mora no comentário da coluna, como nas
  // outras quatro tabelas de configuração deste schema. Num par chave/valor
  // esse texto não tem onde morar, e a próxima pessoa reinventa a decisão.
  //
  // O TIPO. Com value TEXT, o leitor converte: Number('dez') é NaN, e
  // NaN > limite é false. Um erro de digitação do dono LIBERARIA o desconto em
  // vez de barrar. Trava que falha ABERTA é o pior modo de falha que existe, e
  // é o modo que chave/valor produz de graça.
  //
  // ## NULO SIGNIFICA "O COMPORTAMENTO DE HOJE"
  //
  // Nunca "sem valor", nunca "desligado". Empresa sem linha nesta tabela e
  // empresa com as três colunas nulas se comportam EXATAMENTE como o sistema
  // se comportava antes dela existir. É o que permite a tabela nascer sem
  // migrar dado nenhum e sem mudar o balcão de ninguém no dia da subida.
  `CREATE TABLE IF NOT EXISTS core_sale_policies (
     company_id             TEXT PRIMARY KEY REFERENCES core_companies(id) ON DELETE CASCADE,
     -- Até quantos por cento de CONCESSÃO o operador libera sozinho.
     --
     -- Concessão é tudo que a loja abriu mão em relação ao preço vigente:
     -- desconto de rodapé, desconto de linha e preço unitário rebaixado. Não é
     -- só o campo "desconto" — os três caminhos chegam no mesmo lugar, que é
     -- dinheiro que a loja deixou de receber.
     --
     -- Nulo = os 10% que OPERATOR_DISCOUNT_LIMIT_PERCENT cravava no código.
     -- REAL e não INTEGER porque meio ponto percentual é decisão real de
     -- margem: 2,5% num setor de giro alto não é o mesmo que 2% nem que 3%.
     discount_limit_percent REAL,
     -- Em quantos dias vence a venda FIADA (sem nenhum pagamento na hora).
     --
     -- Hoje o lançamento a receber nasce vencendo no MESMO dia da venda, o que
     -- faz a loja inteira aparecer em atraso no dia seguinte à primeira venda a
     -- prazo. Isso não é prazo: é ausência de prazo escrita como se fosse um.
     --
     -- NÃO se aplica a venda com pagamento pendente (PIX aguardando): aquilo
     -- se espera que caia hoje, e dar trinta dias a ela esconderia um PIX que
     -- nunca caiu. Nulo = vence hoje, como hoje.
     credit_sale_due_days   INTEGER,
     -- Por quantos dias a PRÉ-VENDA segura o estoque.
     --
     -- Pré-venda RESERVA mercadoria: a peça some do disponível enquanto o
     -- documento estiver aberto. Aprovar orçamento criava pré-venda SEM
     -- vencimento, e a varredura que expira documentos ignora justamente quem
     -- não tem data — então a reserva ficava para sempre e a peça sumia do
     -- balcão sem ter sido vendida. Os 7 dias existiam só na tela de quem
     -- digita o orçamento à mão.
     --
     -- Nulo = 7 dias, a constante que morava no frontend.
     reservation_valid_days INTEGER,
     -- Quanto o caixa tira da gaveta sem chamar ninguém.
     --
     -- Hoje não há teto: as únicas recusas da sangria são valor menor ou igual
     -- a zero e saldo insuficiente. Qualquer operador com caixa aberto zera a
     -- gaveta, e a única testemunha é o próprio movimento que ele lançou.
     --
     -- Em CENTAVOS, e o dono digita em REAIS — a conversão mora na escrita, no
     -- serviço, e falha alto com o nome do campo na mensagem. Guardar em texto
     -- num par chave/valor faria a conversão de "500,00" virar NaN, e comparar
     -- qualquer coisa com NaN devolve false: a trava falharia ABERTA em cima de
     -- uma vírgula.
     --
     -- Nulo = sem teto, o comportamento de hoje. ZERO é decisão oposta e
     -- legítima: toda sangria chama o gestor.
     cash_withdrawal_limit_cents INTEGER,
     -- A OS da oficina pode ser FATURADA para o cliente — conta a receber, sem
     -- pagamento na hora, vencendo em credit_sale_due_days (GAP-PRD-104).
     --
     -- É decisão do dono, e o padrão é o seguro: nulo ou 0 = desligado, o
     -- caixa só fecha a OS com o total coberto pelos meios. Leitor: o
     -- recebimento da OS (WorkshopCashierService.receberOs), que recusa a
     -- lista vazia de pagamentos enquanto isto não for 1.
     workshop_credit_enabled INTEGER,
     -- COMO A DEVOLUÇÃO DEVOLVE O DINHEIRO.
     --
     -- 'imediato' (nulo = o comportamento de sempre): o registro da devolução
     -- já dá o dinheiro por devolvido, num meio só. 'duas_etapas': a devolução
     -- registra a MERCADORIA (itens, motivo, estoque) e o reembolso é registrado
     -- depois, pelo que de fato aconteceu — dinheiro da gaveta, PIX feito pela
     -- conta, estorno feito na maquininha —, em uma ou mais parcelas, com
     -- pendente/parcial/concluído. Ligado só na Preço Justo nesta entrega
     -- (ativarDevolucaoEmDuasEtapasNaPrecoJusto); as outras operações migram
     -- numa missão própria. Leitor: SaleReturnService, via fluxoDaDevolucao.
     return_refund_flow TEXT,
     -- O MOTIVO DA LIBERAÇÃO DE DESCONTO É OBRIGATÓRIO (P0 da Preço Justo).
     --
     -- O DEFEITO: a liberação acima da alçada gravava "reason" — uma frase que
     -- a TELA montava sozinha ("Concessão de R$ 3.400 (28%) sobre R$ 12.000") —
     -- e nenhum porquê dito por gente. O dono lia a trilha e via QUANTO foi
     -- liberado e por QUEM, nunca POR QUE; "cliente antigo" e "o gerente é
     -- amigo do cliente" ficavam indistinguíveis.
     --
     -- 1 = a senha do gestor só vale com core_authorizations.justification (o
     -- motivo digitado) preenchida. Nulo ou 0 = o comportamento de sempre
     -- (motivo opcional). É por operação, e não uma regra do grupo: ligado só
     -- na Preço Justo, pelo passo idempotente
     -- exigirMotivoDaLiberacaoNaPrecoJusto, que só escreve onde está nulo.
     -- Leitor: AuthorizationService.authorizeAction.
     discount_reason_required INTEGER,
     created_at             TEXT NOT NULL,
     updated_at             TEXT NOT NULL
   );`,

  // LIMITE DE DESCONTO POR PERFIL — o P0 da Preço Justo.
  //
  // O DEFEITO: a alçada tinha UM número por operação (discount_limit_percent),
  // só em percentual, só sobre a venda inteira, e valia igual para o caixa
  // novo, a atendente e o operador de dez anos. E quem tinha perfil de gerente
  // não tinha limite NENHUM — dava 90% sem ninguém ver. Não havia como dizer
  // "a atendente dá até 5% e nunca mais de R$ 50" nem "nenhuma linha sai com
  // mais de 15%".
  //
  // Uma linha por (operação, perfil), quatro tetos, e cada nulo significa "sem
  // este teto" — com UMA exceção, que é o que mantém o balcão de hoje intacto:
  //
  //   max_percent nulo num perfil SEM alçada = o discount_limit_percent da
  //   operação (os 10% de sempre). Num perfil COM alçada (gerente, gestor) =
  //   sem teto, como sempre foi.
  //
  // Operação sem linha nenhuma nesta tabela vende EXATAMENTE como antes. Os
  // valores em centavos são guardados em CENTAVOS e digitados em REAIS — a
  // conversão mora na escrita (SalePolicyService.salvarLimitesPorPerfil).
  //
  //   max_percent      : concessão da VENDA inteira sobre o bruto, em %.
  //   max_cents        : concessão da VENDA inteira, em centavos.
  //   item_max_percent : concessão de UMA linha sobre o bruto da linha, em %.
  //   item_max_cents   : concessão de UMA linha, em centavos.
  //
  // Leitor: LimiteDeDesconto.limiteDosPerfis, chamado por createSale e pela
  // alçada do documento (QuoteService.cobrarAlcadaDoDocumento).
  `CREATE TABLE IF NOT EXISTS core_discount_limits (
     company_id       TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     profile_code     TEXT NOT NULL,
     max_percent      REAL,
     max_cents        INTEGER,
     item_max_percent REAL,
     item_max_cents   INTEGER,
     updated_by       TEXT,
     created_at       TEXT NOT NULL,
     updated_at       TEXT NOT NULL,
     PRIMARY KEY (company_id, profile_code)
   );`,

  // TRANSPORTADORA — quem trouxe a mercadoria até a porta.
  //
  // A NF-e carrega um grupo <transp> inteiro que o sistema descartava: quem
  // transportou, quem pagou o frete, placa do caminhão, quantos volumes e
  // quanto pesava. O conferente da doca precisa exatamente disso para bater a
  // carga contra o romaneio, e quem cobra falta precisa saber para quem ligar.
  //
  // NÃO CONFUNDIR com `logistics_carrier_credentials`: aquilo é cotação de
  // frete de SAÍDA do e-commerce (Melhor Envio, Correios), outro domínio. Esta
  // aqui é a transportadora fiscal da nota que a loja RECEBE.
  //
  // Nasce sozinha na importação, como o fornecedor: nome e documento, e o
  // resto se completa na tela. Cadastro válido e incompleto é melhor que
  // exigir preenchimento na hora de dar entrada — é assim que se ensina o
  // conferente a inventar dado.
  `CREATE TABLE IF NOT EXISTS core_carriers (
     id          TEXT PRIMARY KEY,
     company_id  TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     name        TEXT NOT NULL,
     trade_name  TEXT,
     -- CNPJ da empresa OU CPF do autônomo. O <transporta> traz um ou outro,
     -- nunca os dois, e o transportador autônomo é o caso comum no interior.
     document    TEXT,
     -- Decide crédito de ICMS sobre o frete, pelo mesmo motivo do fornecedor.
     state_registration TEXT,
     email       TEXT,
     phone       TEXT,
     contact_name TEXT,
     city        TEXT,
     state       TEXT,
     notes       TEXT,
     active      INTEGER NOT NULL DEFAULT 1,
     created_at  TEXT NOT NULL,
     updated_at  TEXT,
     -- Mesma identidade do fornecedor: no SQLite NULLs não colidem entre si,
     -- então N transportadoras sem documento convivem e só o preenchido casa.
     UNIQUE (company_id, document)
   );`,
  // Pode ficar aqui: a tabela NASCE nesta lista, então a coluna já existe
  // quando o índice roda. A proibição vale para índice sobre coluna que só a
  // migração acrescenta — foi o que derrubou a subida duas vezes.
  `CREATE INDEX IF NOT EXISTS ix_carriers_company_name
     ON core_carriers (company_id, name);`,

  // PEDIDO DE COMPRA — expectativa, não fato.
  //
  // O pedido NÃO movimenta estoque, e é a regra mais importante daqui. Quem dá
  // entrada é a conferência da nota (IMPORTAR → CONFERIR → CONFIRMAR): o
  // fornecedor manda o que manda, não o que foi pedido. Somar o pedido ao
  // estoque faria o sistema afirmar que a mercadoria chegou porque alguém
  // digitou que ia chegar.
  `CREATE TABLE IF NOT EXISTS core_purchase_orders (
     id           TEXT PRIMARY KEY,
     company_id   TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     number       INTEGER NOT NULL,
     supplier_id  TEXT NOT NULL REFERENCES core_suppliers(id),
     -- rascunho | enviado | recebido_parcial | recebido | cancelado
     status       TEXT NOT NULL DEFAULT 'rascunho',
     expected_at  TEXT,
     notes        TEXT,
     total_cents  INTEGER NOT NULL DEFAULT 0,
     created_by   TEXT,
     cancel_reason TEXT,
     created_at   TEXT NOT NULL,
     updated_at   TEXT,
     UNIQUE (company_id, number)
   );`,

  `CREATE TABLE IF NOT EXISTS core_purchase_order_items (
     id               TEXT PRIMARY KEY,
     order_id         TEXT NOT NULL REFERENCES core_purchase_orders(id) ON DELETE CASCADE,
     company_id       TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     product_id       TEXT REFERENCES core_products(id),
     description      TEXT NOT NULL,
     quantity         REAL NOT NULL,
     unit_cost_cents  INTEGER NOT NULL DEFAULT 0,
     total_cents      INTEGER NOT NULL DEFAULT 0,
     -- Quanto já chegou, somado das notas confirmadas contra este pedido.
     received_quantity REAL NOT NULL DEFAULT 0,
     created_at       TEXT NOT NULL
   );`,

  // A chave da NF-e é única por empresa: reimportar o mesmo XML não duplica
  // entrada de estoque nem contas a pagar (item 23).
  `CREATE TABLE IF NOT EXISTS core_inbound_notes (
     id            TEXT PRIMARY KEY,
     company_id    TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     access_key    TEXT NOT NULL,
     number        TEXT,
     series        TEXT,
     supplier_id   TEXT REFERENCES core_suppliers(id),
     issued_at     TEXT,
     total_cents   INTEGER NOT NULL DEFAULT 0,
     status        TEXT NOT NULL DEFAULT 'imported',
     received_at   TEXT,
     received_by   TEXT,
     -- Pedido que esta nota atende, quando houve pedido. Nulo é normal: nem
     -- toda entrada nasce de pedido de compra (reposição de balcão, brinde,
     -- devolução de cliente). É por aqui que o pedido descobre o que chegou.
     purchase_order_id TEXT REFERENCES core_purchase_orders(id),
     -- ------------------------------------------------- transporte da nota
     --
     -- Tudo abaixo sai do grupo <transp> do XML, que era descartado inteiro.
     -- Todas nulas: nota de retirada no balcão não declara transporte nenhum,
     -- e isso é normal, não é falta de dado.
     carrier_id    TEXT REFERENCES core_carriers(id),
     -- O nome exatamente como veio no arquivo. O casamento por documento
     -- reaproveita cadastro cujo nome pode divergir — o primeiro nome vence
     -- para sempre, como no fornecedor —, e isto mantém a nota fiel ao papel.
     carrier_name_xml TEXT,
     -- Dígito cru do <modFrete>. Domínio {0,1,2,3,4,9}: 5, 6, 7 e 8 NÃO
     -- existem no layout 4.00, então validar como "um dígito" aceitaria valor
     -- que a SEFAZ recusa.
     --
     -- E a leitura INVERTE na compra: o layout fala pela ótica do emitente, e
     -- numa nota de entrada o emitente é o fornecedor. Aqui 0 significa que o
     -- FORNECEDOR pagou o frete, e 1 que a LOJA paga.
     freight_mode  TEXT,
     -- Vem de ICMSTot/vFrete, não de <transp>: o valor do frete nunca morou no
     -- grupo de transporte.
     freight_cents INTEGER,
     vehicle_plate TEXT,
     vehicle_uf    TEXT,
     volumes_qty   INTEGER,
     -- Peso em GRAMAS inteiras. O XML traz kg com 3 casas ("12.500"), e 3
     -- casas de kg é exatamente grama: nada se perde e não entra float.
     --
     -- NUNCA passar por toCents, que multiplica por 100 — é helper de
     -- DINHEIRO. 12,500 kg viraria 1250 e ninguém nota até a balança discordar.
     gross_weight_grams INTEGER,
     net_weight_grams   INTEGER,
     -- ------------------------------------------------- o arquivo, inteiro
     --
     -- O XML DA NOTA, EXATAMENTE COMO CHEGOU. É o único buraco irreversível
     -- que este sistema tinha: até aqui o arquivo era LIDO, virava linha e
     -- item, e era DESCARTADO. A nota que já entrou no banco da loja não tem
     -- backfill possível — o arquivo não existe em lugar nenhum.
     --
     -- Quem precisa dele é o contador: a escrituração da compra é feita a
     -- partir do XML do fornecedor, não do resumo que a tela mostra. E o
     -- fornecedor guarda o dele por prazo próprio; quem responde pelo
     -- arquivo da entrada é quem recebeu a mercadoria.
     --
     -- VERBATIM, E ISSO É O PONTO: nunca reserializado. O XML vem ASSINADO
     -- pelo fornecedor, e a assinatura cobre os bytes. Passar por um parser e
     -- imprimir de volta reordena atributo, normaliza espaço em branco e
     -- troca aspas — o arquivo continua "igual" para um humano e a assinatura
     -- deixa de validar. Um arquivo que parece certo e não prova nada é pior
     -- que arquivo nenhum.
     --
     -- NULLABLE porque as notas que já existem nunca terão o seu, e nulo aqui
     -- é a verdade: "não foi guardado", não "está vazio".
     xml_original  TEXT,
     -- ------------------------------------------- a espécie do documento
     --
     -- 'nfe' é a nota do fornecedor, importada de XML; 'manual' é a compra
     -- SEM nota fiscal (feira, autônomo, produtor rural), digitada na tela
     -- (GAP-V17). A coluna existe para o documento manual NUNCA fingir ser
     -- NF-e: a tela o rotula, o financeiro nasce com origem própria
     -- ('entrada_manual'), e o pacote do contador o distingue. DEFAULT 'nfe'
     -- porque toda linha anterior a esta coluna veio de XML — é a verdade
     -- delas, não um chute.
     doc_type      TEXT NOT NULL DEFAULT 'nfe',
     -- ------------------------------------------------- estorno da entrada
     --
     -- Preenchidas quando a entrada confirmada foi DESFEITA (status
     -- 'estornada', GAP-V20): quem, quando e por quê. O razão guarda o
     -- movimento contrário; estas colunas guardam a decisão. Nulas na nota
     -- viva — ausência de estorno é ausência de fato.
     reversed_at   TEXT,
     reversed_by   TEXT,
     reversal_reason TEXT,
     -- -------------------------------- o que mais o XML diz (GAP-PRD-181)
     --
     -- O modelo (<ide><mod>) e o DESTINATÁRIO da nota — a conferência de
     -- que ela é mesmo desta loja, e matéria do contador. Nulas na entrada
     -- digitada e, nas notas anteriores a estas colunas, até a releitura
     -- (POST /core/fiscal/classification/reler-notas).
     model         TEXT,
     recipient_document TEXT,
     recipient_name TEXT,
     created_at    TEXT NOT NULL,
     -- --------------------------------- a nota recebida SEM conta a pagar
     --
     -- GAP-PRD-088. Nota confirmada antes de o financeiro nascer junto (a NF
     -- 9991 da Preço Justo) ficou recebida sem título, e o código decidiu não
     -- fabricar dívida retroativa. Quem decide é o dono, por um de três
     -- gestos: lançar a conta, lançar já paga, ou declarar que a nota NÃO gera
     -- conta (bonificação, consignação) — e só este último grava aqui, porque
     -- os outros dois deixam o título como prova. Nulas enquanto ninguém
     -- decidiu; anuláveis, então o boot as acrescenta em banco existente.
     finance_waiver_reason TEXT,
     finance_waiver_by     TEXT,
     finance_waiver_at     TEXT,
     -- O QUE O FORMULARIO DA ENTRADA MANUAL PEDIU (RES-IDEM-VIZ): v1 + SHA-256
     -- de fornecedor, numero do documento e itens. So a entrada manual com
     -- idempotencyKey grava; a mesma chave com outra compra e recusada (422)
     -- em vez de devolver esta nota. Nula = nota por XML, ou anterior.
     idempotency_fingerprint TEXT,
     UNIQUE (company_id, access_key)
   );`,

  `CREATE TABLE IF NOT EXISTS core_inbound_note_items (
     id               TEXT PRIMARY KEY,
     note_id          TEXT NOT NULL REFERENCES core_inbound_notes(id) ON DELETE CASCADE,
     company_id       TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     product_id       TEXT REFERENCES core_products(id),
     supplier_code    TEXT,
     barcode          TEXT,
     description      TEXT NOT NULL,
     ncm              TEXT,
     cfop             TEXT,
     unit             TEXT,
     quantity         REAL NOT NULL,
     /**
      * A unidade TRIBUTÁVEL do item, e a quantidade nela.
      *
      * O layout da NF-e obriga o emitente a declarar dois pares: o
      * comercial (uCom/qCom, como ele vende) e o tributável
      * (uTrib/qTrib, a menor unidade do item). Numa nota de 10 caixas
      * de 12, o segundo par diz 120 UN — a conversão vem escrita no
      * arquivo, e o parser a descartava.
      */
     unit_trib        TEXT,
     quantity_trib    REAL,
     /**
      * Quantas unidades do CADASTRO cabem em uma unidade da NOTA.
      *
      * NULL enquanto ninguém precisou dizer: unidade igual, ou nota que
      * já traz a conversão no par tributável. Preenchido pelo conferente
      * quando nem a nota sabe — o fornecedor que tributa em CX também.
      */
     conversion_factor REAL,
     unit_cost_cents  INTEGER NOT NULL DEFAULT 0,
     total_cents      INTEGER NOT NULL DEFAULT 0,
     matched          INTEGER NOT NULL DEFAULT 0,
     /**
      * O que REALMENTE chegou, contado pelo conferente.
      *
      * NULL enquanto ninguém conferiu — e aí vale a quantidade da nota. É
      * diferente de zero, que significa "conferi e não veio nada": tratar os
      * dois como a mesma coisa daria entrada de mercadoria que não chegou.
      *
      * O estoque entra com ESTE número, porque estoque tem que refletir a
      * prateleira. O que se deve ao fornecedor continua sendo o da nota — a
      * diferença é assunto para negociar, não para o sistema resolver sozinho.
      */
     received_quantity REAL,
     divergence_note   TEXT,
     -- COMO o item casou (rodada 44): 'barcode' | 'internal_code' | 'name' |
     -- 'manual'. Antes desta coluna, a leitura FABRICAVA 'barcode' para todo
     -- item vinculado — a tela mentia o método para quem conferia.
     matched_by        TEXT,
     -- O CEST e a ORIGEM que o fornecedor DECLAROU no arquivo.
     --
     -- O NCM e o CFOP já eram guardados; estes dois eram lidos e jogados fora
     -- pelo parser. Guardá-los é o que permite a sugestão de classificação
     -- nascer da nota — e, principalmente, é o que permite PROVAR de qual nota
     -- ela nasceu quando alguém perguntar de onde veio aquele CEST.
     cest              TEXT,
     origin            TEXT,
     -- A TRIBUTAÇÃO QUE O FORNECEDOR DECLAROU no item (GAP-PRD-181): a da
     -- SAÍDA dele. Matéria do contador (crédito, conferência); NUNCA vira a
     -- tributação do produto. Nulo é "não declarado", não zero.
     icms_cst          TEXT,
     icms_csosn        TEXT,
     icms_cents        INTEGER,
     icms_st_cents     INTEGER,
     ipi_cst           TEXT,
     ipi_cents         INTEGER,
     pis_cst           TEXT,
     pis_cents         INTEGER,
     cofins_cst        TEXT,
     cofins_cents      INTEGER
   );`,

  /*
    ==========================================================================
    O DE-PARA DO FORNECEDOR — o código dele, o produto nosso (GAP-PRD-015)
    ==========================================================================

    O fornecedor não fala a língua do catálogo: manda `cProd` próprio, muitas
    vezes sem GTIN, com uma descrição que muda de nota para nota. O casamento
    automático (código de barras, código interno, nome) erra por omissão, e o
    item não reconhecido virava um SEGUNDO produto com preço zero.

    Cada linha é uma DECISÃO já tomada: "o `ALFA-778` da Distribuidora Alfa é o
    nosso Cabo de Acelerador". Ela nasce de dois gestos, e `origin` diz qual:

      - 'vinculo_manual'      alguém da doca escolheu o produto na conferência;
      - 'cadastro_pela_nota'  a confirmação cadastrou o produto que faltava, e
                              a próxima nota do mesmo código cai nele — mesmo
                              que a loja tenha trocado o nome do cadastro.

    A chave é (empresa, fornecedor, código dele): o mesmo "778" de dois
    fornecedores são mercadorias diferentes, e um código só aponta para um
    produto — trocar o vínculo reescreve a linha, desfazer apaga.

    Tabela NOVA: o boot a cria em banco existente, e o índice vai junto por ser
    de tabela nova (REGRAS §5). Nada aqui é backfill — o de-para começa vazio e
    aprende com a primeira conferência de cada fornecedor.
  */
  `CREATE TABLE IF NOT EXISTS core_supplier_item_codes (
     id              TEXT PRIMARY KEY,
     company_id      TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     supplier_id     TEXT NOT NULL REFERENCES core_suppliers(id) ON DELETE CASCADE,
     supplier_code   TEXT NOT NULL,
     product_id      TEXT NOT NULL REFERENCES core_products(id) ON DELETE CASCADE,
     origin          TEXT NOT NULL CHECK (origin IN ('vinculo_manual', 'cadastro_pela_nota')),
     source_note_id  TEXT,
     created_by      TEXT,
     created_at      TEXT NOT NULL,
     updated_at      TEXT NOT NULL,
     UNIQUE (company_id, supplier_id, supplier_code)
   );`,
  `CREATE INDEX IF NOT EXISTS ix_supplier_item_codes_product
     ON core_supplier_item_codes (product_id);`,

  /*
    ==========================================================================
    DEVOLUÇÃO AO FORNECEDOR (GAP-PRD-089) — desfazer PARTE de uma compra
    ==========================================================================

    O estorno da entrada desfaz a nota INTEIRA, e só enquanto nada foi pago
    nem vendido. Devolver a peça com defeito de uma compra já paga e em parte
    vendida não tinha caminho: saída manual com motivo, lançamento avulso e
    documento por fora.

    O documento aponta para a NOTA de entrada (é contra ela que a mercadoria
    volta, e é a chave dela que a NF-e de devolução referencia) e guarda três
    coisas que não se deduzem depois:

      - O VALOR das mercadorias pelo custo com que ENTRARAM (goods_cents) e o
        valor COMBINADO do crédito (credit_cents) — podem diferir quando o
        fornecedor devolve também o IPI ou o frete daquela parte;
      - COMO o financeiro foi tocado: abatimento do título em aberto da nota,
        crédito a receber do fornecedor, ou nada (nota sem dívida — bonificação);
        o detalhe do abatimento (título, antes, depois) vai em finance_detail;
      - A SITUAÇÃO FISCAL: a NF-e de devolução (finalidade 4) é pendência até
        alguém registrar a chave — ou declarar que o fornecedor emite a nota de
        entrada dele, ou dispensar com justificativa.

    Tabela NOVA, DDL canônica (REGRAS §5): o boot a cria em banco existente, e
    o índice por nota é de tabela nova.
  */
  `CREATE TABLE IF NOT EXISTS core_supplier_returns (
     id               TEXT PRIMARY KEY,
     company_id       TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     number           INTEGER NOT NULL,
     note_id          TEXT NOT NULL REFERENCES core_inbound_notes(id),
     supplier_id      TEXT REFERENCES core_suppliers(id),
     reason           TEXT NOT NULL,
     goods_cents      INTEGER NOT NULL,
     credit_cents     INTEGER NOT NULL,
     finance_mode     TEXT NOT NULL
                      CHECK (finance_mode IN ('abatimento', 'credito', 'sem_financeiro')),
     finance_entry_id TEXT REFERENCES core_finance_entries(id),
     finance_detail   TEXT,
     fiscal_status    TEXT NOT NULL DEFAULT 'pendente'
                      CHECK (fiscal_status IN ('pendente', 'emitida', 'nota_do_fornecedor', 'dispensada')),
     fiscal_access_key TEXT,
     fiscal_note      TEXT,
     fiscal_updated_by TEXT,
     fiscal_updated_at TEXT,
     created_by       TEXT,
     created_at       TEXT NOT NULL,
     UNIQUE (company_id, number)
   );`,
  `CREATE INDEX IF NOT EXISTS ix_supplier_returns_note
     ON core_supplier_returns (company_id, note_id);`,
  `CREATE TABLE IF NOT EXISTS core_supplier_return_items (
     id              TEXT PRIMARY KEY,
     return_id       TEXT NOT NULL REFERENCES core_supplier_returns(id) ON DELETE CASCADE,
     company_id      TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     product_id      TEXT NOT NULL REFERENCES core_products(id),
     -- Na unidade do CADASTRO — a mesma do movimento de estoque que a tirou.
     quantity        REAL NOT NULL CHECK (quantity > 0),
     unit_cost_cents INTEGER NOT NULL,
     total_cents     INTEGER NOT NULL,
     created_at      TEXT NOT NULL
   );`,
  `CREATE INDEX IF NOT EXISTS ix_supplier_return_items_return
     ON core_supplier_return_items (return_id);`,

  /*
    ==========================================================================
    A POLÍTICA DE GESTÃO — as decisões que o código tomava sozinho (GAP-PRD-165/166)
    ==========================================================================

    Duas regras moravam no código, com justificativa, e sem confirmação do dono:

      - QUEM VÊ DINHEIRO: o painel (faturamento, ticket, recebíveis) e a
        posição de estoque com custo abriam para todo o escritório, atendente e
        estoquista inclusos. Aqui o dono decide, com padrão SEGURO (0 = só a
        gerência vê os números de dinheiro).
      - A RÉGUA DO VALOR DO ESTOQUE: último custo do cadastro (a de sempre) ou
        custo médio móvel reconstruído do razão. Quem confirma é o CONTADOR — a
        tela registra quem e quando, e mostra a pendência até lá.

    Uma linha por empresa; sem linha = os padrões. Tabela NOVA (REGRAS §5).
  */
  `CREATE TABLE IF NOT EXISTS core_management_policies (
     company_id               TEXT PRIMARY KEY REFERENCES core_companies(id) ON DELETE CASCADE,
     painel_financeiro_equipe INTEGER NOT NULL DEFAULT 0 CHECK (painel_financeiro_equipe IN (0, 1)),
     custo_estoque_equipe     INTEGER NOT NULL DEFAULT 0 CHECK (custo_estoque_equipe IN (0, 1)),
     regua_valorizacao        TEXT NOT NULL DEFAULT 'ultimo_custo'
                              CHECK (regua_valorizacao IN ('ultimo_custo', 'custo_medio')),
     regua_confirmada_por     TEXT,
     regua_confirmada_em      TEXT,
     updated_by               TEXT,
     updated_at               TEXT
   );`,

  /*
    ==========================================================================
    O QUE O XML DO FORNECEDOR SUGERE — E O QUE ELE NUNCA DECIDE
    ==========================================================================

    Cada linha é UM FATO, não um estado: "a nota X, do fornecedor Y, declarou
    NCM 8714.10.00 para o item que casou com este produto". Fato não se
    resolve, não se cancela e não se edita — por isso não existe aqui nenhuma
    coluna de "aceita/recusada". O ESTADO da classificação é DERIVADO da
    comparação entre estes fatos e o que o cadastro tem hoje, exatamente como
    o readiness deriva HOMOLOGATED de um protocolo real em vez de guardar um
    booleano que alguém pode ligar na mão.

    Três consequências desse desenho, e as três são o motivo dele:

      1. CONFIANÇA POR CONTAGEM sai de graça: quantos itens de nota disseram
         o mesmo valor é um COUNT, e não um contador que pode dessincronizar;
      2. DIVERGÊNCIA sai de graça: dois valores distintos para o mesmo campo
         é um GROUP BY com mais de uma linha;
      3. IDEMPOTÊNCIA sai da UNIQUE: a chave inclui `source_ref`, que é a
         LINHA DA NOTA que originou o fato. Reconfirmar a mesma nota reinsere
         a mesma chave e o INSERT OR IGNORE não faz nada — a confiança não
         sobe por clique repetido, que seria confiança fabricada.

    O CFOP NÃO TEM LUGAR NESTA TABELA, e a ausência é a regra mais importante
    dela: o CFOP do XML é o da SAÍDA DO FORNECEDOR (6102, venda interestadual
    dele), não o da nossa. Sugeri-lo produziria nota autorizada com tributação
    errada — pior que nota recusada, porque a recusa aparece na hora e o
    imposto errado aparece na fiscalização. CSOSN, CFOP e pCredSN continuam
    sendo decisão do contador, e nenhum arquivo de terceiro os toca.
  */
  `CREATE TABLE IF NOT EXISTS core_product_fiscal_suggestions (
     id            TEXT PRIMARY KEY,
     company_id    TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     product_id    TEXT NOT NULL REFERENCES core_products(id) ON DELETE CASCADE,
     -- 'ncm' | 'cest' | 'origin'. Nunca 'cfop' — ver o cabeçalho.
     field         TEXT NOT NULL,
     value         TEXT NOT NULL,
     -- De onde veio o fato. Hoje só 'supplier_xml'; a coluna existe para que
     -- uma segunda procedência (tabela oficial de NCM, por exemplo) não exija
     -- migrar tabela nem confundir as duas na contagem.
     source        TEXT NOT NULL DEFAULT 'supplier_xml',
     -- A LINHA DA NOTA que originou o fato. É ela que torna a inserção
     -- idempotente e a procedência auditável.
     source_ref    TEXT NOT NULL,
     note_id       TEXT,
     supplier_name TEXT,
     issued_at     TEXT,
     created_at    TEXT NOT NULL,
     UNIQUE (company_id, product_id, field, value, source_ref)
   );`,
  `CREATE INDEX IF NOT EXISTS ix_fiscal_suggestions_produto
     ON core_product_fiscal_suggestions (company_id, product_id, field);`,

  /*
    DISTRIBUIÇÃO DF-e — as notas emitidas CONTRA o CNPJ do grupo (rodada 44).

    Cada linha é um documento devolvido pela SEFAZ na consulta por NSU:
    resumo (resNFe), nota completa (procNFe) ou resumo de evento (resEvento).
    O NSU é o cursor oficial — UNIQUE por (empresa, ambiente) torna a
    reconsulta idempotente, e o próximo lote parte de MAX(nsu) do ambiente,
    sem tabela de cursor.

    `xml` guarda o documento VERBATIM, pelo mesmo princípio do xml_original
    da nota de entrada: a assinatura cobre os bytes, nunca reserializar.

    A manifestação mora aqui (status/protocolo/quando) porque é o estado DO
    documento perante o destinatário; o rastro append-only do pedido e do
    desfecho fica em core_fiscal_events, como todo evento fiscal.

    O NSU É POR AMBIENTE (DFE-AMBIENTE, GAP-PRD-168): o Ambiente Nacional
    numera homologação e produção em sequências separadas, cada uma a partir
    do 1. `environment` é o ambiente que a CONSULTA usou, e a unicidade e o
    cursor são por (empresa, ambiente). Com UNIQUE (company_id, nsu), a
    primeira consulta de produção partia do maior NSU da homologação e o
    INSERT OR IGNORE engolia as notas de produção de NSU repetido. Banco que
    vem da 84 é reconstruído no passo 85 (`consolidacaoDaRemediacao.ts`).
    Nenhum índice sobre `environment` fora da tabela: a DDL canônica roda
    antes dos passos, e a UNIQUE já indexa (company_id, environment, nsu).
  */
  `CREATE TABLE IF NOT EXISTS core_dfe_documents (
     id                TEXT PRIMARY KEY,
     company_id        TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     environment       TEXT NOT NULL DEFAULT 'homologation'
                       CHECK (environment IN ('homologation', 'production')),
     nsu               TEXT NOT NULL,
     schema_type       TEXT NOT NULL,
     access_key        TEXT,
     supplier_cnpj     TEXT,
     supplier_name     TEXT,
     total_cents       INTEGER,
     issued_at         TEXT,
     xml               TEXT,
     manifest_status   TEXT,
     manifest_protocol TEXT,
     manifested_at     TEXT,
     imported_note_id  TEXT REFERENCES core_inbound_notes(id),
     received_at       TEXT NOT NULL,
     UNIQUE (company_id, environment, nsu)
   );`,
  `CREATE INDEX IF NOT EXISTS ix_dfe_documents_key
     ON core_dfe_documents (company_id, access_key);`,
  /*
    O CURSOR DA DISTRIBUIÇÃO DF-e — o que a SEFAZ DEVOLVEU, por (empresa,
    ambiente). R3-DFE (GAP-PRD-168).

    O cursor era MAX(nsu) de core_dfe_documents: depois de um cStat 137 ou de
    um lote só com o que não se grava, ele não andava, e a consulta seguinte
    repetia o mesmo ultNSU — o Ambiente Nacional (NT 2014.002) chama isso de
    consumo indevido e bloqueia o CNPJ por uma hora (cStat 656). Aqui ficam o
    ultNSU e o maxNSU da última resposta, o instante dela e a hora a partir da
    qual a próxima consulta pode sair (`next_query_at`: em dia, uma hora; 656,
    o bloqueio). O cursor nunca recua (o UPSERT guarda o maior) e a consulta
    nunca parte de menos que o MAX(nsu) gravado. Só a SEFAZ de verdade escreve
    aqui — o simulador não segura o cursor nem a espera.
  */
  `CREATE TABLE IF NOT EXISTS core_dfe_cursors (
     company_id       TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     environment      TEXT NOT NULL CHECK (environment IN ('homologation', 'production')),
     ult_nsu          INTEGER NOT NULL DEFAULT 0,
     max_nsu          INTEGER,
     last_c_stat      TEXT,
     last_x_motivo    TEXT,
     last_response_at TEXT,
     next_query_at    TEXT,
     wait_reason      TEXT CHECK (wait_reason IN ('em_dia', 'consumo_indevido')),
     updated_at       TEXT NOT NULL,
     PRIMARY KEY (company_id, environment)
   );`,

  /*
    CT-e — o documento do TRANSPORTE (modelo 57), que até a rodada 44 não
    existia no sistema: a transportadora emitia o conhecimento e o frete
    ficava sem registro próprio, órfão do lado de quem paga.

    O vínculo com as NF-e transportadas NÃO é coluna: o CT-e referencia as
    chaves (tabela filha) e o join por access_key com core_inbound_notes
    resolve na leitura. Derivado não se mantém à mão.
  */
  `CREATE TABLE IF NOT EXISTS core_cte_documents (
     id             TEXT PRIMARY KEY,
     company_id     TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     access_key     TEXT NOT NULL,
     number         TEXT,
     series         TEXT,
     carrier_cnpj   TEXT,
     carrier_name   TEXT,
     freight_cents  INTEGER NOT NULL DEFAULT 0,
     issued_at      TEXT,
     xml_original   TEXT,
     created_by     TEXT,
     created_at     TEXT NOT NULL,
     UNIQUE (company_id, access_key)
   );`,
  `CREATE TABLE IF NOT EXISTS core_cte_referenced_notes (
     id             TEXT PRIMARY KEY,
     cte_id         TEXT NOT NULL REFERENCES core_cte_documents(id) ON DELETE CASCADE,
     company_id     TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     nfe_access_key TEXT NOT NULL
   );`,
  `CREATE INDEX IF NOT EXISTS ix_cte_refs_key
     ON core_cte_referenced_notes (company_id, nfe_access_key);`,

  /*
    IMPORTAÇÃO DE PLANILHA — a loja nova nascendo com catálogo E saldo.

    Segue o molde da nota fiscal logo acima, e não é imitação: é a mesma
    necessidade. O arquivo entra, vira um lote EM CONFERÊNCIA, a pessoa vê
    linha a linha o que o sistema entendeu, e só o botão de confirmar cria
    produto e mexe em estoque. Importação que grava direto é importação em que
    ninguém confia — e aqui o que se grava é o catálogo inteiro de uma
    operação.
  */
  `CREATE TABLE IF NOT EXISTS core_import_batches (
     id            TEXT PRIMARY KEY,
     company_id    TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     filename      TEXT NOT NULL,
     /*
       SHA-256 dos bytes, e DELIBERADAMENTE SEM UNIQUE.

       Único trancaria a segunda tentativa do MESMO arquivo — ou seja,
       trancaria exatamente a pessoa que viu o separador detectado errado e
       quer subir de novo. O hash serve para AVISAR ("este arquivo já foi
       importado em 12/03 e criou 187 produtos"), não para impedir.
     */
     content_hash  TEXT NOT NULL,
     /*
       Os bytes do arquivo, em base64. Ficam guardados para a releitura:
       trocar o separador ou o encoding re-parseia o MESMO conteúdo, sem pedir
       à pessoa que suba tudo de novo. É o que torna o erro de detecção
       barato de corrigir.
     */
     content_b64   TEXT NOT NULL,
     encoding      TEXT NOT NULL,
     separator     TEXT NOT NULL,
     /*
       JSON de campo -> ÍNDICE da coluna, nunca campo -> nome da coluna.

       Planilha de verdade tem cabeçalho repetido ("preco" em duas colunas) e
       cabeçalho vazio. Guardar por nome torna o mapa ambíguo justamente nos
       arquivos que mais precisam de correção manual; o índice é sempre único.
     */
     column_map    TEXT NOT NULL,
     /*
       O cabeçalho como veio no arquivo, em JSON. A tela precisa mostrar o nome
       de cada coluna ao lado do índice para a pessoa poder remapear — sem
       isto ela escolheria entre "coluna 2" e "coluna 3" às cegas. Guardado, e
       não relido a cada requisição, porque reler exigiria re-parsear os bytes
       só para desenhar um cabeçalho.
     */
     header_json   TEXT NOT NULL DEFAULT '[]',
     -- 'conferencia' | 'confirmado' | 'descartado'
     status        TEXT NOT NULL DEFAULT 'conferencia',
     created_at    TEXT NOT NULL,
     created_by    TEXT REFERENCES core_users(id),
     confirmed_at  TEXT,
     confirmed_by  TEXT REFERENCES core_users(id),
     -- O que a confirmação REALMENTE fez, para a tela não ter de recontar e
     -- para o aviso de reimportação poder dizer o tamanho do estrago.
     created_products INTEGER NOT NULL DEFAULT 0,
     moved_products   INTEGER NOT NULL DEFAULT 0,
     skipped_rows     INTEGER NOT NULL DEFAULT 0
   );`,
  `CREATE INDEX IF NOT EXISTS ix_import_batches_company
     ON core_import_batches (company_id, created_at DESC);`,
  `CREATE INDEX IF NOT EXISTS ix_import_batches_hash
     ON core_import_batches (company_id, content_hash);`,

  `CREATE TABLE IF NOT EXISTS core_import_batch_items (
     id            TEXT PRIMARY KEY,
     batch_id      TEXT NOT NULL REFERENCES core_import_batches(id) ON DELETE CASCADE,
     company_id    TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     /*
       A linha da PLANILHA, contando as vazias — o número que a pessoa vê na
       lateral do Excel. Sem isto "erro na linha 43" manda olhar a linha
       errada, e a mensagem só vale se apontar para onde está o problema.
     */
     line_number   INTEGER NOT NULL,
     name          TEXT,
     barcode       TEXT,
     internal_code TEXT,
     unit          TEXT,
     price_cents   INTEGER,
     cost_cents    INTEGER,
     /*
       NULL e ZERO são coisas diferentes, pelo mesmo motivo que em
       received_quantity na tabela de itens de nota (sem crase de propósito:
       este texto vive DENTRO de um template literal, e a crase fecharia a
       string do DDL — o erro apareceria dezenas de linhas adiante).
       NULL é "a planilha não disse" e zero é "a planilha disse que não
       tem". Tratar os dois igual
       daria entrada de mercadoria que ninguém contou — ou esconderia da
       pessoa que 200 produtos vão nascer sem saldo nenhum.
     */
     quantity      REAL,
     -- Produto que a linha casou, quando casou. NULL num item 'novo'.
     product_id    TEXT REFERENCES core_products(id),
     -- 'novo' | 'existe' | 'erro'
     action        TEXT NOT NULL,
     error_code    TEXT,
     error_detail  TEXT
   );`,
  `CREATE INDEX IF NOT EXISTS ix_import_items_batch
     ON core_import_batch_items (batch_id, line_number);`,

  // Token de terminal confiável: o ÚNICO caminho que dispensa digitar senha,
  // e não é acesso anônimo — o terminal é registrado uma vez por um
  // administrador e troca este token por uma sessão real. Revogável e preso a
  // uma empresa. Nenhuma senha em texto puro no DOM ou no localStorage.
  `CREATE TABLE IF NOT EXISTS core_device_tokens (
     id            TEXT PRIMARY KEY,
     token_hash    TEXT NOT NULL UNIQUE,
     company_id    TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     terminal_id   TEXT REFERENCES core_terminals(id),
     user_id       TEXT NOT NULL REFERENCES core_users(id) ON DELETE CASCADE,
     label         TEXT NOT NULL,
     revoked       INTEGER NOT NULL DEFAULT 0,
     last_used_at  TEXT,
     created_by    TEXT,
     created_at    TEXT NOT NULL,
     expires_at    TEXT
   );`,

  // ---------------------------------------------------------------- oficinas
  // Uma OFICINA é um espaço de trabalho DENTRO de uma empresa — não é uma
  // empresa nova. É isso que permite existir a Oficina de Celulares dentro do
  // Preço Justo sem inventar uma sétima operação.
  //
  //   company-oficina      -> workshop "Mobilidade Elétrica"
  //   company-preco-justo  -> workshop "Celulares"
  //
  // Todo dado de oficina carrega company_id + workshop_id.
  `CREATE TABLE IF NOT EXISTS core_workshops (
     id          TEXT PRIMARY KEY,
     company_id  TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     slug        TEXT NOT NULL UNIQUE,
     name        TEXT NOT NULL,
     kind        TEXT NOT NULL DEFAULT 'mobility',
     -- QUEM ASSINA O PAPEL desta bancada (rodada 54).
     --
     -- A ordem de servico impressa leva marca, CNPJ e endereco de uma empresa
     -- — e nem sempre e a empresa DONA da bancada. A bancada de mobilidade
     -- pertence a Oficina, que e a operacao interna do grupo, mas quem o
     -- cliente conhece, quem vendeu a moto e quem responde pela garantia e a
     -- PJ MOTORS. Papel entregue ao cliente com o nome errado no cabecalho e
     -- documento que nao serve para reclamar depois.
     --
     -- Nulo = a propria empresa da bancada assina, que e o caso da bancada de
     -- celulares (ela ja e da Preco Justo).
     brand_company_id TEXT REFERENCES core_companies(id),
     active      INTEGER NOT NULL DEFAULT 1,
     created_at  TEXT NOT NULL
   );`,
  `CREATE INDEX IF NOT EXISTS ix_workshops_company ON core_workshops (company_id);`,

  // Vínculo técnico<->oficina. Um mecânico de celulares não ganha acesso à
  // oficina de mobilidade por pertencer à mesma empresa.
  `CREATE TABLE IF NOT EXISTS core_workshop_members (
     id           TEXT PRIMARY KEY,
     workshop_id  TEXT NOT NULL REFERENCES core_workshops(id) ON DELETE CASCADE,
     user_id      TEXT NOT NULL REFERENCES core_users(id) ON DELETE CASCADE,
     role         TEXT NOT NULL DEFAULT 'mecanico',
     created_at   TEXT NOT NULL,
     UNIQUE (workshop_id, user_id)
   );`,

  // ------------------------------------------------------------- equipamentos
  // Moto, bike, patinete ou celular acompanhado por uma oficina.
  //
  // Dois tipos, deliberadamente explícitos no domínio:
  //   INTERNAL_PJ_MOTORS  — veículo da PJ Motors, montado pela Oficina; sem
  //                         proprietário até ser vendido.
  //   EXTERNAL_CUSTOMER   — equipamento do cliente, trazido para manutenção;
  //                         NUNCA entra no estoque comercial.
  `CREATE TABLE IF NOT EXISTS core_equipment (
     id                 TEXT PRIMARY KEY,
     company_id         TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     workshop_id        TEXT NOT NULL REFERENCES core_workshops(id) ON DELETE CASCADE,
     public_id          INTEGER NOT NULL UNIQUE,
     public_token       TEXT NOT NULL UNIQUE,
     origin             TEXT NOT NULL,
     origin_company_id  TEXT REFERENCES core_companies(id),
     linked_product_id  TEXT REFERENCES core_products(id),
     category           TEXT,
     brand              TEXT,
     model              TEXT,
     version            TEXT,
     color              TEXT,
     -- Ano de fabricação (rodada 43). O dono pediu desde o início.
     year               INTEGER,
     serial_number      TEXT,
     motor_number       TEXT,
     chassis            TEXT,
     battery            TEXT,
     battery_serial     TEXT,
     owner_customer_id  TEXT REFERENCES core_customers(id),
     sale_status        TEXT NOT NULL DEFAULT 'NOT_SOLD',
     sold_at            TEXT,
     sale_id            TEXT REFERENCES core_sales(id),
     status             TEXT NOT NULL DEFAULT 'ativo',
     notes              TEXT,
     -- ------------------------------------------------ garantia (rodada 52)
     --
     -- Guarda-se o COMBINADO (quantos meses), nunca o estado. O sistema
     -- anterior gravava um "warrantyStatus" a mao e nunca o recalculava: a
     -- moto seguia "em garantia" na tela anos depois de vencer. Aqui o
     -- status e DERIVADO da data-base + meses, toda vez que alguem pergunta.
     warranty_months       INTEGER,
     -- Quem montou a maquina, e quando. So faz sentido no equipamento da
     -- casa: e o nome que responde pela montagem quando a moto volta.
     assembly_mechanic_id  TEXT REFERENCES core_users(id),
     assembled_at          TEXT,
     -- A data em que a maquina ENTROU (aquisicao pela loja, ou recebimento
     -- do cliente). A coluna existia desde o inicio e nunca foi lida nem
     -- escolhida: era sempre o instante do cadastro. Agora e informavel.
     entered_at         TEXT,
     -- -------------------------------- identidade completa (GAP-PRD-106)
     --
     -- A placa morava so na OS (digitada de novo a cada visita) e a
     -- quilometragem nao existia. As duas sao da MAQUINA. Anulaveis: o
     -- reconcileCoreSchema as acrescenta em banco existente, e nulo e o que
     -- toda linha antiga ja significa ("nao informado"). A unicidade da placa
     -- por empresa e conferida no codigo (EquipmentIdentityService); o indice
     -- parcial fica descrito em docs/audits/remediacao/migracoes/OFI.md.
     plate              TEXT,
     odometer_km        INTEGER,
     -- Quando a quilometragem foi lida: km sem data nao diz nada.
     odometer_at        TEXT,
     created_at         TEXT NOT NULL,
     updated_at         TEXT NOT NULL
   );`,
  `CREATE INDEX IF NOT EXISTS ix_equipment_workshop
     ON core_equipment (workshop_id, public_id);`,
  `CREATE INDEX IF NOT EXISTS ix_equipment_owner
     ON core_equipment (owner_customer_id);`,

  // Histórico do equipamento — append-only, sobrevive à venda.
  `CREATE TABLE IF NOT EXISTS core_equipment_events (
     id            TEXT PRIMARY KEY,
     equipment_id  TEXT NOT NULL REFERENCES core_equipment(id) ON DELETE CASCADE,
     company_id    TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     event_type    TEXT NOT NULL,
     description   TEXT,
     user_id       TEXT,
     order_id      TEXT,
     created_at    TEXT NOT NULL
   );`,
  `CREATE INDEX IF NOT EXISTS ix_equipment_events
     ON core_equipment_events (equipment_id, created_at);`,

  // FOTO DA MAQUINA (GAP-PRD-106) — o arquivo no disco, a linha aqui.
  //
  // As fotos existiam so na OS: o estado da moto ao entrar ficava preso a uma
  // visita, e a proxima OS comecava sem nada. Estas sao do EQUIPAMENTO — a
  // lataria, o painel, o chassi gravado — e acompanham a maquina entre OS e
  // depois da venda. Mesmo desenho das fotos da OS: bytes no disco, endereco
  // com nome imprevisivel, nada na pagina publica do QR.
  `CREATE TABLE IF NOT EXISTS core_equipment_photos (
     id            TEXT PRIMARY KEY,
     equipment_id  TEXT NOT NULL REFERENCES core_equipment(id) ON DELETE CASCADE,
     company_id    TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     url           TEXT NOT NULL,
     file_name     TEXT,
     byte_size     INTEGER NOT NULL DEFAULT 0,
     kind          TEXT NOT NULL DEFAULT 'outra',
     caption       TEXT,
     uploaded_by   TEXT REFERENCES core_users(id),
     created_at    TEXT NOT NULL
   );`,
  `CREATE INDEX IF NOT EXISTS ix_equipment_photos
     ON core_equipment_photos (equipment_id, created_at);`,

  // ------------------------------------------------- plaquinhas (rodada 53)
  //
  // O POOL de plaquinhas: o numero existe ANTES da maquina.
  //
  // Ate aqui a plaquinha nascia junto do equipamento — `nextPublicId()` dentro
  // do cadastro — e so podia ser impressa depois que a moto ja estava no
  // sistema. A oficina trabalha ao contrario: manda imprimir uma folha de
  // adesivos, cola nas maquinas do patio e SO DEPOIS cadastra cada uma com o
  // numero que ja esta colado nela.
  //
  // O numero e unico NO GRUPO, nao por empresa: sao adesivos fisicos, e dois
  // com o mesmo numero em maquinas diferentes tornariam o QR ambiguo para
  // sempre. Por isso o indice unico e so em public_id, e o sorteio sai da
  // mesma sequencia do grupo que o cadastro ja usava.
  //
  // OS QUATRO ESTADOS, como no sistema anterior:
  //   gerada     -> o numero foi reservado, o papel ainda nao existe
  //   disponivel -> a folha FOI exportada; o adesivo existe e pode ser colado
  //   associada  -> ja esta numa maquina (permanente)
  //   danificada -> o adesivo se perdeu; o numero morre com ele
  //
  // `printed_at` e o que separa "gerada" de "disponivel": liberar uma
  // plaquinha que nunca foi para o papel cria um numero que existe no sistema
  // e nao existe no mundo.
  `CREATE TABLE IF NOT EXISTS core_equipment_tags (
     id             TEXT PRIMARY KEY,
     company_id     TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     public_id      INTEGER NOT NULL UNIQUE,
     public_token   TEXT NOT NULL UNIQUE,
     status         TEXT NOT NULL DEFAULT 'gerada',
     batch_id       TEXT,
     equipment_id   TEXT REFERENCES core_equipment(id),
     printed_at     TEXT,
     released_at    TEXT,
     released_by    TEXT REFERENCES core_users(id),
     associated_at  TEXT,
     damaged_at     TEXT,
     damaged_by     TEXT REFERENCES core_users(id),
     damaged_reason TEXT,
     created_by     TEXT REFERENCES core_users(id),
     created_at     TEXT NOT NULL,
     updated_at     TEXT NOT NULL
   );`,
  `CREATE INDEX IF NOT EXISTS ix_equipment_tags_status
     ON core_equipment_tags (company_id, status, public_id);`,
  `CREATE INDEX IF NOT EXISTS ix_equipment_tags_batch
     ON core_equipment_tags (batch_id);`,
  `CREATE INDEX IF NOT EXISTS ix_equipment_tags_equipment
     ON core_equipment_tags (equipment_id);`,

  // A identidade visual da plaquinha, POR EMPRESA.
  //
  // No sistema anterior isto morava no localStorage de cada navegador: dois
  // computadores da mesma oficina imprimiam plaquinhas diferentes, e ninguem
  // conseguia dizer qual era a certa. Aqui e do cadastro da empresa.
  //
  // A GEOMETRIA (onde a plaquinha cai na folha) continua no catalogo de
  // formatos, que sabe fazer a conta do modulo do QR. O que mora aqui e a
  // CARA: logo, cores, cantos e o tamanho em milimetro quando a empresa quer
  // o proprio.
  `CREATE TABLE IF NOT EXISTS core_equipment_tag_layouts (
     company_id      TEXT PRIMARY KEY REFERENCES core_companies(id) ON DELETE CASCADE,
     logo_url        TEXT,
     logo_x_mm       REAL NOT NULL DEFAULT 8,
     logo_y_mm       REAL NOT NULL DEFAULT 4,
     logo_w_mm       REAL NOT NULL DEFAULT 28,
     logo_h_mm       REAL NOT NULL DEFAULT 20,
     bg_color        TEXT NOT NULL DEFAULT '#ffffff',
     text_color      TEXT NOT NULL DEFAULT '#1a1a1a',
     rounded         INTEGER NOT NULL DEFAULT 1,
     width_mm        REAL NOT NULL DEFAULT 100,
     height_mm       REAL NOT NULL DEFAULT 40,
     margin_mm       REAL NOT NULL DEFAULT 4,
     updated_by      TEXT REFERENCES core_users(id),
     updated_at      TEXT NOT NULL
   );`,

  // ------------------------------------------------------------------ oficina
  // Ordem de serviço da Oficina. Vive no banco central para que o Kanban seja
  // o mesmo em todos os computadores — refresh e outro terminal enxergam o
  // mesmo estado.
  `CREATE TABLE IF NOT EXISTS core_service_orders (
     id                  TEXT PRIMARY KEY,
     company_id          TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     workshop_id         TEXT REFERENCES core_workshops(id),
     number              INTEGER NOT NULL,
     customer_id         TEXT REFERENCES core_customers(id),
     customer_name       TEXT,
     equipment_id        TEXT REFERENCES core_equipment(id),
     equipment           TEXT,
     plate               TEXT,
     complaint           TEXT,
     diagnosis           TEXT,
     status              TEXT NOT NULL DEFAULT 'em_aberto',
     mechanic_id         TEXT REFERENCES core_users(id),
     assigned_at         TEXT,
     -- Prioridade do quadro (rodada 51): urgente | alta | media | baixa.
     -- Decide a ordem dentro da coluna e a regua do SLA.
     priority            TEXT NOT NULL DEFAULT 'media',
     -- Prazo prometido ao cliente. E promessa de gente, nao derivado do SLA.
     due_date            TEXT,
     -- Quando a OS ENTROU na coluna atual — a base do relogio do SLA. O
     -- sistema anterior contava do updated_at, que reiniciava a cada
     -- comentario; esse defeito ficou la.
     status_changed_at   TEXT,
     opened_by_customer  INTEGER NOT NULL DEFAULT 0,
     has_cost            INTEGER,
     no_cost_reason      TEXT,
     labor_cents         INTEGER NOT NULL DEFAULT 0,
     parts_cents         INTEGER NOT NULL DEFAULT 0,
     total_cents         INTEGER NOT NULL DEFAULT 0,
     sale_id             TEXT REFERENCES core_sales(id),
     paid_at             TEXT,
     -- Dois tempos do orçamento (rodada 43): a oficina pede, o cliente aprova.
     approval_requested_at TEXT,
     approved_at         TEXT,
     closed_at           TEXT,
     created_by          TEXT,
     created_at          TEXT NOT NULL,
     updated_at          TEXT NOT NULL,
     UNIQUE (company_id, number)
   );`,
  `CREATE INDEX IF NOT EXISTS ix_service_orders_status
     ON core_service_orders (company_id, workshop_id, status, updated_at);`,

  // SLA da oficina (rodada 51) — a regua de reacao do quadro, POR EMPRESA.
  //
  // Uma linha por celula personalizada (status x prioridade); celula ausente
  // vale o padrao do codigo (DEFAULT_SLA em WorkshopSlaService). No sistema
  // anterior isto morava no localStorage de cada navegador e o quadro
  // discordava de si mesmo entre maquinas.
  `CREATE TABLE IF NOT EXISTS core_workshop_sla_configs (
     company_id TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     status     TEXT NOT NULL,
     priority   TEXT NOT NULL,
     hours      INTEGER NOT NULL,
     updated_at TEXT NOT NULL,
     PRIMARY KEY (company_id, status, priority)
   );`,

  // CHAMADO — o dono pedindo serviço de casa.
  //
  // NÃO é uma ordem de serviço, e a diferença não é burocrática: OS significa
  // "o aparelho está AQUI". Abrir OS a partir de um pedido feito do sofá faria
  // a plaquinha anunciar "Recebido pela oficina" para uma moto parada na
  // garagem — e, pior, apagaria da tela do dono o andamento da OS anterior,
  // porque a plaquinha mostra a OS mais recente.
  //
  // O chamado é uma FILA de intenção. Vira OS quando a oficina recebe o
  // aparelho, e é essa conversão que finalmente dá escritor ao
  // `opened_by_customer` de `core_service_orders`, que existia sem ninguém
  // preencher.
  `CREATE TABLE IF NOT EXISTS core_service_requests (
     id            TEXT PRIMARY KEY,
     company_id    TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     workshop_id   TEXT NOT NULL REFERENCES core_workshops(id) ON DELETE CASCADE,
     equipment_id  TEXT NOT NULL REFERENCES core_equipment(id) ON DELETE CASCADE,
     customer_id   TEXT NOT NULL REFERENCES core_customers(id),
     -- Quem abriu DE VERDADE: a conta do portal, e não um core_users
     -- inventado. São identidades diferentes e não devem se misturar.
     account_id    TEXT NOT NULL REFERENCES core_customer_accounts(id),
     description   TEXT NOT NULL,
     -- aberto | convertido | encerrado | cancelado
     status        TEXT NOT NULL DEFAULT 'aberto',
     order_id      TEXT REFERENCES core_service_orders(id),
     handled_by    TEXT REFERENCES core_users(id),
     handled_at    TEXT,
     resolution_note TEXT,
     created_at    TEXT NOT NULL,
     updated_at    TEXT NOT NULL
   );`,
  // Estes índices PODEM ficar aqui: a tabela nasce inteira nesta lista, então
  // as colunas já existem quando o índice roda. A proibição vale para índice
  // sobre coluna que só a migração acrescenta.
  `CREATE INDEX IF NOT EXISTS ix_service_requests_fila
     ON core_service_requests (company_id, workshop_id, status, created_at);`,
  `CREATE INDEX IF NOT EXISTS ix_service_requests_conta
     ON core_service_requests (account_id, created_at);`,

  // Timeline append-only da OS, no espírito de um cartão de Trello: vários
  // comentários com autor, data e anexos. Nada é sobrescrito.
  `CREATE TABLE IF NOT EXISTS core_service_order_comments (
     id           TEXT PRIMARY KEY,
     order_id     TEXT NOT NULL REFERENCES core_service_orders(id) ON DELETE CASCADE,
     company_id   TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     author_id    TEXT REFERENCES core_users(id),
     author_name  TEXT,
     author_kind  TEXT NOT NULL DEFAULT 'tecnico',
     body         TEXT NOT NULL,
     attachments  TEXT,
     status_at    TEXT,
     created_at   TEXT NOT NULL
   );`,
  `CREATE INDEX IF NOT EXISTS ix_order_comments
     ON core_service_order_comments (order_id, created_at);`,

  // FOTO DA OS (rodada 52) — o arquivo no disco, a linha aqui.
  //
  // O sistema anterior guardava a foto em base64 dentro do MESMO blob de
  // todas as ordens, no localStorage do navegador: duas fotos de celular
  // estouravam a cota e derrubavam a persistencia de TODAS as OS, nao so das
  // fotos. Aqui vale o desenho das fotos de produto (rodada 45): os bytes vao
  // para o disco do servidor, e o banco guarda o endereco.
  `CREATE TABLE IF NOT EXISTS core_service_order_photos (
     id          TEXT PRIMARY KEY,
     order_id    TEXT NOT NULL REFERENCES core_service_orders(id) ON DELETE CASCADE,
     company_id  TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     url         TEXT NOT NULL,
     file_name   TEXT,
     byte_size   INTEGER NOT NULL DEFAULT 0,
     -- O que a foto conta: a entrada do aparelho, o defeito, o serviço feito.
     kind        TEXT NOT NULL DEFAULT 'servico',
     caption     TEXT,
     uploaded_by TEXT REFERENCES core_users(id),
     created_at  TEXT NOT NULL
   );`,
  `CREATE INDEX IF NOT EXISTS ix_order_photos
     ON core_service_order_photos (order_id, created_at);`,

  // CHECKLIST DE ENTRADA (rodada 52) — o que chegou junto com o aparelho.
  //
  // NAO veio do sistema anterior: la existia so um checklist de TAREFAS
  // livre, digitado a mao, e nenhuma conferencia de entrada. Esta e a lista
  // que evita a discussao de balcao: "meu carregador veio junto", "a moto ja
  // tinha esse risco". Nasce com a OS, a partir do modelo da bancada.
  `CREATE TABLE IF NOT EXISTS core_service_order_checklist (
     id         TEXT PRIMARY KEY,
     order_id   TEXT NOT NULL REFERENCES core_service_orders(id) ON DELETE CASCADE,
     company_id TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     item       TEXT NOT NULL,
     -- 'pendente' (ninguem conferiu), 'sim' (veio junto / esta ok),
     -- 'nao' (nao veio / com avaria). Pendente e o unico que bloqueia.
     answer     TEXT NOT NULL DEFAULT 'pendente',
     note       TEXT,
     position   INTEGER NOT NULL DEFAULT 0,
     answered_by TEXT REFERENCES core_users(id),
     answered_at TEXT,
     created_at TEXT NOT NULL
   );`,
  `CREATE INDEX IF NOT EXISTS ix_order_checklist
     ON core_service_order_checklist (order_id, position);`,

  // Peça consumida na OS. A baixa de estoque usa o ledger comum, com
  // referência `service_order`, então continua valendo a regra de baixa única.
  `CREATE TABLE IF NOT EXISTS core_service_order_parts (
     id               TEXT PRIMARY KEY,
     order_id         TEXT NOT NULL REFERENCES core_service_orders(id) ON DELETE CASCADE,
     company_id       TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     product_id       TEXT NOT NULL REFERENCES core_products(id),
     description      TEXT NOT NULL,
     quantity         REAL NOT NULL CHECK (quantity > 0),
     unit_price_cents INTEGER NOT NULL,
     total_cents      INTEGER NOT NULL,
     -- Peça requisitada e não usada volta ao estoque. Sem esta coluna a peça
     -- some: o mecânico pega três parafusos, usa dois, e o terceiro nunca volta
     -- a existir no sistema.
     returned_quantity REAL NOT NULL DEFAULT 0,
     created_at       TEXT NOT NULL
   );`,

  // Histórico de movimentação no Kanban — quem moveu, de onde para onde.
  `CREATE TABLE IF NOT EXISTS core_service_order_events (
     id          TEXT PRIMARY KEY,
     order_id    TEXT NOT NULL REFERENCES core_service_orders(id) ON DELETE CASCADE,
     company_id  TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     from_status TEXT,
     to_status   TEXT NOT NULL,
     user_id     TEXT,
     note        TEXT,
     created_at  TEXT NOT NULL
   );`,

  // --------------------------------------------------------------- promoções
  // Preço promocional por período. O preço-base do produto NÃO é alterado —
  // acabada a promoção, o valor antigo volta sozinho. PDV e site leem daqui.
  `CREATE TABLE IF NOT EXISTS core_promotions (
     id            TEXT PRIMARY KEY,
     company_id    TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     product_id    TEXT REFERENCES core_products(id) ON DELETE CASCADE,
     category      TEXT,
     price_cents   INTEGER,
     percent_off   REAL,
     starts_at     TEXT NOT NULL,
     ends_at       TEXT,
     -- DIAS DA SEMANA (GAP-V03). "Toda quarta a fruta em oferta" exigia
     -- recriar a promoção a cada semana — só havia começo e fim.
     --
     -- Texto com os dígitos dos dias que valem, do domingo (0) ao sábado (6):
     -- '3' é toda quarta, '06' é fim de semana. NULO = todos os dias, que é o
     -- que TODA promoção já gravada significa — por isso a coluna não tem
     -- default nem NOT NULL: ausência já quer dizer a coisa certa.
     --
     -- Texto e não bitmask porque isto é lido por gente ao investigar um preço
     -- ("por que caiu hoje?"): '135' se explica sozinho no SELECT, 42 não.
     weekdays      TEXT,
     active        INTEGER NOT NULL DEFAULT 1,
     created_by    TEXT,
     created_at    TEXT NOT NULL,
     -- FAIXA DE HORÁRIO (GAP-PRD-194): 'HH:MM' no relógio da LOJA. Início
     -- inclusivo, fim exclusivo ("das 18:00 às 20:00"). NULO = o dia inteiro,
     -- que é o que toda promoção anterior significa. Não atravessa a
     -- meia-noite — o serviço recusa fim <= início.
     starts_time   TEXT,
     ends_time     TEXT,
     -- ESTOQUE PROMOCIONAL (GAP-PRD-194): quantas unidades, somando balcão e
     -- loja online, podem sair pelo preço da promoção. NULO = sem teto. O
     -- consumo é contado pelas linhas que gravaram promotion_id (venda não
     -- cancelada, pedido não cancelado).
     max_units     REAL,
     -- O GRÁTIS CONFIRMADO (GAP-PRD-032): 100 % ou preço zero só valem com
     -- confirmação explícita de quem criou. 0 = não confirmado — e toda
     -- promoção anterior a esta regra que dava o produto de graça deixa de
     -- valer no preço até alguém recriá-la confirmando.
     free_confirmed INTEGER NOT NULL DEFAULT 0,
     updated_at    TEXT,
     updated_by    TEXT
   );`,
  `CREATE INDEX IF NOT EXISTS ix_promotions_lookup
     ON core_promotions (company_id, product_id, active);`,

  // ------------------------------------------------- preço por quantidade
  //
  // FAIXA DE QUANTIDADE (GAP-V04): "3 por R$ 10", atacado por volume para o
  // cliente avulso. A tabela de preço da casa é por CLIENTE
  // (core_customers.price_table_id) e exige alguém identificado e vinculado;
  // quem chega no balcão levando doze não tem cadastro nenhum.
  //
  // A faixa é do PRODUTO e vale para qualquer comprador. Ela entra na disputa
  // do menor preço como mais um CANDIDATO calculado sobre a BASE — nunca sobre
  // o resultado dos outros. Ver PricingService: promoção, tabela e faixa são
  // três candidatos, e vence o menor. Empilhar os três seria erosão de margem
  // invisível.
  `CREATE TABLE IF NOT EXISTS core_product_price_tiers (
     id           TEXT PRIMARY KEY,
     company_id   TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     product_id   TEXT NOT NULL REFERENCES core_products(id) ON DELETE CASCADE,
     -- A partir de QUANTAS unidades esta faixa passa a valer. Real porque
     -- existe produto pesável e produto de unidade fracionada.
     min_quantity REAL NOT NULL CHECK (min_quantity > 0),
     -- Preço UNITÁRIO da faixa, em centavos inteiros. Unitário e não "preço do
     -- combo": o carrinho multiplica por quantidade em todo lugar, e um preço
     -- de combo obrigaria cada chamador a lembrar de não multiplicar.
     price_cents  INTEGER NOT NULL CHECK (price_cents >= 0),
     active       INTEGER NOT NULL DEFAULT 1,
     created_at   TEXT NOT NULL,
     updated_at   TEXT NOT NULL,
     -- Duas faixas com o mesmo piso são duas respostas para a mesma pergunta.
     UNIQUE (product_id, min_quantity)
   );`,

  // ------------------------------------------------ campos personalizados
  //
  // GAP-V07. Voltagem, aro, validade de garantia: atributo que só aquele
  // negócio tem e que não cabe em descrição nem em variant_attributes (esse é
  // da GRADE — o que distingue uma variante da outra, e cada valor dele vira
  // um produto próprio com EAN e saldo).
  //
  // A DEFINIÇÃO é por EMPRESA: a loja de roupa não vê o campo "aro" da de
  // moto. O VALOR é por produto. Duas tabelas, e não uma coluna JSON no
  // produto, porque a lista do que se pode preencher precisa existir mesmo
  // quando nenhum produto ainda foi preenchido — senão o campo só nasce depois
  // de alguém adivinhar o nome dele.
  `CREATE TABLE IF NOT EXISTS core_custom_fields (
     id          TEXT PRIMARY KEY,
     company_id  TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     -- Chave estável, em maiúsculas: é ela que o valor guarda. O rótulo pode
     -- ser corrigido sem órfãos, a chave não muda depois de criada.
     code        TEXT NOT NULL,
     label       TEXT NOT NULL,
     -- 'text' | 'number' | 'date' | 'select'. Só isso: tipo de mais vira
     -- validação que ninguém escreveu.
     kind        TEXT NOT NULL DEFAULT 'text',
     -- Opções do 'select', uma por linha. Nulo nos outros tipos.
     options     TEXT,
     -- A que se aplica: 'product' hoje. A coluna existe para a próxima
     -- entidade não precisar de outra tabela igual.
     entity      TEXT NOT NULL DEFAULT 'product',
     -- Ordem de exibição no formulário, para o cadastro não embaralhar a cada
     -- campo novo.
     position    INTEGER NOT NULL DEFAULT 0,
     active      INTEGER NOT NULL DEFAULT 1,
     created_at  TEXT NOT NULL,
     updated_at  TEXT NOT NULL,
     UNIQUE (company_id, entity, code)
   );`,
  `CREATE TABLE IF NOT EXISTS core_custom_field_values (
     id          TEXT PRIMARY KEY,
     company_id  TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     field_id    TEXT NOT NULL REFERENCES core_custom_fields(id) ON DELETE CASCADE,
     entity      TEXT NOT NULL DEFAULT 'product',
     entity_id   TEXT NOT NULL,
     -- Sempre texto. Number e date são formatos de ENTRADA, conferidos na
     -- gravação; guardá-los em colunas separadas obrigaria todo leitor a saber
     -- de qual coluna ler antes de saber o que perguntar.
     value       TEXT,
     updated_at  TEXT NOT NULL,
     UNIQUE (field_id, entity_id)
   );`,
  `CREATE INDEX IF NOT EXISTS ix_custom_values_entity
     ON core_custom_field_values (company_id, entity, entity_id);`,

  // ------------------------------------------------------------- e-commerce
  // Pedido da loja online. Separado da venda de balcão porque tem ciclo
  // próprio (pagamento assíncrono, separação, envio), mas usa o MESMO
  // catálogo, o MESMO estoque e o MESMO cliente das operações.
  `CREATE TABLE IF NOT EXISTS core_orders (
     id                TEXT PRIMARY KEY,
     company_id        TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     number            INTEGER NOT NULL,
     customer_id       TEXT REFERENCES core_customers(id),
     customer_name     TEXT NOT NULL,
     customer_email    TEXT,
     customer_document TEXT,
     shipping_zip      TEXT,
     shipping_address  TEXT,
     shipping_method   TEXT,
     shipping_cents    INTEGER NOT NULL DEFAULT 0,
     -- O que foi PROMETIDO ao cliente: nome do serviço, prazo, e se aquele
     -- prazo veio de transportadora real. Sem a última coluna não há como
     -- distinguir, depois, data cotada de data simulada.
     shipping_service_name   TEXT,
     shipping_estimated_days INTEGER,
     shipping_quote_real     INTEGER NOT NULL DEFAULT 0,
     items_cents       INTEGER NOT NULL DEFAULT 0,
     total_cents       INTEGER NOT NULL DEFAULT 0,
     status            TEXT NOT NULL DEFAULT 'aguardando_pagamento',
     payment_method    TEXT,
     payment_provider  TEXT,
     payment_ref       TEXT,
     paid_at           TEXT,
     sale_id           TEXT REFERENCES core_sales(id),
     idempotency_key   TEXT NOT NULL,
     tracking_code     TEXT,
     -- QUEM leva a encomenda (GAP-PRD-119): correios, jadlog, melhor_envio,
     -- generic (outra transportadora) ou propria (entrega da loja). Sem ela o
     -- código de rastreio é texto solto — ninguém sabe em que site procurá-lo,
     -- e o link do portal não tem para onde apontar. Nulo = pedido anterior ao
     -- campo, ou retirada.
     shipping_carrier  TEXT,
     -- A CONTA DO PORTAL QUE FECHOU ESTE PEDIDO (GAP-PRD-006/043). Nulo =
     -- pedido de visitante ou anterior à regra. O pedido feito por uma conta
     -- é DELA, e só dela: é esta coluna, e não o cadastro achado pelo CPF,
     -- que decide quem vê e quem cancela. O CPF digitado identifica o
     -- cadastro fiscal; não prova de quem é a compra. Sem REFERENCES de
     -- propósito: coluna acrescentada em banco existente não ganha chave
     -- estrangeira, e a DDL precisa ficar igual nos dois caminhos.
     customer_account_id TEXT,
     -- O RETRATO DOS ENDEREÇOS, EM COLUNAS (GAP-PRD-115). 'shipping_address'
     -- é a linha de texto (etiqueta, telas antigas); a NF-e quer logradouro,
     -- número, bairro, município COM código IBGE e UF em campos. É a CÓPIA do
     -- endereço da conta no momento da compra: editar ou apagar o endereço
     -- depois não muda o pedido. '*_address_id' só diz de onde veio (sem
     -- REFERENCES: o endereço pode ser apagado, o retrato fica). Nulos =
     -- pedido de visitante (endereço digitado em texto) ou anterior à regra.
     -- ENTREGA: para onde a mercadoria vai, e quem recebe.
     shipping_address_id     TEXT,
     shipping_recipient_name TEXT,
     shipping_street         TEXT,
     shipping_number         TEXT,
     shipping_complement     TEXT,
     shipping_district       TEXT,
     shipping_city           TEXT,
     shipping_state          TEXT,
     shipping_city_ibge      TEXT,
     -- FATURAMENTO: o endereço do destinatário da nota (sempre com IBGE —
     -- endereço sem IBGE não serve para faturar).
     billing_address_id      TEXT,
     billing_name            TEXT,
     billing_zip             TEXT,
     billing_street          TEXT,
     billing_number          TEXT,
     billing_complement      TEXT,
     billing_district        TEXT,
     billing_city            TEXT,
     billing_state           TEXT,
     billing_city_ibge       TEXT,
     -- A MERCADORIA DO PEDIDO REEMBOLSADO (GAP-PRD-122). Dinheiro e estoque
     -- são dois fatos: o reembolso deixa 'aguardando' (a mercadoria pode estar
     -- com o cliente, na transportadora ou no balcão), e só o recebimento
     -- conferido ('recebida', com a hora em return_goods_at) devolve saldo ao
     -- estoque. Nulo = nada a conferir (pedido não reembolsado ou anterior).
     return_goods_status     TEXT,
     return_goods_at         TEXT,
     -- O CUPOM DE DESCONTO (GAP-PRD-123). coupon_code é o RETRATO do código
     -- digitado (o cupom pode ser encerrado depois, o pedido continua dizendo
     -- qual foi); discount_cents é o desconto que ele deu NESTE pedido, já
     -- rateado nos itens (core_order_items.discount_cents). items_cents
     -- continua sendo a soma de core_order_items.total_cents — líquida do
     -- cupom —, e total = items + frete. O bruto é items_cents + discount_cents.
     coupon_id               TEXT,
     coupon_code             TEXT,
     discount_cents          INTEGER NOT NULL DEFAULT 0,
     created_at        TEXT NOT NULL,
     updated_at        TEXT NOT NULL,
     -- O QUE O CHECKOUT PEDIU A ESTA LOJA (RES-IDEM-VIZ): v1 + SHA-256 dos
     -- itens desta operacao, forma de pagamento, parcelas, entrega, cupom e
     -- comprador. O mesmo checkout com outro carrinho e recusado (422
     -- CORE_IDEMPOTENCY_KEY_REUSED) em vez de devolver este pedido calado.
     -- Nula = pedido anterior a coluna: o reenvio segue a regra antiga.
     idempotency_fingerprint TEXT,
     -- O QUE O CHECKOUT PEDIU AO CARRINHO INTEIRO (R2-IDEM): v1 + SHA-256 de
     -- todas as lojas — itens, quantidades, frete escolhido de cada uma,
     -- CEP e enderecos, pagamento, parcelas, cupom e comprador —, a MESMA em
     -- cada pedido do checkout. A mesma chave com a loja B tirada ou posta,
     -- ou com outro endereco, e recusada antes de reservar; o mesmo corpo
     -- devolve todos os pedidos. Nula = pedido anterior a coluna: vale a
     -- impressao por loja (idempotency_fingerprint), a regra de antes.
     checkout_fingerprint    TEXT,
     UNIQUE (company_id, idempotency_key),
     UNIQUE (company_id, number)
   );`,
  `CREATE INDEX IF NOT EXISTS ix_orders_company ON core_orders (company_id, status, created_at);`,

  // ------------------------------------------------- portal do cliente
  //
  // IDENTIDADE NÃO É CADASTRO COMERCIAL. `core_customers` é por operação — o
  // mesmo CPF na Gringa e no Preço Justo são dois cadastros, porque são duas
  // empresas. A PESSOA é uma só, e é ela que entra no portal.
  //
  // Por isso a conta vive fora de `core_customers`, com o e-mail como
  // identidade, e se liga a quantos cadastros forem dela.
  //
  // A conta também é separada de `core_users`, que é o acesso ADMINISTRATIVO:
  // misturar as duas faria uma sessão de cliente carregar escopo de PDV ou de
  // gerente por descuido de código.
  `CREATE TABLE IF NOT EXISTS core_customer_accounts (
     id            TEXT PRIMARY KEY,
     email         TEXT NOT NULL,
     password_hash TEXT NOT NULL,
     -- QUANDO a pessoa aceitou os termos e a política de privacidade
     -- (rodada 45). Consentimento sem registro não é consentimento: a LGPD
     -- pede prova de quando o aceite aconteceu. Nulo = conta anterior à
     -- exigência — não se inventa aceite retroativo.
     accepted_terms_at TEXT,
     -- QUANDO o e-mail provou dono (rodada 50) — código digitado ou link de
     -- redefinição usado. Nulo = não provou; e sem provar, a conta NÃO puxa
     -- pedidos por documento: e-mail alheio + CPF alheio davam o histórico
     -- de compras de outra pessoa a quem só CONHECIA os dois dados.
     email_verified_at TEXT,
     -- OS DADOS DA PESSOA, NA CONTA (GAP-PRD-133/205/028). Antes a conta só
     -- guardava e-mail e senha, e o perfil era lido do "primeiro" cadastro
     -- vinculado: conta sem vínculo salvava o nome em lugar nenhum e dizia
     -- "Dados atualizados."; conta com dois vínculos mostrava o nome de um
     -- deles. Nulos: conta anterior a esta regra não ganha dado inventado.
     -- DOCUMENT é o CPF/CNPJ que a PESSOA declarou — o checkout acha ou
     -- cria o cadastro da operação por ele, mas NÃO é prova de identidade:
     -- não vincula cadastro alheio nem se propaga para outras operações.
     name          TEXT,
     phone         TEXT,
     document      TEXT,
     -- A CONTA TEM SENHA? (GAP-PRD-027). A conta criada pelo "Entrar com
     -- Google" nasce SEM senha: password_hash guarda um marcador que
     -- nunca confere (não é Argon2 nem SHA-256) e esta coluna diz 0. O
     -- login por senha recusa com a mesma resposta genérica; a senha nasce
     -- pelo link de recuperação, que vai para a caixa já provada. 1 =
     -- toda conta anterior (todas nasceram com senha).
     has_password  INTEGER NOT NULL DEFAULT 1,
     active        INTEGER NOT NULL DEFAULT 1,
     last_login_at TEXT,
     created_at    TEXT NOT NULL,
     updated_at    TEXT NOT NULL,
     UNIQUE (email)
   );`,

  /**
   * Endereços salvos do cliente.
   *
   * Pertencem à CONTA, não ao cadastro por operação. A pessoa mora num lugar
   * só: se o endereço fosse do cadastro, comprar na Gringa e no Preço Justo
   * exigiria digitar tudo duas vezes, e atualizar a casa nova em um lugar
   * deixaria o outro entregando no endereço antigo.
   *
   * O pedido continua guardando o endereço COPIADO no momento da compra
   * (`core_orders.shipping_address`). É de propósito: mudar de casa não pode
   * reescrever para onde um pedido antigo foi entregue.
   */
  `CREATE TABLE IF NOT EXISTS core_customer_addresses (
     id          TEXT PRIMARY KEY,
     account_id  TEXT NOT NULL REFERENCES core_customer_accounts(id) ON DELETE CASCADE,
     label       TEXT,
     zip         TEXT NOT NULL,
     street      TEXT NOT NULL,
     number      TEXT,
     complement  TEXT,
     district    TEXT,
     city        TEXT NOT NULL,
     state       TEXT NOT NULL,
     -- A NF-e identifica o município do destinatário pelo código de 7 dígitos,
     -- não pelo nome. Sem esta coluna o endereço serve para ENTREGAR e não
     -- serve para FATURAR.
     city_ibge   TEXT,
     is_default  INTEGER NOT NULL DEFAULT 0,
     -- PARA QUE SERVE (GAP-PRD-115): 'entrega', 'faturamento' ou 'ambos'.
     -- Faturar exige o IBGE — o serviço recusa 'faturamento'/'ambos' sem ele.
     -- Nulo = endereço anterior à regra: vale 'ambos' se tem IBGE, senão
     -- 'entrega' (CustomerAccountService.tipoDoEndereco). Sem CHECK de
     -- propósito: coluna acrescentada por ALTER não levaria a constraint.
     kind           TEXT,
     -- Quem recebe no endereço (a portaria, a mãe). Nulo = o nome da conta.
     recipient_name TEXT,
     created_at  TEXT NOT NULL,
     updated_at  TEXT NOT NULL
   );`,
  `CREATE INDEX IF NOT EXISTS ix_customer_addresses_account
     ON core_customer_addresses (account_id, is_default DESC);`,

  // Os municípios do IBGE (IBGE-MUNICIPIOS): ver DDL_DOS_MUNICIPIOS_IBGE.
  DDL_DOS_MUNICIPIOS_IBGE,

  /*
    O CARRINHO DA CONTA (GAP-PRD-193). Vivia só no localStorage: trocar de
    aparelho perdia o carrinho, e entrar na conta não trazia o que foi montado
    no outro. Guarda produto e quantidade — NUNCA preço: o preço é lido da
    vitrine a cada leitura, como o checkout cobra. Uma linha por produto por
    conta; a fusão do login fica com a maior quantidade (CarrinhoDaContaService).
  */
  `CREATE TABLE IF NOT EXISTS core_customer_cart_items (
     account_id TEXT NOT NULL REFERENCES core_customer_accounts(id) ON DELETE CASCADE,
     product_id TEXT NOT NULL REFERENCES core_products(id) ON DELETE CASCADE,
     quantity   INTEGER NOT NULL,
     added_at   TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     PRIMARY KEY (account_id, product_id)
   );`,

  /**
   * Avaliações de produto — SÓ de quem comprou e recebeu.
   *
   * A avaliação aponta para o PEDIDO que a autoriza: é isso que "compra
   * verificada" significa aqui, e não um selo decorativo. Sem essa amarra, a
   * loja acumularia opiniões de quem nunca tocou no produto — e avaliação
   * fabricada destrói exatamente a confiança que a seção existe para criar.
   *
   * UNIQUE (account_id, product_id): uma avaliação por pessoa por produto.
   * Reavaliar EDITA a existente — dez compras não dão direito a dez votos,
   * senão quem compra sempre domina a nota.
   */
  `CREATE TABLE IF NOT EXISTS core_product_reviews (
     id           TEXT PRIMARY KEY,
     product_id   TEXT NOT NULL REFERENCES core_products(id) ON DELETE CASCADE,
     company_id   TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     account_id   TEXT NOT NULL REFERENCES core_customer_accounts(id) ON DELETE CASCADE,
     order_id     TEXT NOT NULL REFERENCES core_orders(id),
     rating       INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
     comment      TEXT,
     display_name TEXT NOT NULL,
     created_at   TEXT NOT NULL,
     updated_at   TEXT NOT NULL,
     UNIQUE (account_id, product_id)
   );`,
  `CREATE INDEX IF NOT EXISTS ix_reviews_product
     ON core_product_reviews (product_id, created_at DESC);`,

  /**
   * Como cada operação entrega.
   *
   * Existe porque havia só duas saídas e as duas eram ruins: cobrar frete
   * simulado (número que o sistema inventa quando não há transportadora
   * conectada) ou não cobrar frete nenhum — que é o que acontecia, com a
   * operação pagando o envio de cada venda online.
   *
   * A terceira saída é esta: o DONO declara a tabela dele. `flat_rate_cents` é
   * preço de gente, não estimativa de robô, e por isso pode ser cobrado hoje,
   * sem nenhuma credencial de transportadora. Quando a credencial existir, a
   * cotação real tem preferência.
   *
   * `free_above_cents` NULL = não há frete grátis. Zero seria "grátis sempre",
   * que é uma decisão comercial bem diferente de "não configurado".
   */
  /**
   * A fila de e-mail transacional.
   *
   * Existe para que a mensagem seja MONTADA no mesmo instante do fato — pedido
   * criado, pagamento confirmado, encomenda despachada — e só depois entregue.
   * Montar na hora do envio significaria ler de novo um pedido que pode ter
   * mudado, e mandar ao cliente uma confirmação de algo que já não é assim.
   *
   * Enquanto não houver credencial, tudo fica em `pending`: nada se perde e
   * nada sai. `blocked` é o e-mail que NUNCA deve sair (endereço inválido, por
   * exemplo) — separado de `failed`, que é para tentar de novo.
   *
   * `payload` guarda só o que a mensagem mostra. Segredo não entra aqui: a
   * fila é lida por tela de gestão, e o que está numa tela vaza em print.
   */
  /**
   * O COFRE DE ANEXOS — o arquivo mora aqui UMA vez, e não uma por mensagem.
   *
   * ## O DEFEITO QUE ESTA TABELA FECHA
   *
   * O zip do contador (até 15 MB) era gravado dentro de `core_email_queue`,
   * uma cópia POR DESTINATÁRIO: três contadores na mesma competência = três
   * cópias do MESMO arquivo, num banco operacional que tem 6,2 MB inteiro. A
   * agenda repete o gesto todo mês, para cada uma das seis empresas.
   *
   * ## O ID É O CONTEÚDO
   *
   * `id` é o sha256 de (empresa + bytes). Duas mensagens que carregam o mesmo
   * arquivo caem no mesmo id por construção — não existe "esqueci de
   * deduplicar", porque o INSERT do segundo é um `ON CONFLICT DO NOTHING`. A
   * empresa entra no hash de propósito: conteúdo idêntico de DUAS operações
   * não pode compartilhar linha, ou uma leria o cofre da outra.
   *
   * ## A RETENÇÃO
   *
   * O anexo vive enquanto houver mensagem PENDENTE que precise dele. Assim que
   * a última sai (ou desiste), os bytes são liberados por `liberarAnexosSemDono`
   * — que roda no FLUSH e no ENVIO, os dois eventos de verdade, no molde de
   * `expireOverdueQuotes` na abertura de caixa. Pendente nunca é podado: sem
   * credencial a fila acumula (é o estado honesto da casa), e apagar o anexo de
   * um pendente entregaria um e-mail dizendo "segue anexo" sem anexo.
   */
  `CREATE TABLE IF NOT EXISTS core_email_attachments (
     id           TEXT PRIMARY KEY,
     company_id   TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     nome         TEXT NOT NULL,
     size_bytes   INTEGER NOT NULL,
     conteudo     BLOB NOT NULL,
     created_at   TEXT NOT NULL
   );`,

  `CREATE TABLE IF NOT EXISTS core_email_queue (
     id           TEXT PRIMARY KEY,
     company_id   TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     template     TEXT NOT NULL,
     to_address   TEXT NOT NULL,
     subject      TEXT NOT NULL,
     body_text    TEXT NOT NULL,
     payload      TEXT NOT NULL,
     status       TEXT NOT NULL DEFAULT 'pending',
     attempts     INTEGER NOT NULL DEFAULT 0,
     last_error   TEXT,
     sent_at      TEXT,
     -- Uma mensagem por fato. Reenviar a confirmação do mesmo pedido a cada
     -- webhook repetido encheria a caixa do cliente e minaria a confiança na
     -- própria notificação.
     dedupe_key   TEXT NOT NULL,
     -- O NOME do anexo (GAP-V30) fica na mensagem, e os BYTES no cofre.
     --
     -- O nome sobrevive à faxina de propósito: depois de entregue, a tela do
     -- histórico continua respondendo "qual arquivo foi para o contador em
     -- julho?" sem carregar os megabytes de julho para sempre.
     anexo_nome   TEXT,
     -- O ponteiro para o cofre. Vira NULL quando os bytes são liberados —
     -- ponteiro pendurado seria uma mentira sobre o que o banco ainda tem.
     anexo_id     TEXT REFERENCES core_email_attachments(id),
     -- O BLOB ANTIGO, mantido só para ler mensagem enfileirada ANTES do cofre.
     -- Nada novo escreve aqui; o flush lê os dois lugares, e o legado se
     -- esvazia sozinho conforme a fila anda.
     anexo_blob   BLOB,
     created_at   TEXT NOT NULL,
     -- QUANDO a próxima tentativa pode sair (GAP-PRD-038). NULL = já pode.
     -- A falha espaça as tentativas (1, 5, 30, 120, 720 min) em vez de queimar
     -- todas em batidas seguidas: cinco minutos de SMTP fora não matam mais a
     -- recuperação de senha de ninguém. Nullable de propósito — o reconcile
     -- acrescenta a coluna em banco existente, e o pendente antigo (NULL) sai
     -- na primeira batida, como sempre saiu.
     next_attempt_at TEXT,
     UNIQUE (dedupe_key)
   );`,
  `CREATE INDEX IF NOT EXISTS ix_email_queue_pending
     ON core_email_queue (status, created_at);`,
  /*
    O CONTEÚDO PROTEGIDO DA MENSAGEM — fora da fila e fora da tela (GAP-PRD-007).

    O link de recuperação de senha e o código de verificação são segredos de
    uso único: quem os tiver toma a conta do cliente enquanto valerem. Eles
    moravam no `body_text` da fila, que é EXATAMENTE o que a tela do gerente
    lê — e o gerente de uma loja redefinia a senha de um cliente do grupo.

    Agora o corpo guardado na fila tem um MARCADOR no lugar do segredo, e o
    segredo mora aqui: selado pelo cofre (AES-256-GCM, `DEVORA_ENCRYPTION_KEY`),
    com prazo, e apagado no instante em que a mensagem sai, desiste ou vence.
    Só o carteiro abre, e só para montar o texto que vai ao cliente.

    `id` é o id da mensagem (no máximo uma linha por mensagem). As colunas
    `company_id`/`created_at`/`updated_at` existem porque o inventário do cofre
    (`secretsInventory.ts`) lê exatamente essas — é por ele que a rotação da
    chave ressela o que estiver pendente.
  */
  `CREATE TABLE IF NOT EXISTS core_email_segredos (
     id               TEXT PRIMARY KEY REFERENCES core_email_queue(id) ON DELETE CASCADE,
     company_id       TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     segredo_cifrado  TEXT NOT NULL,
     expira_em        TEXT NOT NULL,
     created_at       TEXT NOT NULL,
     updated_at       TEXT
   );`,
  /*
    QUEM ASSINA O E-MAIL DE CADA EMPRESA (GAP-PRD-198) — decisão do dono, com
    padrão seguro.

    O carteiro mandava tudo com o único `EMAIL_FROM` do ambiente: o cliente da
    Gringa recebia de "grupo@…", e a resposta dele caía numa caixa só. Qual das
    duas identidades vale é escolha do dono, empresa por empresa:

      - `grupo` (o padrão, e o que vale sem linha nenhuma): exatamente como
        sempre foi — remetente do ambiente, sem Reply-To, assinatura
        "<loja> — Grupo Sampaio";
      - `empresa`: o nome que o cliente vê no "De:", o Reply-To da loja (a
        resposta cai na caixa DELA), a assinatura própria e, se o provedor
        permitir enviar por ele, o endereço próprio.

    Nenhum segredo mora aqui: a credencial SMTP continua no ambiente.
  */
  `CREATE TABLE IF NOT EXISTS core_email_identidade (
     company_id          TEXT PRIMARY KEY REFERENCES core_companies(id) ON DELETE CASCADE,
     modo                TEXT NOT NULL DEFAULT 'grupo',
     nome_remetente      TEXT,
     endereco_remetente  TEXT,
     responder_para      TEXT,
     assinatura          TEXT,
     updated_by          TEXT,
     created_at          TEXT NOT NULL,
     updated_at          TEXT,
     CHECK (modo IN ('grupo', 'empresa'))
   );`,

  // ------------------------------------------------------------------------
  // O ENVIO DO PACOTE AO CONTADOR (GAP-V30/V31)
  //
  // Três tabelas pequenas, todas por empresa:
  //   - destinatários: para QUEM o mês vai (o escritório de contabilidade
  //     pode ter mais de um endereço, e endereço muda de contador);
  //   - agenda: QUANDO o mês sai sozinho (dia 1..28 — 29 em diante não existe
  //     em todo mês, e um agendamento que pula fevereiro é um mês esquecido);
  //   - envios: o HISTÓRICO — quem recebeu qual competência, quando, por qual
  //     caminho (manual/agenda). O ESTADO do envio não mora aqui de propósito:
  //     ele é derivado da fila de e-mail (`email_queue_id`), porque duas
  //     máquinas de estado para a mesma mensagem divergem no primeiro retry.
  // ------------------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS core_contador_destinatarios (
     id           TEXT PRIMARY KEY,
     company_id   TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     name         TEXT NOT NULL,
     email        TEXT NOT NULL,
     active       INTEGER NOT NULL DEFAULT 1,
     created_at   TEXT NOT NULL,
     updated_at   TEXT
   );`,
  `CREATE INDEX IF NOT EXISTS ix_contador_dest_company
     ON core_contador_destinatarios (company_id, active);`,
  `CREATE TABLE IF NOT EXISTS core_contador_agenda (
     company_id       TEXT PRIMARY KEY REFERENCES core_companies(id) ON DELETE CASCADE,
     day_of_month     INTEGER NOT NULL,
     active           INTEGER NOT NULL DEFAULT 0,
     -- A última competência que a AGENDA entregou ('AAAA-MM'). É a marca da
     -- idempotência por (empresa, competência): o tick só gera o mês que
     -- ainda não saiu — junto com o dedupe determinístico da fila, que segura
     -- até o caso do processo morrer entre o enfileirar e o marcar.
     last_sent_period TEXT,
     last_run_at      TEXT,
     last_error       TEXT,
     last_error_at    TEXT,
     created_at       TEXT NOT NULL,
     updated_at       TEXT,
     CHECK (day_of_month BETWEEN 1 AND 28)
   );`,
  `CREATE TABLE IF NOT EXISTS core_contador_envios (
     id               TEXT PRIMARY KEY,
     company_id       TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     period           TEXT NOT NULL,
     destinatario_id  TEXT REFERENCES core_contador_destinatarios(id),
     -- Nome e endereço COPIADOS no instante do envio: o cadastro muda, o
     -- histórico não — "para quem foi março?" tem de responder o endereço de
     -- março, não o de hoje.
     name             TEXT NOT NULL,
     email            TEXT NOT NULL,
     origem           TEXT NOT NULL,
     email_queue_id   TEXT REFERENCES core_email_queue(id),
     user_id          TEXT,
     created_at       TEXT NOT NULL,
     CHECK (origem IN ('manual', 'agenda'))
   );`,
  `CREATE INDEX IF NOT EXISTS ix_contador_envios_period
     ON core_contador_envios (company_id, period, created_at);`,

  // IDENTIDADE DA LOJA ONLINE, por operação.
  //
  // A vitrine mostrava só o nome fantasia da empresa e a contagem de produtos:
  // seis lojas do grupo apareciam iguais, sem nada que dissesse o que cada uma
  // vende. Quem administra não tinha onde escrever isso.
  //
  // O que NÃO entra aqui: catálogo. A autoridade sobre o que aparece na loja
  // continua sendo `core_products.publish_online` — uma lista paralela de
  // "produtos da vitrine" divergiria do cadastro no primeiro produto
  // despublicado, e a loja mostraria coisa que não se pode vender.
  `CREATE TABLE IF NOT EXISTS core_storefront_settings (
     company_id     TEXT PRIMARY KEY REFERENCES core_companies(id) ON DELETE CASCADE,
     headline       TEXT,
     description    TEXT,
     whatsapp       TEXT,
     -- Faixa de aviso da vitrine (frete grátis, horário de festa). Texto vazio
     -- ou desligada não aparece: faixa em branco ocupa espaço e não diz nada.
     banner_text    TEXT,
     banner_active  INTEGER NOT NULL DEFAULT 0,
     -- Identidade visual da página da marca (rodada 40): o LOGO do cabeçalho e
     -- a CAPA de apresentação. URL pública do arquivo em data/uploads/lojas —
     -- arquivo no disco, caminho no banco, nunca base64 em coluna.
     logo_url       TEXT,
     cover_url      TEXT,
     -- EM QUANTAS VEZES ESTA LOJA VENDE (rodada 56) — o selo de parcelamento.
     --
     -- NAO e a tabela core_acquirer_rates, e a diferenca e de lado da mesa: aquela
     -- guarda quanto a OPERADORA cobra da empresa e em quantos dias repassa —
     -- custo, nao oferta. Isto aqui e o que a loja ANUNCIA ao cliente, e a
     -- unica pessoa que sabe e o dono.
     --
     -- NULO e "nao anuncia parcelamento", e e o padrao. Sem esta coluna, um
     -- selo de "ate 12x" seria texto inventado no meio de uma pagina de
     -- compra — a promessa que o caixa nao honra.
     installments_max INTEGER,
     -- QUEM PODE FECHAR PEDIDO NESTA LOJA (GAP-PRD-028): 'conta' exige a
     -- sessão do portal com e-mail provado e cadastro completo; 'visitante'
     -- aceita também quem compra sem conta. NULO = 'conta', o padrão seguro:
     -- abrir para visitante é decisão do dono, tomada na tela da loja.
     checkout_mode  TEXT,
     updated_at     TEXT NOT NULL
   );`,

  `CREATE TABLE IF NOT EXISTS core_shipping_settings (
     company_id       TEXT PRIMARY KEY REFERENCES core_companies(id) ON DELETE CASCADE,
     pickup_enabled   INTEGER NOT NULL DEFAULT 1,
     delivery_enabled INTEGER NOT NULL DEFAULT 0,
     flat_rate_cents  INTEGER,
     free_above_cents INTEGER,
     estimated_days   INTEGER,
     updated_at       TEXT NOT NULL
   );`,

  /*
    Como a operação ENVIA pelo provedor (GAP-PRD-120). Duas decisões que mudam
    o que a etiqueta leva, com o padrão SEGURO:

      - `allow_content_declaration`: envio sem NF-e, com declaração de
        conteúdo. Empresa que despacha mercadoria vendida emite nota; se a
        declaração cabe na operação é pergunta para o CONTADOR. Nasce 0: sem
        nota autorizada, a etiqueta não é comprada.
      - `jadlog_agency_id`: a agência onde a Jadlog recebe a encomenda. O
        Melhor Envio exige para serviço Jadlog; sem ela, a compra é recusada
        com o nome do campo em vez de falhar no provedor.
  */
  `CREATE TABLE IF NOT EXISTS core_logistics_settings (
     company_id                TEXT PRIMARY KEY REFERENCES core_companies(id) ON DELETE CASCADE,
     allow_content_declaration INTEGER NOT NULL DEFAULT 0,
     jadlog_agency_id          TEXT,
     updated_by                TEXT,
     updated_at                TEXT NOT NULL
   );`,

  // Uma conta, N cadastros — um por operação onde a pessoa comprou.
  `CREATE TABLE IF NOT EXISTS core_customer_account_links (
     id          TEXT PRIMARY KEY,
     account_id  TEXT NOT NULL REFERENCES core_customer_accounts(id) ON DELETE CASCADE,
     customer_id TEXT NOT NULL REFERENCES core_customers(id) ON DELETE CASCADE,
     company_id  TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     created_at  TEXT NOT NULL,
     -- QUAL PROVA CRIOU ESTE VÍNCULO (GAP-PRD-006): 'convite' (papel do
     -- balcão), 'coprova' (cadastro com o e-mail PROVADO da conta e o
     -- documento informado), 'email' (cadastro sem documento com o e-mail
     -- provado), 'checkout' (cadastro que a própria conta criou ao comprar)
     -- ou 'documento' (propagado de um documento de convite). Só documento
     -- de vínculo 'convite'/'documento' se propaga para outras operações:
     -- CPF digitado não é prova, e propagá-lo entregava a quem digitou o CPF
     -- alheio os cadastros da vítima em todo o grupo. Nulo = vínculo anterior
     -- à regra, tratado como NÃO confiável para propagar (nunca é desfeito).
     proof       TEXT,
     UNIQUE (account_id, customer_id)
   );`,
  `CREATE INDEX IF NOT EXISTS ix_customer_links_account
     ON core_customer_account_links (account_id);`,

  // Sessão do portal, em tabela PRÓPRIA e com token opaco.
  //
  // Não é JWT e não é `api_sessions`: um token de cliente não pode nunca ser
  // aceito onde se espera um token administrativo, nem o contrário. Opaco
  // porque não há nada que a loja precise ler do token — o servidor consulta.
  `CREATE TABLE IF NOT EXISTS core_customer_sessions (
     id         TEXT PRIMARY KEY,
     account_id TEXT NOT NULL REFERENCES core_customer_accounts(id) ON DELETE CASCADE,
     expires_at TEXT NOT NULL,
     revoked    INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL
   );`,
  `CREATE INDEX IF NOT EXISTS ix_customer_sessions_account
     ON core_customer_sessions (account_id, revoked);`,

  /*
    Pedido de recuperação de senha do cliente.

    Guarda o SHA-256 do token, NUNCA o token — é credencial, e o mesmo cuidado
    do convite do portal vale aqui: quem lê o banco não pode redefinir a senha
    de ninguém. O token vai no e-mail (que a fila entrega quando houver SMTP);
    o que fica gravado é só a impressão digital para conferir na volta.

    `used_at` marca o consumo: um link de recuperação vale UMA vez. `expires_at`
    é curto — uma hora — porque link de senha que dura um dia é link que vaza
    num histórico de navegador e ainda funciona.
  */
  `CREATE TABLE IF NOT EXISTS core_customer_password_resets (
     id         TEXT PRIMARY KEY,
     account_id TEXT NOT NULL REFERENCES core_customer_accounts(id) ON DELETE CASCADE,
     token_hash TEXT NOT NULL,
     expires_at TEXT NOT NULL,
     used_at    TEXT,
     created_at TEXT NOT NULL
   );`,
  `CREATE INDEX IF NOT EXISTS ix_customer_pw_resets_account
     ON core_customer_password_resets (account_id);`,
  `CREATE INDEX IF NOT EXISTS ix_customer_pw_resets_hash
     ON core_customer_password_resets (token_hash);`,

  // "Esqueci minha senha" da EQUIPE (GAP-PRD-160) — decisão do dono por
  // operação, desligada por padrão (sem linha = desligada).
  `CREATE TABLE IF NOT EXISTS core_team_password_recovery_configs (
     company_id    TEXT PRIMARY KEY REFERENCES core_companies(id) ON DELETE CASCADE,
     email_enabled INTEGER NOT NULL DEFAULT 0,
     updated_by    TEXT,
     updated_at    TEXT NOT NULL
   );`,
  // O código de uso único: guarda-se o HMAC, nunca o código.
  `CREATE TABLE IF NOT EXISTS core_user_password_resets (
     id           TEXT PRIMARY KEY,
     user_id      TEXT NOT NULL REFERENCES core_users(id) ON DELETE CASCADE,
     code_hash    TEXT NOT NULL,
     attempts     INTEGER NOT NULL DEFAULT 0,
     expires_at   TEXT NOT NULL,
     used_at      TEXT,
     requested_ip TEXT,
     created_at   TEXT NOT NULL
   );`,
  `CREATE INDEX IF NOT EXISTS ix_user_pw_resets_user
     ON core_user_password_resets (user_id, created_at);`,

  /*
    OS TETOS DAS PORTAS PÚBLICAS DO PORTAL (GAP-PRD-192/116): criar conta e
    pedir recuperação de senha, contados por origem numa janela de uma hora.
    No banco, e não na memória do processo, para o teto sobreviver a um
    reinício. `chave` é o SHA-256 de (ação + origem) — o IP cru não é
    guardado; as linhas com mais de 24 h são apagadas a cada uso. Ver
    `PortalLimiteService`.
  */
  `CREATE TABLE IF NOT EXISTS core_portal_limites (
     id         TEXT PRIMARY KEY,
     acao       TEXT NOT NULL,
     chave      TEXT NOT NULL,
     created_at TEXT NOT NULL
   );`,
  `CREATE INDEX IF NOT EXISTS ix_portal_limites_chave
     ON core_portal_limites (acao, chave, created_at);`,
  `CREATE INDEX IF NOT EXISTS ix_portal_limites_created
     ON core_portal_limites (created_at);`,

  // O código que prova o e-mail (rodada 50) — o molde é o dos resets:
  // guarda-se o SHA-256, nunca o código; TTL curto; uso único.
  //
  // `link_document` é o documento da CO-PROVA do registro, esperando a
  // prova do e-mail: o vínculo dos pedidos só nasce quando o código volta
  // — antes disso, e-mail alheio + CPF alheio não entregam nada.
  `CREATE TABLE IF NOT EXISTS core_customer_email_verifications (
     id            TEXT PRIMARY KEY,
     account_id    TEXT NOT NULL REFERENCES core_customer_accounts(id) ON DELETE CASCADE,
     code_hash     TEXT NOT NULL,
     link_document TEXT,
     expires_at    TEXT NOT NULL,
     used_at       TEXT,
     created_at    TEXT NOT NULL
   );`,
  `CREATE INDEX IF NOT EXISTS ix_customer_email_verif_account
     ON core_customer_email_verifications (account_id);`,

  /*
    ENTRAR COM GOOGLE (GAP-PRD-027) — três tabelas novas, nenhuma coluna
    alheia além de `core_customer_accounts.has_password`.

    1. A CONFIGURAÇÃO É DA INSTALAÇÃO, não da operação: a conta do cliente é
       do grupo (uma pessoa, um login), e um cliente OAuth do Google só
       aceita os endereços de retorno cadastrados nele. Uma linha só
       (`id = 'google'`). `company_id` fica sempre nulo e existe para o
       inventário do cofre, que lê tabela relacional por
       (id, company_id, updated_at, created_at). O segredo do cliente OAuth
       vai SELADO (`secret_cipher`, AES-256-GCM) e nunca volta para a tela —
       só a dica dos quatro últimos caracteres.
       `provider_mode` = 'google' (o de verdade) ou 'teste' (o provedor que
       mora dentro da API, para ensaio sem Google); o servidor recusa o de
       teste em produção, em homologação e com NODE_ENV=production, na
       gravação E na execução.
  */
  `CREATE TABLE IF NOT EXISTS core_portal_google_login (
     id            TEXT PRIMARY KEY CHECK (id = 'google'),
     company_id    TEXT,
     enabled       INTEGER NOT NULL DEFAULT 0,
     provider_mode TEXT NOT NULL DEFAULT 'google' CHECK (provider_mode IN ('google', 'teste')),
     client_id     TEXT,
     secret_cipher TEXT,
     secret_hint   TEXT,
     redirect_uri  TEXT,
     updated_by    TEXT,
     created_at    TEXT NOT NULL,
     updated_at    TEXT NOT NULL
   );`,

  /*
    2. O PEDIDO DE AUTORIZAÇÃO EM VOO. Cada "Entrar com Google" grava aqui o
       que só o servidor pode saber: o verificador do PKCE, o nonce que o
       id_token tem de devolver, e as impressões digitais (SHA-256) do
       `state` e da chave do navegador que começou — o link de retorno
       aberto em OUTRO navegador não conclui nada (login CSRF). Uso único
       (`used_at`), vida curta (`expires_at`). Quando a pessoa ainda não tem
       conta e não aceitou os termos, a linha vira `aguardando_termos` e
       guarda a identidade JÁ VERIFICADA até o aceite (ticket de uso único).
       `account_id` sem REFERENCES de propósito: a linha é descartável e a
       conta que pediu o vínculo é conferida de novo na volta.
  */
  `CREATE TABLE IF NOT EXISTS core_portal_google_states (
     id               TEXT PRIMARY KEY,
     state_hash       TEXT NOT NULL UNIQUE,
     browser_key_hash TEXT NOT NULL,
     nonce            TEXT NOT NULL,
     code_verifier    TEXT NOT NULL,
     intent           TEXT NOT NULL CHECK (intent IN ('entrar', 'vincular')),
     account_id       TEXT,
     terms_accepted   INTEGER NOT NULL DEFAULT 0,
     return_to        TEXT,
     provider_mode    TEXT NOT NULL CHECK (provider_mode IN ('google', 'teste')),
     status           TEXT NOT NULL DEFAULT 'pendente'
                      CHECK (status IN ('pendente', 'aguardando_termos', 'concluido')),
     ticket_hash      TEXT,
     verified_issuer  TEXT,
     verified_sub     TEXT,
     verified_email   TEXT,
     verified_name    TEXT,
     expires_at       TEXT NOT NULL,
     used_at          TEXT,
     created_at       TEXT NOT NULL
   );`,
  `CREATE INDEX IF NOT EXISTS ix_portal_google_states_ticket
     ON core_portal_google_states (ticket_hash);`,
  `CREATE INDEX IF NOT EXISTS ix_portal_google_states_created
     ON core_portal_google_states (created_at);`,

  /*
    3. A IDENTIDADE EXTERNA LIGADA À CONTA. A chave é (emissor, sub): o
       `sub` é o identificador estável que o Google dá à pessoa — o e-mail
       dela lá pode mudar, o `sub` não. O EMISSOR entra na chave para que
       uma identidade do provedor de TESTE nunca se confunda com uma do
       Google de verdade (quem controla o provedor de teste escolhe o `sub`
       que quiser). Uma conta, no máximo uma identidade Google. Nenhum
       token do Google é guardado — nem de acesso, nem de atualização: o
       sistema só precisa saber QUEM é, uma vez por entrada.
  */
  `CREATE TABLE IF NOT EXISTS core_customer_identities (
     id            TEXT PRIMARY KEY,
     account_id    TEXT NOT NULL REFERENCES core_customer_accounts(id) ON DELETE CASCADE,
     provider      TEXT NOT NULL CHECK (provider IN ('google')),
     issuer        TEXT NOT NULL,
     subject       TEXT NOT NULL,
     email         TEXT,
     created_at    TEXT NOT NULL,
     last_login_at TEXT,
     UNIQUE (issuer, subject),
     UNIQUE (account_id, provider)
   );`,

  // Ponte entre o cliente DAQUI e o cliente lá no Asaas.
  //
  // O Asaas não é dono do cadastro: ele guarda uma cópia do que precisa para
  // cobrar. Esta tabela existe para não criar um cliente novo lá a cada
  // compra — e a UNIQUE por (empresa, cliente, ambiente) é o que garante isso
  // mesmo com dois checkouts simultâneos.
  //
  // O ambiente entra na chave porque o mesmo cliente tem ids diferentes em
  // sandbox e em produção: são duas contas Asaas distintas.
  `CREATE TABLE IF NOT EXISTS core_asaas_customers (
     id                TEXT PRIMARY KEY,
     company_id        TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     customer_id       TEXT NOT NULL REFERENCES core_customers(id) ON DELETE CASCADE,
     environment       TEXT NOT NULL,
     asaas_customer_id TEXT NOT NULL,
     created_at        TEXT NOT NULL,
     updated_at        TEXT NOT NULL,
     UNIQUE (company_id, customer_id, environment)
   );`,
  `CREATE INDEX IF NOT EXISTS ix_asaas_customers_remote
     ON core_asaas_customers (company_id, asaas_customer_id);`,

  `CREATE TABLE IF NOT EXISTS core_order_items (
     id               TEXT PRIMARY KEY,
     order_id         TEXT NOT NULL REFERENCES core_orders(id) ON DELETE CASCADE,
     company_id       TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     product_id       TEXT NOT NULL REFERENCES core_products(id),
     description      TEXT NOT NULL,
     quantity         REAL NOT NULL CHECK (quantity > 0),
     unit_price_cents INTEGER NOT NULL,
     total_cents      INTEGER NOT NULL,
     -- A parte do CUPOM que coube a esta linha (GAP-PRD-123). total_cents é
     -- LÍQUIDO dela: unit_price_cents × quantity − discount_cents. É assim que
     -- a NF-e do pedido declara vProd e vDesc por item, e que "produtos
     -- vendidos" soma a receita que de fato entrou.
     discount_cents   INTEGER NOT NULL DEFAULT 0,
     -- A promoção que deu o preço desta linha (GAP-PRD-194), quando foi ela —
     -- conta o saldo da promoção com teto de unidades. Mesmo motivo de
     -- core_sale_items.promotion_id para não ter REFERENCES.
     promotion_id     TEXT
   );`,
  `CREATE INDEX IF NOT EXISTS ix_order_items_order ON core_order_items (order_id);`,

  // --------------------------------------------- cupons de desconto (loja)
  //
  // GAP-PRD-123. O cupom é da LOJA ONLINE e de UMA empresa: o código digitado
  // no checkout desconta só o pedido da operação que o criou (carrinho de duas
  // lojas são dois pedidos). O desconto é sobre os ITENS — nunca sobre o frete
  // — e o pedido guarda o retrato (coupon_code, discount_cents), rateado nos
  // itens. Tabelas NOVAS: as CHECKs valem nos dois caminhos.
  `CREATE TABLE IF NOT EXISTS core_coupons (
     id            TEXT PRIMARY KEY,
     company_id    TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     -- Maiúsculas, sem espaço, 3 a 30 de [A-Z0-9_-]. A pessoa digita como
     -- quiser; o serviço normaliza antes de procurar.
     code          TEXT NOT NULL,
     description   TEXT,
     -- UM dos dois: percentual (0 < p < 100) ou valor fixo em centavos.
     percent_off   REAL CHECK (percent_off IS NULL OR (percent_off > 0 AND percent_off < 100)),
     amount_cents  INTEGER CHECK (amount_cents IS NULL OR amount_cents > 0),
     -- Pedido mínimo (itens depois das promoções, antes do frete).
     min_order_cents INTEGER NOT NULL DEFAULT 0 CHECK (min_order_cents >= 0),
     starts_at     TEXT NOT NULL,
     ends_at       TEXT,
     -- Usos no total e por cliente (conta; visitante pelo e-mail). NULO =
     -- sem teto. O serviço grava 1 por cliente quando nada é dito: uso único é
     -- o padrão seguro de um código que circula.
     max_uses      INTEGER CHECK (max_uses IS NULL OR max_uses > 0),
     max_uses_per_customer INTEGER CHECK (max_uses_per_customer IS NULL OR max_uses_per_customer > 0),
     -- 0 (padrão) = não cumulativo: o desconto só alcança item que NÃO está
     -- em promoção. 1 = vale sobre o preço já promovido também.
     accumulates_with_promotions INTEGER NOT NULL DEFAULT 0,
     active        INTEGER NOT NULL DEFAULT 1,
     created_by    TEXT,
     created_at    TEXT NOT NULL,
     ended_at      TEXT,
     ended_by      TEXT,
     CHECK ((percent_off IS NULL) <> (amount_cents IS NULL)),
     UNIQUE (company_id, code)
   );`,
  // Cada uso de um cupom, um por pedido. 'ativo' conta no teto; o pedido
  // cancelado (pelo cliente, pela loja ou pela reserva vencida) devolve o uso:
  // 'liberado'. Pedido pago e depois reembolsado continua 'ativo' — o cupom
  // foi usado.
  `CREATE TABLE IF NOT EXISTS core_coupon_redemptions (
     id             TEXT PRIMARY KEY,
     coupon_id      TEXT NOT NULL REFERENCES core_coupons(id) ON DELETE CASCADE,
     company_id     TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     order_id       TEXT NOT NULL REFERENCES core_orders(id) ON DELETE CASCADE,
     -- Quem usou: a conta, e o e-mail normalizado (é por ele que o visitante
     -- é contado). Sem REFERENCES na conta: ela pode ser apagada pela LGPD e o
     -- uso continua fato do pedido.
     account_id     TEXT,
     customer_email TEXT,
     discount_cents INTEGER NOT NULL CHECK (discount_cents > 0),
     status         TEXT NOT NULL DEFAULT 'ativo' CHECK (status IN ('ativo', 'liberado')),
     created_at     TEXT NOT NULL,
     released_at    TEXT,
     UNIQUE (order_id)
   );`,
  `CREATE INDEX IF NOT EXISTS ix_coupon_redemptions_coupon
     ON core_coupon_redemptions (coupon_id, status);`,

  `CREATE TABLE IF NOT EXISTS core_order_events (
     id         TEXT PRIMARY KEY,
     order_id   TEXT NOT NULL REFERENCES core_orders(id) ON DELETE CASCADE,
     company_id TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     status     TEXT NOT NULL,
     note       TEXT,
     user_id    TEXT,
     -- DE ONDE veio a mudança (GAP-PRD-119): 'operador' (gente da loja, com
     -- user_id), 'provedor' (a transportadora disse — postado, entregue),
     -- 'cliente' ou 'sistema'. "Entregue" dito pela transportadora e
     -- "entregue" clicado no balcão não valem o mesmo. Nulo = evento anterior
     -- ao campo: a origem não foi registrada, e não se inventa.
     origin     TEXT,
     created_at TEXT NOT NULL
   );`,

  /*
    O ENVIO DO PEDIDO — etiqueta, rastreio e eventos (GAP-PRD-119, GAP-PRD-120).

    Antes a expedição era mudança de status mais um código digitado num
    `window.prompt`; `logistics_shipments` e `logistics_labels` eram coleções
    sem escritor, e `POST /logistics/shipments` gravava qualquer corpo como
    "quoted", sem pedido e sem provedor.

    Um envio pertence a UM pedido. `channel` diz quem emitiu a etiqueta:
    'melhor_envio' (comprada pelo provedor, com `provider_ref`) ou 'manual'
    (postada fora do sistema, com o código informado no despacho). `carrier`
    é quem transporta. Só pode haver UM envio vivo por pedido — o índice
    parcial abaixo recusa o segundo, e o cancelado sai da conta.
  */
  `CREATE TABLE IF NOT EXISTS core_shipments (
     id                TEXT PRIMARY KEY,
     company_id        TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     order_id          TEXT NOT NULL REFERENCES core_orders(id) ON DELETE CASCADE,
     channel           TEXT NOT NULL,
     carrier           TEXT NOT NULL,
     provider_ref      TEXT,
     provider_protocol TEXT,
     service_code      TEXT,
     service_name      TEXT,
     -- 'sandbox' | 'production' para etiqueta do provedor; nulo no manual.
     environment       TEXT,
     -- pendente | paga | etiqueta_gerada | postado | entregue | nao_entregue | cancelado
     status            TEXT NOT NULL,
     tracking_code     TEXT,
     price_cents       INTEGER,
     invoice_key       TEXT,
     content_declaration INTEGER NOT NULL DEFAULT 0,
     -- A última falha de COMPRA (carrinho, pagamento, geração), com a frase
     -- do provedor. Nunca o token.
     last_error        TEXT,
     -- A última consulta de rastreio: quando, se deu certo e o que o provedor
     -- disse. É o que torna a falha do provedor VISÍVEL no ERP e no portal.
     last_sync_at      TEXT,
     last_sync_ok      INTEGER,
     last_sync_message TEXT,
     created_by        TEXT,
     dispatched_at     TEXT,
     dispatched_by     TEXT,
     delivered_at      TEXT,
     -- 'provedor' | 'operador': quem disse que chegou.
     delivered_origin  TEXT,
     cancelled_at      TEXT,
     idempotency_key   TEXT NOT NULL,
     created_at        TEXT NOT NULL,
     updated_at        TEXT NOT NULL,
     -- v1 + SHA-256 do pedido, do servico e do destinatario pedidos
     -- (RES-IDEM-VIZ): a mesma chave com outra etiqueta e recusada (422) em
     -- vez de devolver este envio. Nula = envio anterior a coluna.
     idempotency_fingerprint TEXT,
     UNIQUE (company_id, idempotency_key)
   );`,
  `CREATE INDEX IF NOT EXISTS ix_shipments_order ON core_shipments (company_id, order_id);`,
  `CREATE INDEX IF NOT EXISTS ix_shipments_sync ON core_shipments (channel, status, last_sync_at);`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_shipments_order_alive
     ON core_shipments (order_id) WHERE status <> 'cancelado';`,

  // O que aconteceu com a encomenda, com a ORIGEM de cada linha. A chave de
  // repetição impede que a mesma postagem, lida em duas consultas, vire duas
  // linhas na tela do cliente.
  `CREATE TABLE IF NOT EXISTS core_shipment_events (
     id           TEXT PRIMARY KEY,
     company_id   TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     shipment_id  TEXT NOT NULL REFERENCES core_shipments(id) ON DELETE CASCADE,
     order_id     TEXT NOT NULL REFERENCES core_orders(id) ON DELETE CASCADE,
     status       TEXT NOT NULL,
     description  TEXT NOT NULL,
     occurred_at  TEXT NOT NULL,
     origin       TEXT NOT NULL,
     user_id      TEXT,
     dedupe_key   TEXT NOT NULL,
     created_at   TEXT NOT NULL,
     UNIQUE (shipment_id, dedupe_key)
   );`,
  `CREATE INDEX IF NOT EXISTS ix_shipment_events_order
     ON core_shipment_events (order_id, occurred_at);`,

  // O PEDIDO DE DEVOLUÇÃO FEITO PELA CLIENTE NO PORTAL (GAP-PRD-125). Depois de
  // entregue, por arrependimento (7 dias do recebimento, CDC art. 49) ou por
  // defeito. A loja aprova ou recusa (com motivo que a cliente lê); o
  // reembolso pelo ERP conclui. `account_id` sem REFERENCES: a conta pode ser
  // apagada (LGPD) e a solicitação continua sendo fato do pedido.
  `CREATE TABLE IF NOT EXISTS core_order_return_requests (
     id            TEXT PRIMARY KEY,
     company_id    TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     order_id      TEXT NOT NULL REFERENCES core_orders(id) ON DELETE CASCADE,
     account_id    TEXT,
     kind          TEXT NOT NULL CHECK (kind IN ('arrependimento', 'defeito')),
     reason        TEXT NOT NULL,
     status        TEXT NOT NULL DEFAULT 'aberta'
                   CHECK (status IN ('aberta', 'aprovada', 'recusada', 'concluida')),
     decision_note TEXT,
     decided_by    TEXT,
     decided_at    TEXT,
     created_at    TEXT NOT NULL,
     updated_at    TEXT NOT NULL
   );`,
  `CREATE INDEX IF NOT EXISTS ix_order_return_requests_order
     ON core_order_return_requests (order_id, created_at);`,
  `CREATE INDEX IF NOT EXISTS ix_order_return_requests_company
     ON core_order_return_requests (company_id, status, created_at);`,

  // Cobranças de provedores externos (Asaas hoje). O pedido NUNCA é marcado
  // pago pelo frontend — só por confirmação vinda daqui.
  `CREATE TABLE IF NOT EXISTS core_payment_intents (
     id              TEXT PRIMARY KEY,
     company_id      TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     provider        TEXT NOT NULL,
     environment     TEXT NOT NULL DEFAULT 'sandbox',
     origin_type     TEXT NOT NULL,
     origin_id       TEXT NOT NULL,
     method          TEXT NOT NULL,
     amount_cents    INTEGER NOT NULL,
     status          TEXT NOT NULL DEFAULT 'pending',
     provider_ref    TEXT,
     qr_payload      TEXT,
     qr_image        TEXT,
     invoice_url     TEXT,
     last_error      TEXT,
     attempts        INTEGER NOT NULL DEFAULT 0,
     idempotency_key TEXT NOT NULL,
     confirmed_at    TEXT,
     created_at      TEXT NOT NULL,
     updated_at      TEXT NOT NULL,
     -- Última vez que o ERP PERGUNTOU ao provedor pelo status desta cobrança
     -- (GAP-PRD-016). A sincronização consulta primeiro as que estão há mais
     -- tempo sem pergunta — o webhook perdido não some do relatório.
     provider_checked_at TEXT,
     -- Cartão parcelado da loja online (GAP-PRD-114): em quantas vezes, e o
     -- id do PLANO no provedor — cada parcela vira uma cobrança lá, todas com
     -- o mesmo "installment", e é por ele que o webhook das parcelas 2..N
     -- encontra esta intenção. Nulos na cobrança à vista.
     installment_count INTEGER,
     provider_installment_ref TEXT,
     -- Vencimento enviado ao provedor (AAAA-MM-DD). É por ele que a reserva
     -- do pedido com boleto vive até o banco poder confirmar o pagamento
     -- (GAP-PRD-029, PrazoDaReserva). Nulo: cobrança anterior à regra — vale
     -- o D+1 da criação, que é o que o código sempre mandou.
     due_date        TEXT,
     -- O QUE A CHAVE DO CLIENTE PEDIU (RES-IDEM-VIZ). Hoje so o PIX do balcao
     -- grava (a referencia do QR vem da tela): v1 + SHA-256 de valor e
     -- pagador. A mesma referencia com outro valor e recusada (422) em vez de
     -- mostrar o QR antigo. Nula = cobranca de chave derivada pelo servidor,
     -- ou anterior a coluna: o reenvio segue a regra antiga.
     idempotency_fingerprint TEXT,
     UNIQUE (company_id, idempotency_key)
   );`,
  `CREATE INDEX IF NOT EXISTS ix_payment_intents_origin
     ON core_payment_intents (origin_type, origin_id);`,

  // Cada passada de sincronização das cobranças com o provedor (GAP-PRD-016):
  // quando rodou, quem pediu, quantas perguntou, o que mudou e o que falhou.
  // É o que deixa a tela da conciliação dizer DE QUANDO é a verdade que mostra.
  `CREATE TABLE IF NOT EXISTS core_asaas_sync_runs (
     id           TEXT PRIMARY KEY,
     company_id   TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     trigger      TEXT NOT NULL CHECK (trigger IN ('manual', 'automatico')),
     user_id      TEXT,
     started_at   TEXT NOT NULL,
     finished_at  TEXT,
     checked      INTEGER NOT NULL DEFAULT 0,
     changed      INTEGER NOT NULL DEFAULT 0,
     failed       INTEGER NOT NULL DEFAULT 0,
     skipped      INTEGER NOT NULL DEFAULT 0,
     unconfigured INTEGER NOT NULL DEFAULT 0,
     detail       TEXT
   );`,
  `CREATE INDEX IF NOT EXISTS ix_asaas_sync_runs_company
     ON core_asaas_sync_runs (company_id, started_at);`,

  // Webhook recebido. A UNIQUE do event_id é o que impede processar duas
  // vezes a mesma notificação do provedor.
  `CREATE TABLE IF NOT EXISTS core_payment_webhooks (
     id           TEXT PRIMARY KEY,
     provider     TEXT NOT NULL,
     event_id     TEXT NOT NULL,
     event_type   TEXT,
     payload      TEXT NOT NULL,
     processed    INTEGER NOT NULL DEFAULT 0,
     processed_at TEXT,
     error        TEXT,
     received_at  TEXT NOT NULL,
     -- Operação que o token (ou a URL) provou. Anulável: evento sem cobrança
     -- casada pelo token de ambiente não tem dono provado. É o que deixa a
     -- tela de Integrações dizer "o último aviso chegou em…" (GAP-PRD-002).
     company_id   TEXT,
     UNIQUE (provider, event_id)
   );`,

  // Reserva da chave de idempotência da cobrança na MAQUININHA (GAP-PRD-008).
  //
  // A transação de terminal mora numa coleção de documentos, que não tem
  // UNIQUE. O serviço fazia "busca a chave → await provedor → grava", e duas
  // requisições com a mesma chave passavam as duas pela busca: cobrança dupla
  // no cartão do cliente. Esta tabela é a fechadura: a chave é reservada AQUI,
  // na mesma transação de banco que cria a linha `in_progress`, ANTES de falar
  // com o provedor. A PRIMARY KEY é o que garante UMA cobrança por chave mesmo
  // entre dois processos.
  //
  // Sem FK para core_companies de propósito: as transações de terminal são da
  // camada de documentos, onde a empresa é só um texto, e a reserva segue a
  // linha que ela protege.
  `CREATE TABLE IF NOT EXISTS core_payment_terminal_charge_keys (
     company_id      TEXT NOT NULL,
     idempotency_key TEXT NOT NULL,
     transaction_id  TEXT NOT NULL,
     created_at      TEXT NOT NULL,
     PRIMARY KEY (company_id, idempotency_key)
   );`,

  // ------------------------------------- fila de comandos do agente local (TEF)
  // O navegador não fala com PinPad nem com cliente TEF (GAP-PRD-014). Quem
  // fala é o agente local instalado no computador do caixa, e ele PUXA o que
  // tem de fazer desta fila, assinando cada pedido com o segredo que recebeu
  // no pareamento. Relacional, e não documento, porque a retirada precisa ser
  // atômica: o comando `queued` que vence o prazo de retirada vira `expired`
  // (nada foi cobrado) na MESMA transação em que o agente o retiraria — os
  // dois nunca acontecem juntos.
  //
  // deliver_by: até quando o agente pode retirar. Passou sem retirar, é seguro
  //             dizer que o aparelho nunca viu a cobrança.
  // answer_by:  até quando, depois de retirado, a resposta tem de chegar.
  //             Passou, ninguém sabe o que o aparelho fez: a cobrança vira
  //             "não confirmada" e vai para a conferência do gestor.
  `CREATE TABLE IF NOT EXISTS core_payment_terminal_agent_commands (
     id               TEXT PRIMARY KEY,
     company_id       TEXT NOT NULL,
     agent_id         TEXT NOT NULL,
     configuration_id TEXT,
     pdv_terminal_id  TEXT,
     transaction_id   TEXT,
     command          TEXT NOT NULL
       CHECK (command IN ('startPayment','queryStatus','cancel','refund','reprint','health')),
     payload          TEXT NOT NULL DEFAULT '{}',
     status           TEXT NOT NULL DEFAULT 'queued'
       CHECK (status IN ('queued','delivered','answered','expired')),
     attempts         INTEGER NOT NULL DEFAULT 0,
     requested_by     TEXT,
     created_at       TEXT NOT NULL,
     deliver_by       TEXT NOT NULL,
     answer_by        TEXT,
     answer_window_ms INTEGER NOT NULL,
     delivered_at     TEXT,
     answered_at      TEXT,
     expired_at       TEXT,
     result_status    TEXT,
     result           TEXT
   );`,
  `CREATE INDEX IF NOT EXISTS ix_pt_agent_commands_agent
     ON core_payment_terminal_agent_commands (agent_id, status, created_at);`,
  `CREATE INDEX IF NOT EXISTS ix_pt_agent_commands_company
     ON core_payment_terminal_agent_commands (company_id, status, created_at);`,
  `CREATE INDEX IF NOT EXISTS ix_pt_agent_commands_tx
     ON core_payment_terminal_agent_commands (transaction_id);`,

  // Os "nonces" já usados por cada agente. A assinatura sozinha não impede que
  // alguém que capturou um pedido o REENVIE dentro da janela de cinco minutos
  // (um resultado "aprovado" repetido, um heartbeat forjado): a chave primária
  // faz o segundo uso do mesmo nonce ser recusado.
  `CREATE TABLE IF NOT EXISTS core_payment_terminal_agent_nonces (
     agent_id TEXT NOT NULL,
     nonce    TEXT NOT NULL,
     seen_at  TEXT NOT NULL,
     PRIMARY KEY (agent_id, nonce)
   );`,

  // ------------------------------------------ vendas offline recusadas (GAP-PRD-045/046)
  // A venda feita com o servidor da loja fora mora na fila do NAVEGADOR
  // (localStorage). Quando o servidor volta e RECUSA o reenvio (o caixa daquele
  // turno já fechou, o estoque acabou), o dinheiro já foi recebido: a venda
  // não pode ficar presa num computador que só aquele caixa enxerga. O PDV a
  // entrega aqui — com o corpo original e a MESMA chave de idempotência — e daí
  // em diante ela é do servidor: visível ao gestor e aos outros caixas, e
  // sobrevive à máquina do caixa. Sai por RELANÇAR (createSale com a mesma
  // chave, na gaveta aberta) ou por DESCARTAR (gerência, com motivo).
  `CREATE TABLE IF NOT EXISTS core_offline_sale_pendings (
     id               TEXT PRIMARY KEY,
     company_id       TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     idempotency_key  TEXT NOT NULL,
     label            TEXT,
     request_body     TEXT NOT NULL,
     received_cents   INTEGER NOT NULL DEFAULT 0,
     items_count      INTEGER NOT NULL DEFAULT 0,
     queued_at        TEXT,
     terminal_id      TEXT,
     cash_session_id  TEXT,
     status           TEXT NOT NULL DEFAULT 'pendente'
       CHECK (status IN ('pendente','regularizada','descartada')),
     error_code       TEXT,
     error_message    TEXT,
     attempts         INTEGER NOT NULL DEFAULT 1,
     reported_by      TEXT,
     reported_at      TEXT NOT NULL,
     last_reported_at TEXT NOT NULL,
     sale_id          TEXT,
     resolved_by      TEXT,
     resolved_at      TEXT,
     resolution_note  TEXT,
     UNIQUE (company_id, idempotency_key)
   );`,
  `CREATE INDEX IF NOT EXISTS ix_offline_sale_pendings_status
     ON core_offline_sale_pendings (company_id, status, cash_session_id);`,

  // ------------------------------------------------- autorizações do balcão
  // Ação restrita que um gestor liberou sem o operador sair do PDV. Separado
  // da auditoria geral porque é o que se consulta na conferência de caixa:
  // quem autorizou aquele desconto, e por quê.
  // A LIBERAÇÃO É UM BILHETE DE UMA VIAGEM SÓ, e as cinco colunas abaixo são o
  // que faz dela isso. Antes, a venda conferia a liberação por EXISTÊNCIA
  // (id + empresa + ação): o mesmo id servia para infinitas vendas seguintes,
  // de clientes diferentes, em dias diferentes — bastava o PDV guardar o id da
  // primeira vez que um gestor digitou a senha. E servia para QUALQUER valor:
  // o gestor liberava 15% e o operador vendia com 60% usando o mesmo bilhete.
  //
  //   granted_* : QUANTO foi liberado. Nulo = a liberação não declarou valor
  //               (é o caminho antigo do PDV) e vale para a concessão do
  //               documento que a consumir — uma vez.
  //   consumed_*: ONDE ela foi gasta. Preenchidas na MESMA transação do
  //               documento, o que torna impossível gastá-la duas vezes.
  //
  // O consumo é (tipo, id) e não `sale_id` porque quem gasta a liberação passou
  // a ser também o orçamento e a pré-venda: a concessão é conferida onde o
  // preço é ESCRITO, e não só onde ele é cobrado.
  //
  // ONDE A SENHA FOI DIGITADA — `terminal_id` e `ip`.
  //
  // A rota já recebia o IP e o JOGAVA FORA: `authorizeAction` tinha o parâmetro
  // `ip` na assinatura, a rota o preenchia com `req.ip`, e o INSERT abaixo não
  // tinha coluna para ele. Parâmetro que ninguém grava é pior que parâmetro
  // ausente, porque quem lê a chamada acredita que o dado ficou registrado.
  //
  // As duas respondem a pergunta que a conferência de caixa faz depois: a senha
  // do gerente foi digitada NO BALCÃO, com ele presente, ou de outra máquina?
  // `terminal_id` é o terminal da sessão de quem pediu (nulo quando a sessão é
  // de login comum, e nulo aqui é a verdade — não houve terminal); `ip` é o
  // endereço do SOCKET, e não o de um cabeçalho: `X-Forwarded-For` é a coisa
  // mais barata do mundo de forjar, e o mesmo motivo já está escrito em
  // `clientIp` no roteador de autenticação.
  `CREATE TABLE IF NOT EXISTS core_authorizations (
     id            TEXT PRIMARY KEY,
     company_id    TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     action        TEXT NOT NULL,
     requested_by  TEXT NOT NULL,
     authorized_by TEXT NOT NULL,
     reason        TEXT,
     detail        TEXT,
     reference_id  TEXT,
     granted_concession_cents INTEGER,
     granted_gross_cents      INTEGER,
     consumed_ref_type        TEXT,
     consumed_ref_id          TEXT,
     consumed_at              TEXT,
     terminal_id   TEXT,
     ip            TEXT,
     created_at    TEXT NOT NULL,
     -- O PORQUÊ, DITO POR GENTE (P0 da Preço Justo). reason é a frase que a
     -- tela monta com os números; justification é o motivo que o operador ou
     -- o gestor digitou. Obrigatório quando a operação liga
     -- core_sale_policies.discount_reason_required. Nulo em linha antiga e na
     -- liberação sem motivo das operações que não o exigem. Leitores: a venda
     -- que gasta a liberação (trilha sale.create) e a lista de liberações.
     justification TEXT
   );`,
  `CREATE INDEX IF NOT EXISTS ix_authorizations_company
     ON core_authorizations (company_id, created_at);`,

  // ---------------------------------------------------------------- auditoria
  `CREATE TABLE IF NOT EXISTS core_audit_log (
     id          TEXT PRIMARY KEY,
     company_id  TEXT,
     user_id     TEXT,
     action      TEXT NOT NULL,
     entity_type TEXT NOT NULL,
     entity_id   TEXT,
     detail      TEXT,
     ip          TEXT,
     created_at  TEXT NOT NULL
   );`,
  `CREATE INDEX IF NOT EXISTS ix_audit_company ON core_audit_log (company_id, created_at);`,

  // Numeração sequencial por empresa, usada para o número da venda.
  `CREATE TABLE IF NOT EXISTS core_sequences (
     company_id  TEXT NOT NULL,
     name        TEXT NOT NULL,
     current     INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (company_id, name)
   );`,

  // ----------------------------------------------------------------- fiscal
  //
  // Emissão fiscal do Grupo. NÃO confundir com NfeImportService, que lê o XML
  // que o FORNECEDOR emitiu contra nós: são direções opostas do mesmo papel.
  //
  // Cada operação emite com o próprio CNPJ. Não há emitente padrão e não há
  // fallback: usar o CNPJ do Preço Justo para faturar da Oficina é emitir nota
  // por quem não fez a venda.
  `CREATE TABLE IF NOT EXISTS core_fiscal_configs (
     company_id      TEXT PRIMARY KEY REFERENCES core_companies(id) ON DELETE CASCADE,
     legal_name      TEXT,
     trade_name      TEXT,
     cnpj            TEXT,
     ie              TEXT,
     im              TEXT,
     crt             TEXT,
     zip             TEXT,
     street          TEXT,
     number          TEXT,
     complement      TEXT,
     district        TEXT,
     city_name       TEXT,
     city_ibge       TEXT,
     uf              TEXT,
     phone           TEXT,
     -- 'homologation' | 'production'. Nasce em homologação: produção exige
     -- passo administrativo explícito, não um valor padrão distraído.
     environment     TEXT NOT NULL DEFAULT 'homologation',
     -- Só vira 1 depois de autorização real na homologação + confirmação.
     -- Uma variável de ambiente sozinha não libera.
     production_unlocked INTEGER NOT NULL DEFAULT 0,
     production_unlocked_at   TEXT,
     production_unlocked_by   TEXT,
     updated_at      TEXT NOT NULL
   );`,

  // A POLÍTICA DOS ATOS COM A SEFAZ (GAP-PRD-005): cancelamento, carta de
  // correção e inutilização usam o A1 do cofre (a senha selada, como a
  // emissão) ou exigem a senha DIGITADA a cada ato. Decisão do dono, com
  // padrão seguro: 0 = cofre — a senha não trafega pelo navegador nem passa
  // a ser sabida por quem cancela. Sem linha, vale o padrão.
  `CREATE TABLE IF NOT EXISTS core_fiscal_act_policies (
     company_id             TEXT PRIMARY KEY REFERENCES core_companies(id) ON DELETE CASCADE,
     require_typed_password INTEGER NOT NULL DEFAULT 0,
     updated_by             TEXT,
     updated_at             TEXT NOT NULL
   );`,

  // A NFC-e NO FINALIZAR (GAP-PRD-163): decisão do dono, por empresa. 'MANUAL'
  // (padrão — o painel do PDV oferece o botão) ou 'AUTOMATICA' (a nota sai
  // sozinha quando a prontidão DA VENDA está verde). Sem linha = MANUAL.
  `CREATE TABLE IF NOT EXISTS core_fiscal_emission_policies (
     company_id       TEXT PRIMARY KEY REFERENCES core_companies(id) ON DELETE CASCADE,
     nfce_on_finalize TEXT NOT NULL DEFAULT 'MANUAL'
                      CHECK (nfce_on_finalize IN ('MANUAL', 'AUTOMATICA')),
     updated_by       TEXT,
     updated_at       TEXT NOT NULL
   );`,

  // A NFS-e DA MÃO DE OBRA (GAP-PRD-024). A peça da OS é mercadoria (ICMS,
  // NFC-e); o serviço é ISS, e o documento dele é a NFS-e. Configuração por
  // empresa, decisão do dono com padrão seguro: 'DESLIGADA' (o sistema não
  // emite e a tela diz o que falta). 'EMISSOR_NACIONAL' = DPS assinada com o
  // A1 e enviada à Sefin Nacional; 'REGISTRO_MANUAL' = a nota é emitida no
  // portal e o número é registrado aqui. Os códigos (cTribNac, regime do
  // Simples, alíquota) são do contador.
  `CREATE TABLE IF NOT EXISTS core_nfse_configs (
     company_id               TEXT PRIMARY KEY REFERENCES core_companies(id) ON DELETE CASCADE,
     mode                     TEXT NOT NULL DEFAULT 'DESLIGADA',
     environment              TEXT NOT NULL DEFAULT 'homologation',
     service_code             TEXT,
     municipal_service_code   TEXT,
     nbs_code                 TEXT,
     service_description      TEXT,
     iss_rate                 TEXT,
     simples_option           TEXT,
     simples_regime           TEXT,
     special_regime           TEXT NOT NULL DEFAULT '0',
     iss_withholding          TEXT NOT NULL DEFAULT '1',
     dps_series               TEXT NOT NULL DEFAULT '1',
     next_dps_number          INTEGER NOT NULL DEFAULT 1,
     municipality_confirmed_at TEXT,
     municipality_confirmed_by TEXT,
     updated_by               TEXT,
     updated_at               TEXT NOT NULL
   );`,
  // Uma NFS-e por venda: a mão de obra da OS vira UM documento. A linha nasce
  // antes do envio (ENVIANDO) para que a queda no meio do caminho deixe rastro
  // e o reenvio use o MESMO número de DPS.
  `CREATE TABLE IF NOT EXISTS core_nfse_documents (
     id                 TEXT PRIMARY KEY,
     company_id         TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     sale_id            TEXT NOT NULL REFERENCES core_sales(id),
     service_order_id   TEXT,
     origin             TEXT NOT NULL,
     environment        TEXT NOT NULL,
     status             TEXT NOT NULL,
     service_cents      INTEGER NOT NULL,
     description        TEXT NOT NULL,
     taker_document     TEXT,
     taker_name         TEXT,
     dps_series         TEXT,
     dps_number         INTEGER,
     dps_id             TEXT,
     xml_dps            TEXT,
     access_key         TEXT,
     nfse_number        TEXT,
     verification_code  TEXT,
     xml_nfse           TEXT,
     reason             TEXT,
     issued_at          TEXT,
     cancelled_at       TEXT,
     cancel_reason      TEXT,
     created_by         TEXT,
     created_at         TEXT NOT NULL,
     updated_at         TEXT NOT NULL,
     UNIQUE (company_id, sale_id)
   );`,

  // A MODALIDADE DE CONTINGÊNCIA DA NFC-e (GAP-PRD-098): decisão do contador,
  // registrada pelo dono. 'AGUARDAR' (padrão seguro) = com a SEFAZ fora, a
  // nota espera na fila e nada sai com tpEmis 9; 'OFFLINE_NFCE' = a NFC-e é
  // montada em contingência off-line (tpEmis 9, dhCont, xJust) enquanto durar
  // o período, e deadline_hours é o prazo de transmissão que o contador
  // confirmou para a UF. Sem linha, vale o padrão.
  `CREATE TABLE IF NOT EXISTS core_fiscal_contingency_policies (
     company_id     TEXT PRIMARY KEY REFERENCES core_companies(id) ON DELETE CASCADE,
     mode           TEXT NOT NULL DEFAULT 'AGUARDAR',
     deadline_hours INTEGER,
     note           TEXT,
     updated_by     TEXT,
     updated_at     TEXT NOT NULL
   );`,

  // Os PERÍODOS de contingência da operação: quando entrou, por quê, com que
  // justificativa (o xJust das notas do período), quem ou o quê abriu e fechou,
  // e a última resposta da SEFAZ à sondagem. Um período ativo por empresa
  // (ended_at nulo) — o índice único parcial garante no banco.
  `CREATE TABLE IF NOT EXISTS core_fiscal_contingency_periods (
     id                TEXT PRIMARY KEY,
     company_id        TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     model             TEXT NOT NULL DEFAULT '65',
     reason            TEXT NOT NULL,
     justification     TEXT NOT NULL,
     started_at        TEXT NOT NULL,
     started_origin    TEXT NOT NULL,
     started_by        TEXT,
     trigger_code      TEXT,
     ended_at          TEXT,
     ended_origin      TEXT,
     ended_by          TEXT,
     last_probe_at     TEXT,
     last_probe_cstat  TEXT,
     last_probe_reason TEXT,
     created_at        TEXT NOT NULL,
     updated_at        TEXT NOT NULL
   );`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_fiscal_contingency_active
     ON core_fiscal_contingency_periods (company_id) WHERE ended_at IS NULL;`,

  // Numeração fiscal. É SERVER-SIDE e por (empresa, modelo, série): dois PDVs
  // não podem receber o mesmo número, e número queimado não volta.
  `CREATE TABLE IF NOT EXISTS core_fiscal_series (
     id            TEXT PRIMARY KEY,
     company_id    TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     model         TEXT NOT NULL,
     serie         INTEGER NOT NULL,
     next_number   INTEGER NOT NULL DEFAULT 1,
     active        INTEGER NOT NULL DEFAULT 1,
     created_at    TEXT NOT NULL,
     UNIQUE (company_id, model, serie)
   );`,

  // O documento fiscal.
  //
  // A chave única (company, model, serie, number) é a defesa real contra
  // numeração repetida: mesmo que a aplicação erre, o banco recusa.
  // A chave única em access_key faz o mesmo para a chave de 44 dígitos.
  `CREATE TABLE IF NOT EXISTS core_fiscal_documents (
     id              TEXT PRIMARY KEY,
     company_id      TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     -- A venda que originou. O fiscal REFERENCIA o fato econômico; não cria
     -- outro. Baixa de estoque e receita já aconteceram na venda.
     sale_id         TEXT REFERENCES core_sales(id),
     -- O pedido online que originou, quando a nota não vem de uma venda de
     -- balcão. Pedido NÃO É VENDA: tem financeiro próprio, já lançado quando o
     -- pagamento entrou. Transformá-lo em venda só para caber em sale_id
     -- lançaria a mesma receita duas vezes. Por isso a segunda coluna — e por
     -- isso exatamente uma das duas é preenchida.
     order_id        TEXT REFERENCES core_orders(id),
     model           TEXT NOT NULL,
     serie           INTEGER NOT NULL,
     number          INTEGER NOT NULL,
     access_key      TEXT,
     environment     TEXT NOT NULL,
     status          TEXT NOT NULL DEFAULT 'DRAFT',
     xml_original    TEXT,
     xml_signed      TEXT,
     xml_authorized  TEXT,
     protocol        TEXT,
     c_stat          TEXT,
     x_motivo        TEXT,
     qr_code         TEXT,
     contingency_mode TEXT,
     -- POR QUE entrou em contingência, DESDE QUANDO, e se ainda falta
     -- transmitir. Sem isso, um documento em contingência vira um mistério na
     -- auditoria meses depois.
     contingency_reason     TEXT,
     contingency_started_at TEXT,
     contingency_ended_at   TEXT,
     pending_transmission   INTEGER NOT NULL DEFAULT 0,
     trigger_code           TEXT,
     issued_at       TEXT,
     authorized_at   TEXT,
     cancelled_at    TEXT,
     -- Destinatário da NF-e: obrigatório no modelo 55 e ausente da venda de
     -- atacado. Fica em coluna porque a lista fiscal precisa dele sem abrir XML.
     recipient_name     TEXT,
     recipient_document TEXT,
     idempotency_key TEXT,
     created_at      TEXT NOT NULL,
     updated_at      TEXT NOT NULL,
     UNIQUE (company_id, model, serie, number),
     UNIQUE (access_key),
     UNIQUE (company_id, idempotency_key)
   );`,
  `CREATE INDEX IF NOT EXISTS ix_fiscal_docs_status
     ON core_fiscal_documents (company_id, status);`,
  `CREATE INDEX IF NOT EXISTS ix_fiscal_docs_sale
     ON core_fiscal_documents (sale_id);`,
  // O índice de `order_id` NÃO fica aqui: `ensureCoreSchema` roda ANTES das
  // migrations, e um CREATE INDEX sobre coluna que só a migração adiciona
  // derruba a subida de todo banco existente com "no such column". Ele
  // pertence ao passo 39.

  // Eventos: cancelamento, carta de correção, inutilização.
  //
  // APPEND-ONLY. O XML autorizado nunca é reescrito — a correção é um evento
  // que se soma a ele. Reescrever o autorizado apagaria o que a SEFAZ tem.
  `CREATE TABLE IF NOT EXISTS core_fiscal_events (
     id              TEXT PRIMARY KEY,
     company_id      TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     document_id     TEXT REFERENCES core_fiscal_documents(id),
     event_type      TEXT NOT NULL,
     sequence        INTEGER NOT NULL DEFAULT 1,
     justification   TEXT,
     protocol        TEXT,
     c_stat          TEXT,
     x_motivo        TEXT,
     xml             TEXT,
     -- O procEventoNFe ÍNTEGRO (GAP-V32), guardado no instante do evento.
     --
     -- (Sem crase nesta explicação: crase dentro do template literal do DDL
     -- fecha a string — a mordida conhecida da casa.)
     -- A coluna xml guarda o retorno passado por sanitizeResponse, que troca
     -- assinatura e certificado por "[removido]" — certo para LOG e tela, e
     -- fatal para ARQUIVAMENTO: a assinatura do evento é prova pública, não
     -- segredo. Esta coluna guarda o documento de arquivamento completo
     -- (evento assinado + retEvento), quando o adapter tem as duas metades.
     -- Evento antigo fica NULL para sempre — o que não foi guardado não
     -- existe, e o LEIA-ME do pacote declara a ressalva.
     xml_proc        TEXT,
     -- Inutilização não tem documento: é uma FAIXA de números queimada.
     model           TEXT,
     serie           INTEGER,
     number_from     INTEGER,
     number_to       INTEGER,
     user_id         TEXT,
     created_at      TEXT NOT NULL
   );`,
  `CREATE INDEX IF NOT EXISTS ix_fiscal_events_doc
     ON core_fiscal_events (document_id, created_at);`,

  // Fila de transmissão. Persistente porque o motivo de existir é justamente
  // sobreviver a queda de rede e de processo.
  `CREATE TABLE IF NOT EXISTS core_fiscal_queue (
     id              TEXT PRIMARY KEY,
     company_id      TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     document_id     TEXT NOT NULL REFERENCES core_fiscal_documents(id) ON DELETE CASCADE,
     operation       TEXT NOT NULL,
     status          TEXT NOT NULL DEFAULT 'pending',
     attempts        INTEGER NOT NULL DEFAULT 0,
     next_attempt_at TEXT,
     last_attempt_at TEXT,
     error_code      TEXT,
     error_message   TEXT,
     locked_until    TEXT,
     locked_by       TEXT,
     idempotency_key TEXT,
     created_at      TEXT NOT NULL,
     updated_at      TEXT NOT NULL,
     UNIQUE (company_id, idempotency_key)
   );`,
  `CREATE INDEX IF NOT EXISTS ix_fiscal_queue_due
     ON core_fiscal_queue (status, next_attempt_at);`,

  // ------------------------------------------------------------------ outbox
  //
  // Fila de saída para o banco central (Supabase/PostgreSQL).
  //
  // A arquitetura é híbrida por um motivo operacional, não por gosto: o PDV
  // precisa vender com a internet caída. O SQLite local continua sendo o banco
  // OPERACIONAL, com as transações e os invariantes onde sempre estiveram; a
  // Supabase é a central, que recebe os fatos quando a conexão volta.
  //
  // A linha do outbox é gravada DENTRO da mesma transação do fato. É isso que
  // fecha o buraco clássico: "gravou a venda mas caiu antes de publicar", que
  // faz a central divergir para sempre sem ninguém perceber. Se a transação
  // volta atrás, não sobra evento; se ela commita, o evento existe.
  //
  // `seq` é AUTOINCREMENT de propósito. Sem ele o SQLite reaproveita id de
  // linha apagada, e a ordem de reenvio passaria a intercalar fato novo com
  // fato antigo — numeração fiscal e saldo de estoque não sobrevivem a isso.
  //
  // A linha NÃO é apagada ao sincronizar: ganha `sent_at`. Apagar antes da
  // confirmação da central é a forma mais fácil de perder um fato de dinheiro.
  // O envelope é padronizado e VERSIONADO (`schema_version`). Sem versão no
  // evento, mudar o formato do payload no futuro quebraria a leitura dos
  // eventos antigos que ainda estiverem na fila ou já na central — e evento de
  // venda antiga não se regenera.
  //
  // `aggregate_type` / `aggregate_id` em vez de "tabela/linha": o que sobe é um
  // FATO DE NEGÓCIO, não uma linha de tabela. É o que permite a central ter um
  // schema próprio em vez de uma cópia do SQLite.
  //
  // `status` é explícito, não derivado de `sent_at`. `processing` existe para
  // que um worker que morreu no meio do envio seja distinguível de um evento
  // que nunca saiu — e `dead` para o que precisa de gente olhando.
  `CREATE TABLE IF NOT EXISTS core_outbox (
     seq                 INTEGER PRIMARY KEY AUTOINCREMENT,
     id                  TEXT NOT NULL UNIQUE,
     node_id             TEXT NOT NULL,
     event_type          TEXT NOT NULL,
     aggregate_type      TEXT NOT NULL,
     aggregate_id        TEXT NOT NULL,
     company_id          TEXT NOT NULL,
     operational_unit_id TEXT,
     operation           TEXT NOT NULL,
     schema_version      INTEGER NOT NULL DEFAULT 1,
     payload             TEXT NOT NULL,
     occurred_at         TEXT NOT NULL,
     status              TEXT NOT NULL DEFAULT 'pending',
     attempts            INTEGER NOT NULL DEFAULT 0,
     next_attempt_at     TEXT,
     last_error          TEXT,
     sent_at             TEXT,
     created_at          TEXT NOT NULL,
     -- De que natureza foi a última falha (GAP-PRD-047): 'TRANSPORTE' (a
     -- central não respondeu — tenta para sempre) ou 'RECUSA' (a central
     -- respondeu que não — conta para o limite e pode virar 'dead'). Nula
     -- em linha antiga; o reconcile a acrescenta em banco existente.
     last_error_kind     TEXT,
     CHECK (status IN ('pending', 'processing', 'synced', 'retry', 'dead'))
   );`,
  // OS ÍNDICES DO OUTBOX NÃO FICAM AQUI, e isso é deliberado.
  //
  // `status` e `aggregate_type` só existem a partir da migração 24. Um índice
  // na DDL canônica sobre coluna que a migração adiciona quebra o
  // `ensureCoreSchema()` de qualquer banco ainda na versão anterior — e
  // `ensureCoreSchema()` roda ANTES dos passos, então o banco trava sem nem
  // chegar na migração que resolveria.
  //
  // O projeto já pagou por isso uma vez; existe teste cobrando exatamente
  // este ponto ("a DDL canônica não cria índice sobre coluna que só a
  // migração adiciona"). Os índices do outbox são criados no passo 24, que
  // roda tanto em banco novo quanto em banco antigo.

  // ------------------------------------------------------------------ backup
  // O ESTADO DO BACKUP (GAP-PRD-011, GAP-PRD-058). Até aqui o único sinal de
  // que o diário rodou, subiu para o bucket ou copiou as fotos era uma linha
  // de log. Cada execução do diário vira uma linha aqui, com o resultado de
  // cada etapa — é daqui que a tela Configurações › Backup lê "quando foi a
  // última cópia" e "o que falhou". Tabelas globais (o banco é um só para as
  // seis empresas); nada de chave nem de URL do bucket, só nomes de objeto.
  `CREATE TABLE IF NOT EXISTS core_backup_execucoes (
     id                TEXT PRIMARY KEY,
     gatilho           TEXT NOT NULL,
     iniciado_em       TEXT NOT NULL,
     terminado_em      TEXT NOT NULL,
     local_estado      TEXT NOT NULL,
     local_arquivo     TEXT,
     local_bytes       INTEGER,
     local_detalhe     TEXT,
     mesmo_disco       INTEGER,
     remoto_estado     TEXT NOT NULL,
     remoto_objeto     TEXT,
     remoto_detalhe    TEXT,
     uploads_estado    TEXT NOT NULL,
     uploads_arquivos  INTEGER,
     uploads_enviados  INTEGER,
     uploads_bytes     INTEGER,
     uploads_manifesto TEXT,
     uploads_detalhe   TEXT,
     CHECK (gatilho IN ('boot', 'agenda', 'manual')),
     CHECK (local_estado IN ('ok', 'falhou', 'pulado')),
     CHECK (remoto_estado IN ('ok', 'falhou', 'nao_configurado', 'nao_tentado')),
     CHECK (uploads_estado IN ('enviado', 'sem_mudanca', 'vazio', 'falhou', 'nao_configurado', 'nao_tentado'))
   );`,
  `CREATE INDEX IF NOT EXISTS idx_core_backup_execucoes_inicio
     ON core_backup_execucoes (iniciado_em);`,
  // A IMPLANTAÇÃO DE CADA EMPRESA (GAP-PRD-067). O checklist é CALCULADO a
  // cada leitura pelas funções de cada domínio; o que se guarda aqui é só o que
  // gente decidiu: "confirmo que este dado está certo" (com a assinatura dos
  // valores confirmados — mudou depois, o item vira DIVERGENTE) e "não se aplica
  // a esta empresa" (com o motivo). Uma marca por item por empresa.
  `CREATE TABLE IF NOT EXISTS core_implantacao_marcas (
     company_id  TEXT NOT NULL REFERENCES core_companies(id) ON DELETE CASCADE,
     item        TEXT NOT NULL,
     tipo        TEXT NOT NULL,
     assinatura  TEXT,
     motivo      TEXT,
     user_id     TEXT,
     created_at  TEXT NOT NULL,
     PRIMARY KEY (company_id, item),
     CHECK (tipo IN ('CONFIRMADO', 'NAO_APLICAVEL'))
   );`,
  // Uma instância por arquivo de banco (GAP-PRD-137) — ver DDL_DA_INSTANCIA.
  DDL_DA_INSTANCIA,
  // A digital de cada arquivo enviado por gente (foto, logo), para o diário não
  // reler e re-hashear o catálogo inteiro todo dia: arquivo com o mesmo
  // tamanho e a mesma data de modificação reaproveita o sha256 guardado.
  `CREATE TABLE IF NOT EXISTS core_backup_uploads (
     caminho       TEXT PRIMARY KEY,
     bytes         INTEGER NOT NULL,
     modificado_em TEXT NOT NULL,
     sha256        TEXT NOT NULL,
     visto_em      TEXT NOT NULL
   );`,
  // O que JÁ ESTÁ no bucket, por conteúdo: o envio das fotos é incremental,
  // um objeto por sha256. `destino` é a digital de (URL, bucket) — trocar de
  // bucket reenvia tudo, em vez de acreditar que o novo já tem.
  `CREATE TABLE IF NOT EXISTS core_backup_objetos_remotos (
     destino    TEXT NOT NULL,
     sha256     TEXT NOT NULL,
     bytes      INTEGER NOT NULL,
     enviado_em TEXT NOT NULL,
     PRIMARY KEY (destino, sha256)
   );`,
];

let ready = false;

export function ensureCoreSchema(): void {
  if (ready) return;
  withTransaction(() => {
    const db = getConnection();
    for (const statement of STATEMENTS) db.exec(statement);
  });
  ready = true;
}

export function resetCoreSchemaCache(): void {
  ready = false;
}

/**
 * O esquema do núcleo já foi garantido neste processo? A referência do
 * esquema (GAP-PRD-140) monta um banco novo com a conexão emprestada, e o
 * `ensureCoreSchema` que os passos chamam não pode deixar a marca de "pronto"
 * valendo para o banco da API quando só a referência o recebeu.
 */
export function coreSchemaEmCache(): boolean {
  return ready;
}

/** Tabelas core em ordem segura para truncamento (filhos antes dos pais). */
export const CORE_TABLES_IN_DELETE_ORDER = [
  // A fila de saída primeiro: ela não é apontada por ninguém, e deixá-la para
  // trás faria um teste enxergar os eventos do teste anterior.
  'core_outbox',
  // O estado do backup não aponta nem é apontado por ninguém.
  'core_backup_execucoes',
  // O dono do banco (GAP-PRD-137), idem.
  'core_instancia',
  // As marcas da implantação (GAP-PRD-067) só apontam para core_companies,
  // que é a última da lista. Faltava aqui, e o reset dos testes deixava as
  // marcas de um caso para o seguinte.
  'core_implantacao_marcas',
  'core_backup_uploads',
  'core_backup_objetos_remotos',
  // Fiscal primeiro: a fila aponta para o documento, o documento aponta para a
  // venda. Apagar a venda antes derrubaria a chave estrangeira.
  // A NFS-e aponta para a venda (GAP-PRD-024); a configuração, só para a empresa.
  'core_nfse_documents',
  'core_nfse_configs',
  'core_fiscal_queue',
  'core_fiscal_events',
  'core_fiscal_documents',
  'core_fiscal_series',
  'core_fiscal_act_policies',
  'core_fiscal_emission_policies',
  'core_fiscal_contingency_periods',
  'core_fiscal_contingency_policies',
  'core_fiscal_configs',
  // Configuração por empresa, no mesmo molde da fiscal: só aponta para
  // core_companies, que é a última da lista.
  'core_inbound_configs',
  // Mesmo molde: só aponta para core_companies, que é a última da lista.
  'core_sale_policies',
  // O limite de desconto por perfil: só aponta para a empresa, mesmo molde.
  'core_discount_limits',
  // A política de gestão (GAP-PRD-165/166): uma linha por empresa, mesmo molde.
  'core_management_policies',
  'core_workshop_sla_configs',
  'core_payment_webhooks',
  // Passadas de sincronização com o provedor: só apontam para a empresa.
  'core_asaas_sync_runs',
  'core_payment_intents',
  // Não aponta para ninguém (a transação que ela protege é documento). Sem ela
  // aqui, cada teste herdaria as chaves reservadas do anterior.
  'core_payment_terminal_charge_keys',
  // Mesma família (GAP-PRD-014): apontam para documentos — agente, transação —
  // e não para tabela relacional.
  'core_payment_terminal_agent_commands',
  'core_payment_terminal_agent_nonces',
  'core_offline_sale_pendings',
  // O histórico de envios ao contador aponta para a fila de e-mail E para o
  // cadastro de destinatários — filho antes dos DOIS pais.
  'core_contador_envios',
  'core_contador_destinatarios',
  'core_contador_agenda',
  // Portal antes do pedido e do cliente: sessão e vínculo apontam para a
  // conta, e o vínculo aponta para o cadastro. A avaliação vem primeiro ainda,
  // porque aponta para conta E pedido.
  // O conteúdo protegido aponta para a mensagem — filho antes do pai.
  'core_email_segredos',
  // A identidade do remetente só aponta para a empresa (GAP-PRD-198).
  'core_email_identidade',
  'core_email_queue',
  // O cofre de anexos vem DEPOIS da fila: é ela quem aponta para ele.
  'core_email_attachments',
  'core_storefront_settings',
  'core_shipping_settings',
  'core_logistics_settings',
  'core_product_reviews',
  'core_customer_sessions',
  'core_customer_password_resets',
  // Os tetos das portas do portal (GAP-PRD-192/116) não apontam para ninguém.
  'core_portal_limites',
  // O código de verificação aponta para a conta — filho antes do pai.
  'core_customer_email_verifications',
  // Entrar com Google (GAP-PRD-027): a identidade aponta para a conta; o
  // pedido em voo e a configuração não apontam para ninguém.
  'core_customer_identities',
  'core_portal_google_states',
  'core_portal_google_login',
  'core_customer_addresses',
  // Os municípios do IBGE (IBGE-MUNICIPIOS) não apontam nem são apontados.
  'core_ibge_municipios',
  // O carrinho da conta (GAP-PRD-193) aponta para a conta e para o produto.
  'core_customer_cart_items',
  'core_customer_account_links',
  // O chamado aponta para SEIS tabelas — empresa, oficina, equipamento,
  // cliente, conta do portal e a OS em que virou. A conta do portal é a que
  // vem primeiro na lista, então é ela que manda a posição.
  'core_service_requests',
  'core_customer_accounts',
  'core_asaas_customers',
  // O evento do envio aponta para o envio E para o pedido; o envio, para o
  // pedido. Os dois saem antes de core_orders.
  'core_shipment_events',
  'core_shipments',
  // O uso do cupom aponta para o pedido E para o cupom (GAP-PRD-123) — sai
  // antes dos dois; o cupom só aponta para a empresa.
  'core_coupon_redemptions',
  'core_coupons',
  // O pedido de devolução pelo portal (GAP-PRD-125/031) aponta para o pedido
  // e para a empresa — filho antes do pai.
  'core_order_return_requests',
  'core_order_events',
  'core_order_items',
  'core_orders',
  'core_promotions',
  'core_service_order_comments',
  'core_service_order_events',
  'core_service_order_parts',
  // Foto e checklist apontam para a OS — filhos antes do pai (rodada 52).
  'core_service_order_photos',
  'core_service_order_checklist',
  'core_service_orders',
  'core_equipment_events',
  // A foto da máquina (GAP-PRD-106) aponta para o equipamento; sai antes dele.
  'core_equipment_photos',
  // O pool da plaquinha aponta para o equipamento; sai antes dele.
  'core_equipment_tags',
  'core_equipment_tag_layouts',
  // ANTES de core_equipment, não só antes de core_products.
  //
  // A unidade aponta para QUATRO tabelas — produto, local de estoque,
  // equipamento e empresa — e quando ela entrou, na rodada do estoque
  // serializado, eu só contei duas. Ficou lá embaixo, perto dos produtos, e o
  // equipamento passou a ser apagado 71 posições ANTES de quem aponta para ele.
  //
  // Não estourou porque `equipment_id` ainda nasce nulo em todo lugar: a ponte
  // moto-do-estoque ↔ equipamento-com-plaquinha é a rodada que vem. O primeiro
  // teste a gravar essa coluna é que teria descoberto, com FOREIGN KEY no
  // `resetDbForTests` do arquivo SEGUINTE — o pior lugar para descobrir, porque
  // a falha aparece longe de quem a causou.
  //
  // A regra da lista é uma só: filho antes de pai, e "pai" é CADA referência,
  // não a mais óbvia.
  // A reserva de unidade aponta para a unidade e para o documento (GAP-PRD-111).
  'core_product_unit_holds',
  'core_product_units',
  'core_equipment',
  'core_workshop_members',
  // Antes dos produtos: a contagem aponta para o produto contado.
  'core_inventory_count_items',
  'core_inventory_counts',
  // Antes de core_customers, core_sales e das devoluções: a razão de pontos
  // aponta para os três.
  'core_loyalty_entries',
  'core_loyalty_programs',
  // Antes de core_customers — e das VENDAS e DEVOLUÇÕES, que a origem
  // referencia por (origin_type, origin_id). A ordem é a mesma da razão de
  // pontos logo acima, porque a razão de crédito aponta para as mesmas tabelas.
  'core_customer_credits',
  // Antes de core_products e core_customers: o contrato aponta para os dois.
  'core_rental_contract_items',
  'core_rental_contracts',
  // Antes de core_customers e core_sales: a oportunidade aponta para os dois,
  // e o lead aponta para o cliente em que virou.
  'core_opportunities',
  'core_leads',
  // Antes de core_workshops: a razão de estoque referencia a oficina que
  // consumiu a peça. Apagar a oficina primeiro derruba a chave estrangeira.
  'core_stock_movements',
  // DEPOIS de core_stock_movements, e ANTES de core_products e de
  // core_stock_locations: o lote é PAI do movimento (batch_id) e FILHO do
  // produto e do local. A regra da lista é filho antes de pai, e "pai" é CADA
  // referência — foi assim que `core_product_units` acabou 71 posições no
  // lugar errado.
  'core_product_batches',
  // DEVOLUÇÃO AO FORNECEDOR (GAP-PRD-089): ANTES de core_finance_entries (o
  // documento aponta o título que abateu ou o crédito que criou), de
  // core_inbound_notes, core_products e core_suppliers. Registrada no mesmo
  // gesto em que as tabelas nasceram.
  'core_supplier_return_items',
  'core_supplier_returns',
  // Antes das baixas: a linha do extrato aponta para a baixa que ela casou.
  'core_bank_statement_lines',
  'core_bank_statements',
  // A memória do Idempotency-Key da baixa (GAP-PRD-173): só aponta para
  // core_companies, que é a última da lista.
  'core_finance_settle_requests',
  // O reembolso da devolução aponta para o lançamento, a gaveta, a venda e a
  // devolução: sai antes de todos eles.
  'core_sale_return_refunds',
  'core_finance_settlements',
  // COMISSÃO ANTES DO FINANCEIRO E DA VENDA: o fechamento aponta para o
  // lançamento a pagar, e a linha apurada aponta para a venda. Apagar o
  // financeiro primeiro derruba a chave estrangeira — foi exatamente o que o
  // teste pegou quando estas cinco entraram no fim da lista.
  'core_commission_closings',
  'core_commission_entries',
  'core_commission_members',
  'core_commission_tiers',
  'core_commission_groups',
  // Operadora antes do financeiro: a taxa aponta para a conta de depósito.
  'core_acquirer_rates',
  'core_acquirers',
  'core_finance_entries',
  // CONSIGNAÇÃO, e as três na ordem filho→pai (GAP-V65).
  //
  // O evento aponta para a consignação E para core_sales (o faturamento
  // parcial), então precisa sair antes das duas. O item aponta para a
  // consignação e para core_products. A consignação aponta para core_companies
  // e core_customers — as duas ficam lá no fim da lista.
  //
  // Registradas aqui NO MESMO gesto em que as tabelas nasceram, que é a lição
  // das sete tabelas de tabela de preços: fora da lista, o reset nunca as
  // esvazia e o arquivo de teste SEGUINTE estoura FOREIGN KEY, longe de quem
  // causou.
  'core_consignment_events',
  'core_consignment_items',
  'core_consignments',
  // Antes de core_sales: o documento convertido aponta para a venda.
  'core_quote_items',
  'core_quotes',
  'core_sale_payments',
  // Antes de core_sales e de core_products: o rastro aponta para os dois.
  'core_sale_removed_items',
  // Antes da devolução: a chave do pedido aponta para ela.
  'core_sale_return_requests',
  // Antes dos itens da venda: a devolução aponta para o item devolvido.
  'core_sale_return_items',
  'core_sale_returns',
  'core_sale_items',
  'core_sales',
  'core_cash_movements',
  'core_cash_sessions',
  'core_stock',
  'core_mail_messages',
  'core_mail_inboxes',
  'core_print_jobs',
  // Aponta para core_printers: sai antes dela.
  'core_label_templates',
  'core_printers',
  'core_categories',
  'core_brands',
  'core_product_images',
  // Auxiliares do catálogo, ANTES de core_products.
  //
  // Os três primeiros apontam para o produto; os dois últimos, só para a
  // empresa. Ficaram de fora desta lista quando foram criados, e o efeito só
  // apareceu ao escrever o segundo arquivo de teste que mexia em tabela de
  // preços: o `resetDbForTests` do teste seguinte estourava FOREIGN KEY, porque
  // apagava o produto com o item de tabela ainda apontando para ele.
  'core_price_table_items',
  // A faixa por quantidade aponta para o produto — filha antes do pai, e
  // registrada aqui NO MESMO gesto em que a tabela nasceu, que é a lição das
  // sete tabelas que ficaram de fora e derrubaram o reset da suíte.
  'core_product_price_tiers',
  // O valor aponta para a definição do campo; a definição, só para a empresa.
  'core_custom_field_values',
  'core_custom_fields',
  'core_kit_components',
  'core_product_barcodes',
  'core_units',
  'core_tax_groups',
  'core_tax_rates',
  // Depois de core_finance_entries, que aponta para as três.
  'core_finance_categories',
  'core_cost_centers',
  'core_finance_accounts',
  // Depois de core_stock_movements, que aponta para o local. Registrar aqui na
  // hora de criar a tabela — e não depois — é a lição da rodada anterior, em
  // que sete tabelas ficaram de fora e o reset dos testes estourou FOREIGN KEY.
  'core_stock_locations',
  // Antes de core_products (o item aponta para o produto que casou) e antes do
  // próprio lote, que é o pai.
  'core_import_batch_items',
  'core_import_batches',
  // Antes de core_products: a sugestão fiscal aponta para o produto que ela
  // classifica. Registrada aqui NO MESMO gesto em que a tabela nasceu — é a
  // lição das sete tabelas que ficaram de fora e derrubaram o reset da suíte
  // com FOREIGN KEY.
  'core_product_fiscal_suggestions',
  'core_inbound_note_items',
  // Antes da nota: o documento DF-e aponta a nota importada dele.
  'core_dfe_documents',
  // O cursor da Distribuição (R3-DFE) só aponta para a empresa. Registrado no
  // mesmo gesto em que a tabela nasceu.
  'core_dfe_cursors',
  // Filha antes do CT-e, e o CT-e não referencia a nota — só chaves.
  'core_cte_referenced_notes',
  'core_cte_documents',
  // Antes do pedido de compra: a nota aponta para o pedido que ela atende.
  'core_inbound_notes',
  // DEPOIS da nota: é a nota que aponta para a transportadora, e não o
  // contrário. A transportadora em si só referencia a empresa.
  'core_carriers',
  'core_purchase_order_items',
  'core_purchase_orders',
  // Antes de core_products E de core_suppliers: o de-para aponta para os dois
  // (GAP-PRD-015). Registrado no mesmo gesto em que a tabela nasceu.
  'core_supplier_item_codes',
  'core_products',
  // DEPOIS de core_products: a peça de oficina aponta para a oficina dona dela
  // (`core_products.workshop_id`). Apagar a oficina antes derruba a chave
  // estrangeira — e só aparecia quando algum produto de fato tinha oficina,
  // que é o caso desde que peça virou um recorte de verdade.
  'core_workshops',
  // Depois do pedido: o pedido aponta para o fornecedor.
  'core_suppliers',
  // O escopo e a personalização do vínculo (RBAC granular) apontam para o
  // vínculo E para o caixa — saem antes dos dois.
  'core_user_company_terminals',
  'core_user_company_capabilities',
  'core_device_tokens',
  'core_terminals',
  // Antes de core_users e core_companies, para as quais apontam (GAP-PRD-160).
  'core_user_password_resets',
  'core_team_password_recovery_configs',
  // Os modelos de permissão: a lista de capabilities aponta para o modelo. Sem
  // eles no banco, `MODELOS_DE_SISTEMA` responde — é o que o teste truncado usa.
  'core_permission_template_capabilities',
  'core_permission_templates',
  'core_user_companies',
  'core_login_attempts',
  // Os access tokens encerrados no logout (item SESSAO): não apontam para
  // ninguém. Registrada no mesmo gesto em que a tabela nasceu.
  'core_tokens_revogados',
  'core_users',
  // DEPOIS de core_users: o cliente que cria conta na loja online vira um
  // usuário com `core_users.customer_id` apontando para cá. Ficou antes desde
  // que a conta de cliente existe, e só não estourou porque poucos testes
  // criam esse vínculo — mais um dormente da mesma família.
  'core_customers',
  // DEPOIS de core_customers, e o motivo é desta rodada: o cliente passou a
  // apontar para a tabela por que ele compra (`core_customers.price_table_id`).
  //
  // Ela estava lá em cima, junto dos auxiliares de catálogo, porque até agora
  // só o ITEM da tabela tinha pai — e o item continua onde estava, antes de
  // core_products. A tabela em si mudou de lado no grafo: virou PAI de
  // core_customers e de core_quotes. Apagá-la antes deles derruba a chave
  // estrangeira no `resetDbForTests` do arquivo SEGUINTE, que é o pior lugar
  // para descobrir — a falha aparece longe de quem a causou.
  'core_price_tables',
  // Autorização de gerente (desconto acima da alçada). Não estava na lista:
  // nenhum reset a esvaziava, e cada arquivo de teste herdava as autorizações
  // do anterior. Aponta só para a empresa, então o lugar é aqui perto do fim.
  'core_authorizations',
  'core_audit_log',
  'core_sequences',
  // A declaração da etiqueta da balança aponta só para a empresa.
  'core_scale_label_settings',
  'core_companies',
] as const;

/**
 * Reserva o próximo número de uma sequência. Deve ser chamado dentro de uma
 * transação para que dois PDVs não obtenham o mesmo número de venda.
 */
export function nextSequenceValue(companyId: string, name: string): number {
  ensureCoreSchema();
  const db = getConnection();
  db.prepare(
    `INSERT INTO core_sequences (company_id, name, current) VALUES (?, ?, 0)
     ON CONFLICT (company_id, name) DO NOTHING`,
  ).run(companyId, name);
  db.prepare(
    'UPDATE core_sequences SET current = current + 1 WHERE company_id = ? AND name = ?',
  ).run(companyId, name);
  const row = db
    .prepare('SELECT current FROM core_sequences WHERE company_id = ? AND name = ?')
    .get(companyId, name) as { current: number } | undefined;
  return row?.current ?? 1;
}
