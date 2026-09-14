/**
 * O dono, autenticado, vendo o que a plaquinha esconde.
 *
 * ## Duas portas, de propósito
 *
 * A PLAQUINHA continua pública e mínima: quem escaneia o QR na calçada vê o
 * aparelho e o andamento, sem nome, sem valor, sem login. Ela não muda.
 *
 * Esta é a OUTRA porta. O dono entra com a conta do portal — a mesma que já
 * serve o e-commerce — e vê o que o anônimo não pode ver: seus aparelhos, o
 * histórico completo de ordens e quanto custou cada uma.
 *
 * Não é a mesma rota lendo um cabeçalho opcional. Uma resposta pública cujo
 * CORPO muda conforme um header é defeito de cache esperando acontecer: sem
 * `Vary` em toda camada, a resposta enriquecida de um dono pode ser servida a
 * um anônimo. A rota da plaquinha é o único endereço do sistema desenhado para
 * ser compartilhável, e é justamente onde isso custaria caro. Uma rota, uma
 * forma.
 *
 * ## O convite, e por que ele existe
 *
 * Sem ele o portal nasceria inacessível para exatamente quem serve. Criar
 * conta exige e-mail E documento na MESMA linha de `core_customers`; o cliente
 * de oficina é cadastrado no balcão com nome e telefone, e `email` é nulo. O
 * dono da moto nunca conseguiria entrar.
 *
 * O convite troca essa prova por outra: um código que só quem estava no balcão
 * recebeu. Guarda-se o SHA-256 dele, nunca o código — é credencial, e este
 * banco também guarda CPF.
 *
 * ## O que o convite NÃO faz, e é o mais importante daqui
 *
 * Ele NÃO chama `syncLinks` e NÃO escreve `core_customers.email`.
 *
 * `syncLinks` liga a conta a todo cadastro do GRUPO cujo e-mail ou documento
 * casem — sem filtro de empresa. Como o e-mail do convite é escolhido por quem
 * resgata e ninguém o verifica, passar por lá entregaria: pego o papel da
 * Joana, registro com o e-mail da Maria, e recebo os cadastros da Maria em
 * todas as operações. O convite insere UM vínculo, o do cliente que ele nomeia,
 * e mais nada.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { isOrderOnBench, ORDER_STATUSES_ON_BENCH } from './WorkshopCoreService.js';
import {
  consumirPromessasDaOs,
  soltarPromessasDaOs,
} from './WorkshopPartsReservation.js';

/** Validade do convite. Curta o bastante para papel perdido não virar acesso. */
const CONVITE_VALIDO_HORAS = 72;

/**
 * Alfabeto sem os caracteres que se confundem no papel: sem O/0, I/1, L.
 * O código é ditado por telefone e copiado à mão — ambiguidade aqui vira
 * chamado de suporte, não segurança.
 */
const ALFABETO = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function gerarCodigo(): string {
  const bytes = randomBytes(10);
  let saida = '';
  for (const b of bytes) saida += ALFABETO[b % ALFABETO.length];
  // 10 caracteres de 31 símbolos ≈ 49 bits. Não se adivinha por sorte, e o
  // freio por código cobre quem martelar.
  return saida;
}

function hashDoCodigo(codigo: string): string {
  return createHash('sha256').update(codigo.trim().toUpperCase()).digest('hex');
}

export interface ConviteEmitido {
  code: string;
  expiresAt: string;
  customerName: string;
}

/**
 * Emite (ou reemite) o convite de um cliente.
 *
 * Reemitir sobrescreve: não há histórico de convite a manter, e deixar dois
 * códigos válidos para a mesma pessoa só aumenta a superfície.
 */
export function emitirConvitePortal(companyId: string, customerId: string): ConviteEmitido {
  ensureCoreSchema();
  const db = getConnection();
  const cliente = db
    .prepare('SELECT id, name FROM core_customers WHERE id = ? AND company_id = ? AND active = 1')
    .get(customerId, companyId) as { id: string; name: string } | undefined;
  if (!cliente) {
    throw new ApiError('CORE_CUSTOMER_NOT_FOUND', 'Cliente não encontrado nesta empresa.', 404);
  }

  const codigo = gerarCodigo();
  const expira = new Date(Date.now() + CONVITE_VALIDO_HORAS * 3600_000).toISOString();
  db.prepare(
    `UPDATE core_customers
        SET portal_invite_hash = ?, portal_invite_expires_at = ?, portal_invite_used_at = NULL,
            updated_at = ?
      WHERE id = ? AND company_id = ?`,
  ).run(hashDoCodigo(codigo), expira, new Date().toISOString(), customerId, companyId);

  // O código em claro sai UMA vez, na resposta de quem o emitiu. Depois disso
  // só existe no papel do cliente.
  return { code: codigo, expiresAt: expira, customerName: cliente.name };
}

interface ClienteConvidado {
  id: string;
  company_id: string;
  name: string;
}

/** Resolve o código, ou explica por que não vale. */
function resolverConvite(codigo: string): ClienteConvidado {
  const db = getConnection();
  const linha = db
    .prepare(
      `SELECT id, company_id, name, portal_invite_expires_at, portal_invite_used_at
         FROM core_customers
        WHERE portal_invite_hash = ? AND active = 1`,
    )
    .get(hashDoCodigo(codigo)) as
    | (ClienteConvidado & { portal_invite_expires_at: string | null; portal_invite_used_at: string | null })
    | undefined;

  // Mesma resposta para código inexistente e código já usado: distinguir os
  // dois diria a quem tenta adivinhar que ele acertou o formato.
  if (!linha || linha.portal_invite_used_at) {
    throw new ApiError('PORTAL_CONVITE_INVALIDO', 'Código inválido ou já utilizado.', 400);
  }
  if (!linha.portal_invite_expires_at || new Date(linha.portal_invite_expires_at) <= new Date()) {
    throw new ApiError(
      'PORTAL_CONVITE_EXPIRADO',
      'Este código expirou. Peça um novo na oficina.',
      400,
    );
  }
  return { id: linha.id, company_id: linha.company_id, name: linha.name };
}

/**
 * Liga o cliente convidado a uma conta que JÁ EXISTE.
 *
 * Este caminho é o que faltava no desenho original, e o cenário é comum: o
 * dono da moto já comprou um capacete no site e tem conta. Na oficina ele é um
 * `core_customers` DIFERENTE. Sem resgate separado do registro, o código dele
 * seria papel morto — `core_customer_accounts` tem UNIQUE no e-mail e o
 * registro recusaria com "já existe acesso para este e-mail".
 */
export function resgatarConvite(accountId: string, codigo: string): { customerName: string } {
  ensureCoreSchema();
  return withTransaction(() => {
    const cliente = resolverConvite(codigo);
    const db = getConnection();
    const agora = new Date().toISOString();

    // O papel do balcão é a prova mais forte que a conta pode ter: o vínculo
    // fica marcado 'convite' (mesmo o que já existia por outra prova), e é o
    // documento DELE que o portal pode propagar às outras operações
    // (GAP-PRD-006, `syncLinks`).
    db.prepare(
      `INSERT INTO core_customer_account_links
         (id, account_id, customer_id, company_id, created_at, proof)
       VALUES (?, ?, ?, ?, ?, 'convite')
       ON CONFLICT (account_id, customer_id) DO UPDATE SET proof = 'convite'`,
    ).run(randomUUID(), accountId, cliente.id, cliente.company_id, agora);

    db.prepare('UPDATE core_customers SET portal_invite_used_at = ? WHERE id = ?').run(
      agora,
      cliente.id,
    );
    return { customerName: cliente.name };
  });
}

/** O par (cliente, empresa) de um convite, para o registro criar o vínculo. */
export function clienteDoConvite(codigo: string): { customerId: string; companyId: string; name: string } {
  ensureCoreSchema();
  const c = resolverConvite(codigo);
  return { customerId: c.id, companyId: c.company_id, name: c.name };
}

/** Marca o convite como usado. Chamado pelo registro, dentro da transação. */
export function marcarConviteUsado(customerId: string): void {
  getConnection()
    .prepare('UPDATE core_customers SET portal_invite_used_at = ? WHERE id = ?')
    .run(new Date().toISOString(), customerId);
}

// ------------------------------------------------------ o que o dono enxerga

export interface EquipamentoDoDono {
  id: string;
  publicIdLabel: string;
  brand: string | null;
  model: string | null;
  color: string | null;
  category: string | null;
  workshopName: string | null;
  companyName: string;
  serialNumber: string | null;
  plate: string | null;
}

/**
 * Os aparelhos do dono.
 *
 * A guarda é `owner_customer_id IN (cadastros da conta)`. Conta sem vínculo
 * nenhum devolve lista vazia ANTES de montar SQL — `IN ()` é erro de sintaxe no
 * SQLite e viraria 500 numa rota que deveria responder "você não tem nenhum".
 */
export function listarEquipamentosDoDono(customerIds: string[]): EquipamentoDoDono[] {
  ensureCoreSchema();
  if (customerIds.length === 0) return [];

  const marcas = customerIds.map(() => '?').join(', ');
  return (
    getConnection()
      .prepare(
        `SELECT e.id, e.public_id, e.brand, e.model, e.color, e.category, e.serial_number,
                w.name AS workshop_name, c.trade_name AS company_name,
                (SELECT o.plate FROM core_service_orders o
                  WHERE o.equipment_id = e.id AND o.plate IS NOT NULL
                  ORDER BY o.number DESC LIMIT 1) AS plate
           FROM core_equipment e
           LEFT JOIN core_workshops w ON w.id = e.workshop_id AND w.company_id = e.company_id
           JOIN core_companies c ON c.id = e.company_id
          WHERE e.owner_customer_id IN (${marcas})
          ORDER BY e.public_id DESC`,
      )
      .all(...(customerIds as never[])) as unknown as Record<string, unknown>[]
  ).map((l) => ({
    id: String(l.id),
    publicIdLabel: `#${String(l.public_id ?? '').padStart(4, '0')}`,
    brand: (l.brand as string) ?? null,
    model: (l.model as string) ?? null,
    color: (l.color as string) ?? null,
    category: (l.category as string) ?? null,
    workshopName: (l.workshop_name as string) ?? null,
    companyName: String(l.company_name ?? ''),
    serialNumber: (l.serial_number as string) ?? null,
    plate: (l.plate as string) ?? null,
  }));
}

export interface OrdemDoDono {
  id: string;
  number: number;
  status: string;
  complaint: string | null;
  diagnosis: string | null;
  laborCents: number;
  partsCents: number;
  totalCents: number;
  createdAt: string;
  closedAt: string | null;
  approvalRequestedAt: string | null;
  approvedAt: string | null;
  /**
   * O orçamento está na mesa do dono AGORA (GAP-PRD-182): pedido de pé, sem
   * resposta, e a OS ainda na bancada. É o que decide se o portal mostra os
   * botões — a regra mora aqui, e não repetida na tela, porque é a mesma que
   * `decidirOrcamento` confere antes de aceitar a decisão.
   */
  aguardandoDecisao: boolean;
}

export interface EquipamentoComHistorico {
  equipamento: EquipamentoDoDono;
  ordens: OrdemDoDono[];
}

/**
 * O aparelho e o histórico dele — só as ordens DESTE dono.
 *
 * O corte por pessoa, e não só por equipamento, é o que impede o dono de hoje
 * de ler o que o dono ANTERIOR escreveu. `assignOwner` sobrescreve
 * `owner_customer_id` sem recriar registro: a moto usada trocou de mãos, e as
 * queixas do antigo dono — que são as palavras dele — continuam presas àquele
 * chassi.
 *
 * OS antiga sem `customer_id` (só o nome em texto) fica de fora. É a escolha
 * conservadora: melhor faltar linha do que mostrar a de outra pessoa.
 */
export function equipamentoDoDono(
  customerIds: string[],
  equipmentId: string,
): EquipamentoComHistorico | null {
  ensureCoreSchema();
  if (customerIds.length === 0) return null;

  const equipamento = listarEquipamentosDoDono(customerIds).find((e) => e.id === equipmentId);
  if (!equipamento) return null;

  const marcas = customerIds.map(() => '?').join(', ');
  const ordens = getConnection()
    .prepare(
      `SELECT id, number, status, complaint, diagnosis, labor_cents, parts_cents, total_cents,
              created_at, closed_at, approval_requested_at, approved_at
         FROM core_service_orders
        WHERE equipment_id = ? AND customer_id IN (${marcas})
        ORDER BY number DESC`,
    )
    .all(...([equipmentId, ...customerIds] as never[])) as unknown as Record<string, unknown>[];

  return {
    equipamento,
    ordens: ordens.map((o) => ({
      id: String(o.id),
      number: Number(o.number),
      status: String(o.status),
      complaint: (o.complaint as string) ?? null,
      diagnosis: (o.diagnosis as string) ?? null,
      laborCents: Number(o.labor_cents ?? 0),
      partsCents: Number(o.parts_cents ?? 0),
      totalCents: Number(o.total_cents ?? 0),
      createdAt: String(o.created_at),
      closedAt: (o.closed_at as string) ?? null,
      approvalRequestedAt: (o.approval_requested_at as string) ?? null,
      approvedAt: (o.approved_at as string) ?? null,
      aguardandoDecisao:
        Boolean(o.approval_requested_at) && !o.approved_at && isOrderOnBench(String(o.status)),
    })),
  };
}

// ------------------------------------------------------------------ chamados

/** Teto por JANELA, não por status — ver a nota em `abrirChamado`. */
const CHAMADOS_POR_DIA = 10;

/**
 * Estados em que o aparelho ESTÁ na oficina.
 *
 * `aguardando_pagamento` fica de fora de propósito: a moto já foi entregue e a
 * OS só sai daquele estado quando alguém dá baixa no caixa. Tratá-la como "está
 * aqui" trancaria o dono para fora por semanas, justamente no caso mais comum
 * de OS esquecida em aberto.
 */
/*
  Uma fonte só para "a OS está viva na bancada" (rodada 51) — a cópia local não
  conhecia `parada_setor`, e o dono da moto parada perdia o chamado.

  A lista é montada DENTRO da função, e não no topo do módulo (rodada 54).
  Espalhar no topo faz este arquivo depender de `WorkshopCoreService` já ter
  TERMINADO de avaliar: num ciclo de importação — e existe um, por
  `ProductUnitService` — a constante ainda está vazia quando o espalhamento
  roda, e o processo morre com "ORDER_STATUSES_ON_BENCH is not iterable", num
  arquivo que não tem nada a ver com oficina. Dentro da função, o valor já está
  pronto quando alguém pergunta.
*/
function naOficina(): string[] {
  return [...ORDER_STATUSES_ON_BENCH];
}

export interface Chamado {
  id: string;
  equipmentId: string;
  description: string;
  status: string;
  createdAt: string;
}

/**
 * O dono pede serviço.
 *
 * ## O freio é por janela, e não por quantos estão abertos
 *
 * Contar chamados com status `aberto` parece um teto, mas não é: o próprio
 * cancelamento zera o contador, e o laço abrir→cancelar→abrir roda sem limite.
 * Contar por CRIAÇÃO numa janela de 24h é o que de fato freia, e não pune quem
 * cancelou por engano.
 */
export function abrirChamado(input: {
  accountId: string;
  customerIds: string[];
  equipmentId: string;
  description: string;
}): Chamado {
  ensureCoreSchema();
  const texto = input.description?.trim();
  if (!texto) {
    throw new ApiError('PORTAL_CHAMADO_SEM_DESCRICAO', 'Descreva o que está acontecendo.', 400);
  }
  if (input.customerIds.length === 0) {
    throw new ApiError('PORTAL_EQUIPAMENTO_NAO_ENCONTRADO', 'Equipamento não encontrado.', 404);
  }

  return withTransaction(() => {
    const db = getConnection();
    const marcas = input.customerIds.map(() => '?').join(', ');

    const eq = db
      .prepare(
        `SELECT id, company_id, workshop_id, owner_customer_id
           FROM core_equipment
          WHERE id = ? AND owner_customer_id IN (${marcas})`,
      )
      .get(...([input.equipmentId, ...input.customerIds] as never[])) as
      | { id: string; company_id: string; workshop_id: string; owner_customer_id: string }
      | undefined;
    // 404 e não 403: quem não é dono não deve nem descobrir que o id existe.
    if (!eq) {
      throw new ApiError('PORTAL_EQUIPAMENTO_NAO_ENCONTRADO', 'Equipamento não encontrado.', 404);
    }

    /*
      O teto é POR OPERAÇÃO, e antes não era.

      A conta era `WHERE account_id = ? AND created_at >= ?`, sem empresa. Uma
      conta de portal só alcança cadastros de várias operações do grupo — foi a
      rodada 19 que abriu isso de propósito, espelhando o cliente pelo documento
      para que o comprador de uma moto na loja fosse reconhecido na oficina. O
      efeito colateral era este: dez chamados sobre um celular na Preço Justo
      esgotavam a cota da moto na Oficina, e a segunda oficina recusava um
      pedido que ela nunca recebeu.

      A empresa sai do EQUIPAMENTO, não do que o cliente informou: é o aparelho
      que decide de quem é a bancada.
    */
    const desde = new Date(Date.now() - 24 * 3600_000).toISOString();
    const recentes = db
      .prepare(
        `SELECT COUNT(*) AS n FROM core_service_requests
          WHERE account_id = ? AND company_id = ? AND created_at >= ?`,
      )
      .get(input.accountId, eq.company_id, desde) as { n: number };
    if (recentes.n >= CHAMADOS_POR_DIA) {
      throw new ApiError(
        'PORTAL_CHAMADO_LIMITE',
        'Muitos chamados abertos hoje. Fale com a oficina por telefone.',
        429,
      );
    }

    // Aparelho que já está na bancada não precisa de chamado: o dono
    // acompanharia pela plaquinha, e a fila encheria de pedido repetido.
    const emServico = db
      .prepare(
        `SELECT 1 AS ok FROM core_service_orders
          WHERE equipment_id = ? AND status IN (${naOficina().map(() => '?').join(', ')})
          LIMIT 1`,
      )
      .get(...([input.equipmentId, ...naOficina()] as never[])) as { ok?: number } | undefined;
    if (emServico?.ok) {
      throw new ApiError(
        'PORTAL_EQUIPAMENTO_EM_ATENDIMENTO',
        'Este equipamento já está em atendimento na oficina.',
        409,
      );
    }

    const id = randomUUID();
    const agora = new Date().toISOString();
    db.prepare(
      `INSERT INTO core_service_requests
         (id, company_id, workshop_id, equipment_id, customer_id, account_id,
          description, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'aberto', ?, ?)`,
    ).run(
      id,
      eq.company_id,
      eq.workshop_id,
      eq.id,
      eq.owner_customer_id,
      input.accountId,
      texto,
      agora,
      agora,
    );

    return { id, equipmentId: eq.id, description: texto, status: 'aberto', createdAt: agora };
  });
}

/**
 * Os chamados da CONTA.
 *
 * Escopado por `account_id`, a mesma chave da escrita. Ler por `customerIds`
 * seria mais largo: `core_customer_account_links` permite que o mesmo cliente
 * esteja ligado a duas contas, e aí uma conta leria o chamado que a outra
 * abriu.
 */
export function listarChamadosDaConta(accountId: string): Chamado[] {
  ensureCoreSchema();
  return (
    getConnection()
      .prepare(
        `SELECT id, equipment_id, description, status, created_at
           FROM core_service_requests WHERE account_id = ?
          ORDER BY created_at DESC LIMIT 50`,
      )
      .all(accountId) as unknown as Record<string, unknown>[]
  ).map((l) => ({
    id: String(l.id),
    equipmentId: String(l.equipment_id),
    description: String(l.description),
    status: String(l.status),
    createdAt: String(l.created_at),
  }));
}

export function cancelarChamado(accountId: string, requestId: string): void {
  ensureCoreSchema();
  const r = getConnection()
    .prepare(
      `UPDATE core_service_requests SET status = 'cancelado', updated_at = ?
        WHERE id = ? AND account_id = ? AND status = 'aberto'`,
    )
    .run(new Date().toISOString(), requestId, accountId);
  if (Number(r.changes ?? 0) === 0) {
    throw new ApiError('PORTAL_CHAMADO_NAO_ENCONTRADO', 'Chamado não encontrado.', 404);
  }
}

// ------------------------------------------------------- o lado da oficina

/** A fila que a oficina atende. */
export function listarChamadosDaOficina(
  companyId: string,
  workshopIds: string[] | null,
): Record<string, unknown>[] {
  ensureCoreSchema();
  const where = ['r.company_id = ?', "r.status = 'aberto'"];
  const params: unknown[] = [companyId];
  if (workshopIds && workshopIds.length > 0) {
    where.push(`r.workshop_id IN (${workshopIds.map(() => '?').join(', ')})`);
    params.push(...workshopIds);
  } else if (workshopIds && workshopIds.length === 0) {
    where.push('1 = 0');
  }

  return getConnection()
    .prepare(
      `SELECT r.id, r.description, r.created_at, r.equipment_id,
              e.public_id AS equipment_public_id, e.brand, e.model,
              c.name AS customer_name, c.phone AS customer_phone,
              w.name AS workshop_name
         FROM core_service_requests r
         JOIN core_equipment e ON e.id = r.equipment_id
         JOIN core_customers c ON c.id = r.customer_id
         LEFT JOIN core_workshops w ON w.id = r.workshop_id AND w.company_id = r.company_id
        WHERE ${where.join(' AND ')}
        ORDER BY r.created_at`,
    )
    .all(...(params as never[])) as unknown as Record<string, unknown>[];
}

/**
 * A conversão: o aparelho chegou, o chamado vira OS.
 *
 * É AQUI que `opened_by_customer` finalmente ganha escritor. A coluna existia
 * desde a primeira versão da tabela e nenhuma rota a preenchia — a OS aberta
 * pelo dono era indistinguível da aberta no balcão.
 */
export function converterChamado(input: {
  companyId: string;
  requestId: string;
  userId: string;
  criarOrdem: (dados: {
    workshopId: string;
    equipmentId: string;
    customerId: string;
    complaint: string;
  }) => { id: string };
}): { orderId: string } {
  ensureCoreSchema();
  return withTransaction(() => {
    const db = getConnection();
    const r = db
      .prepare(
        `SELECT * FROM core_service_requests
          WHERE id = ? AND company_id = ? AND status = 'aberto'`,
      )
      .get(input.requestId, input.companyId) as Record<string, unknown> | undefined;
    if (!r) throw new ApiError('PORTAL_CHAMADO_NAO_ENCONTRADO', 'Chamado não encontrado.', 404);

    const ordem = input.criarOrdem({
      workshopId: String(r.workshop_id),
      equipmentId: String(r.equipment_id),
      customerId: String(r.customer_id),
      complaint: String(r.description),
    });

    db.prepare(
      `UPDATE core_service_requests
          SET status = 'convertido', order_id = ?, handled_by = ?, handled_at = ?, updated_at = ?
        WHERE id = ?`,
    ).run(ordem.id, input.userId, new Date().toISOString(), new Date().toISOString(), input.requestId);

    return { orderId: ordem.id };
  });
}

/** Encerrar sem virar OS: o cliente desistiu, ou resolveu por telefone. */
export function encerrarChamado(input: {
  companyId: string;
  requestId: string;
  userId: string;
  note?: string;
}): void {
  ensureCoreSchema();
  const r = getConnection()
    .prepare(
      `UPDATE core_service_requests
          SET status = 'encerrado', handled_by = ?, handled_at = ?, resolution_note = ?, updated_at = ?
        WHERE id = ? AND company_id = ? AND status = 'aberto'`,
    )
    .run(
      input.userId,
      new Date().toISOString(),
      input.note?.trim() || null,
      new Date().toISOString(),
      input.requestId,
      input.companyId,
    );
  if (Number(r.changes ?? 0) === 0) {
    throw new ApiError('PORTAL_CHAMADO_NAO_ENCONTRADO', 'Chamado não encontrado.', 404);
  }
}

// ------------------------------------------------------- decisão do orçamento

/**
 * O segundo tempo do orçamento: o CLIENTE decide, no portal dele.
 *
 * A régua de posse é a mesma do resto do arquivo: a OS precisa estar amarrada
 * a um `customer_id` da sessão. Quem não é dono recebe 404 — nem descobre que
 * a ordem existe.
 *
 * Recusa LIMPA o pedido (a oficina pode reorçar e pedir de novo) e aprovação
 * é definitiva: depois do "sim" o serviço pode começar na hora, então mudar
 * de ideia é conversa com a oficina, não botão.
 *
 * A fala entra na linha do tempo como `author_kind = 'proprietario'` — a
 * mesma voz dos comentários do dono, distinta da equipe.
 */
export function decidirOrcamento(
  customerIds: string[],
  orderId: string,
  decisao: 'aprovar' | 'recusar',
): { ordem: { id: string; approvalRequestedAt: string | null; approvedAt: string | null } } {
  ensureCoreSchema();
  if (customerIds.length === 0) {
    throw new ApiError('PORTAL_ORDER_NOT_FOUND', 'Ordem não encontrada.', 404);
  }
  return withTransaction(() => {
    const db = getConnection();
    const marcas = customerIds.map(() => '?').join(', ');
    const ordem = db
      .prepare(
        `SELECT id, company_id, number, status, total_cents, customer_id,
                approval_requested_at, approved_at
           FROM core_service_orders
          WHERE id = ? AND customer_id IN (${marcas})`,
      )
      .get(...([orderId, ...customerIds] as never[])) as
      | {
          id: string;
          company_id: string;
          number: number;
          status: string;
          total_cents: number;
          customer_id: string;
          approval_requested_at: string | null;
          approved_at: string | null;
        }
      | undefined;
    if (!ordem) {
      throw new ApiError('PORTAL_ORDER_NOT_FOUND', 'Ordem não encontrada.', 404);
    }
    /*
      SÓ SE DECIDE ORÇAMENTO DE OS NA BANCADA (GAP-PRD-182).

      Depois da conclusão técnica a OS está na fila do caixa (ou finalizada): o
      serviço foi feito e a peça já saiu. Aceitar a decisão ali registrava um
      "recusado pelo cliente" numa OS pronta para cobrar, e apagava o pedido
      — a linha do tempo passava a contradizer o estado. É a mesma régua que
      `pedirAprovacaoOrcamento` usa do lado da oficina, e ela vem ANTES da
      pendência: o pedido pendurado por código antigo também é recusado.

      O clique repetido do "aprovar" continua sem erro e sem efeito: não é
      decisão nova, é a mesma que já está gravada.
    */
    if (ordem.approval_requested_at && ordem.approved_at && decisao === 'aprovar') {
      return { ordem: { id: ordem.id, approvalRequestedAt: ordem.approval_requested_at, approvedAt: ordem.approved_at } };
    }
    if (!isOrderOnBench(ordem.status)) {
      throw new ApiError(
        'PORTAL_ORDER_NOT_ON_BENCH',
        'Esta ordem já saiu da bancada — o orçamento virou conta. Fale com a oficina.',
        409,
      );
    }
    if (!ordem.approval_requested_at) {
      throw new ApiError('PORTAL_NO_APPROVAL_PENDING', 'Não há orçamento aguardando decisão.', 409);
    }
    if (ordem.approved_at) {
      if (decisao === 'aprovar') {
        // Clique repetido não é erro nem efeito novo.
        return { ordem: { id: ordem.id, approvalRequestedAt: ordem.approval_requested_at, approvedAt: ordem.approved_at } };
      }
      throw new ApiError(
        'PORTAL_ALREADY_APPROVED',
        'O orçamento já foi aprovado — fale com a oficina.',
        409,
      );
    }

    const agora = new Date().toISOString();
    const dono = db
      .prepare('SELECT name FROM core_customers WHERE id = ?')
      .get(ordem.customer_id) as { name: string } | undefined;
    const valor = (ordem.total_cents / 100).toFixed(2).replace('.', ',');

    /*
      A DECISÃO DO CLIENTE MOVE A GAVETA (rodada 55).

      As peças do orçamento estão PROMETIDAS ao conserto — reservadas, não
      baixadas. O "sim" autoriza o serviço e a peça sai. O "não" desfaz a
      promessa na hora, e é o buraco que esta rodada fecha: antes, a peça já
      tinha saído do estoque para montar o orçamento e só voltava se alguém
      lembrasse de devolvê-la, uma a uma. Ninguém lembra de desfazer um
      orçamento recusado.

      Na MESMA transação da decisão: um "não" registrado com a peça ainda
      presa seria pior que nenhum registro.
    */
    if (decisao === 'aprovar') {
      db.prepare(
        'UPDATE core_service_orders SET approved_at = ?, updated_at = ? WHERE id = ?',
      ).run(agora, agora, ordem.id);
      consumirPromessasDaOs({
        companyId: ordem.company_id,
        orderId: ordem.id,
        orderNumber: ordem.number,
        // O dono da moto não é usuário do ERP: a autoria da baixa é do fato,
        // não de uma pessoa da equipe, e inventar um id aqui seria mentira.
        userId: null,
        nota: `OS #${ordem.number} — orçamento aprovado pelo cliente`,
      });
    } else {
      db.prepare(
        `UPDATE core_service_orders
            SET approval_requested_at = NULL, approved_at = NULL, updated_at = ?
          WHERE id = ?`,
      ).run(agora, ordem.id);
      soltarPromessasDaOs({
        companyId: ordem.company_id,
        orderId: ordem.id,
        orderNumber: ordem.number,
        userId: null,
      });
    }

    db.prepare(
      `INSERT INTO core_service_order_comments
         (id, order_id, company_id, author_id, author_name, author_kind, body,
          attachments, status_at, created_at)
       VALUES (?, ?, ?, ?, ?, 'proprietario', ?, NULL, ?, ?)`,
    ).run(
      randomUUID(),
      ordem.id,
      ordem.company_id,
      // `author_id` tem FK para core_users — o dono não é usuário do ERP.
      // A identidade da fala está no nome e no author_kind.
      null,
      dono?.name ?? 'Cliente',
      decisao === 'aprovar'
        ? `Orçamento de R$ ${valor} APROVADO pelo cliente.`
        : `Orçamento de R$ ${valor} recusado pelo cliente.`,
      ordem.status,
      agora,
    );

    const depois = db
      .prepare('SELECT approval_requested_at, approved_at FROM core_service_orders WHERE id = ?')
      .get(ordem.id) as { approval_requested_at: string | null; approved_at: string | null };
    return {
      ordem: {
        id: ordem.id,
        approvalRequestedAt: depois.approval_requested_at,
        approvedAt: depois.approved_at,
      },
    };
  });
}
