/**
 * Preço vigente de um produto.
 *
 * Vive fora da loja e fora do PDV de propósito: o preço promocional é regra
 * de negócio da operação, não detalhe de um canal. Os dois canais chamam esta
 * mesma função, então nunca divergem — a vitrine não pode anunciar um valor
 * que o balcão não cobra.
 *
 * ## A TABELA DE PREÇO ENTRA AQUI, E NÃO NA VENDA
 *
 * O revendedor tem desconto combinado, e até esta rodada ele era digitado À MÃO
 * em cada venda. Digitar desconto tem uma consequência que ninguém associa à
 * causa: em `SalesService`, o teto do item, o bruto da linha e o "preço
 * rebaixado" saem TODOS de `priceCents`. Desconto digitado por fora, portanto,
 * é CONCESSÃO — e um revendedor com 15% combinado estourava a alçada de 10% em
 * toda compra, parando o balcão para chamar gestor a cada venda de atacado.
 *
 * Pondo o preço da tabela DENTRO do vigente, o combinado passa a viver no
 * DENOMINADOR: o bruto da venda já nasce com o desconto do revendedor, o
 * numerador da concessão fica zero, e só o que o operador conceder ALÉM da
 * tabela é medido. É esta linha que decide se a funcionalidade nasce usável.
 */
import { getConnection } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import {
  faixasAtivasDaEmpresa,
  listPriceTiers,
  priceInTable,
  priceTableForCustomer,
  type FaixaDePreco,
} from './CatalogAuxService.js';
import { hojeNaLoja, horaDaLoja } from './CalendarioOperacional.js';

/**
 * De ONDE saiu o preço que está valendo.
 *
 * Existe porque a tela precisa explicar o número sem reimplementar a regra: o
 * PDV mostra "preço de revenda" e não "promoção", e a etiqueta do balcão não
 * pode anunciar como promoção um valor que só aquele cliente tem.
 *
 * 'aberto' é o caso em que NÃO HÁ preço vigente para calcular — ver `openPrice`
 * logo abaixo.
 */
export type FontePreco = 'cadastro' | 'promocao' | 'tabela' | 'faixa' | 'aberto';

/**
 * QUE DIA DA SEMANA É HOJE NA LOJA — 0 domingo, 6 sábado (GAP-V03).
 *
 * Não é `new Date().getDay()`, e a diferença é a mordida que este projeto já
 * levou duas vezes: o carimbo do servidor é Greenwich, e das 21h à meia-noite
 * de Pelotas o relógio de lá já virou o dia. Uma promoção "toda quarta"
 * morreria às 21h de quarta e começaria às 21h de terça — as três horas mais
 * cheias do balcão, nos dois casos errados.
 *
 * `hojeNaLoja()` devolve o dia de CALENDÁRIO da loja ('AAAA-MM-DD'). Lê-lo de
 * volta ao meio-dia UTC é o que impede o outro lado do mesmo defeito: uma data
 * de calendário lida como meia-noite recua um dia em qualquer fuso negativo.
 */
export function diaDaSemanaDaLoja(agora: Date = new Date()): number {
  return new Date(`${hojeNaLoja(agora)}T12:00:00.000Z`).getUTCDay();
}

/**
 * A promoção vale HOJE, pelo dia da semana?
 *
 * NULO (e vazio) = todos os dias, que é o que TODA promoção gravada antes
 * desta rodada significa. Por isso a ausência não é tratada como "nenhum dia":
 * ligar o filtro sem esta linha desligaria, de uma vez, todas as promoções que
 * já estavam no ar.
 */
export function valeNesteDiaDaSemana(
  weekdays: string | null | undefined,
  diaDaSemana: number,
): boolean {
  const dias = String(weekdays ?? '').trim();
  if (!dias) return true;
  return dias.includes(String(diaDaSemana));
}

/**
 * A promoção vale AGORA, pelo horário? (GAP-PRD-194)
 *
 * 'HH:MM' no relógio da loja, início inclusivo e fim exclusivo: "das 18:00 às
 * 20:00" vale às 18:00 e já não vale às 20:00. Nulo = sem ponta: o dia
 * inteiro, que é o que toda promoção anterior a esta coluna significa.
 *
 * Comparar texto 'HH:MM' funciona porque o formato tem largura fixa — e é o
 * serviço de promoções que garante isso na escrita.
 */
export function valeNesteHorario(
  inicio: string | null | undefined,
  fim: string | null | undefined,
  hora: string,
): boolean {
  const de = String(inicio ?? '').trim() || '00:00';
  const ate = String(fim ?? '').trim() || '24:00';
  return hora >= de && hora < ate;
}

/**
 * Quantas unidades a promoção com teto ainda tem, ou nulo sem teto.
 *
 * O consumo vem de `units_used`, que as consultas desta casa calculam por
 * `unidadesUsadasSql` — a mesma conta na vitrine, no balcão e na lista.
 */
export function saldoDaPromocao(p: {
  max_units?: number | null;
  units_used?: number | null;
}): number | null {
  if (p.max_units === null || p.max_units === undefined) return null;
  return Number(p.max_units) - Number(p.units_used ?? 0);
}

/**
 * As unidades que já saíram pelo preço de uma promoção, nos DOIS canais.
 *
 * Conta as linhas que gravaram `promotion_id`: venda do balcão não cancelada
 * e pedido online não cancelado (o cancelado devolveu a reserva — e a
 * unidade volta ao saldo da promoção junto). Reembolso e devolução continuam
 * contando: a unidade saiu pelo preço promocional, e reabrir o saldo por isso
 * faria a campanha "até acabar" vender mais do que anunciou.
 *
 * Só calcula quando há teto: a promoção sem teto (a imensa maioria) não paga
 * a subconsulta.
 */
export function unidadesUsadasSql(alias: string): string {
  return `CASE WHEN ${alias}.max_units IS NULL THEN 0 ELSE
    (SELECT COALESCE(SUM(si.quantity), 0) FROM core_sale_items si
       JOIN core_sales s ON s.id = si.sale_id
      WHERE si.promotion_id = ${alias}.id AND s.status <> 'cancelled')
  + (SELECT COALESCE(SUM(oi.quantity), 0) FROM core_order_items oi
       JOIN core_orders o ON o.id = oi.order_id
      WHERE oi.promotion_id = ${alias}.id AND o.status <> 'cancelado') END`;
}

export interface EffectivePrice {
  priceCents: number;
  onSale: boolean;
  fonte: FontePreco;
  /**
   * A promoção que deu o preço, quando `fonte` é 'promocao' (GAP-PRD-194).
   * É ela que a venda e o pedido gravam na linha para contar o estoque
   * promocional. Nulo em qualquer outra fonte.
   */
  promocaoId?: string | null;
}

export interface OpcoesDePreco {
  /**
   * Tabela do CLIENTE desta venda, quando há cliente e ele tem tabela.
   *
   * Nulo/ausente = preço de tabela normal, que é o que todo cliente que já
   * existe significa. Quem resolve o id é `priceTableForCustomer`, que só
   * devolve tabela ATIVA — desativar uma tabela precisa ter efeito de verdade,
   * e não pode depender de cada chamador lembrar de filtrar.
   */
  priceTableId?: string | null;
  /**
   * O produto é de PREÇO ABERTO (mão de obra, serviço, o que se combina no
   * balcão).
   *
   * A exclusão mora aqui, e não em cada chamador, porque ela precisa valer dos
   * dois lados com a MESMA decisão: o servidor devolve `fonte: 'aberto'` e a
   * tela usa isso para não reprecificar a linha. Esses produtos costumam ter
   * `price_cents` ZERO no cadastro; reprecificá-los no instante em que o
   * cliente é escolhido zeraria a linha de mão de obra da OS — o valor
   * digitado pelo atendente sumiria sem erro nenhum.
   */
  openPrice?: boolean;
  /**
   * As promoções vigentes JÁ LIDAS, para quem precifica muitos produtos.
   *
   * A vitrine chama esta função uma vez por produto do catálogo. Cada chamada
   * ia ao banco procurar a promoção daquele item — uma ida por produto, num
   * processo síncrono que também atende o balcão. Passando a lista da empresa,
   * a leitura acontece uma vez e a REGRA continua sendo desta função.
   *
   * Ausente: a função lê sozinha, como sempre.
   */
  promocoes?: PromocaoVigente[];
  /**
   * QUANTAS unidades desta LINHA (GAP-V04).
   *
   * É a quantidade que decide se a faixa de atacado ("3 por R$ 10") vale. Fica
   * na linha, e não no carrinho inteiro, porque é assim que a oferta é feita e
   * conferida: quem leva três daquele item paga o preço de três daquele item —
   * somar itens diferentes para atingir um piso é outra promoção, que ninguém
   * pediu e que o cupom não saberia explicar.
   *
   * Ausente (ou 1) = a faixa não entra na disputa, e nada muda.
   */
  quantidade?: number;
  /**
   * As faixas da empresa JÁ LIDAS, pelo mesmo motivo de `promocoes`: quem
   * precifica um catálogo inteiro lê uma vez em vez de uma ida por produto.
   */
  faixas?: FaixaDePreco[];
  /**
   * Quantas unidades desta linha sairiam do ESTOQUE PROMOCIONAL (GAP-PRD-194).
   *
   * Separado de `quantidade` de propósito: a loja online não disputa faixa
   * por quantidade (a vitrine não a anuncia), mas a promoção com teto precisa
   * saber se a linha INTEIRA cabe no saldo. A linha que não cabe sai pelo
   * preço sem aquela promoção — nunca metade por um preço e metade por outro,
   * que o cupom e a nota não saberiam explicar.
   *
   * Ausente = `quantidade`, e na falta dela, 1.
   */
  unidadesDaLinha?: number;
}

/**
 * O preço da FAIXA que vale para esta quantidade, ou nulo.
 *
 * A faixa de MAIOR piso satisfeito ganha, e não a de menor preço: comprar mais
 * nunca pode sair mais caro por unidade, e o cadastro já recusa faixa acima do
 * preço de venda. Escolher "a mais barata entre as satisfeitas" daria o mesmo
 * resultado hoje e esconderia um cadastro incoerente amanhã.
 */
function precoDaFaixa(
  companyId: string,
  productId: string,
  quantidade: number,
  faixas?: FaixaDePreco[],
): number | null {
  if (!(quantidade > 1)) return null;
  const linhas = faixas
    ? faixas.filter((f) => f.product_id === productId && f.active !== 0)
    : listPriceTiers(companyId, productId).filter((f) => f.active !== 0);
  // As duas fontes já vêm da maior para a menor; o `sort` aqui é o que garante
  // isso mesmo quando o chamador montou a lista à mão (o teste faz isso).
  const candidatas = linhas
    .filter((f) => quantidade >= f.min_quantity)
    .sort((a, b) => b.min_quantity - a.min_quantity);
  return candidatas.length > 0 ? candidatas[0].price_cents : null;
}

/**
 * Menor preço vigente agora, entre o cadastro, as promoções e a tabela.
 *
 * OS CANDIDATOS SÃO TODOS CALCULADOS SOBRE A BASE, e nunca um sobre o outro.
 * 20% de promoção com 10% de tabela dá 20%, e não 28%. Empilhar seria erosão
 * de margem invisível: não dá erro, não aparece em relatório nenhum, e o preço
 * final só é conferido quando alguém compara o cupom com o cadastro à mão.
 *
 * Promoção pode alvejar um produto específico ou uma categoria inteira;
 * havendo mais de uma vigente, vale a mais vantajosa para o cliente. O empate
 * fica com a promoção porque ela é pública: o cliente viu aquele preço
 * anunciado, e é esse nome que precisa aparecer no cupom.
 */
/** Uma promoção vigente, do jeito que a conta do preço precisa. */
export interface PromocaoVigente {
  product_id: string | null;
  category: string | null;
  price_cents: number | null;
  percent_off: number | null;
  /**
   * Dígitos dos dias em que a promoção vale (0 domingo a 6 sábado).
   *
   * Nulo = todos os dias. O campo é OPCIONAL no tipo de propósito: quem monta
   * a lista à mão (o teste, a vitrine antiga) continua compilando, e a
   * ausência cai no "vale todo dia" que era a única verdade possível antes
   * desta coluna existir.
   */
  weekdays?: string | null;
  /** O id — só para dizer QUAL promoção deu o preço (GAP-PRD-194). */
  id?: string;
  /** Faixa de horário 'HH:MM' da loja; nulo = o dia inteiro (GAP-PRD-194). */
  starts_time?: string | null;
  ends_time?: string | null;
  /** Estoque promocional e quanto dele já saiu; nulo = sem teto (GAP-PRD-194). */
  max_units?: number | null;
  units_used?: number | null;
  /**
   * 1 = quem criou confirmou o GRÁTIS (GAP-PRD-032). Sem isso, um candidato
   * de preço zero não entra na disputa — ausente conta como não confirmado,
   * que é o lado seguro.
   */
  free_confirmed?: number | null;
}

/**
 * TODAS as promoções vigentes de uma empresa, numa consulta só.
 *
 * A vitrine chama `effectivePriceCents` uma vez por produto, e cada chamada
 * ia ao banco procurar a promoção daquele item. Com o catálogo inteiro na
 * home do grupo isso é uma ida por produto — e `node:sqlite` é síncrono, no
 * mesmo processo que atende o PDV.
 *
 * A REGRA do preço não muda de lugar: quem escolhe a melhor promoção
 * continua sendo `effectivePriceCents`. O que muda é de onde vêm as linhas.
 */
export function promocoesVigentes(companyId: string): PromocaoVigente[] {
  ensureCoreSchema();
  const now = new Date().toISOString();
  const linhas = getConnection()
    .prepare(
      `SELECT ${COLUNAS_DA_PROMOCAO} FROM core_promotions pr
        WHERE pr.company_id = ? AND pr.active = 1
          AND pr.starts_at <= ?
          AND (pr.ends_at IS NULL OR pr.ends_at >= ?)`,
    )
    .all(companyId, now, now) as unknown as PromocaoVigente[];

  /*
    O DIA DA SEMANA É PENEIRADO EM TS, E NÃO NO SQL — de propósito.

    O SQLite converteria o carimbo para dia da semana com `strftime('%w')`, que
    lê UTC: das 21h à meia-noite a loja estaria no dia seguinte, e "toda
    quarta" morreria três horas antes de acabar a quarta. É o mesmo defeito que
    fez a promoção "válida até 31/12" morrer às 21h do dia 30, e a casa já tem
    o dono da resposta — `CalendarioOperacional`, que o SQL não alcança sem
    duplicar o deslocamento.

    Como a peneira é a mesma dos dois lados (aqui e em `effectivePriceCents`),
    o resultado não depende de por onde as linhas entraram.
  */
  const hoje = diaDaSemanaDaLoja();
  const hora = horaDaLoja(new Date());
  /*
    O HORÁRIO E O SALDO PENEIRAM AQUI TAMBÉM (GAP-PRD-194), pelo mesmo motivo
    do dia da semana: a hora é a do relógio da LOJA, que o SQL não alcança sem
    duplicar o deslocamento. Promoção com teto sem nenhuma unidade sobrando não
    é "vigente" — a vitrine não pode anunciar o preço de uma campanha que
    acabou.
  */
  return linhas.filter(
    (p) =>
      valeNesteDiaDaSemana(p.weekdays, hoje)
      && valeNesteHorario(p.starts_time, p.ends_time, hora)
      && (saldoDaPromocao(p) ?? 1) > 0,
  );
}

/**
 * As colunas que a disputa do preço lê de `core_promotions` (alias `pr`).
 * Uma lista só para os dois caminhos — a vitrine que lê a empresa inteira e o
 * produto avulso —, para o resultado não depender de por onde as linhas
 * entraram.
 */
const COLUNAS_DA_PROMOCAO = `pr.id, pr.product_id, pr.category, pr.price_cents, pr.percent_off,
  pr.weekdays, pr.starts_time, pr.ends_time, pr.max_units, pr.free_confirmed,
  ${unidadesUsadasSql('pr')} AS units_used`;

export function effectivePriceCents(
  companyId: string,
  productId: string,
  basePriceCents: number,
  category: string | null,
  opcoes?: OpcoesDePreco,
): EffectivePrice {
  ensureCoreSchema();

  /*
    PREÇO ABERTO SAI ANTES DE QUALQUER CONTA.

    Não é atalho de desempenho: é a afirmação de que para este produto não
    existe "preço vigente" a descobrir. O cadastro é SUGESTÃO (em geral zero) e
    o valor nasce na conversa. Devolver a base intocada com `fonte: 'aberto'`
    é o que permite ao balcão e ao servidor tomarem a MESMA decisão de não
    mexer na linha.
  */
  if (opcoes?.openPrice) {
    return { priceCents: basePriceCents, onSale: false, fonte: 'aberto' };
  }

  /*
    AS LINHAS PODEM VIR DE FORA — a regra, não.

    Quem precifica um catálogo inteiro (a vitrine) lê as promoções da
    empresa UMA vez e passa a lista aqui. Sem isso, cada produto da home
    do grupo custa uma ida ao banco, num processo síncrono que também
    atende o balcão.

    O filtro repetido aqui é o MESMO do SQL, para o resultado não depender
    de por onde as linhas entraram.
  */
  const now = new Date().toISOString();
  const diaDeHoje = diaDaSemanaDaLoja();
  const horaDeAgora = horaDaLoja(new Date());
  const rows = (opcoes?.promocoes
    ? opcoes.promocoes.filter(
      (p) =>
        p.product_id === productId
          || (p.product_id == null && p.category != null && p.category === category),
    )
    : (getConnection()
      .prepare(
        `SELECT ${COLUNAS_DA_PROMOCAO} FROM core_promotions pr
          WHERE pr.company_id = ? AND pr.active = 1
            AND pr.starts_at <= ?
            AND (pr.ends_at IS NULL OR pr.ends_at >= ?)
            AND (pr.product_id = ?
                 OR (pr.product_id IS NULL AND pr.category IS NOT NULL AND pr.category = ?))`,
      )
      .all(companyId, now, now, productId, category) as unknown as PromocaoVigente[])
  // O DIA DA SEMANA peneira os dois caminhos (GAP-V03), como o período já
  // fazia: a lista que vem de fora já foi peneirada por `promocoesVigentes`,
  // e repetir aqui é o que garante que o resultado não dependa de por onde as
  // linhas entraram — inclusive quando o chamador monta a lista à mão. O
  // HORÁRIO (GAP-PRD-194) entra pela mesma razão, com o relógio da loja.
  ).filter(
    (p) =>
      valeNesteDiaDaSemana(p.weekdays, diaDeHoje)
      && valeNesteHorario(p.starts_time, p.ends_time, horaDeAgora),
  );

  let best = basePriceCents;
  let fonte: FontePreco = 'cadastro';
  let promocaoId: string | null = null;
  const unidadesDaLinha = Number(opcoes?.unidadesDaLinha ?? opcoes?.quantidade ?? 1);
  for (const promo of rows) {
    /*
      ESTOQUE PROMOCIONAL (GAP-PRD-194): a linha inteira precisa caber no que
      sobrou. A que não cabe disputa sem esta promoção — metade por um preço e
      metade por outro não é algo que o cupom e a nota saibam explicar.
    */
    const saldo = saldoDaPromocao(promo);
    if (saldo !== null && saldo < unidadesDaLinha) continue;
    const candidate =
      promo.price_cents != null
        ? promo.price_cents
        : promo.percent_off != null
          ? Math.round(basePriceCents * (1 - promo.percent_off / 100))
          : basePriceCents;
    /*
      O GRÁTIS SÓ ENTRA CONFIRMADO (GAP-PRD-032). Aqui era `candidate >= 0`:
      um 100 % digitado por engano vendia o produto por R$ 0,00 na vitrine e no
      balcão. Candidato negativo (preço negativo, percentual acima de 100) nunca
      entra; zero, só com a confirmação gravada por quem criou.
    */
    const gratisConfirmado = Number(promo.free_confirmed ?? 0) === 1;
    const aceitavel = candidate > 0 || (candidate === 0 && gratisConfirmado);
    if (aceitavel && candidate < best) {
      best = candidate;
      fonte = 'promocao';
      promocaoId = promo.id ?? null;
    }
  }

  if (opcoes?.priceTableId) {
    // `priceInTable` recebe a BASE, e não `best`: é o que impede o empilhamento
    // descrito no cabeçalho. A exceção por item da tabela continua ganhando do
    // percentual geral, porque essa decisão é de lá.
    const daTabela = priceInTable(companyId, opcoes.priceTableId, productId, basePriceCents);
    if (daTabela >= 0 && daTabela < best) {
      best = daTabela;
      fonte = 'tabela';
    }
  }

  /*
    A FAIXA POR QUANTIDADE É O QUARTO CANDIDATO (GAP-V04) — não é um desconto
    a mais.

    Ela entra na MESMA disputa dos outros três, e é isso que a doutrina do
    menor preço exige: "3 por R$ 10" com 20% de promoção não vira "3 por R$ 8".
    Empilhar seria erosão de margem invisível — não dá erro, não aparece em
    relatório nenhum, e o preço final só é conferido quando alguém compara o
    cupom com o cadastro à mão.

    A faixa é um preço ABSOLUTO, então não há o que calcular sobre a base: ela
    já é o candidato. Por isso a comparação é a mesma dos outros, `< best`.

    O EMPATE NÃO É DELA, e a ordem deste bloco é o que decide isso: a promoção
    é PÚBLICA (o cliente viu aquele preço anunciado e é esse nome que precisa
    aparecer no cupom) e a tabela é o COMBINADO daquele cliente. A faixa é a
    oferta geral do balcão; quando dá o mesmo número, quem explica o preço é a
    outra. Ela só vence quando é ESTRITAMENTE melhor — que é quando o cliente
    de fato ganha alguma coisa com ela.
  */
  const daFaixa = precoDaFaixa(
    companyId,
    productId,
    Number(opcoes?.quantidade ?? 1),
    opcoes?.faixas,
  );
  if (daFaixa != null && daFaixa >= 0 && daFaixa < best) {
    best = daFaixa;
    fonte = 'faixa';
  }

  /*
    `onSale` continua significando "está saindo por menos do que o cadastro", e
    NÃO "tem promoção". Quem precisa distinguir os dois casos tem `fonte` — e
    quem já lia este campo (a vitrine, a etiqueta, a busca do balcão) não passa
    tabela nenhuma, então para eles nada mudou.
  */
  return {
    priceCents: best,
    onSale: best < basePriceCents,
    fonte,
    // Só quando a promoção VENCEU a disputa: se a tabela ou a faixa deram o
    // preço, a linha não consome o estoque promocional.
    promocaoId: fonte === 'promocao' ? promocaoId : null,
  };
}

// ------------------------------------------------- reprecificação do carrinho

/** Uma linha do carrinho com o preço que o SERVIDOR diz que vale. */
export interface LinhaPrecificada {
  productId: string;
  /** O que vale agora, para este cliente. */
  priceCents: number;
  /** O preço de cadastro, para a tela poder mostrar o "de/por". */
  listPriceCents: number;
  onSale: boolean;
  fonte: FontePreco;
}

export interface CarrinhoPrecificado {
  items: LinhaPrecificada[];
  /**
   * A condição do cliente, uma vez para o carrinho inteiro.
   *
   * A tela precisa dela para DIZER o que está acontecendo ("Atacado -15%").
   * Sem esse aviso, o operador vê o preço cair sozinho ao escolher o cliente e
   * a primeira reação é achar que errou de tecla.
   */
  priceTable: { id: string; name: string; percentOff: number } | null;
}

/**
 * O carrinho inteiro reprecificado para um cliente — a resposta de
 * `POST /core/pricing/cart`.
 *
 * ## Por que isto é uma rota, e não uma conta no navegador
 *
 * Porque o preço é regra de negócio, e regra de negócio que nasce na tela
 * nasce duplicada: o PDV calcularia o desconto do revendedor de um jeito e a
 * venda conferiria de outro, e a divergência apareceria como venda recusada
 * por alçada num carrinho que a tela mostrava dentro do limite. O navegador
 * pergunta e desenha; quem decide quanto custa é este arquivo, o mesmo que a
 * venda usa.
 *
 * ## O que a tela faz com isto
 *
 * O PDV descobre o cliente DEPOIS dos itens, e item entra DEPOIS do cliente por
 * caminhos que ninguém lembra de atualizar — bipe de identidade, carregar
 * orçamento, retomar venda em espera, produto de preço aberto. Consertar caso a
 * caso deixa o quinto caminho aberto. A tela marca em cada linha PARA QUEM ela
 * foi precificada e reprecifica toda linha que não bate com o cliente atual,
 * venha ela de onde vier — e é esta rota que devolve o preço certo, seja qual
 * for o caminho.
 *
 * ## Quantidade AGORA muda o preço (GAP-V04)
 *
 * O contrato desta rota já carregava `quantity` sem usá-la, com a promessa
 * escrita aqui: "quando a faixa existir, a conta muda aqui dentro e nenhuma
 * tela precisa ser tocada". A faixa existe, e a promessa foi cumprida ao pé da
 * letra — a única mudança é o `quantidade` repassado a `effectivePriceCents`.
 * O PDV já mandava a quantidade de cada linha.
 *
 * Ausente continua valendo 1, que é o que uma linha sem quantidade declarada
 * significa em todo o resto do sistema.
 */
export function priceCartForCustomer(
  companyId: string,
  customerId: string | null | undefined,
  items: { productId: string; quantity?: number }[],
): CarrinhoPrecificado {
  ensureCoreSchema();
  const tabela = priceTableForCustomer(companyId, customerId ?? null);
  const db = getConnection();
  const consulta = db.prepare(
    `SELECT id, price_cents, category, open_price
       FROM core_products WHERE id = ? AND company_id = ? AND active = 1`,
  );

  // Uma leitura só para o carrinho inteiro, pelo mesmo motivo de
  // `promocoesVigentes`: sem isto cada linha custa uma ida ao banco, num
  // processo síncrono que também atende o balcão.
  const faixas = faixasAtivasDaEmpresa(companyId);

  const linhas: LinhaPrecificada[] = [];
  for (const item of items) {
    const produto = consulta.get(String(item.productId), companyId) as
      | { id: string; price_cents: number; category: string | null; open_price: number | null }
      | undefined;
    /*
      PRODUTO QUE NÃO EXISTE (ou foi inativado) SAI DA RESPOSTA — não estoura.

      Reprecificar é uma operação de TELA, disparada por trocar de cliente. Uma
      linha órfã no carrinho não pode derrubar a reprecificação das outras e
      deixar o operador sem preço nenhum. Quem tem de recusar a venda é a
      venda, com a mensagem que nomeia o produto, e ela continua recusando.
      Omitir aqui faz a tela manter a linha exatamente como estava.
    */
    if (!produto) continue;

    const vigente = effectivePriceCents(
      companyId,
      produto.id,
      Number(produto.price_cents ?? 0),
      produto.category,
      {
        priceTableId: tabela?.id ?? null,
        openPrice: produto.open_price === 1,
        quantidade: Number(item.quantity ?? 1),
        faixas,
      },
    );
    linhas.push({
      productId: produto.id,
      priceCents: vigente.priceCents,
      listPriceCents: Number(produto.price_cents ?? 0),
      onSale: vigente.onSale,
      fonte: vigente.fonte,
    });
  }

  return { items: linhas, priceTable: tabela };
}
