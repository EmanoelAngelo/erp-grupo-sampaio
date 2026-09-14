/**
 * Caixa dentro do PDV: abrir, sangrar, suprir e fechar.
 *
 * POR QUE ESTA TELA EXISTE
 *
 * O PDV avisava "Nenhum caixa aberto" e não oferecia como abrir — o operador
 * tinha que sair para uma tela de gestão, que na separação de ambientes é
 * território do escritório. Um caixa que não consegue começar o dia sem pedir
 * ajuda não é um PDV pronto.
 *
 * O QUE ELA NÃO FAZ
 *
 * Não calcula o esperado por conta própria. O valor esperado vem do servidor
 * (`cashSummary`), que soma o fundo de abertura, as vendas em dinheiro e os
 * movimentos de gaveta na mesma fonte que o fechamento vai usar. Recalcular
 * aqui criaria uma segunda verdade sobre quanto deveria haver na gaveta — e
 * quando as duas divergissem, ninguém saberia qual acreditar.
 *
 * A DIVERGÊNCIA É MOSTRADA, NÃO ESCONDIDA
 *
 * Ao fechar, o operador digita o que CONTOU. A diferença aparece antes de
 * confirmar, com sinal e valor. Fechar com sobra ou falta é possível — o que
 * não pode é fechar sem que a pessoa tenha visto o número.
 *
 * O TETO DA SANGRIA APARECE ANTES DE O OPERADOR DIGITAR
 *
 * A retirada da gaveta é a única operação daqui que tem trava de alçada, e a
 * trava só serve se for VISÍVEL antes. Descobrir o teto pela recusa — depois de
 * digitar o valor, com a mão no dinheiro — é a mesma experiência de descobrir o
 * limite de desconto no Finalizar, com o cliente na frente: o número existe, o
 * sistema sabe, e mesmo assim a pessoa erra primeiro para saber depois.
 *
 * O teto chega junto da sessão em `GET /core/cash/open`. Não é `/sale-policies`,
 * que exige gerente: quem sangra é o caixa, e ele precisa saber a regra que se
 * aplica a ele sem poder ler o limite de desconto da operação inteira.
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as TeclaDoCampo } from 'react';
import { estaNoTopo, prenderFoco } from './armadilhaDeFoco';
import { uuid } from '@/lib/uuid';
import { formatCents, parseReaisToCents } from '@/components/gs/format';
import { AutorizacaoGerenteDialog } from '@/components/gs/PagamentoDialog';
import {
  AvisoGavetaDeOutroDia,
  EscolhaDoCaixa,
  ImprimirFechamento,
  LinhaDoCaixa,
  TETO_FUNDO_DE_TROCO_CENTS,
} from '@/components/gs/CaixaDoComputador';
import { rotuloDoMeio } from '@/lib/comprovanteNaoFiscal';
import { useHasProfile, useSession } from '@/hooks/useSession';
import { ApiRequestError } from '@/lib/api/client';
import {
  coreApi,
  detalheDeSangria,
  type CaixaDoComputador,
  type CashSession,
  type PendenciasEletronicas,
} from '@/lib/api/core';
import { PendenciasDoFechamento } from '@/components/gs/PendenciasDoFechamento';
import { subscribeQueue, type QueuedRequest } from '@/lib/api/offlineQueue';
import { AbrirGavetaPorComando } from '@/components/gs/AbrirGavetaPorComando';
import { cienciaCompleta, pendenciasDoErro } from '@/lib/pendenciasDoFechamento';

/*
  O TETO DO FUNDO DE TROCO (R$ 100.000,00) mora em `CaixaDoComputador` desde
  que a tela de Caixa da gestão passou a cobrá-lo também (H-caixa-seguranca-01,
  as duas telas): uma regra, escrita uma vez, para as duas portas que abrem
  gaveta. Aqui ele vale na abertura e no Suprimento — o botão que o leitor de
  código de barras alcança com o campo "Valor" focado (H-caixa-seguranca-14).
*/

/**
 * O nome que o operador usa para cada movimento da gaveta.
 *
 * Só entra em cena quando o movimento veio sem nota — venda e sangria trazem
 * a própria descrição, e repetir "Venda" antes de "Venda #41" seria ruído.
 */
function rotuloDoMovimento(tipo: string): string {
  const nomes: Record<string, string> = {
    opening: 'Fundo de abertura',
    sale: 'Venda',
    sale_return: 'Devolução',
    sale_cancel: 'Cancelamento',
    supply: 'Suprimento',
    withdrawal: 'Sangria',
    adjustment: 'Ajuste',
  };
  return nomes[tipo] ?? tipo;
}

/*
  O QUE O FECHAMENTO RECUSADO POR GAVETA MORTA DIZ (H-caixa-seguranca-M01).

  O fechamento NÃO tem chave de idempotência: se ESTE computador já o tinha
  mandado e só a resposta se perdeu no Wi-Fi, o "já fechado" do segundo clique
  é o dele mesmo. Por isso a frase não diz "a sua contagem se perdeu" — diz que
  esta tentativa não gravou nada e que vale a contagem de quando ela fechou.
*/
const FECHAMENTO_NAO_GRAVADO =
  'Esta tentativa de fechamento não gravou nada: vale a contagem registrada quando a gaveta fechou.';

interface Resumo {
  expectedCents: number;
  byMethod: { method: string; total: number }[];
  /** O troco devolvido no turno — a ponte entre o entregue e o que ficou. */
  changeCents: number;
  /**
   * Abertura, vendas, sangrias e suprimentos: a composição do esperado.
   *
   * `reference_type` separa a sangria que saiu SEM gestor (`manual`) da que
   * passou com gestor (`manual_com_gestor`) — é a soma das primeiras que o
   * servidor compara com o teto do turno (H-caixa-seguranca-04).
   */
  movements: {
    movement_type: string;
    amount_cents: number;
    note: string | null;
    reference_type?: string | null;
  }[];
  /** O dinheiro eletrônico do turno ainda indefinido (GAP-PRD-081). */
  pendenciasEletronicas: PendenciasEletronicas | null;
}

export function CaixaPdvDialog({
  cash,
  onClose,
  onChanged,
  vendasEmEspera,
  tetoSangriaCents,
  acaoInicial = null,
  caixaDoComputador = null,
  onEscolherCaixa,
  aviso = null,
}: {
  /**
   * POR QUE esta tela subiu sozinha, quando foi a venda que a abriu
   * (E-venda-servidor-08): "a venda no cartão precisa de caixa aberto — o
   * carrinho continua na tela". Sem isto o diálogo aparecia por cima da faixa
   * do balcão e o operador via uma tela de abertura sem saber por quê.
   */
  aviso?: string | null;
  /**
   * O que o servidor disse sobre ESTE computador (GAP-PRD-039/131): qual
   * caixa ele é, se precisa escolher, e se a gaveta é de outro dia. Nulo é a
   * gaveta única de sempre, sem nada a escolher.
   */
  caixaDoComputador?: Omit<CaixaDoComputador, 'session' | 'cashWithdrawalLimitCents'> | null;
  /** Guarda o caixa escolhido (ou `null` para trocar) e relê a gaveta. */
  onEscolherCaixa?: (terminalId: string | null) => void;
  cash: CashSession | null;
  onClose: () => void;
  onChanged: (proximo: CashSession | null) => void;
  /** Vendas em espera nesta sessão. Fechar com elas pendentes perde o carrinho. */
  vendasEmEspera: number;
  /**
   * A ação que o ATALHO pediu — Ctrl+F3 é sangria, Shift+F3 é suprimento.
   *
   * O atalho não pode ser decorativo: quem o aperta precisa VER que a tela
   * entendeu. A ação vem nomeada numa linha de status e o botão dela ganha
   * destaque; o valor continua sendo digitado e confirmado pela pessoa —
   * nenhum atalho lança dinheiro sozinho. Nulo é a abertura comum (F3, botão).
   */
  acaoInicial?: 'sangria' | 'suprimento' | null;
  /**
   * Teto da sangria em centavos, ou `null` para SEM TETO.
   *
   * Nulo não é "não carregou": é a resposta de uma operação que não configurou
   * trava nenhuma — a maioria delas. Nesse caso a tela não desenha aviso
   * algum, porque um aviso sobre um teto que não existe é ruído que ensina o
   * operador a ignorar avisos.
   */
  tetoSangriaCents: number | null;
}) {
  // Esta passou a ser a PRIMEIRA tela do dia — ela pede dinheiro e precisa
  // dizer de qual gaveta está falando.
  const session = useSession();
  const [valor, setValor] = useState('');
  const [nota, setNota] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [resumo, setResumo] = useState<Resumo | null>(null);
  /**
   * O problema DO CAMPO "Valor" — teto do fundo e do suprimento, contagem que
   * falta —, dito embaixo dele e não numa faixa solta (H-caixa-seguranca-01).
   */
  const [erroDoValor, setErroDoValor] = useState<string | null>(null);
  const campoValor = useRef<HTMLInputElement | null>(null);
  /**
   * A sessão que ACABOU de fechar, para o papel do fechamento
   * (H-caixa-seguranca-11). Guardada no clique de confirmar, porque o PDV zera
   * `cash` no mesmo instante em que o fechamento volta.
   */
  const [fechamentoParaImprimir, setFechamentoParaImprimir] = useState<
    { sessionId: string; terminalId: string | null } | null
  >(null);

  /*
    QUEM JÁ TEM ALÇADA NÃO VÊ PEDIDO DE LIBERAÇÃO NENHUM.

    Estes são os mesmos quatro perfis do `AUTHORIZERS` do servidor, e
    `useHasProfile` já devolve verdadeiro para admin_geral e gestor por cima —
    a mesma regra de `requireProfile`, escrita uma vez de cada lado.

    A razão de a tela repetir o teste, em vez de deixar o servidor responder,
    é que o servidor DEIXA ELES PASSAREM: `CashService.addMovement` só cobra
    liberação de quem não tem alçada. Um modal que pedisse a senha de um
    segundo gestor a quem vai passar de qualquer jeito é um pedido que nunca
    tem desfecho — e em loja pequena o gerente É quem fica no caixa. A sangria
    existe para tirar dinheiro da gaveta por segurança; travá-la para ele
    deixaria o dinheiro exposto exatamente no momento em que alguém decidiu
    protegê-lo.
  */
  const temAlcada = useHasProfile('gerente_loja', 'gerente_oficina');

  /**
   * A sangria esperando a liberação de um gestor.
   *
   * Guarda o valor e a observação do momento em que o botão foi apertado, e
   * não relê os campos depois: entre pedir a senha e reenviar, o operador
   * ainda tem o teclado na mão. Sem este congelamento, o gestor autorizaria
   * R$ 800 e o movimento sairia com o que estivesse no campo na hora do
   * reenvio — o mesmo contorno que a liberação sem teto abria no PDV.
   */
  const [sangriaPendente, setSangriaPendente] = useState<
    { centavos: number; nota: string } | null
  >(null);
  const [autorizacaoErro, setAutorizacaoErro] = useState<string | null>(null);
  const [autorizando, setAutorizando] = useState(false);

  const carregarResumo = useCallback(async () => {
    if (!cash) return;
    try {
      const r = await coreApi.cashSummary(cash.id);
      // `?? []` porque um resumo sem as listas derrubava o diálogo inteiro no
      // `.length` — e ele é a primeira tela do dia.
      setResumo({
        expectedCents: r.expectedCents,
        byMethod: r.byMethod ?? [],
        changeCents: r.changeCents ?? 0,
        movements: (r.movements ?? []) as Resumo['movements'],
        pendenciasEletronicas: r.pendenciasEletronicas ?? null,
      });
    } catch {
      // Sem resumo a tela ainda abre e fecha o caixa; só não mostra o esperado.
      setResumo(null);
    }
  }, [cash]);

  useEffect(() => {
    void carregarResumo();
  }, [carregarResumo]);

  /**
   * Abre o caixa e SAI DA FRENTE.
   *
   * O diálogo ficava na tela depois da abertura — agora em modo "Caixa
   * aberto", com um botão vermelho "Fechar caixa" exatamente onde o dedo
   * acabara de clicar em "Abrir caixa". O primeiro gesto do dia terminava a
   * um clique de desfazer o próprio dia.
   */
  const abrirCaixa = async () => {
    // O fundo vai como foi DIGITADO — nunca `?? 0` (H-caixa-seguranca-01): o
    // botão e o Enter já exigem um valor, e esta linha garante que nenhum
    // caminho novo abra a gaveta com um zero que ninguém escreveu.
    if (centavos === null) {
      setErroDoValor('Fundo de troco inválido. Digite o valor em reais, por exemplo 100,00 (ou 0,00 sem fundo).');
      return;
    }
    const fundo = centavos;
    if (fundo > TETO_FUNDO_DE_TROCO_CENTS) {
      setErroDoValor(
        `Fundo de troco acima de ${formatCents(TETO_FUNDO_DE_TROCO_CENTS)}. ` +
          'Confira o valor — um código de barras bipado aqui vira dinheiro na gaveta.',
      );
      return;
    }
    // O turno novo não tem papel de fechamento: a oferta do anterior sai.
    setFechamentoParaImprimir(null);
    // Só fecha se a abertura passou de verdade: com erro na tela, sumir com o
    // diálogo esconderia a recusa que o operador precisa ler.
    // A gaveta abre NO CAIXA deste computador (GAP-PRD-039). Sem caixa é a
    // gaveta única; com o token de dispositivo, o servidor usa o do token.
    if (await executar(() => coreApi.openCash(fundo, caixaDoComputador?.terminal?.id ?? null))) onClose();
  };

  /*
    A CHAVE DO MOVIMENTO (H-caixa-seguranca-09).

    O DEFEITO: suprimento e sangria iam sem chave de idempotência. No Wi-Fi da
    loja o POST chegava e era gravado, a resposta se perdia, a tela mostrava
    "Não foi possível concluir." com o valor ainda no campo — e o segundo
    clique, o gesto natural, gravava o movimento de novo.

    A chave nasce para um movimento (tipo + valor nesta gaveta) e é REUSADA em
    todo reenvio dele até um sucesso — inclusive no reenvio com a liberação do
    gestor: o servidor casa a chave ANTES de gastar a liberação. Mudou o valor
    ou o tipo, é outro movimento, e ganha chave nova. Deu certo, a próxima
    sangria igual (duas de R$ 100 seguidas) também ganha chave nova.
  */
  const chaveDoMovimento = useRef<{ assinatura: string; chave: string } | null>(null);
  const chavePara = (tipo: 'supply' | 'withdrawal', valorCents: number): string => {
    const assinatura = `${cash?.id ?? ''}|${tipo}|${valorCents}`;
    if (chaveDoMovimento.current?.assinatura !== assinatura) {
      chaveDoMovimento.current = { assinatura, chave: uuid() };
    }
    return chaveDoMovimento.current.chave;
  };

  /*
    A GAVETA MORREU COM ESTE DIÁLOGO ABERTO (H-caixa-seguranca-M01, o diálogo).

    O DEFEITO: o PDV relê a gaveta ao abrir este diálogo e ao ver a venda
    recusada — mas não enquanto ele fica aberto. O gestor fechava o turno pela
    lista de gavetas abertas (ou outro computador o fechava), e a sangria, o
    suprimento ou o fechamento feitos daqui recebiam `CORE_CASH_CLOSED` (409) ou
    `CORE_CASH_NOT_FOUND` (404). A tela mostrava "Caixa já fechado." e seguia
    desenhando a gaveta morta — "Caixa aberto", o esperado, os três botões —, e
    cada nova tentativa batia na mesma recusa, sem "Abrir caixa" à vista.

    Agora a recusa zera a gaveta no PDV (`onChanged(null)`, o mesmo caminho do
    fechamento feito aqui, que também esquece a lembrança dela), e o diálogo
    passa a "Abrir caixa" dizendo o que houve e que ESTE pedido não gravou nada.
    É verdade para o movimento: o servidor confere a chave de idempotência antes
    do "já fechado", então o reenvio de um movimento que JÁ tinha passado volta
    como sucesso, e a recusa só chega ao que não entrou.

    O VALOR DIGITADO SAI DO CAMPO: o mesmo campo vira "Fundo de troco", e um
    Enter nele abriria a gaveta nova com o valor da sangria como fundo.
  */
  /*
    QUEM FECHOU, NO FECHAMENTO, NÃO É SÓ "OUTRO LUGAR" (revisão do M01).

    O DEFEITO: a frase do "já fechado" dizia sempre "em outro computador ou
    pela lista de gavetas abertas". No FECHAMENTO o caminho mais comum até essa
    recusa é o do Wi-Fi: o primeiro "Confirmar fechamento" chegou e fechou, a
    resposta se perdeu, a pergunta ficou na tela e o segundo clique voltou 409.
    A tela mandava o operador procurar quem fechou a gaveta dele — e quem fechou
    foi ele. No fechamento a frase passa a incluir esse envio.
  */
  const gavetaMorta = (err: unknown, oQueNaoFoiGravado: string, noFechamento = false): boolean => {
    if (
      !(err instanceof ApiRequestError)
      || (err.code !== 'CORE_CASH_CLOSED' && err.code !== 'CORE_CASH_NOT_FOUND')
    ) {
      return false;
    }
    const oQueHouve =
      err.code === 'CORE_CASH_CLOSED'
        ? noFechamento
          ? 'Esta gaveta já foi fechada (em outro computador, pela lista de gavetas abertas ou por um envio '
            + 'anterior deste mesmo fechamento que ficou sem resposta) — abra uma nova para continuar.'
          : 'Esta gaveta já foi fechada (em outro computador ou pela lista de gavetas abertas) — abra uma nova para continuar.'
        : 'Esta gaveta não existe mais nesta operação — abra uma nova para continuar.';
    // As esperas eram do turno que acabou, e o PDV as descarta junto com ele —
    // o mesmo que o aviso de "vendas em espera" promete no fechamento daqui.
    const esperas =
      vendasEmEspera > 0
        ? ` As ${vendasEmEspera} venda(s) em espera eram daquele turno e saem junto com ele.`
        : '';
    chaveDoMovimento.current = null;
    setSangriaPendente(null);
    setAutorizacaoErro(null);
    setConfirmandoFechamento(false);
    setPendDoServidor(null);
    setPendCiente(false);
    setPendMotivo('');
    setValor('');
    setNota('');
    setErroDoValor(null);
    setResumo(null);
    setErro(`${oQueHouve} ${oQueNaoFoiGravado}${esperas}`);
    onChanged(null);
    campoValor.current?.focus();
    return true;
  };

  /**
   * Devolve `true` quando a ação passou — quem chama decide o que fazer depois.
   *
   * `oQueNaoFoiGravado` é dito quando a ação mexe numa gaveta que JÁ EXISTE
   * (suprimento, fechamento): é a frase que a recusa de gaveta morta mostra.
   * A abertura não passa nada — ela não tem gaveta para ter morrido.
   */
  const executar = async (
    acao: () => Promise<CashSession | null>,
    oQueNaoFoiGravado?: string,
    noFechamento = false,
  ): Promise<boolean> => {
    setOcupado(true);
    setErro(null);
    try {
      const proximo = await acao();
      onChanged(proximo);
      setValor('');
      setNota('');
      await carregarResumo();
      return true;
    } catch (err) {
      if (oQueNaoFoiGravado !== undefined && gavetaMorta(err, oQueNaoFoiGravado, noFechamento)) return false;
      setErro(err instanceof ApiRequestError ? err.message : 'Não foi possível concluir.');
      return false;
    } finally {
      setOcupado(false);
    }
  };

  /*
    A OPERAÇÃO TEM CAIXAS E ESTE COMPUTADOR NÃO DISSE QUAL É.

    Enquanto não disser, não há fundo de troco a pedir: o servidor recusaria a
    abertura (`CORE_TERMINAL_REQUIRED`), e é essa recusa que impede o segundo
    operador de cair na gaveta do primeiro. A tela pergunta antes.
  */
  const precisaEscolherCaixa =
    !cash && Boolean(caixaDoComputador?.exigeTerminal) && !caixaDoComputador?.terminal;

  const centavos = parseReaisToCents(valor);
  /*
    O CAMPO DIZ O PROBLEMA DELE (H-caixa-seguranca-01, as duas telas).

    Texto que não é dinheiro deixava "Abrir caixa" e "Fechar caixa"
    desabilitados sem explicar nada, e a recusa do teto aparecia numa faixa no
    alto do diálogo. O erro de envio (teto, contagem que falta) vence; sem ele,
    o que está digitado e não se lê como reais é dito na hora.
  */
  const mensagemDoValor =
    erroDoValor
    ?? (valor.trim() !== '' && centavos === null
      ? 'Valor inválido: digite em reais, por exemplo 350,50 (ou 0,00).'
      : null);
  const esperado = resumo?.expectedCents ?? null;
  // A diferença só faz sentido depois de o operador digitar o que contou.
  const diferenca = esperado !== null && centavos !== null ? centavos - esperado : null;

  /**
   * O turno teve troco? Então a tela deve a explicação.
   *
   * "Recebido no turno · dinheiro" e "Esperado na gaveta" são os dois
   * verdadeiros e respondem a perguntas diferentes: o primeiro é o que o
   * cliente ENTREGOU, o segundo é o que FICOU. Numa venda de R$ 50 paga com
   * R$ 100 um diz 100 e o outro diz 50, e nada dizia que a diferença era o
   * troco — quem confere conta a gaveta e vai procurar um erro que não existe.
   */
  const entregueEmEspecie = resumo?.byMethod.find((m) => m.method === 'dinheiro')?.total ?? 0;
  const trocoDoTurno = resumo?.changeCents ?? 0;

  /**
   * Fechar o turno não tem volta, e o botão vive na mesma linha do Suprimento
   * e da Sangria, alimentado pelo mesmo campo de valor.
   */
  const [confirmandoFechamento, setConfirmandoFechamento] = useState(false);
  /*
    VENDA GUARDADA NESTE COMPUTADOR QUE AINDA NÃO SUBIU (GAP-PRD-045).

    A venda feita com o servidor fora mora na fila deste navegador e sobe com
    a gaveta DESTE turno. Fechar a gaveta antes de ela subir é o que faz o
    servidor recusá-la depois — com o dinheiro dela já contado aqui. Enquanto
    houver fila, o fechamento espera (a barra do topo envia sozinha).
  */
  /*
    ...MAS SÓ A VENDA QUE SOBE NESTA GAVETA TRAVA O FECHAMENTO (G-offline-sync-12).

    O DEFEITO: a contagem era a fila INTEIRA deste navegador. Uma venda da
    Gringa guardada ontem no mesmo computador deixava o "Fechar caixa" da Preço
    Justo desabilitado para sempre — e a barra do topo nunca a envia nesta
    operação (só manda a venda da operação de agora). O operador ficava sem
    saída.

    Trava a venda desta operação (ou a antiga, sem escopo gravado) que vai para
    ESTA gaveta — ou para gaveta nenhuma, que o servidor resolve no reenvio. A
    de outra operação ou de outro turno aparece à parte, e não trava.
  */
  const [fila, setFila] = useState<QueuedRequest[]>([]);
  useEffect(() => subscribeQueue(setFila), []);
  // A gaveta é sempre da operação da sessão: é dela que `getOpenCash` a trouxe.
  const empresaDaGaveta = session?.company.id ?? null;
  const sobeNestaGaveta = (q: QueuedRequest): boolean => {
    const empresa = q.escopo?.companyId ?? null;
    const gaveta = (q.body as { cashSessionId?: string | null } | null)?.cashSessionId ?? null;
    const daOperacao = !empresa || !empresaDaGaveta || empresa === empresaDaGaveta;
    return daOperacao && (gaveta === null || gaveta === cash?.id);
  };
  const naFila = fila.filter(sobeNestaGaveta).length;
  /*
    O aviso à parte separa as duas razões (revisão do G-offline-sync-12): uma
    frase só dizia à venda de OUTRO TURNO DESTA operação que ela "sobe quando
    alguém voltar àquela operação" — mentira: a operação é esta, e a venda é
    de outra gaveta (turno anterior ou outro caixa), não de outra empresa.
  */
  const deOutraOperacao = fila.filter((q) => {
    const empresa = q.escopo?.companyId ?? null;
    return Boolean(empresa && empresaDaGaveta && empresa !== empresaDaGaveta);
  }).length;
  const deOutraGaveta = fila.length - naFila - deOutraOperacao;

  /*
    DINHEIRO ELETRÔNICO INDEFINIDO NO TURNO (GAP-PRD-081).

    O resumo já traz as pendências (a mesma conta que trava o fechamento no
    servidor), e a tela as mostra ANTES de o operador contar a gaveta. Se o
    servidor recusar com uma lista mais nova — uma cobrança que caiu no meio
    tempo —, vale a dele. Fechar com pendência exige ciência e motivo.
  */
  const [pendDoServidor, setPendDoServidor] = useState<PendenciasEletronicas | null>(null);
  const [pendCiente, setPendCiente] = useState(false);
  const [pendMotivo, setPendMotivo] = useState('');
  const pendencias = pendDoServidor ?? resumo?.pendenciasEletronicas ?? null;
  const temPendencia = (pendencias?.quantidade ?? 0) > 0;

  /*
    SEM ESPERADO NÃO SE FECHA.

    Se a consulta do resumo falha, o esperado vira "—", a diferença some e o
    botão vermelho continuava ativo. Fechar assim grava uma conferência sem
    confronto: o contado entra como fato e a diferença fica registrada contra
    um número que ninguém viu — e o turno não reabre.
  */
  const semResumo = cash !== null && resumo === null;

  /*
    ESC FECHA — a mesma tecla que fecha o pagamento.

    A ajuda do PDV ensina que Esc fecha modal e o diálogo de pagamento
    obedece; este não tinha handler de tecla nenhum no arquivo inteiro. Quem
    aprendeu o gesto apertava duas, três vezes antes de desconfiar.

    Com a confirmação de fechamento na tela, Esc responde a PERGUNTA: some com
    ela e mantém o diálogo. Fechar as duas coisas com uma tecla só faria a
    pessoa perder de vista o que acabou de desfazer.

    COM O PEDIDO DE SENHA DO GESTOR POR CIMA, O ESC É DELE (H-caixa-seguranca-15).
    O DEFEITO: este ouvinte e o do `AutorizacaoGerenteDialog` ficam os dois em
    `window`, na captura, e `stopPropagation` não impede o outro ouvinte do
    MESMO alvo. Este vem primeiro (montou antes) e chamava `onClose()`: o
    gestor desistia com Esc e sumiam o pedido de senha E o diálogo de caixa,
    com o valor e o motivo digitados. Agora, se há diálogo por cima, este cala
    e deixa o de cima responder — o pedido some e o caixa fica.
  */
  const raizDoDialogo = useRef<HTMLDivElement | null>(null);
  const prenderERegistrar = useCallback((raiz: HTMLDivElement | null) => {
    raizDoDialogo.current = raiz;
    return prenderFoco(raiz);
  }, []);
  useEffect(() => {
    const aoTeclar = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (sangriaPendente !== null) return;
      if (raizDoDialogo.current && !estaNoTopo(raizDoDialogo.current)) return;
      e.preventDefault();
      e.stopPropagation();
      if (confirmandoFechamento) {
        setConfirmandoFechamento(false);
        return;
      }
      /*
        COM O PAPEL DO FECHAMENTO OFERECIDO, O ESC É "SEGUIR SEM IMPRIMIR"
        (H-caixa-seguranca-11). Este ouvinte fica em `window`, na captura, e
        roda ANTES do botão da oferta — então é ele que responde: some com a
        oferta e mantém o diálogo, a mesma regra da confirmação acima.
      */
      if (fechamentoParaImprimir) {
        setFechamentoParaImprimir(null);
        campoValor.current?.focus();
        return;
      }
      onClose();
    };
    window.addEventListener('keydown', aoTeclar, true);
    return () => window.removeEventListener('keydown', aoTeclar, true);
  }, [confirmandoFechamento, fechamentoParaImprimir, onClose, sangriaPendente]);

  /*
    ENTER NO "FUNDO DE TROCO" ABRE O CAIXA (D-pdv-teclado-23).

    O DEFEITO: os campos não estavam num formulário nem tinham tecla nenhuma.
    No primeiro gesto do dia o caixa digitava 200 e apertava Enter — e nada.
    Precisava de Tab, Tab, Enter, ou do mouse, num PDV que se opera pelo
    teclado. Só vale com o caixa FECHADO: com a gaveta aberta o mesmo campo
    alimenta suprimento, sangria e fechamento, e um Enter não pode escolher
    nenhum deles — muito menos o fechamento, que não tem volta.
  */
  const aoTeclarNoCampo = (e: TeclaDoCampo<HTMLInputElement>) => {
    if (e.key !== 'Enter' || cash || precisaEscolherCaixa || ocupado || centavos === null) return;
    e.preventDefault();
    void abrirCaixa();
  };

  /*
    O QUE JÁ ESTÁ DIGITADO PASSA DO TETO?

    Estritamente maior, como no servidor (`Math.abs(amountCents) > teto`):
    sangrar EXATAMENTE o teto é o caso que a configuração autoriza, e um `>=`
    aqui pediria gestor para o valor que o dono liberou por escrito.

    Teto nulo é sem trava, e a expressão inteira se cala — não há aviso, não há
    botão diferente, nada muda para a operação que não configurou nada.
  */
  /*
    O TETO É DO TURNO (H-caixa-seguranca-04): o que se compara é o já sangrado
    SEM gestor nesta gaveta mais o que está digitado — a mesma soma que o
    servidor faz. Antes a tela olhava só o valor digitado e deixava cinco
    sangrias de R$ 200 passarem "dentro do teto" de R$ 200.
  */
  const jaSangradoSemGestor = (resumo?.movements ?? [])
    .filter((m) => m.movement_type === 'withdrawal' && m.reference_type === 'manual')
    .reduce((soma, m) => soma + Math.abs(m.amount_cents), 0);
  const passaDoTeto =
    tetoSangriaCents !== null && centavos !== null && jaSangradoSemGestor + centavos > tetoSangriaCents;

  /** A sangria diz para onde o dinheiro foi (H-caixa-seguranca-08). */
  const motivoDaSangria = nota.trim();
  const sangriaSemMotivo = motivoDaSangria.length < 3;

  /** A sangria vai precisar da senha de um gestor antes de sair? */
  const sangriaPedeGestor = passaDoTeto && !temAlcada;

  /**
   * Lança a sangria, com a liberação quando ela existe.
   *
   * O `authorizationId` é a mesma peça do PDV: nasce de `POST
   * /core/authorizations` e é gasta no movimento que a consome. Sem ele o
   * servidor recusa com `CORE_WITHDRAWAL_NEEDS_AUTHORIZATION` — e o `catch`
   * abaixo trata essa recusa como o que ela é: um pedido de senha, e não uma
   * falha.
   */
  const sangrar = async (
    centavosDaSangria: number,
    notaDaSangria: string,
    authorizationId?: string,
  ) => {
    if (!cash) return;
    setOcupado(true);
    setErro(null);
    try {
      await coreApi.cashMovement(
        cash.id,
        'withdrawal',
        centavosDaSangria,
        notaDaSangria || undefined,
        authorizationId,
        chavePara('withdrawal', centavosDaSangria),
      );
      chaveDoMovimento.current = null;
      onChanged(cash);
      setValor('');
      setNota('');
      setSangriaPendente(null);
      await carregarResumo();
    } catch (err) {
      // A gaveta fechou em outro lugar com o diálogo aberto (H-caixa-seguranca-M01):
      // o pedido de senha do gestor, se estava na tela, some junto — não há
      // mais gaveta para a liberação valer.
      if (gavetaMorta(err, `A sangria de ${formatCents(centavosDaSangria)} NÃO foi registrada.`)) return;
      /*
        A RECUSA DO SERVIDOR TAMBÉM ABRE O PEDIDO — e não é redundância com o
        `sangriaPedeGestor` acima.

        O teto na tela é o que veio quando o PDV abriu, e um turno de balcão
        dura o dia inteiro: o dono pode ter apertado a política às onze da
        manhã. Quando isso acontece, quem sabe o número certo é o servidor, e
        ele manda os dois valores em `details`. Tratar este 403 como erro
        genérico deixaria o operador olhando "não foi possível concluir" numa
        retirada que só precisava de uma assinatura.
      */
      if (
        err instanceof ApiRequestError
        && err.code === 'CORE_WITHDRAWAL_NEEDS_AUTHORIZATION'
      ) {
        const detalhe = detalheDeSangria(err.details);
        setSangriaPendente({ centavos: centavosDaSangria, nota: notaDaSangria });
        setAutorizacaoErro(null);
        // A mensagem do SERVIDOR fica na tela junto do pedido: ela já traz o
        // teto e o valor pedido por extenso, e é o número dele que vale.
        setErro(
          detalhe
            ? `${err.message} (teto ${formatCents(detalhe.tetoCents)}, `
              + `pedido ${formatCents(detalhe.pedidoCents)})`
            : err.message,
        );
        return;
      }
      setErro(err instanceof ApiRequestError ? err.message : 'Não foi possível concluir.');
    } finally {
      setOcupado(false);
    }
  };

  /** O botão "Sangria": pede a senha antes quando já se sabe que vai precisar. */
  const aoClicarSangria = () => {
    if (centavos === null || centavos <= 0 || sangriaSemMotivo) return;
    if (sangriaPedeGestor) {
      // Pedir ANTES de enviar poupa uma recusa que a tela já sabe que virá — e
      // o servidor continua sendo quem decide: a liberação só vale se ele a
      // aceitar no reenvio.
      setSangriaPendente({ centavos, nota: motivoDaSangria });
      setAutorizacaoErro(null);
      setErro(null);
      return;
    }
    void sangrar(centavos, motivoDaSangria);
  };

  /** O Suprimento: o mesmo teto da abertura, antes de o servidor recusar. */
  const suprir = () => {
    if (!cash || centavos === null || centavos <= 0) return;
    if (centavos > TETO_FUNDO_DE_TROCO_CENTS) {
      setErroDoValor(
        `Suprimento acima de ${formatCents(TETO_FUNDO_DE_TROCO_CENTS)}. ` +
          'Confira o valor — um código de barras bipado aqui vira dinheiro na gaveta.',
      );
      return;
    }
    const valorDoSuprimento = centavos;
    void executar(async () => {
      await coreApi.cashMovement(
        cash.id,
        'supply',
        valorDoSuprimento,
        nota || undefined,
        undefined,
        chavePara('supply', valorDoSuprimento),
      );
      chaveDoMovimento.current = null;
      return cash;
    }, `O suprimento de ${formatCents(valorDoSuprimento)} NÃO foi registrado.`);
  };

  /** O gestor digitou a credencial: pede a liberação e reenvia a sangria. */
  const confirmarLiberacaoDaSangria = async (login: string, password: string) => {
    if (!sangriaPendente) return;
    setAutorizando(true);
    setAutorizacaoErro(null);
    try {
      /*
        `concedidoCents` vai; `brutoCents` NÃO.

        O teto da gaveta é ABSOLUTO — R$ 800 são R$ 800 —, e não uma fatia de
        coisa nenhuma. Declarar um bruto aqui inventaria um denominador, e o
        servidor passaria a comparar um percentual que ninguém decidiu. É a
        mesma escolha que `CashService` faz do outro lado, onde o bruto desce
        zerado com o comentário dizendo por quê.

        Com o valor declarado, a liberação vale ATÉ ele: autorizar R$ 800 e
        reenviar R$ 3.000 é recusado com os dois números na mensagem.
      */
      const granted = await coreApi.authorize({
        action: 'sangria_especial',
        login,
        password,
        concedidoCents: sangriaPendente.centavos,
        reason:
          `Sangria de ${formatCents(sangriaPendente.centavos)}`
          + (tetoSangriaCents !== null
            ? `, acima do teto de ${formatCents(tetoSangriaCents)} desta operação`
            : '')
          + (sangriaPendente.nota ? ` — ${sangriaPendente.nota}` : ''),
      });
      await sangrar(sangriaPendente.centavos, sangriaPendente.nota, granted.id);
    } catch (err) {
      setAutorizacaoErro(
        err instanceof ApiRequestError ? err.message : 'Não foi possível autorizar.',
      );
    } finally {
      setAutorizando(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      ref={prenderERegistrar}
      tabIndex={-1}
      aria-label={`Caixa · ${session?.company.tradeName ?? ""}`}
      data-testid="caixa-pdv"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
    >
      <div className="w-full max-w-xl rounded-[var(--gs-radius-lg)] bg-[var(--gs-surface)] shadow-2xl">
        <header className="px-6 py-4 border-b border-[var(--gs-border)] flex items-center justify-between">
          {/*
            DE QUAL LOJA É ESTA GAVETA?

            O diálogo pedia o fundo de troco sem nomear a empresa em lugar
            nenhum — nem no `aria-label`, nem no título. Era omissão discreta
            enquanto ele só abria a pedido; virou problema quando passou a ser
            a PRIMEIRA tela do dia. Quem opera duas empresas na mesma máquina
            digitava dinheiro no escuro.
          */}
          <div className="flex flex-col gap-0.5">
            <h2 className="text-[length:var(--gs-text-lg)] font-bold text-[var(--gs-purple-900)] m-0">
              {cash ? 'Caixa aberto' : 'Abrir caixa'}
            </h2>
            <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
              {session?.company.tradeName ?? '—'}
              {caixaDoComputador?.terminal ? ` · ${caixaDoComputador.terminal.name}` : ''} · Op.:{' '}
              {session?.user.displayName ?? '—'}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar"
            className="bg-transparent border-0 text-[var(--gs-muted)] text-xl cursor-pointer"
          >
            ✕
          </button>
        </header>

        <div className="p-6 flex flex-col gap-4">
          {aviso && (
            <p
              role="alert"
              data-testid="caixa-aviso-da-venda"
              className="m-0 text-[var(--gs-danger)] text-[length:var(--gs-text-sm)] font-semibold"
            >
              {aviso}
            </p>
          )}
          {erro && (
            <p role="alert" className="m-0 text-[var(--gs-danger)] text-[length:var(--gs-text-sm)]">
              {erro}
            </p>
          )}

          {/*
            O PAPEL DO FECHAMENTO (H-caixa-seguranca-11). Fica no topo, com o
            foco no botão, também depois de o PDV zerar `cash`: é o id guardado
            no clique de confirmar que diz de qual turno é o papel.
          */}
          {fechamentoParaImprimir && (
            <ImprimirFechamento
              key={fechamentoParaImprimir.sessionId}
              sessionId={fechamentoParaImprimir.sessionId}
              terminalId={fechamentoParaImprimir.terminalId}
              onSeguir={() => {
                setFechamentoParaImprimir(null);
                campoValor.current?.focus();
              }}
            />
          )}

          {precisaEscolherCaixa && onEscolherCaixa && (
            <EscolhaDoCaixa
              onEscolher={(id) => onEscolherCaixa(id)}
              recusado={caixaDoComputador?.terminalRecusado ?? null}
            />
          )}

          {caixaDoComputador?.terminal && (
            <LinhaDoCaixa
              nome={caixaDoComputador.terminal.name}
              fixo={Boolean(caixaDoComputador.terminalDoDispositivo)}
              // Trocar com a gaveta aberta não mexe nela: só faz este
              // computador olhar para outro caixa.
              onTrocar={onEscolherCaixa ? () => onEscolherCaixa(null) : undefined}
            />
          )}

          {/* A gaveta esquecida (GAP-PRD-131): o fechamento é logo abaixo. */}
          {cash && caixaDoComputador?.deOutroDia && (
            <AvisoGavetaDeOutroDia gaveta={caixaDoComputador.deOutroDia} />
          )}

          {/*
            O ATALHO QUE ABRIU ESTA TELA, nomeado — Ctrl+F3 (sangria) e
            Shift+F3 (suprimento). Sem esta linha o atalho seria indistinguível
            do F3 comum, e atalho que não muda nada visível é rótulo mentindo.
            Com o caixa ainda fechado, a ação pedida não existe — e a linha diz
            isso em vez de sumir.
          */}
          {acaoInicial && (
            <p
              role="status"
              data-testid="caixa-acao-do-atalho"
              className="m-0 text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-purple-800)]"
            >
              {cash
                ? acaoInicial === 'sangria'
                  ? 'Atalho de SANGRIA (Ctrl+F3): digite o valor e confirme no botão "Sangria".'
                  : 'Atalho de SUPRIMENTO (Shift+F3): digite o valor e confirme no botão "Suprimento".'
                : `Abra o caixa antes de registrar a ${acaoInicial}.`}
            </p>
          )}

          {cash && (
            <dl className="grid grid-cols-2 gap-2 m-0">
              <dt className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">Fundo de abertura</dt>
              <dd className="m-0 text-right">{formatCents(cash.opening_cents)}</dd>
              <dt className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                Esperado na gaveta
              </dt>
              <dd className="m-0 text-right font-semibold" data-testid="caixa-esperado">
                {esperado === null ? '—' : formatCents(esperado)}
              </dd>
              {/*
                O TETO ENTRA NA MESMA LISTA DO ESPERADO, e não numa faixa de
                aviso: aqui ele é FATO da operação, do lado dos outros números
                da gaveta, e é lido antes de a pessoa digitar qualquer coisa.
                Faixa de aviso é para o que está errado; isto é a regra.

                Só aparece quando existe. Operação sem teto não ganha uma linha
                dizendo "sem teto" — seria informar a ausência de uma trava que
                a pessoa não sabia que podia existir.
              */}
              {tetoSangriaCents !== null && (
                <>
                  <dt className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                    Sangria sem chamar gestor
                  </dt>
                  <dd className="m-0 text-right font-semibold" data-testid="caixa-teto-sangria">
                    até {formatCents(tetoSangriaCents)}
                  </dd>
                  {/* O teto é do turno: o que já saiu sem gestor conta. */}
                  {jaSangradoSemGestor > 0 && (
                    <>
                      <dt className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                        Já sangrado sem gestor neste turno
                      </dt>
                      <dd className="m-0 text-right font-semibold" data-testid="caixa-ja-sangrado">
                        {formatCents(jaSangradoSemGestor)}
                      </dd>
                    </>
                  )}
                </>
              )}
            </dl>
          )}

          {cash && trocoDoTurno > 0 && (
            <p
              data-testid="caixa-conta-do-dinheiro"
              className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]"
            >
              {/*
                A conta que faltava. Os dois números já estavam na tela e se
                contradiziam em silêncio; aqui eles viram uma frase só.
              */}
              Em espécie o cliente entregou <strong>{formatCents(entregueEmEspecie)}</strong> e
              {' '}saíram <strong>{formatCents(trocoDoTurno)}</strong> de troco — por isso a gaveta
              {' '}fica com <strong>{formatCents(entregueEmEspecie - trocoDoTurno)}</strong> das
              {' '}vendas, além do fundo de abertura.
            </p>
          )}

          {cash && (resumo?.movements.length ?? 0) > 0 && (
            <details data-testid="caixa-composicao" className="text-[length:var(--gs-text-sm)]">
              {/*
                DE ONDE VEIO O ESPERADO.

                O servidor sempre mandou os movimentos do turno e a tela
                guardava só dois números. "Esperado R$ 350" sem composição
                obriga a confiar ou a abrir outra tela — no exato momento em
                que a pessoa está com as notas na mão.

                Fechado por padrão: quem só quer conferir o total não precisa
                rolar uma lista, e quem quer conferir a origem tem um clique.
              */}
              <summary className="cursor-pointer text-[var(--gs-purple-800)] font-semibold">
                Como o esperado foi formado ({resumo?.movements.length} movimento(s))
              </summary>
              <ul className="list-none p-0 mt-2 mb-0 flex flex-col gap-1">
                {resumo?.movements.map((m, i) => (
                  <li key={i} className="flex justify-between gap-3">
                    <span className="text-[var(--gs-muted)]">
                      {m.note || rotuloDoMovimento(m.movement_type)}
                    </span>
                    <span
                      className={m.amount_cents < 0 ? 'text-[var(--gs-danger)]' : undefined}
                    >
                      {m.amount_cents < 0 ? '−' : '+'} {formatCents(Math.abs(m.amount_cents))}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          )}

          {semResumo && (
            <p role="alert" className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-warning)]">
              Não foi possível carregar o resumo do turno. Sem o esperado não dá para conferir a
              {' '}gaveta, e fechar não tem volta — tente de novo em instantes.
            </p>
          )}

          {!precisaEscolherCaixa && (<>
          <label className="flex flex-col gap-1">
            <span className="text-[length:var(--gs-text-sm)] font-semibold">
              {cash ? 'Valor' : 'Fundo de troco'}
            </span>
            <input
              ref={campoValor}
              autoFocus
              inputMode="decimal"
              aria-label={cash ? 'Valor' : 'Fundo de troco'}
              aria-invalid={mensagemDoValor ? true : undefined}
              aria-describedby={mensagemDoValor ? 'caixa-pdv-erro-do-valor' : undefined}
              value={valor}
              onChange={(e) => {
                setValor(e.target.value);
                setErroDoValor(null);
                /*
                  MEXEU NO VALOR, A PERGUNTA DO FECHAMENTO CAI (H-caixa-seguranca-01).

                  O DEFEITO: com a confirmação na tela, apagar o campo deixava
                  "Confirmar fechamento" ativo e o envio ia com `centavos ?? 0` —
                  o turno fechava com contagem ZERO, a gaveta inteira registrada
                  como falta, sem ninguém ter contado. É a mesma regra da tela de
                  Caixa da gestão: número novo, pergunta nova.
                */
                setConfirmandoFechamento(false);
              }}
              onKeyDown={aoTeclarNoCampo}
              placeholder="0,00"
              className="px-3 py-2 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)]
                text-[length:var(--gs-text-lg)]"
            />
            {mensagemDoValor && (
              <span
                id="caixa-pdv-erro-do-valor"
                role="alert"
                data-testid="caixa-erro-do-valor"
                className="text-[length:var(--gs-text-sm)] text-[var(--gs-danger)]"
              >
                {mensagemDoValor}
              </span>
            )}
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-[length:var(--gs-text-sm)] font-semibold">
              {cash ? 'Motivo / observação (obrigatório na sangria)' : 'Observação'}
            </span>
            <input
              aria-label={cash ? 'Motivo (obrigatório na sangria)' : 'Observação'}
              value={nota}
              onChange={(e) => setNota(e.target.value)}
              onKeyDown={aoTeclarNoCampo}
              placeholder={cash ? 'Ex.: depósito no banco, pagamento do fornecedor' : undefined}
              className="px-3 py-2 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)]"
            />
          </label>
          </>)}

          {cash && diferenca !== null && (
            <p
              data-testid="caixa-diferenca"
              className={`m-0 text-[length:var(--gs-text-sm)] font-semibold ${
                diferenca === 0 ? 'text-[var(--gs-success)]' : 'text-[var(--gs-warning)]'
              }`}
            >
              {diferenca === 0
                ? 'Conferido: o contado bate com o esperado.'
                : diferenca > 0
                  ? `Sobra de ${formatCents(diferenca)} em relação ao esperado.`
                  : `Falta ${formatCents(Math.abs(diferenca))} em relação ao esperado.`}
            </p>
          )}

          {/*
            O AVISO DO TETO, enquanto ainda dá para mudar o valor.

            Aparece com o número já digitado e antes de qualquer clique: é o
            momento em que a pessoa ainda pode retirar menos, ou já ir chamar o
            gerente em vez de descobrir depois que precisa dele.

            Para quem TEM alçada este bloco não existe — nem como aviso, nem
            como pedido. O servidor deixa esses perfis passarem, e um alerta
            sobre uma trava que não os alcança é a definição de ruído.
          */}
          {cash && sangriaPedeGestor && tetoSangriaCents !== null && (
            <p
              role="status"
              data-testid="caixa-sangria-acima-do-teto"
              className="m-0 text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-warning)]"
            >
              Sangria de {formatCents(centavos ?? 0)}
              {jaSangradoSemGestor > 0
                ? `, somada a ${formatCents(jaSangradoSemGestor)} já sangrados sem gestor neste turno,`
                : ''}{' '}
              passa do teto de {formatCents(tetoSangriaCents)} desta operação. Ao confirmar, um gestor
              precisa digitar a credencial dele aqui — ou retire um valor menor.
            </p>
          )}

          {/*
            Quem tem alçada passa, e a tela diz o que isso significa: não é que
            a trava sumiu, é que ela não é sobre ele. O movimento continua
            gravado com o nome de quem lançou, e a conferência do fechamento
            compara esperado e contado do mesmo jeito.
          */}
          {cash && passaDoTeto && temAlcada && tetoSangriaCents !== null && (
            <p
              role="status"
              data-testid="caixa-sangria-alcada-propria"
              className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]"
            >
              Acima do teto de {formatCents(tetoSangriaCents)}, mas seu perfil libera sozinho. A
              retirada fica gravada no seu nome.
            </p>
          )}

          {/* Troco e conferência: a gaveta por comando, só com o agente do caixa no ar (GAP-PRD-082). */}
          {cash && <AbrirGavetaPorComando terminalId={cash.terminal_id ?? null} />}

          {cash && naFila > 0 && (
            <p
              role="alert"
              data-testid="caixa-fila-offline"
              className="m-0 text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-danger)]"
            >
              {naFila} venda(s) guardada(s) neste computador ainda não subiram para o servidor. Envie pela barra do
              topo antes de fechar: fechada a gaveta, o servidor recusa a venda deste turno.
            </p>
          )}

          {cash && deOutraOperacao > 0 && (
            <p
              role="status"
              data-testid="caixa-fila-de-outra-operacao"
              className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]"
            >
              {deOutraOperacao} venda(s) de outra operação guardada(s) neste computador. Elas sobem quando alguém
              voltar àquela operação, e não impedem fechar esta gaveta.
            </p>
          )}

          {cash && deOutraGaveta > 0 && (
            <p
              role="status"
              data-testid="caixa-fila-de-outra-gaveta"
              className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]"
            >
              {deOutraGaveta} venda(s) guardada(s) de outra gaveta desta operação (turno anterior ou outro caixa). Não
              são desta gaveta e não impedem fechá-la.
            </p>
          )}

          {cash && centavos !== null && centavos > 0 && sangriaSemMotivo && (
            <p
              data-testid="caixa-sangria-sem-motivo"
              className="m-0 text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]"
            >
              Para a sangria, escreva o motivo (ex.: depósito no banco): é o que o gestor confere no fechamento.
            </p>
          )}

          {cash && vendasEmEspera > 0 && (
            <p role="status" className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-warning)]">
              {vendasEmEspera} venda(s) em espera. Fechar o caixa agora descarta esses carrinhos —
              retome ou cancele antes.
            </p>
          )}

          {cash && temPendencia && pendencias && (
            <PendenciasDoFechamento
              idBase="caixa-pdv"
              pendencias={pendencias}
              ciente={pendCiente}
              motivo={pendMotivo}
              onCiente={setPendCiente}
              onMotivo={setPendMotivo}
            />
          )}

          {confirmandoFechamento && (
            <div
              role="alertdialog"
              aria-label="Confirmar fechamento do turno"
              data-testid="caixa-confirmar-fechamento"
              className="rounded-[var(--gs-radius)] border border-[var(--gs-danger)]
                bg-[var(--gs-danger-bg)] px-4 py-3 flex flex-col gap-2"
            >
              {/*
                O ÚNICO BOTÃO DESTA TELA QUE NÃO TEM VOLTA.

                Fechado o turno, não há reabrir: o contado vira fato e a
                diferença fica registrada. E ele mora na mesma linha do
                Suprimento e da Sangria, alimentado pelo MESMO campo de valor —
                um dedo no lugar errado encerra o dia.
              */}
              <p className="m-0 text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-danger)]">
                Fechar o turno não tem volta.
              </p>
              <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-text)]">
                Contado <strong>{formatCents(centavos ?? 0)}</strong> contra o esperado
                {' '}<strong>{esperado === null ? '—' : formatCents(esperado)}</strong>
                {diferenca !== null && diferenca !== 0 && (
                  <>
                    {' '}({diferenca > 0 ? 'sobra' : 'falta'}{' '}
                    {formatCents(Math.abs(diferenca))})
                  </>
                )}
                .
              </p>
              <div className="flex flex-wrap gap-2 justify-end">
                <button
                  type="button"
                  onClick={() => setConfirmandoFechamento(false)}
                  className="bg-transparent border border-[var(--gs-border-strong)]
                    rounded-[var(--gs-radius)] px-4 py-2 cursor-pointer"
                >
                  Voltar
                </button>
                <button
                  type="button"
                  disabled={
                    ocupado
                    || centavos === null
                    || (temPendencia && !cienciaCompleta(pendCiente, pendMotivo))
                  }
                  onClick={() => {
                    if (!cash) return;
                    /*
                      A CONTAGEM VAI COMO FOI DIGITADA — nunca `?? 0`
                      (H-caixa-seguranca-01, as duas telas). Sem número no campo
                      não há o que confirmar: a pergunta cai e o campo diz o que
                      falta. O servidor recusa do mesmo jeito
                      (`CORE_CASH_COUNT_REQUIRED`).
                    */
                    if (centavos === null) {
                      setConfirmandoFechamento(false);
                      setErroDoValor(
                        'Digite quanto foi contado na gaveta para fechar o turno (0,00 se ela foi esvaziada).',
                      );
                      campoValor.current?.focus();
                      return;
                    }
                    const contado = centavos;
                    // O turno e o caixa dele, guardados AGORA: quando o
                    // fechamento voltar, o PDV já terá zerado `cash`.
                    const turnoQueFecha = {
                      sessionId: cash.id,
                      terminalId: cash.terminal_id ?? caixaDoComputador?.terminal?.id ?? null,
                    };
                    void executar(async () => {
                      try {
                        await coreApi.closeCash(
                          turnoQueFecha.sessionId,
                          contado,
                          nota || undefined,
                          temPendencia ? { ciente: pendCiente, motivo: pendMotivo } : undefined,
                        );
                      } catch (err) {
                        // O servidor viu pendência que o resumo ainda não tinha
                        // (GAP-PRD-081): vale a lista dele, e a ciência é pedida.
                        const p = pendenciasDoErro(err);
                        if (p) setPendDoServidor(p);
                        throw err;
                      }
                      setConfirmandoFechamento(false);
                      // Fechou de verdade: o papel para assinar (H-caixa-seguranca-11).
                      setFechamentoParaImprimir(turnoQueFecha);
                      return null;
                    }, FECHAMENTO_NAO_GRAVADO, true);
                  }}
                  className="bg-[var(--gs-danger)] text-white border-0 rounded-[var(--gs-radius)]
                    px-4 py-2 cursor-pointer font-semibold disabled:opacity-50"
                >
                  {ocupado ? 'Fechando…' : 'Confirmar fechamento'}
                </button>
              </div>
            </div>
          )}

          <div className="flex flex-wrap gap-2 justify-end">
            {!cash && !precisaEscolherCaixa && (
              <button
                type="button"
                disabled={ocupado || centavos === null}
                onClick={() => void abrirCaixa()}
                className="bg-[var(--gs-purple-700)] text-white border-0 rounded-[var(--gs-radius)]
                  px-4 py-2 cursor-pointer font-semibold disabled:opacity-50"
              >
                {ocupado ? 'Abrindo…' : 'Abrir caixa'}
              </button>
            )}

            {cash && (
              <>
                <button
                  type="button"
                  disabled={ocupado || !centavos}
                  onClick={suprir}
                  className={`border rounded-[var(--gs-radius)] px-4 py-2 cursor-pointer disabled:opacity-50 ${
                    // O botão que o atalho pediu fica marcado — é para ele que
                    // a linha de status aponta.
                    acaoInicial === 'suprimento'
                      ? 'bg-[var(--gs-purple-100)] border-[var(--gs-purple-700)] font-semibold'
                      : 'bg-transparent border-[var(--gs-border-strong)]'
                  }`}
                >
                  Suprimento
                </button>

                {/*
                  Fora do `executar` genérico de propósito: a sangria é a única
                  ação daqui que pode terminar pedindo uma senha em vez de
                  terminar em erro, e o `executar` só sabe dois desfechos. Ver
                  `sangrar`.
                */}
                <button
                  type="button"
                  disabled={ocupado || !centavos || sangriaSemMotivo}
                  onClick={aoClicarSangria}
                  className={`border rounded-[var(--gs-radius)] px-4 py-2 cursor-pointer disabled:opacity-50 ${
                    acaoInicial === 'sangria'
                      ? 'bg-[var(--gs-purple-100)] border-[var(--gs-purple-700)] font-semibold'
                      : 'bg-transparent border-[var(--gs-border-strong)]'
                  }`}
                >
                  {sangriaPedeGestor ? 'Sangria (pede gestor)' : 'Sangria'}
                </button>

                <button
                  type="button"
                  disabled={ocupado || centavos === null || semResumo || naFila > 0}
                  onClick={() => setConfirmandoFechamento(true)}
                  className="bg-[var(--gs-danger)] text-white border-0 rounded-[var(--gs-radius)]
                    px-4 py-2 cursor-pointer font-semibold disabled:opacity-50"
                >
                  {ocupado ? 'Fechando…' : 'Fechar caixa'}
                </button>
              </>
            )}
          </div>

          {cash && resumo && resumo.byMethod.length > 0 && (
            <section className="border-t border-[var(--gs-border)] pt-3">
              <h3 className="text-[length:var(--gs-text-sm)] font-semibold m-0 mb-2">
                Recebido no turno, por meio
              </h3>
              <ul className="list-none p-0 m-0 flex flex-col gap-1">
                {/*
                  O MEIO PELO NOME, COMO NO PAPEL (PED-caixa-01). A lista mostrava
                  o código do banco — "debito", "crediario" — enquanto o papel do
                  fechamento, na mão do mesmo operador, diz "Cartão de débito". O
                  rótulo é o mesmo do comprovante (`rotuloDoMeio`), e o código
                  que ninguém mapeou aparece como veio, em vez de sumir.
                */}
                {resumo.byMethod.map((m) => (
                  <li key={m.method} className="flex justify-between text-[length:var(--gs-text-sm)]">
                    <span className="text-[var(--gs-muted)]">{rotuloDoMeio(m.method)}</span>
                    <span>{formatCents(m.total)}</span>
                  </li>
                ))}
              </ul>
              {/* Só o dinheiro está na gaveta. Cartão e PIX entram na conta, e
                  somá-los ao esperado faria toda conferência acusar sobra. */}
              <p className="text-[length:var(--gs-text-xs)] text-[var(--gs-muted)] mt-2 mb-0">
                O esperado na gaveta considera apenas dinheiro — cartão e PIX caem na conta.
              </p>
            </section>
          )}
        </div>
      </div>

      {/*
        O MESMO diálogo do PDV, e não um segundo parecido.

        `AutorizacaoGerenteDialog` já resolve o que é delicado aqui: foco no
        campo certo, senha que não sobrevive ao fechamento do modal, botão
        travado enquanto a credencial vai e volta. Um clone teria de acertar as
        três de novo, e a segunda cópia é onde uma delas se perde — a senha
        ficando em memória é o tipo de detalhe que ninguém revisa duas vezes.

        Ele monta DENTRO deste modal, por cima. É o mesmo gesto do balcão: o
        gerente chega, digita, e a sangria continua de onde parou, sem que o
        operador perca o valor que já tinha digitado.
      */}
      {sangriaPendente && (
        <AutorizacaoGerenteDialog
          motivo={
            `Sangria de ${formatCents(sangriaPendente.centavos)}`
            + (tetoSangriaCents !== null
              ? `, acima do teto de ${formatCents(tetoSangriaCents)} desta operação.`
              : '.')
            + ' A credencial precisa ser de um gestor — ninguém autoriza a própria retirada.'
          }
          busy={autorizando || ocupado}
          error={autorizacaoErro}
          onCancel={() => {
            setSangriaPendente(null);
            setAutorizacaoErro(null);
          }}
          onConfirm={(login, password) => void confirmarLiberacaoDaSangria(login, password)}
        />
      )}
    </div>
  );
}
