/**
 * ============================================================================
 * REGULARIZAR A VENDA GUARDADA QUE O SERVIDOR RECUSOU (GAP-PRD-045 / 046)
 * ============================================================================
 *
 * A venda foi feita com o servidor da loja fora, o dinheiro foi recebido, e
 * quando o servidor voltou ele recusou o reenvio — o caixa daquele turno já
 * tinha fechado, ou o estoque acabou. Antes, a venda ficava presa no
 * navegador daquele caixa, e o único caminho era o desenvolvedor.
 *
 * Aqui qualquer caixa da operação (e o gestor) vê a venda e a RELANÇA — com a
 * mesma chave, então relançar duas vezes não vende duas. O gerente pode
 * DESCARTAR, com motivo, quando a venda não vai existir. Quando a recusa é
 * estoque, a tela diz o produto e aponta a entrada de estoque: a mercadoria já
 * saiu com o cliente.
 *
 * ## A gaveta é a do dinheiro, e não a de quem clica (G-offline-sync-10)
 *
 * O relançamento ia sempre para a gaveta aberta DESTE computador: o operador do
 * Caixa 2 relançava a venda do Caixa 1 e ela entrava na gaveta do Caixa 2 —
 * sobra num fechamento, falta no outro. Agora o servidor diz onde o dinheiro
 * está (`gavetaDeDestino`: a gaveta da venda ainda aberta, ou a aberta do
 * mesmo caixa) e o relançamento entra nela, de qualquer computador — inclusive
 * do escritório, sem gaveta nenhuma. Só sem essa gaveta vale a deste
 * computador, e sendo de outro caixa o servidor pede confirmação, que o cartão
 * mostra com a sobra e a falta ditas.
 *
 * ## A recusa por alçada tem saída (G-offline-sync-11)
 *
 * Sem servidor, o PDV não tinha como pedir a liberação do desconto; no
 * reenvio, o 403 virava pendência, e aqui não havia como liberar. O cartão da
 * recusa por alçada pede a liberação do gestor ali mesmo e relança com ela.
 *
 * ## A chave que já registrou outra venda (RES-IDEM-TELA)
 *
 * Se a tentativa guardada usava a chave de uma venda que o servidor JÁ tinha
 * registrado com outros itens (a #N), relançar com a mesma chave é recusado
 * para sempre (422 CORE_IDEMPOTENCY_KEY_REUSED). O cartão diz isso na língua de
 * quem regulariza — o que a #N registrou, e que esta é OUTRA venda — e troca o
 * botão que nunca passa por "Relançar como venda nova": o servidor faz a venda
 * da pendência com chave própria, na gaveta aberta, e a #N continua como está.
 * Se a #N era este mesmo atendimento antes de o carrinho mudar, a tela manda
 * cancelar a #N antes — registrar em dobro não acontece por clique distraído.
 *
 * ## O preço que baixou depois da venda (G-offline-sync-08)
 *
 * A venda sem servidor cobrou no cartão o preço que a tela conhecia; quando o
 * servidor voltou, o preço tinha baixado, e ele recusava com 409
 * `CORE_SALE_TOTAL_CHANGED` (cartão passado a mais não vira troco). Aqui o
 * relançamento repetia o mesmo corpo e tomava a mesma recusa, sem saída. Agora
 * o cartão mostra, com as linhas que o servidor apontou, o preço da venda, o de
 * hoje e a diferença, e oferece duas saídas: relançar pelo preço de agora
 * (devolvendo a diferença ao cliente) ou — a gerência — manter o valor cobrado,
 * com a diferença lançada como acréscimo. Quem faz a conta é o servidor, e a
 * decisão fica escrita na pendência.
 */
import { useCallback, useEffect, useState } from 'react';
import { prenderFoco } from './armadilhaDeFoco';
import { formatCents } from '@/components/gs/format';
import { useHasProfile, useSession } from '@/hooks/useSession';
import { ApiRequestError } from '@/lib/api/client';
import { coreApi } from '@/lib/api/core';
import { codigoDaVendaGuardada } from '@/lib/api/offlineQueue';
import { caixaDesteComputador } from '@/lib/api/terminais';
import {
  vendasOfflineApi,
  type ModoDoAjusteDePreco,
  type PedidoDeRelancamento,
  type RespostaDoRelancamento,
  type VendaOfflineRecusada,
} from '@/lib/api/vendasOffline';
import { destinoDaOrigem } from '@/lib/rotasDeOrigem';
import { environmentOf } from '@/router/environments';

function quando(iso: string | null): string {
  if (!iso) return 'hora não registrada';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? 'hora não registrada' : d.toLocaleString('pt-BR');
}

/** A frase do erro do produto inativado aponta Produtos — o cartão põe o link ao lado (só na gestão). */
const APONTA_PRODUTOS = 'reative o produto em Produtos';

/**
 * O PRODUTO INATIVADO DEPOIS DA VENDA DIZ QUAL É E O QUE FAZER (G-offline-sync-09).
 *
 * O DEFEITO: a recusa do relançamento subia com o texto do BALCÃO — "Tire a
 * linha do carrinho —" — numa tela em que não há carrinho: a venda já
 * aconteceu, a mercadoria já saiu. E o servidor anterior dizia só o UUID. O
 * caixa lia uma instrução impossível e não sabia que descartar era a outra
 * saída. Agora a frase é desta tela: o nome (do `details.name` do servidor, ou
 * da linha da própria venda), reativar em Produtos e relançar — ou descartar,
 * dito para quem pode (a gerência) e para quem precisa pedir (o caixa).
 */
function mensagemDoErro(err: unknown, venda: VendaOfflineRecusada, podeDescartar: boolean): string {
  if (err instanceof ApiRequestError) {
    if (err.code === 'CORE_INSUFFICIENT_STOCK') {
      const produtoId = (err.details as { productId?: string } | undefined)?.productId;
      const nome = venda.items.find((i) => i.productId === produtoId)?.name ?? 'um dos produtos';
      return (
        `Sem estoque de ${nome} para relançar. A mercadoria já saiu com o cliente: lance a entrada que `
        + 'faltou em Estoque › Movimentações (motivo: venda feita sem servidor) e relance.'
      );
    }
    if (err.code === 'CORE_PRODUCT_NOT_FOUND') {
      const d = err.details as { productId?: unknown; name?: unknown; inativo?: unknown } | undefined;
      const produtoId = typeof d?.productId === 'string' ? d.productId : null;
      const daVenda = venda.items.find((i) => i.productId === produtoId)?.name ?? null;
      const nome = typeof d?.name === 'string' && d.name.trim() ? d.name : daVenda;
      const descarte = podeDescartar
        ? 'Se a venda não vai existir, descarte-a com o motivo.'
        : 'Se a venda não vai existir, peça a um gerente para descartá-la.';
      if (d?.inativo === true) {
        return (
          `${nome ? `"${nome}"` : 'Um dos produtos desta venda'} foi inativado em Produtos depois desta venda (ele ou o `
          + 'modelo da grade dele) e o servidor não vende produto inativo. A mercadoria já saiu com o cliente: '
          + `${APONTA_PRODUTOS} e relance. ${descarte}`
        );
      }
      // REVISÃO — O DEFEITO: sem `details` nenhum (recusa sem o detalhe, de um
      // servidor fora de passo com esta tela), a frase afirmava "não tem como
      // ser relançada" — e o produto podia estar só inativado, com a venda de
      // dinheiro já recebido empurrada para o descarte. Sem o sinal do servidor,
      // a tela diz os dois casos e não decide por ele.
      if (!produtoId) {
        return (
          'Um produto desta venda não foi encontrado pelo servidor. Se ele foi inativado, '
          + `${APONTA_PRODUTOS} e relance; se saiu do cadastro, a venda não tem como ser relançada. ${descarte}`
        );
      }
      // Sem o cadastro (o produto foi excluído): relançar nunca vai passar.
      return (
        `${nome ? `"${nome}"` : 'Um dos produtos desta venda'} não existe mais no cadastro desta operação, e esta venda `
        + `não tem como ser relançada. ${descarte}`
      );
    }
    return err.message;
  }
  return 'Não foi possível falar com o servidor. Tente de novo.';
}

/** O que se sabe da venda que a chave desta pendência já registrou. */
interface ChaveReusada {
  id: string | null;
  number: number | null;
  totalCents: number | null;
  status: string | null;
  items: { description: string; quantity: number }[];
}

/** A recusa de alçada do relançamento: o que o gestor vai liberar. */
interface PedidoDeLiberacao {
  mensagem: string;
  concedidoCents?: number;
  brutoCents?: number;
}

/** A recusa pelo preço que baixou depois da venda (G-offline-sync-08): as linhas que o servidor apontou. */
interface PrecoMudou {
  mensagem: string;
  linhas: { productId: string; name: string | null; informadoCents: number; vigenteCents: number }[];
}

function precoMudouDaRecusa(err: ApiRequestError): PrecoMudou {
  const d = err.details as { linhas?: unknown } | undefined;
  const linhas = (Array.isArray(d?.linhas) ? d.linhas : []) as Record<string, unknown>[];
  return {
    mensagem: err.message,
    linhas: linhas.map((l) => ({
      productId: String(l?.productId ?? ''),
      name: typeof l?.name === 'string' ? l.name : null,
      informadoCents: Number(l?.informadoCents ?? 0),
      vigenteCents: Number(l?.vigenteCents ?? 0),
    })),
  };
}

/**
 * Quanto a venda sai mais barata pelo preço de agora — a mesma conta do
 * servidor (preço × quantidade de cada linha, arredondado). Só para mostrar:
 * o valor que vale é o que o servidor devolve no relançamento.
 */
function diferencaDoPreco(v: VendaOfflineRecusada, preco: PrecoMudou): number {
  const usadas = new Set<number>();
  return preco.linhas.reduce((soma, l) => {
    const k = v.items.findIndex(
      (i, n) => !usadas.has(n) && i.productId === l.productId && i.unitPriceCents === l.informadoCents,
    );
    if (k >= 0) usadas.add(k);
    const q = k >= 0 ? v.items[k].quantity : 1;
    return soma + Math.max(0, Math.round(l.informadoCents * q) - Math.round(l.vigenteCents * q));
  }, 0);
}

function PrecoMudouNoCartao({
  venda,
  preco,
  podeManter,
  ocupado,
  onEscolher,
}: {
  venda: VendaOfflineRecusada;
  preco: PrecoMudou;
  podeManter: boolean;
  ocupado: boolean;
  onEscolher: (modo: ModoDoAjusteDePreco) => void;
}) {
  const diferenca = diferencaDoPreco(venda, preco);
  return (
    <div
      data-testid="preco-mudou"
      className="flex flex-col gap-2 px-3 py-2 rounded-[var(--gs-radius)] bg-[var(--gs-warning-bg,var(--gs-canvas))] text-[length:var(--gs-text-sm)]"
    >
      <strong>O preço baixou depois desta venda, e o servidor cobra o preço de agora.</strong>
      {preco.linhas.length > 0 && (
        <ul className="m-0 pl-5">
          {preco.linhas.map((l, n) => (
            <li key={`${l.productId}-${n}`}>
              {l.name ?? 'Item'}: vendido a {formatCents(l.informadoCents)}, hoje {formatCents(l.vigenteCents)}
            </li>
          ))}
        </ul>
      )}
      <span>
        O cliente pagou {formatCents(venda.receivedCents)}. Pelo preço de agora esta venda fica{' '}
        {formatCents(diferenca)} mais barata. Escolha como relançar — a decisão fica registrada na venda guardada.
      </span>
      <div className="flex flex-wrap gap-2 justify-end">
        <button
          type="button"
          disabled={ocupado}
          onClick={() => onEscolher('preco_de_agora')}
          className="bg-[var(--gs-purple-700)] text-white border-0 rounded-[var(--gs-radius)] px-3 py-1.5 cursor-pointer font-semibold disabled:opacity-50"
        >
          Relançar pelo preço de agora (devolver {formatCents(diferenca)} ao cliente)
        </button>
        {podeManter && (
          <button
            type="button"
            disabled={ocupado}
            onClick={() => onEscolher('manter_o_cobrado')}
            className="bg-transparent border border-[var(--gs-border-strong)] rounded-[var(--gs-radius)] px-3 py-1.5 cursor-pointer font-semibold disabled:opacity-50"
          >
            Manter o valor cobrado (acréscimo de {formatCents(diferenca)})
          </button>
        )}
      </div>
      {!podeManter && (
        <span className="text-[var(--gs-text-soft)]">
          Manter o valor cobrado, lançando a diferença como acréscimo, é decisão da gerência: peça a um gerente para
          relançar esta venda por aqui.
        </span>
      )}
    </div>
  );
}

/**
 * A pendência é de chave reusada? O servidor diz por `vendaDaChave`, olhando a
 * chave AGORA. A recusa que o relançamento acabou de receber (com o número da
 * venda no detalhe) é mais fresca que a lista e vale sempre. O código gravado
 * da recusa só serve de pista quando o servidor NÃO manda o campo (servidor
 * anterior, `undefined`): com `null` ele disse que a chave não tem venda de
 * outra mercadoria, e explicar "chave reusada" ali escondia o relançamento
 * comum atrás de um "como venda nova" que o servidor recusa (R2-IDEM).
 */
function chaveReusadaDe(v: VendaOfflineRecusada, doRelancamento: ChaveReusada | undefined): ChaveReusada | null {
  if (v.vendaDaChave) return { ...v.vendaDaChave };
  if (doRelancamento) return doRelancamento;
  if (v.vendaDaChave === undefined && v.errorCode === 'CORE_IDEMPOTENCY_KEY_REUSED') {
    return { id: null, number: null, totalCents: null, status: null, items: [] };
  }
  return null;
}

function ExplicacaoDaChaveReusada({ reusada, podeAbrirVendas }: { reusada: ChaveReusada; podeAbrirVendas: boolean }) {
  const qual = reusada.number ? `a venda #${reusada.number}` : 'outra venda';
  const aVenda = reusada.number ? `a #${reusada.number}` : 'essa venda';
  const destino = reusada.id ? destinoDaOrigem('sale', reusada.id) : null;
  return (
    <div
      data-testid="explicacao-chave-reusada"
      className="flex flex-col gap-1 px-3 py-2 rounded-[var(--gs-radius)] bg-[var(--gs-warning-bg,var(--gs-canvas))] text-[length:var(--gs-text-sm)]"
    >
      <strong>Esta tentativa já registrou {qual}, com outros itens.</strong>
      {reusada.items.length > 0 && (
        <span>
          {reusada.number ? `A #${reusada.number}` : 'Ela'} registrou:{' '}
          {reusada.items.map((i) => `${i.quantity}× ${i.description}`).join(', ')}
          {reusada.totalCents !== null && ` — ${formatCents(reusada.totalCents)}`}
          {reusada.status === 'cancelled' && ' (cancelada)'}.
        </span>
      )}
      <span>
        Relançar com a mesma chave nunca vai passar: esta é OUTRA venda. Se o cliente levou as duas, relance esta
        como venda nova — {aVenda} continua como está. Se {aVenda} era este mesmo atendimento antes de o carrinho
        mudar, peça ao gerente para cancelar {aVenda} e só depois relance esta como venda nova.
      </span>
      {podeAbrirVendas && destino && (
        <a href={destino} className="underline self-start">
          Ver {aVenda} em Vendas
        </a>
      )}
    </div>
  );
}

/** Onde o dinheiro da venda está, dito no cartão. */
function ondeEstaODinheiro(v: VendaOfflineRecusada): string | null {
  const g = v.gavetaDeDestino;
  if (!g) return null;
  const gaveta = g.terminalName ? `na gaveta do ${g.terminalName}` : 'na gaveta em que ela foi feita';
  const comoEsta = g.motivo === 'mesmo_caixa' ? ', aberta de novo no mesmo caixa' : ', que continua aberta';
  return `O dinheiro desta venda está ${gaveta}${comoEsta}: o relançamento entra nela, de qualquer computador.`;
}

export function RegularizarVendasOffline({
  onClose,
  onMudou,
}: {
  onClose: () => void;
  onMudou?: () => void;
}) {
  const sessao = useSession();
  const podeDescartar = useHasProfile('gerente_loja', 'gerente_oficina');
  // A tela de Vendas é do escritório: o caixa no PDV seria devolvido para casa.
  const podeAbrirVendas = environmentOf(sessao?.user?.profileCode) === 'gestao';
  const [vendas, setVendas] = useState<VendaOfflineRecusada[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [descartando, setDescartando] = useState<string | null>(null);
  const [motivo, setMotivo] = useState('');
  const [erroDaVenda, setErroDaVenda] = useState<Record<string, string>>({});
  /** A recusa de chave reusada que o relançamento comum recebeu, por pendência. */
  const [reusadaNoRelancamento, setReusadaNoRelancamento] = useState<Record<string, ChaveReusada>>({});
  /** A gaveta de outro caixa que o servidor pede para confirmar, por pendência. */
  const [outraGaveta, setOutraGaveta] = useState<Record<string, string>>({});
  /** A recusa de alçada que o relançamento recebeu, por pendência. */
  const [liberacao, setLiberacao] = useState<Record<string, PedidoDeLiberacao>>({});
  const [liberando, setLiberando] = useState<string | null>(null);
  const [loginDoGestor, setLoginDoGestor] = useState('');
  const [senhaDoGestor, setSenhaDoGestor] = useState('');
  const [erroDaLiberacao, setErroDaLiberacao] = useState<string | null>(null);
  /** A recusa pelo preço que baixou, com as linhas do servidor, por pendência (G-offline-sync-08). */
  const [precoMudou, setPrecoMudou] = useState<Record<string, PrecoMudou>>({});
  /**
   * O que já foi escolhido para cada pendência — a gaveta de outro caixa
   * confirmada, o ajuste de preço. A recusa seguinte (a alçada, depois da
   * gaveta; o preço, depois da alçada) não pode fazer o próximo clique
   * esquecer o que a pessoa já decidiu. A liberação do gestor é de uso único e
   * fica de fora.
   */
  const [escolhas, setEscolhas] = useState<
    Record<string, { confirmarOutraGaveta?: boolean; ajusteDePreco?: ModoDoAjusteDePreco }>
  >({});
  // Manter o valor cobrado lança acréscimo sobre o preço anunciado: gerência — o
  // MESMO recorte de quem descarta (a catraca das guardas legadas não aceita uma
  // segunda chamada de perfil nesta tela).
  const podeManterOCobrado = podeDescartar;

  const carregar = useCallback(async () => {
    setErro(null);
    try {
      setVendas(await vendasOfflineApi.listar('pendente'));
    } catch (err) {
      setVendas([]);
      setErro(err instanceof ApiRequestError ? err.message : 'Não foi possível carregar as vendas guardadas.');
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const relancar = useCallback(
    async (
      venda: VendaOfflineRecusada,
      comoVendaNova: boolean,
      extrasDoClique: {
        confirmarOutraGaveta?: boolean;
        authorizationId?: string;
        ajusteDePreco?: ModoDoAjusteDePreco;
      } = {},
    ) => {
      const extras = { ...escolhas[venda.id], ...extrasDoClique };
      setEscolhas((m) => ({
        ...m,
        [venda.id]: { confirmarOutraGaveta: extras.confirmarOutraGaveta, ajusteDePreco: extras.ajusteDePreco },
      }));
      setOcupado(venda.id);
      setAviso(null);
      setErroDaVenda((m) => ({ ...m, [venda.id]: '' }));
      try {
        let alvo: { cashSessionId: string | null; terminalId: string | null };
        if (venda.gavetaDeDestino) {
          // A gaveta onde o dinheiro está está aberta: o servidor relança
          // nela, venha o pedido de onde vier — não precisa de gaveta aqui.
          alvo = {
            cashSessionId: venda.gavetaDeDestino.cashSessionId,
            terminalId: venda.gavetaDeDestino.terminalId,
          };
        } else {
          // Sem ela, a gaveta ABERTA deste computador — nunca a do turno que fechou.
          const terminalId = caixaDesteComputador(sessao?.company?.id);
          const caixa = await coreApi.getOpenCash(terminalId);
          if (!caixa.session) {
            setErroDaVenda((m) => ({
              ...m,
              [venda.id]:
                'Não há gaveta aberta neste computador, e a gaveta em que a venda foi feita já fechou. Abra o '
                + 'caixa (F3 no PDV) — de preferência o caixa em que a venda foi feita — e relance.',
            }));
            return;
          }
          alvo = {
            cashSessionId: caixa.session.id,
            terminalId: caixa.terminal?.id ?? caixa.session.terminal_id ?? terminalId ?? null,
          };
        }
        const pedido: PedidoDeRelancamento = {
          ...alvo,
          ...(extras.confirmarOutraGaveta ? { confirmarOutraGaveta: true } : {}),
          ...(extras.authorizationId ? { authorizationId: extras.authorizationId } : {}),
          ...(extras.ajusteDePreco ? { ajusteDePreco: extras.ajusteDePreco } : {}),
        };
        // O ajuste de preço aplicado vem dito pelo servidor, com o valor a
        // devolver ou o acréscimo — é o que o caixa faz a seguir.
        const doAjuste = (r: RespostaDoRelancamento) =>
          r.ajusteDePreco ? ` ${r.ajusteDePreco.frase} A decisão ficou registrada na venda guardada.` : '';
        if (comoVendaNova) {
          const r = await vendasOfflineApi.relancarComoVendaNova(venda.id, pedido);
          const daChave = venda.vendaDaChave?.number ?? reusadaNoRelancamento[venda.id]?.number ?? null;
          setAviso(
            (r.duplicated
              ? `A venda nova desta pendência já existia no servidor (#${r.sale.number}): nada foi vendido de novo.`
              : `Venda #${r.sale.number} registrada como venda nova — ${formatCents(r.sale.total_cents)} na gaveta `
                + `aberta.${daChave ? ` A venda #${daChave} continua como está.` : ''}`) + doAjuste(r),
          );
        } else {
          const r = await vendasOfflineApi.relancar(venda.id, pedido);
          setAviso(
            (r.duplicated
              ? `A venda já existia no servidor (#${r.sale.number}): nada foi vendido de novo.`
              : `Venda #${r.sale.number} relançada — ${formatCents(r.sale.total_cents)} na gaveta aberta.`)
              + doAjuste(r),
          );
        }
        setOutraGaveta((m) => ({ ...m, [venda.id]: '' }));
        setLiberacao((m) => {
          const { [venda.id]: _feita, ...resto } = m;
          return resto;
        });
        setPrecoMudou((m) => {
          const { [venda.id]: _feito, ...resto } = m;
          return resto;
        });
        setEscolhas((m) => {
          const { [venda.id]: _feitas, ...resto } = m;
          return resto;
        });
        onMudou?.();
        await carregar();
      } catch (err) {
        if (err instanceof ApiRequestError && err.code === 'CORE_IDEMPOTENCY_KEY_REUSED') {
          // A recusa pelo CÓDIGO: vira a explicação e a saída certa, e não o
          // texto do servidor (que fala em chave de idempotência).
          const d = err.details as { saleId?: unknown; saleNumber?: unknown } | undefined;
          setReusadaNoRelancamento((m) => ({
            ...m,
            [venda.id]: {
              id: typeof d?.saleId === 'string' ? d.saleId : null,
              number: typeof d?.saleNumber === 'number' ? d.saleNumber : null,
              totalCents: null,
              status: null,
              items: [],
            },
          }));
        } else if (
          err instanceof ApiRequestError
          && err.code === 'CORE_OFFLINE_SALE_OTHER_DRAWER'
          && (err.details as { confirmavel?: unknown } | undefined)?.confirmavel === true
        ) {
          // Gaveta de OUTRO caixa: a sobra e a falta ditas, e a escolha é de quem relança.
          setOutraGaveta((m) => ({ ...m, [venda.id]: err.message }));
        } else if (err instanceof ApiRequestError && err.code === 'CORE_DISCOUNT_NEEDS_AUTHORIZATION') {
          const d = err.details as { concedidoCents?: unknown; brutoCents?: unknown } | undefined;
          setLiberacao((m) => ({
            ...m,
            [venda.id]: {
              mensagem: err.message,
              concedidoCents: typeof d?.concedidoCents === 'number' ? d.concedidoCents : undefined,
              brutoCents: typeof d?.brutoCents === 'number' ? d.brutoCents : undefined,
            },
          }));
          setErroDaVenda((m) => ({ ...m, [venda.id]: err.message }));
        } else if (err instanceof ApiRequestError && err.code === 'CORE_SALE_TOTAL_CHANGED') {
          // O preço baixou depois da venda: a recusa traz as linhas com o preço
          // de agora, e o cartão mostra a diferença e as duas saídas, no lugar
          // da frase que mandava "atualizar o carrinho" — carrinho que não existe aqui.
          setPrecoMudou((m) => ({ ...m, [venda.id]: precoMudouDaRecusa(err) }));
        } else {
          setErroDaVenda((m) => ({ ...m, [venda.id]: mensagemDoErro(err, venda, podeDescartar) }));
        }
      } finally {
        setOcupado(null);
      }
    },
    [carregar, escolhas, onMudou, podeDescartar, reusadaNoRelancamento, sessao?.company?.id],
  );

  /** A liberação do gestor, pedida aqui mesmo, e o relançamento com ela (G-offline-sync-11). */
  const liberarERelancar = useCallback(
    async (venda: VendaOfflineRecusada, comoVendaNova: boolean) => {
      setOcupado(venda.id);
      setErroDaLiberacao(null);
      const pedido = liberacao[venda.id];
      let autorizacaoId: string;
      try {
        const concedida = await coreApi.authorize({
          action: 'desconto_acima_limite',
          login: loginDoGestor,
          password: senhaDoGestor,
          concedidoCents: pedido?.concedidoCents,
          brutoCents: pedido?.brutoCents,
          reason:
            `Venda guardada sem servidor (código ${codigoDaVendaGuardada(venda.idempotencyKey)}, `
            + `${formatCents(venda.receivedCents)} recebidos), relançada em Regularizar`,
        });
        autorizacaoId = concedida.id;
      } catch (err) {
        setErroDaLiberacao(err instanceof ApiRequestError ? err.message : 'Não foi possível liberar. Tente de novo.');
        setOcupado(null);
        return;
      }
      // A senha não fica na tela depois de usada.
      setSenhaDoGestor('');
      setLiberando(null);
      await relancar(venda, comoVendaNova, { authorizationId: autorizacaoId });
    },
    [liberacao, loginDoGestor, relancar, senhaDoGestor],
  );

  const descartar = useCallback(
    async (venda: VendaOfflineRecusada) => {
      setOcupado(venda.id);
      try {
        await vendasOfflineApi.descartar(venda.id, motivo);
        setAviso(`Venda guardada de ${formatCents(venda.receivedCents)} descartada. O motivo ficou na trilha.`);
        setDescartando(null);
        setMotivo('');
        onMudou?.();
        await carregar();
      } catch (err) {
        setErroDaVenda((m) => ({ ...m, [venda.id]: mensagemDoErro(err, venda, podeDescartar) }));
      } finally {
        setOcupado(null);
      }
    },
    [carregar, motivo, onMudou, podeDescartar],
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
      role="dialog"
      aria-modal="true"
      ref={prenderFoco}
      tabIndex={-1}
      aria-label="Vendas guardadas recusadas pelo servidor"
    >
      <div className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-[var(--gs-radius-lg)] bg-[var(--gs-surface)] shadow-2xl text-[var(--gs-text)]">
        <header className="px-6 py-4 border-b border-[var(--gs-border)]">
          <h2 className="m-0 text-[length:var(--gs-text-lg)] font-bold text-[var(--gs-purple-900)]">
            Vendas guardadas recusadas pelo servidor
          </h2>
          <p className="m-0 mt-1 text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
            Feitas com o servidor da loja fora, com o dinheiro já recebido. Relançar usa a mesma chave da venda: ela
            entra uma vez só, na gaveta onde o dinheiro está — a da venda, se ainda estiver aberta, ou a aberta do
            mesmo caixa; sem nenhuma das duas, na gaveta aberta deste computador.
          </p>
        </header>

        <div className="px-6 py-4 flex flex-col gap-3">
          {aviso && (
            <p role="status" className="m-0 px-3 py-2 rounded-[var(--gs-radius)] bg-[var(--gs-success-bg)] text-[var(--gs-success)]">
              {aviso}
            </p>
          )}
          {erro && (
            <p role="alert" className="m-0 px-3 py-2 rounded-[var(--gs-radius)] bg-[var(--gs-danger-bg)] text-[var(--gs-danger)]">
              {erro}
            </p>
          )}
          {vendas === null && <p role="status" className="m-0 text-[var(--gs-muted)]">Carregando…</p>}
          {vendas?.length === 0 && !erro && (
            <p className="m-0 text-[var(--gs-text-soft)]">Nenhuma venda guardada esperando regularização.</p>
          )}
          {vendas?.map((v) => {
            const reusada = chaveReusadaDe(v, reusadaNoRelancamento[v.id]);
            const comoVendaNova = Boolean(reusada);
            const onde = ondeEstaODinheiro(v);
            const pedeLiberacao = Boolean(liberacao[v.id]) || v.errorCode === 'CORE_DISCOUNT_NEEDS_AUTHORIZATION';
            const preco = precoMudou[v.id];
            // Recusada pelo preço, mas sem as linhas ainda (a entrega do PDV não
            // leva o detalhe): o relançamento traz a diferença de AGORA.
            const precoNaLista = !preco && v.errorCode === 'CORE_SALE_TOTAL_CHANGED';
            return (
              <article
                key={v.id}
                data-testid="venda-offline-recusada"
                className="rounded-[var(--gs-radius)] border border-[var(--gs-border)] px-4 py-3 flex flex-col gap-2"
              >
                <div className="flex flex-wrap justify-between gap-2">
                  <strong>
                    {formatCents(v.receivedCents)} recebidos · {v.itemsCount} item(ns)
                  </strong>
                  <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
                    Feita em {quando(v.queuedAt)}
                    {v.terminalName ? ` · ${v.terminalName}` : ''}
                    {v.reportedByName ? ` · ${v.reportedByName}` : ''}
                    {/* O mesmo código do comprovante offline: casa o papel do cliente com a pendência. */}
                    <span data-testid="codigo-da-venda-guardada">
                      {' '}
                      · código {codigoDaVendaGuardada(v.idempotencyKey)}
                    </span>
                  </span>
                </div>
                <span className="text-[length:var(--gs-text-sm)]">
                  {v.items.map((i) => `${i.quantity}× ${i.name ?? 'produto'}`).join(', ')}
                  {v.payments.length > 0 && ` — ${v.payments.map((p) => `${p.method} ${formatCents(p.amountCents)}`).join(', ')}`}
                </span>
                {onde && (
                  <span data-testid="gaveta-de-destino" className="text-[length:var(--gs-text-sm)]">
                    {onde}
                  </span>
                )}
                {reusada ? (
                  // O texto cru da recusa fala em chave de idempotência: no
                  // lugar dele, o que aconteceu e o que fazer.
                  <ExplicacaoDaChaveReusada reusada={reusada} podeAbrirVendas={podeAbrirVendas} />
                ) : preco ? null : (
                  v.errorMessage && (
                    <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-warning)]">
                      Recusada: {v.errorMessage}
                    </span>
                  )
                )}
                {v.errorCode === 'CORE_PRODUCT_NOT_FOUND' && !reusada && (
                  // O texto guardado é o do BALCÃO ("tire a linha do carrinho"): aqui a
                  // venda já aconteceu e não há carrinho — as saídas são estas.
                  // REVISÃO — O DEFEITO: o aviso mandava sempre "reativar", mas o
                  // mesmo código vem do produto EXCLUÍDO (a exclusão passa quando o
                  // produto não tem histórico, e a venda guardada nunca chegou ao
                  // servidor): não há o que reativar. A lista não tem o detalhe da
                  // recusa, então diz os dois casos; o relançamento diz qual é.
                  <span data-testid="produto-inativo-na-lista" className="text-[length:var(--gs-text-sm)]">
                    A venda já aconteceu e a mercadoria já saiu com o cliente: não há linha para tirar. Se o produto
                    foi inativado, a saída é reativá-lo em Produtos e relançar; se ele saiu do cadastro, esta venda não
                    relança. Se a venda não vai existir, ela é descartada (gerência). Relançar diz qual é o caso.
                  </span>
                )}
                {precoNaLista && (
                  <span data-testid="preco-mudou-na-lista" className="text-[length:var(--gs-text-sm)]">
                    O preço de algum item baixou depois desta venda. Clique em relançar para ver a diferença de agora
                    e escolher: relançar pelo preço de agora, devolvendo a diferença ao cliente, ou manter o valor
                    cobrado (gerência).
                  </span>
                )}
                {preco && (
                  <PrecoMudouNoCartao
                    venda={v}
                    preco={preco}
                    podeManter={podeManterOCobrado}
                    ocupado={ocupado === v.id}
                    onEscolher={(modo) => void relancar(v, comoVendaNova, { ajusteDePreco: modo })}
                  />
                )}
                {erroDaVenda[v.id] && (
                  <span role="alert" className="text-[length:var(--gs-text-sm)] text-[var(--gs-danger)]">
                    {erroDaVenda[v.id]}
                    {erroDaVenda[v.id].includes('Estoque ›') && (
                      <>
                        {' '}
                        <a href="/sistema/estoque/movimentacoes" className="underline">
                          Abrir Movimentações
                        </a>
                      </>
                    )}
                    {/* Produtos é tela do escritório: o caixa no PDV seria devolvido para casa. */}
                    {podeAbrirVendas && erroDaVenda[v.id].includes(APONTA_PRODUTOS) && (
                      <>
                        {' '}
                        <a href="/sistema/produtos" className="underline">
                          Abrir Produtos
                        </a>
                      </>
                    )}
                  </span>
                )}
                {outraGaveta[v.id] && (
                  <div
                    data-testid="confirmar-outra-gaveta"
                    className="flex flex-col gap-2 px-3 py-2 rounded-[var(--gs-radius)] bg-[var(--gs-warning-bg,var(--gs-canvas))] text-[length:var(--gs-text-sm)]"
                  >
                    <span>{outraGaveta[v.id]}</span>
                    <button
                      type="button"
                      disabled={ocupado === v.id}
                      onClick={() => void relancar(v, comoVendaNova, { confirmarOutraGaveta: true })}
                      className="self-end bg-[var(--gs-danger)] text-white border-0 rounded-[var(--gs-radius)] px-3 py-1.5 cursor-pointer font-semibold disabled:opacity-50"
                    >
                      Relançar nesta gaveta mesmo assim
                    </button>
                  </div>
                )}
                {liberando === v.id && (
                  <form
                    data-testid="liberacao-do-gestor"
                    className="flex flex-col gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void liberarERelancar(v, comoVendaNova);
                    }}
                  >
                    <span className="text-[length:var(--gs-text-sm)] font-semibold">
                      Liberação do gestor para a concessão desta venda
                    </span>
                    <label className="flex flex-col gap-1 text-[length:var(--gs-text-sm)]">
                      <span>Usuário do gestor</span>
                      <input
                        aria-label="Usuário do gestor"
                        value={loginDoGestor}
                        autoComplete="off"
                        onChange={(e) => setLoginDoGestor(e.target.value)}
                        className="px-3 py-2 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)]"
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-[length:var(--gs-text-sm)]">
                      <span>Senha do gestor</span>
                      <input
                        aria-label="Senha do gestor"
                        type="password"
                        value={senhaDoGestor}
                        autoComplete="off"
                        onChange={(e) => setSenhaDoGestor(e.target.value)}
                        className="px-3 py-2 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)]"
                      />
                    </label>
                    {erroDaLiberacao && (
                      <span role="alert" className="text-[length:var(--gs-text-sm)] text-[var(--gs-danger)]">
                        {erroDaLiberacao}
                      </span>
                    )}
                    <div className="flex gap-2 justify-end">
                      <button
                        type="button"
                        onClick={() => {
                          setLiberando(null);
                          setSenhaDoGestor('');
                          setErroDaLiberacao(null);
                        }}
                        className="bg-transparent border border-[var(--gs-border-strong)] rounded-[var(--gs-radius)] px-3 py-1.5 cursor-pointer"
                      >
                        Voltar
                      </button>
                      <button
                        type="submit"
                        disabled={ocupado === v.id || !loginDoGestor.trim() || !senhaDoGestor}
                        className="bg-[var(--gs-purple-700)] text-white border-0 rounded-[var(--gs-radius)] px-3 py-1.5 cursor-pointer font-semibold disabled:opacity-50"
                      >
                        Liberar e relançar
                      </button>
                    </div>
                  </form>
                )}
                {descartando === v.id ? (
                  <div className="flex flex-col gap-2">
                    <label className="flex flex-col gap-1 text-[length:var(--gs-text-sm)]">
                      <span className="font-semibold">Por que esta venda não vai existir</span>
                      <input
                        aria-label="Motivo do descarte"
                        value={motivo}
                        onChange={(e) => setMotivo(e.target.value)}
                        placeholder='Ex.: "cliente desistiu e o dinheiro foi devolvido"'
                        className="px-3 py-2 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)]"
                      />
                    </label>
                    <div className="flex gap-2 justify-end">
                      <button
                        type="button"
                        onClick={() => {
                          setDescartando(null);
                          setMotivo('');
                        }}
                        className="bg-transparent border border-[var(--gs-border-strong)] rounded-[var(--gs-radius)] px-3 py-1.5 cursor-pointer"
                      >
                        Voltar
                      </button>
                      <button
                        type="button"
                        disabled={ocupado === v.id || motivo.trim().length < 10}
                        onClick={() => void descartar(v)}
                        className="bg-[var(--gs-danger)] text-white border-0 rounded-[var(--gs-radius)] px-3 py-1.5 cursor-pointer font-semibold disabled:opacity-50"
                      >
                        Confirmar descarte
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex gap-2 justify-end">
                    {podeDescartar && (
                      <button
                        type="button"
                        onClick={() => setDescartando(v.id)}
                        className="bg-transparent border border-[var(--gs-border-strong)] rounded-[var(--gs-radius)] px-3 py-1.5 cursor-pointer"
                      >
                        Descartar
                      </button>
                    )}
                    {pedeLiberacao && liberando !== v.id && (
                      <button
                        type="button"
                        onClick={() => {
                          setLiberando(v.id);
                          setErroDaLiberacao(null);
                        }}
                        className="bg-transparent border border-[var(--gs-border-strong)] rounded-[var(--gs-radius)] px-3 py-1.5 cursor-pointer font-semibold"
                      >
                        Pedir liberação do gestor
                      </button>
                    )}
                    {/* Com o preço mudado, repetir o mesmo corpo toma a mesma recusa: as saídas estão no quadro acima. */}
                    {preco ? null : reusada ? (
                      <button
                        type="button"
                        disabled={ocupado === v.id}
                        onClick={() => void relancar(v, true)}
                        className="bg-[var(--gs-purple-700)] text-white border-0 rounded-[var(--gs-radius)] px-3 py-1.5 cursor-pointer font-semibold disabled:opacity-50"
                      >
                        {ocupado === v.id ? 'Relançando…' : 'Relançar como venda nova'}
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={ocupado === v.id}
                        onClick={() => void relancar(v, false)}
                        className="bg-[var(--gs-purple-700)] text-white border-0 rounded-[var(--gs-radius)] px-3 py-1.5 cursor-pointer font-semibold disabled:opacity-50"
                      >
                        {ocupado === v.id ? 'Relançando…' : 'Relançar na gaveta aberta'}
                      </button>
                    )}
                  </div>
                )}
              </article>
            );
          })}
        </div>

        <footer className="px-6 py-3 border-t border-[var(--gs-border)] flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="bg-transparent border border-[var(--gs-border-strong)] rounded-[var(--gs-radius)] px-4 py-2 cursor-pointer"
          >
            Fechar
          </button>
        </footer>
      </div>
    </div>
  );
}
