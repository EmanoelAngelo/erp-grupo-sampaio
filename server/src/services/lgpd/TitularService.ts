/**
 * ============================================================================
 * O CLIENTE VISTO PELO PERFIL, E OS DIREITOS DO TITULAR (GAP-PRD-073)
 * ============================================================================
 *
 * A auditoria logou como mecânico e como estoquista e recebeu de
 * `GET /core/customers` o `SELECT *` inteiro — CPF, e-mail, telefone,
 * endereço, observações e o hash do convite do portal. E não havia caminho
 * para atender um pedido de titular sem SQL do desenvolvedor.
 *
 * ## 1. Projeção por perfil
 *
 * A rota continua aberta aos três ambientes, e o motivo está escrito nela: o
 * PDV vincula cliente à venda e a bancada acha o dono do aparelho. Fechar
 * quebraria as duas telas. O que muda é a LINHA:
 *
 *   - quem ATENDE o cadastro — caixa, atendente, gerência, dono — vê o contato
 *     inteiro. É quem cadastra (`POST`), corrige (`PUT`) e põe o CPF na nota;
 *   - o resto (bancada, estoque) vê o nome, o código e só os últimos quatro
 *     dígitos do telefone e do documento — o que basta para confirmar "é esta
 *     Maria?" sem levar a carteira de clientes para casa. E-mail, endereço e
 *     observações não saem.
 *
 * A lista é de PERFIS QUE VEEM, e não de perfis que não veem: um perfil novo
 * nasce vendo o mínimo, até alguém decidir o contrário.
 *
 * O hash do convite do portal é credencial e não sai para ninguém — isso é do
 * `CatalogService` (`semSegredoDoConvite`), na fonte, para valer também em
 * toda outra rota que devolva um cadastro.
 *
 * ## 2. Exportação (art. 18, II e V)
 *
 * Tudo o que a operação guarda da pessoa, num documento só, com a política de
 * retenção junto — o titular fica sabendo também o que continuará guardado,
 * e por quê. Coluna com cara de credencial não entra.
 *
 * ## 3. Anonimização (art. 18, IV e VI) mantendo o histórico
 *
 * A linha de `core_customers` NÃO é apagada: venda, nota, OS e título apontam
 * para ela, e apagar quebraria o histórico fiscal que a lei manda guardar
 * (art. 16, I). Os dados de contato saem — do cadastro, dos contatos
 * comerciais ligados a ele, do nome copiado nas ordens de serviço, e das
 * cópias que a fila da central guardou. O vínculo com a conta do portal desta
 * operação é desfeito; a conta em si é da pessoa e vale para as seis
 * operações, e uma delas não a apaga.
 *
 * Com pendência — vale a devolver, título a receber, OS na bancada, locação
 * ou consignação aberta, pedido online em andamento — é recusada com a lista:
 * anonimizado, não haveria de quem cobrar nem a quem devolver.
 */
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { getCustomer, semSegredoDoConvite } from '../core/CatalogService.js';
import { creditBalanceCents } from '../core/CustomerCreditService.js';
import { pointsBalance } from '../core/LoyaltyService.js';
import { recordDomainEvent } from '../sync/DomainEvents.js';
import { POLITICA_DE_RETENCAO, type RegraDeRetencao } from './PoliticaDeRetencao.js';

// ============================================================ projeção por perfil

/**
 * Quem vê o contato inteiro do cliente: os perfis de `POST`/`PUT
 * /core/customers` (quem cadastra e corrige) e o dono do grupo.
 */
const QUEM_ATENDE_O_CADASTRO: ReadonlySet<string> = new Set([
  'admin_geral',
  'gestor',
  'gerente_loja',
  'gerente_oficina',
  'atendente',
  'operador_caixa',
  'operador_caixa_loja',
  'operador_caixa_oficina',
]);

export type AlcanceDoCliente = 'contato' | 'minimo';

export function alcanceDoCliente(perfis: readonly string[]): AlcanceDoCliente {
  return perfis.some((p) => QUEM_ATENDE_O_CADASTRO.has(p)) ? 'contato' : 'minimo';
}

/** Os últimos quatro dígitos — confere sem expor. Menos que isso não sai. */
function ultimosDigitos(valor: unknown): string | null {
  const digitos = String(valor ?? '').replace(/\D/g, '');
  if (digitos.length < 4) return null;
  return `••• ${digitos.slice(-4)}`;
}

/** O que a linha mínima carrega sem máscara: nada que identifique a pessoa além do nome. */
const COLUNAS_DO_MINIMO = [
  'id',
  'company_id',
  'code',
  'name',
  'active',
  'price_table_id',
  'anonymized_at',
  'created_at',
  'updated_at',
] as const;

export function projetarCliente(
  linha: Record<string, unknown>,
  alcance: AlcanceDoCliente,
): Record<string, unknown> {
  const limpa = semSegredoDoConvite(linha);
  if (alcance === 'contato') return limpa;
  const minima: Record<string, unknown> = {};
  for (const coluna of COLUNAS_DO_MINIMO) if (coluna in limpa) minima[coluna] = limpa[coluna];
  minima.document = ultimosDigitos(limpa.document);
  minima.phone = ultimosDigitos(limpa.phone);
  minima.email = null;
  minima.address = null;
  minima.notes = null;
  // A tela usa a bandeira para dizer por que o CPF aparece pela metade — sem
  // ela, a pessoa acharia que o cadastro está incompleto e "corrigiria".
  minima.dados_mascarados = true;
  return minima;
}

// ============================================================ exportação

interface FonteDoTitular {
  chave: string;
  titulo: string;
  tabela: string;
  coluna: string;
}

/**
 * Onde a operação guarda a pessoa. Nomes de tabela e coluna são constantes
 * deste arquivo — nunca entrada — e por isso podem ir no texto do SQL.
 */
const FONTES: readonly FonteDoTitular[] = [
  { chave: 'vendas', titulo: 'Vendas', tabela: 'core_sales', coluna: 'customer_id' },
  { chave: 'orcamentos', titulo: 'Orçamentos e pré-vendas', tabela: 'core_quotes', coluna: 'customer_id' },
  { chave: 'ordens_de_servico', titulo: 'Ordens de serviço', tabela: 'core_service_orders', coluna: 'customer_id' },
  { chave: 'chamados', titulo: 'Chamados abertos pelo portal', tabela: 'core_service_requests', coluna: 'customer_id' },
  { chave: 'equipamentos', titulo: 'Equipamentos', tabela: 'core_equipment', coluna: 'owner_customer_id' },
  { chave: 'credito_de_loja', titulo: 'Crédito de loja', tabela: 'core_customer_credits', coluna: 'customer_id' },
  { chave: 'fidelidade', titulo: 'Pontos de fidelidade', tabela: 'core_loyalty_entries', coluna: 'customer_id' },
  { chave: 'locacoes', titulo: 'Locações', tabela: 'core_rental_contracts', coluna: 'customer_id' },
  { chave: 'consignacoes', titulo: 'Consignações', tabela: 'core_consignments', coluna: 'customer_id' },
  { chave: 'contas_a_receber', titulo: 'Contas a receber', tabela: 'core_finance_entries', coluna: 'customer_id' },
  { chave: 'pedidos_online', titulo: 'Pedidos da loja online', tabela: 'core_orders', coluna: 'customer_id' },
  { chave: 'contatos_comerciais', titulo: 'Contatos comerciais', tabela: 'core_leads', coluna: 'customer_id' },
  { chave: 'oportunidades', titulo: 'Oportunidades', tabela: 'core_opportunities', coluna: 'customer_id' },
  {
    chave: 'cobranca_asaas',
    titulo: 'Cadastro no provedor de cobrança',
    tabela: 'core_asaas_customers',
    coluna: 'customer_id',
  },
];

/** Coluna com cara de credencial não sai em exportação nenhuma. */
const COLUNA_SECRETA = /hash|token|password|senha|secret|api_?key/i;

function semColunaSecreta(linha: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [coluna, valor] of Object.entries(linha)) {
    if (!COLUNA_SECRETA.test(coluna)) out[coluna] = valor;
  }
  return out;
}

function colunasDe(tabela: string): Set<string> {
  const linhas = getConnection().prepare(`PRAGMA table_info(${tabela})`).all() as unknown as {
    name: string;
  }[];
  return new Set(linhas.map((c) => c.name));
}

function linhasDaFonte(
  fonte: FonteDoTitular,
  companyId: string,
  customerId: string,
): Record<string, unknown>[] {
  const colunas = colunasDe(fonte.tabela);
  if (!colunas.has(fonte.coluna)) return [];
  const porEmpresa = colunas.has('company_id');
  const sql =
    `SELECT * FROM ${fonte.tabela} WHERE ${fonte.coluna} = ?` +
    (porEmpresa ? ' AND company_id = ?' : '') +
    (colunas.has('created_at') ? ' ORDER BY created_at' : '');
  const params = porEmpresa ? [customerId, companyId] : [customerId];
  const linhas = getConnection().prepare(sql).all(...params) as unknown as Record<string, unknown>[];
  return linhas.map(semColunaSecreta);
}

export interface SecaoDoTitular {
  chave: string;
  titulo: string;
  total: number;
  linhas: Record<string, unknown>[];
}

export interface DocumentoDoTitular {
  formato: 'devora.titular.v1';
  geradoEm: string;
  controlador: { id: string; nome: string | null; razaoSocial: string | null; cnpj: string | null };
  titular: Record<string, unknown>;
  secoes: SecaoDoTitular[];
  retencao: readonly RegraDeRetencao[];
  observacoes: string[];
}

export function exportarDadosDoTitular(companyId: string, customerId: string): DocumentoDoTitular {
  ensureCoreSchema();
  const cadastro = getCustomer(companyId, customerId);
  if (!cadastro) throw new ApiError('CORE_CUSTOMER_NOT_FOUND', 'Cliente não encontrado.', 404);
  const db = getConnection();

  const empresa = db
    .prepare('SELECT id, trade_name, legal_name, cnpj FROM core_companies WHERE id = ?')
    .get(companyId) as
    | { id: string; trade_name: string | null; legal_name: string | null; cnpj: string | null }
    | undefined;

  const secoes: SecaoDoTitular[] = FONTES.map((fonte) => {
    const linhas = linhasDaFonte(fonte, companyId, customerId);
    return { chave: fonte.chave, titulo: fonte.titulo, total: linhas.length, linhas };
  });

  // A conta do portal: e-mail e aceites — nunca a senha.
  const contas = db
    .prepare(
      `SELECT a.id, a.email, a.accepted_terms_at, a.email_verified_at, a.active,
              a.last_login_at, a.created_at, l.created_at AS vinculada_em
         FROM core_customer_account_links l
         JOIN core_customer_accounts a ON a.id = l.account_id
        WHERE l.customer_id = ? AND l.company_id = ?
        ORDER BY l.created_at`,
    )
    .all(customerId, companyId) as unknown as Record<string, unknown>[];
  secoes.push({ chave: 'contas_do_portal', titulo: 'Conta no portal do cliente', total: contas.length, linhas: contas });

  // O que foi feito com o cadastro, e quando — sem o funcionário, que não é
  // dado do titular.
  const trilha = db
    .prepare(
      `SELECT action, created_at FROM core_audit_log
        WHERE company_id = ? AND entity_type = 'customer' AND entity_id = ?
        ORDER BY created_at`,
    )
    .all(companyId, customerId) as unknown as Record<string, unknown>[];
  secoes.push({ chave: 'trilha', titulo: 'Registro do que foi feito com o cadastro', total: trilha.length, linhas: trilha });

  return {
    formato: 'devora.titular.v1',
    geradoEm: new Date().toISOString(),
    controlador: {
      id: companyId,
      nome: empresa?.trade_name ?? null,
      razaoSocial: empresa?.legal_name ?? null,
      cnpj: empresa?.cnpj ?? null,
    },
    titular: cadastro,
    secoes,
    retencao: POLITICA_DE_RETENCAO,
    observacoes: [
      'Documento gerado a pedido do titular (LGPD, art. 18, II e V). Contém os dados que esta operação guarda da pessoa.',
      'Os documentos fiscais emitidos (XML da NFC-e/NF-e) não estão aqui: são guardados pelo prazo legal e podem ser pedidos à operação.',
      'A conta do portal do cliente é da própria pessoa: endereços salvos e senha ficam nela, e ela os vê no portal.',
    ],
  };
}

// ============================================================ pendências

export interface PendenciaDoTitular {
  chave: string;
  descricao: string;
}

function reais(centavos: number): string {
  return `R$ ${(centavos / 100).toFixed(2).replace('.', ',')}`;
}

function contar(sql: string, ...params: (string | number)[]): number {
  const r = getConnection().prepare(sql).get(...params) as { n: number };
  return Number(r.n);
}

/** O que impede anonimizar agora — cada item diz o que falta fazer. */
export function pendenciasDoTitular(companyId: string, customerId: string): PendenciaDoTitular[] {
  ensureCoreSchema();
  const pendencias: PendenciaDoTitular[] = [];

  const saldo = creditBalanceCents(companyId, customerId);
  if (saldo > 0) {
    pendencias.push({
      chave: 'credito_de_loja',
      descricao: `A loja deve ${reais(saldo)} em crédito de loja a esta pessoa. Use ou devolva o crédito antes.`,
    });
  } else if (saldo < 0) {
    pendencias.push({
      chave: 'credito_de_loja',
      descricao: `O crédito de loja está negativo em ${reais(-saldo)}: a pessoa deve à loja. Acerte antes.`,
    });
  }

  const receber = getConnection()
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents - settled_cents), 0) AS aberto
         FROM core_finance_entries
        WHERE company_id = ? AND customer_id = ? AND direction = 'in' AND status = 'open'`,
    )
    .get(companyId, customerId) as { n: number; aberto: number };
  if (Number(receber.n) > 0) {
    pendencias.push({
      chave: 'contas_a_receber',
      descricao: `${receber.n} título(s) a receber em aberto (${reais(Number(receber.aberto))}). Receba ou cancele antes.`,
    });
  }

  const ordens = contar(
    `SELECT COUNT(*) AS n FROM core_service_orders
      WHERE company_id = ? AND customer_id = ? AND status <> 'finalizada'`,
    companyId,
    customerId,
  );
  if (ordens > 0) {
    pendencias.push({
      chave: 'ordens_de_servico',
      descricao: `${ordens} ordem(ns) de serviço ainda na oficina. Finalize e entregue antes.`,
    });
  }

  const locacoes = contar(
    `SELECT COUNT(*) AS n FROM core_rental_contracts WHERE company_id = ? AND customer_id = ? AND status = 'aberto'`,
    companyId,
    customerId,
  );
  if (locacoes > 0) {
    pendencias.push({ chave: 'locacoes', descricao: `${locacoes} locação(ões) em aberto. Receba a devolução antes.` });
  }

  const consignacoes = contar(
    `SELECT COUNT(*) AS n FROM core_consignments WHERE company_id = ? AND customer_id = ? AND status = 'aberta'`,
    companyId,
    customerId,
  );
  if (consignacoes > 0) {
    pendencias.push({ chave: 'consignacoes', descricao: `${consignacoes} consignação(ões) aberta(s). Feche o acerto antes.` });
  }

  const pedidos = contar(
    `SELECT COUNT(*) AS n FROM core_orders
      WHERE company_id = ? AND customer_id = ?
        AND status NOT IN ('entregue', 'cancelado', 'reembolsado')`,
    companyId,
    customerId,
  );
  if (pedidos > 0) {
    pendencias.push({
      chave: 'pedidos_online',
      descricao: `${pedidos} pedido(s) da loja online em andamento. Entregue ou cancele antes.`,
    });
  }

  const chamados = contar(
    `SELECT COUNT(*) AS n FROM core_service_requests WHERE company_id = ? AND customer_id = ? AND status = 'aberto'`,
    companyId,
    customerId,
  );
  if (chamados > 0) {
    pendencias.push({ chave: 'chamados', descricao: `${chamados} chamado(s) do portal esperando atendimento. Atenda ou encerre antes.` });
  }

  return pendencias;
}

// ============================================================ anonimização

export const ROTULO_ANONIMO = 'Titular anonimizado';

const MOTIVO_MINIMO = 10;
const MOTIVO_MAXIMO = 500;

export interface ResultadoDaAnonimizacao {
  id: string;
  anonimizadoEm: string;
  motivo: string;
  alterados: {
    cadastro: number;
    contatosComerciais: number;
    ordensDeServico: number;
    vinculosDoPortal: number;
    copiasNaFila: number;
  };
  /** O que continua guardado, e por quê — para responder ao titular. */
  retidos: RegraDeRetencao[];
  avisos: string[];
}

export function anonimizarTitular(input: {
  companyId: string;
  customerId: string;
  motivo: unknown;
}): ResultadoDaAnonimizacao {
  ensureCoreSchema();
  const motivo = typeof input.motivo === 'string' ? input.motivo.trim() : '';
  if (motivo.length < MOTIVO_MINIMO) {
    throw new ApiError(
      'CORE_TITULAR_MOTIVO_OBRIGATORIO',
      `Diga o motivo da anonimização, com ao menos ${MOTIVO_MINIMO} caracteres — por exemplo, "pedido da titular por e-mail em 11/09".`,
      400,
    );
  }
  if (motivo.length > MOTIVO_MAXIMO) {
    throw new ApiError(
      'CORE_TITULAR_MOTIVO_OBRIGATORIO',
      `O motivo cabe em ${MOTIVO_MAXIMO} caracteres.`,
      400,
    );
  }
  const { companyId, customerId } = input;

  return withTransaction(() => {
    const atual = getCustomer(companyId, customerId);
    if (!atual) throw new ApiError('CORE_CUSTOMER_NOT_FOUND', 'Cliente não encontrado.', 404);
    if (atual.anonymized_at) {
      throw new ApiError('CORE_TITULAR_JA_ANONIMIZADO', 'Este cadastro já foi anonimizado.', 409);
    }
    const pendencias = pendenciasDoTitular(companyId, customerId);
    if (pendencias.length > 0) {
      throw new ApiError(
        'CORE_TITULAR_COM_PENDENCIA',
        'Há pendências com esta pessoa. Resolva-as antes de anonimizar — depois disso não haveria de quem cobrar nem a quem devolver.',
        409,
        { pendencias },
      );
    }

    const avisos: string[] = [];
    const pontos = pointsBalance(companyId, customerId);
    if (pontos > 0) avisos.push(`${pontos} ponto(s) de fidelidade deixam de ter dono.`);

    const agora = new Date().toISOString();
    // O sufixo mantém a lista legível — vinte "Titular anonimizado" iguais
    // numa busca de vendas antigas não dizem qual é qual.
    const rotulo = `${ROTULO_ANONIMO} ${customerId.slice(0, 8)}`;
    const db = getConnection();

    const cadastro = db
      .prepare(
        `UPDATE core_customers
            SET name = ?, document = NULL, email = NULL, phone = NULL, address = NULL, notes = NULL,
                portal_invite_hash = NULL, portal_invite_expires_at = NULL, portal_invite_used_at = NULL,
                price_table_id = NULL, active = 0, anonymized_at = ?, updated_at = ?
          WHERE id = ? AND company_id = ?`,
      )
      .run(rotulo, agora, agora, customerId, companyId);

    const contatos = db
      .prepare(
        `UPDATE core_leads
            SET name = ?, phone = NULL, email = NULL, document = NULL, notes = NULL, updated_at = ?
          WHERE company_id = ? AND customer_id = ?`,
      )
      .run(rotulo, agora, companyId, customerId);

    // O nome COPIADO na OS. A OS fica (é histórico de serviço e de garantia);
    // o nome da pessoa, não.
    const ordens = db
      .prepare(
        `UPDATE core_service_orders SET customer_name = ?, updated_at = ?
          WHERE company_id = ? AND customer_id = ?`,
      )
      .run(rotulo, agora, companyId, customerId);

    const vinculos = db
      .prepare('DELETE FROM core_customer_account_links WHERE company_id = ? AND customer_id = ?')
      .run(companyId, customerId);

    /*
      AS CÓPIAS DA FILA DA CENTRAL. `core_outbox` guarda o payload de cada
      evento — inclusive os já entregues, que ninguém poda — e o do cliente é a
      linha inteira, CPF junto. Anonimizar só a tabela deixaria o documento
      vivo ali para sempre. O evento novo, registrado logo abaixo, é o que leva
      a anonimização para a cópia remota.
    */
    const copiasDoCliente = db
      .prepare(
        `UPDATE core_outbox
            SET payload = json_remove(
                  json_set(payload, '$.name', ?, '$.document', NULL, '$.email', NULL,
                           '$.phone', NULL, '$.address', NULL, '$.notes', NULL),
                  '$.portal_invite_hash', '$.portal_invite_expires_at', '$.portal_invite_used_at')
          WHERE company_id = ? AND aggregate_type = 'customer' AND aggregate_id = ?
            AND json_valid(payload)`,
      )
      .run(rotulo, companyId, customerId);
    const copiasDasOrdens = db
      .prepare(
        `UPDATE core_outbox SET payload = json_set(payload, '$.customer_name', ?)
          WHERE company_id = ? AND aggregate_type = 'service_order'
            AND json_valid(payload)
            AND json_extract(payload, '$.customer_id') = ?
            AND json_type(payload, '$.customer_name') IS NOT NULL`,
      )
      .run(rotulo, companyId, customerId);

    const anonimizado = getCustomer(companyId, customerId)!;
    recordDomainEvent({
      eventType: 'customer.upserted',
      aggregateType: 'customer',
      aggregateId: customerId,
      companyId,
      operation: 'update',
      payload: anonimizado,
    });

    return {
      id: customerId,
      anonimizadoEm: agora,
      motivo,
      alterados: {
        cadastro: Number(cadastro.changes ?? 0),
        contatosComerciais: Number(contatos.changes ?? 0),
        ordensDeServico: Number(ordens.changes ?? 0),
        vinculosDoPortal: Number(vinculos.changes ?? 0),
        copiasNaFila: Number(copiasDoCliente.changes ?? 0) + Number(copiasDasOrdens.changes ?? 0),
      },
      retidos: POLITICA_DE_RETENCAO.filter((r) =>
        ['documentos_fiscais', 'vendas_e_financeiro', 'pedidos_online', 'core_audit_log'].includes(r.chave),
      ),
      avisos,
    };
  });
}
