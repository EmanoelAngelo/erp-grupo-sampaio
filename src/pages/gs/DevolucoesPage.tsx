/**
 * Vendas › Cancelamentos e devoluções.
 *
 * DEVOLVER NÃO É CANCELAR, e a tela precisa deixar isso claro porque quem
 * atende no balcão decide entre os dois com o cliente na frente:
 *
 *   CANCELAR   a venda passa a não valer. Mesmo dia, antes de o dinheiro
 *              assentar — erro de digitação, desistência no balcão. Desfaz
 *              estoque, comissão e fidelidade de uma vez.
 *   DEVOLVER   a venda aconteceu. O cliente levou e voltou depois com parte da
 *              mercadoria. A venda continua inteira no histórico: está no
 *              fechamento do mês e na comissão que já foi paga.
 *
 * O BOTÃO DE CANCELAR, QUE O MENU PROMETIA HÁ RODADAS
 *
 * O item de menu diz "Devolver não altera a venda; cancelar desfaz" e aponta
 * para cá. A rota `POST /core/sales/:id/cancel` existia, `cancelSale` estornava
 * estoque, comissão e fidelidade, `coreApi.cancelSale` estava escrito — e
 * NENHUMA tela chamava. Promessa de menu que o sistema não cumpre é pior que
 * ausência: quem lia acreditava que a saída existia, e no balcão acabava
 * devolvendo a venda inteira, que é outro fato e deixa a receita no mês.
 *
 * As duas ações ficam lado a lado na mesma linha da mesma venda, porque é aí
 * que a escolha acontece — com o cliente na frente. E a confirmação do
 * cancelamento DIZ o que ele desfaz, um item por vez: numa tela que já trata
 * devolução, "tem certeza?" não distingue as duas.
 *
 * A escolha que mais custa dinheiro aqui é "volta ao estoque?". Peça com
 * defeito marcada como boa vira saldo que não existe, e a falta só aparece
 * quando alguém for vender e não achar.
 *
 * A escolha que mais custa CONFIANÇA é QUAL peça voltou. Duas motos iguais na
 * mesma venda, o cliente devolve a de chassi B e o sistema registra a A: o pátio
 * fica com uma moto e o sistema afirma ter outra, a plaquinha da A sai para um
 * segundo comprador com o chassi da moto que está na garagem do primeiro, e o
 * portal do primeiro passa a mostrar a moto do pátio da loja. Por isso produto
 * controlado por unidade não tem campo de quantidade aqui: tem a lista das peças
 * daquela venda, para bipar o número que está na moto.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { prenderFoco } from '@/components/gs/armadilhaDeFoco';
import { Link, useSearchParams } from 'react-router-dom';
import { AppShell } from '@/components/gs/AppShell';
import { AutorizacaoGerenteDialog } from '@/components/gs/PagamentoDialog';
import { Badge, Button, Card, EmptyState, Field, Input, PageHeader } from '@/components/gs/ui';
import { TitulosDoDocumento } from '@/components/gs/TitulosDoDocumento';
import { useHasProfile, useSession } from '@/hooks/useSession';
import { ApiRequestError, envelope } from '@/lib/api/client';
import { caixaDesteComputador } from '@/lib/api/terminais';
import { fraseDosEstornosNaMaquininha } from '@/lib/api/maquininhas';
import { temDescontoDoRodape, valorDaDevolucaoDaLinha } from '@/lib/valorDaDevolucao';
import {
  coreApi,
  type FinanceEntry,
  type FluxoDaDevolucao,
  type MeioDoReembolso,
  type RefundMethod,
  type ReturnableItem,
  type ReturnableUnit,
  type Sale,
  type SaleDetail,
  type SaleReturn,
  type SaleReturnDetail,
  type SituacaoDoReembolso,
  type VendaParaDevolucao,
} from '@/lib/api/core';
import { parseReaisToCents } from '@/components/gs/format';
import { dataBR } from '@/lib/datas';
import { PARAM_DA_DEVOLUCAO, destinoDaOrigem } from '@/lib/rotasDeOrigem';
import { uuid } from '@/lib/uuid';

function formatCents(cents: number): string {
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

/**
 * Como a peça se chama no balcão.
 *
 * O chassi vem primeiro porque é o número da moto — é o que está gravado nela e
 * o que sai no documento. Peça sem identidade nenhuma é caso real (a unidade
 * nasce sem número, e a nota de entrada não traz chassi), e mostrar um pedaço do
 * identificador interno é melhor que uma linha em branco que o operador não
 * consegue distinguir da de baixo.
 */
function identidadeDaPeca(u: ReturnableUnit): string {
  const numero = u.chassis ?? u.serial_number ?? u.motor_number ?? u.imei ?? u.plate;
  return numero ?? `sem número — peça ${u.id.slice(0, 8)}`;
}

const METODOS: { id: RefundMethod; label: string; hint: string }[] = [
  // "se houver caixa aberto" era a descrição do defeito (GAP-PRD-161): sem
  // caixa, o dinheiro saía assim mesmo. Agora sem caixa aberto não sai.
  { id: 'dinheiro', label: 'Dinheiro', hint: 'Sai da gaveta do caixa aberto' },
  {
    id: 'credito',
    label: 'Crédito de loja',
    // O texto mudou junto com o mecanismo: até esta rodada o "crédito na loja"
    // não virava saldo nenhum — era um rótulo gravado na devolução e uma
    // ressalva no DRE. Agora ele é vale de verdade, com extrato e consumo no
    // PDV, e a dica diz exatamente isso para quem está no balcão.
    hint: 'Vira vale do cliente, gastável na próxima compra; nada sai do caixa agora',
  },
  { id: 'estorno_cartao', label: 'Estorno no cartão', hint: 'Volta pela operadora' },
  { id: 'pix', label: 'PIX', hint: 'Devolvido pela conta' },
];

interface Escolha {
  quantity: string;
  restock: boolean;
  /** As peças bipadas, quando o produto é controlado por unidade. */
  unitIds: string[];
  /** Duas etapas: em que condição a mercadoria voltou (padrão: intacto). */
  condition?: string;
}

/*
  A DEVOLUÇÃO EM DUAS ETAPAS (Preço Justo).

  A tela deixava de só DIZER "devolva R$ X ao cliente": a devolução registra a
  mercadoria (itens, motivo, condição, estoque) e o valor devolvível; o
  reembolso é registrado depois, pelo que de fato aconteceu — dinheiro da
  gaveta, PIX feito pela conta, estorno feito na maquininha —, com pendente,
  parcial e concluído. Mercadoria, reembolso e fiscal são três estados.
*/
const MOTIVOS: { id: string; label: string }[] = [
  { id: 'defeito', label: 'Defeito' },
  { id: 'produto_incorreto', label: 'Produto incorreto' },
  { id: 'desistencia', label: 'Desistência' },
  { id: 'troca', label: 'Troca' },
  { id: 'outro', label: 'Outro' },
];

const CONDICOES: { id: string; label: string }[] = [
  { id: 'intacto', label: 'Intacto, vendável' },
  { id: 'defeituoso', label: 'Defeituoso' },
  { id: 'quebrado', label: 'Quebrado' },
  { id: 'avariado', label: 'Avariado' },
  { id: 'improprio', label: 'Impróprio' },
];

const MEIOS_DO_REEMBOLSO: { id: MeioDoReembolso; label: string; botao: string; instrucao: string }[] = [
  {
    id: 'dinheiro',
    label: 'Dinheiro',
    botao: 'Registrar devolução ao cliente',
    instrucao:
      'Entregue o dinheiro da gaveta ao cliente e registre: a saída entra no caixa como DEVOLUÇÃO AO '
      + 'CLIENTE e baixa o valor esperado no fechamento.',
  },
  {
    id: 'pix',
    label: 'PIX',
    botao: 'Registrar PIX devolvido',
    instrucao:
      'Faça o PIX pela conta da loja e depois registre aqui. O DEVORA não envia PIX: este registro é a '
      + 'confirmação do que foi feito. O dinheiro da gaveta não muda.',
  },
  {
    id: 'debito',
    label: 'Estorno no débito',
    botao: 'Confirmar estorno realizado',
    instrucao:
      'Realize o estorno/reembolso na maquininha e depois confirme aqui, com o NSU do comprovante se '
      + 'houver. O dinheiro da gaveta não muda.',
  },
  {
    id: 'credito',
    label: 'Estorno no crédito',
    botao: 'Confirmar estorno realizado',
    instrucao:
      'Realize o estorno/reembolso na maquininha e depois confirme aqui, com o NSU do comprovante se '
      + 'houver. O dinheiro da gaveta não muda.',
  },
  {
    id: 'vale',
    label: 'Crédito de loja (vale)',
    botao: 'Registrar crédito de loja',
    instrucao: 'O valor vira vale do cliente, gastável na próxima compra. Nada sai do caixa.',
  },
];

const SITUACAO: Record<SituacaoDoReembolso, { texto: string; tom: 'warning' | 'info' | 'success' | 'neutral' }> = {
  pendente: { texto: 'PENDENTE', tom: 'warning' },
  parcial: { texto: 'PARCIAL', tom: 'info' },
  concluido: { texto: 'CONCLUÍDO', tom: 'success' },
  nao_se_aplica: { texto: 'NADA A DEVOLVER', tom: 'neutral' },
};

const ROTULO_DO_ESTOQUE: Record<string, string> = {
  retornou: 'RETORNOU',
  nao_retornou: 'NÃO RETORNOU',
  parcial: 'PARTE RETORNOU',
  sem_itens: '—',
};

const rotuloDoMeioDoReembolso = (m: string) => MEIOS_DO_REEMBOLSO.find((x) => x.id === m)?.label ?? rotuloDoMeio(m);

/** Centavos no campo, em pt-BR — o que `parseReaisToCents` sabe ler de volta. */
function centavosNoCampo(cents: number): string {
  return (cents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** O que o servidor diz que o cancelamento devolveu, meio a meio (E-venda-servidor-06). */
type ReembolsoDoCancelamento = NonNullable<
  Awaited<ReturnType<typeof coreApi.cancelSale>>['reembolso']
>;

/**
 * O QUE AINDA PRECISA DE UMA MÃO depois do cancelamento (E-venda-servidor-06).
 *
 * O DEFEITO: o aviso dizia sempre "o cancelamento já repôs tudo, e não há o
 * que devolver". Na venda de R$ 250 no crédito da maquininha avulsa, ninguém
 * estornava no aparelho: o título a receber sumia do financeiro e o cliente
 * continuava cobrado no cartão por uma venda que o sistema diz não existir. Na
 * venda em dinheiro, a tela nem dizia quanto entregar da gaveta. Agora cada
 * meio vira uma instrução, com o valor que o servidor apurou.
 */
function frasesDoReembolso(r: ReembolsoDoCancelamento | undefined): string {
  if (!r) return '';
  const partes: string[] = [];
  if (r.gavetaCents > 0) {
    partes.push(
      `Entregue ${formatCents(r.gavetaCents)} ao cliente, da gaveta — a saída já está registrada no caixa.`,
    );
  }
  if (r.aDevolverAMao.dinheiro > 0) {
    partes.push(
      `Devolva ${formatCents(r.aDevolverAMao.dinheiro)} em dinheiro ao cliente — esta venda não passou por gaveta.`,
    );
  }
  if (r.aDevolverAMao.credito > 0) {
    partes.push(
      `Estorne ${formatCents(r.aDevolverAMao.credito)} no crédito, no próprio aparelho da maquininha: `
        + 'esta venda não tem cobrança integrada, e ninguém mais faz esse estorno.',
    );
  }
  if (r.aDevolverAMao.debito > 0) {
    partes.push(
      `Estorne ${formatCents(r.aDevolverAMao.debito)} no débito, no próprio aparelho da maquininha.`,
    );
  }
  if (r.aDevolverAMao.pix > 0) {
    partes.push(`Devolva ${formatCents(r.aDevolverAMao.pix)} por PIX ao cliente, pela conta da loja.`);
  }
  if (r.valeDevolvidoCents > 0) {
    partes.push(`${formatCents(r.valeDevolvidoCents)} de crédito de loja voltaram ao saldo do cliente.`);
  }
  if (r.valeRevogadoCents > 0) {
    partes.push(
      `${formatCents(r.valeRevogadoCents)} de crédito concedido pela devolução desta venda saíram do saldo do cliente.`,
    );
  }
  /*
    O QUE ENTROU DEPOIS, EM CONTAS A RECEBER (E-venda-servidor-R01).

    O DEFEITO: a venda a prazo paga depois (ou o PIX pendente baixado à mão)
    não aparecia em nenhum campo do resumo, e o fim desta função transformava
    o resumo todo zero em "Nada desta venda tinha sido recebido, então não há
    dinheiro a devolver" — para uma venda de R$ 200 que o cliente tinha pago.
    O servidor agora manda o valor, e ele vira instrução como os outros meios.
  */
  const depois = r.recebidoDepois;
  if (depois && depois.cents > 0) {
    const meios = depois.meios
      .map((m) => (m === 'não informado' ? 'meio não informado na baixa' : rotuloDoMeio(m)))
      .join(', ');
    partes.push(
      `Devolva ${formatCents(depois.cents)} ao cliente pelo meio em que ele pagou`
        + (meios ? ` (${meios})` : '')
        + ': esse valor foi recebido depois, em Contas a receber, e o cancelamento anulou o '
        + 'recebimento — nenhuma gaveta ou maquininha devolve por você.',
    );
  }
  if (r.jaDevolvidoCents > 0) {
    partes.push(
      `${formatCents(r.jaDevolvidoCents)} já tinham voltado ao cliente por devoluções anteriores e não voltam de novo.`,
    );
  }
  if (partes.length === 0 && r.maquininhaCents === 0) {
    partes.push('Nada desta venda tinha sido recebido, então não há dinheiro a devolver.');
  }
  return ` ${partes.join(' ')}`;
}

/*
  Os meios que uma baixa pode trazer. Faltavam o crediário (histórico) e os
  meios do Contas a receber (boleto, transferência): a frase saía com o código
  cru. O que não está aqui (meio cadastrado com outro nome) sai legível por
  `rotuloDoMeio`, e não como "cartao_voucher".
*/
const ROTULO_DO_MEIO: Record<string, string> = {
  dinheiro: 'Dinheiro',
  credito: 'Cartão de crédito',
  debito: 'Cartão de débito',
  pix: 'PIX',
  crediario: 'Crediário',
  boleto: 'Boleto',
  transferencia: 'Transferência',
  ted: 'Transferência',
  cheque: 'Cheque',
};

function rotuloDoMeio(codigo: string): string {
  const conhecido = ROTULO_DO_MEIO[codigo];
  if (conhecido) return conhecido;
  const legivel = codigo.replace(/[_-]+/g, ' ').trim();
  return legivel ? legivel.charAt(0).toUpperCase() + legivel.slice(1) : 'Outro meio';
}

/**
 * Um envio de devolução que ficou sem resposta (E-venda-servidor-09): a venda,
 * as devoluções dela que já existiam ANTES do envio e a forma enviada.
 */
interface EnvioSemResposta {
  saleId: string;
  conhecidas: Set<string>;
  forma: RefundMethod | 'em_etapas';
}

/** O que a conferência depois de um envio sem resposta achou. */
type ConferenciaDoEnvio =
  | { estado: 'chegou'; devolucao: SaleReturn }
  | { estado: 'nao_chegou' }
  // A leitura do histórico também falhou: a tela não pode afirmar nada.
  | { estado: 'sem_conferencia' };

/** Como a venda entrou — lido da ficha da venda (E-venda-servidor-03). */
interface ComoFoiPaga {
  linhas: { metodo: string; cents: number; pendente: boolean }[];
  valeCents: number;
}

function comoFoiPagaDe(detalhe: SaleDetail | null): ComoFoiPaga | null {
  // Ficha de servidor de outra versão, ou que não veio: sem o bloco, e a tela
  // segue como sempre — o servidor continua sendo quem recusa.
  if (!detalhe || !Array.isArray(detalhe.payments)) return null;
  return {
    linhas: detalhe.payments.map((p) => ({
      metodo: String(p.method),
      cents: Number(p.amount_cents) || 0,
      pendente: p.status === 'pending',
    })),
    valeCents: Number(detalhe.customerCreditCents) || 0,
  };
}

/**
 * O MEIO QUE A TELA PROPÕE, pelo que entrou (E-venda-servidor-03).
 *
 * O DEFEITO: o método nascia sempre "Dinheiro" e a tela não mostrava como a
 * venda foi paga. A venda paga só com vale saía da gaveta em espécie; a paga no
 * cartão também. Quando a venda entrou por UM meio só, a devolução nasce nele;
 * misturada, a escolha fica com quem está no balcão — e o servidor recusa o
 * que passar do que entrou naquele meio.
 */
function meioSugerido(p: ComoFoiPaga): RefundMethod | null {
  const metodos = new Set(p.linhas.filter((l) => !l.pendente && l.cents > 0).map((l) => l.metodo));
  if (metodos.size === 0) return p.valeCents > 0 ? 'credito' : null;
  if (p.valeCents > 0) return null;
  if ([...metodos].every((m) => m === 'credito' || m === 'debito')) return 'estorno_cartao';
  if (metodos.size === 1 && metodos.has('pix')) return 'pix';
  if (metodos.size === 1 && metodos.has('dinheiro')) return 'dinheiro';
  return null;
}

/**
 * Quanto está sendo devolvido desta linha.
 *
 * Em produto serializado a quantidade NÃO é digitada: ela é o tamanho da
 * seleção. Ter os dois campos deixaria a tela oferecer "devolver 2" com uma peça
 * marcada, e a recusa do servidor chegaria depois do clique — sendo que a tela
 * tinha todos os elementos para não deixar o operador chegar lá.
 */
function quantidadeDe(item: ReturnableItem, escolha: Escolha | undefined): number {
  if (!escolha) return 0;
  if (item.serialized === 1) return escolha.unitIds.length;
  return Number(escolha.quantity) || 0;
}

export default function DevolucoesPage() {
  const [busca, setBusca] = useState('');
  const [saleId, setSaleId] = useState('');
  const [saleNumber, setSaleNumber] = useState<number | null>(null);
  const [vendas, setVendas] = useState<Sale[] | null>(null);
  const [itens, setItens] = useState<ReturnableItem[] | null>(null);
  const [escolhas, setEscolhas] = useState<Record<string, Escolha>>({});
  const [motivo, setMotivo] = useState('');
  const [metodo, setMetodo] = useState<RefundMethod>('dinheiro');

  const [historico, setHistorico] = useState<SaleReturn[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);

  /** Como esta operação devolve o dinheiro — a resposta do servidor ao abrir a venda. */
  const [fluxo, setFluxo] = useState<FluxoDaDevolucao>('imediato');
  const emEtapas = fluxo === 'duas_etapas';
  /** A venda aberta, inteira: quem, quando, como pagou, fiscal e o que já voltou. */
  const [vendaAberta, setVendaAberta] = useState<VendaParaDevolucao | null>(null);
  const [codigoDoMotivo, setCodigoDoMotivo] = useState('');
  const [observacaoDoMotivo, setObservacaoDoMotivo] = useState('');
  const rotuloDoMotivo = MOTIVOS.find((m) => m.id === codigoDoMotivo)?.label ?? '';
  const motivoComposto = observacaoDoMotivo.trim()
    ? `${rotuloDoMotivo} — ${observacaoDoMotivo.trim()}`
    : rotuloDoMotivo;
  const motivoEmEtapasOk =
    codigoDoMotivo !== '' && (codigoDoMotivo !== 'outro' || observacaoDoMotivo.trim().length >= 3);
  /** A devolução em duas etapas aberta para registrar a devolução ao cliente. */
  const [devolucaoAberta, setDevolucaoAberta] = useState<SaleReturnDetail | null>(null);

  /*
    QUEM ALCANÇA ESTA TELA NÃO É QUEM CANCELA SOZINHO — e agora há uma segunda
    porta, que é a rodada da liberação pontual (GAP-V60) inteira.

    A rota do navegador é `ROTA_GESTAO`, que abre o escritório inteiro:
    admin_geral, gestor, gerente_loja, gerente_oficina, estoquista e atendente.
    O servidor deixa `gerente_loja` (mais admin e gestor) cancelar DIRETO, e
    `gerente_loja`/`gerente_oficina` registrar devolução DIRETO.

    ## Por que o botão passou a aparecer para todo mundo

    Até esta rodada ele era escondido de quem não podia, e a razão era boa: o
    estoquista clicaria, leria a confirmação inteira sobre estorno de estoque e
    comissão, confirmaria — e só então descobriria que não podia, numa ação
    irreversível, no momento exato em que a pessoa se compromete.

    O que mudou é que agora ELE PODE, com a credencial de um gestor digitada
    ali mesmo. Continuar escondendo o botão seria o defeito simétrico: a tela
    negaria uma saída que o servidor oferece, e o balcão voltaria a resolver
    devolvendo a venda inteira (outro fato) ou pedindo a senha emprestada
    (nenhum rastro). Quem não tem alçada vê o botão E vê, na confirmação, que
    um gestor vai precisar assinar — o compromisso é informado ANTES do clique,
    que era o ponto do desenho anterior.

    `useHasProfile` já embute o "admin_geral e gestor passam", igual ao
    servidor. Isto é navegação, não autorização: a rota continua conferindo, e é
    ela que recusa com `CORE_CANCEL_NEEDS_AUTHORIZATION` quando falta o bilhete.
  */
  const cancelaDireto = useHasProfile('gerente_loja');
  const devolveDireto = useHasProfile('gerente_loja', 'gerente_oficina');

  /*
    O CAIXA DESTE COMPUTADOR (GAP-PRD-161) — o mesmo que o PDV guardou.

    Com caixas cadastrados, o dinheiro de uma devolução (ou do cancelamento de
    venda de turno já fechado) sai da gaveta do caixa de quem está aqui, e não
    "da aberta mais recente": é a gaveta que a pessoa tem na frente. Sem caixa
    cadastrado vai vazio, e o servidor usa a gaveta única de sempre.
  */
  const session = useSession();
  const caixaDoComputador = caixaDesteComputador(session?.company.id ?? null);

  /**
   * A venda esperando confirmação do cancelamento.
   *
   * Estado próprio, e não um `window.confirm`: o que precisa ser lido aqui não
   * cabe numa linha do navegador — são três estornos, e é a leitura deles que
   * separa esta decisão da devolução.
   */
  const [cancelando, setCancelando] = useState<Sale | null>(null);
  const [motivoCancelamento, setMotivoCancelamento] = useState('');
  const [cancelandoBusy, setCancelandoBusy] = useState(false);
  /**
   * A recusa do cancelamento, DENTRO da confirmação.
   *
   * Ela era escrita na faixa de erro da página — atrás do diálogo, que ficava
   * aberto por cima. A nota fiscal autorizada, a devolução por outro meio e a
   * venda já cancelada (E-venda-servidor-01/05/14) só serviam de algo se a
   * pessoa lesse, e ela não via.
   */
  const [erroCancelamento, setErroCancelamento] = useState<string | null>(null);

  /**
   * ==========================================================================
   * A VENDA QUE ACABOU DE SUMIR DA LISTA — e o beco que ela deixava
   * ==========================================================================
   *
   * ## O defeito
   *
   * É DESTA TELA que se cancela uma venda, e o cancelamento a faz desaparecer
   * daqui na mesma ação (`vendasFiltradas` recusa `status === 'cancelled'`).
   * Isso está certo — oferecer "Devolver desta" numa venda que não vale mais
   * convidaria a estornar duas vezes o mesmo item. O que estava errado é o que
   * vinha depois: a linha sumia, o aviso explicava os três estornos, e a pessoa
   * ficava SEM CAMINHO até a ficha da venda.
   *
   * E a ficha é o que ela costuma querer justamente aqui: o rastro dos itens
   * que saíram do carrinho antes do Finalizar (`removedItems`, desenhado por
   * `ItensCanceladosDaVenda` em `VendasPage`) é o motivo pelo qual muita venda é
   * cancelada — "fechou por menos do que mostrou ao cliente". Ele é alcançável,
   * e ninguém dizia por onde.
   *
   * ## Por que um LINK, e não uma cópia do bloco aqui
   *
   * Copiar o componente criaria a segunda definição da mesma regra, na tela que
   * ESCONDE a venda cancelada — ou seja, o rastro apareceria onde a pergunta
   * pesa menos e sumiria, junto com a venda, onde ela pesa mais. Quem aprendesse
   * "o rastro se lê em Devoluções" procuraria a venda cancelada e não acharia
   * nem o bloco nem a venda. Uma casa só, com placa na porta.
   *
   * É a mesma regra que esta tela já aplica ao recorte do `?devolucao=`: o
   * recorte se declara E tem saída.
   */
  const [vendaCancelada, setVendaCancelada] = useState<Sale | null>(null);

  /**
   * ==========================================================================
   * O PEDIDO DE LIBERAÇÃO PENDURADO — o gestor assina e a ação SEGUE
   * ==========================================================================
   *
   * O servidor recusa com um código NOMEADO (`CORE_CANCEL_NEEDS_AUTHORIZATION`,
   * `CORE_RETURN_NEEDS_AUTHORIZATION`) em vez de "permissão negada", e é isso
   * que permite à tela oferecer alguma coisa em vez de só mostrar um "não".
   * O que fica pendurado aqui é a ação inteira: quando a credencial do gestor é
   * aceita, `repetir` roda a MESMA chamada com o bilhete na mão.
   *
   * Guardar a continuação, e não só o id, é o que evita o defeito clássico
   * deste fluxo: pedir a senha, obter a liberação e deixar o operador clicar de
   * novo — com o bilhete expirando em quinze minutos e o cliente na frente.
   *
   * A SENHA NÃO PASSA POR AQUI. `AutorizacaoGerenteDialog` a entrega direto ao
   * `coreApi.authorize` e a esquece ao desmontar; nenhum estado desta página a
   * vê.
   */
  const [liberacaoPedida, setLiberacaoPedida] = useState<{
    acao: 'cancelar_venda' | 'devolver_venda';
    referenceId: string;
    motivo: string;
    repetir: (authorizationId: string) => Promise<void>;
  } | null>(null);
  const [liberacaoBusy, setLiberacaoBusy] = useState(false);
  const [liberacaoErro, setLiberacaoErro] = useState<string | null>(null);

  /**
   * O 403 que PEDE gestor, separado do 403 que apenas nega.
   *
   * Sem esta distinção a tela trataria os dois como erro e escreveria a
   * mensagem do servidor numa faixa vermelha — que é exatamente o "o sistema
   * está com defeito" que quem opera reporta quando a permissão não se explica.
   */
  function pedeGestor(err: unknown, codigo: string): boolean {
    return err instanceof ApiRequestError && err.code === codigo;
  }

  /** O gestor digitou a credencial: pede o bilhete e repete a ação com ele. */
  const autorizarEContinuar = async (login: string, password: string) => {
    if (!liberacaoPedida) return;
    setLiberacaoBusy(true);
    setLiberacaoErro(null);
    try {
      const bilhete = await coreApi.authorize({
        action: liberacaoPedida.acao,
        login,
        password,
        referenceId: liberacaoPedida.referenceId,
        reason: liberacaoPedida.motivo,
      });
      const repetir = liberacaoPedida.repetir;
      setLiberacaoPedida(null);
      await repetir(bilhete.id);
    } catch (err) {
      setLiberacaoErro(
        err instanceof ApiRequestError ? err.message : 'Não foi possível autorizar.',
      );
    } finally {
      setLiberacaoBusy(false);
    }
  };

  /**
   * Cancela a venda: ela deixa de valer, e três coisas voltam atrás.
   *
   * O botão que faltava há rodadas. O menu prometia "cancelar desfaz" apontando
   * para cá, a rota existia, o serviço existia e estornava tudo — e nenhuma
   * tela chamava `coreApi.cancelSale`. Promessa de menu que o sistema não
   * cumpre é pior que ausência: quem lia acreditava que o cancelamento estava
   * ao alcance, e no balcão a saída acabava sendo devolver a venda inteira,
   * que é OUTRO fato — a venda continua no histórico, no fechamento do mês e
   * na comissão que já foi paga.
   */
  const cancelarVenda = async (authorizationId?: string) => {
    if (!cancelando) return;
    const venda = cancelando;
    setCancelandoBusy(true);
    setErro(null);
    setErroCancelamento(null);
    setAviso(null);
    setVendaCancelada(null);
    try {
      const cancelada = await coreApi.cancelSale(
        venda.id,
        // Obrigatório (E-venda-servidor-M01): o botão só confirma com motivo.
        motivoCancelamento.trim(),
        authorizationId,
        caixaDoComputador,
      );
      setAviso(
        `Venda #${cancelada.number} cancelada. O estoque voltou, a comissão foi estornada e os `
          + 'pontos de fidelidade saíram do saldo do cliente.'
          // O dinheiro, meio a meio — e o que ainda precisa de uma mão.
          + frasesDoReembolso(cancelada.reembolso)
          // O cartão da maquininha volta junto (GAP-PRD-080): a tela diz se voltou.
          + (cancelada.estornosNaMaquininha?.length
            ? ` ${fraseDosEstornosNaMaquininha(cancelada.estornosNaMaquininha, formatCents)}`
            : '')
          + ' Ela sai da lista acima.',
      );
      // Guardada a venda, e não só o aviso: é ela que dá o endereço da ficha —
      // sem isso a linha some da tela sem deixar por onde continuar.
      setVendaCancelada(venda);
      setCancelando(null);
      setMotivoCancelamento('');
      // A venda cancelada tem de sumir da lista de devolução na mesma ação —
      // oferecer "Devolver desta" numa venda que não vale mais convidaria a
      // estornar duas vezes o mesmo item.
      await carregarHistorico();
    } catch (err) {
      /*
        A RECUSA QUE PEDE GESTOR NÃO É UM ERRO NA TELA — é o próximo passo.

        O servidor devolve `CORE_CANCEL_NEEDS_AUTHORIZATION` justamente para
        que aqui se possa abrir o diálogo em vez de pintar uma faixa vermelha.
        A ação fica pendurada com o motivo já digitado: quando o gestor
        assinar, a mesma chamada sai de novo com o bilhete.
      */
      if (pedeGestor(err, 'CORE_CANCEL_NEEDS_AUTHORIZATION')) {
        setLiberacaoErro(null);
        setLiberacaoPedida({
          acao: 'cancelar_venda',
          referenceId: venda.id,
          motivo:
            `Cancelamento da venda #${venda.number} — ${formatCents(venda.total_cents)}. `
            + 'Desfaz estoque, comissão e fidelidade.',
          repetir: (id) => cancelarVenda(id),
        });
        return;
      }
      setErroCancelamento(
        err instanceof ApiRequestError
          ? err.message
          : 'Sem resposta do servidor — a venda não foi cancelada. Confira a conexão e tente de novo.',
      );
    } finally {
      setCancelandoBusy(false);
    }
  };

  /**
   * QUANTO A LOJA DEVE EM VALE — o passivo que esta tela cria (GAP-V10/V47).
   *
   * Cada devolução em crédito acrescenta uma dívida: mercadoria que voltou para
   * a prateleira e ainda não foi paga de volta. Até esta rodada o número não
   * existia em lugar nenhum; agora ele mora ao lado do botão que o faz crescer,
   * que é o único lugar em que ele muda o comportamento de quem lê.
   *
   * Só para quem responde pelo caixa: a rota é de gerência, e pedi-la com
   * perfil de estoquista tomaria 403 — mostrar um bloco vazio com erro seria
   * pior que não mostrar nada.
   */
  const [passivo, setPassivo] = useState<{ cents: number; customers: number } | null>(null);

  const carregarHistorico = useCallback(async () => {
    try {
      setHistorico(await coreApi.listSaleReturns());
      setVendas(await coreApi.listSales());
    } catch (err) {
      setHistorico(null);
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao carregar devoluções.');
    }
    if (devolveDireto) {
      // Silencioso na falha: o passivo é informação de gestão, e perder o
      // número não pode impedir o balcão de registrar a devolução que o cliente
      // está esperando.
      coreApi
        .customerCreditLiability()
        .then(setPassivo)
        .catch(() => setPassivo(null));
    }
  }, [devolveDireto]);

  useEffect(() => {
    void carregarHistorico();
  }, [carregarHistorico]);

  /**
   * A DEVOLUÇÃO QUE VEIO PELO LINK — `/sistema/vendas/devolucoes?devolucao=<id>`.
   *
   * O contas a pagar rotula o estorno como "Devolução #4 da venda #12" e o link
   * dele parava na tela, com o histórico inteiro: quem conferia a saída de
   * dinheiro tinha de caçar a #4 na lista. O recorte é feito sobre o histórico
   * que JÁ chegou — devolução não tem rota de leitura por id nesta tela, e
   * inventar uma criaria um segundo caminho para a mesma pergunta.
   */
  const [paramsDaUrl] = useSearchParams();
  const devolucaoPedida = paramsDaUrl.get(PARAM_DA_DEVOLUCAO);
  // Nulo continua sendo "ainda carregando", e o recorte só acontece depois:
  // filtrar sobre `historico ?? []` transformaria a espera em "nenhuma
  // devolução" — o estado vazio piscando no lugar do "Carregando…".
  const historicoNaTela =
    historico === null
      ? null
      : devolucaoPedida
        ? historico.filter((d) => d.id === devolucaoPedida)
        : historico;

  /**
   * ==========================================================================
   * O QUE ESTA DEVOLUÇÃO GEROU NO FINANCEIRO — a VOLTA (V04-FIN-016)
   * ==========================================================================
   *
   * ## O DEFEITO
   *
   * A IDA estava inteira: o contas a pagar rotula o estorno como "Devolução #4
   * da venda #12" e o link dele abre ESTE recorte. A VOLTA não: a ficha da
   * devolução não mostrava o título que ela criou. Quem chegava aqui para
   * conferir se o estorno já tinha saído lia motivo, forma e valor — e sobre o
   * dinheiro, nada. Voltava ao financeiro e procurava pelo texto da descrição,
   * que é exatamente o gesto que o link do financeiro existe para apagar.
   *
   * A devolução é a origem que MAIS pede este bloco: ela cria dívida da loja
   * com o cliente, e "já pagamos?" é a única pergunta que ela levanta.
   *
   * ## POR QUE UMA SEGUNDA CONSULTA, E NÃO O BLOCO NA RESPOSTA DO DETALHE
   *
   * A ficha da VENDA e a do PEDIDO DA LOJA recebem `financeEntries` na própria
   * resposta do detalhe, e é o caminho certo LÁ: as duas telas fazem
   * `GET /core/sales/:id` e `GET /core/orders/:id` para existir, então o bloco
   * pega carona numa chamada que já acontece.
   *
   * AQUI NÃO HÁ ESSA CHAMADA. Esta tela nunca abre o detalhe de uma devolução:
   * o recorte do `?devolucao=` é feito sobre o histórico que JÁ chegou (ver o
   * bloco acima). Pendurar os títulos em `GET /sale-returns/:id` obrigaria a
   * tela a passar a fazer uma ida ao servidor que ela não faz — e a receber a
   * devolução DUAS vezes, uma pela lista e outra pelo detalhe, com o risco
   * clássico de as duas divergirem — só para carregar o bloco de carona. Uma
   * requisição por uma requisição, com uma fonte de verdade a mais.
   *
   * Então aqui vale o caminho da ficha da NOTA DE ENTRADA: a consulta genérica
   * da volta, `originType` + `originId`, que o servidor já responde e testa.
   *
   * ## SÓ COM FICHA ABERTA
   *
   * Sem `?devolucao=` não há documento na mesa, e perguntar pela lista inteira
   * seria uma consulta por linha do histórico para responder uma pergunta que
   * interessa a uma.
   *
   * ## OS DOIS ESTADOS QUE NÃO PODEM SE PARECER
   *
   * "Não gerou título" e "não consegui perguntar" são fatos diferentes. O
   * segundo lido como o primeiro afirma que a devolução não deve nada a
   * ninguém — e esta rota é de gerência, então o 403 é caso real: quem opera o
   * balcão alcança a tela e não alcança o financeiro.
   */
  const [titulos, setTitulos] = useState<FinanceEntry[] | null>(null);
  const [erroTitulos, setErroTitulos] = useState<string | null>(null);

  useEffect(() => {
    if (!devolucaoPedida) {
      setTitulos(null);
      setErroTitulos(null);
      return;
    }
    // `vivo` fecha a corrida: trocar de devolução pelo endereço enquanto a
    // resposta antiga voltava desenharia o estorno da devolução ERRADA sob o
    // número da nova — a pior forma de estar errado numa tela de dinheiro.
    let vivo = true;
    setTitulos(null);
    setErroTitulos(null);
    void coreApi
      .listFinanceEntries({ originType: 'sale_return', originId: devolucaoPedida })
      .then((r) => {
        /*
          `envelope`, e NÃO confiança no corpo. Um 200 sem `items` (servidor de
          outra versão, proxy que cortou a resposta) entraria no estado como
          `undefined`, e o bloco chamaria `.length` sobre nada: tela branca,
          longe da causa e sem dizer o que houve. Medido: `TypeError: Cannot
          read properties of undefined (reading 'length')`. Aqui a ausência
          vira o MESMO recado honesto da falha de rede, no lugar da lista.
        */
        const lista = envelope('items')(r);
        if (vivo) setTitulos(lista);
      })
      .catch((err) => {
        if (!vivo) return;
        setTitulos([]);
        setErroTitulos(
          err instanceof ApiRequestError
            ? err.message
            : 'Falha ao consultar os títulos desta devolução.',
        );
      });
    return () => {
      vivo = false;
    };
  }, [devolucaoPedida]);

  /**
   * A venda tem cliente identificado?
   *
   * É o que decide se "Crédito de loja" pode ser oferecido: o vale precisa de
   * dono — sem ele não há saldo de ninguém a somar, extrato a mostrar nem venda
   * que o consuma, e o servidor recusa. A tela guarda a resposta ao abrir a
   * venda para não deixar o operador escolher o que vai ser negado.
   */
  const [vendaTemCliente, setVendaTemCliente] = useState(false);
  const [comoFoiPaga, setComoFoiPaga] = useState<ComoFoiPaga | null>(null);

  /**
   * A CHAVE DESTA TENTATIVA DE DEVOLUÇÃO (E-venda-servidor-09).
   *
   * Nasce quando a venda é aberta para devolver e vai no cabeçalho
   * `Idempotency-Key` de TODO envio desta devolução — o do botão, o repetido
   * depois da liberação do gestor e o reenvio depois de uma resposta perdida.
   * Com ela, o servidor devolve a devolução que já gravou em vez de gravar a
   * segunda; a conferência do histórico logo abaixo continua valendo, e as duas
   * se somam: a tela deixa de depender só da rede ter voltado.
   *
   * Uma devolução registrada encerra a tentativa: a próxima venda aberta — ou a
   * mesma, de novo — ganha chave nova. Recusa do servidor NÃO troca a chave:
   * pedido recusado não grava chave, e o conserto do formulário vai com ela.
   */
  const chaveDaTentativa = useRef<string | null>(null);

  const abrirVenda = useCallback(async (venda: Sale) => {
    setErro(null);
    setAviso(null);
    setItens(null);
    setComoFoiPaga(null);
    chaveDaTentativa.current = uuid();
    setDevolucaoAberta(null);
    setCodigoDoMotivo('');
    setObservacaoDoMotivo('');
    try {
      // A ficha vem junto e em silêncio na falha: ela só serve para mostrar
      // como a venda entrou e propor o meio (E-venda-servidor-03).
      const [devolvivel, detalhe] = await Promise.all([
        coreApi.returnableSale(venda.id),
        coreApi.getSale(venda.id).catch(() => null),
      ]);
      const lista = devolvivel.items;
      setFluxo(devolvivel.fluxo ?? 'imediato');
      setVendaAberta(devolvivel.venda ?? null);
      const pagamento = comoFoiPagaDe(detalhe);
      setComoFoiPaga(pagamento);
      setSaleId(venda.id);
      setSaleNumber(venda.number);
      setVendaTemCliente(Boolean(venda.customer_id));
      /*
        A proposta é da venda aberta AGORA (revisão da trilha "venda"): venda
        misturada, sem proposta, volta ao padrão da tela — e não fica valendo,
        sem ninguém escolher, a forma que a venda ANTERIOR propôs (o estorno no
        cartão da venda de antes aparecia pré-escolhido na venda em dinheiro e PIX).
      */
      const sugerido = pagamento ? meioSugerido(pagamento) : null;
      if (pagamento) {
        setMetodo(sugerido && (sugerido !== 'credito' || venda.customer_id) ? sugerido : 'dinheiro');
      }
      // Venda anônima e crédito escolhido é o par que o servidor recusa. Voltar
      // para dinheiro é o padrão da tela, e não uma escolha nova do operador.
      if (!venda.customer_id) setMetodo((atual) => (atual === 'credito' ? 'dinheiro' : atual));
      setItens(lista);
      setEscolhas(
        Object.fromEntries(
          lista.map((i) => [i.sale_item_id, { quantity: '0', restock: true, unitIds: [] }]),
        ),
      );
    } catch (err) {
      setErro(
        err instanceof ApiRequestError ? err.message : 'Venda não encontrada nesta operação.',
      );
    }
  }, []);

  /**
   * O cliente chega com o cupom, que mostra o NÚMERO da venda.
   *
   * A primeira versão desta tela pedia o identificador interno — quem está no
   * balcão não tem como saber um UUID, e a tela ficaria inútil na prática.
   */
  const vendasFiltradas = (vendas ?? []).filter((v) => {
    if (v.status === 'cancelled') return false;
    const termo = busca.trim().replace('#', '');
    return termo === '' ? true : String(v.number).includes(termo);
  });

  /**
   * A DEVOLUÇÃO QUE CHEGOU AO SERVIDOR MESMO SEM RESPOSTA (E-venda-servidor-09).
   *
   * O DEFEITO: a rede caía depois do commit, a tela mostrava "Falha ao
   * registrar a devolução" com o formulário intacto, e o segundo clique gravava
   * a SEGUNDA devolução — mais dinheiro fora da gaveta e o estoque subindo de
   * novo. Sem resposta, a pergunta certa não é "tentar de novo?", é "ela
   * chegou?": a tela olha o histórico DESTA venda e procura uma devolução que
   * não existia antes do envio, com a mesma forma.
   *
   * Três respostas, e não duas (revisão da trilha "venda"). A primeira versão
   * tratava "não consegui ler o histórico" como "não chegou": com a rede ainda
   * fora — o caso normal logo depois de uma resposta perdida — a tela afirmava
   * "ela não foi registrada, registre de novo", e o clique seguinte, com a rede
   * de volta, gravava a SEGUNDA devolução. Sem leitura, a tela não afirma nada:
   * guarda o envio em `envioSemConferencia` e confere ANTES do próximo.
   *
   * O valor não entra na comparação: o id novo desta venda, na forma enviada, já
   * é a prova, e um centavo de arredondamento entre a conta da tela e a do
   * servidor faria a devolução gravada parecer ausente — de novo o segundo clique.
   */
  const devolucaoQueChegou = async (envio: EnvioSemResposta): Promise<ConferenciaDoEnvio> => {
    const depois = await coreApi.listSaleReturns({ saleId: envio.saleId }).catch(() => null);
    if (!depois) return { estado: 'sem_conferencia' };
    const nova = depois.find(
      (d) =>
        d.sale_id === envio.saleId && !envio.conhecidas.has(d.id) && d.refund_method === envio.forma,
    );
    return nova ? { estado: 'chegou', devolucao: nova } : { estado: 'nao_chegou' };
  };

  /**
   * O envio que ficou SEM RESPOSTA e que a tela ainda não conseguiu conferir.
   * O próximo "Registrar devolução" da mesma venda confere primeiro — e só
   * envia se o anterior de fato não chegou.
   */
  const envioSemConferencia = useRef<EnvioSemResposta | null>(null);

  /** A devolução chegou, mesmo sem resposta: diz isso e tira o formulário da tela. */
  const anunciarQueChegou = async (devolucao: SaleReturn) => {
    // A tentativa acabou: ela chegou. A próxima devolução é outra, com chave nova.
    chaveDaTentativa.current = null;
    setAviso(
      `A devolução #${devolucao.number} foi registrada — ${formatCents(devolucao.total_cents)}. A resposta `
        + 'do servidor se perdeu na rede, e nada foi lançado de novo.',
    );
    setItens(null);
    setSaleId('');
    setBusca('');
    setMotivo('');
    setComoFoiPaga(null);
    await carregarHistorico();
  };

  const registrar = async (authorizationId?: string) => {
    setSalvando(true);
    setErro(null);
    setAviso(null);
    // A ação nova apaga o rastro da anterior: um link para a ficha de uma venda
    // cancelada minutos atrás, colado ao aviso de uma DEVOLUÇÃO, faria os dois
    // fatos parecerem um só.
    setVendaCancelada(null);
    const formaEnviada: RefundMethod | 'em_etapas' = emEtapas ? 'em_etapas' : metodo;
    let conhecidas: Set<string> | null = null;
    try {
      /*
        O ENVIO ANTERIOR SEM RESPOSTA É CONFERIDO ANTES DE UM NOVO
        (E-venda-servidor-09, revisão). Chegou: é anunciado, e nada é enviado.
        Continua sem como conferir: nada é enviado também.
      */
      const pendente = envioSemConferencia.current;
      if (pendente && pendente.saleId === saleId) {
        const conferido = await devolucaoQueChegou(pendente);
        if (conferido.estado === 'sem_conferencia') {
          setErro(
            'Ainda sem conexão para conferir se a devolução anterior desta venda foi registrada. '
              + 'Nada foi enviado de novo — tente quando a conexão voltar.',
          );
          return;
        }
        envioSemConferencia.current = null;
        if (conferido.estado === 'chegou') {
          await anunciarQueChegou(conferido.devolucao);
          return;
        }
      }

      /*
        O que já existia desta venda ANTES do envio, lido do SERVIDOR com o
        filtro da venda — é contra isso que a falta de resposta é conferida.

        O DEFEITO da primeira versão: a base era o `historico` da tela, que é a
        lista GERAL da operação (as 100 devoluções mais recentes, de todas as
        vendas). Uma devolução antiga desta venda fora dessas 100 parecia "nova"
        depois de uma falha, e a tela anunciava como registrada uma devolução
        que não tinha sido — o operador entregava o dinheiro sem nada lançado.
        Sem essa leitura não há como conferir depois: com a rede fora agora, o
        envio nem sai.
      */
      const antes = await coreApi.listSaleReturns({ saleId }).catch(() => null);
      if (!antes) {
        setErro(
          'Sem conexão com o servidor — a devolução NÃO foi enviada. Confira a conexão e registre de novo.',
        );
        return;
      }
      conhecidas = new Set(antes.filter((d) => d.sale_id === saleId).map((d) => d.id));
      const items = (itens ?? [])
        .map((item) => ({ item, escolha: escolhas[item.sale_item_id] }))
        .filter(({ item, escolha }) => quantidadeDe(item, escolha) > 0)
        .map(({ item, escolha }) => ({
          saleItemId: item.sale_item_id,
          quantity: quantidadeDe(item, escolha),
          restock: escolha!.restock,
          // Duas etapas: a condição em que a mercadoria voltou.
          condition: emEtapas ? (escolha!.condition ?? 'intacto') : undefined,
          // Só vai em produto serializado. Mandar lista vazia no resto faria o
          // servidor recusar com "este produto não é controlado por unidade".
          unitIds: item.serialized === 1 ? escolha!.unitIds : undefined,
        }));

      /*
        DEVOLUÇÃO EM DINHEIRO SAI DA GAVETA — e a gaveta é lida AGORA.

        O servidor lança o movimento negativo na sessão, mas só quando recebe
        `cashSessionId` — e esta tela nunca mandava. O operador tirava as notas,
        devolvia ao cliente, e o fechamento do dia dava FALTA do valor exato,
        sem nenhum movimento que explicasse. Quem levava a culpa era quem
        estava no caixa.

        A leitura é na hora do envio, e não na abertura da tela: entre uma
        coisa e outra pode ter passado um turno inteiro.

        Cartão e PIX não passam por aqui — esses voltam pela operadora.

        A gaveta é a do CAIXA DESTE COMPUTADOR (GAP-PRD-161): a consulta leva o
        caixa que o PDV guardou, e o pedido também — o servidor confere que a
        gaveta é dele, e é quem recusa, com o valor, quando não há gaveta.
      */
      let cashSessionId: string | null = null;
      // Em duas etapas nenhum dinheiro sai agora: a gaveta é lida no registro do reembolso.
      if (metodo === 'dinheiro' && !emEtapas) {
        const gaveta = await coreApi.getOpenCash(caixaDoComputador).catch(() => null);
        if (gaveta && !gaveta.session && gaveta.exigeTerminal) {
          setErro(
            'Esta operação tem caixas cadastrados e este computador ainda não disse qual é o dele. '
              + 'Escolha o caixa no PDV (é de lá que sai o dinheiro), ou devolva por outra forma.',
          );
          return;
        }
        if (!gaveta?.session) {
          setErro(
            'Não há caixa aberto — a devolução em dinheiro sairia da gaveta sem o sistema ver, ' +
              'e o fechamento do dia daria falta. Abra o caixa, ou devolva por outra forma.',
          );
          return;
        }
        cashSessionId = gaveta.session.id;
      }

      // Sem venda aberta pelo botão (a devolução que chega pelo endereço), a
      // chave nasce aqui — e continua a mesma nos reenvios desta tentativa.
      if (!chaveDaTentativa.current) chaveDaTentativa.current = uuid();
      const registro = await coreApi.createSaleReturn(
        emEtapas
          ? {
              saleId,
              reason: motivoComposto,
              reasonCode: codigoDoMotivo,
              reasonNote: observacaoDoMotivo.trim() || undefined,
              items,
              authorizationId,
            }
          : {
              saleId,
              reason: motivo,
              refundMethod: metodo,
              items,
              cashSessionId,
              terminalId: metodo === 'dinheiro' ? caixaDoComputador : null,
              authorizationId,
            },
        chaveDaTentativa.current,
      );
      chaveDaTentativa.current = null;
      if (emEtapas) {
        // A mercadoria está concluída; o dinheiro, não. A próxima etapa abre
        // aqui mesmo, com o valor pendente e o meio em que a venda entrou.
        setAviso(
          `Devolução #${registro.number} registrada — mercadoria concluída, estoque `
            + `${(ROTULO_DO_ESTOQUE[registro.mercadoria?.estoque ?? 'sem_itens'] ?? '—').toLowerCase()}. `
            + `Valor devolvível: ${formatCents(registro.total_cents)}. O reembolso fica PENDENTE até ser `
            + 'registrado abaixo, pelo que de fato for feito.',
        );
        setDevolucaoAberta(registro);
        setItens(null);
        setSaleId('');
        setBusca('');
        setMotivo('');
        setCodigoDoMotivo('');
        setObservacaoDoMotivo('');
        setComoFoiPaga(null);
        await carregarHistorico();
        return;
      }
      setAviso(
        `Devolução #${registro.number} registrada — ${formatCents(registro.total_cents)}. `
          + `A venda #${registro.sale_number} continua no histórico.`
          // O crédito agora TEM onde aparecer, e o operador precisa saber onde:
          // o vale vai para a ficha do cliente e o PDV o oferece na próxima
          // compra. Sem esta frase, "crédito na loja" continuaria significando
          // "anota no papel", que é o hábito que esta rodada veio quebrar.
          + (metodo === 'credito'
            ? ' O valor virou crédito de loja do cliente: aparece na ficha dele e o PDV o oferece'
              + ' como abatimento na próxima compra.'
            : '')
          // Estorno no cartão vai para a maquininha (GAP-PRD-080) — ou, sem
          // cobrança integrada nesta venda, continua sendo no aparelho.
          + (metodo === 'estorno_cartao'
            ? registro.estornosNaMaquininha?.length
              ? ` ${fraseDosEstornosNaMaquininha(registro.estornosNaMaquininha, formatCents)}`
              : ' Esta venda não tem cobrança da maquininha integrada: faça o estorno no próprio aparelho.'
            : ''),
      );
      setItens(null);
      setSaleId('');
      setBusca('');
      setMotivo('');
      await carregarHistorico();
    } catch (err) {
      // Mesma porta do cancelamento: a recusa nomeada abre o diálogo do gestor
      // com a devolução inteira pendurada — os itens escolhidos, o método e o
      // motivo continuam na tela, e nada precisa ser digitado de novo.
      if (pedeGestor(err, 'CORE_RETURN_NEEDS_AUTHORIZATION')) {
        setLiberacaoErro(null);
        setLiberacaoPedida({
          acao: 'devolver_venda',
          referenceId: saleId,
          motivo:
            `Devolução da venda #${saleNumber ?? ''} — ${formatCents(totalEscolhido)} por `
            + `${METODOS.find((m) => m.id === metodo)?.label ?? metodo}.`,
          repetir: (id) => registrar(id),
        });
        return;
      }
      /*
        A MESMA CHAVE COM OUTRO PEDIDO (revisão do E-venda-servidor-09).

        O DEFEITO: o 422 `CORE_IDEMPOTENCY_KEY_REUSED` caía na faixa de erro com a
        frase técnica do servidor ("Esta chave de idempotência já registrou...") e
        a tentativa seguia com a MESMA chave. Ele só acontece quando um envio
        anterior DESTA tentativa foi gravado sem a tela saber (a resposta voltou
        como erro, ou a conferência correu antes de o servidor terminar) e o
        formulário mudou depois — e então todo clique seguinte, com qualquer
        ajuste, tomava o mesmo 422: a tela ficava presa, falando de "chave" com
        quem está no balcão. Aqui a tentativa acaba: a chave sai, o formulário
        fecha, o histórico é recarregado e a devolução que já existe é nomeada.
      */
      if (err instanceof ApiRequestError && err.code === 'CORE_IDEMPOTENCY_KEY_REUSED') {
        const numero = (err.details as { returnNumber?: unknown } | undefined)?.returnNumber;
        chaveDaTentativa.current = null;
        envioSemConferencia.current = null;
        setItens(null);
        setSaleId('');
        setBusca('');
        setMotivo('');
        setComoFoiPaga(null);
        setErro(
          `${typeof numero === 'number' ? `A devolução #${numero}` : 'Uma devolução'} desta venda já tinha `
            + 'sido registrada por um envio anterior desta tela, e nada foi lançado agora. Confira no '
            + 'histórico abaixo o que ela devolveu antes de entregar qualquer coisa ao cliente; se ainda '
            + 'faltar devolver algo, abra a venda de novo em "Devolver desta".',
        );
        await carregarHistorico();
        return;
      }
      /*
        SEM RESPOSTA também é o 502/503/504 do proxy na frente da API: o 504 é
        justamente "o servidor de trás pode ter gravado". Ele chega como
        `ApiRequestError` (corpo HTML), e a primeira versão o tratava como
        recusa — formulário intacto, segundo clique, segunda devolução.
      */
      const semResposta =
        !(err instanceof ApiRequestError) || [0, 502, 503, 504].includes(err.status);
      if (semResposta && conhecidas) {
        const envio: EnvioSemResposta = { saleId, conhecidas, forma: formaEnviada };
        const conferido = await devolucaoQueChegou(envio);
        if (conferido.estado === 'chegou') {
          await anunciarQueChegou(conferido.devolucao);
          return;
        }
        if (conferido.estado === 'sem_conferencia') {
          envioSemConferencia.current = envio;
          setErro(
            'Sem resposta do servidor, e ainda não deu para conferir se a devolução foi registrada. '
              + 'Não entregue nada ao cliente ainda: quando a conexão voltar, clique em "Registrar '
              + 'devolução" de novo — a tela confere primeiro e só envia se a primeira não tiver chegado.',
          );
          return;
        }
        setErro(
          'Sem resposta do servidor, e nenhuma devolução nova desta venda apareceu no histórico: '
            + 'ela não foi registrada. Confira a conexão e registre de novo.',
        );
        return;
      }
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao registrar a devolução.');
    } finally {
      setSalvando(false);
    }
  };

  /*
    O "A devolver" é a conta do SERVIDOR (GAP-PRD-009/050): o líquido da linha,
    com o desconto do rodapé rateado, sobre o acumulado do que já voltou. A
    conta antiga desta tela — total bruto × qtd / vendida — anunciava R$ 200,00
    numa venda que recebeu R$ 180,00.
  */
  const totalEscolhido = (itens ?? []).reduce((soma, item) => {
    const qtd = quantidadeDe(item, escolhas[item.sale_item_id]);
    if (qtd <= 0) return soma;
    return soma + valorDaDevolucaoDaLinha(item, qtd);
  }, 0);
  const vendaTemDescontoNoRodape = (itens ?? []).some(temDescontoDoRodape);

  const algumItem = (itens ?? []).some(
    (item) => quantidadeDe(item, escolhas[item.sale_item_id]) > 0,
  );

  return (
    <AppShell>
      <PageHeader
        breadcrumb={['Vendas', 'Devoluções']}
        title="Cancelamentos e devoluções"
        subtitle="Devolver reconhece que a venda aconteceu — cancelar, não. A venda não é alterada."
      />

      {/*
        A CONDIÇÃO SE EXPLICA ANTES DO CLIQUE, em vez de virar 403 depois dele.

        Esta linha dizia "cancelar venda é do gerente da loja" e o botão ficava
        escondido. As duas coisas mudaram junto: o botão aparece, porque agora
        existe caminho, e a frase deixa de ser uma negativa para ser a
        instrução — vai precisar de um gestor, e ele assina aqui mesmo.
      */}
      {!(cancelaDireto && devolveDireto) && (
        <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] mb-4">
          Cancelar venda {devolveDireto ? '' : 'e registrar devolução '}é decisão de quem responde
          pela loja. Você pode fazer por aqui com a liberação de um gestor: ele digita a credencial
          na hora, o sistema registra os dois nomes, e a liberação vale uma vez só para esta venda.
        </p>
      )}

      {erro && (
        <p role="alert" className="text-[var(--gs-danger)] text-[length:var(--gs-text-sm)]">
          {erro}
        </p>
      )}
      {aviso && (
        <p className="text-[var(--gs-success)] text-[length:var(--gs-text-sm)]">
          {aviso}
          {vendaCancelada && (
            <>
              {' '}
              {/*
                A PLACA NA PORTA DO BECO.

                `destinoDaOrigem` é o mesmo tradutor que o financeiro usa para
                levar do título até o documento — reusá-lo é o que impede um
                segundo jeito de escrever `/sistema/vendas?venda=`. O contrato
                dele admite `null` para origem sem superfície; 'sale' tem uma,
                e o fallback é a lista inteira, que continua sendo um destino de
                verdade — nunca um link que não abre.
              */}
              <Link
                to={destinoDaOrigem('sale', vendaCancelada.id) ?? '/sistema/vendas'}
                className="text-[var(--gs-purple-700)] underline"
              >
                Ver a ficha da venda #{vendaCancelada.number}
              </Link>{' '}
              — lá está o que ela vendeu e o que saiu do carrinho antes de fechar.
            </>
          )}
        </p>
      )}

      <Card title="Registrar devolução">
        <div className="mb-4">
          <Field label="Venda" hint="O número que está no cupom do cliente">
            {(p) => (
              <Input
                {...p}
                value={busca}
                onChange={(e) => setBusca(e.target.value)}
                placeholder="Número da venda, ex.: 42"
                inputMode="numeric"
              />
            )}
          </Field>
        </div>

        {!itens && (
          <div className="overflow-x-auto">
            {vendas === null ? (
              <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">Carregando vendas…</p>
            ) : vendasFiltradas.length === 0 ? (
              /*
                O VAZIO DIZ O QUE ESCONDEU, E PARA ONDE FOI.

                Quem digitava o número de uma venda cancelada lia "não encontrada" e a explicação
                do estoque — e parava aí, sem saber que a venda existe inteira noutra tela. É o
                mesmo beco do aviso pós-cancelamento, pela outra ponta: `/sistema/vendas` lista as
                canceladas, e é na ficha delas que mora o rastro do carrinho.
              */
              <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                Nenhuma venda encontrada. Venda cancelada não aparece aqui: o cancelamento já repôs
                o estoque e não há o que devolver.{' '}
                <Link to="/sistema/vendas" className="text-[var(--gs-purple-700)] underline">
                  Ver todas as vendas, inclusive as canceladas
                </Link>{' '}
                — a ficha de cada uma mostra os itens e o que saiu do carrinho antes de fechar.
              </p>
            ) : (
              <table className="w-full text-[length:var(--gs-text-sm)] border-collapse">
                <thead>
                  <tr className="text-left text-[var(--gs-muted)]">
                    <th className="py-2">Venda</th>
                    <th className="py-2">Data</th>
                    <th className="py-2 text-right">Total</th>
                    <th className="py-2" />
                  </tr>
                </thead>
                <tbody>
                  {vendasFiltradas.slice(0, 12).map((v) => (
                    <tr key={v.id} className="border-t border-[var(--gs-border)]">
                      <td className="py-2 font-mono">#{v.number}</td>
                      <td className="py-2">
                        {dataBR(v.created_at)}
                      </td>
                      <td className="py-2 text-right">{formatCents(v.total_cents)}</td>
                      <td className="py-2 text-right">
                        <div className="inline-flex gap-2">
                          <Button size="sm" variant="ghost" onClick={() => void abrirVenda(v)}>
                            Devolver desta
                          </Button>
                          {/*
                            Os dois botões lado a lado, e é assim que tem de
                            ser: a escolha entre devolver e cancelar acontece
                            com o cliente na frente, sobre a MESMA venda. Pôr o
                            cancelamento noutra tela obrigaria a pessoa a
                            decidir antes de ver as duas opções — e a que ela
                            acha primeiro vira a que ela usa sempre.

                            `danger` porque é irreversível e desfaz três
                            registros; `ghost` no devolver porque devolução é a
                            operação comum do balcão.
                          */}
                          <Button
                            size="sm"
                            variant="danger"
                            onClick={() => {
                              setCancelando(v);
                              setMotivoCancelamento('');
                              setErroCancelamento(null);
                            }}
                          >
                            Cancelar venda
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {itens && itens.length === 0 && (
          <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
            Esta venda não tem itens devolvíveis.
          </p>
        )}

        {itens && itens.length > 0 && (
          <>
            <div className="flex items-center gap-3 mb-2">
              <strong>Venda #{saleNumber}</strong>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setItens(null);
                  setSaleId('');
                  setSaleNumber(null);
                  setComoFoiPaga(null);
                }}
              >
                Trocar venda
              </Button>
            </div>
            {emEtapas && vendaAberta && <VendaDaDevolucao venda={vendaAberta} />}
            {/*
              COMO A VENDA ENTROU — antes de escolher como o dinheiro volta
              (E-venda-servidor-03). O servidor devolve, em cada meio, só o que
              entrou nele; a tela diz isso ANTES do clique.
            */}
            {comoFoiPaga && (
              <p
                data-testid="como-a-venda-foi-paga"
                className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] m-0 mb-2"
              >
                Como a venda foi paga:{' '}
                {[
                  ...comoFoiPaga.linhas.map(
                    (l) =>
                      `${rotuloDoMeio(l.metodo)} ${formatCents(l.cents)}`
                      + (l.pendente ? ' (ainda não caiu)' : ''),
                  ),
                  ...(comoFoiPaga.valeCents > 0
                    ? [`Crédito de loja ${formatCents(comoFoiPaga.valeCents)}`]
                    : []),
                ].join(' · ') || 'sem pagamento na hora (venda a prazo)'}
                . Dinheiro e PIX voltam até o que entrou em dinheiro ou PIX; o cartão, por estorno
                no cartão; o vale, como crédito de loja — e o que ainda não foi recebido não volta.
              </p>
            )}
            <div className="overflow-x-auto">
              <table className="w-full text-[length:var(--gs-text-sm)] border-collapse">
                <thead>
                  <tr className="text-left text-[var(--gs-muted)]">
                    <th className="py-2">Item</th>
                    <th className="py-2 text-right">Vendido</th>
                    {emEtapas && <th className="py-2 text-right">Pago por unidade</th>}
                    <th className="py-2 text-right">Já devolvido</th>
                    <th className="py-2 w-28">Devolver</th>
                    <th className="py-2">{emEtapas ? 'Condição e estoque' : 'Volta ao estoque?'}</th>
                  </tr>
                </thead>
                <tbody>
                  {itens.map((item) => {
                    const resta = item.quantity - item.returned_quantity;
                    const escolha = escolhas[item.sale_item_id] ?? {
                      quantity: '0',
                      restock: true,
                      unitIds: [],
                    };
                    const porUnidade = item.serialized === 1;
                    return (
                      <tr key={item.sale_item_id} className="border-t border-[var(--gs-border)]">
                        <td className="py-2">{item.description}</td>
                        <td className="py-2 text-right">{item.quantity}</td>
                        {emEtapas && (
                          // O que o cliente PAGOU por unidade: o líquido da linha,
                          // com o desconto dela e a parte do desconto da venda.
                          <td className="py-2 text-right" data-testid={`pago-por-unidade-${item.sale_item_id}`}>
                            {formatCents(Math.round((item.net_total_cents ?? item.total_cents) / item.quantity))}
                          </td>
                        )}
                        <td className="py-2 text-right">{item.returned_quantity}</td>
                        <td className="py-2">
                          {/*
                            PRODUTO CONTROLADO POR UNIDADE NÃO TEM CAMPO DE
                            QUANTIDADE.

                            "Devolver 1" não diz QUAL das duas motos iguais
                            voltou, e o servidor recusa a devolução sem a peça
                            nomeada. Aqui a quantidade é consequência do que foi
                            bipado — assim não existe estado em que a tela deixa
                            pedir e o servidor recusa.
                          */}
                          {porUnidade ? (
                            item.units.length === 0 ? (
                              <span className="text-[var(--gs-muted)]">
                                Nenhuma peça desta venda ainda está com o cliente.
                              </span>
                            ) : (
                              <div className="flex flex-col gap-1.5">
                                {item.units.map((u) => (
                                  <label key={u.id} className="flex items-center gap-2">
                                    <input
                                      type="checkbox"
                                      checked={escolha.unitIds.includes(u.id)}
                                      onChange={(e) =>
                                        setEscolhas((a) => ({
                                          ...a,
                                          [item.sale_item_id]: {
                                            ...escolha,
                                            unitIds: e.target.checked
                                              ? [...escolha.unitIds, u.id]
                                              : escolha.unitIds.filter((id) => id !== u.id),
                                          },
                                        }))
                                      }
                                    />
                                    <span className="font-mono">{identidadeDaPeca(u)}</span>
                                  </label>
                                ))}
                              </div>
                            )
                          ) : (
                            <Input
                              type="number"
                              /* A coluna se chama "Devolver" e o campo não tinha
                                 nome nenhum: quem lê por leitor de tela ouvia
                                 "caixa de rotação" sem saber de qual item. */
                              aria-label={`Devolver quantos de ${item.description}`}
                              min={0}
                              max={resta}
                              step="any"
                              value={escolha.quantity}
                              disabled={resta <= 0}
                              onChange={(e) =>
                                setEscolhas((a) => ({
                                  ...a,
                                  [item.sale_item_id]: { ...escolha, quantity: e.target.value },
                                }))
                              }
                            />
                          )}
                        </td>
                        <td className="py-2">
                          {/*
                            A escolha que mais custa dinheiro nesta tela. Peça
                            com defeito marcada como boa vira saldo que não
                            existe.
                          */}
                          {emEtapas ? (
                            <CondicaoEEstoque
                              id={item.sale_item_id}
                              descricao={item.description}
                              condicao={escolha.condition ?? 'intacto'}
                              volta={escolha.restock}
                              desabilitado={resta <= 0}
                              onChange={(condicao, volta) =>
                                setEscolhas((a) => ({
                                  ...a,
                                  [item.sale_item_id]: { ...escolha, condition: condicao, restock: volta },
                                }))
                              }
                            />
                          ) : (
                            <label className="flex items-center gap-2">
                              <input
                                type="checkbox"
                                checked={escolha.restock}
                                disabled={resta <= 0}
                                onChange={(e) =>
                                  setEscolhas((a) => ({
                                    ...a,
                                    [item.sale_item_id]: { ...escolha, restock: e.target.checked },
                                  }))
                                }
                              />
                              {escolha.restock ? 'Sim, em condição de venda' : 'Não — com defeito'}
                            </label>
                          )}
                          {/*
                            Desmarcar não é só "não somar ao saldo": a peça
                            identificada sai do estoque como baixada e deixa de
                            ter dono. Dizer isso aqui evita a descoberta pelo
                            portal do cliente, semanas depois.
                          */}
                          {porUnidade && !escolha.restock && (
                            <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] m-0 mt-1">
                              A peça fica baixada, fora do estoque vendável, e deixa de constar como
                              do cliente no portal.
                            </p>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {emEtapas ? (
              <MotivoDaDevolucao
                codigo={codigoDoMotivo}
                observacao={observacaoDoMotivo}
                onCodigo={setCodigoDoMotivo}
                onObservacao={setObservacaoDoMotivo}
              />
            ) : (
            <div className="grid gap-4 md:grid-cols-2 mt-4">
              <Field label="Motivo" required hint="Fica registrado na devolução">
                {(p) => (
                  <Input
                    {...p}
                    value={motivo}
                    onChange={(e) => setMotivo(e.target.value)}
                    placeholder="Tamanho errado, defeito, arrependimento…"
                  />
                )}
              </Field>
              <Field label="Como o dinheiro volta">
                {(p) => (
                  <select
                    {...p}
                    value={metodo}
                    onChange={(e) => setMetodo(e.target.value as RefundMethod)}
                    className="w-full rounded-[var(--gs-radius)] border border-[var(--gs-border)]
                      bg-[var(--gs-surface)] px-3 py-2 text-[length:var(--gs-text-base)]"
                  >
                    {METODOS.map((m) => (
                      <option
                        key={m.id}
                        value={m.id}
                        /*
                          O CRÉDITO SÓ EXISTE COM DONO.

                          Desabilitar em vez de esconder: a opção some da lista e
                          o operador conclui que o sistema não faz troca. Aqui
                          ela continua visível, indisponível, e a linha abaixo
                          diz o que fazer para destravá-la.
                        */
                        disabled={m.id === 'credito' && !vendaTemCliente}
                      >
                        {m.label} — {m.hint}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              {!vendaTemCliente && (
                <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] m-0 md:col-span-2">
                  Esta venda saiu sem cliente identificado, então o crédito de loja não está
                  disponível: o vale precisa de dono para virar saldo e ser gasto depois. Devolva
                  em dinheiro, PIX ou estorno no cartão.
                </p>
              )}
            </div>
            )}

            <div className="flex flex-wrap items-center gap-3 mt-4">
              <Button
                onClick={() => void registrar()}
                loading={salvando}
                disabled={!algumItem || (emEtapas ? !motivoEmEtapasOk : motivo.trim().length < 3)}
              >
                {emEtapas ? 'Confirmar mercadoria' : 'Registrar devolução'}
              </Button>
              <span className="font-bold">
                {emEtapas ? 'Valor devolvível' : 'A devolver'}: {formatCents(totalEscolhido)}
              </span>
            </div>

            <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
              O valor sai do preço praticado na venda, não do preço de hoje — devolver pelo preço
              atual pagaria a mais depois de um aumento e a menos depois de uma promoção.
            </p>

            {vendaTemDescontoNoRodape && (
              <p
                data-testid="desconto-do-rodape-rateado"
                className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]"
              >
                Esta venda teve desconto no total, e ele entra em cada item na proporção do valor
                dele: a devolução devolve o que o cliente pagou pelo item, não o preço antes do
                desconto.
              </p>
            )}

            {itens.some((i) => i.serialized === 1) && (
              <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                Nos itens controlados por unidade, marque a peça pelo número que está nela — é o
                chassi ou a série que vale, não a posição na lista. Marcar a peça errada deixa o
                pátio com uma moto e o sistema afirmando que tem outra.
              </p>
            )}
          </>
        )}
      </Card>

      {/*
        O PASSIVO EM VALE, ao lado do botão que o faz crescer.

        A devolução em crédito não tira dinheiro do caixa HOJE — e é justamente
        por isso que ela é fácil de dar. O que ela cria é dívida: mercadoria de
        volta na prateleira e um vale que o cliente vai gastar depois. Sem este
        número, o total só apareceria somando devolução por devolução à mão, que
        é o mesmo que não aparecer.

        Some quando é zero: um "R$ 0,00 em vale" permanente vira paisagem, e no
        dia em que o número subir ninguém vai reparar.
      */}
      {passivo && passivo.cents > 0 && (
        <div
          data-testid="passivo-em-vale"
          className="mb-5 px-4 py-3 rounded-[var(--gs-radius)] bg-[var(--gs-info-bg)]
            text-[var(--gs-info)] text-[length:var(--gs-text-sm)]"
        >
          A loja deve <strong>{formatCents(passivo.cents)}</strong> em crédito de loja para{' '}
          {passivo.customers === 1 ? '1 cliente' : `${passivo.customers} clientes`}. É mercadoria
          que já voltou e ainda não foi paga de volta — o saldo de cada um está na ficha dele, e o
          PDV o oferece como abatimento na próxima compra.
        </div>
      )}

      {devolucaoAberta && (
        <PainelDoReembolso
          devolucao={devolucaoAberta}
          caixaDoComputador={caixaDoComputador}
          onRegistrado={async (r) => {
            setDevolucaoAberta(r);
            const resumo = r.reembolso;
            setAviso(
              `Devolução ao cliente registrada na devolução #${r.number}: `
                + `${formatCents(resumo?.reembolsadoCents ?? 0)} de ${formatCents(resumo?.devolvivelCents ?? 0)} — `
                + `reembolso ${resumo ? SITUACAO[resumo.situacao].texto : '—'}.`
                + (r.estornosNaMaquininha?.length
                  ? ` ${fraseDosEstornosNaMaquininha(r.estornosNaMaquininha, formatCents)}`
                  : ''),
            );
            await carregarHistorico();
          }}
          onPedeGestor={(motivoDoPedido, repetir) => {
            setLiberacaoErro(null);
            setLiberacaoPedida({
              acao: 'devolver_venda',
              referenceId: devolucaoAberta.sale_id,
              motivo: motivoDoPedido,
              repetir,
            });
          }}
          onFechar={() => setDevolucaoAberta(null)}
        />
      )}

      <Card title="Devoluções registradas">
        {/*
          O RECORTE SE DECLARA, e tem saída. Filtrar em silêncio faria quem
          chegou por outro caminho ler "sumiram as devoluções".
        */}
        {devolucaoPedida && (
          <p className="m-0 mb-3 flex flex-wrap items-center gap-3 text-[length:var(--gs-text-sm)]">
            <span>
              Mostrando só a devolução que veio do link
              {historicoNaTela?.length === 1 ? ` — #${historicoNaTela[0].number}` : ''}.
              {historicoNaTela?.length === 0 && ' Ela não está nesta listagem.'}
            </span>
            <Link
              to="/sistema/vendas/devolucoes"
              className="text-[var(--gs-purple-700)] underline"
            >
              Ver todas as devoluções
            </Link>
          </p>
        )}
        {historicoNaTela === null ? (
          <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">Carregando…</p>
        ) : historicoNaTela.length === 0 ? (
          <EmptyState
            title="Nenhuma devolução"
            description="Devoluções aparecem aqui ao lado das vendas, sem alterá-las."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[length:var(--gs-text-sm)] border-collapse">
              <thead>
                <tr className="text-left text-[var(--gs-muted)]">
                  <th className="py-2">Nº</th>
                  <th className="py-2">Venda</th>
                  <th className="py-2">Motivo</th>
                  <th className="py-2">Forma</th>
                  <th className="py-2">Data</th>
                  <th className="py-2 text-right">Valor</th>
                  <th className="py-2">Reembolso</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {historicoNaTela.map((d) => (
                  <tr key={d.id} className="border-t border-[var(--gs-border)]">
                    <td className="py-2 font-mono">#{d.number}</td>
                    <td className="py-2 font-mono">#{d.sale_number}</td>
                    <td className="py-2">{d.reason}</td>
                    <td className="py-2">
                      <Badge tone={d.refund_method === 'credito' ? 'info' : 'neutral'}>
                        {d.refund_method === 'em_etapas'
                          ? 'Em duas etapas'
                          : (METODOS.find((m) => m.id === d.refund_method)?.label ?? d.refund_method)}
                      </Badge>
                    </td>
                    <td className="py-2">{dataBR(d.created_at)}</td>
                    <td className="py-2 text-right">{formatCents(d.total_cents)}</td>
                    <td className="py-2" data-testid={`reembolso-da-devolucao-${d.number}`}>
                      {d.reembolso ? (
                        <Badge tone={SITUACAO[d.reembolso.situacao].tom}>
                          {SITUACAO[d.reembolso.situacao].texto}
                          {d.reembolso.pendenteCents > 0 ? ` · falta ${formatCents(d.reembolso.pendenteCents)}` : ''}
                        </Badge>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="py-2 text-right">
                      {d.refund_flow === 'duas_etapas' && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            coreApi
                              .getSaleReturn(d.id)
                              .then(setDevolucaoAberta)
                              .catch((err: unknown) =>
                                setErro(err instanceof ApiRequestError ? err.message : 'Falha ao abrir a devolução.'),
                              );
                          }}
                        >
                          {(d.reembolso?.pendenteCents ?? 0) > 0 ? 'Registrar reembolso' : 'Ver'}
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/*
        --------------------------------------- o que a devolução gerou a pagar

        Só com a FICHA aberta (`?devolucao=`): sem documento na mesa não há
        origem pela qual perguntar, e perguntar pela lista inteira seria uma
        consulta por linha do histórico.

        O MESMO `TitulosDoDocumento` das fichas de venda, nota, pedido de compra
        e pedido da loja — ele não consulta nada, recebe a lista pronta. Uma
        segunda cópia do bloco criaria a segunda definição da mesma regra, e a
        distinção entre "não gerou título" e "não consegui perguntar" teria de
        ser reescrita certa duas vezes.

        Fica DEPOIS da devolução, e não antes: primeiro o papel, depois o que
        ele cobra.
      */}
      {devolucaoPedida && (
        <div data-testid="devolucao-titulos-do-financeiro">
          <TitulosDoDocumento
            titulos={titulos}
            erro={erroTitulos}
            titulo="O que esta devolução gerou no financeiro"
            subtitulo="O estorno lançado no contas a pagar — com o que ainda não voltou ao cliente."
          />
        </div>
      )}

      {cancelando && (
        <ConfirmarCancelamentoDialog
          venda={cancelando}
          motivo={motivoCancelamento}
          onMotivo={setMotivoCancelamento}
          busy={cancelandoBusy}
          erro={erroCancelamento}
          // Quem não cancela sozinho é avisado AQUI, antes de se comprometer —
          // era este o cuidado que escondia o botão, e ele não se perdeu.
          precisaDeGestor={!cancelaDireto}
          onCancel={() => {
            setCancelando(null);
            setMotivoCancelamento('');
            setErroCancelamento(null);
          }}
          onConfirm={() => void cancelarVenda()}
        />
      )}

      {/*
        O MESMO DIÁLOGO DA ALÇADA DE DESCONTO, e é de propósito que seja o
        mesmo componente: quem digita a senha do gestor no PDV vê exatamente
        esta caixa, e uma segunda com outro texto ensinaria que existem duas
        "autorizações" diferentes no sistema. Existe uma.
      */}
      {liberacaoPedida && (
        <AutorizacaoGerenteDialog
          motivo={liberacaoPedida.motivo}
          busy={liberacaoBusy}
          error={liberacaoErro}
          onCancel={() => {
            setLiberacaoPedida(null);
            setLiberacaoErro(null);
          }}
          onConfirm={(login, password) => void autorizarEContinuar(login, password)}
        />
      )}
    </AppShell>
  );
}

/** Um par rótulo/valor dos blocos da devolução em duas etapas. */
function Estado({ rotulo, valor, testid }: { rotulo: string; valor: string; testid?: string }) {
  return (
    <div>
      <dt className="text-[length:var(--gs-text-xs)] uppercase tracking-wide text-[var(--gs-muted)]">{rotulo}</dt>
      <dd className="m-0 font-semibold" data-testid={testid}>
        {valor}
      </dd>
    </div>
  );
}

/**
 * A VENDA ORIGINAL, antes de escolher os itens: número, data e hora, quem
 * operou e quem vendeu, cliente, total pago, desconto, formas de pagamento,
 * situação fiscal e as devoluções anteriores com o estado do reembolso delas.
 */
function VendaDaDevolucao({ venda }: { venda: VendaParaDevolucao }) {
  const formas = venda.payments.map(
    (p) => `${rotuloDoMeio(p.method)} ${formatCents(p.amount_cents)}${p.status === 'pending' ? ' (ainda não caiu)' : ''}`,
  );
  if (venda.customerCreditCents > 0) formas.push(`Crédito de loja ${formatCents(venda.customerCreditCents)}`);
  const quando = new Date(venda.created_at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
  return (
    <dl
      data-testid="venda-da-devolucao"
      className="m-0 mb-3 grid gap-x-6 gap-y-2 grid-cols-2 md:grid-cols-4 text-[length:var(--gs-text-sm)]"
    >
      <Estado rotulo="Venda" valor={`#${venda.number} · ${quando}`} />
      <Estado rotulo="Operador" valor={venda.operator_name ?? '—'} />
      <Estado rotulo="Vendedor" valor={venda.seller_name ?? '—'} />
      <Estado rotulo="Cliente" valor={venda.customer_name ?? 'Consumidor final'} />
      <Estado rotulo="Total pago" valor={formatCents(venda.total_cents)} />
      <Estado rotulo="Desconto na venda" valor={formatCents(venda.discount_cents)} />
      <Estado rotulo="Formas de pagamento" valor={formas.join(' · ') || '—'} testid="formas-da-venda" />
      <Estado rotulo="Fiscal" valor={venda.fiscal.rotulo} testid="fiscal-da-venda" />
      {venda.devolucoes.length > 0 && (
        <div className="col-span-2 md:col-span-4">
          <dt className="text-[length:var(--gs-text-xs)] uppercase tracking-wide text-[var(--gs-muted)]">
            Devoluções anteriores
          </dt>
          <dd className="m-0" data-testid="devolucoes-anteriores">
            {venda.devolucoes
              .map(
                (d) =>
                  `#${d.number} ${formatCents(d.total_cents)} — reembolso ${d.reembolso ? SITUACAO[d.reembolso.situacao].texto : '—'}`,
              )
              .join(' · ')}
          </dd>
        </div>
      )}
    </dl>
  );
}

/**
 * A CONDIÇÃO E O ESTOQUE de um item devolvido — a pergunta, por extenso:
 * "Retornar ao estoque disponível? SIM / NÃO". Quebrado, defeituoso, avariado
 * ou impróprio não volta: o SIM fica travado, e o servidor recusa se chegar.
 */
function CondicaoEEstoque({
  id,
  descricao,
  condicao,
  volta,
  desabilitado,
  onChange,
}: {
  id: string;
  descricao: string;
  condicao: string;
  volta: boolean;
  desabilitado: boolean;
  onChange: (condicao: string, volta: boolean) => void;
}) {
  const intacto = condicao === 'intacto';
  return (
    <div className="flex flex-col gap-1.5">
      <select
        aria-label={`Condição de ${descricao}`}
        value={condicao}
        disabled={desabilitado}
        onChange={(e) => onChange(e.target.value, e.target.value === 'intacto')}
        className="w-full rounded-[var(--gs-radius)] border border-[var(--gs-border)] bg-[var(--gs-surface)] px-2 py-1"
      >
        {CONDICOES.map((c) => (
          <option key={c.id} value={c.id}>
            {c.label}
          </option>
        ))}
      </select>
      <fieldset className="m-0 p-0 border-0 flex flex-wrap items-center gap-3" disabled={desabilitado}>
        <legend className="p-0 text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
          Retornar ao estoque disponível?
        </legend>
        <label className="flex items-center gap-1">
          <input
            type="radio"
            name={`volta-${id}`}
            checked={volta}
            disabled={!intacto}
            onChange={() => onChange(condicao, true)}
            aria-label={`Sim — ${descricao} volta ao estoque disponível`}
          />
          SIM
        </label>
        <label className="flex items-center gap-1">
          <input
            type="radio"
            name={`volta-${id}`}
            checked={!volta}
            onChange={() => onChange(condicao, false)}
            aria-label={`Não — ${descricao} não volta ao estoque disponível`}
          />
          NÃO
        </label>
      </fieldset>
      {!intacto && (
        <p className="m-0 text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
          Mercadoria {CONDICOES.find((c) => c.id === condicao)?.label.toLowerCase() ?? condicao} não volta ao
          estoque disponível.
        </p>
      )}
    </div>
  );
}

/** O motivo em lista, com a observação — "outro" exige observação. */
function MotivoDaDevolucao({
  codigo,
  observacao,
  onCodigo,
  onObservacao,
}: {
  codigo: string;
  observacao: string;
  onCodigo: (v: string) => void;
  onObservacao: (v: string) => void;
}) {
  return (
    <div className="grid gap-4 md:grid-cols-2 mt-4">
      <Field label="Motivo" required hint="Fica registrado na devolução, com o seu nome">
        {(p) => (
          <select
            {...p}
            value={codigo}
            onChange={(e) => onCodigo(e.target.value)}
            className="w-full rounded-[var(--gs-radius)] border border-[var(--gs-border)]
              bg-[var(--gs-surface)] px-3 py-2 text-[length:var(--gs-text-base)]"
          >
            <option value="">Escolha o motivo</option>
            {MOTIVOS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field label={codigo === 'outro' ? 'Observação (obrigatória)' : 'Observação'} required={codigo === 'outro'}>
        {(p) => (
          <Input
            {...p}
            value={observacao}
            onChange={(e) => onObservacao(e.target.value)}
            placeholder="O que o cliente relatou"
          />
        )}
      </Field>
      <p className="m-0 md:col-span-2 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
        Confirmar a mercadoria registra itens, motivo e estoque. O valor fica PENDENTE: a devolução ao
        cliente — dinheiro, PIX ou estorno no cartão — é registrada no passo seguinte, pelo que de fato for
        feito.
      </p>
    </div>
  );
}

/**
 * ============================================================================
 * REGISTRAR DEVOLUÇÃO AO CLIENTE — a segunda etapa da devolução da Preço Justo
 * ============================================================================
 *
 * Mostra os três estados (mercadoria, reembolso, fiscal) e registra o que de
 * fato voltou ao cliente, em um meio por vez: o dinheiro entregue da gaveta,
 * o PIX feito pela conta, o estorno feito na maquininha. A chave é a desta
 * tentativa: o clique duplo, o Enter duplo e o reenvio depois de uma resposta
 * perdida devolvem o MESMO registro — ela só troca depois de um registro que
 * deu certo, ou quando o servidor diz que ela já registrou outra coisa.
 */
function PainelDoReembolso({
  devolucao,
  caixaDoComputador,
  onRegistrado,
  onPedeGestor,
  onFechar,
}: {
  devolucao: SaleReturnDetail;
  caixaDoComputador: string | null;
  onRegistrado: (r: Awaited<ReturnType<typeof coreApi.registerReturnRefund>>) => void | Promise<void>;
  onPedeGestor: (motivo: string, repetir: (authorizationId: string) => Promise<void>) => void;
  onFechar: () => void;
}) {
  const reembolso = devolucao.reembolso;
  const pendente = reembolso?.pendenteCents ?? 0;
  const [meio, setMeio] = useState<MeioDoReembolso>(reembolso?.sugestao?.[0]?.method ?? 'dinheiro');
  const [valor, setValor] = useState(centavosNoCampo(reembolso?.sugestao?.[0]?.cents ?? pendente));
  const [referencia, setReferencia] = useState('');
  const [observacao, setObservacao] = useState('');
  const [justificativa, setJustificativa] = useState('');
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const chave = useRef<string | null>(null);
  const ocupado = useRef(false);

  // Outra devolução aberta, ou esta depois de um registro: a proposta volta ao
  // saldo de agora, e a tentativa seguinte é outra.
  //
  // O reset corre NO COMMIT que desenha o painel. Num efeito passivo ele
  // rodava depois de o painel já estar na tela: o meio escolhido, a referência
  // do PIX ou o valor digitados nesse intervalo eram apagados pelo reset
  // atrasado — o cartão voltava a "dinheiro" e o PIX saía sem a referência que
  // a pessoa tinha escrito. O mesmo vale para o painel relido depois de um
  // registro, que chega pela resposta do servidor.
  useLayoutEffect(() => {
    const s = devolucao.reembolso?.sugestao?.[0];
    setMeio(s?.method ?? 'dinheiro');
    setValor(centavosNoCampo(s?.cents ?? devolucao.reembolso?.pendenteCents ?? 0));
    setReferencia('');
    setObservacao('');
    setJustificativa('');
    setErro(null);
    chave.current = null;
  }, [devolucao]);

  if (!reembolso) return null;

  const centavos = parseReaisToCents(valor);
  const doMeio = reembolso.meiosDaVenda.find((m) => m.method === meio);
  const outroMeio = !(doMeio && centavos !== null && doMeio.disponivelCents >= centavos);
  const formaOriginal =
    reembolso.meiosDaVenda.map((m) => `${rotuloDoMeioDoReembolso(m.method)} ${formatCents(m.recebidoCents)}`).join(' · ')
    || '—';
  const info = MEIOS_DO_REEMBOLSO.find((m) => m.id === meio) ?? MEIOS_DO_REEMBOLSO[0];
  const situacao = SITUACAO[reembolso.situacao];

  const registrar = async (authorizationId?: string) => {
    if (ocupado.current) return;
    if (centavos === null || centavos <= 0) {
      setErro('Valor ilegível: digite no formato 29,90.');
      return;
    }
    ocupado.current = true;
    setSalvando(true);
    setErro(null);
    try {
      let cashSessionId: string | null = null;
      if (meio === 'dinheiro') {
        const gaveta = await coreApi.getOpenCash(caixaDoComputador).catch(() => null);
        if (!gaveta?.session) {
          setErro(
            'Não há caixa aberto — o dinheiro sairia da gaveta sem o sistema ver, e o fechamento daria '
              + 'falta. Abra o caixa, ou devolva por outro meio.',
          );
          return;
        }
        cashSessionId = gaveta.session.id;
      }
      if (!chave.current) chave.current = uuid();
      const r = await coreApi.registerReturnRefund(
        devolucao.id,
        {
          method: meio,
          amountCents: centavos,
          reference: referencia.trim() || undefined,
          note: observacao.trim() || undefined,
          justification: outroMeio ? justificativa.trim() : undefined,
          cashSessionId,
          terminalId: meio === 'dinheiro' ? caixaDoComputador : null,
          authorizationId,
        },
        chave.current,
      );
      chave.current = null;
      await onRegistrado(r);
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === 'CORE_REFUND_NEEDS_AUTHORIZATION') {
        onPedeGestor(
          `Devolução ao cliente — devolução #${devolucao.number}: ${formatCents(centavos)} por ${info.label.toLowerCase()}.`,
          (id) => {
            ocupado.current = false;
            return registrar(id);
          },
        );
        return;
      }
      if (err instanceof ApiRequestError && err.code === 'CORE_IDEMPOTENCY_KEY_REUSED') {
        // Um envio anterior desta tentativa já foi gravado: a tentativa acaba,
        // e a ficha é relida para mostrar o que ele registrou.
        chave.current = null;
        setErro(
          'Um envio anterior desta tela já tinha registrado um reembolso, e nada foi lançado agora. '
            + 'Confira os registros abaixo antes de entregar qualquer coisa ao cliente.',
        );
        const relida = await coreApi.getSaleReturn(devolucao.id).catch(() => null);
        if (relida) await onRegistrado({ ...relida, refundId: '' });
        return;
      }
      // Recusa do servidor ou falta de resposta: a chave FICA — o próximo
      // clique, se o primeiro tiver sido gravado, devolve o mesmo registro.
      setErro(
        err instanceof ApiRequestError && ![0, 502, 503, 504].includes(err.status)
          ? err.message
          : 'Sem resposta do servidor. Tente de novo: o mesmo reembolso não é registrado duas vezes.',
      );
    } finally {
      ocupado.current = false;
      setSalvando(false);
    }
  };

  return (
    <Card
      title={`Devolução #${devolucao.number} — venda #${devolucao.sale_number}`}
      subtitle="Mercadoria, reembolso e fiscal são três estados: um não conclui o outro."
    >
      <div data-testid="painel-do-reembolso">
        <dl className="m-0 mb-3 grid gap-x-6 gap-y-2 grid-cols-2 md:grid-cols-4 text-[length:var(--gs-text-sm)]">
          <Estado rotulo="Mercadoria" valor="CONCLUÍDA" testid="estado-mercadoria" />
          <Estado
            rotulo="Estoque"
            valor={ROTULO_DO_ESTOQUE[devolucao.mercadoria?.estoque ?? 'sem_itens'] ?? '—'}
            testid="estado-estoque"
          />
          <Estado rotulo="Valor devolvível" valor={formatCents(reembolso.devolvivelCents)} testid="valor-devolvivel" />
          <Estado rotulo="Já reembolsado" valor={formatCents(reembolso.reembolsadoCents)} testid="valor-reembolsado" />
          <Estado rotulo="Saldo pendente" valor={formatCents(pendente)} testid="valor-pendente" />
          <div>
            <dt className="text-[length:var(--gs-text-xs)] uppercase tracking-wide text-[var(--gs-muted)]">Reembolso</dt>
            <dd className="m-0" data-testid="estado-reembolso">
              <Badge tone={situacao.tom}>{situacao.texto}</Badge>
            </dd>
          </div>
          <Estado rotulo="Fiscal" valor={devolucao.fiscal?.rotulo ?? '—'} testid="estado-fiscal" />
          <Estado rotulo="Forma original" valor={formaOriginal} testid="forma-original" />
        </dl>
        {devolucao.fiscal && (
          <p className="m-0 mb-3 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">{devolucao.fiscal.detalhe}</p>
        )}

        {reembolso.registros.length > 0 && (
          <div className="overflow-x-auto mb-3">
            <table className="w-full text-[length:var(--gs-text-sm)] border-collapse" data-testid="registros-do-reembolso">
              <thead>
                <tr className="text-left text-[var(--gs-muted)]">
                  <th className="py-1">Meio</th>
                  <th className="py-1 text-right">Valor</th>
                  <th className="py-1">Quem registrou</th>
                  <th className="py-1">Quando</th>
                  <th className="py-1">Referência</th>
                  <th className="py-1">Observação</th>
                </tr>
              </thead>
              <tbody>
                {reembolso.registros.map((f) => (
                  <tr key={f.id} className="border-t border-[var(--gs-border)]">
                    <td className="py-1">{rotuloDoMeioDoReembolso(f.method)}</td>
                    <td className="py-1 text-right">{formatCents(f.amount_cents)}</td>
                    <td className="py-1">{f.created_by_name ?? f.created_by}</td>
                    <td className="py-1">
                      {new Date(f.created_at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}
                    </td>
                    <td className="py-1">{f.reference ?? '—'}</td>
                    <td className="py-1">
                      {[
                        f.original_method ? `Venda entrou por ${f.original_method}: ${f.method_justification ?? ''}` : '',
                        f.note ?? '',
                      ]
                        .filter(Boolean)
                        .join(' · ') || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {pendente > 0 ? (
          <form
            aria-label="Registrar devolução ao cliente"
            className="grid gap-4 md:grid-cols-2"
            onSubmit={(e) => {
              e.preventDefault();
              void registrar();
            }}
          >
            <p className="m-0 md:col-span-2 font-bold text-[var(--gs-purple-900)]">REGISTRAR DEVOLUÇÃO AO CLIENTE</p>
            <Field label="Meio da devolução" hint="Proposto pelo meio em que a venda entrou">
              {(p) => (
                <select
                  {...p}
                  value={meio}
                  onChange={(e) => setMeio(e.target.value as MeioDoReembolso)}
                  className="w-full rounded-[var(--gs-radius)] border border-[var(--gs-border)]
                    bg-[var(--gs-surface)] px-3 py-2 text-[length:var(--gs-text-base)]"
                >
                  {MEIOS_DO_REEMBOLSO.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field label="Valor" hint={`Saldo pendente: ${formatCents(pendente)}`}>
              {(p) => <Input {...p} value={valor} onChange={(e) => setValor(e.target.value)} inputMode="decimal" />}
            </Field>
            <p className="m-0 md:col-span-2 text-[length:var(--gs-text-sm)]" data-testid="instrucao-do-meio">
              {info.instrucao}
            </p>
            {(meio === 'pix' || meio === 'debito' || meio === 'credito') && (
              <Field label={meio === 'pix' ? 'Referência do PIX (opcional)' : 'NSU / comprovante (opcional)'}>
                {(p) => <Input {...p} value={referencia} onChange={(e) => setReferencia(e.target.value)} />}
              </Field>
            )}
            <Field label="Observação (opcional)">
              {(p) => <Input {...p} value={observacao} onChange={(e) => setObservacao(e.target.value)} />}
            </Field>
            {outroMeio && (
              <div className="md:col-span-2">
                <Field
                  label="Justificativa — meio diferente do original"
                  required
                  hint={`A venda entrou por ${formaOriginal}. Devolver por outro meio é decisão de gestor, e a justificativa fica no registro com o seu nome.`}
                >
                  {(p) => (
                    <Input {...p} value={justificativa} onChange={(e) => setJustificativa(e.target.value)} />
                  )}
                </Field>
              </div>
            )}
            {erro && (
              <p role="alert" className="m-0 md:col-span-2 text-[var(--gs-danger)] text-[length:var(--gs-text-sm)]">
                {erro}
              </p>
            )}
            <div className="md:col-span-2 flex flex-wrap items-center gap-3">
              <Button type="submit" loading={salvando} disabled={salvando || centavos === null || centavos <= 0}>
                {info.botao}
              </Button>
              <Button type="button" variant="ghost" onClick={onFechar}>
                Fechar
              </Button>
            </div>
          </form>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <p className="m-0" data-testid="reembolso-concluido">
              Reembolso concluído — nada mais a devolver ao cliente.
            </p>
            <Button variant="ghost" onClick={onFechar}>
              Fechar
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}

/**
 * A confirmação do cancelamento — e ela tem de DIZER O QUE DESFAZ.
 *
 * Esta tela já trata devolução, e é justamente por isso que a confirmação não
 * pode ser um "tem certeza?". As duas ações se parecem na tela e são opostas no
 * livro:
 *
 *   DEVOLVER   reconhece que a venda aconteceu. Ela continua inteira no
 *              histórico, no fechamento do mês e na comissão que já foi paga.
 *              Volta só o que o cliente trouxe de volta.
 *   CANCELAR   a venda passa a NÃO TER ACONTECIDO. Três registros voltam atrás
 *              de uma vez, e nenhum deles é óbvio para quem está clicando.
 *
 * Os três estão escritos, um a um, porque cada um surpreende alguém: o estoque
 * surpreende quem já separou a mercadoria para outro cliente; a comissão
 * surpreende o vendedor, que vê o número do mês cair; a fidelidade surpreende o
 * cliente, que perde pontos que já apareciam no aplicativo dele. Uma
 * confirmação genérica transfere as três surpresas para depois do clique.
 *
 * O MOTIVO É OBRIGATÓRIO (E-venda-servidor-M01). Era opcional "porque o
 * servidor o aceitava opcional" — e o cancelamento tira dinheiro da gaveta e
 * desfaz estoque, comissão e fidelidade, enquanto a devolução, que mexe em
 * menos coisa, já exigia três letras. O servidor passou a recusar sem motivo, e
 * o botão só confirma com ele: é o que responde "por que esta venda sumiu?" no
 * fechamento e meses depois.
 */
function ConfirmarCancelamentoDialog({
  venda,
  motivo,
  onMotivo,
  busy,
  erro,
  precisaDeGestor,
  onCancel,
  onConfirm,
}: {
  venda: Sale;
  motivo: string;
  onMotivo: (valor: string) => void;
  busy: boolean;
  /** A recusa do servidor, mostrada onde a pessoa está olhando. */
  erro?: string | null;
  /** Quem não cancela sozinho lê isto ANTES de confirmar, não depois. */
  precisaDeGestor: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const motivoValido = motivo.trim().length >= 3;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
      role="dialog"
      aria-modal="true"
      ref={prenderFoco}
      tabIndex={-1}
      aria-label={`Cancelar a venda #${venda.number}`}
      data-testid="confirmar-cancelamento"
    >
      <div className="w-full max-w-xl max-h-[90vh] overflow-y-auto rounded-[var(--gs-radius-lg)] bg-[var(--gs-surface)] shadow-2xl">
        <header className="px-6 py-4 border-b border-[var(--gs-border)]">
          <h2 className="text-[length:var(--gs-text-lg)] font-bold text-[var(--gs-purple-900)] m-0">
            Cancelar a venda #{venda.number}?
          </h2>
        </header>

        <div className="px-6 py-5 flex flex-col gap-4">
          <p className="m-0 text-[length:var(--gs-text-base)]">
            Cancelar não é devolver. A venda de {formatCents(venda.total_cents)} passa a{' '}
            <strong>não valer</strong> — some do faturamento em vez de ficar no histórico com uma
            devolução ao lado.
          </p>

          <div>
            <p className="m-0 mb-1 text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-text-soft)]">
              O que volta atrás, de uma vez:
            </p>
            <ul className="m-0 pl-5 text-[length:var(--gs-text-sm)] flex flex-col gap-1">
              <li>
                <strong>Estoque</strong> — todos os itens voltam à prateleira, inclusive as peças
                de um kit e as unidades com número de série, exatamente as que saíram nesta venda.
              </li>
              <li>
                <strong>Comissão</strong> — o que foi gerado para o vendedor é estornado. Se já
                houve devolução parcial, volta só o saldo que restava.
              </li>
              <li>
                <strong>Fidelidade</strong> — os pontos que o cliente ganhou saem do saldo dele.
              </li>
            </ul>
          </div>

          <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
            O dinheiro em gaveta desta venda também é revertido no caixa do turno. A venda não é
            apagada: fica marcada como cancelada, com o seu nome e a data — a trilha permanece.
            <strong> Não há como desfazer o cancelamento.</strong>
          </p>

          {/*
            O AVISO QUE SUBSTITUIU O BOTÃO ESCONDIDO.

            Antes desta rodada, quem não podia cancelar não via o botão — e a
            razão era não deixar a pessoa ler tudo isto, se comprometer e só
            então descobrir que não podia. O caminho passou a existir, e o
            cuidado continua: ela lê aqui, ANTES de confirmar, que um gestor vai
            precisar assinar ao lado dela.
          */}
          {precisaDeGestor && (
            <p
              data-testid="aviso-de-gestor"
              className="m-0 px-3 py-2 rounded-[var(--gs-radius)] bg-[var(--gs-info-bg)]
                text-[length:var(--gs-text-sm)] text-[var(--gs-info)]"
            >
              Cancelar venda é do gerente da loja. Ao confirmar, o sistema vai pedir a credencial
              de um gestor — ela vale <strong>uma vez só</strong>, para esta venda, e os dois nomes
              ficam registrados na auditoria.
            </p>
          )}

          <Field
            label="Motivo"
            hint="Obrigatório (ao menos 3 letras): é o que responde 'por que esta venda sumiu?' no fechamento e meses depois. Vai para a auditoria, para o movimento de estoque e para a saída da gaveta."
          >
            {(p) => (
              <Input
                {...p}
                value={motivo}
                onChange={(e) => onMotivo(e.target.value)}
                placeholder="Ex.: cliente desistiu no balcão, erro de digitação"
              />
            )}
          </Field>

          {erro && (
            <p
              role="alert"
              data-testid="erro-do-cancelamento"
              className="m-0 text-[var(--gs-danger)] text-[length:var(--gs-text-sm)]"
            >
              {erro}
            </p>
          )}

          <div className="flex justify-end gap-3">
            <Button variant="ghost" onClick={onCancel} disabled={busy}>
              Voltar
            </Button>
            <Button variant="danger" onClick={onConfirm} loading={busy} disabled={!motivoValido}>
              Cancelar a venda #{venda.number}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
