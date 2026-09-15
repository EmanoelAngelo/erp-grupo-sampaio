/**
 * A política comercial do balcão — o que o operador pode fazer sem chamar o dono.
 *
 * ## O que esta rodada descobriu, e é o motivo de o módulo existir
 *
 * Três números decidiam sozinhos o dia a dia de quem está no caixa, e os três
 * estavam cravados onde o dono não alcança:
 *
 *   - 10% de desconto era uma constante em AuthorizationService;
 *   - venda fiada nascia vencendo NO MESMO DIA, porque o lançamento a receber
 *     copiava a data de hoje sem perguntar nada a ninguém;
 *   - os 7 dias de validade da pré-venda existiam SÓ na tela de orçamento, e
 *     a pré-venda criada pela aprovação nascia sem vencimento — segurando
 *     estoque para sempre.
 *
 * ## NULO É "O COMPORTAMENTO DE HOJE", e isso é a regra central daqui
 *
 * Não é "sem valor", não é "desligado". Empresa que nunca abriu esta tela e
 * empresa com as três colunas nulas se comportam exatamente como o sistema se
 * comportava antes de a tabela existir. Por isso a leitura NUNCA devolve nulo
 * para quem calcula: devolve o número efetivo, e devolve à parte quem o
 * escolheu — em "definidos". Quem calcula não precisa saber de onde veio; quem
 * MOSTRA precisa, para a tela poder dizer "padrão do sistema" em vez de fingir
 * que o dono digitou 10.
 *
 * ## O que NÃO entra aqui
 *
 * Regra fiscal, regra de estoque e preferência de tela. O critério de entrada
 * está escrito na DDL, em schema.ts, junto da tabela — e a condição que mais
 * se esquece é a terceira: coluna nova só nasce com LEITOR no servidor no
 * mesmo commit. Sem esse freio, esta tabela vira o depósito de quinze colunas
 * que ninguém lê, que é exatamente o que payment_term_days já foi.
 */
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { fimDoDia, hojeNaLoja, somarDias } from './CalendarioOperacional.js';
import { emReais } from './Money.js';
import { precoPorMargem, precoPorMarkup } from './Pricing.js';

/**
 * Os padrões — o comportamento de hoje, escrito uma vez só.
 *
 * Estão aqui e não espalhados pelos leitores porque a tela precisa mostrar
 * "10% (padrão do sistema)" com o MESMO número que a venda aplica. Dois
 * lugares guardando o padrão divergem no primeiro dia em que alguém muda um
 * deles, e o sintoma é a tela dizendo uma coisa e o balcão fazendo outra.
 */
export const PADRAO_LIMITE_DESCONTO_PERCENT = 10;
/** Zero dias = vence no dia da venda, que é o que o sistema sempre fez. */
export const PADRAO_PRAZO_FIADO_DIAS = 0;
/** Sete dias, a constante que morava no formulário de orçamento do frontend. */
export const PADRAO_VALIDADE_RESERVA_DIAS = 7;

export interface PoliticaDeVenda {
  discountLimitPercent: number;
  creditSaleDueDays: number;
  reservationValidDays: number;
  /**
   * Teto da sangria em CENTAVOS, ou `null` quando não há teto.
   *
   * É o único campo desta política que pode ser nulo no resultado, e a exceção
   * é o próprio significado: "sem teto" não tem número que o represente. Zero
   * seria o oposto — toda sangria chama o gestor —, então usar zero como
   * ausência trocaria "pode tudo" por "não pode nada" no dia em que alguém
   * lesse o campo sem ler este comentário.
   */
  cashWithdrawalLimitCents: number | null;
  /**
   * A OS da oficina pode ser faturada para o cliente — sem pagamento na hora,
   * vencendo em `creditSaleDueDays` (GAP-PRD-104).
   *
   * Falso é o padrão, e é o comportamento de antes: o caixa só fecha a OS com o
   * total coberto. Ligar é decisão do dono, porque é crédito concedido — e a
   * trava mora no recebimento da OS, que é quem lê este campo.
   */
  workshopCreditEnabled: boolean;
  /**
   * A liberação de desconto acima da alçada só vale com MOTIVO digitado
   * (P0 da Preço Justo). Falso é o padrão, e é o comportamento de sempre: o
   * motivo continua aceito, só não é exigido. Leitor: `authorizeAction`.
   */
  discountReasonRequired: boolean;
  /** Quais vieram do cadastro e quais são o padrão — a tela mostra a diferença. */
  definidos: {
    discountLimitPercent: boolean;
    creditSaleDueDays: boolean;
    reservationValidDays: boolean;
    cashWithdrawalLimitCents: boolean;
    workshopCreditEnabled: boolean;
    discountReasonRequired: boolean;
  };
}

interface LinhaDePolitica {
  discount_limit_percent: number | null;
  credit_sale_due_days: number | null;
  reservation_valid_days: number | null;
  cash_withdrawal_limit_cents: number | null;
  workshop_credit_enabled: number | null;
  discount_reason_required: number | null;
}

/**
 * A política vigente da empresa, já resolvida contra os padrões.
 *
 * Empresa sem linha é o estado normal de quem nunca configurou — e não é erro
 * nem ausência. Devolver o padrão evita que cada chamador escreva o seu
 * próprio "se não tem, usa 10", que é como um padrão vira três padrões.
 */
export function politicaDaEmpresa(companyId: string): PoliticaDeVenda {
  ensureCoreSchema();
  const linha = getConnection()
    .prepare(
      `SELECT discount_limit_percent, credit_sale_due_days, reservation_valid_days,
              cash_withdrawal_limit_cents, workshop_credit_enabled, discount_reason_required
         FROM core_sale_policies WHERE company_id = ?`,
    )
    .get(companyId) as LinhaDePolitica | undefined;

  const limite = linha?.discount_limit_percent ?? null;
  const prazo = linha?.credit_sale_due_days ?? null;
  const validade = linha?.reservation_valid_days ?? null;
  const tetoSangria = linha?.cash_withdrawal_limit_cents ?? null;
  const faturaOs = linha?.workshop_credit_enabled ?? null;
  const motivoObrigatorio = linha?.discount_reason_required ?? null;

  return {
    discountLimitPercent: limite ?? PADRAO_LIMITE_DESCONTO_PERCENT,
    creditSaleDueDays: prazo ?? PADRAO_PRAZO_FIADO_DIAS,
    reservationValidDays: validade ?? PADRAO_VALIDADE_RESERVA_DIAS,
    // Sem padrão de sistema, e é a diferença dos outros três: aqui a ausência
    // NÃO é um número, é a ausência de trava. Inventar um teto padrão ligaria a
    // exigência de gestor nas seis operações de uma vez, num deploy que ninguém
    // pediu.
    cashWithdrawalLimitCents: tetoSangria,
    // Nulo e zero são o mesmo "não": só o 1 gravado de propósito concede prazo.
    workshopCreditEnabled: faturaOs === 1,
    // Mesmo molde: só o 1 gravado de propósito exige o motivo.
    discountReasonRequired: motivoObrigatorio === 1,
    definidos: {
      discountLimitPercent: limite !== null,
      creditSaleDueDays: prazo !== null,
      reservationValidDays: validade !== null,
      cashWithdrawalLimitCents: tetoSangria !== null,
      workshopCreditEnabled: faturaOs !== null,
      discountReasonRequired: motivoObrigatorio !== null,
    },
  };
}

/**
 * COMO A DEVOLUÇÃO DEVOLVE O DINHEIRO — `core_sale_policies.return_refund_flow`.
 *
 * 'imediato' é o comportamento de sempre (e o de toda operação sem a coluna):
 * o registro da devolução já dá o dinheiro por devolvido. 'duas_etapas' separa
 * a MERCADORIA do REEMBOLSO: a devolução trata itens e estoque, e o reembolso é
 * registrado depois, pelo que de fato aconteceu (ver SaleReturnService).
 */
export type FluxoDaDevolucao = 'imediato' | 'duas_etapas';

export function fluxoDaDevolucao(companyId: string): FluxoDaDevolucao {
  ensureCoreSchema();
  const linha = getConnection()
    .prepare('SELECT return_refund_flow FROM core_sale_policies WHERE company_id = ?')
    .get(companyId) as { return_refund_flow: string | null } | undefined;
  return linha?.return_refund_flow === 'duas_etapas' ? 'duas_etapas' : 'imediato';
}

/**
 * LIGA A DEVOLUÇÃO EM DUAS ETAPAS NA PREÇO JUSTO — e só nela.
 *
 * Roda a cada subida (`prepararBanco`) e no bootstrap (banco novo), e só
 * escreve onde a coluna está VAZIA: o que o dono gravar depois fica. As outras
 * cinco operações seguem no fluxo imediato até a missão que as migrar — esta
 * função não as toca. Devolve se escreveu.
 */
export function ativarDevolucaoEmDuasEtapasNaPrecoJusto(): boolean {
  ensureCoreSchema();
  const agora = new Date().toISOString();
  const r = getConnection()
    .prepare(
      `INSERT INTO core_sale_policies (company_id, return_refund_flow, created_at, updated_at)
       SELECT id, 'duas_etapas', ?, ? FROM core_companies WHERE slug = 'preco-justo'
       ON CONFLICT (company_id) DO UPDATE SET
         return_refund_flow = 'duas_etapas',
         updated_at         = excluded.updated_at
       WHERE core_sale_policies.return_refund_flow IS NULL`,
    )
    .run(agora, agora);
  return Number(r.changes) > 0;
}

/**
 * EXIGE O MOTIVO DA LIBERAÇÃO DE DESCONTO NA PREÇO JUSTO — e só nela (P0).
 *
 * O mesmo molde de `ativarDevolucaoEmDuasEtapasNaPrecoJusto`, e pelo mesmo
 * motivo: roda a cada subida (`prepararBanco`) e no bootstrap (banco novo), e
 * só escreve onde a coluna está NULA. O "não" que o dono gravar depois (0)
 * fica; as outras cinco operações seguem com o motivo opcional, que é o
 * comportamento de sempre — esta função não as toca. Devolve se escreveu.
 *
 * NÃO cria limite por perfil nenhum, e é decisão: quanto a atendente dá e quanto
 * uma linha aguenta são números do DONO. Inventá-los aqui mudaria o balcão da
 * loja num deploy que ninguém pediu. Sem linha em `core_discount_limits`, a
 * Preço Justo vende com os limites de hoje até alguém configurar a tela.
 */
export function exigirMotivoDaLiberacaoNaPrecoJusto(): boolean {
  ensureCoreSchema();
  const agora = new Date().toISOString();
  const r = getConnection()
    .prepare(
      `INSERT INTO core_sale_policies (company_id, discount_reason_required, created_at, updated_at)
       SELECT id, 1, ?, ? FROM core_companies WHERE slug = 'preco-justo'
       ON CONFLICT (company_id) DO UPDATE SET
         discount_reason_required = 1,
         updated_at               = excluded.updated_at
       WHERE core_sale_policies.discount_reason_required IS NULL`,
    )
    .run(agora, agora);
  return Number(r.changes) > 0;
}

/**
 * OS PERFIS QUE PODEM TER LIMITE PRÓPRIO DE DESCONTO (P0 da Preço Justo).
 *
 * Todo perfil que vende ou libera, e só eles. `admin_geral` fica FORA de
 * propósito: é a alçada que responde pelo grupo inteiro, e um teto nele poderia
 * deixar a operação sem ninguém capaz de liberar a concessão grande — a trava
 * viraria balcão parado. `contador` não vende. Perfil fora desta lista é
 * recusado na gravação: um erro de digitação no código do perfil viraria um
 * limite que nunca vale para ninguém, e o dono acreditaria nele.
 */
export const PERFIS_COM_LIMITE_DE_DESCONTO = [
  'operador_caixa_loja',
  'operador_caixa_oficina',
  'operador_caixa',
  'atendente',
  'estoquista',
  'mecanico',
  'gerente_loja',
  'gerente_oficina',
  'gerente_operacao_loja',
  'gestor',
] as const;

/**
 * O limite de desconto de UM perfil nesta operação — uma linha de
 * `core_discount_limits`. Cada nulo é "sem este teto", com a exceção escrita
 * na DDL: `maxPercent` nulo num perfil SEM alçada é o limite da operação.
 */
export interface LimitePorPerfil {
  profileCode: string;
  /** Concessão da venda inteira, em % do bruto. */
  maxPercent: number | null;
  /** Concessão da venda inteira, em CENTAVOS. */
  maxCents: number | null;
  /** Concessão de UMA linha, em % do bruto dela. */
  itemMaxPercent: number | null;
  /** Concessão de UMA linha, em CENTAVOS. */
  itemMaxCents: number | null;
}

export function limitesPorPerfil(companyId: string): LimitePorPerfil[] {
  ensureCoreSchema();
  const linhas = getConnection()
    .prepare(
      `SELECT profile_code, max_percent, max_cents, item_max_percent, item_max_cents
         FROM core_discount_limits WHERE company_id = ? ORDER BY profile_code`,
    )
    .all(companyId) as unknown as {
    profile_code: string;
    max_percent: number | null;
    max_cents: number | null;
    item_max_percent: number | null;
    item_max_cents: number | null;
  }[];
  return linhas.map((l) => ({
    profileCode: l.profile_code,
    maxPercent: l.max_percent,
    maxCents: l.max_cents,
    itemMaxPercent: l.item_max_percent,
    itemMaxCents: l.item_max_cents,
  }));
}

/**
 * Confere a lista que veio da tela ANTES de qualquer escrita — e recusa alto.
 *
 * A mesma régua de `salvarPolitica` (`numeroOuPadrao`): texto que não é número
 * é recusado com o nome do campo, vazio é "sem este teto", e o valor em REAIS
 * vira CENTAVOS aqui. Percentual é arredondado a duas casas na gravação, que é
 * a precisão com que a venda compara (ver `passaDoPercentual`): guardar 7,125
 * e comparar 7,13 faria a tela dizer um número e o balcão aplicar outro.
 */
export function normalizarLimitesPorPerfil(entrada: unknown): LimitePorPerfil[] {
  if (!Array.isArray(entrada)) {
    throw new ApiError(
      'CORE_SALE_POLICY_INVALID',
      'Limites por perfil: envie a lista de perfis.',
      400,
      { campo: 'limitesPorPerfil' },
    );
  }
  const conhecidos = new Set<string>(PERFIS_COM_LIMITE_DE_DESCONTO);
  const vistos = new Set<string>();
  const percentual = { min: 0, max: 100, inteiro: false };
  const reais = { min: 0, max: 1_000_000, inteiro: false };
  const duasCasas = (v: number | null) => (v === null ? null : Math.round(v * 100) / 100);
  const emCentavos = (v: number | null) => (v === null ? null : Math.round(v * 100));
  return entrada.map((bruto) => {
    const item = (bruto && typeof bruto === 'object' ? bruto : {}) as Record<string, unknown>;
    const perfil = String(item.profileCode ?? '').trim();
    if (!conhecidos.has(perfil)) {
      throw new ApiError(
        'CORE_SALE_POLICY_INVALID',
        `Limites por perfil: "${perfil}" não é um perfil que vende ou libera desconto.`,
        400,
        { campo: 'limitesPorPerfil', profileCode: perfil },
      );
    }
    if (vistos.has(perfil)) {
      throw new ApiError(
        'CORE_SALE_POLICY_INVALID',
        `Limites por perfil: "${perfil}" aparece duas vezes.`,
        400,
        { campo: 'limitesPorPerfil', profileCode: perfil },
      );
    }
    vistos.add(perfil);
    return {
      profileCode: perfil,
      maxPercent: duasCasas(numeroOuPadrao(item.maxPercent, `Desconto da venda (${perfil}, %)`, percentual)),
      maxCents: emCentavos(numeroOuPadrao(item.maxReais, `Desconto da venda (${perfil}, R$)`, reais)),
      itemMaxPercent: duasCasas(
        numeroOuPadrao(item.itemMaxPercent, `Desconto por item (${perfil}, %)`, percentual),
      ),
      itemMaxCents: emCentavos(numeroOuPadrao(item.itemMaxReais, `Desconto por item (${perfil}, R$)`, reais)),
    };
  });
}

/**
 * Grava a lista INTEIRA de limites por perfil da operação.
 *
 * A lista é o estado final: perfil que saiu dela volta ao padrão (a linha é
 * apagada), e perfil com os quatro tetos vazios também — linha com tudo nulo
 * seria "configurado" sem configurar nada, e a trilha diria que alguém decidiu
 * um limite que não existe. Configuração do dono, e não dado de venda: a venda
 * que já aconteceu guardou na trilha dela o limite com que foi medida.
 */
export function gravarLimitesPorPerfil(input: {
  companyId: string;
  userId: string;
  limites: LimitePorPerfil[];
}): LimitePorPerfil[] {
  ensureCoreSchema();
  const db = getConnection();
  const agora = new Date().toISOString();
  const vale = input.limites.filter(
    (l) => l.maxPercent !== null || l.maxCents !== null || l.itemMaxPercent !== null || l.itemMaxCents !== null,
  );
  withTransaction(() => {
    const ficam = vale.map((l) => l.profileCode);
    db.prepare(
      `DELETE FROM core_discount_limits
        WHERE company_id = ? AND profile_code NOT IN (${ficam.map(() => '?').join(', ') || "''"})`,
    ).run(input.companyId, ...ficam);
    const gravar = db.prepare(
      `INSERT INTO core_discount_limits
         (company_id, profile_code, max_percent, max_cents, item_max_percent, item_max_cents,
          updated_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (company_id, profile_code) DO UPDATE SET
         max_percent      = excluded.max_percent,
         max_cents        = excluded.max_cents,
         item_max_percent = excluded.item_max_percent,
         item_max_cents   = excluded.item_max_cents,
         updated_by       = excluded.updated_by,
         updated_at       = excluded.updated_at`,
    );
    for (const l of vale) {
      gravar.run(
        input.companyId,
        l.profileCode,
        l.maxPercent,
        l.maxCents,
        l.itemMaxPercent,
        l.itemMaxCents,
        input.userId,
        agora,
        agora,
      );
    }
  });
  return limitesPorPerfil(input.companyId);
}

/**
 * Converte o que veio do corpo da requisição, e RECUSA o que não é número.
 *
 * Este é o ponto exato onde o par chave/valor perdia a discussão. Com
 * value TEXT, o leitor faz Number('dez') e recebe NaN; NaN > limite é FALSE, e
 * a trava que deveria pedir gestor passaria a liberar tudo em silêncio. Um
 * erro de digitação do dono ABRIRIA o balcão em vez de fechá-lo.
 *
 * Por isso a conversão mora na ESCRITA e falha alto: o banco só recebe número
 * ou nulo, e quem digitou errado descobre na hora, com a tela aberta.
 *
 * Nulo e string vazia significam a mesma coisa — "volta ao padrão do sistema"
 * —, porque é assim que um campo apagado chega de um formulário.
 */
/**
 * O que o dono digitou, na notação daqui, virando número.
 *
 * A primeira versão fazia `String(valor).replace(',', '.')` — e `replace` com
 * uma STRING troca só a PRIMEIRA ocorrência. Para "5,5" funcionava; para
 * "5.000,00" produzia "5.000.00", que é `NaN`. O efeito era um teto de sangria
 * a partir de mil reais ser recusado com "informe um número", e o dono não
 * conseguir salvar a política INTEIRA — nem para mexer no limite de desconto,
 * que não tinha nada a ver.
 *
 * O comentário original conferiu a vírgula e não conferiu o ponto. Só apareceu
 * porque a tela devolve o valor formatado ao campo, e o formato brasileiro
 * agrupa milhar.
 *
 * A REGRA: quando há vírgula, ela é o separador decimal e todo ponto é milhar.
 * Sem vírgula, o texto passa como está — "5.5" continua sendo cinco e meio,
 * que é o comportamento de hoje e o que alguém digitando um percentual espera.
 */
function comoNumero(texto: string): string {
  const limpo = texto.trim();
  return limpo.includes(',')
    ? limpo.replace(/\./g, '').replace(',', '.')
    : limpo;
}

function numeroOuPadrao(
  valor: unknown,
  campo: string,
  regras: { min: number; max: number; inteiro: boolean },
): number | null {
  if (valor === null || valor === undefined || valor === '') return null;
  const numero = typeof valor === 'number' ? valor : Number(comoNumero(String(valor)));
  if (!Number.isFinite(numero)) {
    throw new ApiError(
      'CORE_SALE_POLICY_INVALID',
      `${campo}: informe um número, ou deixe em branco para usar o padrão do sistema.`,
      400,
      { campo },
    );
  }
  if (regras.inteiro && !Number.isInteger(numero)) {
    throw new ApiError(
      'CORE_SALE_POLICY_INVALID',
      `${campo}: dias são números inteiros.`,
      400,
      { campo },
    );
  }
  if (numero < regras.min || numero > regras.max) {
    throw new ApiError(
      'CORE_SALE_POLICY_INVALID',
      `${campo}: o valor precisa estar entre ${regras.min} e ${regras.max}.`,
      400,
      { campo, min: regras.min, max: regras.max },
    );
  }
  return numero;
}

export function salvarPolitica(input: {
  companyId: string;
  /**
   * Quem está gravando.
   *
   * Não vai para a tabela: quem responde pelo histórico é o recordAudit da
   * rota, como em toda configuração por empresa deste sistema. Está na
   * assinatura para que não exista caminho de gravação anônimo — política
   * comercial mudada por ninguém é a que ninguém consegue explicar depois.
   */
  userId: string;
  discountLimitPercent?: number | string | null;
  creditSaleDueDays?: number | string | null;
  reservationValidDays?: number | string | null;
  /**
   * O teto da sangria em REAIS — e a unidade está no nome de propósito.
   *
   * A coluna guarda CENTAVOS e o dono digita REAIS. Um campo chamado
   * `cashWithdrawalLimit` sem unidade convida ao erro de cem vezes: quem manda
   * 500 pensando em reais grava R$ 5,00 e passa a ser chamado para toda
   * sangria, sem entender por quê. O nome é o único lugar onde essa confusão
   * pode ser impedida antes de virar dado.
   */
  cashWithdrawalLimitReais?: number | string | null;
  /**
   * Faturar a OS para o cliente (GAP-PRD-104). `true`/`false` gravam a escolha;
   * ausente ou nulo volta ao padrão — desligado. Qualquer outra coisa é
   * recusada: um "sim" em texto virando verdadeiro por coerção concederia
   * crédito que ninguém decidiu dar.
   */
  workshopCreditEnabled?: boolean | null;
  /**
   * Exigir motivo na liberação de desconto (P0 da Preço Justo).
   *
   * AUSENTE MANTÉM o que está gravado — ao contrário dos campos acima, e de
   * propósito: é uma trava de segurança, e um cliente antigo que salvasse a
   * política sem conhecer o campo não pode desligá-la em silêncio. `null`
   * volta ao padrão (opcional); `true`/`false` gravam a escolha; texto é
   * recusado, pelo mesmo argumento de `workshopCreditEnabled`.
   */
  discountReasonRequired?: boolean | null;
}): PoliticaDeVenda {
  ensureCoreSchema();

  // Limite ZERO é decisão legítima e diferente de nulo: significa "nenhuma
  // concessão sem gestor". Cem por cento também é: significa "o operador dá o
  // que quiser". O que não existe é limite negativo nem acima de cem — não há
  // como conceder mais do que o preço inteiro.
  const limite = numeroOuPadrao(input.discountLimitPercent, 'Limite de desconto', {
    min: 0,
    max: 100,
    inteiro: false,
  });
  // O teto de 365 não é burocracia: prazo de fiado maior que um ano é sempre
  // erro de digitação, e o efeito dele é uma dívida que nunca aparece como
  // atrasada — some do painel em vez de cobrar.
  const prazo = numeroOuPadrao(input.creditSaleDueDays, 'Prazo da venda a prazo', {
    min: 0,
    max: 365,
    inteiro: true,
  });
  // Zero é válido: a pré-venda vale até o fim do dia de hoje. Segurar estoque
  // por mais de um ano não é reserva, é estoque perdido.
  const validade = numeroOuPadrao(input.reservationValidDays, 'Validade da pré-venda', {
    min: 0,
    max: 365,
    inteiro: true,
  });

  /*
    O teto chega em REAIS e é guardado em CENTAVOS.

    O máximo de um milhão de reais não é desconfiança do dono: é a faixa em que
    um dígito extra ainda é plausível. Acima disso o número deixou de descrever
    uma gaveta de loja, e recusar aqui é mais barato que descobrir depois que a
    trava nunca dispara porque o teto é maior que todo o dinheiro que passa pelo
    caixa num ano.

    Zero é decisão legítima e oposta: TODA sangria chama o gestor. É por isso
    que `numeroOuPadrao` distingue zero de vazio, e é por isso que a tela manda
    texto — para que `''` e `'0'` cheguem separados até aqui.
  */
  const tetoReais = numeroOuPadrao(input.cashWithdrawalLimitReais, 'Teto da sangria', {
    min: 0,
    max: 1_000_000,
    inteiro: false,
  });
  const tetoSangria = tetoReais === null ? null : Math.round(tetoReais * 100);

  const faturaOsPedido: unknown = input.workshopCreditEnabled;
  if (
    faturaOsPedido !== undefined
    && faturaOsPedido !== null
    && typeof faturaOsPedido !== 'boolean'
  ) {
    throw new ApiError(
      'CORE_SALE_POLICY_INVALID',
      'Faturar OS a prazo: responda sim ou não.',
      400,
      { campo: 'workshopCreditEnabled' },
    );
  }
  const faturaOs = typeof faturaOsPedido === 'boolean' ? (faturaOsPedido ? 1 : 0) : null;

  const motivoPedido: unknown = input.discountReasonRequired;
  if (motivoPedido !== undefined && motivoPedido !== null && typeof motivoPedido !== 'boolean') {
    throw new ApiError(
      'CORE_SALE_POLICY_INVALID',
      'Exigir motivo na liberação de desconto: responda sim ou não.',
      400,
      { campo: 'discountReasonRequired' },
    );
  }
  // 1 no segundo parâmetro = "o pedido trouxe o campo, grave"; 0 = mantenha.
  const trouxeMotivo = motivoPedido === undefined ? 0 : 1;
  const motivoObrigatorio = typeof motivoPedido === 'boolean' ? (motivoPedido ? 1 : 0) : null;

  const agora = new Date().toISOString();
  getConnection()
    .prepare(
      `INSERT INTO core_sale_policies
         (company_id, discount_limit_percent, credit_sale_due_days,
          reservation_valid_days, cash_withdrawal_limit_cents, workshop_credit_enabled,
          discount_reason_required, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (company_id) DO UPDATE SET
         discount_limit_percent      = excluded.discount_limit_percent,
         credit_sale_due_days        = excluded.credit_sale_due_days,
         reservation_valid_days      = excluded.reservation_valid_days,
         cash_withdrawal_limit_cents = excluded.cash_withdrawal_limit_cents,
         workshop_credit_enabled     = excluded.workshop_credit_enabled,
         discount_reason_required    = CASE WHEN ? = 1
                                         THEN excluded.discount_reason_required
                                         ELSE core_sale_policies.discount_reason_required END,
         updated_at                  = excluded.updated_at`,
    )
    .run(
      input.companyId,
      limite,
      prazo,
      validade,
      tetoSangria,
      faturaOs,
      motivoObrigatorio,
      agora,
      agora,
      trouxeMotivo,
    );

  // Relê em vez de montar o objeto com o que acabou de entrar: o que a tela
  // mostra passa a ser o que o banco guarda, e não o que esta função acha que
  // guardou. Se um dia a gravação divergir, a tela denuncia na hora.
  return politicaDaEmpresa(input.companyId);
}

/**
 * Até quando a pré-venda segura o estoque.
 *
 * O cálculo mora AQUI, junto da política, e não em quem chama, por um motivo
 * de balcão: "vale 3 dias" para quem atende significa "até o fim do terceiro
 * dia", nunca "até esta mesma hora daqui a três dias". Uma reserva feita às
 * 17h que morre às 17h da sexta pega o cliente voltando às 18h com o dinheiro
 * na mão — e a peça já foi vendida para outro.
 *
 * Fim do dia no relógio do servidor, que é o relógio da loja. Devolve ISO
 * porque é assim que core_quotes.valid_until é comparado em expireOverdueQuotes.
 */
export function validadeDaReserva(companyId: string, agora = new Date()): string {
  const { reservationValidDays } = politicaDaEmpresa(companyId);
  /*
    `setDate`/`setHours` usam o fuso da MÁQUINA do servidor. Num contêiner em
    UTC — o padrão de quase toda hospedagem — "23:59:59.999 local" é 20:59 em
    Pelotas: a reserva soltava três horas antes do prazo, e o cliente que
    voltasse às 21h para fechar o orçamento encontrava a peça vendida.

    O prazo é do calendário da LOJA, e o último dia vale inteiro.
  */
  return fimDoDia(somarDias(hojeNaLoja(agora), reservationValidDays));
}

/**
 * O PISO DE PREÇO DE UM PRODUTO — o mínimo que o dono declarou no cadastro
 * (A-produto-17).
 *
 * O DEFEITO: `min_price_cents`, `min_markup_percent` e `min_margin_percent` são
 * escritos pelo cadastro (que já pede confirmação para salvar abaixo deles) e
 * lidos pela sugestão de preço da nota de entrada — e a VENDA nunca os lia. O
 * operador podia baixar o preço da linha até o limite de desconto da alçada, e
 * os 8% de uma camiseta de R$ 26,00 viravam R$ 23,92 numa peça cujo mínimo
 * declarado era R$ 25,00: a trava que o dono escreveu no produto não travava
 * nada no balcão, que é o único lugar onde o preço de fato é cobrado.
 *
 * A regra mora AQUI, junto da política comercial, porque é política comercial:
 * quem chama (`createSale`) só pergunta "qual é o piso?" e compara com o que a
 * linha de fato cobra. Os três mínimos viram UM preço — o MAIOR, pela mesma
 * razão da sugestão de preço (`RepricingService`): atender só o menos exigente
 * deixaria o produto violando o outro. A conta é a de `Pricing.ts`, a mesma do
 * cadastro; uma segunda implementação de markup divergiria no arredondamento.
 *
 *   - preço mínimo: vale quando é maior que zero (zero é "sem mínimo", o padrão
 *     da coluna);
 *   - markup e margem mínimos: valem quando não são nulos E o produto tem custo
 *     — sem custo não há markup a medir, e inventar um piso seria opinar sobre
 *     um preço que ninguém calculou. Margem de 100% ou mais não tem preço que a
 *     atenda (`precoPorMargem` devolve nulo) e fica de fora, como na sugestão.
 *
 * Nulo quando o produto não declara piso nenhum — o comportamento de sempre.
 */
export interface PisoDoPreco {
  /** O menor preço UNITÁRIO que o produto aceita, em centavos. */
  pisoCents: number;
  /** De qual mínimo veio, em palavras — é o que a recusa do balcão mostra. */
  regra: string;
}

function percentualEmTexto(valor: number): string {
  return String(Math.round(valor * 100) / 100).replace('.', ',');
}

export function pisoDoPreco(produto: {
  cost_cents?: number | null;
  min_price_cents?: number | null;
  min_markup_percent?: number | null;
  min_margin_percent?: number | null;
}): PisoDoPreco | null {
  const candidatos: PisoDoPreco[] = [];

  const minimo = Math.round(Number(produto.min_price_cents ?? 0));
  if (Number.isFinite(minimo) && minimo > 0) {
    candidatos.push({ pisoCents: minimo, regra: `preço mínimo de ${emReais(minimo)}` });
  }

  const custo = Math.round(Number(produto.cost_cents ?? 0));
  if (Number.isFinite(custo) && custo > 0) {
    const markup = produto.min_markup_percent;
    if (markup !== null && markup !== undefined && Number.isFinite(Number(markup))) {
      candidatos.push({
        pisoCents: precoPorMarkup(custo, Number(markup)),
        regra: `markup mínimo de ${percentualEmTexto(Number(markup))}% sobre o custo de ${emReais(custo)}`,
      });
    }
    const margem = produto.min_margin_percent;
    if (margem !== null && margem !== undefined && Number.isFinite(Number(margem))) {
      const preco = precoPorMargem(custo, Number(margem));
      if (preco !== null) {
        candidatos.push({
          pisoCents: preco,
          regra: `margem mínima de ${percentualEmTexto(Number(margem))}% sobre o custo de ${emReais(custo)}`,
        });
      }
    }
  }

  if (candidatos.length === 0) return null;
  return candidatos.reduce((maior, c) => (c.pisoCents > maior.pisoCents ? c : maior));
}

/**
 * DE ONDE VEIO O PREÇO DA GESTÃO que ficou abaixo do piso (A-produto-R01), em
 * palavras para a recusa da venda e do documento.
 *
 * O DEFEITO que isto fecha: a recusa do piso dizia "o próprio preço de venda do
 * cadastro, R$ 23,92, já está abaixo desse piso" quando os R$ 23,92 eram de uma
 * PROMOÇÃO — e mandava corrigir em Produtos um cadastro que estava em R$ 29,90.
 * A promoção não tem nome no cadastro, então é dita pelo que a distingue: a
 * categoria (ou o produto) e o percentual. Mora aqui, com o piso, porque as
 * duas recusas (venda e documento) precisam da MESMA frase.
 */
export function origemDoPrecoDaGestao(
  companyId: string,
  input: { fonte: string; promotionId?: string | null; tabela?: string | null },
): string {
  if (input.fonte === 'tabela') {
    return input.tabela
      ? `a tabela de preço "${input.tabela}" do cliente`
      : 'a tabela de preço do cliente';
  }
  // REVISÃO: a frase era "o preço por quantidade desta quantidade" — o
  // operador lia duas vezes e não sabia de onde vinha o preço. A faixa é
  // cadastro do produto, e é assim que ela aparece para quem a criou.
  if (input.fonte === 'faixa') return 'a faixa de preço por quantidade deste produto';
  if (input.fonte === 'promocao') {
    const promo = input.promotionId
      ? (getConnection()
          .prepare('SELECT category, percent_off FROM core_promotions WHERE id = ? AND company_id = ?')
          .get(input.promotionId, companyId) as
          | { category: string | null; percent_off: number | null }
          | undefined)
      : undefined;
    const percentual =
      promo?.percent_off != null ? ` de ${percentualEmTexto(Number(promo.percent_off))}%` : '';
    return promo?.category
      ? `a promoção${percentual} da categoria "${promo.category}"`
      : `a promoção${percentual} deste produto`;
  }
  return 'o preço vigente';
}
