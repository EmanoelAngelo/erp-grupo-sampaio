/**
 * CUPONS DE DESCONTO DA LOJA ONLINE — GAP-PRD-123.
 *
 * Até o lote E5 da remediação não existia tabela, rota, tela nem campo: a
 * campanha "10 % com o código BEMVINDO" não tinha como ser feita, e o dono só
 * baixava preço por promoção (que vale para todo mundo, nos dois canais).
 *
 * O QUE UM CUPOM É AQUI
 *
 *   - Um CÓDIGO de UMA empresa, digitado no checkout da loja online. O carrinho
 *     de duas lojas vira dois pedidos; o cupom desconta só o pedido da empresa
 *     que o criou. O balcão não recebe cupom — lá a regra é a promoção e a
 *     alçada de desconto.
 *   - Um desconto sobre os ITENS (percentual ou valor fixo), nunca sobre o
 *     frete, com pedido mínimo, vigência, teto de usos no total e por cliente.
 *   - NÃO CUMULATIVO por padrão: o desconto só alcança item que não está em
 *     promoção. O dono liga "vale também sobre promoção" por cupom. É o lado
 *     seguro da decisão dele — empilhar desconto sobre promoção é a erosão de
 *     margem invisível que `PricingService` já recusa entre os seus candidatos.
 *
 * COMO O DESCONTO VIRA FATO
 *
 * O pedido guarda o retrato (`coupon_code`, `discount_cents`) e o desconto é
 * RATEADO nos itens (`core_order_items.discount_cents`), com `total_cents`
 * líquido. Por isso o resto do sistema não precisou aprender cupom: a cobrança
 * sai de `total_cents`, a NF-e declara vProd e vDesc por item, "produtos
 * vendidos" soma a receita que entrou, e o DRE lê o pedido pago pelo total.
 * O rateio deixa pelo menos um centavo em cada linha — item de valor zero é
 * recusa certa na SEFAZ.
 *
 * O USO
 *
 * Um uso por pedido (`core_coupon_redemptions`). O pedido cancelado — pelo
 * cliente, pela loja ou pela reserva vencida — devolve o uso; o pedido pago e
 * depois reembolsado não devolve (o cupom foi usado). O cliente é a CONTA; o
 * visitante (quando a loja o aceita) é contado pelo e-mail digitado.
 */
import { randomUUID } from 'node:crypto';
import { getConnection } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import {
  comoInstanteFinal,
  comoInstanteInicial,
  diaDaLoja,
} from './CalendarioOperacional.js';

/** A linha de `core_coupons`. */
export interface LinhaDoCupom {
  id: string;
  company_id: string;
  code: string;
  description: string | null;
  percent_off: number | null;
  amount_cents: number | null;
  min_order_cents: number;
  starts_at: string;
  ends_at: string | null;
  max_uses: number | null;
  max_uses_per_customer: number | null;
  accumulates_with_promotions: number;
  active: number;
  created_by: string | null;
  created_at: string;
  ended_at: string | null;
  ended_by: string | null;
}

/** Uma linha do pedido, do jeito que o rateio precisa. */
export interface LinhaParaCupom {
  productId: string;
  /** Valor da linha JÁ com a promoção, antes do cupom. */
  totalCents: number;
  /** O preço desta linha já está abaixo do cadastro (promoção)? */
  emPromocao: boolean;
}

/** Quem está usando — a conta, ou o e-mail do visitante. */
export interface QuemUsa {
  accountId?: string | null;
  email?: string | null;
}

export interface CupomAplicado {
  cupomId: string;
  code: string;
  description: string | null;
  discountCents: number;
  /** O desconto de cada linha, na MESMA ordem das linhas recebidas. */
  porLinha: number[];
}

const CODIGO = /^[A-Z0-9][A-Z0-9_-]{2,29}$/;

function reais(cents: number): string {
  return `R$ ${(cents / 100).toFixed(2).replace('.', ',')}`;
}

function dataBR(instante: string): string {
  const [ano, mes, dia] = diaDaLoja(instante).split('-');
  return `${dia}/${mes}/${ano}`;
}

/** O código como o banco guarda: maiúsculas, sem espaço nenhum. */
export function normalizarCodigo(valor: unknown): string {
  return valor === undefined || valor === null
    ? ''
    : String(valor).replace(/\s+/g, '').toUpperCase();
}

function emailNormalizado(email: string | null | undefined): string | null {
  const e = String(email ?? '').trim().toLowerCase();
  return e || null;
}

/**
 * A recusa do código que não vale nesta loja — inexistente OU encerrado, com
 * a MESMA resposta: dizer "existe, mas foi encerrado" ajudaria quem varre
 * códigos. É esta recusa (e só ela) que conta no teto por origem.
 */
export function cupomInvalido(code: string): ApiError {
  return new ApiError(
    'CHECKOUT_CUPOM_INVALIDO',
    `O cupom "${code}" não vale nesta loja: confira o código (ou a campanha acabou).`,
    400,
    { code },
  );
}

/** As empresas do carrinho que têm um cupom com este código (ativo ou não). */
export function empresasComCupom(code: string, companyIds: string[]): string[] {
  ensureCoreSchema();
  if (!code || companyIds.length === 0) return [];
  const marcadores = companyIds.map(() => '?').join(', ');
  return (
    getConnection()
      .prepare(
        `SELECT company_id FROM core_coupons WHERE code = ? AND company_id IN (${marcadores})`,
      )
      .all(code, ...companyIds) as { company_id: string }[]
  ).map((l) => l.company_id);
}

/**
 * O cupom aplicado a UM pedido — conferido e rateado. Lança a recusa com o
 * motivo nomeado; não grava nada (quem grava é `registrarUsoDoCupom`, na
 * mesma transação do pedido).
 */
export function aplicarCupom(input: {
  companyId: string;
  code: string;
  linhas: LinhaParaCupom[];
  quem: QuemUsa;
  agora?: Date;
}): CupomAplicado {
  ensureCoreSchema();
  const db = getConnection();
  const code = normalizarCodigo(input.code);
  const agora = (input.agora ?? new Date()).toISOString();
  const cupom = db
    .prepare('SELECT * FROM core_coupons WHERE company_id = ? AND code = ?')
    .get(input.companyId, code) as LinhaDoCupom | undefined;
  if (!cupom || !cupom.active) throw cupomInvalido(code);

  if (cupom.starts_at > agora) {
    throw new ApiError(
      'CHECKOUT_CUPOM_AINDA_NAO_VALE',
      `O cupom ${code} começa a valer em ${dataBR(cupom.starts_at)}.`,
      400,
      { code, startsAt: cupom.starts_at },
    );
  }
  if (cupom.ends_at && cupom.ends_at < agora) {
    throw new ApiError(
      'CHECKOUT_CUPOM_VENCIDO',
      `O cupom ${code} venceu em ${dataBR(cupom.ends_at)}.`,
      400,
      { code, endsAt: cupom.ends_at },
    );
  }

  if (cupom.max_uses !== null) {
    const usados = (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM core_coupon_redemptions WHERE coupon_id = ? AND status = 'ativo'",
        )
        .get(cupom.id) as { n: number }
    ).n;
    if (usados >= cupom.max_uses) {
      throw new ApiError(
        'CHECKOUT_CUPOM_ESGOTADO',
        `O cupom ${code} já foi usado o número máximo de vezes.`,
        409,
        { code },
      );
    }
  }

  const conta = input.quem.accountId ?? null;
  const email = emailNormalizado(input.quem.email);
  if (cupom.max_uses_per_customer !== null && (conta || email)) {
    const meus = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM core_coupon_redemptions
            WHERE coupon_id = ? AND status = 'ativo'
              AND ((? IS NOT NULL AND account_id = ?) OR (? IS NOT NULL AND customer_email = ?))`,
        )
        .get(cupom.id, conta, conta, email, email) as { n: number }
    ).n;
    if (meus >= cupom.max_uses_per_customer) {
      throw new ApiError(
        'CHECKOUT_CUPOM_JA_USADO',
        cupom.max_uses_per_customer === 1
          ? `Você já usou o cupom ${code} — ele vale uma vez por cliente.`
          : `Você já usou o cupom ${code} ${meus} vezes, o máximo por cliente.`,
        409,
        { code },
      );
    }
  }

  const subtotal = input.linhas.reduce((s, l) => s + l.totalCents, 0);
  if (subtotal < cupom.min_order_cents) {
    throw new ApiError(
      'CHECKOUT_CUPOM_PEDIDO_MINIMO',
      `O cupom ${code} vale para compras a partir de ${reais(cupom.min_order_cents)} em produtos desta loja. Faltam ${reais(cupom.min_order_cents - subtotal)}.`,
      400,
      { code, minOrderCents: cupom.min_order_cents, subtotalCents: subtotal },
    );
  }

  const cumulativo = Number(cupom.accumulates_with_promotions) === 1;
  const elegivel = input.linhas.map((l) => cumulativo || !l.emPromocao);
  const base = input.linhas.reduce((s, l, i) => (elegivel[i] ? s + l.totalCents : s), 0);
  const quantasElegiveis = elegivel.filter(Boolean).length;
  if (base <= 0) {
    throw new ApiError(
      'CHECKOUT_CUPOM_SO_PRECO_CHEIO',
      `O cupom ${code} não vale para itens em promoção, e os itens desta loja já estão com preço promocional.`,
      400,
      { code },
    );
  }

  const bruto =
    cupom.percent_off !== null
      ? Math.floor((base * Number(cupom.percent_off)) / 100)
      : Math.min(Number(cupom.amount_cents), base);
  // Cada linha que recebe desconto fica com pelo menos um centavo.
  const desconto = Math.min(bruto, base - quantasElegiveis);
  if (desconto <= 0) {
    throw new ApiError(
      'CHECKOUT_CUPOM_SEM_DESCONTO',
      `O cupom ${code} não dá desconto nenhum nestes itens.`,
      400,
      { code },
    );
  }

  return {
    cupomId: cupom.id,
    code,
    description: cupom.description,
    discountCents: desconto,
    porLinha: ratear(desconto, input.linhas.map((l, i) => (elegivel[i] ? l.totalCents : 0))),
  };
}

/**
 * O rateio do desconto, proporcional ao valor de cada linha elegível.
 *
 * Maior resto: cada linha recebe o piso da sua parte, e os centavos que sobram
 * vão para as de maior fração — a soma bate com o desconto ao centavo. Nenhuma
 * linha recebe tudo o que vale (fica ao menos 1 centavo): o chamador garante
 * `desconto <= soma - linhas`, e o laço só dá o centavo a quem ainda cabe.
 */
export function ratear(desconto: number, valores: number[]): number[] {
  const base = valores.reduce((s, v) => s + v, 0);
  if (base <= 0 || desconto <= 0) return valores.map(() => 0);
  const partes = valores.map((v) => (v * desconto) / base);
  const pisos = partes.map((p, i) => Math.min(Math.floor(p), Math.max(0, valores[i] - 1)));
  let resto = desconto - pisos.reduce((s, p) => s + p, 0);
  const ordem = partes
    .map((p, i) => ({ i, fracao: p - Math.floor(p) }))
    .filter(({ i }) => valores[i] > 0)
    .sort((a, b) => b.fracao - a.fracao || a.i - b.i);
  while (resto > 0) {
    let deu = false;
    for (const { i } of ordem) {
      if (resto === 0) break;
      if (pisos[i] + 1 <= valores[i] - 1) {
        pisos[i] += 1;
        resto -= 1;
        deu = true;
      }
    }
    if (!deu) break;
  }
  return pisos;
}

/** Grava o uso — na MESMA transação do pedido. */
export function registrarUsoDoCupom(input: {
  companyId: string;
  cupom: CupomAplicado;
  orderId: string;
  quem: QuemUsa;
}): void {
  getConnection()
    .prepare(
      `INSERT INTO core_coupon_redemptions
         (id, coupon_id, company_id, order_id, account_id, customer_email, discount_cents,
          status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'ativo', ?)`,
    )
    .run(
      randomUUID(),
      input.cupom.cupomId,
      input.companyId,
      input.orderId,
      input.quem.accountId ?? null,
      emailNormalizado(input.quem.email),
      input.cupom.discountCents,
      new Date().toISOString(),
    );
}

/** O pedido cancelado devolve o uso do cupom. Repetir não faz nada de novo. */
export function liberarUsoDoCupom(orderId: string): void {
  ensureCoreSchema();
  getConnection()
    .prepare(
      `UPDATE core_coupon_redemptions SET status = 'liberado', released_at = ?
        WHERE order_id = ? AND status = 'ativo'`,
    )
    .run(new Date().toISOString(), orderId);
}

// ------------------------------------------------------------ simulação

export interface LojaParaCupom {
  companyId: string;
  storeName: string;
  linhas: LinhaParaCupom[];
}

/**
 * "Aplicar" na gaveta do carrinho: o MESMO cálculo do checkout, sem gravar.
 * A tela mostra o desconto e o total antes do clique; o checkout confere de
 * novo (entre um e outro o cupom pode esgotar).
 */
export function simularCupom(input: {
  code: unknown;
  lojas: LojaParaCupom[];
  quem: QuemUsa;
}): {
  code: string;
  discountCents: number;
  lojas: { companyId: string; storeName: string; discountCents: number; description: string | null }[];
} {
  const code = normalizarCodigo(input.code);
  if (!code) {
    throw new ApiError('CHECKOUT_CUPOM_VAZIO', 'Digite o código do cupom.', 400);
  }
  const comCupom = new Set(
    empresasComCupom(
      code,
      input.lojas.map((l) => l.companyId),
    ),
  );
  if (comCupom.size === 0) throw cupomInvalido(code);
  const lojas = input.lojas
    .filter((l) => comCupom.has(l.companyId))
    .map((l) => {
      const r = aplicarCupom({ companyId: l.companyId, code, linhas: l.linhas, quem: input.quem });
      return {
        companyId: l.companyId,
        storeName: l.storeName,
        discountCents: r.discountCents,
        description: r.description,
      };
    });
  return { code, discountCents: lojas.reduce((s, l) => s + l.discountCents, 0), lojas };
}

// ---------------------------------------------------------- administração

function invalido(mensagem: string, details?: unknown): ApiError {
  return new ApiError('CORE_INVALID_COUPON', mensagem, 400, details);
}

function inteiroDoCorpo(valor: unknown, campo: string): number | null {
  if (valor === undefined || valor === null || valor === '') return null;
  const n = typeof valor === 'number' ? valor : Number(valor);
  if (typeof valor === 'boolean' || !Number.isInteger(n)) {
    throw invalido(`${campo}: informe um número inteiro.`);
  }
  return n;
}

function instanteDoCorpo(valor: unknown, ponta: 'inicio' | 'fim'): string | null {
  const texto = valor === undefined || valor === null ? '' : String(valor).trim();
  if (!texto) return null;
  const convertido = ponta === 'inicio' ? comoInstanteInicial(texto) : comoInstanteFinal(texto);
  if (Number.isNaN(Date.parse(convertido))) {
    throw invalido(`Data de ${ponta === 'inicio' ? 'início' : 'fim'} inválida: use AAAA-MM-DD.`);
  }
  return new Date(convertido).toISOString();
}

/**
 * Cria o cupom, conferido. Os padrões são os seguros: uma vez por cliente,
 * não cumulativo com promoção, começa agora e sem prazo.
 */
export function criarCupom(input: {
  companyId: string;
  userId: string | null;
  corpo: Record<string, unknown>;
}): LinhaDoCupom {
  ensureCoreSchema();
  const corpo = input.corpo ?? {};
  const code = normalizarCodigo(corpo.code);
  if (!CODIGO.test(code)) {
    throw invalido(
      'O código do cupom tem de 3 a 30 caracteres: letras sem acento, números, "-" ou "_" (ex.: BEMVINDO10).',
    );
  }
  const descricao = corpo.description === undefined || corpo.description === null
    ? null
    : String(corpo.description).trim().slice(0, 120) || null;

  const percentualCru = corpo.percentOff;
  const percentual =
    percentualCru === undefined || percentualCru === null || percentualCru === ''
      ? null
      : Number(percentualCru);
  const valor = inteiroDoCorpo(corpo.amountCents, 'Valor do desconto (centavos)');
  if (percentual !== null && valor !== null) {
    throw invalido('Escolha UM tipo de desconto: percentual OU valor fixo.');
  }
  if (percentual === null && valor === null) {
    throw invalido('Informe o desconto do cupom: um percentual ou um valor fixo.');
  }
  if (percentual !== null && (!Number.isFinite(percentual) || !(percentual > 0) || percentual >= 100)) {
    throw invalido('O percentual do cupom precisa ser maior que 0 e menor que 100.');
  }
  if (valor !== null && !(valor > 0)) {
    throw invalido('O valor do desconto precisa ser maior que zero.');
  }

  const minimo = inteiroDoCorpo(corpo.minOrderCents, 'Pedido mínimo (centavos)') ?? 0;
  if (minimo < 0) throw invalido('O pedido mínimo não pode ser negativo.');
  if (valor !== null && minimo <= valor) {
    throw invalido(
      `O pedido mínimo precisa ser maior que o desconto (${reais(valor)}) — senão o cupom pagaria o pedido inteiro.`,
    );
  }

  const inicio = instanteDoCorpo(corpo.startsAt, 'inicio') ?? new Date().toISOString();
  const fim = instanteDoCorpo(corpo.endsAt, 'fim');
  if (fim !== null && fim < inicio) {
    throw invalido(
      `O cupom terminaria antes de começar: o fim (${dataBR(fim)}) é anterior ao início (${dataBR(inicio)}).`,
    );
  }

  const usos = inteiroDoCorpo(corpo.maxUses, 'Limite de usos');
  if (usos !== null && !(usos > 0)) throw invalido('O limite de usos precisa ser maior que zero.');
  // Ausente = uma vez por cliente (o padrão seguro); nulo explícito = sem teto.
  const porCliente = tem(corpo, 'maxUsesPerCustomer')
    ? inteiroDoCorpo(corpo.maxUsesPerCustomer, 'Usos por cliente')
    : 1;
  if (porCliente !== null && !(porCliente > 0)) {
    throw invalido('O limite por cliente precisa ser maior que zero (ou vazio, para sem limite).');
  }

  const db = getConnection();
  const existe = db
    .prepare('SELECT 1 AS n FROM core_coupons WHERE company_id = ? AND code = ?')
    .get(input.companyId, code);
  if (existe) {
    throw new ApiError(
      'CORE_COUPON_CODE_TAKEN',
      `Já existe um cupom ${code} nesta empresa (em uso ou encerrado): o código conta a história dos pedidos que o usaram. Escolha outro.`,
      409,
      { code },
    );
  }

  const id = randomUUID();
  db.prepare(
    `INSERT INTO core_coupons
       (id, company_id, code, description, percent_off, amount_cents, min_order_cents,
        starts_at, ends_at, max_uses, max_uses_per_customer, accumulates_with_promotions,
        active, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  ).run(
    id,
    input.companyId,
    code,
    descricao,
    percentual === null ? null : Math.round(percentual * 100) / 100,
    valor,
    minimo,
    inicio,
    fim,
    usos,
    porCliente,
    corpo.accumulatesWithPromotions === true ? 1 : 0,
    input.userId,
    new Date().toISOString(),
  );
  return db.prepare('SELECT * FROM core_coupons WHERE id = ?').get(id) as unknown as LinhaDoCupom;
}

const tem = (corpo: Record<string, unknown>, campo: string) =>
  Object.prototype.hasOwnProperty.call(corpo, campo);

export interface CupomDaLista extends LinhaDoCupom {
  /** Usos que contam no teto (pedidos não cancelados). */
  uses: number;
  /** Quanto o cupom já descontou, nos pedidos não cancelados. */
  discount_total_cents: number;
}

export function listarCupons(companyId: string): CupomDaLista[] {
  ensureCoreSchema();
  return getConnection()
    .prepare(
      `SELECT c.*,
              (SELECT COUNT(*) FROM core_coupon_redemptions r
                WHERE r.coupon_id = c.id AND r.status = 'ativo') AS uses,
              (SELECT COALESCE(SUM(r.discount_cents), 0) FROM core_coupon_redemptions r
                WHERE r.coupon_id = c.id AND r.status = 'ativo') AS discount_total_cents
         FROM core_coupons c
        WHERE c.company_id = ?
        ORDER BY c.created_at DESC`,
    )
    .all(companyId) as unknown as CupomDaLista[];
}

/**
 * Encerra o cupom: o código deixa de valer no checkout na hora. Os pedidos
 * que já o usaram continuam com o desconto (é o retrato deles). Repetir não
 * faz nada de novo.
 */
export function encerrarCupom(input: {
  companyId: string;
  userId: string | null;
  id: string;
}): { cupom: LinhaDoCupom; mudou: boolean } {
  ensureCoreSchema();
  const db = getConnection();
  const cupom = db
    .prepare('SELECT * FROM core_coupons WHERE id = ? AND company_id = ?')
    .get(input.id, input.companyId) as LinhaDoCupom | undefined;
  if (!cupom) throw new ApiError('CORE_COUPON_NOT_FOUND', 'Cupom não encontrado.', 404);
  if (!cupom.active) return { cupom, mudou: false };
  db.prepare(
    'UPDATE core_coupons SET active = 0, ended_at = ?, ended_by = ? WHERE id = ? AND company_id = ?',
  ).run(new Date().toISOString(), input.userId, input.id, input.companyId);
  return {
    cupom: db.prepare('SELECT * FROM core_coupons WHERE id = ?').get(input.id) as unknown as LinhaDoCupom,
    mudou: true,
  };
}
