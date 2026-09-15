/**
 * PDV — ponto de venda de balcão.
 *
 * Estrutura reproduzida da referência visual:
 *
 *   faixa superior em gradiente, com mensagem de estado no centro e
 *   Início / Ajuda / operador à direita;
 *   coluna esquerda: busca grande com lupa, link de pesquisa avançada,
 *   Quantidade e Preço Unitário lado a lado com rótulos em roxo;
 *   coluna direita: vendedor + tabela de preços, lista de itens e a régua de
 *   totais no rodapé do card;
 *   rodapé: três ações primárias, três secundárias e o Finalizar com o total
 *   em destaque.
 *
 * A venda vai com chave de idempotência gerada na abertura do carrinho, então
 * reenvio por queda de rede não gera venda duplicada.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { prenderFoco } from '@/components/gs/armadilhaDeFoco';
import { useSearchParams } from 'react-router-dom';
import { Badge, Button, SearchInput } from '@/components/gs/ui';
import {
  AutorizacaoGerenteDialog,
  PagamentoDialog,
  type PaymentLine,
} from '@/components/gs/PagamentoDialog';
import { formatCents, formatQuantity, parseReaisToCents } from '@/components/gs/format';
import { useHasProfile, useSession } from '@/hooks/useSession';
import { useEmpresaTemPlaquinha } from '@/hooks/useEmpresaTemPlaquinha';
import { useCan } from '@/hooks/useCan';
import { ApiRequestError } from '@/lib/api/client';
import { oficinaCaixaApi, type FilaDeRecebimento } from '@/lib/api/oficinaCaixa';
import { OsAReceberDialog } from '@/components/gs/OsAReceberDialog';
import { AbrirOsDialog } from '@/components/gs/AbrirOsDialog';
import {
  coreApi,
  detalheDeConcessao,
  type CaixaDoComputador,
  type CarrinhoPrecificado,
  type CashSession,
  type Customer,
  type DetalheDeConcessao,
  type Product,
  type ProductUnit,
  type Quote,
  type SaleDetail,
} from '@/lib/api/core';
import { printDocument } from '@/lib/print';
import { PainelFiscalPdv } from '@/components/gs/PainelFiscalPdv';
import { VendaConcluidaDialog, type EstadoFiscalDaVenda, type VendaConcluida } from '@/components/gs/VendaConcluidaDialog';
import {
  htmlDoComprovanteNaoFiscal,
  imprimirComprovanteNaoFiscal,
  rotuloDoMeio,
  type DadosDoComprovante,
} from '@/lib/comprovanteNaoFiscal';
import { impressaoApi } from '@/lib/api/impressao';
import type { DisparoDaNfce } from '@/lib/api/emissaoNoFinalizar';
import { FiscalBadgePdv } from '@/components/gs/FiscalBadgePdv';
import { CaixaPdvDialog } from '@/components/gs/CaixaPdvDialog';
import { AvisoGavetaDeOutroDia } from '@/components/gs/CaixaDoComputador';
import { caixaDesteComputador, guardarCaixaDesteComputador } from '@/lib/api/terminais';
import { ClientePdvDialog } from '@/components/gs/ClientePdvDialog';
import {
  achadoExato,
  avisoFiscalIncompleto,
  destinoDaBusca,
  distintivoDePeca,
  ehPecaDeBancada,
  rotuloFiscalIncompleto,
  ehPesavel,
  etiquetaDaBalancaUnica,
  PDV_SHORTCUT_KEYS,
  QTD_MAXIMA_DA_LINHA,
  recusaDaEtiquetaDaBalanca,
  recusaDeFracao,
  soVendeInteiro,
  temEtiquetaDaBalanca,
  type AchadoDaBalanca,
  type AchadoDaBusca,
  type CartLine,
  type ItemRemovidoDoCarrinho,
} from './pdvTypes';
import { codigoDaVendaGuardada, isNetworkFailure } from '@/lib/api/offlineQueue';
import {
  concessaoPrevista,
  descontoDoRodapeCents,
  ehPrecoAberto,
  origensEmPalavras,
  precoVigenteCents,
  unitarioCobradoCents,
} from './pdvConcessao';
import { PesquisaAvancadaDialog } from '@/components/gs/PesquisaAvancadaDialog';
import { MiniaturaDoProduto } from '@/components/gs/MiniaturaDoProduto';
import {
  aplicarPrecificacao,
  clienteDaVenda,
  condicaoEmPalavras,
  linhasParaReprecificar,
} from './pdvReprecificacao';
import { dataBR } from '@/lib/datas';
import {
  escolherUnidadesDoDocumento,
  unidadesDaConversao,
  unidadesLivres,
} from '@/lib/api/motoDaPreVenda';

/** O número que o operador confere contra a peça na mão. */
function rotuloDaUnidade(u: ProductUnit): string {
  return (
    u.chassis ?? u.imei ?? u.plate ?? u.serial_number ?? u.motor_number ?? 'sem identidade'
  );
}

/**
 * Centavos no formato em que o campo de dinheiro é DIGITADO (1250,00).
 *
 * Vírgula, e não ponto: é o que `parseReaisToCents` lê de volta e é o que o
 * balcão digita. Zero devolve vazio de propósito — o campo em branco é o que
 * mostra que ninguém combinou preço ainda, e um "0,00" pré-escrito pareceria
 * um valor decidido.
 */
function reaisNoCampo(cents: number): string {
  if (cents <= 0) return '';
  return (cents / 100).toFixed(2).replace('.', ',');
}

/**
 * ============================================================================
 * O DESCONTO DA LINHA NUNCA PODE PASSAR DO QUE A LINHA COBRA
 * ============================================================================
 *
 * ## O defeito que esta função encerra
 *
 * O desconto era limitado ao total da linha SÓ no instante em que era digitado.
 * Depois disso, três lugares mexem no teto e nenhum mexia no desconto: a
 * quantidade da linha, o valor combinado do preço aberto e a reprecificação por
 * cliente.
 *
 * Sequência real: linha 3 × R$ 10,00, desconto R$ 30,00 (aceito, é o teto),
 * quantidade corrigida para 1. A tela mostrava a linha em R$ 0,00 — o
 * `Math.max(0, …)` do total esconde o negativo — e o POST levava
 * `discountCents: 3000` contra um bruto de 1000. O servidor recusa com
 * `CORE_INVALID_DISCOUNT`, com o cliente na frente.
 *
 * Consertar só a quantidade seria consertar a linha e deixar a classe: o teto
 * tem três escritores, e a regra é UMA. Quem mudar o teto passa por aqui.
 *
 * O teto é a mesma conta do servidor (`unitário cobrado × quantidade`), escrita
 * uma vez só — duas aritméticas para o mesmo limite é como o buraco volta.
 */
function comDescontoDentroDoTeto(linha: CartLine): CartLine {
  const teto = Math.round(unitarioCobradoCents(linha) * linha.quantity);
  const dentro = Math.min(Math.max(0, linha.discountCents ?? 0), teto);
  // Sem desconto nenhum a linha volta sem o campo, e não com zero: `undefined`
  // é o que a monta o POST sem `discountCents` (`l.discountCents || undefined`).
  return { ...linha, discountCents: dentro || undefined };
}

/**
 * As linhas cujo desconto NÃO CABE no que elas cobram.
 *
 * Serve à recusa do servidor: quando ele não nomeia a linha ofensora, a tela a
 * encontra com a MESMA conta dele. Achar nenhuma é resposta legítima — quer
 * dizer que a aritmética da tela e a do servidor discordam, e aí a faixa diz
 * isso em vez de marcar uma linha por chute.
 */
function linhasComDescontoImpossivel(linhas: CartLine[]): CartLine[] {
  return linhas.filter(
    (l) => Math.round(l.discountCents ?? 0)
      > Math.round(unitarioCobradoCents(l) * l.quantity),
  );
}

/**
 * Quantas peças da linha saem sem plaquinha da oficina.
 *
 * O balcão é o último ponto em que isso ainda tem conserto: depois da venda a
 * unidade vira `sold` e o vínculo não se faz mais, então a moto que sair assim
 * fica sem dono no portal para sempre. Contar aqui é o que permite dizer isso
 * ANTES, sem impedir nada.
 */
function contarSemPlaquinha(unidades?: ProductUnit[]): number {
  return (unidades ?? []).filter((u) => !u.equipment_id).length;
}
import * as emEspera from './pdvEmEspera';
import { uuid } from '../../lib/uuid';
import { EstadoConexao } from '@/components/gs/EstadoConexao';
import { PainelAuxiliar } from '@/components/gs/PainelAuxiliar';
import { DialogoBase } from '@/components/gs/DialogoBase';

// `CartLine` mora em `pdvTypes.ts` porque a espera de venda (F7) usa o mesmo
// formato — ver o comentário lá.

function newIdempotencyKey(): string {
  return `pdv-${uuid()}`;
}

/** Ação da faixa inferior — sólida (primária) ou clara (secundária). */
function PdvButton({
  tone,
  onClick,
  disabled,
  children,
}: {
  tone: 'solid' | 'soft';
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`w-full rounded-[var(--gs-radius)] border-0 cursor-pointer font-bold
        disabled:opacity-50 disabled:cursor-not-allowed transition-colors ${
          tone === 'solid'
            ? 'bg-[var(--gs-purple-800)] hover:bg-[var(--gs-purple-900)] text-white py-4 text-[length:var(--gs-text-base)]'
            : 'bg-[var(--gs-purple-100)] hover:bg-[#e9daf0] text-[var(--gs-purple-800)] py-2.5 text-[length:var(--gs-text-sm)]'
        }`}
    >
      {children}
    </button>
  );
}

/**
 * Uma faixa de aviso do balcão, no tom da gravidade.
 *
 * Existe para que as quatro situações desta tela — concessão, recusa de
 * alçada, produto sem preço e preço digitado acima do vigente — tenham a MESMA
 * forma. Quando cada aviso inventa a própria caixa, o operador aprende a
 * ignorar o formato em vez de ler o conteúdo.
 */
function FaixaPdv({
  tom,
  titulo,
  children,
}: {
  tom: 'info' | 'warning' | 'danger';
  titulo: string;
  children: React.ReactNode;
}) {
  const cores = {
    info: 'bg-[var(--gs-info-bg)] border-[var(--gs-info)] text-[var(--gs-info)]',
    warning: 'bg-[var(--gs-warning-bg)] border-[var(--gs-warning)] text-[var(--gs-warning)]',
    danger: 'bg-[var(--gs-danger-bg)] border-[var(--gs-danger)] text-[var(--gs-danger)]',
  }[tom];
  return (
    <div className={`border rounded-[var(--gs-radius)] px-4 py-3 flex flex-col gap-1.5 ${cores}`}>
      <strong className="text-[length:var(--gs-text-sm)] uppercase tracking-wide">{titulo}</strong>
      <div className="text-[length:var(--gs-text-sm)] text-[var(--gs-text)] flex flex-col gap-1.5">
        {children}
      </div>
    </div>
  );
}

/**
 * Atalhos declarados na ajuda da tela.
 *
 * Esta lista e o mapa do handler precisam bater. Ela declarava F7, F12 e Esc
 * que o handler não tratava — o operador apertava e nada acontecia, que é o
 * tipo de coisa que faz perder confiança no sistema inteiro. Há teste
 * cobrando a equivalência entre as duas.
 */
/*
  A LISTA NÃO PODE CITAR MEIO QUE A LOJA NÃO TEM.

  Dizia "dinheiro, débito, crédito, PIX, crediário", e o crediário está
  desligado no catálogo do servidor (`active: false`): nunca é devolvido por
  `/payment-methods`, não aparece como botão, e o Alt+5 não escolhe nada. A
  ajuda ensinava um meio de pagamento que a loja não oferece — e venda a
  prazo é justamente o que um cliente pede em voz alta no balcão.
*/
const SHORTCUTS = [
  // F1 era a ajuda do NAVEGADOR, numa aba nova, no meio da venda (D-pdv-teclado-18).
  ['F1', 'Mostra (ou esconde) esta ajuda'],
  ['F2', 'Busca e cadastra o cliente da venda, sem sair do carrinho'],
  ['F3', 'Abre o caixa: fundo de troco, sangria, suprimento e fechamento'],
  // Os dois atalhos de gaveta abrem o MESMO diálogo do F3, já apontando a
  // ação — o valor continua sendo digitado e confirmado pela pessoa.
  ['Ctrl+F3', 'Abre o caixa direto na sangria'],
  ['Shift+F3', 'Abre o caixa direto no suprimento'],
  ['F4', 'Abre a pesquisa avançada de produtos'],
  ['F6', 'Cancela a venda em aberto'],
  ['F7', 'Põe a venda em espera e libera a tela para o próximo cliente'],
  ['F8', 'Fecha em dinheiro pelo valor exato, sem troco'],
  ['F9', 'Abre um orçamento ou pré-venda para faturar'],
  ['F10', 'Abre o pagamento (divide meios e calcula troco) — e o finaliza quando fecha'],
  ['Alt+O', 'Escreve a observação da venda'],
  ['Alt+1 a Alt+4', 'No pagamento, escolhe o meio: dinheiro, débito, crédito, PIX'],
  ['Esc', 'Fecha o pagamento e volta ao mesmo carrinho'],
];


/**
 * O nome do documento carregado no balcão (GAP-V68).
 *
 * Desde que o F9 lista os dois, chamar tudo de "pré-venda" viraria mentira na
 * faixa mais importante da tela: a pré-venda já tirou a peça do disponível, o
 * orçamento não tirou nada. Quem lê "mercadoria já reservada" sobre um
 * orçamento vai ficar surpreso quando faltar saldo no Finalizar.
 */
function rotuloDoDocumento(kind: Quote['kind']): string {
  return kind === 'pre_venda' ? 'Pré-venda' : 'Orçamento';
}

/**
 * O que a faixa diz quando o documento sai do balcão sem ser faturado — pelo
 * link "soltar do balcão" ou pelo F6 (D-pdv-teclado-R02). Uma frase só para os
 * dois gestos, e certa para cada documento: o banner dizia "Pré-venda liberada…
 * continua reservada" também para o orçamento, que não reserva nada.
 */
function fraseDoDocumentoSolto(documento: Pick<Quote, 'kind' | 'number'>): string {
  return documento.kind === 'pre_venda'
    ? `Pré-venda #${documento.number} liberada do balcão. Ela continua aberta no servidor, com a mercadoria `
        + 'reservada — volta pelo F9.'
    : `${rotuloDoDocumento(documento.kind)} #${documento.number} liberado do balcão. Ele continua aberto no `
        + 'servidor — volta pelo F9.';
}

/**
 * O carrinho como o cupom mostra: descrição, quantidade, unitário e total líquido da linha.
 *
 * O UNITÁRIO É O COBRADO, e não o digitado (D-pdv-teclado-19). Usava
 * `l.unitPriceCents`: num item de preço fechado de R$ 400,00 com R$ 500,00
 * digitados, o servidor cobra R$ 400,00 — e a tela de venda concluída listava
 * R$ 500,00 no item com total R$ 400,00. O comprovante offline ia além: subtotal
 * R$ 500,00 e um "Desconto R$ 100,00" que ninguém deu. É a mesma conta da linha
 * do carrinho (`unitarioCobradoCents`), escrita uma vez só.
 */
function retratoDoCarrinho(linhas: CartLine[]): DadosDoComprovante['itens'] {
  return linhas.map((l) => {
    const unitario = unitarioCobradoCents(l);
    const bruto = Math.round(unitario * l.quantity);
    const desconto = Math.max(0, l.discountCents ?? 0);
    return { descricao: l.product.name, quantidade: l.quantity, unitarioCents: unitario, totalCents: Math.max(0, bruto - desconto) };
  });
}

/**
 * Os meios da venda como a tela e o cupom mostram — com o VALE à parte, que não
 * é meio de pagamento (é dívida que a loja já tinha com o cliente) e não pode
 * sumir do papel: sem ele, os meios não fechavam com o total (D-pdv-teclado-08).
 */
function pagamentosDaTela(
  payments: PaymentLine[],
  creditoCents: number,
): { rotulo: string; valorCents: number }[] {
  return [
    ...payments.map((p) => ({
      /*
        O PIX "RECEBER DEPOIS" NÃO É PIX PAGO (PED-pdv-01).

        A linha pendente saía rotulada "PIX", igual à liquidada: a tela de venda
        concluída e o comprovante afirmavam ao cliente e ao caixa um dinheiro que
        ainda não caiu. O rótulo diz o que ela é.
      */
      rotulo:
        p.status === 'pending'
          ? `${rotuloDoMeio(p.method)} — aguardando confirmação`
          : rotuloDoMeio(p.method),
      valorCents: p.amountCents,
    })),
    ...(creditoCents > 0 ? [{ rotulo: 'Crédito de loja (vale do cliente)', valorCents: creditoCents }] : []),
  ];
}

/**
 * AS CONTAS DO CARRINHO, NUM LUGAR SÓ.
 *
 * A tela as fazia no corpo do componente, e o Finalizar lia o `total` do
 * fechamento — o total do carrinho de ANTES do último bipe (D-pdv-teclado-02).
 * Separadas aqui, o Finalizar refaz a mesma conta sobre as linhas que de fato
 * vão para a venda, e o rodapé continua mostrando a mesma coisa.
 *
 *   bruto            unitário cobrado × quantidade, somado
 *   subtotal         bruto menos o desconto de cada linha (a conta do servidor)
 *   discount         o desconto de rodapé, derivado do texto ("50" ou "10%")
 *   total            subtotal menos o rodapé
 */
function contasDoCarrinho(linhas: CartLine[], descontoTexto: string) {
  let bruto = 0;
  let subtotal = 0;
  for (const l of linhas) {
    const daLinha = Math.round(unitarioCobradoCents(l) * l.quantity);
    bruto += daLinha;
    // O campo da linha já limita o desconto ao valor da própria linha; o
    // Math.max é cinto.
    subtotal += Math.max(0, daLinha - Math.round(l.discountCents ?? 0));
  }
  const discount = descontoDoRodapeCents(descontoTexto, subtotal);
  return { bruto, subtotal, descontoDeLinhas: bruto - subtotal, discount, total: Math.max(0, subtotal - discount) };
}

/*
  ============================================================================
  O CARRINHO SOBREVIVE AO F5 (D-pdv-teclado-06)
  ============================================================================

  O carrinho vivia só no estado da tela. F5 (vizinho do F4 "pesquisa" e do F6
  "cancela"), recarregar ou fechar a aba no meio de uma venda de 25 itens
  apagava tudo sem pergunta — itens, cliente, desconto, o rastro de cancelados.
  O caso grave é o F5 durante o POST: a venda nasce no servidor, a tela esquece,
  e o caixa refaz com chave NOVA — venda em dobro.

  O rascunho vai para o `sessionStorage` a cada mudança, com a MESMA chave de
  idempotência: se o POST já tinha gravado, reenviar devolve a venda original em
  vez de criar outra. `sessionStorage`, e não `localStorage`: é da ABA — duas
  abas de PDV na mesma máquina não disputam o mesmo rascunho — e sobrevive ao
  recarregar, que é o acidente que interessa. Fechar a aba pergunta antes
  (`beforeunload`).
*/
const PREFIXO_DO_RASCUNHO = 'gs.pdv.rascunho';

interface RascunhoDaVenda {
  lines: CartLine[];
  customer: { id: string; name: string } | null;
  descontoTexto: string;
  note: string;
  removidos: ItemRemovidoDoCarrinho[];
  saleKey: string;
  loadedQuote: Quote | null;
  guardadoEm: string;
}

function chaveDoRascunhoDaVenda(empresa?: string | null, usuario?: string | null): string {
  return `${PREFIXO_DO_RASCUNHO}:${empresa ?? 'sem-empresa'}:${usuario ?? 'sem-usuario'}`;
}

function lerRascunhoDaVenda(chave: string): RascunhoDaVenda | null {
  try {
    const bruto = sessionStorage.getItem(chave);
    if (!bruto) return null;
    const r = JSON.parse(bruto) as RascunhoDaVenda;
    if (!r || !Array.isArray(r.lines) || r.lines.length === 0 || typeof r.saleKey !== 'string') return null;
    return {
      ...r,
      removidos: Array.isArray(r.removidos) ? r.removidos : [],
      descontoTexto: typeof r.descontoTexto === 'string' ? r.descontoTexto : '',
      note: typeof r.note === 'string' ? r.note : '',
      loadedQuote: r.loadedQuote ?? null,
      customer: r.customer ?? null,
    };
  } catch {
    return null;
  }
}

function gravarRascunhoDaVenda(chave: string, rascunho: RascunhoDaVenda | null): void {
  try {
    if (rascunho) sessionStorage.setItem(chave, JSON.stringify(rascunho));
    else sessionStorage.removeItem(chave);
  } catch {
    // Sem armazenamento, o rascunho vale só enquanto a tela está aberta — que
    // é o comportamento de antes. Não trava a venda por um recurso de socorro.
  }
}

/*
  ============================================================================
  A ÚLTIMA GAVETA QUE O SERVIDOR CONFIRMOU (G-offline-sync-02)
  ============================================================================

  Com o servidor fora, a gaveta que a tela conhecia vale mais do que "nenhuma":
  a venda que vai para a fila leva o `cashSessionId` e o caixa DAQUELE turno —
  sem eles, a venda no cartão sincronizava com `cash_session_id` nulo e ficava
  fora do fechamento do turno (diferença que ninguém explica), a venda em
  dinheiro caía em qualquer gaveta aberta no reenvio, e as esperas (F7) do turno
  sumiam da tela, porque o escopo delas é o id da sessão.

  A volta do foco já não zerava a gaveta (D-pdv-teclado-20). Faltava o F5 — ou
  o navegador reaberto — durante a queda: a montagem falhava e a tela nascia sem
  gaveta e sem caixa. Por isso a última resposta do servidor fica guardada por
  empresa, e é ela que a tela usa quando a consulta NÃO chega ao servidor —
  marcando "não confirmado". Só uma resposta do servidor muda a gaveta de
  verdade. Passado o prazo abaixo, a lembrança é velha demais para valer.
*/
const PREFIXO_DO_ULTIMO_CAIXA = 'gs.pdv.ultimoCaixa';
const VALIDADE_DO_ULTIMO_CAIXA_MS = 18 * 60 * 60 * 1000;

interface UltimoCaixaConfirmado {
  session: CashSession;
  terminal: { id: string; code: string; name: string } | null;
  confirmadoEm: string;
}

function lerUltimoCaixa(empresa: string | null): UltimoCaixaConfirmado | null {
  if (!empresa) return null;
  try {
    const bruto = localStorage.getItem(`${PREFIXO_DO_ULTIMO_CAIXA}:${empresa}`);
    if (!bruto) return null;
    const u = JSON.parse(bruto) as UltimoCaixaConfirmado;
    if (!u?.session || typeof u.session.id !== 'string') return null;
    const idade = Date.now() - new Date(u.confirmadoEm).getTime();
    if (!Number.isFinite(idade) || idade < 0 || idade > VALIDADE_DO_ULTIMO_CAIXA_MS) return null;
    return { session: u.session, terminal: u.terminal ?? null, confirmadoEm: u.confirmadoEm };
  } catch {
    return null;
  }
}

function gravarUltimoCaixa(empresa: string | null, valor: UltimoCaixaConfirmado | null): void {
  if (!empresa) return;
  try {
    const chave = `${PREFIXO_DO_ULTIMO_CAIXA}:${empresa}`;
    if (valor) localStorage.setItem(chave, JSON.stringify(valor));
    else localStorage.removeItem(chave);
  } catch {
    // Sem armazenamento, a lembrança vale só enquanto a tela está aberta.
  }
}

/*
  A PERGUNTA DE PREÇO ANTES DE COBRAR TEM PRAZO (revisão de G-offline-sync-M01).

  O Finalizar (F8/F10) passou a esperar a pergunta de preço por quantidade
  antes de mandar a venda. Só que a consulta de preço não tem prazo nenhum — só
  a VENDA tem (`PRAZO_DA_VENDA_MS`, depois do qual ela vai para a fila). Com o
  servidor travado (aceita a conexão e não responde), o F8 de um carrinho com
  dois do mesmo item ficava parado para sempre esperando o preço, e a venda
  nunca chegava nem a tentar a fila: o balcão travava justamente no dia em que
  a fila existe para salvá-lo. Passado o prazo, a venda segue com o preço da
  tela — a palavra final é do servidor, como já era sem resposta.
*/
const PRAZO_DO_PRECO_ANTES_DE_COBRAR_MS = 3_000;

/** O valor da promessa, ou `undefined` se ela falhar ou passar do prazo. */
function comPrazo<T>(promessa: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const relogio = setTimeout(() => resolve(undefined), ms);
    promessa.then(
      (valor) => {
        clearTimeout(relogio);
        resolve(valor);
      },
      () => {
        clearTimeout(relogio);
        resolve(undefined);
      },
    );
  });
}

/**
 * A consulta não chegou à API (PED-pdv-09): a rede caiu, ou o proxy na frente
 * dela respondeu 502/503/504 no lugar dela — o mesmo critério da fila de
 * vendas (G-offline-sync-05). Resposta DA API com erro (403, 500, recusa com
 * código) não entra aqui: o servidor está no ar e disse alguma coisa.
 */
function semServidor(err: unknown): boolean {
  if (isNetworkFailure(err)) return true;
  return err instanceof ApiRequestError && (err.status === 502 || err.status === 503 || err.status === 504);
}

/**
 * Escreve num campo controlado pelo React como se a pessoa tivesse digitado —
 * o `onChange` dele roda e o estado acompanha. Serve para DESFAZER o bipe que
 * caiu no campo errado (D-pdv-teclado-05).
 */
function escreverNoCampo(campo: HTMLInputElement, valor: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(campo, valor);
  campo.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Intervalo máximo entre as teclas de um leitor de código de barras. Gente não digita tão rápido. */
const ENTRE_TECLAS_DO_LEITOR_MS = 50;

type VendaNaTela = VendaConcluida & {
  saleId: string | null;
  documentoFiscalId: string | null;
  comprovante: Omit<DadosDoComprovante, 'loja'>;
};

export default function PdvPage() {
  const session = useSession();
  /*
    O AVISO "SEM PLAQUINHA DA OFICINA" É DA PJ MOTORS (P0 das plaquinhas).
    A Preço Justo vende celular controlado por unidade, e o balcão dela lia
    "sem plaquinha da oficina — sendo moto…" em toda venda de aparelho. Fora da
    PJ a plaquinha não existe, e o aviso não tem o que pedir.
  */
  const temPlaquinha = useEmpresaTemPlaquinha();
  const searchRef = useRef<HTMLInputElement>(null);
  // O rascunho da venda que o F5 interrompeu (D-pdv-teclado-06): lido UMA vez,
  // na montagem, e usado como valor inicial dos estados do carrinho.
  const chaveDoRascunho = chaveDoRascunhoDaVenda(session?.company.id, session?.user.id);
  const [rascunhoInicial] = useState(() => lerRascunhoDaVenda(chaveDoRascunho));
  // A mão dada por Orçamentos (GAP-V68): `/pdv?documento=<id>`.
  const [searchParams, setSearchParams] = useSearchParams();

  const [cash, setCash] = useState<CashSession | null>(null);

  /**
   * O que o servidor disse sobre ESTE computador (GAP-PRD-039/131): qual caixa
   * ele é, se ainda precisa escolher, e se a gaveta aberta é de outro dia.
   * Nulo é a resposta de um servidor que não conhece caixas — a gaveta única.
   */
  const [caixaDoComputador, setCaixaDoComputador] = useState<
    Omit<CaixaDoComputador, 'session' | 'cashWithdrawalLimitCents'> | null
  >(null);
  const empresaDaSessao = session?.company.id ?? null;

  /**
   * A CONSULTA AO CAIXA RESPONDEU? — e não "o caixa está aberto?".
   *
   * São perguntas diferentes, e confundi-las trava o balcão. Sessão nula
   * significa duas coisas: não há caixa aberto (e aí vender seria criar
   * diferença de gaveta) ou a consulta falhou (e aí o sistema simplesmente
   * não sabe). Recusar a venda no segundo caso pararia a loja por causa de
   * uma piscada de rede.
   */
  const [caixaConhecido, setCaixaConhecido] = useState(false);
  /**
   * A consulta ao caixa NÃO chegou ao servidor (G-offline-sync-02): a gaveta na
   * tela é a última que ele confirmou, e a faixa diz isso em vez de afirmar.
   */
  const [caixaNaoConfirmado, setCaixaNaoConfirmado] = useState(false);
  /**
   * O servidor RESPONDEU à consulta do caixa, com erro (PED-pdv-09): 403, 500,
   * recusa com código. Não é "fora de alcance" — por isso a lembrança da
   * gaveta não vale, e a frase do servidor vai para a faixa.
   */
  const [erroDoCaixa, setErroDoCaixa] = useState<string | null>(null);

  /**
   * Quanto o operador pode tirar da gaveta sem chamar gestor, em centavos.
   *
   * Nulo é SEM TETO — a resposta de uma operação que não configurou trava — e
   * não "ainda não chegou". Os dois casos levam ao mesmo desfecho na tela (não
   * desenhar aviso nenhum), e é por isso que um estado só basta aqui.
   *
   * Vem de `GET /core/cash/open`, junto da sessão, e não de
   * `/core/sale-policies`: aquela exige perfil de gerente, e quem está no PDV
   * é o caixa. O teto viaja pela rota que o caixa alcança justamente porque é
   * a regra que se aplica a ELE.
   */
  const [tetoSangriaCents, setTetoSangriaCents] = useState<number | null>(null);
  const [term, setTerm] = useState('');
  const [results, setResults] = useState<Product[]>([]);
  /**
   * "Incluir peças da oficina" — DESLIGADO por padrão.
   *
   * Desligado, a busca por texto devolve só mercadoria de revenda: digitar
   * "bateria" e receber quarenta baterias da bancada esconde o produto de
   * venda no meio do estoque de conserto, e peça tem preço de reposição. Mas o
   * servidor sempre soube atender `?includeParts=1`, e sem ninguém para
   * chamá-lo a opção era código morto — enquanto a venda de balcão de uma peça
   * avulsa acontece de verdade, e sem o interruptor só dava para chegar nela
   * bipando o código.
   */
  const [incluirPecas, setIncluirPecas] = useState(false);
  /**
   * A peça bipada esperando um sim.
   *
   * Ver `destinoDaBusca`: o casamento exato de uma peça não entra sozinho no
   * carrinho. Isto é a pergunta na tela, e ela nomeia a bancada.
   */
  const [pecaParaConfirmar, setPecaParaConfirmar] = useState<
    {
      product: Product;
      quantity: number;
      unidades?: ProductUnit[];
      /** O preço combinado no balcão, se houver. Ver `precoDigitadoCents`. */
      precoCents?: number;
    } | null
  >(null);
  const [quantity, setQuantity] = useState('1');
  const [unitPrice, setUnitPrice] = useState('');
  const [lines, setLines] = useState<CartLine[]>(
    () => (rascunhoInicial?.lines ?? []).map(comDescontoDentroDoTeto),
  );

  /*
    QUEM VENDEU, e não quem digitou.

    O padrão é o próprio operador — na maioria das vendas é ele mesmo, e
    obrigar a escolher a cada venda atrasaria o balcão. O seletor só aparece
    quando há mais de uma pessoa na operação.
  */
  const [equipe, setEquipe] = useState<{ id: string; displayName: string; active: boolean }[]>(
    [],
  );
  const [sellerId, setSellerId] = useState<string>('');
  useEffect(() => {
    if (!session?.user.id) return;
    setSellerId(session.user.id);
    void coreApi
      // `listSellers` e não `listTeam`: a rota de gestão exige gerente, e quem
      // está no PDV é o caixa. O 403 caía neste mesmo catch e o seletor nunca
      // aparecia — toda venda saía em nome do operador, comissão inclusive.
      .listSellers()
      .then((t) => setEquipe(t.filter((p) => p.active)))
      // Sem a lista, o balcão segue vendendo em nome do operador — que é
      // exatamente o comportamento de antes.
      .catch(() => setEquipe([]));
  }, [session?.user.id]);
  // A chave do rascunho volta junto: reenviar a venda que já tinha subido
  // devolve a original em vez de criar outra.
  const [saleKey, setSaleKey] = useState(() => rascunhoInicial?.saleKey ?? newIdempotencyKey());
  const [customer, setCustomer] = useState<Customer | null>(() =>
    rascunhoInicial?.customer
      ? ({ id: rascunhoInicial.customer.id, name: rascunhoInicial.customer.name } as Customer)
      : null,
  );
  /**
   * O diálogo de cliente (F2) — busca viva e cadastro rápido (GAP-V53).
   *
   * Era uma lista completa sem filtro num scroll de 160px: com centenas de
   * cadastros, escolher era rolagem com fila no balcão, e cadastrar exigia
   * sair para a tela Clientes perdendo o carrinho de vista. A lista e o
   * formulário moram em `ClientePdvDialog`; aqui só vive o interruptor.
   */
  const [showClientes, setShowClientes] = useState(false);
  /**
   * A condição comercial do cliente do carrinho, como o servidor a devolveu.
   *
   * Guardada junto de PARA QUEM ela vale, e não sozinha: sem esse par, tirar o
   * cliente do carrinho deixaria "Atacado -15%" na tela anunciando um desconto
   * que já não está sendo aplicado — e o operador repetiria o número ao próximo
   * cliente da fila.
   */
  const [condicao, setCondicao] = useState<{
    para: string | null;
    tabela: CarrinhoPrecificado['priceTable'];
  }>(
    // Começa sabendo o óbvio: sem cliente não há tabela. Nascer vazio faria
    // toda abertura de PDV disparar uma consulta para descobrir "nenhuma", e a
    // tela mais usada da loja é a que menos pode gastar ida ao servidor à toa.
    { para: null, tabela: null },
  );
  /**
   * O desconto de rodapé COMO FOI DIGITADO — "50" (reais) ou "10%" (GAP-V54).
   *
   * Texto e não centavos pelo mesmo motivo de `precoDaLinha`: "1," e "10" são
   * estados intermediários de quem digita. Os centavos que valem são derivados
   * em `discount`, logo abaixo do subtotal — e quando o texto é percentual, o
   * valor acompanha o carrinho: "10%" continua sendo 10% depois do próximo
   * bipe, que é o que quem digitou quis dizer.
   */
  const [descontoTexto, setDescontoTexto] = useState(() => rascunhoInicial?.descontoTexto ?? '');
  const [note, setNote] = useState(() => rascunhoInicial?.note ?? '');
  /**
   * OS ITENS QUE SAÍRAM DO CARRINHO ANTES DO FINALIZAR — GAP-V52/V63.
   *
   * O rodapé "Itens cancelados" era um '0' literal imitando o layout de
   * referência — pior que não ter, porque o gestor achava que o número
   * existia. Cada remoção agora vira um retrato {produto, qtd, valor, hora}
   * contado AO VIVO no rodapé e enviado no POST /core/sales, onde o servidor
   * o grava com o OPERADOR do token em core_sale_removed_items.
   *
   * Zera no `clearSale`: o rastro pertence à venda, e venda ABANDONADA sem
   * finalizar não persiste nada — o carrinho é local, e o servidor só fica
   * sabendo da venda no Finalizar (decisão documentada no schema).
   *
   * A ESPERA (F7) GUARDA O RASTRO JUNTO DO CARRINHO (D-pdv-teclado-M05). Ela o
   * recomeçava: remover o item, F7 e retomar apagava o rastro com dois
   * cliques — e retomar uma espera por cima de outro carrinho levava o rastro
   * de um para a venda do outro. O rastro é do carrinho, e viaja com ele.
   */
  const [removidos, setRemovidos] = useState<ItemRemovidoDoCarrinho[]>(
    () => rascunhoInicial?.removidos ?? [],
  );
  /** Rascunho da quantidade em digitação, por produto — espelho de `precoDaLinha`. */
  const [qtdDaLinha, setQtdDaLinha] = useState<Record<string, string>>({});
  /** Rascunho do desconto de linha em digitação, por produto. */
  const [descontoDaLinha, setDescontoDaLinha] = useState<Record<string, string>>({});
  const [showHelp, setShowHelp] = useState(false);
  const [showCaixa, setShowCaixa] = useState(false);
  /**
   * A ação que o atalho de gaveta pediu: Ctrl+F3 abre o caixa já na SANGRIA,
   * Shift+F3 no SUPRIMENTO. Nulo é a abertura comum (F3, botões) — e o
   * diálogo, recebendo a ação, a nomeia na tela e marca o botão dela.
   */
  const [acaoDoCaixa, setAcaoDoCaixa] = useState<'sangria' | 'suprimento' | null>(null);
  /**
   * POR QUE o diálogo do caixa subiu sozinho, quando foi a VENDA que o abriu
   * (E-venda-servidor-08#pdv): a recusa do servidor, dita dentro do diálogo —
   * a faixa do balcão fica atrás dele. Morre no fechamento.
   */
  const [avisoDoCaixa, setAvisoDoCaixa] = useState<string | null>(null);
  /** Diálogo da observação da venda (Alt+O) — o window.prompt saiu de cena. */
  const [showNota, setShowNota] = useState(false);
  const [notaRascunho, setNotaRascunho] = useState('');
  /** Diálogo da pesquisa avançada (F4) — o rótulo parou de mentir. */
  const [showPesquisa, setShowPesquisa] = useState(false);
  /**
   * Vendas paradas neste turno.
   *
   * O escopo é a sessão de caixa; sem caixa aberto, o próprio terminal. Espera
   * de ontem, com preço e estoque de ontem, não pode reaparecer hoje como se
   * ainda valesse.
   */
  /*
    A ESPERA É DA EMPRESA, E NÃO DO GRUPO.

    Era `cash?.id ?? 'sem-caixa'`. Com caixa aberto o escopo é o id da sessão
    — único por empresa — e tudo funciona; SEM caixa aberto as seis empresas
    caíam na mesma chave literal, no mesmo localStorage da mesma máquina: o
    carrinho em espera da Gringa aparecia no PDV da Me Mimei. E, desde que a
    abertura passou a subir sozinha, "sem caixa" é justamente como o dia
    começa.
  */
  const escopoEspera = emEspera.escopoDaEspera(cash?.id, session?.company.id);
  const [esperas, setEsperas] = useState<emEspera.VendaEmEspera[]>([]);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(() =>
    rascunhoInicial
      ? {
          tone: 'ok',
          text:
            `Venda recuperada depois de recarregar a página: ${rascunhoInicial.lines.length} item(ns). `
            + 'Confira antes de finalizar.',
        }
      : null,
  );
  /*
    O CATÁLOGO VAZIO NÃO É "NÃO ENCONTRADO".

    Instalação nova nasce sem produto. "Nenhum produto encontrado" manda
    procurar de outro jeito — e não há o que achar. Quando a busca do servidor
    diz `catalogoVazio`, a tela diz "Nenhum produto cadastrado" e mostra o
    cadastro a quem pode abri-lo; ao caixa, diz a quem pedir.
  */
  const [catalogoVazio, setCatalogoVazio] = useState(false);
  const podeCadastrarProduto = useCan('products.manage');
  const [busy, setBusy] = useState(false);

  /**
   * A VERDADE SOBRE A GAVETA E A IMPRESSÃO (GAP-V55).
   *
   * O gap pedia "comando de gaveta e impressão térmica silenciosa". Metade
   * disso o navegador NÃO FAZ e nunca vai fazer: ele não expõe porta de
   * impressora a uma página, e o caminho de impressão passa pelo driver, que
   * rasteriza — bytes de comando dentro de um HTML saem impressos como texto,
   * não executados como comando.
   *
   * A escolha aqui é dizer isso ao operador, na tela, junto do cupom, com o que
   * ele PODE fazer hoje: a chave da gaveta, ou a opção "abrir gaveta ao
   * imprimir" do driver da térmica. E o servidor entrega o cupom em ESC/POS
   * (com o pulso) para o agente local, que é o caminho real quando existir.
   *
   * O que NÃO se faz: desenhar um botão "Abrir gaveta" que às vezes não abre
   * nada. Botão que engana uma vez é botão em que ninguém confia depois.
   */
  const [gaveta, setGaveta] = useState<{ byCommand: boolean; message: string } | null>(null);
  // A resposta é DESTE caixa (GAP-PRD-082): a térmica e o agente dele.
  const terminalDoCaixa = caixaDoComputador?.terminal?.id ?? null;
  /*
    A LARGURA DA BOBINA DESTE CAIXA, PARA O COMPROVANTE OFFLINE (PED-pdv-01).

    O comprovante montado no navegador (venda guardada sem servidor) saía sempre
    em 80 mm: numa térmica de 58 mm ele sai cortado, justamente no dia em que é o
    único papel que o cliente leva. A largura vem da mesma resposta que diz da
    gaveta DESTE caixa, e fica guardada — porque o comprovante offline é impresso
    quando o servidor NÃO responde.
  */
  const chaveDaLargura = `gs.pdv.larguraDoCupom:${empresaDaSessao ?? 'sem-empresa'}`;
  const [larguraDoCupom, setLarguraDoCupom] = useState<58 | 80 | undefined>(() => {
    try {
      const n = Number(localStorage.getItem(chaveDaLargura));
      return n === 58 || n === 80 ? n : undefined;
    } catch {
      return undefined;
    }
  });
  /*
    A LOJA DO COMPROVANTE OFFLINE (F-cupom-fiscal-20#reauditoria).

    O papel da venda guardada sem servidor saía só com o nome fantasia: sem CNPJ,
    sem endereço, sem telefone — o cliente não sabia de quem comprou nem para
    onde voltar. A mesma resposta da gaveta traz a loja (a leitura do cabeçalho
    do cupom do servidor), e ela fica guardada pelo mesmo motivo da largura.
  */
  type LojaDoPapel = { nome: string; cnpj: string | null; endereco: string | null; telefone: string | null };
  const chaveDaLoja = `gs.pdv.lojaDoPapel:${empresaDaSessao ?? 'sem-empresa'}`;
  const [lojaDoPapel, setLojaDoPapel] = useState<LojaDoPapel | null>(() => {
    try {
      const guardada = JSON.parse(localStorage.getItem(chaveDaLoja) ?? 'null') as Partial<LojaDoPapel> | null;
      return guardada && typeof guardada.nome === 'string'
        ? {
            nome: guardada.nome,
            cnpj: guardada.cnpj ?? null,
            endereco: guardada.endereco ?? null,
            telefone: guardada.telefone ?? null,
          }
        : null;
    } catch {
      return null;
    }
  });
  useEffect(() => {
    let vivo = true;
    void coreApi
      .drawerReadiness(terminalDoCaixa)
      .then((r) => {
        if (!vivo) return;
        setGaveta(r);
        if (r.loja && typeof r.loja.nome === 'string') {
          setLojaDoPapel(r.loja);
          try {
            localStorage.setItem(chaveDaLoja, JSON.stringify(r.loja));
          } catch {
            // Sem armazenamento, a loja vale enquanto a tela está aberta.
          }
        }
        const bruta = (r as { paperWidthMm?: unknown; paper_width_mm?: unknown }).paperWidthMm
          ?? (r as { paper_width_mm?: unknown }).paper_width_mm;
        const n = Number(bruta);
        if (n === 58 || n === 80) {
          setLarguraDoCupom(n);
          try {
            localStorage.setItem(chaveDaLargura, String(n));
          } catch {
            // Sem armazenamento, a largura vale enquanto a tela está aberta.
          }
        }
      })
      // Sem resposta, a tela não afirma nada sobre a gaveta — o silêncio é
      // melhor do que um palpite sobre hardware.
      .catch(() => undefined);
    return () => {
      vivo = false;
    };
    // As chaves da largura e da loja são texto derivado da empresa: listá-las só relê a gaveta se mudarem de fato.
  }, [terminalDoCaixa, chaveDaLargura, chaveDaLoja]);

  // Fechamento: modal de pagamento e liberação gerencial.
  const [showPayment, setShowPayment] = useState(false);
  const [paymentError, setPaymentError] = useState<string | null>(null);
  const [showAuth, setShowAuth] = useState(false);
  const [authReason, setAuthReason] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [authorizationId, setAuthorizationId] = useState<string | null>(null);
  const [pendingPayments, setPendingPayments] = useState<PaymentLine[] | null>(null);
  /**
   * A TENTATIVA QUE JÁ REGISTROU OUTRA VENDA (RES-IDEM-TELA).
   *
   * A venda foi criada, mas a tela recebeu um erro que não é de rede (um 500
   * depois do commit): o carrinho ficou com a MESMA chave, o caixa mexeu nele
   * e finalizou de novo. O servidor recusa com 422 CORE_IDEMPOTENCY_KEY_REUSED
   * — a mesma chave com outra mercadoria — e nada registra.
   *
   * Aqui fica o que o caixa precisa para escolher: qual venda a tentativa já
   * registrou, e o pagamento que ele tinha acabado de montar, para
   * "Registrar como venda nova" reenviar exatamente a mesma finalização com
   * chave nova. Sem a escolha, nada é reenviado.
   */
  const [tentativaReusada, setTentativaReusada] = useState<{
    saleId: string | null;
    saleNumber: number | null;
    reenvio: {
      payments: PaymentLine[];
      authId: string | null;
      surchargeCents: number;
      customerCreditCents: number;
    };
  } | null>(null);
  /** "Ver a venda #N": o que ela registrou, lido do servidor (aberto ao balcão). */
  const [vendaDaTentativa, setVendaDaTentativa] = useState<SaleDetail | 'carregando' | 'erro' | null>(null);
  // `busy` é estado de render e chega atrasado ao handler; o ref barra o
  // segundo clique no mesmo tick.
  const busyRef = useRef(false);

  // Pré-venda aberta no balcão (F9). Enquanto houver uma, o carrinho pertence
  // a ela: a finalização fatura a conversão, não uma venda nova.
  const [loadedQuote, setLoadedQuote] = useState<Quote | null>(() => rascunhoInicial?.loadedQuote ?? null);
  const [showQuotes, setShowQuotes] = useState(false);
  const [quotes, setQuotes] = useState<Quote[] | null>(null);

  // Última venda fechada, para imprimir o comprovante sem sair da tela.
  // Reimprimir NÃO refaz a venda: cria só um job novo para o mesmo documento.
  const [lastSaleId, setLastSaleId] = useState<string | null>(null);
  /** O que o Finalizar fez com a NFC-e desta venda (GAP-PRD-163). */
  const [disparoFiscal, setDisparoFiscal] = useState<DisparoDaNfce | null>(null);
  // Muda a cada venda fechada: é o gatilho para o selo fiscal reconferir as
  // pendências, sem precisar de um poll próprio na tela mais usada da loja.
  const [fiscalTick, setFiscalTick] = useState(0);

  /*
    A VENDA QUE ACABOU DE SER CONCLUÍDA — a tela de pós-pagamento.

    O Finalizar fechava tudo em silêncio e, com agente local, imprimia sozinho.
    Agora a tela mostra número, total, pagamentos, troco e a situação fiscal, e
    o OPERADOR escolhe: Enter imprime, Esc segue para a próxima venda.
  */
  const [concluida, setConcluida] = useState<VendaNaTela | null>(null);
  const [imprimindoConcluida, setImprimindoConcluida] = useState(false);
  const [erroDaImpressao, setErroDaImpressao] = useState<string | null>(null);
  /** O item da lista de resultados em destaque — ↑↓ escolhem, Enter põe no carrinho. */
  const [destaque, setDestaque] = useState(0);
  /** O termo que produziu a lista na tela: Enter só escolhe da lista se o termo não mudou. */
  const termoDosResultados = useRef('');
  /*
    A FILA DAS LEITURAS E O CARRINHO "DE AGORA" (D-pdv-teclado-01/02).

    `linhasRef` é o carrinho da última renderização: é por ela que o Finalizar,
    depois de esperar a leitura em curso, sabe o que vai vender, e por ela que
    uma leitura sabe o que já está no carrinho. `filaDeLeitura` põe as buscas
    uma atrás da outra; `leiturasPendentes` é o que cada leitura no ar
    escreveu no campo; `vendaEmCurso` é o POST do Finalizar no ar.
  */
  const linhasRef = useRef<CartLine[]>(lines);
  const loadedQuoteRef = useRef<Quote | null>(loadedQuote);
  const concluidaRef = useRef<VendaNaTela | null>(null);
  const filaDeLeitura = useRef<Promise<void>>(Promise.resolve());
  const leiturasPendentes = useRef<string[]>([]);
  const vendaEmCurso = useRef<Promise<void> | null>(null);
  /** A quantidade da linha quando o campo dela ganhou o foco (D-pdv-teclado-07). */
  const qtdNaEntrada = useRef<Record<string, number>>({});
  const runSearchRef = useRef<((comPecas?: boolean, codigo?: string) => Promise<void>) | null>(null);

  /** Põe a tarefa na fila das leituras: uma de cada vez, e a falha de uma não trava as próximas. */
  const enfileirar = useCallback((tarefa: () => Promise<unknown>): Promise<void> => {
    const proxima = filaDeLeitura.current.then(() => tarefa()).then(
      () => undefined,
      () => undefined,
    );
    filaDeLeitura.current = proxima;
    return proxima;
  }, []);

  /*
    O RASTRO "DE AGORA" E AS LEITURAS QUE NÃO ENTRARAM (revisão de
    D-pdv-teclado-02/07).

    `removidosRef` é o rastro de cancelados da última renderização: o Finalizar
    o lê DEPOIS de fechar as reduções ainda em digitação no campo da linha
    (`fecharReducoesEmDigitacao`) — o `removidos` do fechamento é o de antes
    delas. `leiturasSemItem` conta as leituras que terminaram SEM pôr item no
    carrinho (não encontrado, lista, peça esperando a pergunta, falha): o
    Finalizar que esperou uma leitura e a viu acabar assim não fecha a venda
    sem o item.
  */
  const removidosRef = useRef<ItemRemovidoDoCarrinho[]>(removidos);
  const leiturasSemItem = useRef(0);

  /** F6 com carrinho montado pergunta antes de apagar (D-pdv-teclado-12). */
  const [confirmarCancelamento, setConfirmarCancelamento] = useState(false);
  /**
   * A venda cuja NFC-e a tela está acompanhando — separada da tela de venda
   * concluída de propósito (F-cupom-fiscal-01): o caixa fecha aquela tela com o
   * próximo bipe em um segundo, e a rejeição que chega depois precisa aparecer
   * mesmo assim.
   */
  /*
    AS ÚLTIMAS VENDAS VIGIADAS, E NÃO SÓ A ÚLTIMA (PED-pdv-07).

    Era uma venda só: se outra venda fechava enquanto a nota da anterior ainda
    ia à SEFAZ, a vigília passava para a nova e a rejeição da anterior nunca
    aparecia no balcão — a venda ficava sem nota e ninguém sabia. Agora são as
    cinco últimas com NFC-e disparada, cada uma com a sua vigília.
  */
  const [vendasVigiadas, setVendasVigiadas] = useState<{ saleId: string; numero: number }[]>([]);
  /**
   * As NFC-e que ficaram SEM nota (rejeitadas, ou em erro sem nova tentativa).
   *
   * Ficam numa faixa própria, fora do painel fiscal — que só aparece com o
   * carrinho vazio e some no primeiro bipe do próximo cliente. Cada uma sai
   * quando o operador diz que viu; uma não apaga a outra (PED-pdv-07).
   */
  const [notasSemNota, setNotasSemNota] = useState<
    { saleId: string; numero: number | string | null; estado: 'rejeitada' | 'erro'; motivo: string }[]
  >([]);

  /*
    A FILA DA OFICINA (GAP-PRD-042).

    Só é pedida por quem pode receber OS — a rota recusa os outros, e pedir
    para ouvir 403 em toda abertura do PDV da loja seria ruído. A resposta diz
    se a empresa tem bancada; sem bancada, o botão nem aparece. Falha calada:
    o balcão continua vendendo, e o pior caso é o botão não aparecer.
  */
  const recebeOs = useHasProfile('operador_caixa_oficina', 'gerente_oficina');
  const [filaOs, setFilaOs] = useState<FilaDeRecebimento | null>(null);
  const [showOsAReceber, setShowOsAReceber] = useState(false);
  /** O balcão da oficina recebe o aparelho do cliente e abre a OS (GAP-PRD-099). */
  const [showAbrirOs, setShowAbrirOs] = useState(false);
  const carregarFilaOs = useCallback(() => {
    if (!recebeOs) return;
    void oficinaCaixaApi
      .fila()
      .then(setFilaOs)
      .catch(() => setFilaOs(null));
  }, [recebeOs]);
  useEffect(() => {
    carregarFilaOs();
  }, [carregarFilaOs]);

  /*
    O SUBTOTAL USA O PREÇO QUE A VENDA VAI COBRAR, e não o que está na linha.

    Em produto de preço fechado o servidor aplica teto no preço vigente: digitar
    R$ 500 num item de R$ 400 fecha a venda por R$ 400. Somando `unitPriceCents`
    a tela prometia R$ 500 ao cliente, cobrava R$ 400 no comprovante, e a
    diferença aparecia como "erro do sistema" para quem estava no balcão.
    `unitarioCobradoCents` é a mesma regra do servidor, escrita uma vez só.
  */
  // O desconto de LINHA abate no subtotal, como no servidor (total da linha =
  // unitário × quantidade − desconto). A conta mora em `contasDoCarrinho`,
  // que o Finalizar também usa.
  const contas = contasDoCarrinho(lines, descontoTexto);
  const subtotal = contas.subtotal;
  /*
    OS CENTAVOS DO DESCONTO DE RODAPÉ, derivados do texto digitado.

    Derivado, e não guardado: com "10%" no campo, o valor precisa acompanhar o
    carrinho. É uma PRÉVIA como todo número desta tela — quem decide o total é
    o servidor, e é o total DELE que aparece na mensagem de venda fechada.
  */
  const discount = contas.discount;
  const total = contas.total;
  const itemCount = lines.reduce((acc, l) => acc + l.quantity, 0);
  /** O que o rodapé conta: a QUANTIDADE removida, não o número de cliques. */
  const itensCancelados = removidos.reduce((acc, r) => acc + r.quantity, 0);

  /*
    A CONCESSÃO NA TELA, ANTES DE FECHAR.

    Recalculada a cada mudança do carrinho porque é isso que a torna útil: o
    número aparece quando o item entra, e não quando o Finalizar é recusado com
    o cliente esperando. A palavra final continua sendo do servidor — ver
    `finalize`, onde a recusa dele substitui esta prévia pelos números dele.
  */
  const concessao = useMemo(() => concessaoPrevista(lines, discount), [lines, discount]);

  /**
   * O limite desta operação, lido do servidor.
   *
   * Nulo enquanto não chegou, e nulo se a leitura falhar — e nesse caso o
   * painel mostra a concessão SEM dizer se passou do limite. Chutar 10% aqui
   * seria reintroduzir no frontend exatamente a constante que esta rodada tirou
   * do servidor, e ela mentiria para toda loja que configurou outro valor.
   */
  const [limitePercent, setLimitePercent] = useState<number | null>(null);
  /** A operação exige o motivo na liberação de desconto (P0 da Preço Justo). */
  const [motivoObrigatorio, setMotivoObrigatorio] = useState(false);
  /**
   * A recusa do servidor, com os números DELE.
   *
   * Enquanto existe, é ela que manda no painel: a prévia é uma estimativa da
   * tela, e a recusa é o fato. Mostrar as duas ao mesmo tempo com valores
   * diferentes seria a tela discutindo consigo mesma na frente do cliente.
   */
  const [recusaDeAlcada, setRecusaDeAlcada] = useState<DetalheDeConcessao | null>(null);
  /**
   * Produto que o servidor recusou por não ter preço, com a mensagem dele.
   *
   * Estado separado da mensagem geral porque esta recusa tem AÇÃO: a linha
   * ofensora fica marcada no carrinho e há um botão para tirá-la de lá. Uma
   * faixa vermelha genérica no topo deixaria o operador procurando qual dos
   * doze itens está sem preço.
   */
  const [recusaSemPreco, setRecusaSemPreco] = useState<
    {
      productId: string | null;
      texto: string;
      /**
       * Qual recusa aponta a linha. `nao_vendavel` é o produto inativado (ou
       * arquivado) entre o bipe e o Finalizar (G-offline-sync-09#pdv): a
       * marca e o "Tirar do carrinho" são os mesmos, o título não. Ausente é
       * a do produto sem preço, a de sempre.
       */
      motivo?: 'sem_preco' | 'nao_vendavel';
    } | null
  >(null);
  /**
   * A recusa de DESCONTO do servidor (`CORE_INVALID_DISCOUNT`), com a linha.
   *
   * Estado próprio pelo mesmo motivo de `recusaSemPreco`: esta recusa TEM ação.
   * Ela caía no ramo genérico do `finalize` — faixa vermelha com a frase
   * "Desconto maior que o valor do item." e nada marcado no carrinho —, e o
   * operador com doze linhas na tela e o cliente na frente ia procurar em qual
   * delas está o problema.
   *
   * `productIds` VAZIO é um estado HONESTO e diferente: o servidor não nomeou a
   * linha e a conta da tela também não achou nenhuma fora do teto. Aí a faixa
   * diz quais linhas TÊM desconto, que reduz a busca sem marcar a errada —
   * marcar por chute mandaria consertar o que não está quebrado.
   *
   * É uma LISTA, e não uma linha só, porque estourar duas ao mesmo tempo é um
   * carrinho perfeitamente possível. Antes, a tela só marcava quando achava
   * EXATAMENTE uma (`achadas.length === 1`) e, com duas, desistia das duas — o
   * operador voltava a receber uma frase e doze linhas para conferir, com o
   * cliente na frente. O `=== 1` não era prudência: achar duas pela MESMA conta
   * do servidor não é chute nenhum, é a resposta certa duas vezes. Prudência é
   * o caso ZERO, e esse continua igual.
   */
  const [recusaDeDesconto, setRecusaDeDesconto] = useState<
    { productIds: string[]; texto: string; comDesconto: string[] } | null
  >(null);

  /**
   * A LINHA CORRIGIDA SAI DA MARCAÇÃO — e as outras continuam marcadas.
   *
   * A recusa descreve o carrinho de ANTES da correção, e deixá-la inteira na
   * tela enquanto a pessoa arruma o valor é descrever um estado que já não
   * existe. Mas apagar a faixa toda ao corrigir UMA de duas linhas apagaria
   * junto a marca da outra, que continua quebrada — o defeito que a lista veio
   * fechar, recomeçando pelo outro lado. Some quando não sobra nenhuma.
   */
  const desmarcarLinhaDaRecusa = useCallback((productId: string) => {
    setRecusaDeDesconto((r) => {
      if (!r || !r.productIds.includes(productId)) return r;
      const restantes = r.productIds.filter((id) => id !== productId);
      return restantes.length === 0 ? null : { ...r, productIds: restantes };
    });
  }, []);
  /**
   * O que está digitado no preço DA LINHA, por produto, como texto.
   *
   * Texto e não centavos porque é um campo em digitação: "1.2" e "1," são
   * estados intermediários legítimos de quem está escrevendo 1.250,00, e
   * guardar só o número convertido apagaria a vírgula debaixo do dedo da
   * pessoa. Os centavos da venda continuam morando na linha do carrinho — este
   * mapa é só o rascunho da tela, e por isso some com a venda.
   */
  const [precoDaLinha, setPrecoDaLinha] = useState<Record<string, string>>({});

  /**
   * A gaveta de outro dia que já abriu o diálogo sozinha (H-caixa-seguranca-06).
   * Guarda o id da sessão: o aviso sobe uma vez por gaveta, na entrada ou na
   * releitura por foco — nunca a cada volta de foco.
   */
  const avisoDeOutroDia = useRef<string | null>(null);
  /**
   * Algum diálogo da venda está na tela AGORA (revisão do H-caixa-seguranca-06),
   * e o aviso da gaveta de outro dia que ficou para quando ele fechar.
   *
   * A releitura por foco chega no meio do pagamento — o operador volta do
   * aplicativo da maquininha. Subir o diálogo do caixa ali o punha no topo da
   * pilha de foco POR TRÁS do pagamento: o `PagamentoDialog` só responde às
   * teclas quando está no topo (`estaNoTopo`), e o F10/Esc do pagamento
   * paravam, com o foco num diálogo que não se via. O aviso espera o diálogo
   * fechar e sobe numa releitura nova (efeito logo abaixo de `recarregarCaixa`).
   */
  const algumDialogoAbertoRef = useRef(false);
  const avisoDeOutroDiaAdiado = useRef(false);

  /**
   * Relê a gaveta do balcão.
   *
   * @param primeiraEntrada abre o diálogo sozinho quando não há caixa. Só na
   * entrada: subir a tela de abertura por cima de um atendimento em curso, a
   * cada volta de foco, seria pior que o problema.
   */
  const recarregarCaixa = useCallback((primeiraEntrada = false) => {
    void coreApi
      // O caixa que ESTE computador guardou (GAP-PRD-039). Com token de
      // dispositivo o servidor ignora e usa o do token.
      .getOpenCash(caixaDesteComputador(empresaDaSessao))
      .then((r) => {
        setCash(r.session);
        setTetoSangriaCents(r.cashWithdrawalLimitCents);
        setCaixaConhecido(true);
        setCaixaNaoConfirmado(false);
        setErroDoCaixa(null);
        // A resposta do servidor é a lembrança que vale na próxima queda
        // (G-offline-sync-02); "sem sessão" apaga a lembrança.
        gravarUltimoCaixa(
          empresaDaSessao,
          r.session
            ? { session: r.session, terminal: r.terminal ?? null, confirmadoEm: new Date().toISOString() }
            : null,
        );
        setCaixaDoComputador({
          terminal: r.terminal ?? null,
          terminalDoDispositivo: r.terminalDoDispositivo ?? false,
          terminalRecusado: r.terminalRecusado ?? null,
          terminaisAtivos: r.terminaisAtivos ?? 0,
          exigeTerminal: r.exigeTerminal ?? false,
          deOutroDia: r.deOutroDia ?? null,
        });
        // O caixa guardado não vale mais (desligado, ou de outra operação):
        // esquecê-lo é o que faz a escolha voltar a ser pedida.
        if (r.terminalRecusado && !r.terminalDoDispositivo && empresaDaSessao) {
          guardarCaixaDesteComputador(empresaDaSessao, null);
        }
        /*
          A GAVETA DE OUTRO DIA TAMBÉM ABRE O DIÁLOGO NA ENTRADA (GAP-PRD-131):
          o primeiro gesto do dia, com a gaveta de agosto aberta, é contar e
          fechar — não vender em cima dela.

          E NA RELEITURA POR FOCO (H-caixa-seguranca-06#pdv). O DEFEITO: a regra
          valia só com `primeiraEntrada`. O computador do balcão que ficou ligado
          a noite toda nunca remonta o PDV: a gaveta de ontem virava "de outro
          dia" à meia-noite, o operador voltava de manhã, o foco relia a gaveta
          — e a tela seguia vendendo em cima dela, só com a faixa. Agora a
          primeira leitura que vê a gaveta como de outro dia abre o diálogo,
          venha da entrada ou do foco. UMA vez por gaveta (`avisoDeOutroDia`):
          fechar o diálogo é decisão do operador, e reabri-lo a cada volta de
          foco seria a tela de caixa por cima de todo atendimento.
        */
        if (r.session && r.deOutroDia && avisoDeOutroDia.current !== r.session.id) {
          // Com um diálogo da venda na tela, o aviso fica para quando ele fechar
          // (ver `algumDialogoAbertoRef`): a gaveta NÃO é dada por avisada.
          if (algumDialogoAbertoRef.current) {
            avisoDeOutroDiaAdiado.current = true;
          } else {
            avisoDeOutroDia.current = r.session.id;
            setShowCaixa(true);
          }
        }
        /*
          SEM CAIXA, O PDV JÁ ABRE A TELA DE ABERTURA — auditoria de entrega.

          Abrir o caixa é o primeiro gesto do dia, e ele estava escondido atrás
          de um botão numa faixa de aviso. O preço de não achá-lo era alto: o
          PDV vendia com o caixa fechado, e o dinheiro entrava sem gaveta
          nenhuma — no fim do dia o operador conta as notas e o sistema não
          sabe de onde vieram.

          O diálogo sobe uma vez, na entrada. Fechá-lo é decisão do operador
          (ele pode querer só consultar um preço), e a faixa continua ali.
        */
        if (primeiraEntrada && !r.session) setShowCaixa(true);
      })
      .catch((err: unknown) => {
        // Falhou a consulta: o PDV não sabe da gaveta — e não sabendo, não
        // impede a venda. Travar o balcão por rede caída seria pior que o
        // problema que a trava resolve.
        setCaixaConhecido(false);
        /*
          SÓ A FALTA DE SERVIDOR USA A LEMBRANÇA (PED-pdv-09).

          O DEFEITO: este `catch` tratava QUALQUER erro como servidor
          inalcançável. Um 403 (o perfil não lê a gaveta), um 500 (erro da API)
          ou uma recusa com código punham "(não confirmado — servidor fora de
          alcance)" no cabeçalho — o servidor tinha respondido — e, na montagem,
          a tela punha na tela a gaveta da lembrança, que vale 18 h e pode ter
          sido fechada em OUTRA máquina. Agora só a falha de rede (e o
          502/503/504 do proxy na frente da API caída, que é a mesma coisa vista
          de fora — `semServidor`) usa a lembrança. A resposta com erro vai para
          a faixa como veio, e a lembrança não vira gaveta. A gaveta que JÁ
          estava na tela veio de uma resposta boa do servidor e fica (ver
          D-pdv-teclado-20 abaixo), marcada como não confirmada.
        */
        if (!semServidor(err)) {
          setCaixaNaoConfirmado(false);
          setErroDoCaixa(
            err instanceof ApiRequestError && err.message
              ? `o servidor recusou a consulta do caixa: ${err.message}`
              : 'o servidor não conseguiu informar o caixa. Tente de novo em instantes.',
          );
          setTetoSangriaCents(null);
          return;
        }
        setErroDoCaixa(null);
        setCaixaNaoConfirmado(true);
        /*
          SEM A GAVETA NA TELA, VALE A ÚLTIMA QUE O SERVIDOR CONFIRMOU
          (G-offline-sync-02). Na montagem durante a queda (o F5, o navegador
          reaberto) a tela nascia sem gaveta e sem caixa: a venda ia para a fila
          com `cashSessionId` e `terminalId` nulos. A gaveta que JÁ estava na
          tela continua a mesma — o `atual ??` não a troca por uma lembrança.
        */
        const ultimo = lerUltimoCaixa(empresaDaSessao);
        if (ultimo) {
          setCash((atual) => atual ?? ultimo.session);
          setCaixaDoComputador((atual) =>
            atual ?? {
              terminal: ultimo.terminal,
              terminalDoDispositivo: false,
              terminalRecusado: null,
              terminaisAtivos: ultimo.terminal ? 1 : 0,
              exigeTerminal: false,
              deOutroDia: null,
            },
          );
        }
        /*
          A GAVETA QUE A TELA JÁ CONHECIA CONTINUA NA TELA (D-pdv-teclado-20).

          Era `setCash(null)`: uma piscada de rede na volta do foco da janela
          (a janela de impressão fechando) zerava o caixa, e o escopo da espera
          — que é o id da sessão — virava "sem caixa": as esperas do turno
          sumiam da faixa como se perdidas, e uma espera feita nessa janela ia
          para o escopo errado. Só uma resposta DO SERVIDOR dizendo "não há
          sessão" zera a gaveta; a falha da consulta só diz que a tela não
          conseguiu confirmar. O servidor resolve a gaveta sozinho no Finalizar.
        */
        // Sem resposta, sem teto conhecido — e a tela do caixa deixa de
        // prometer um número que não tem. Chutar zero aqui faria toda sangria
        // pedir gestor numa loja que nunca configurou trava nenhuma.
        setTetoSangriaCents(null);
      });
  }, [empresaDaSessao]);

  /** O operador disse qual caixa é este computador (ou pediu para trocar). */
  const escolherCaixa = useCallback(
    (terminalId: string | null) => {
      if (empresaDaSessao) guardarCaixaDesteComputador(empresaDaSessao, terminalId);
      setCash(null);
      recarregarCaixa();
    },
    [empresaDaSessao, recarregarCaixa],
  );

  useEffect(() => {
    recarregarCaixa(true);
  }, [recarregarCaixa]);

  /*
    O PDV DO BALCÃO FICA ABERTO O DIA INTEIRO — e a gaveta muda por baixo dele.

    A leitura acontecia uma vez só, na montagem. A gaveta é de UM CAIXA (a
    única da empresa, ou a do caixa deste computador desde o GAP-PRD-039), e
    outra máquina mexe nela: o gerente fecha o turno de outra máquina, ou de outra aba, e esta
    tela continua achando que a gaveta está aberta pelo resto do dia — mandando
    `cashSessionId` de uma sessão fechada, que o servidor recusa com o cliente
    na frente.

    A volta do foco é o momento certo de reler: é quando o operador volta do
    outro programa, da outra aba, da tela bloqueada.
  */
  useEffect(() => {
    const aoVoltar = () => recarregarCaixa();
    // A aba que volta a ficar visível (a tela bloqueada, outra aba) também relê.
    const aoAparecer = () => {
      if (document.visibilityState === 'visible') recarregarCaixa();
    };
    window.addEventListener('focus', aoVoltar);
    document.addEventListener('visibilitychange', aoAparecer);
    return () => {
      window.removeEventListener('focus', aoVoltar);
      document.removeEventListener('visibilitychange', aoAparecer);
    };
  }, [recarregarCaixa]);

  /*
    ABRIR O CAIXA RELÊ A GAVETA (H-caixa-seguranca-M01).

    O PDV do balcão fica em primeiro plano o dia inteiro: a volta do foco nunca
    acontece. Com o turno fechado em outra máquina, o F3 abria o diálogo com
    "Caixa aberto" de uma sessão já fechada e sem "Abrir caixa" — sangria e
    fechamento davam "Caixa já fechado". O diálogo passa a abrir com a gaveta de
    agora: quem vai mexer no dinheiro olha o estado do servidor, não o da manhã.
  */
  useEffect(() => {
    if (showCaixa) recarregarCaixa();
  }, [showCaixa, recarregarCaixa]);

  /*
    O AVISO DA GAVETA DE OUTRO DIA QUE ESPEROU O DIÁLOGO FECHAR (revisão do
    H-caixa-seguranca-06). Mesma lista do bloqueio dos atalhos de balcão (sem o
    próprio caixa, que já mostra o aviso quando aberto), mais a venda concluída.
    Fechado o último, a gaveta é relida — e é a resposta NOVA do servidor que
    decide, e não um "de outro dia" guardado de uma gaveta que pode ter mudado.
  */
  const algumDialogoAberto =
    showPayment || showAuth || showQuotes || showNota || showPesquisa || showClientes || showOsAReceber
    || showAbrirOs || Boolean(tentativaReusada) || confirmarCancelamento || Boolean(concluida);
  algumDialogoAbertoRef.current = algumDialogoAberto;
  useEffect(() => {
    if (algumDialogoAberto || !avisoDeOutroDiaAdiado.current) return;
    avisoDeOutroDiaAdiado.current = false;
    recarregarCaixa();
  }, [algumDialogoAberto, recarregarCaixa]);

  /*
    `/core/sales/discount-policy` e NÃO `/core/sale-policies`: a segunda exige
    perfil de gerente (é onde a política é EDITADA), e quem está no PDV é o
    caixa. Esta responde para o operador e já traz o limite da OPERAÇÃO, que é
    o mesmo número que a venda vai aplicar.
  */
  useEffect(() => {
    void coreApi
      .discountPolicy()
      .then((p) => {
        // O percentual DESTA pessoa quando o perfil tem um (P0 da Preço Justo);
        // sem ele, o da operação — o mesmo número que a venda vai aplicar.
        setLimitePercent(p.limiteDoPerfil?.percentual ?? p.operatorLimitPercent);
        setMotivoObrigatorio(p.motivoObrigatorio === true);
      })
      // Sem o limite, o painel continua mostrando quanto está sendo concedido
      // — que já é mais do que o balcão tinha antes — e só deixa de opinar
      // sobre gestor.
      .catch(() => setLimitePercent(null));
  }, []);

  /*
    ----------------------------------------- O PREÇO DO CLIENTE, POR CLASSE

    O revendedor tem desconto combinado. Desde esta rodada ele é o preço
    VIGENTE — e vigente que depende de QUEM compra tem um problema de ordem:
    no PDV o cliente é escolhido depois dos itens tanto quanto os itens entram
    depois do cliente.

    Este efeito não sabe nem quer saber por qual caminho a linha entrou. Ele
    olha a marca `precificadaPara` de cada uma e reprecifica as que não batem
    com o cliente do carrinho — bipe de identidade, pré-venda carregada, venda
    retomada da espera, produto de preço aberto, e o caminho que ainda não foi
    escrito. Fechar a CLASSE é o que impede o quinto caso de nascer aberto.

    O preço vem do servidor, sempre: `POST /core/pricing/cart` chama o mesmo
    `PricingService` que a venda usa para conferir. Uma segunda conta aqui viria
    a divergir, e a divergência apareceria no balcão como venda recusada por
    alçada num carrinho que a tela mostrava dentro do limite.

    O carrinho VAZIO também consulta, e de propósito: é assim que a tela sabe
    anunciar "Atacado · -15%" antes do primeiro bipe, em vez de o operador ver
    o preço cair sozinho no primeiro item e achar que errou de tecla.
  */
  /** A pergunta de preço que está no ar — o Finalizar a espera (G-offline-sync-M01). */
  const precoNoAr = useRef<Promise<void> | null>(null);
  /**
   * A espera cuja reprecificação está no ar (G-offline-sync-07#pdv). A resposta
   * só vale para ESTA retomada: outra retomada, ou a venda limpa, a invalida.
   */
  const retomadaNoAr = useRef<string | null>(null);
  /**
   * Os produtos que a retomada está perguntando AGORA (G-offline-sync-07,
   * reauditoria). A espera volta sem a marca de preço, e as linhas dela ficam
   * pendentes: sem este cerco, este efeito repetiria no mesmo instante a
   * pergunta que `reprecificarRetomada` acabou de fazer. Só essas linhas são
   * puladas — a que entrar por bipe durante a ida continua sendo perguntada.
   */
  const produtosDaRetomada = useRef<ReadonlySet<string>>(new Set());
  const idDoCliente = clienteDaVenda(customer?.id);
  useEffect(() => {
    const emVoo = produtosDaRetomada.current;
    const pendentes = linhasParaReprecificar(lines, idDoCliente).filter((l) => !emVoo.has(l.product.id));
    // A condição já conhecida para ESTE cliente não é perguntada de novo: sem
    // esta guarda, o efeito se realimentaria a cada resposta.
    if (pendentes.length === 0 && condicao.para === idDoCliente) return;

    const pedidos = pendentes.map((l) => l.product.id);
    // A quantidade PERGUNTADA de cada linha (G-offline-sync-M01): a resposta
    // vale para ela, e a linha que mudou no caminho continua pendente.
    const quantidades = Object.fromEntries(pendentes.map((l) => [l.product.id, l.quantity]));
    let cancelado = false;
    const ida: Promise<void> = coreApi
      .priceCart({
        customerId: idDoCliente,
        items: pendentes.map((l) => ({ productId: l.product.id, quantity: l.quantity })),
      })
      .then((r) => {
        if (cancelado) return;
        /*
          RESPOSTA SEM `items` NÃO É RESPOSTA.

          Um proxy devolvendo HTML, uma versão do servidor sem esta rota, um 200
          vazio: o que chega aqui pode não ser o contrato. Tratar como sucesso
          derrubaria a tela inteira do balcão no meio de uma venda — e uma tela
          de PDV que some é pior do que qualquer preço errado. Cai no `catch`
          abaixo, que avisa e deixa as linhas pendentes.
        */
        if (!Array.isArray(r?.items)) {
          throw new ApiRequestError(
            'CORE_PRICING_BAD_SHAPE',
            'Resposta de preço em formato inesperado.',
            0,
          );
        }
        setCondicao({ para: idDoCliente, tabela: r.priceTable ?? null });
        if (pedidos.length > 0) {
          /*
            O TETO DO DESCONTO MUDA JUNTO COM O PREÇO — terceiro escritor da
            mesma classe (ver `comDescontoDentroDoTeto`). Uma tabela de atacado
            que baixa o item de R$ 10,00 para R$ 5,00 deixaria um desconto de
            linha de R$ 30,00 acima do que a linha cobra, e a venda morreria no
            Finalizar com `CORE_INVALID_DISCOUNT`.
          */
          /*
            `flushSync`: o Finalizar que esperou esta resposta lê o carrinho pela
            ref logo depois (G-offline-sync-M01) — sem a renderização síncrona,
            ele leria as linhas de ANTES do preço da faixa.
          */
          flushSync(() => {
            setLines((prev) =>
              aplicarPrecificacao(prev, r, idDoCliente, pedidos, quantidades).map(comDescontoDentroDoTeto),
            );
          });
          // E o rascunho do campo morre junto, para o número exibido ser o que
          // a venda leva (mesmo motivo de `esquecerODescontoDigitado`).
          setDescontoDaLinha((prev) => {
            const proximo = { ...prev };
            for (const id of pedidos) delete proximo[id];
            return proximo;
          });
        }
      })
      .catch((err) => {
        if (cancelado) return;
        /*
          FALHOU: as linhas ficam PENDENTES, e não marcadas.

          Marcá-las seria afirmar que o preço da tela é o preço do cliente
          quando ninguém confirmou isso — e o operador fecharia a venda pelo
          valor errado sem nada na tela dizendo o contrário. Deixando-as
          pendentes, o próximo item bipado (ou a próxima troca de cliente)
          tenta de novo, e enquanto isso a mensagem diz o que está em jogo.
          A palavra final continua sendo do servidor no fechamento.
        */
        // Sem cliente, o que se pergunta é a faixa por quantidade — a frase diz
        // qual das duas ficou sem conferir (G-offline-sync-M01).
        const oQue = idDoCliente ? 'o preço do cliente' : 'o preço por quantidade';
        setMessage({
          tone: 'error',
          text: isNetworkFailure(err)
            ? `Sem conexão com o servidor da loja — ${oQue} não foi conferido. A venda confere no Finalizar.`
            : err instanceof ApiRequestError
              ? `Não foi possível aplicar ${oQue}: ${err.message}`
              : `Não foi possível aplicar ${oQue}. Confira os valores antes de fechar.`,
        });
      });
    precoNoAr.current = ida;
    void ida.finally(() => {
      if (precoNoAr.current === ida) precoNoAr.current = null;
    });
    return () => {
      cancelado = true;
    };
  }, [lines, idDoCliente, condicao]);

  /**
   * O PREÇO DO CARRINHO EM DIA ANTES DE COBRAR (G-offline-sync-M01).
   *
   * O Finalizar (F8) e o pagamento (F10) liam o total com a linha ainda no
   * preço de UMA unidade quando o terceiro bipe acabava de entrar: o débito
   * passava R$ 12,00 e o servidor, com a faixa, fechava por R$ 9,99 — e recusava.
   * Aqui eles esperam a pergunta de preço que está no ar e, sobrando linha
   * pendente (o efeito ainda não rodou), perguntam uma vez. Sem resposta (a
   * rede), seguem: quem decide é o servidor, e o balcão não para por isso.
   */
  const precoDoCarrinhoEmDia = useCallback(async (): Promise<void> => {
    // As esperas têm prazo: servidor travado não prende o Finalizar (ver
    // `PRAZO_DO_PRECO_ANTES_DE_COBRAR_MS`). A pergunta no ar nunca rejeita (o
    // efeito trata a falha); se ela nem voltou no prazo, perguntar de novo só
    // dobraria a espera — a venda segue.
    if (precoNoAr.current) {
      const voltou = await comPrazo(
        precoNoAr.current.then(() => true),
        PRAZO_DO_PRECO_ANTES_DE_COBRAR_MS,
      );
      if (!voltou) return;
    }
    const pendentes = linhasParaReprecificar(linhasRef.current, idDoCliente);
    if (pendentes.length === 0) return;
    const pedidos = pendentes.map((l) => l.product.id);
    const quantidades = Object.fromEntries(pendentes.map((l) => [l.product.id, l.quantity]));
    try {
      const r = await comPrazo(
        coreApi.priceCart({
          customerId: idDoCliente,
          items: pendentes.map((l) => ({ productId: l.product.id, quantity: l.quantity })),
        }),
        PRAZO_DO_PRECO_ANTES_DE_COBRAR_MS,
      );
      if (!Array.isArray(r?.items)) return;
      flushSync(() => {
        setLines((prev) =>
          aplicarPrecificacao(prev, r, idDoCliente, pedidos, quantidades).map(comDescontoDentroDoTeto),
        );
        setDescontoDaLinha((prev) => {
          const proximo = { ...prev };
          for (const id of pedidos) delete proximo[id];
          return proximo;
        });
      });
    } catch {
      // Sem resposta de preço, a venda segue: a palavra final é do servidor.
    }
  }, [idDoCliente]);

  /**
   * A tabela que está valendo AGORA, ou nada.
   *
   * Derivada em vez de guardada solta: a resposta anterior continua em
   * `condicao` por um instante depois de o cliente sair do carrinho, e mostrar
   * "Atacado · -15%" nesse intervalo faria o operador repetir ao próximo
   * cliente da fila um desconto que não está sendo aplicado.
   */
  const tabelaVigente = condicao.para === idDoCliente ? condicao.tabela : null;

  /**
   * APAGA OS RASCUNHOS DA LINHA — quantidade, valor combinado e desconto
   * (D-pdv-teclado-M02).
   *
   * O campo da linha mostra `rascunho ?? valor da linha`: o rascunho vence
   * enquanto existir. Três caminhos mexiam na linha sem apagá-lo — Alt+↑↓, a
   * nova leitura do mesmo produto e a remoção. Bipava ARROZ duas vezes, Alt+↑
   * (rascunho "3") e bipava de novo: a linha valia 4, o total cobrava 4, e o
   * campo mostrava 3 — o cliente conferia 3 e pagava 4. E o desconto "5,00"
   * de uma linha removida reaparecia escrito na linha nova do mesmo produto,
   * com o desconto de verdade em zero.
   */
  const esquecerRascunhos = useCallback((productId: string) => {
    const semEle = (prev: Record<string, string>) => {
      if (!(productId in prev)) return prev;
      const proximo = { ...prev };
      delete proximo[productId];
      return proximo;
    };
    setQtdDaLinha(semEle);
    setPrecoDaLinha(semEle);
    setDescontoDaLinha(semEle);
  }, []);

  const addProduct = useCallback(
    (
      product: Product,
      qty: number,
      priceOverride?: number,
      unidades?: ProductUnit[],
      /**
       * `manterCampo`: quem chama cuida do campo de leitura — é a leitura do
       * leitor, que tira do campo só o que ELA consumiu (D-pdv-teclado-01).
       */
      opcoes: { manterCampo?: boolean } = {},
    ): boolean => {
      /*
        COM DOCUMENTO NO BALCÃO, O BIPE NÃO ENTRA NO CARRINHO (revisão do
        D-pdv-teclado-R02).

        A conversão fatura o DOCUMENTO — ela manda pagamentos, unidades e a
        liberação, não as linhas. O item bipado por cima de uma pré-venda (ou a
        unidade somada a uma linha dela) aparecia no carrinho e no total da tela,
        e não era vendido; no F6, saía sem rastro. A tela recusa aqui e diz o
        caminho. A troca do chassi de uma linha do documento tem ramo próprio em
        `runSearch` e não passa por aqui.
      */
      const documentoNoBalcao = loadedQuoteRef.current;
      if (documentoNoBalcao) {
        setMessage({
          tone: 'error',
          text:
            `${rotuloDoDocumento(documentoNoBalcao.kind)} #${documentoNoBalcao.number} está no balcão, e o `
            + `documento é faturado como foi escrito: "${product.name}" não entraria na venda. Fature o `
            + 'documento e faça uma venda nova para este item, ou solte o documento (F6) e acrescente o item '
            + 'em Orçamentos.',
        });
        setQuantity('1');
        setUnitPrice('');
        return false;
      }
      /*
        O PREÇO DIGITADO NÃO SOME CALADO (D-pdv-teclado-21).

        Com o produto já no carrinho, a leitura só somava a quantidade e jogava
        fora o valor digitado em "Preço Unitário": o serviço de R$ 30,00 com a
        segunda unidade combinada a R$ 50,00 virava 2 × R$ 30,00, sem aviso. O
        carrinho tem uma linha por produto (a chave da linha e os rascunhos são
        por produto), então a tela recusa a soma e diz onde mudar o valor.
      */
      /*
        MEIA CAMISETA NÃO ENTRA NO CARRINHO (D-pdv-teclado-14).

        "2,5" no campo Quantidade (ou "0,5*código") num produto vendido por
        unidade entrava na linha: o total mostrava a metade do preço e a recusa
        do servidor (`CORE_QUANTITY_MUST_BE_INTEGER`) só vinha no Finalizar,
        com o cliente na frente. A tela recusa aqui, com a frase do servidor, e
        os campos voltam ao padrão para o próximo bipe.
      */
      if (!Number.isInteger(qty) && soVendeInteiro(product)) {
        setMessage({ tone: 'error', text: recusaDeFracao(product, qty) });
        setQuantity('1');
        setUnitPrice('');
        return false;
      }
      const jaNoCarrinho = linhasRef.current.find((l) => l.product.id === product.id);
      if (jaNoCarrinho && priceOverride !== undefined && priceOverride !== jaNoCarrinho.unitPriceCents) {
        setMessage({
          tone: 'error',
          text:
            `"${product.name}" já está nesta venda por ${formatCents(jaNoCarrinho.unitPriceCents)} cada. `
            + `Para cobrar outro valor, mude o valor na linha — o preço digitado (${formatCents(priceOverride)}) `
            + 'não foi somado.',
        });
        /*
          A leitura acabou SEM item: Quantidade e Preço Unitário voltam ao
          padrão (D-pdv-teclado-13, na revisão). O valor recusado ficava no
          campo e caía no PRÓXIMO produto bipado, virando preço digitado — e
          concessão. Ele continua escrito na faixa, para o caixa levar à linha.
        */
        setQuantity('1');
        setUnitPrice('');
        return false;
      }
      /*
        `flushSync`: a linha nova precisa estar NA TELA quando esta função volta
        (D-pdv-teclado-02). O Finalizar espera a leitura em curso e lê as linhas
        logo em seguida — sem a renderização síncrona, ele leria o carrinho de
        ANTES do bipe e a venda sairia sem o item.
      */
      flushSync(() => {
        /*
          O TROCO DO CLIENTE ANTERIOR SAI DA TELA QUANDO O PRÓXIMO ITEM ENTRA.

          A faixa central é o maior texto do PDV, em 26px, e mostra `message`
          enquanto ele existir. `message` só era zerado no começo de `finalize`:
          o primeiro item do próximo cliente entrava no carrinho com
          "TROCO R$ 47,25" ainda escrito acima dele — convite a devolver troco
          duas vezes.
        */
        setMessage(null);
        /*
          O PRIMEIRO ITEM DO PRÓXIMO CLIENTE APOSENTA O PAINEL DA VENDA ANTERIOR
          (PED-pdv-10).

          O painel fiscal só aparece com o carrinho vazio. Era o F6 que o
          apagava — inclusive o F6 por reflexo com o carrinho vazio, que sumia
          com o "emitir NFC-e" da venda que acabou de fechar. Agora é o começo
          do carrinho novo: tirar o único item com o ✕ não devolve à tela o
          painel (e o "Imprimir") de outro cliente (F-cupom-fiscal-M03).
        */
        if (linhasRef.current.length === 0) {
          setLastSaleId(null);
          setDisparoFiscal(null);
        }
        setLines((prev) => {
          const existing = prev.findIndex((l) => l.product.id === product.id);
          if (existing >= 0) {
            const next = [...prev];
            const linha = next[existing];
            next[existing] = {
              ...linha,
              // Soma em gramas, e não em ponto flutuante: duas etiquetas da
              // balança de 0,1 e 0,2 kg davam 0,30000000000000004 kg na linha
              // — e no corpo da venda (D-pdv-teclado-16).
              quantity: Math.round((linha.quantity + qty) * 1000) / 1000,
              unitIds: [...(linha.unitIds ?? []), ...(unidades ?? []).map((u) => u.id)],
              unitLabel: [linha.unitLabel, unidades?.map(rotuloDaUnidade).join(', ')]
                .filter(Boolean)
                .join(', '),
              unidadesSemPlaquinha:
                (linha.unidadesSemPlaquinha ?? 0) + contarSemPlaquinha(unidades),
            };
            return next;
          }
          return [
            ...prev,
            {
              product,
              quantity: qty,
              // O preço VIGENTE, não o de tabela: senão o balcão cobra cheio
              // enquanto a vitrine anuncia com desconto.
              unitPriceCents: priceOverride ?? product.effective_price_cents ?? product.price_cents,
              unitIds: unidades?.map((u) => u.id),
              unitLabel: unidades?.map(rotuloDaUnidade).join(', '),
              unidadesSemPlaquinha: contarSemPlaquinha(unidades),
              /*
                A LINHA NASCE PRECIFICADA PARA "SEM CLIENTE" — e é a verdade.

                O preço acima veio da busca do balcão, e a busca não conhece
                cliente nenhum: o servidor a responde com base e promoção, que é
                exatamente o que vale para uma venda sem cliente. Marcar `null` em
                vez de deixar indefinido evita uma ida ao servidor por item bipado
                no caso mais comum da loja, que é a venda de consumidor final.

                Havendo cliente, a marca não bate e a reprecificação entra —
                inclusive pelo bipe de identidade da peça, que chama por aqui.
              */
              precificadaPara: null,
              /*
                Preço digitado no campo "Preço Unitário" é negociação do balcão, e
                a reprecificação não a sobrescreve: ela apenas a limita ao novo
                vigente. Sem isto, escolher o cliente DEPOIS de combinar o valor
                apagaria o combinado — e é justamente com o cliente na frente que
                o operador digita o número.
              */
              precoDigitado: priceOverride !== undefined,
              // O combinado fica guardado à parte: é contra ELE que a
              // reprecificação mede o teto, e não contra o valor que ela mesma
              // reescreve. Ver `precoNegociadoCents`.
              precoNegociadoCents: priceOverride,
            },
          ];
        });
        if (!opcoes.manterCampo) setTerm('');
        setResults([]);
        setQuantity('1');
        setUnitPrice('');
        esquecerRascunhos(product.id);
      });
      /*
        O FISCAL INCOMPLETO NA FAIXA (P0 da Preço Justo).

        O item bipado entra direto, sem passar pela lista onde o distintivo
        aparece — e era aí que o operador ficava sem saber de nada até a NFC-e
        ser recusada, depois do pagamento. A venda continua (travar o balcão por
        cadastro pararia a loja); a faixa diz o que falta, na cor de atenção, e
        a linha do carrinho carrega o distintivo até o fim.
      */
      const aviso = avisoFiscalIncompleto(product);
      if (aviso) setMessage({ tone: 'error', text: aviso });
      searchRef.current?.focus();
      return true;
    },
    [esquecerRascunhos],
  );

  /**
   * Põe no carrinho já resolvendo QUAIS peças, quando o produto é serializado.
   *
   * As peças mais antigas são escolhidas por padrão — é o que o balcão faz na
   * prática, pegando a da frente — e a linha do carrinho MOSTRA o chassi ou o
   * IMEI, para o operador conferir contra o que está na mão. Se for outra, ele
   * bipa a identidade da peça certa na busca, que a acha direto.
   */
  const addProductResolvendoUnidade = useCallback(
    async (
      product: Product,
      qty: number,
      priceOverride?: number,
      opcoes: { manterCampo?: boolean } = {},
    ): Promise<boolean> => {
      if (product.serialized !== 1) {
        return addProduct(product, qty, priceOverride, undefined, opcoes);
      }
      try {
        const noEstoque = await coreApi.listUnits(product.id, 'in_stock');
        // A moto segurada por uma pré-venda é de outro cliente (GAP-PRD-111):
        // o balcão não a escolhe, e o servidor recusaria no Finalizar.
        const livres = unidadesLivres(noEstoque);
        /*
          A PEÇA QUE JÁ ESTÁ NESTA VENDA NÃO É ESCOLHIDA DE NOVO
          (D-pdv-teclado-22).

          Cada chamada pegava `livres.slice(0, qty)` sem olhar o carrinho: bipar
          duas vezes o mesmo celular (ou Enter duplo na lista durante a espera
          da consulta) punha a MESMA peça — o mesmo IMEI — duas vezes na linha,
          e o servidor recusava no Finalizar por peça repetida. As chamadas
          agora passam uma de cada vez (a fila de leitura) e a segunda enxerga
          a peça que a primeira pôs.
        */
        const naVenda = new Set(linhasRef.current.flatMap((l) => l.unitIds ?? []));
        const disponiveis = livres.filter((u) => !naVenda.has(u.id));
        if (disponiveis.length < qty) {
          const seguradas = noEstoque.length - livres.length;
          const jaNaVenda = livres.length - disponiveis.length;
          setMessage({
            tone: 'error',
            text:
              `"${product.name}" tem ${disponiveis.length} peça(s) livre(s) em estoque, e foram pedidas ${qty}.`
              + (jaNaVenda > 0 ? ` ${jaNaVenda} já está(ão) nesta venda.` : '')
              + (seguradas > 0 ? ` Outras ${seguradas} estão reservadas para pré-venda.` : ''),
          });
          // Leitura sem item: os campos não caem no próximo bipe (D-pdv-teclado-13).
          setQuantity('1');
          setUnitPrice('');
          return false;
        }
        return addProduct(product, qty, priceOverride, disponiveis.slice(0, qty), opcoes);
      } catch (err) {
        setMessage({
          tone: 'error',
          text:
            err instanceof ApiRequestError ? err.message : 'Não foi possível carregar as peças.',
        });
        return false;
      }
    },
    [addProduct],
  );

  /**
   * A etiqueta da balança no carrinho, com a quantidade que ELA traz
   * (D-pdv-teclado-16). A regra de quando entra direto mora em
   * `etiquetaDaBalancaUnica`; a conferência da etiqueta de preço, em
   * `recusaDaEtiquetaDaBalanca` (`pdvTypes.ts`).
   *
   * `qtdDigitada` é a do campo Quantidade (ou do "3*"). A etiqueta já traz o
   * peso: multiplicá-lo por um número digitado — ou pôr "2" onde a etiqueta
   * diz 0,352 kg — seria cobrar mercadoria que não está no balcão. Diferente
   * de 1, a etiqueta não entra, e a faixa diz por quê e o que fazer.
   */
  const entrarPelaEtiquetaDaBalanca = useCallback(
    async (
      achado: AchadoDaBalanca,
      qtdDigitada: number,
      precoCents: number | undefined,
      opcoes: { manterCampo?: boolean } = {},
    ): Promise<boolean> => {
      const recusar = (text: string): boolean => {
        setMessage({ tone: 'error', text });
        // Leitura sem item: os campos não caem no próximo bipe (D-pdv-teclado-13).
        setQuantity('1');
        setUnitPrice('');
        setResults([]);
        return false;
      };
      if (qtdDigitada !== 1) {
        return recusar(
          `A etiqueta da balança já traz a quantidade de "${achado.name}": a quantidade digitada `
          + `(${formatQuantity(qtdDigitada)}) não vale para ela, e o item não entrou. Para duas embalagens, `
          + 'bipe as duas etiquetas.',
        );
      }
      const unitario = precoCents ?? achado.effective_price_cents ?? achado.price_cents;
      const recusa = recusaDaEtiquetaDaBalanca(achado, unitario);
      if (recusa) return recusar(recusa);
      const kg = achado.balanca.quantidade as number;
      // Peça da bancada pesável continua perguntando, como pelo código.
      if (ehPecaDeBancada(achado)) {
        setPecaParaConfirmar({ product: achado, quantity: kg, precoCents });
        setResults([]);
        return false;
      }
      return addProductResolvendoUnidade(achado, kg, precoCents, opcoes);
    },
    [addProductResolvendoUnidade],
  );

  /**
   * `comPecas` chega por parâmetro quando quem chama é o próprio interruptor.
   *
   * Ler `incluirPecas` do fechamento devolveria o valor de antes do clique — a
   * primeira busca depois de ligar viria sem peça nenhuma, e a pessoa
   * concluiria que o interruptor não funciona.
   */
  /**
   * O que está digitado em "Preço Unitário", em centavos. Nulo se vazio.
   *
   * ESTAVA SÓ NUM DOS CAMINHOS, e por isso o campo funcionava pela metade: o
   * valor digitado ia para o carrinho quando o operador CLICAVA num resultado
   * da lista, e era jogado fora quando ele BIPAVA o código de barras — o gesto
   * mais comum do balcão. Como o produto de preço aberto (mão de obra, serviço)
   * tem preço zero no cadastro, bipá-lo o punha no carrinho a R$ 0,00 e a venda
   * era recusada com "digite o valor na linha" — uma instrução que a tela, por
   * aquele caminho, não deixava cumprir.
   *
   * `parseReaisToCents` no lugar de `Number(...) * 100`: o que estava lá virava
   * NaN em "1.250,00", e NaN atravessa as travas do servidor sem acionar
   * nenhuma. Vazio e ilegível caem no mesmo nulo — "usa o preço vigente".
   */
  const precoDigitadoCents = useCallback(
    (): number | undefined => parseReaisToCents(unitPrice) ?? undefined,
    [unitPrice],
  );

  /**
   * A quantidade pedida, como número — ou nulo, com o motivo na faixa.
   *
   * NÃO HÁ QUANTIDADE ZERO, NEGATIVA OU ASTRONÔMICA (D-pdv-teclado-07/05).
   * `Number(quantity) || 1` aceitava "-4": somado à linha existente, o bipe
   * TIRAVA quatro unidades da venda sem passar pelo rastro de cancelados — o
   * controle do GAP-V52 contornado por um campo. E sem teto, o código de barras
   * que caía no campo Quantidade virava 17 trilhões de unidades.
   */
  const lerQuantidade = useCallback((texto: string): number | null => {
    const n = texto.trim() === '' ? 1 : Number(texto.trim().replace(',', '.'));
    if (!Number.isFinite(n) || n <= 0) {
      setMessage({
        tone: 'error',
        text:
          'Quantidade inválida: use um número maior que zero. Para tirar item da venda, use o ✕ da '
          + 'linha — a saída fica no rastro de itens cancelados.',
      });
      return null;
    }
    if (n > QTD_MAXIMA_DA_LINHA) {
      setMessage({
        tone: 'error',
        text:
          `Quantidade ${formatQuantity(n)} passa do limite de ${formatQuantity(QTD_MAXIMA_DA_LINHA)} por item. `
          + 'Confira o campo Quantidade — um bipe pode ter caído nele.',
      });
      return null;
    }
    return n;
  }, []);

  /**
   * Tira do campo de leitura SÓ o que esta leitura consumiu
   * (D-pdv-teclado-01/04).
   *
   * `manter`: o texto fica, SELECIONADO — lista por texto (Enter e ↓ continuam
   * valendo) ou falha de rede (Enter tenta de novo). Selecionado, o próximo
   * bipe o SUBSTITUI em vez de se colar atrás dele: era assim que, depois de um
   * "não encontrado", cada bipe crescia o campo ("7890000000001" +
   * "7891234567895"…) e falhava de novo, até o operador largar o leitor.
   *
   * Se outra leitura já começou a chegar atrás desta, só o COMEÇO sai: os
   * dígitos do próximo produto ficam.
   */
  const consumirLeitura = useCallback((lido: string, manter: boolean) => {
    if (!lido) return;
    const noCampo = searchRef.current?.value ?? '';
    if (noCampo === lido) {
      if (manter) {
        searchRef.current?.select();
        return;
      }
      setTerm((t) => (t === lido ? '' : t.startsWith(lido) ? t.slice(lido.length) : t));
      return;
    }
    setTerm((t) => (t.startsWith(lido) ? t.slice(lido.length) : t));
  }, []);

  const runSearch = useCallback(
    (comPecas?: boolean, codigoDaRajada?: string): Promise<void> => {
      /*
        ==================================================================
        LEITURAS EM FILA, E O CAMPO SÓ PERDE O QUE FOI LIDO
        (D-pdv-teclado-01/11)
        ==================================================================

        O campo só era limpo quando a busca RESPONDIA, e nada impedia uma
        segunda leitura com a primeira no ar. Bipe A (a resposta demora), bipe
        B logo depois: os dígitos de B entravam atrás de A, o Enter buscava
        "AB", a resposta de A limpava o campo, a de "AB" dizia "Nenhum produto
        encontrado" — e B não entrava na venda. Se A respondesse NO MEIO da
        leitura de B, o `setTerm('')` apagava metade do código de B.

        Agora cada Enter separa o que é DELE: o começo do campo que pertence a
        leituras ainda no ar (`leiturasPendentes`) sai da conta, e o resto é a
        leitura nova. As buscas passam uma de cada vez (`enfileirar`), então a
        resposta velha nunca chega depois da nova nem carimba a lista errada; e
        cada uma, ao terminar, tira do campo só o próprio pedaço.

        `codigoDaRajada`: o código que um bipe escreveu no campo ERRADO e a tela
        desviou para cá (D-pdv-teclado-05). Ele não está no campo de leitura, e
        o campo não é tocado.
      */
      const doCampo = codigoDaRajada === undefined;
      const bruto = doCampo ? (searchRef.current?.value ?? term) : codigoDaRajada;
      const emCurso = doCampo ? leiturasPendentes.current.join('') : '';
      const lido = emCurso && bruto.startsWith(emCurso) ? bruto.slice(emCurso.length) : bruto;
      const digitado = lido.trim();
      if (!digitado) return Promise.resolve();
      // "3*7891234567895": três unidades do que for bipado — o jeito do balcão de
      // lançar quantidade sem tirar a mão do leitor.
      const comQuantidade = /^(\d+(?:[.,]\d+)?)\s*\*\s*(.+)$/.exec(digitado);
      const q = comQuantidade ? comQuantidade[2].trim() : digitado;
      /*
        QUANTIDADE E PREÇO UNITÁRIO SÃO DA PRIMEIRA LEITURA QUE OS ENCONTRA
        (revisão de D-pdv-teclado-01/13).

        Com a fila, a leitura B começa com a A ainda no ar — e os campos só
        voltam ao padrão quando A entra. B lia o MESMO "3" e o MESMO "R$ 5,00"
        que o caixa digitou para A: o segundo produto entrava com a quantidade e
        o preço do primeiro (e preço digitado vira concessão). Com leitura no
        ar, a nova vale uma unidade pelo preço vigente — ou o que vier no "3*".
      */
      const camposLivres = leiturasPendentes.current.length === 0;
      const qtdDigitada = lerQuantidade(comQuantidade ? comQuantidade[1] : camposLivres ? quantity : '1');
      if (qtdDigitada === null) {
        if (doCampo) searchRef.current?.select();
        return Promise.resolve();
      }
      if (comQuantidade) setQuantity(String(qtdDigitada));
      setPecaParaConfirmar(null);
      // O que vale para ESTA leitura é o que estava na tela no Enter — se
      // nenhuma leitura no ar chegou antes a ele.
      const precoCents = camposLivres ? precoDigitadoCents() : undefined;
      const incluir = comPecas ?? incluirPecas;
      /*
        A venda que está indo ao servidor AGORA (D-pdv-teclado-02). O bipe
        feito com o Finalizar no ar é do PRÓXIMO cliente: ele espera a venda
        voltar e o carrinho novo nascer, em vez de entrar no carrinho que o
        `clearSale` da resposta vai apagar — o item que aparecia e sumia, sem
        nunca ser vendido.
      */
      const vendaAntes = vendaEmCurso.current;
      if (doCampo) leiturasPendentes.current.push(lido);

      return enfileirar(async () => {
        let manterNoCampo = false;
        // A leitura pôs (ou trocou) item no carrinho? Sem isso, o Finalizar
        // que a esperou não fecha a venda (revisão de D-pdv-teclado-02).
        let entrou = false;
        try {
          const resposta = await coreApi.buscarNoBalcao(q, { includeParts: incluir });
          if (vendaAntes) await vendaAntes;
          const found = resposta.items as AchadoDaBusca[];
          setCatalogoVazio(found.length === 0 && resposta.catalogoVazio);

          /*
            O QUE FAZER COM O QUE VOLTOU — a regra mora em `destinoDaBusca`.

            Mercadoria bipada continua entrando direto: é o gesto mais repetido
            do balcão e atrasá-lo com uma confirmação custaria fila. Peça bipada
            PARA: a venda é permitida, mas o saldo que sai é o que a oficina está
            contando para terminar um conserto.

            O achado que entra é o do casamento EXATO — que pode não ser o
            primeiro da lista quando veio pelo SKU ou por um código adicional
            (D-pdv-teclado-03).
          */
          /*
            A ETIQUETA DA BALANÇA ENTRA COM O PESO DELA (D-pdv-teclado-16) — e
            antes da regra do casamento exato, que ela não passa: a linha vem
            com `matched_exact` em zero justamente para a tela que não a lê
            cair na lista, em vez de pôr "1 kg". Duas linhas com etiqueta (o
            mesmo PLU em dois cadastros) vão para a lista — e a escolha, pelo
            Enter ou pelo clique, também leva o peso.
          */
          const daBalanca = etiquetaDaBalancaUnica(found);
          if (daBalanca) {
            entrou = await entrarPelaEtiquetaDaBalanca(daBalanca, qtdDigitada, precoCents, { manterCampo: true });
            return;
          }
          const destino = destinoDaBusca(found, q);
          const exato = achadoExato(found, q);
          if (destino === 'carrinho' && exato) {
            entrou = await addProductResolvendoUnidade(exato, qtdDigitada, precoCents, { manterCampo: true });
            return;
          }
          if (destino === 'perguntar' && exato) {
            setPecaParaConfirmar({
              product: exato,
              quantity: qtdDigitada,
              // O preço combinado sobrevive à pergunta: a confirmação é sobre
              // vender peça da bancada, não sobre o valor.
              precoCents,
            });
            setResults([]);
            return;
          }

          /*
            Nada achado pelo produto? Pode ser a IDENTIDADE DA PEÇA.

            Bipar o IMEI da caixa do celular é o gesto natural do balcão, e ele
            não é código de barras de produto — é o número daquele aparelho.
          */
          if (found.length === 0) {
            const unidades = await coreApi.searchUnit(q);
            const disponivel = unidades.find((u) => u.status === 'in_stock');
            if (disponivel) {
              // `getProduct` pelo ID, e NÃO `searchProducts`: a busca é por texto
              // e um UUID não casa com nada.
              const produto = await coreApi.getProduct(disponivel.product_id);
              /*
                NO DOCUMENTO CARREGADO, BIPAR O CHASSI TROCA A MOTO (GAP-PRD-025).

                A quantidade da pré-venda é a do documento: somar uma moto à
                linha faria o carrinho mentir sobre o que a conversão fatura. O
                chassi bipado entra no lugar do último da linha. O documento e as
                linhas são os de AGORA (refs), e não os do Enter.
              */
              const documento = loadedQuoteRef.current;
              const daLinha = documento
                ? linhasRef.current.find(
                    (l) => l.product.id === produto.id && (l.unitIds?.length ?? 0) > 0,
                  )
                : undefined;
              if (documento && daLinha) {
                const ids = daLinha.unitIds ?? [];
                if (ids.includes(disponivel.id)) {
                  setMessage({ tone: 'ok', text: `O chassi ${rotuloDaUnidade(disponivel)} já está nesta venda.` });
                  entrou = true;
                  return;
                }
                const rotulos = (daLinha.unitLabel ?? '').split(', ').filter(Boolean);
                const saiu = rotulos[rotulos.length - 1] ?? 'a moto anterior';
                setLines((prev) =>
                  prev.map((l) =>
                    l.product.id !== produto.id
                      ? l
                      : {
                          ...l,
                          unitIds: [...ids.slice(0, -1), disponivel.id],
                          unitLabel: [...rotulos.slice(0, -1), rotuloDaUnidade(disponivel)].join(', '),
                        },
                  ),
                );
                setMessage({
                  tone: 'ok',
                  text: `Chassi ${rotuloDaUnidade(disponivel)} entra no lugar de ${saiu}.`,
                });
                entrou = true;
                return;
              }
              // Peça também pára aqui: bipar o IMEI é o gesto da bancada de
              // celular, e entrar direto seria a venda silenciosa por outra porta.
              if (ehPecaDeBancada(produto)) {
                setPecaParaConfirmar({ product: produto, quantity: 1, unidades: [disponivel] });
                return;
              }
              entrou = addProduct(produto, 1, undefined, [disponivel], { manterCampo: true });
              return;
            }
            if (unidades.length > 0) {
              // O status vem da PRÓPRIA unidade encontrada.
              const rotulo: Record<string, string> = {
                sold: 'vendida',
                baixada: 'com baixa',
                in_stock: 'em estoque',
              };
              setMessage({
                tone: 'error',
                text: `Essa peça está como "${rotulo[unidades[0].status] ?? unidades[0].status}" e não pode ser vendida.`,
              });
              /*
                A PEÇA RECUSADA TAMBÉM DEVOLVE OS CAMPOS AO PADRÃO
                (D-pdv-teclado-13, reauditoria).

                Este ramo acaba a leitura SEM item e era o único que não fazia
                a volta: o caixa digitava R$ 5,00 em Preço Unitário (ou "3" em
                Quantidade), bipava o IMEI de um celular já vendido, e o
                PRÓXIMO produto entrava por 3 × R$ 5,00, marcado como preço
                digitado — concessão, gestor chamado ou, com alçada, a venda
                saindo a R$ 5,00.
              */
              setQuantity('1');
              setUnitPrice('');
              return;
            }
          }

          // O carimbo é o termo que PRODUZIU esta lista, e não o que está na
          // tela quando ela chega (D-pdv-teclado-11).
          termoDosResultados.current = digitado;
          setResults(found);
          if (found.length === 0) {
            /*
              NÃO ENCONTRADO: o código sai do campo e vai para a faixa
              (D-pdv-teclado-04), e Quantidade e Preço Unitário voltam ao padrão
              (D-pdv-teclado-13) — o R$ 5,00 digitado para o serviço não pode
              cair no próximo produto bipado, virando concessão de 90%.
            */
            setQuantity('1');
            setUnitPrice('');
            setMessage({
              tone: 'error',
              // Com o interruptor desligado, "nenhum produto encontrado" pode ser
              // mentira: a peça existe e a busca por texto a escondeu.
              text: resposta.catalogoVazio
                ? 'Nenhum produto cadastrado.'
                : incluir
                  ? `Nenhum produto encontrado para "${q}".`
                  : `Nenhum produto encontrado para "${q}". Se for peça de conserto, ligue "Incluir peças da oficina".`,
            });
            return;
          }
          manterNoCampo = true;
        } catch (err) {
          /*
            SEM CONEXÃO, A FAIXA DIZ QUE É O SERVIDOR (PED-pdv-03).

            "Falha na busca." a cada bipe fazia o operador achar que era o leitor
            — trocava cabo, reiniciava a pistola — com o servidor da loja fora.
            A frase diz o que houve e o que ainda dá para fazer.
          */
          setMessage({
            tone: 'error',
            text: isNetworkFailure(err)
              ? 'Sem conexão com o servidor da loja — a busca de produto não funciona agora. Dá para finalizar só o carrinho que já está na tela.'
              : err instanceof ApiRequestError
                ? err.message
                : 'Falha na busca.',
          });
          manterNoCampo = true;
        } finally {
          if (!entrou) leiturasSemItem.current += 1;
          if (doCampo) {
            const i = leiturasPendentes.current.indexOf(lido);
            if (i >= 0) leiturasPendentes.current.splice(i, 1);
            consumirLeitura(lido, manterNoCampo);
          }
        }
      });
    },
    [
      term,
      quantity,
      incluirPecas,
      addProduct,
      addProductResolvendoUnidade,
      entrarPelaEtiquetaDaBalanca,
      precoDigitadoCents,
      enfileirar,
      consumirLeitura,
      lerQuantidade,
    ],
  );

  /**
   * O PREÇO COMBINADO, DIGITADO NA PRÓPRIA LINHA — o campo que a recusa citava
   * e que não existia.
   *
   * O servidor recusa a venda de produto de preço aberto sem valor com "digite
   * o valor na linha antes de fechar a venda". A instrução estava certa e o
   * campo não existia: havia só o "Preço Unitário" da coluna de busca, que
   * vale no momento de PÔR o item no carrinho. Depois de o item estar lá — que
   * é exatamente quando a recusa acontece —, o único conserto era tirar a
   * linha, digitar o valor lá em cima e bipar de novo. Mensagem que manda a
   * pessoa a um campo inexistente é pior que nenhuma: ela procura, não acha, e
   * conclui que o sistema está quebrado.
   *
   * SÓ em preço aberto, e isso é decisão e não esquecimento. Mão de obra,
   * serviço e o combinado não têm preço de tabela — o valor da linha É o
   * preço, e digitá-lo não concede nada. Em produto de preço fechado o valor
   * vem do cadastro, e baixá-lo é concessão: continua possível pelo campo da
   * busca, onde já passa pela alçada como sempre passou. Espalhar um campo de
   * preço por toda linha do carrinho criaria um caminho novo de desconto no
   * gesto mais repetido do balcão.
   *
   * Vazio ou ilegível vira ZERO, e não "mantém o que estava": zero é o que
   * pinta a linha de amarelo e acende o aviso de item sem preço. Apagar o
   * campo e a tela continuar mostrando o valor antigo esconderia justamente o
   * estado que vai ser recusado.
   */
  /**
   * APAGA O RASCUNHO DO CAMPO DE DESCONTO daquela linha.
   *
   * O campo mostra `descontoDaLinha[id] ?? reaisNoCampo(line.discountCents)`: o
   * rascunho vence enquanto existir. Re-limitar o desconto da linha sem apagar
   * o rascunho deixaria "30,00" escrito num desconto que passou a valer
   * R$ 10,00 — trocaria uma mentira por outra, e esta com o número na cara de
   * quem está no balcão. Apagado, o campo volta a mostrar o desconto de
   * verdade, que é o que vai viajar no POST.
   */
  const esquecerODescontoDigitado = useCallback((productId: string) => {
    setDescontoDaLinha((prev) => {
      if (!(productId in prev)) return prev;
      const proximo = { ...prev };
      delete proximo[productId];
      return proximo;
    });
  }, []);

  const definirPrecoDaLinha = useCallback((productId: string, texto: string) => {
    setPrecoDaLinha((prev) => ({ ...prev, [productId]: texto }));
    setLines((prev) =>
      prev.map((l) =>
        l.product.id === productId
          ? comDescontoDentroDoTeto({
              ...l,
              unitPriceCents: parseReaisToCents(texto) ?? 0,
              // O valor nasceu na conversa: a reprecificação por cliente não
              // pode sobrescrevê-lo. Em preço aberto o servidor devolve
              // `fonte: 'aberto'` e nem chega a propor outro número, mas a marca
              // fica pelo dia em que este campo servir a outro tipo de linha.
              precoDigitado: true,
              // O que ele acabou de digitar é o combinado desta linha.
              precoNegociadoCents: parseReaisToCents(texto) ?? 0,
            })
          : l,
      ),
    );
    // O TETO DESTA LINHA ACABOU DE MUDAR — e o desconto dela vai junto (ver
    // `comDescontoDentroDoTeto`). O rascunho do campo de desconto morre para o
    // número exibido ser o que a venda leva: R$ 100,00 escritos num item que
    // passou a valer R$ 50,00 seriam a mesma mentira que o re-limite conserta.
    esquecerODescontoDigitado(productId);
    // A recusa do servidor descreve o carrinho de antes desta digitação. Deixá-la
    // na tela enquanto a pessoa corrige o valor é descrever um estado que já não
    // existe — e é o tipo de faixa que ensina a ignorar faixa.
    setRecusaSemPreco((r) => (r?.productId === productId ? null : r));
    desmarcarLinhaDaRecusa(productId);
  }, [esquecerODescontoDigitado, desmarcarLinhaDaRecusa]);

  /**
   * Guarda o retrato da linha que está saindo do carrinho — GAP-V52/V63.
   *
   * O retrato é tirado ANTES do filtro, com o preço que a venda COBRARIA
   * (`unitarioCobradoCents`, a mesma regra do servidor): é esse o valor que o
   * cliente viu no total antes de a linha sumir, e é ele que interessa a quem
   * investigar um fechamento por menos.
   */
  const registrarRemocao = useCallback((linha: CartLine, quantidade: number = linha.quantity) => {
    setRemovidos((prev) => [
      ...prev,
      {
        productId: linha.product.id,
        name: linha.product.name,
        // Uma REDUÇÃO registra só o que saiu (D-pdv-teclado-07); a remoção da
        // linha, a quantidade inteira.
        quantity: Math.round(quantidade * 1000) / 1000,
        unitPriceCents: unitarioCobradoCents(linha),
        removedAt: new Date().toISOString(),
      },
    ]);
  }, []);

  /** O ✕ da linha: registra o retrato e só então tira do carrinho. */
  const removerLinha = useCallback(
    (linha: CartLine, index: number) => {
      registrarRemocao(linha);
      setLines((prev) => prev.filter((_, i) => i !== index));
      // Os rascunhos da linha saem com ela (D-pdv-teclado-M02): bipado de novo,
      // o produto nasce com os campos da linha NOVA.
      esquecerRascunhos(linha.product.id);
      delete qtdNaEntrada.current[linha.product.id];
    },
    [registrarRemocao, esquecerRascunhos],
  );

  /**
   * Quantidade digitada NA LINHA — GAP-V56.
   *
   * Só inteiro >= 1 muda a venda; o resto fica como rascunho do campo (a
   * pessoa pode estar no meio de apagar para digitar "3"). Serializado não
   * passa por aqui: a quantidade dele é o número de PEÇAS escolhidas, e mexer
   * no número sem escolher peça faria o chassi do documento mentir.
   *
   * MUDAR A QUANTIDADE MUDA O TETO DO DESCONTO, e por isso a linha volta por
   * `comDescontoDentroDoTeto`: era daqui que saía o `discountCents: 3000` num
   * item de R$ 10,00 (ver o cabeçalho daquela função).
   */
  const definirQtdDaLinha = useCallback(
    (productId: string, texto: string) => {
      setQtdDaLinha((prev) => ({ ...prev, [productId]: texto }));
      const linha = linhasRef.current.find((l) => l.product.id === productId);
      /*
        PRODUTO PESÁVEL ACEITA DECIMAL (D-pdv-teclado-M06).

        A regra era "só inteiro >= 1" para toda linha: o pesável lançado com
        1,250 kg não aceitava a correção da balança para 1,5 — o valor voltava
        a 1,25 no blur, sem mensagem, e o único conserto era remover a linha
        (deixando rastro de cancelado) e lançar de novo. Pesável aceita até três
        casas; o resto continua inteiro.
      */
      const pesavel = linha ? ehPesavel(linha.product) : false;
      const limpo = texto.trim().replace(',', '.');
      const n = Number(limpo);
      const valido = pesavel
        ? /^\d+(\.\d{1,3})?$/.test(limpo) && n > 0
        : Number.isInteger(n) && n >= 1;
      if (!valido) return;
      /*
        TETO DE QUANTIDADE (D-pdv-teclado-05). O caixa corrigia a linha para
        "3" e bipava o próximo produto sem voltar ao campo de leitura: a linha
        virava 37.891.234.567.895 unidades. Acima do teto a linha não muda — e
        a faixa diz o que provavelmente aconteceu.
      */
      if (n > QTD_MAXIMA_DA_LINHA) {
        setMessage({
          tone: 'error',
          text:
            `Quantidade ${formatQuantity(n)} passa do limite de ${formatQuantity(QTD_MAXIMA_DA_LINHA)} por item — `
            + 'a linha continua como estava. Um bipe pode ter caído neste campo.',
        });
        return;
      }
      setLines((prev) =>
        prev.map((l) =>
          l.product.id === productId ? comDescontoDentroDoTeto({ ...l, quantity: n }) : l,
        ),
      );
      esquecerODescontoDigitado(productId);
      // A recusa de desconto descrevia o carrinho de antes desta correção.
      desmarcarLinhaDaRecusa(productId);
    },
    [esquecerODescontoDigitado, desmarcarLinhaDaRecusa],
  );

  /**
   * Muda a quantidade da linha SEM escrever rascunho no campo dela — o
   * Alt+↑↓ (D-pdv-teclado-M02). Pela `definirQtdDaLinha`, o rascunho ficava
   * gravado ("3") e o blur que o apagaria nunca vinha, porque o foco está no
   * campo de leitura: a próxima leitura somava na linha e o campo seguia
   * mostrando o número velho.
   */
  const mudarQtdDaLinha = useCallback(
    (productId: string, n: number) => {
      setLines((prev) =>
        prev.map((l) =>
          l.product.id === productId ? comDescontoDentroDoTeto({ ...l, quantity: n }) : l,
        ),
      );
      esquecerRascunhos(productId);
      desmarcarLinhaDaRecusa(productId);
    },
    [esquecerRascunhos, desmarcarLinhaDaRecusa],
  );

  /**
   * O campo da quantidade da linha foi CONFIRMADO (Enter ou saída do campo).
   *
   * REDUZIR A QUANTIDADE É TIRAR MERCADORIA DA VENDA, e deixa rastro
   * (D-pdv-teclado-07). Só a remoção da linha inteira ia para "Itens
   * cancelados": 5 unidades passadas, R$ 50,00 vistos pelo cliente, a linha
   * baixada para 1 e a venda fechada em R$ 10,00 — com o rastro do GAP-V52 em
   * zero. A diferença é medida na CONFIRMAÇÃO, contra a quantidade de quando o
   * campo ganhou o foco, e não a cada tecla: "10" → "1" → "12" não registra 9.
   *
   * E o rascunho morre aqui: se sobrou "0" ou vazio no campo, volta a valer a
   * última quantidade válida da linha.
   */
  const confirmarQtdDaLinha = useCallback(
    (productId: string) => {
      setQtdDaLinha((prev) => {
        if (!(productId in prev)) return prev;
        const proximo = { ...prev };
        delete proximo[productId];
        return proximo;
      });
      const antes = qtdNaEntrada.current[productId];
      delete qtdNaEntrada.current[productId];
      const linha = linhasRef.current.find((l) => l.product.id === productId);
      if (!linha || antes === undefined) return;
      const saiu = Math.round((antes - linha.quantity) * 1000) / 1000;
      if (saiu > 0) registrarRemocao(linha, saiu);
    },
    [registrarRemocao],
  );

  /**
   * FECHA AS REDUÇÕES AINDA EM DIGITAÇÃO — e devolve os retratos delas
   * (revisão de D-pdv-teclado-07).
   *
   * A redução só era medida no blur ou no Enter do campo da linha. F8 (ou F7)
   * apertado com o foco AINDA no campo não tira o foco dele: 5 → 2 e F8
   * fechava a venda com o rastro vazio — o mesmo contorno do GAP-V52 que o D-07
   * fechou, por outra tecla. Quem leva o carrinho embora (Finalizar, espera)
   * chama isto antes: a diferença contra a quantidade de quando o campo ganhou o
   * foco vira retrato, e a base passa a ser a quantidade de agora — o blur que
   * vier depois mede só o que mudar daí em diante, sem contar duas vezes.
   */
  const fecharReducoesEmDigitacao = useCallback((): ItemRemovidoDoCarrinho[] => {
    const novos: ItemRemovidoDoCarrinho[] = [];
    for (const [productId, antes] of Object.entries(qtdNaEntrada.current)) {
      const linha = linhasRef.current.find((l) => l.product.id === productId);
      if (!linha) {
        delete qtdNaEntrada.current[productId];
        continue;
      }
      const saiu = Math.round((antes - linha.quantity) * 1000) / 1000;
      if (saiu > 0) {
        novos.push({
          productId,
          name: linha.product.name,
          quantity: saiu,
          unitPriceCents: unitarioCobradoCents(linha),
          removedAt: new Date().toISOString(),
        });
      }
      qtdNaEntrada.current[productId] = linha.quantity;
    }
    if (novos.length > 0) setRemovidos((prev) => [...prev, ...novos]);
    return novos;
  }, []);

  /**
   * Desconto digitado NA LINHA, em reais — GAP-V54.
   *
   * O valor é limitado ao total da própria linha: desconto maior que o item é
   * recusado pelo servidor ("Desconto maior que o valor do item"), então o
   * campo nem deixa nascer o estado que morreria no Finalizar. A alçada
   * continua sendo do SERVIDOR — este campo só emite o número que ele sempre
   * soube medir.
   *
   * O teto é o MESMO de `comDescontoDentroDoTeto`, e vem de lá: o limite tem de
   * ser um só nos quatro lugares que mexem nele.
   */
  const definirDescontoDaLinha = useCallback((productId: string, texto: string) => {
    setDescontoDaLinha((prev) => ({ ...prev, [productId]: texto }));
    const cents = parseReaisToCents(texto) ?? 0;
    setLines((prev) =>
      prev.map((l) =>
        l.product.id === productId
          ? comDescontoDentroDoTeto({ ...l, discountCents: Math.max(0, cents) })
          : l,
      ),
    );
    desmarcarLinhaDaRecusa(productId);
  }, [desmarcarLinhaDaRecusa]);

  const limparVenda = useCallback((opcoes: { leituraDoInicio?: string } = {}) => {
    // A reprecificação de uma espera retomada é do carrinho que está saindo.
    retomadaNoAr.current = null;
    produtosDaRetomada.current = new Set();
    setLines([]);
    /*
      A REF ANDA JUNTO COM O CARRINHO QUE SAI (D-pdv-teclado-R01).

      `linhasRef` só era atualizada no render, e o `setLines([])` acima, no fim
      do Finalizar, roda fora de evento: fica agendado. A leitura feita com o F8
      no ar espera `vendaEmCurso` e continua numa microtarefa ANTES desse
      render — `addProduct` lia na ref o carrinho da venda que acabou de sair,
      achava que o carrinho não estava vazio e não aposentava o painel fiscal
      dela. Tirar esse item com o ✕ devolvia à tela o painel (e o "Imprimir")
      do cliente anterior. Quem esvazia o carrinho esvazia a ref na hora.
    */
    linhasRef.current = [];
    setPrecoDaLinha({});
    setQtdDaLinha({});
    setDescontoDaLinha({});
    qtdNaEntrada.current = {};
    // O rastro de cancelados pertence à venda que acabou de sair da tela:
    // deixá-lo acumularia remoções de um cliente na venda do próximo.
    setRemovidos([]);
    setSaleKey(newIdempotencyKey());
    /*
      O CAMPO DE LEITURA SÓ PERDE O QUE ERA DESTA VENDA (D-pdv-teclado-02).

      No fim do Finalizar, o que o caixa já começou a bipar para o PRÓXIMO
      cliente enquanto a venda ia ao servidor está no campo. `setTerm('')`
      apagava metade de um código em plena leitura, e o resto era buscado como
      código parcial. `leituraDoInicio` é o que estava no campo quando o
      Finalizar começou: só esse começo sai.
    */
    const inicio = opcoes.leituraDoInicio;
    if (inicio === undefined) setTerm('');
    else setTerm((t) => (t.startsWith(inicio) ? t.slice(inicio.length) : t));
    setResults([]);
    // A pergunta pendente é sobre a venda que acabou de sair da tela: deixá-la
    // aberta faria o próximo cliente herdar a peça do anterior.
    setPecaParaConfirmar(null);
    setQuantity('1');
    setUnitPrice('');
    setCustomer(null);
    setDescontoTexto('');
    setNote('');
    setLoadedQuote(null);
    // As duas recusas são sobre o carrinho que acabou de sair da tela. Deixá-las
    // aparecendo faria o próximo cliente herdar o problema do anterior — e a
    // segunda é justamente do tipo que descreve um estado que não existe mais.
    setRecusaDeAlcada(null);
    setRecusaSemPreco(null);
    setRecusaDeDesconto(null);
    /*
      O LEITOR DE CÓDIGO DE BARRAS PRECISA DE UM CAMPO FOCADO.

      `clearSale` roda ao fim de TODA venda e mexia em doze estados sem devolver
      o foco a lugar nenhum. Quem fecha pelo pagamento tem o foco dentro do
      diálogo, que desmonta em seguida: o próximo bipe digita no vazio, e o
      operador larga a pistola para clicar no campo — a cada cliente.
    */
    searchRef.current?.focus();
  }, []);

  /**
   * Cancelar a venda sem leitura a preservar. Não recebe argumento: é também o `onClick`.
   *
   * O PAINEL DA VENDA ANTERIOR SAI JUNTO (F-cupom-fiscal-M03). O painel fiscal
   * aparece com o carrinho vazio: F6 no carrinho do próximo cliente (ou F7,
   * "guardar no servidor", "soltar do balcão") esvaziava a tela e o painel
   * da venda ANTERIOR voltava — "imprimir comprovante" entregava ao cliente da
   * frente o cupom de outro, e no modo manual "emitir NFC-e" emitia a nota de
   * outra venda. `limparVenda`, que o Finalizar usa, não passa por aqui: lá o
   * painel é o da venda que acabou de fechar.
   */
  const clearSale = useCallback(() => {
    limparVenda();
    setLastSaleId(null);
    setDisparoFiscal(null);
  }, [limparVenda]);

  /*
    F6 PERGUNTA ANTES DE APAGAR A VENDA (D-pdv-teclado-12).

    `F6: clearSale` e o botão "Cancelar (F6)" zeravam o carrinho na hora, sem
    desfazer: F6 fica entre o F5 e o F7 "Aguardar", e o botão ao lado do
    "Finalizar Rápido". Trinta itens bipados sumiam por uma tecla errada. Com
    carrinho montado a tela pergunta, com o foco em "Voltar ao carrinho" —
    Enter por reflexo não apaga nada; F6 de novo (ou o botão) confirma.
  */
  const pedirCancelamento = useCallback(() => {
    if (linhasRef.current.length === 0 && !loadedQuoteRef.current) {
      /*
        F6 NO CARRINHO VAZIO NÃO APAGA O PAINEL DA VENDA QUE ACABOU DE FECHAR
        (PED-pdv-10).

        O DEFEITO: com o carrinho vazio, F6 chamava `clearSale`, que zera
        `lastSaleId` desde o F-cupom-fiscal-M03. Venda fechada, o caixa aperta
        F6 por reflexo — e o painel fiscal dela sumia antes de a nota sair: no
        modo MANUAL, o "emitir NFC-e" daquela venda desaparecia do balcão. Não
        há carrinho a cancelar: sai só o que já foi preparado para o próximo
        cliente (o cliente escolhido, a observação, o desconto, o campo). O
        painel da venda anterior sai quando o carrinho novo COMEÇA — o primeiro
        item, a pré-venda carregada, a espera retomada —, e o F6 de um carrinho
        montado continua levando-o junto (`clearSale`).
      */
      limparVenda();
      return;
    }
    setConfirmarCancelamento(true);
  }, [limparVenda]);

  /*
    O F6 DEIXA RASTRO (D-pdv-teclado-12).

    A confirmação já existia, mas o carrinho confirmado como cancelado sumia sem
    registro: o carrinho é local, e o servidor só sabia da venda no Finalizar.
    Trinta itens bipados e mostrados ao cliente saíam da tela e o gerente não
    tinha como saber. O que saiu vai para a trilha do servidor — que carimba
    quem e quando pelo token. O registro NÃO trava a limpeza: o cliente da vez
    não espera a rede; se falhar, a faixa diz que o rastro não subiu.
  */
  /*
    SOLTAR O DOCUMENTO DO BALCÃO NÃO É CANCELAR NADA (D-pdv-teclado-R02).

    O link "soltar do balcão" e o F6 com pré-venda ou orçamento carregado são o
    mesmo gesto: o documento sai da tela e continua aberto no servidor (a
    pré-venda, reservada). Um só caminho para os dois, com a mesma frase — e
    nenhum registro de carrinho abandonado.
  */
  const soltarDocumentoDoBalcao = useCallback(
    (documento: Pick<Quote, 'kind' | 'number'>) => {
      setLoadedQuote(null);
      clearSale();
      setMessage({ tone: 'ok', text: fraseDoDocumentoSolto(documento) });
    },
    [clearSale],
  );

  const cancelarVendaMontada = useCallback(() => {
    /*
      O F6 COM DOCUMENTO CARREGADO GRAVAVA UM CANCELAMENTO QUE NÃO ACONTECEU
      (D-pdv-teclado-R02).

      As linhas da pré-venda iam para `POST /core/sales/abandoned` como
      "carrinho cancelado": a trilha ganhava R$ 300,00 cancelados de um
      documento que continuava aberto e reservado — e que depois era faturado
      em outro caixa. O gerente que investiga cancelamentos (a razão do D-12)
      via um cancelamento que não existiu, e o "soltar do balcão" do banner, o
      mesmo gesto, não gravava nada. O documento só sai da tela.
    */
    const documento = loadedQuoteRef.current;
    if (documento) {
      soltarDocumentoDoBalcao(documento);
      return;
    }
    const linhas = linhasRef.current;
    if (linhas.length > 0) {
      void coreApi
        .recordAbandonedCart({
          saleKey,
          terminalId: caixaDoComputador?.terminal?.id ?? null,
          customerId: customer?.id ?? null,
          items: linhas.map((l) => ({
            productId: l.product.id,
            name: l.product.name,
            quantity: l.quantity,
            unitPriceCents: Math.round(unitarioCobradoCents(l)),
          })),
        })
        .catch((err: unknown) => {
          /*
            O 504 NÃO É "NÃO CHEGOU" (revisão do G-offline-sync-R01). Atrás do
            proxy, o 504 é o servidor que não respondeu A TEMPO — ele pode ter
            gravado o registro. Dizer "sem conexão" mandava avisar a gerência de
            um cancelamento que talvez esteja na trilha.
          */
          const tempoEsgotado = err instanceof ApiRequestError && err.status === 504;
          setMessage({
            tone: 'error',
            text: tempoEsgotado
              ? 'A venda foi cancelada, mas o servidor não respondeu a tempo (HTTP 504) ao registro do '
                + 'cancelamento — ele pode ter chegado. Confira no histórico antes de avisar a gerência.'
              : 'A venda foi cancelada, mas o registro do cancelamento não chegou ao servidor: '
                + `${isNetworkFailure(err) ? 'sem conexão' : err instanceof Error && err.message ? err.message : 'sem resposta'}. `
                + 'Avise a gerência.',
          });
        });
    }
    clearSale();
  }, [saleKey, caixaDoComputador, customer, clearSale, soltarDocumentoDoBalcao]);

  const recarregarEsperas = useCallback(() => {
    setEsperas(emEspera.listar(escopoEspera));
  }, [escopoEspera]);

  useEffect(() => {
    recarregarEsperas();
  }, [recarregarEsperas]);

  /**
   * F7 — põe a venda em espera DE VERDADE.
   *
   * Antes isto só mostrava a mensagem "Venda em espera." e deixava o carrinho
   * na tela: o operador atendia o próximo cliente e perdia tudo. A espera não
   * reserva estoque (ver `pdvEmEspera.ts`) — é o carrinho parado, não um
   * documento.
   */
  const aguardarVenda = useCallback(() => {
    /*
      DOCUMENTO NO BALCÃO NÃO VAI PARA A ESPERA (D-pdv-teclado-M01).

      A espera guarda só linhas: o F7 com a pré-venda carregada transformava o
      documento reservado num carrinho comum — retomado, virava venda NOVA por
      `createSale`, e a mesma mercadoria era baixada pela venda e continuava
      reservada pelo documento.
    */
    if (loadedQuote) {
      setMessage({
        tone: 'error',
        text:
          `${rotuloDoDocumento(loadedQuote.kind)} #${loadedQuote.number} está no balcão: fature, ou use `
          + '"soltar do balcão" antes de pôr em espera — ela continua aberta no servidor e volta pelo F9.',
      });
      return;
    }
    const guardada = emEspera.guardar({
      escopo: escopoEspera,
      lines,
      customerId: customer?.id ?? null,
      customerName: customer?.name ?? null,
      discount,
      note,
      // O rastro de cancelados viaja com o carrinho (D-pdv-teclado-M05) — com
      // a redução ainda em digitação no campo da linha (revisão de D-07).
      removidos: [...removidos, ...fecharReducoesEmDigitacao()],
    });
    if (!guardada) {
      setMessage({ tone: 'error', text: 'Não há itens para deixar em espera.' });
      return;
    }
    clearSale();
    recarregarEsperas();
    setMessage({ tone: 'ok', text: `Em espera: ${guardada.rotulo}.` });
  }, [escopoEspera, lines, customer, discount, note, removidos, loadedQuote, clearSale, recarregarEsperas, fecharReducoesEmDigitacao]);

  /**
   * ==========================================================================
   * A ESPERA QUE CRUZA TERMINAIS (GAP-V59) — e por que ela é um ORÇAMENTO
   * ==========================================================================
   *
   * ## O defeito, e o tamanho dele
   *
   * A espera (F7) mora no `localStorage`: o carrinho suspenso no caixa 1 não
   * reaparece no caixa 2, e formatar a máquina perde as esperas do turno. Nas
   * seis operações do grupo há UM caixa por loja, então o impacto é pequeno —
   * mas "pequeno hoje" não é "correto".
   *
   * ## Por que NÃO nasceu uma tabela de espera no servidor
   *
   * Porque já existe o documento certo, e criar um segundo seria fabricar uma
   * terceira ideia de "carrinho guardado" (espera local, pré-venda, e a nova),
   * com três telas para listar, três estados para reconciliar e três caminhos
   * para faturar. O ORÇAMENTO já é exatamente isto: documento do servidor,
   * numerado, que cruza terminais, NÃO reserva estoque (a própria tela diz
   * isso quando carrega um) e é retomado pelo F9 que o balcão já usa.
   *
   * A pré-venda seria a escolha errada aqui: ela RESERVA mercadoria. Segurar
   * saldo por um carrinho que talvez nem vire venda tira peça da prateleira de
   * quem está pronto para pagar — a mesma razão pela qual a espera local nunca
   * reservou nada.
   *
   * ## Os dois convivem, e a diferença é o preço de cada um
   *
   * F7 continua sendo o gesto de dois minutos: instantâneo, sem rede, sem
   * número, some no fim do turno. Este aqui é o carrinho que precisa
   * sobreviver ao terminal — custa uma ida ao servidor e nasce com número.
   * Dizer qual é qual na tela é o que impede o operador de escolher errado.
   */
  const guardarNoServidor = useCallback(async () => {
    // O documento carregado já está no servidor (D-pdv-teclado-M01): guardá-lo
    // de novo como orçamento duplicaria o documento.
    if (loadedQuote) {
      setMessage({
        tone: 'error',
        text:
          `${rotuloDoDocumento(loadedQuote.kind)} #${loadedQuote.number} já está guardado no servidor. `
          + 'Fature, ou use "soltar do balcão".',
      });
      return;
    }
    if (lines.length === 0) {
      setMessage({ tone: 'error', text: 'Não há itens para guardar.' });
      return;
    }
    setBusy(true);
    try {
      const documento = await coreApi.createQuote({
        kind: 'orcamento',
        items: lines.map((l) => ({
          productId: l.product.id,
          quantity: l.quantity,
          unitPriceCents: l.unitPriceCents,
        })),
        customerId: customer?.id ?? null,
        sellerId: sellerId || null,
        discountCents: discount || undefined,
        note: note || 'Carrinho guardado no servidor — espera entre caixas.',
      });
      clearSale();
      recarregarEsperas();
      setMessage({
        tone: 'ok',
        text:
          `Guardado no servidor como orçamento #${documento.number}. `
          + 'Retome em qualquer caixa por F9 — sem reserva de mercadoria.',
      });
    } catch (err) {
      setMessage({
        tone: 'error',
        text:
          err instanceof ApiRequestError
            ? `Não foi possível guardar no servidor: ${err.message}`
            : 'Não foi possível guardar no servidor. O carrinho continua na tela.',
      });
    } finally {
      setBusy(false);
    }
  }, [lines, customer, sellerId, discount, note, loadedQuote, clearSale, recarregarEsperas]);

  /**
   * A VENDA RETOMADA DA ESPERA VOLTA AO PREÇO DE AGORA (G-offline-sync-07#pdv).
   *
   * O DEFEITO: a espera guarda as linhas com a marca de quem as precificou
   * (`precificadaPara`/`precificadaQtd`) e, retomada para o mesmo cliente, a
   * marca batia — a reprecificação por classe não via nada a fazer, e o
   * carrinho guardado às 10h voltava às 15h com o preço das 10h. O servidor
   * cobra o vigente de agora: a tela mostrava um total, a maquininha passava
   * esse total, e o Finalizar era recusado (ou o preço que subiu virava
   * "desconto" do operador). Agora TODAS as linhas da espera são perguntadas
   * ao servidor na retomada, pela mesma regra de sempre (`aplicarPrecificacao`
   * — valor combinado só é limitado, preço aberto não é tocado), e a faixa diz
   * o que mudou. O Finalizar espera esta pergunta, como espera a do efeito.
   */
  const reprecificarRetomada = useCallback(
    (idDaEspera: string, antes: CartLine[], customerId: string | null, rotulo: string) => {
      if (antes.length === 0) return;
      retomadaNoAr.current = idDaEspera;
      const alvo = clienteDaVenda(customerId);
      const pedidos = antes.map((l) => l.product.id);
      const perguntados = new Set(pedidos);
      // O efeito do carrinho não repete esta pergunta enquanto ela está no ar.
      produtosDaRetomada.current = perguntados;
      const quantidades = Object.fromEntries(antes.map((l) => [l.product.id, l.quantity]));
      const ida: Promise<void> = coreApi
        .priceCart({
          customerId: alvo,
          items: antes.map((l) => ({ productId: l.product.id, quantity: l.quantity })),
        })
        .then((r) => {
          if (retomadaNoAr.current !== idDaEspera) return;
          if (!Array.isArray(r?.items)) {
            throw new ApiRequestError('CORE_PRICING_BAD_SHAPE', 'Resposta de preço em formato inesperado.', 0);
          }
          let depois: CartLine[] = [];
          /*
            O cerco sai ANTES de a resposta entrar: o efeito que roda nesta
            renderização precisa enxergar a linha que esta resposta não resolveu
            (a quantidade mudou no caminho, o cliente trocou) e perguntá-la.
          */
          produtosDaRetomada.current = new Set();
          // Síncrono pelo mesmo motivo do efeito: o Finalizar que esperou esta
          // resposta lê o carrinho pela ref logo depois.
          flushSync(() => {
            setLines((prev) => {
              // Tirar a marca é o que faz `aplicarPrecificacao` aceitar a
              // resposta para a linha que já "estava em dia" pela marca velha.
              depois = aplicarPrecificacao(
                prev.map((l) => (perguntados.has(l.product.id) ? { ...l, precificadaPara: undefined } : l)),
                r,
                alvo,
                pedidos,
                quantidades,
              ).map(comDescontoDentroDoTeto);
              return depois;
            });
          });
          const agora = new Map(depois.map((l) => [l.product.id, l]));
          const mudadas = antes.flatMap((l) => {
            const nova = agora.get(l.product.id);
            return nova && nova.precificadaPara === alvo && nova.unitPriceCents !== l.unitPriceCents
              ? [{ id: l.product.id, nome: l.product.name, de: l.unitPriceCents, para: nova.unitPriceCents }]
              : [];
          });
          if (mudadas.length === 0) return;
          // O rascunho do desconto da linha morre junto: o teto dela mudou.
          setDescontoDaLinha((prev) => {
            const proximo = { ...prev };
            for (const m of mudadas) delete proximo[m.id];
            return proximo;
          });
          setMessage({
            tone: 'error',
            text:
              `Retomada: ${rotulo}. O preço mudou desde que a venda foi guardada — `
              + mudadas
                .map((m) => `"${m.nome}" de ${formatCents(m.de)} para ${formatCents(m.para)}`)
                .join('; ')
              + '. Confira com o cliente antes de cobrar.',
          });
        })
        .catch((err: unknown) => {
          if (retomadaNoAr.current !== idDaEspera) return;
          // Sem resposta, as linhas ficam como estavam e quem confere o preço é
          // o Finalizar — a faixa diz isso em vez de afirmar que está em dia.
          setMessage({
            tone: 'error',
            text:
              `Retomada: ${rotulo}. `
              + (isNetworkFailure(err)
                ? 'Sem conexão com o servidor da loja — os preços da venda guardada não foram conferidos; '
                  + 'o Finalizar confere.'
                : `Não foi possível conferir os preços da venda guardada${
                  err instanceof ApiRequestError ? `: ${err.message}` : ''}. Confira os valores antes de cobrar.`),
          });
        })
        .finally(() => {
          if (retomadaNoAr.current === idDaEspera) {
            retomadaNoAr.current = null;
            /*
              Sem resposta, as linhas da espera continuam PENDENTES (voltaram
              sem a marca de preço) e o cerco sai: o Finalizar e o F10
              (`precoDoCarrinhoEmDia`) perguntam de novo antes de cobrar — é o
              "o Finalizar confere" da faixa, agora verdade.
            */
            produtosDaRetomada.current = new Set();
          }
        });
      // O Finalizar (e o F10) esperam esta pergunta — junto com a do efeito, se
      // houver uma no ar. Nenhuma das duas rejeita: cada uma trata a própria falha.
      const anterior = precoNoAr.current;
      const emDia: Promise<void> = anterior ? Promise.all([anterior, ida]).then(() => undefined) : ida;
      precoNoAr.current = emDia;
      void emDia.finally(() => {
        if (precoNoAr.current === emDia) precoNoAr.current = null;
      });
    },
    [],
  );

  /** Retomar troca o carrinho da tela pelo que estava parado. */
  const retomarEspera = useCallback(
    (id: string) => {
      /*
        RETOMAR COM DOCUMENTO NO BALCÃO FATURARIA O DOCUMENTO, E NÃO O
        CARRINHO DA TELA (D-pdv-teclado-M01).

        A retomada trocava as linhas e deixava `loadedQuote` de pé: a tela
        mostrava os itens da espera, dizia "Faturando pré-venda #12", e o
        Finalizar convertia a pré-venda — os itens da espera saíam sem venda
        nenhuma. A tela recusa e diz o caminho.
      */
      if (loadedQuote) {
        setMessage({
          tone: 'error',
          text:
            `${rotuloDoDocumento(loadedQuote.kind)} #${loadedQuote.number} está no balcão: fature, ou use `
            + '"soltar do balcão" antes de retomar uma espera.',
        });
        return;
      }
      const venda = emEspera.retomar(id);
      if (!venda) return;
      // Retomar por cima de um carrinho com itens perderia o atual: ele volta
      // para a espera antes — COM o rastro de cancelados dele (M05) —, para
      // que nenhum dos dois se perca.
      if (lines.length > 0) {
        emEspera.guardar({
          escopo: escopoEspera,
          lines,
          customerId: customer?.id ?? null,
          customerName: customer?.name ?? null,
          discount,
          note,
          removidos: [...removidos, ...fecharReducoesEmDigitacao()],
        });
      }
      /*
        A RETOMADA É O QUARTO ESCRITOR DO TETO — e era o único que não passava
        por aqui.

        `comDescontoDentroDoTeto` guarda os três escritores que a tela conhece
        (quantidade, valor combinado, reprecificação) e o cabeçalho dele diz que
        quem mexe no teto passa por ele. A retomada mexe: ela substitui o
        carrinho inteiro.

        E a fonte dela não é a tela — é o `localStorage`, lido com um `as` seco
        (`JSON.parse(bruto) as VendaEmEspera[]`, em `pdvEmEspera.ts`). O que
        volta é o que estava gravado, inclusive o que foi gravado por uma versão
        ANTERIOR a esta regra: o carrinho deixado em espera na sexta, com 3 ×
        R$ 10,00 e R$ 30,00 de desconto, retomado depois da atualização já com
        quantidade 1. Sem esta linha ele volta pedindo R$ 30,00 de desconto numa
        linha de R$ 10,00, e o único desfecho é a recusa do servidor no
        Finalizar — com o cliente na frente.

        Re-limitar é mais honesto do que recusar a retomada: o operador não
        escreveu aquele número hoje, e o carrinho dele não pode ser perdido por
        causa de um desconto que a régua de agora não aceita mais.
      */
      const retomadas = venda.lines.map(comDescontoDentroDoTeto);
      setLines(retomadas);
      // A espera guarda CENTAVOS (o "10%" já tinha virado valor quando foi
      // guardado); o campo volta escrito em reais.
      setDescontoTexto(reaisNoCampo(venda.discount));
      setNote(venda.note);
      setCustomer(
        venda.customerId ? ({ id: venda.customerId, name: venda.customerName ?? '' } as Customer) : null,
      );
      setSaleKey(newIdempotencyKey());
      // O carrinho que entra é o de outro cliente: o painel da venda anterior
      // sai aqui (PED-pdv-10 — o carrinho novo começa aqui, e não no F6).
      setLastSaleId(null);
      setDisparoFiscal(null);
      /*
        O RASTRO E OS RASCUNHOS SÃO DO CARRINHO QUE ENTRA (D-pdv-teclado-M05).
        O rastro do carrinho que foi para a espera ia no Finalizar da venda
        retomada — `core_sale_removed_items` gravava que X saiu da venda B,
        quando saiu de A. E os rascunhos dos campos da linha, a pergunta de
        peça e as recusas descreviam o carrinho que saiu da tela.
      */
      setRemovidos(Array.isArray(venda.removidos) ? venda.removidos : []);
      setPrecoDaLinha({});
      setQtdDaLinha({});
      setDescontoDaLinha({});
      qtdNaEntrada.current = {};
      setPecaParaConfirmar(null);
      setRecusaDeAlcada(null);
      setRecusaSemPreco(null);
      setRecusaDeDesconto(null);
      recarregarEsperas();
      setMessage({ tone: 'ok', text: `Retomada: ${venda.rotulo}.` });
      // O preço de agora para TODAS as linhas guardadas (G-offline-sync-07#pdv).
      reprecificarRetomada(venda.id, retomadas, venda.customerId, venda.rotulo);
    },
    [lines, customer, discount, note, removidos, loadedQuote, escopoEspera, recarregarEsperas, fecharReducoesEmDigitacao, reprecificarRetomada],
  );

  /**
   * Alt+O — observação da venda, num diálogo da casa (GAP-V58).
   *
   * Era `window.prompt`: uma linha só, sem estilo, bloqueando a aba — e
   * alguns kiosks e navegadores o DESABILITAM, caso em que a observação sumia
   * sem erro nenhum. O diálogo edita um RASCUNHO: a observação da venda só
   * muda no Salvar, e o Cancelar devolve a que já existia.
   */
  const editarObservacao = useCallback(() => {
    setNotaRascunho(note);
    setShowNota(true);
  }, [note]);

  /**
   * VENDER COM O CAIXA FECHADO É CRIAR DIFERENÇA DE GAVETA POR DESENHO.
   *
   * O PDV aceitava a venda e mandava `cashSessionId: null`: o dinheiro
   * entrava, a mercadoria saía, e no fim do dia o operador contava as notas
   * sem ter de onde tirar o confronto. A recusa vale só quando o sistema SABE
   * que não há gaveta — se a consulta falhou, o balcão continua vendendo.
   */
  const vendaSemGaveta = caixaConhecido && !cash;

  /**
   * As linhas em que o carrinho já passou do saldo que o servidor informou.
   *
   * O PDV punha qualquer produto em qualquer quantidade sem olhar saldo, e a
   * recusa (`CHECK (quantity >= 0)` → `CORE_INSUFFICIENT_STOCK`) chegava no
   * Finalizar — depois de o cartão já ter passado na maquininha avulsa. O
   * saldo vem na MESMA resposta da busca que trouxe o produto.
   *
   * Não bloqueia: a prateleira pode ter a peça que o sistema não sabe que tem,
   * e travar o balcão por isso pararia a loja. Avisa no momento em que o
   * conserto ainda é barato — antes de cobrar.
   */
  const linhasSemSaldo = lines.filter(
    (l) => typeof l.product.stock_quantity === 'number' && l.quantity > l.product.stock_quantity,
  );

  /**
   * A VENDA QUE ACABOU DE FECHAR VIRA A TELA DE VENDA CONCLUÍDA — pelos DOIS
   * caminhos do Finalizar (F-cupom-fiscal-05, D-pdv-teclado-09/M04).
   *
   * Só a venda direta passava por aqui. Faturar pré-venda ou orçamento (F9)
   * fechava o pagamento e mostrava uma faixa: sem a tela de venda concluída,
   * sem troco escrito, sem Enter para o cupom, sem a gaveta do agente e sem
   * acompanhar a NFC-e que a rota dispara no modo automático. E `lastSaleId`
   * ficava na venda ANTERIOR: o "Imprimir" do painel fiscal entregava ao
   * cliente B o cupom do cliente A, com os itens e o CPF de A.
   */
  const registrarVendaConcluida = useCallback(
    (v: {
      saleId: string;
      numero: number;
      totalCents: number;
      trocoCents: number;
      subtotalCents: number;
      descontoCents: number;
      acrescimoCents: number;
      pagamentos: { rotulo: string; valorCents: number }[];
      itens: DadosDoComprovante['itens'];
      disparo: DisparoDaNfce | null;
      houveDinheiro: boolean;
      /** O começo da frase da faixa; o padrão é "Venda #N finalizada". */
      titulo?: string;
    }) => {
      setLastSaleId(v.saleId);
      // A resposta diz se a NFC-e saiu sozinha (modo automático) e, quando não
      // saiu, por quê — o painel fiscal mostra (GAP-PRD-163).
      setDisparoFiscal(v.disparo);
      setFiscalTick((t) => t + 1);
      // A nota foi para a SEFAZ: a tela acompanha o desfecho, mesmo depois de a
      // tela de venda concluída fechar (F-cupom-fiscal-01).
      // Entra na lista das últimas cinco — sem tirar a vigília das anteriores
      // (PED-pdv-07): a rejeição de uma venda de antes ainda precisa aparecer.
      if (v.disparo?.disparada) {
        const vigiada = { saleId: v.saleId, numero: v.numero };
        setVendasVigiadas((lista) => [vigiada, ...lista.filter((x) => x.saleId !== v.saleId)].slice(0, 5));
      }
      const titulo = v.titulo ?? `Venda #${v.numero} finalizada`;
      setMessage({
        tone: 'ok',
        text:
          v.trocoCents > 0
            ? `${titulo} — TROCO ${formatCents(v.trocoCents)}`
            : `${titulo} — ${formatCents(v.totalCents)}`,
      });
      // Três estados que não se misturam: autorizada (depois de conferir),
      // pendente (a nota saiu para a SEFAZ e não voltou) e sem NFC-e.
      const estadoFiscal: EstadoFiscalDaVenda = v.disparo?.disparada
        ? { tipo: 'pendente', motivo: null }
        : { tipo: 'nao_fiscal', motivo: v.disparo?.motivos?.[0] ?? null };
      setErroDaImpressao(null);
      setImprimindoConcluida(false);
      setConcluida({
        saleId: v.saleId,
        documentoFiscalId: null,
        numero: v.numero,
        totalCents: v.totalCents,
        trocoCents: v.trocoCents,
        pagamentos: v.pagamentos,
        itens: v.itens.map(({ descricao, quantidade, totalCents }) => ({ descricao, quantidade, totalCents })),
        estadoFiscal,
        comprovante: {
          quando: new Date(),
          identificacao: `Venda #${v.numero}`,
          itens: v.itens,
          subtotalCents: v.subtotalCents,
          descontoCents: v.descontoCents,
          acrescimoCents: v.acrescimoCents,
          totalCents: v.totalCents,
          pagamentos: v.pagamentos,
          trocoCents: v.trocoCents,
          offline: false,
        },
      });
      /*
        A GAVETA ABRE SOZINHA NO DINHEIRO; O CUPOM, SÓ SE O OPERADOR PEDIR
        (GAP-PRD-082).

        Só quando o servidor disse que ESTE caixa tem térmica de agente com o
        agente no ar (`gaveta.byCommand`). A impressão é a escolha da tela de
        venda concluída (Enter imprime, Esc não). A falha da gaveta não desfaz a
        venda: acrescenta o aviso ao lado do troco.
      */
      if (gaveta?.byCommand && v.houveDinheiro) {
        const numero = v.numero;
        void impressaoApi
          .abrirGaveta(`Venda #${numero} — dinheiro`, caixaDoComputador?.terminal?.id ?? null)
          .catch((err: unknown) => {
            setMessage((m) => ({
              tone: 'error',
              text:
                `${m?.text ?? `Venda #${numero} finalizada`}. A gaveta não abriu: `
                + `${err instanceof Error ? err.message : 'falha do agente local'}.`,
            }));
          });
      }
    },
    [gaveta, caixaDoComputador],
  );

  const finalize = useCallback(
    async (
      /**
       * Os pagamentos lançados — ou `'dinheiro-exato'` (F8): o valor é o total
       * do carrinho que de fato vai para a venda, calculado DEPOIS de a leitura
       * em curso entrar (D-pdv-teclado-02).
       */
      pedidos: PaymentLine[] | 'dinheiro-exato',
      authId?: string | null,
      surchargeCents = 0,
      /**
       * Quanto do CRÉDITO DE LOJA do cliente esta venda abate (GAP-V10/V47).
       *
       * Vem do diálogo de pagamento e desce inteiro para a API — a tela não
       * decide nada sobre ele: quem confere saldo, dono e teto é o servidor, na
       * mesma transação da venda.
       */
      customerCreditCents = 0,
      /**
       * A chave NOVA escolhida pelo caixa em "Registrar como venda nova"
       * (RES-IDEM-TELA). O `setSaleKey` do mesmo clique só chega a esta função
       * no próximo render; sem este parâmetro, o reenvio sairia com a chave
       * velha e tomaria a mesma recusa.
       */
      chaveNova?: string,
      /**
       * O troco que o diálogo de pagamento calculou, contra o que sobrou para
       * os meios depois do acréscimo e do vale (D-pdv-teclado-08). O PDV o
       * jogava fora (`_troco`) e recalculava contra o total SEM acréscimo e SEM
       * vale — offline, a tela mandava devolver troco que o cliente não tinha.
       */
      trocoInformado?: number,
    ) => {
      const chaveDaVenda = chaveNova ?? saleKey;
      if (linhasRef.current.length === 0 && leiturasPendentes.current.length === 0) {
        setMessage({ tone: 'error', text: 'Carrinho vazio.' });
        return;
      }
      // Caixa fechado: a venda para aqui e a tela pede o que falta. Este é o
      // único ponto por onde TODAS as vendas passam — F8, F10 e a conversão
      // de pré-venda —, e por isso a trava mora nele.
      if (vendaSemGaveta) {
        setMessage({ tone: 'error', text: 'Caixa fechado — abra o caixa antes de vender.' });
        setShowPayment(false);
        setShowCaixa(true);
        return;
      }
      // Trava local contra clique duplo. O servidor também recusa pela chave
      // de idempotência, mas segurar aqui evita a segunda ida à rede.
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      /*
        ==================================================================
        O BIPE DE ANTES DO FINALIZAR ENTRA NA VENDA; O DE DEPOIS, NA PRÓXIMA
        (D-pdv-teclado-02)
        ==================================================================

        Os itens eram montados com o `lines` do fechamento, e a resposta
        chamava `clearSale`. Duas perdas:
          (a) F8 e já bipar o primeiro item do próximo cliente com o POST no
              ar: o item aparecia no carrinho e sumia quando a resposta
              chegava — nunca vendido;
          (b) bipar o último item e apertar F8 antes de a busca responder: a
              venda saía SEM o item, a busca respondia, o item aparecia, e o
              `clearSale` o apagava. Mercadoria saindo sem cobrança.

        Agora o Finalizar ESPERA as leituras feitas antes dele (a fila, como
        estava neste instante) e lê as linhas depois disso — pela ref, que a
        leitura atualiza de forma síncrona. As leituras feitas DEPOIS dele
        esperam `vendaEmCurso` e entram no carrinho novo.
      */
      const leiturasAntes = filaDeLeitura.current;
      // Havia leitura no ar no Finalizar? E quantas já tinham acabado sem item?
      const esperouLeitura = leiturasPendentes.current.length > 0;
      const semItemAntes = leiturasSemItem.current;
      let terminarVenda: () => void = () => undefined;
      vendaEmCurso.current = new Promise<void>((fim) => {
        terminarVenda = fim;
      });
      // O que estava no campo de leitura no Finalizar. O que chegar depois é do
      // próximo cliente, e o fim da venda não pode apagá-lo.
      const leituraDoInicio = searchRef.current?.value ?? '';
      try {
        await leiturasAntes;
        /*
          A LEITURA QUE O FINALIZAR ESPEROU E NÃO ENTROU (revisão de
          D-pdv-teclado-02).

          Bipe e F8 no mesmo instante: se a leitura acabava SEM item — não
          encontrado, lista, peça esperando a pergunta —, a venda saía sem ele,
          o `setMessage(null)` logo abaixo apagava o "Nenhum produto
          encontrado" e o `limparVenda` levava a lista e a pergunta embora. O
          cliente saía com o item e a tela não dizia nada. A venda para aqui, e
          a faixa mantém o motivo da leitura.
        */
        if (esperouLeitura && leiturasSemItem.current > semItemAntes) {
          setMessage((m) => ({
            tone: 'error',
            text:
              `${m?.tone === 'error' ? `${m.text} ` : ''}A venda NÃO foi finalizada: o último item lido não `
              + 'entrou no carrinho. Confira o item e finalize de novo.',
          }));
          return;
        }
        /*
          O PREÇO POR QUANTIDADE ANTES DA CONTA (G-offline-sync-M01): o terceiro
          bipe do mesmo item muda o preço da linha pela faixa do Gestor, e a
          resposta pode estar no ar quando o F8 chega. A venda espera — senão
          cobraria o preço de uma unidade que o servidor não cobra.
        */
        await precoDoCarrinhoEmDia();
        const linhasDaVenda = linhasRef.current;
        if (linhasDaVenda.length === 0) {
          setMessage({ tone: 'error', text: 'Carrinho vazio.' });
          return;
        }
        const contas = contasDoCarrinho(linhasDaVenda, descontoTexto);
        // O rastro de agora, com a redução que ainda estava sendo digitada no
        // campo da linha quando o F8 veio (revisão de D-pdv-teclado-07).
        const cancelados = [...removidosRef.current, ...fecharReducoesEmDigitacao()];
        const payments: PaymentLine[] =
          pedidos === 'dinheiro-exato' ? [{ method: 'dinheiro', amountCents: contas.total }] : pedidos;
        setMessage(null);
        setPaymentError(null);
        // Recusa antiga sai da tela ANTES da nova tentativa: enquanto a requisição
        // corre, uma faixa dizendo "sem preço" descreveria um estado que talvez
        // já tenha sido corrigido.
        setRecusaDeAlcada(null);
        setRecusaSemPreco(null);
        try {
          // Carrinho vindo de pré-venda fatura pela conversão: é ela que solta a
          // reserva antes da baixa. Passar pelo caminho normal deixaria a
          // mercadoria reservada para sempre, além de já vendida.
          if (loadedQuote) {
            /*
              A CONVERSÃO DE PRÉ-VENDA GASTA O VALE pelo MESMO
              `CustomerCreditService` da venda direta — mesma trava de
              concorrência, mesmo resgate amarrado à venda gerada. A tela
              continua sem voto: quem confere saldo, dono e teto é o servidor. E
              o dono é o cliente DO DOCUMENTO.
            */
            const documento = loadedQuote;
            const result = await coreApi.convertQuote(
              documento.id,
              {
                payments,
                cashSessionId: cash?.id ?? null,
                // Fora de `payments` pelo mesmo motivo da venda direta: ali mora o
                // que o cliente PAGOU, e aqui ele cobrou uma dívida que a loja já
                // tinha com ele.
                customerCreditCents: customerCreditCents || undefined,
                // QUAL MOTO SAI (GAP-PRD-025): o chassi que a linha mostra. Linha
                // de moto sem o chassi completo não vai — o servidor escolhe.
                unidades: unidadesDaConversao(linhasDaVenda),
                /*
                  A LIBERAÇÃO DO GESTOR VAI NA CONVERSÃO (A-produto-17#conversao-pdv).

                  O DEFEITO: o corpo da conversão não levava `authorizationId`. A
                  recusa 403 CORE_DISCOUNT_NEEDS_AUTHORIZATION (linha abaixo do
                  piso do produto) abria o diálogo do gestor, o gestor digitava a
                  senha, `confirmAuthorization` chamava este `finalize` com o id da
                  liberação — e a nova tentativa saía SEM ele: o servidor recusava
                  de novo, e o balcão ficava num laço sem saída. É o MESMO campo e
                  a mesma fonte da venda direta, e ele é esquecido logo abaixo
                  (`setAuthorizationId(null)`), depois do uso.
                */
                authorizationId: authId ?? authorizationId ?? undefined,
              },
              chaveDaVenda,
            );
            setShowPayment(false);
            setPendingPayments(null);
            setAuthorizationId(null);
            // A rota devolve o disparo da NFC-e (`nfceNoFinalizar`) como a da
            // venda direta; o tipo do cliente não o declara.
            const disparo = (result as { nfceNoFinalizar?: DisparoDaNfce }).nfceNoFinalizar ?? null;
            /*
              OS NÚMEROS DA TELA SÃO OS DA VENDA QUE NASCEU, e não os do carrinho:
              a conversão fatura o DOCUMENTO. A ficha é lida do servidor; sem
              ela (rede piscou), a tela usa o que tem — o troco que o diálogo
              calculou e as contas do carrinho, que são as do documento.
            */
            let venda: SaleDetail | null = null;
            try {
              venda = await coreApi.getSale(result.saleId);
            } catch {
              venda = null;
            }
            const numeros = (venda ?? {}) as Partial<SaleDetail>;
            const itensDaVenda = Array.isArray(numeros.items)
              ? numeros.items.map((i) => ({
                  descricao: i.description,
                  quantidade: i.quantity,
                  unitarioCents: i.unit_price_cents,
                  totalCents: i.total_cents,
                }))
              : retratoDoCarrinho(linhasDaVenda);
            registrarVendaConcluida({
              saleId: result.saleId,
              numero: result.number,
              totalCents:
                typeof numeros.total_cents === 'number' ? numeros.total_cents : contas.total + surchargeCents,
              trocoCents:
                typeof numeros.change_cents === 'number' ? numeros.change_cents : (trocoInformado ?? 0),
              subtotalCents:
                typeof numeros.subtotal_cents === 'number' ? numeros.subtotal_cents : contas.bruto,
              descontoCents:
                typeof numeros.discount_cents === 'number'
                  ? numeros.discount_cents
                  : contas.descontoDeLinhas + contas.discount,
              acrescimoCents:
                typeof numeros.surcharge_cents === 'number' ? numeros.surcharge_cents : surchargeCents,
              pagamentos: pagamentosDaTela(payments, customerCreditCents),
              itens: itensDaVenda,
              disparo,
              houveDinheiro: payments.some((p) => p.method === 'dinheiro'),
              titulo: `${rotuloDoDocumento(documento.kind)} #${documento.number} faturado — venda #${result.number}`,
            });
            setLoadedQuote(null);
            limparVenda({ leituraDoInicio });
            return;
          }

          const sale = await coreApi.createSale(
            {
              items: linhasDaVenda.map((l) => ({
                productId: l.product.id,
                quantity: l.quantity,
                unitPriceCents: l.unitPriceCents,
                // O desconto digitado NA LINHA (GAP-V54). O servidor sempre o
                // mediu na alçada; faltava a tela emitir o número.
                discountCents: l.discountCents || undefined,
                // QUAIS peças saíram. Sem isto o servidor recusa a venda de
                // produto controlado por unidade.
                unitIds: l.unitIds,
                /*
                  QUEM ESCREVEU ESTE PREÇO (G-offline-sync-07#pdv).

                  O DEFEITO: o servidor passou a separar o preço NEGOCIADO no
                  balcão do preço que veio da busca e ficou velho (a linha bipada
                  às 13h50 e cobrada às 14h10, depois de o gestor subir o preço),
                  e a tela não dizia qual era qual — toda diferença virava "preço
                  abaixo do vigente", e o relatório de concessão acusava o
                  operador de um desconto que ninguém digitou. `precoDigitado` é
                  a marca que só o campo de preço (e o documento) escreve.
                */
                precoNegociado: Boolean(l.precoDigitado),
              })),
              payments,
              cashSessionId: cash?.id ?? null,
              // O caixa deste computador (GAP-PRD-039): o servidor confere que é
              // o mesmo da gaveta. Sem caixa cadastrado vai vazio, como sempre.
              terminalId: caixaDoComputador?.terminal?.id ?? undefined,
              customerId: customer?.id ?? null,
              // Quem vendeu. Sem isto o servidor grava o operador logado.
              sellerId: sellerId || undefined,
              discountCents: contas.discount || undefined,
              estimatedTotalCents: contas.total,
              /*
                Juros de parcelamento e frete, lançados no pagamento — onde a
                tela sempre mandou lançá-los. O servidor tem a coluna, a recusa
                de valor negativo e a regra de não inflar a base de comissão.
              */
              surchargeCents: surchargeCents || undefined,
              // O vale do cliente abatendo esta venda. Fora de `payments` porque
              // não é dinheiro que entrou: é dívida que a loja deixou de dever.
              customerCreditCents: customerCreditCents || undefined,
              authorizationId: authId ?? authorizationId ?? undefined,
              note: note || undefined,
              /*
                O RASTRO DOS ITENS CANCELADOS viaja junto da venda (GAP-V52/V63).

                O retrato local vira linha em core_sale_removed_items, na MESMA
                transação da venda — e é o servidor que carimba QUEM removeu,
                pelo token.
              */
              cancelledItems: cancelados.length > 0 ? cancelados : undefined,
            },
            chaveDaVenda,
          );
          setShowPayment(false);
          setPendingPayments(null);
          setAuthorizationId(null);
          const valores = sale as typeof sale & {
            subtotal_cents?: number;
            discount_cents?: number;
            surcharge_cents?: number;
            nfceNoFinalizar?: DisparoDaNfce;
          };
          registrarVendaConcluida({
            saleId: sale.id,
            numero: sale.number,
            totalCents: sale.total_cents,
            trocoCents: sale.change_cents,
            subtotalCents: valores.subtotal_cents ?? sale.total_cents,
            descontoCents: valores.discount_cents ?? 0,
            acrescimoCents: valores.surcharge_cents ?? 0,
            pagamentos: pagamentosDaTela(payments, customerCreditCents),
            itens: retratoDoCarrinho(linhasDaVenda),
            disparo: valores.nfceNoFinalizar ?? null,
            houveDinheiro: payments.some((p) => p.method === 'dinheiro'),
          });
          limparVenda({ leituraDoInicio });
          /*
            O RESUMO DO CUPOM É O QUE O SERVIDOR GRAVOU (F-cupom-fiscal-M04).

            A tela montava o resumo pelo carrinho, e o TOTAL vinha do servidor: o
            servidor cobra o vigente de agora (promoção que entrou, faixa por
            quantidade, tabela do cliente), e a tela mostrava "TOTAL R$ 19,90"
            com "1 × item R$ 21,90" logo abaixo. A tela abre na hora com o
            carrinho — o cliente está esperando — e as linhas GRAVADAS entram
            assim que a ficha da venda chega. Sem a ficha, fica o carrinho.
          */
          const idDaVenda = sale.id;
          void coreApi
            .getSale(idDaVenda)
            .then((ficha) => {
              if (!Array.isArray(ficha?.items) || ficha.items.length === 0) return;
              const gravados = ficha.items.map((i) => ({
                descricao: i.description,
                quantidade: i.quantity,
                unitarioCents: i.unit_price_cents,
                totalCents: i.total_cents,
              }));
              setConcluida((c) =>
                c && c.saleId === idDaVenda
                  ? {
                      ...c,
                      itens: gravados.map(({ descricao, quantidade, totalCents }) => ({
                        descricao,
                        quantidade,
                        totalCents,
                      })),
                      comprovante: { ...c.comprovante, itens: gravados },
                    }
                  : c,
              );
            })
            .catch(() => undefined);
        } catch (err) {
          const apiError = err instanceof ApiRequestError ? err : null;
          /*
            A VENDA QUE ENTROU NA FILA NÃO É UMA VENDA QUE FALHOU.

            `API_QUEUED_OFFLINE` quer dizer "deu certo, só ainda não subiu": o
            POST está guardado com a chave de idempotência e sobe sozinho quando
            a conexão voltar. Do ponto de vista do balcão, acabou — e a tela
            precisa dizer isso, junto com a única instrução que evita o estrago.
          */
          if (apiError?.code === 'API_QUEUED_OFFLINE') {
            setShowPayment(false);
            setPendingPayments(null);
            setAuthorizationId(null);
            /*
              O TOTAL E O TROCO DA VENDA OFFLINE SÃO OS DO PAGAMENTO
              (D-pdv-teclado-08).

              Eram `pago - total` com o total do carrinho, SEM o acréscimo e
              SEM abater o vale: R$ 100,00 + R$ 10,00 de frete pagos com
              R$ 110,00 mostravam TROCO R$ 10,00 (o certo é zero), e o caixa
              devolvia dinheiro que não devia. O total da venda é o carrinho mais
              o acréscimo; o vale aparece como meio à parte; o troco é o que o
              diálogo calculou contra o que sobrou para os meios.
            */
            const totalDaVenda = contas.total + surchargeCents;
            const aCobrarNosMeios = Math.max(0, totalDaVenda - customerCreditCents);
            const pago = payments.reduce((s, p) => s + p.amountCents, 0);
            const troco = trocoInformado ?? Math.max(0, pago - aCobrarNosMeios);
            /*
              O CÓDIGO DA VENDA GUARDADA, NA FAIXA E NO PAPEL (PED-pdv-04).

              O comprovante saía "Venda offline 15:20": duas vendas do mesmo
              minuto tinham o mesmo nome, e o caixa não tinha como achar a venda
              do cliente depois em "Regularizar". O código é o mesmo que a barra
              de conexão e a regularização mostram — tirado da chave da venda.
            */
            const codigo = codigoDaVendaGuardada(chaveDaVenda);
            setMessage({
              tone: 'ok',
              text:
                `Venda guardada na fila (código ${codigo}) — ${formatCents(totalDaVenda)}`
                + (troco > 0 ? ` — TROCO ${formatCents(troco)}` : '')
                + '. Sobe sozinha quando a conexão voltar. NÃO refaça esta venda.',
            });
            // A venda offline não tem id no servidor: o painel fiscal não pode
            // continuar apontando para a venda anterior (D-pdv-teclado-M04) —
            // o papel dela é o da tela de venda concluída.
            setLastSaleId(null);
            setDisparoFiscal(null);
            const itens = retratoDoCarrinho(linhasDaVenda);
            const pagamentos = pagamentosDaTela(payments, customerCreditCents);
            setErroDaImpressao(null);
            setImprimindoConcluida(false);
            setConcluida({
              saleId: null,
              documentoFiscalId: null,
              numero: null,
              totalCents: totalDaVenda,
              trocoCents: troco,
              pagamentos,
              itens: itens.map(({ descricao, quantidade, totalCents }) => ({ descricao, quantidade, totalCents })),
              estadoFiscal: { tipo: 'offline' },
              comprovante: {
                quando: new Date(),
                identificacao:
                  `Venda offline ${new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`
                  + ` · código ${codigo}`,
                itens,
                // Bruto, descontos CALCULADOS (linha + rodapé) e acréscimo — e
                // não um "desconto" fabricado pela diferença.
                subtotalCents: contas.bruto,
                descontoCents: contas.descontoDeLinhas + contas.discount,
                acrescimoCents: surchargeCents,
                totalCents: totalDaVenda,
                pagamentos,
                trocoCents: troco,
                offline: true,
                // A bobina DESTE caixa (PED-pdv-01): 58 mm sai cortado no molde de 80.
                larguraMm: larguraDoCupom,
              },
            });
            limparVenda({ leituraDoInicio });
          } else if (apiError?.code === 'CORE_DISCOUNT_NEEDS_AUTHORIZATION') {
            // Desconto acima da alçada: em vez de perder a venda, o operador
            // chama o gestor ali mesmo e volta para o mesmo carrinho.
            setPendingPayments(payments);
            setAuthReason(apiError.message);
            setAuthError(null);
            setShowAuth(true);
            /*
              Os números do SERVIDOR ficam na tela, atrás do diálogo: o gestor
              que vem liberar pergunta liberar o quê, e por quê — `origens`
              responde. Detalhe ausente devolve nulo, e a mensagem do servidor
              aparece sozinha no diálogo.
            */
            setRecusaDeAlcada(detalheDeConcessao(apiError.details));
          } else if (apiError?.code === 'CORE_PRODUCT_WITHOUT_PRICE') {
            /*
              PRODUTO SEM PREÇO — a recusa que precisa dizer o que fazer. A tela
              mostra o texto DO SERVIDOR e marca a linha. Sai do diálogo de
              pagamento de propósito: o conserto é no carrinho.
            */
            const detalhe = apiError.details as { productId?: string } | undefined;
            setShowPayment(false);
            setRecusaSemPreco({
              productId: typeof detalhe?.productId === 'string' ? detalhe.productId : null,
              texto: apiError.message,
            });
          } else if (apiError?.code === 'CORE_INVALID_DISCOUNT') {
            /*
              DESCONTO QUE NÃO CABE — a recusa que precisa APONTAR A LINHA.

              As linhas saem de duas fontes, e elas SE SOMAM: o SERVIDOR (que
              nomeia todas em `productIds`, ou a primeira em `productId` num
              servidor anterior) e a conta da própria tela, que é a MESMA dele.
              Nenhuma das duas achando, a lista fica VAZIA — e a faixa lista as
              linhas que TÊM desconto, sem marcar a errada.
            */
            const detalhe = apiError.details as
              | { productId?: string; productIds?: unknown }
              | undefined;
            const listaDoServidor = Array.isArray(detalhe?.productIds)
              ? detalhe.productIds.filter((id): id is string => typeof id === 'string')
              : [];
            const doServidor = listaDoServidor.length > 0
              ? listaDoServidor
              : typeof detalhe?.productId === 'string'
                ? [detalhe.productId]
                : [];
            const achadas = linhasComDescontoImpossivel(linhasDaVenda).map((l) => l.product.id);
            setShowPayment(false);
            setRecusaDeDesconto({
              productIds: [...new Set([...doServidor, ...achadas])],
              texto: apiError.message,
              comDesconto: linhasDaVenda
                .filter((l) => (l.discountCents ?? 0) > 0)
                .map((l) => `${l.product.name} (${formatCents(l.discountCents ?? 0)})`),
            });
          } else if (apiError?.code === 'CORE_PRODUCT_NOT_FOUND') {
            /*
              O PRODUTO INATIVADO ENTRE O BIPE E O FINALIZAR (G-offline-sync-09#pdv).

              O DEFEITO: a recusa caía no ramo genérico — a frase no diálogo de
              pagamento, nada marcado no carrinho, e o operador com doze linhas
              e o cliente na frente sem saber qual tirar. O servidor passou a
              mandar `productId`, `name` e `inativo`: o pagamento fecha (o
              conserto é no carrinho), a linha fica marcada e a faixa diz qual é,
              com o "Tirar do carrinho" da recusa que aponta linha.

              Com DOCUMENTO no balcão, tirar a linha da tela não muda nada — a
              conversão fatura o documento. Aí a faixa nomeia o produto e diz o
              caminho (editar o documento), sem oferecer o botão.
            */
            const detalhe = apiError.details as
              | { productId?: unknown; name?: unknown; inativo?: unknown }
              | undefined;
            const idRecusado =
              typeof detalhe?.productId === 'string' && detalhe.productId ? detalhe.productId : null;
            const linhaRecusada = idRecusado
              ? linhasDaVenda.find((l) => l.product.id === idRecusado)
              : undefined;
            const nome =
              typeof detalhe?.name === 'string' && detalhe.name
                ? detalhe.name
                : linhaRecusada?.product.name ?? null;
            /*
              Revisão: a frase do documento dizia "tire o item do Pré-venda" (o
              rótulo com maiúscula, no masculino), e sem `inativo` mostrava a do
              servidor — "tire a linha do carrinho e bipe de novo" —, que não vale
              para o documento: a conversão fatura o que está gravado nele.
            */
            const inativo = detalhe?.inativo === true;
            const doDocumento = loadedQuote?.kind === 'pre_venda' ? 'da pré-venda' : 'do orçamento';
            setShowPayment(false);
            setPendingPayments(null);
            setRecusaSemPreco({
              productId: loadedQuote ? null : linhaRecusada ? idRecusado : null,
              motivo: 'nao_vendavel',
              texto: loadedQuote
                ? `A venda NÃO foi registrada: ${nome ? `"${nome}"` : 'um item'} ${doDocumento} `
                  + (inativo ? 'foi inativado no cadastro' : 'não existe mais nesta operação')
                  + ` — tire o item ${doDocumento} em Orçamentos${inativo ? ' (ou reative o produto)' : ''} `
                  + 'para faturar.'
                : inativo && nome
                  ? `A venda NÃO foi registrada: "${nome}" foi inativado no cadastro — tire do carrinho `
                    + 'para finalizar.'
                  : `A venda NÃO foi registrada: ${apiError.message}`,
            });
          } else if (apiError?.code === 'CORE_CASH_SESSION_REQUIRED') {
            /*
              VENDA EM CARTÃO OU PIX SEM GAVETA ABERTA (E-venda-servidor-08#pdv).

              O servidor passou a exigir turno aberto também para a venda de
              balcão sem dinheiro (a venda no cartão entra na conferência da
              maquininha do turno). A recusa caía no ramo genérico: a frase no
              diálogo de pagamento e o operador sem saída — nenhum botão de abrir
              o caixa ali. Chega aqui quando a tela não sabia da gaveta (a
              consulta falhou) ou há várias gavetas sem dizer qual. O pagamento
              fecha, a gaveta é relida e o diálogo do caixa abre na abertura (ou
              na escolha do caixa) — com o CARRINHO E A CHAVE intactos: aberto o
              caixa, o Finalizar manda a mesma venda, e nada é cobrado duas vezes.
            */
            /*
              Revisão: com VÁRIAS gavetas abertas o servidor manda escolher o
              caixa deste computador, e o fim fixo "abra o caixa" contradizia a
              frase dele — o diálogo mostra a escolha, não a abertura.
            */
            const variasGavetas = Array.isArray(
              (apiError.details as { gavetasAbertas?: unknown } | undefined)?.gavetasAbertas,
            );
            const aviso =
              `${apiError.message} A venda NÃO foi registrada; o carrinho continua na tela — `
              + (variasGavetas
                ? 'escolha o caixa deste computador e finalize de novo.'
                : 'abra o caixa e finalize de novo.');
            setShowPayment(false);
            setPendingPayments(null);
            recarregarCaixa();
            setAcaoDoCaixa(null);
            setAvisoDoCaixa(aviso);
            setShowCaixa(true);
            setMessage({ tone: 'error', text: aviso });
          } else if (
            apiError?.code === 'CORE_CASH_SESSION_CLOSED'
            || apiError?.code === 'CORE_CASH_SESSION_INVALID'
          ) {
            /*
              O TURNO FOI FECHADO EM OUTRA TELA (H-caixa-seguranca-M01).

              O PDV do balcão fica em primeiro plano o dia inteiro — a volta do
              foco, que relê a gaveta, nunca acontece. O gerente fecha o turno no
              computador dele, e toda venda daqui era recusada com a gaveta velha
              na tela: o F3 mostrava "Caixa aberto" de uma sessão fechada, sem
              "Abrir caixa". Agora a recusa relê a gaveta, esquece a lembrança
              dela (G-offline-sync-02) e abre o caixa — com o carrinho intacto.
            */
            setShowPayment(false);
            setPendingPayments(null);
            gravarUltimoCaixa(empresaDaSessao, null);
            setCash(null);
            recarregarCaixa();
            setAcaoDoCaixa(null);
            setShowCaixa(true);
            setMessage({
              tone: 'error',
              text:
                `${apiError.message} A venda NÃO foi registrada; o carrinho continua na tela — `
                + 'abra o caixa e finalize de novo.',
            });
          } else if (apiError?.code === 'CORE_SALE_TOTAL_CHANGED') {
            /*
              O PREÇO MUDOU ENTRE O BIPE E O FINALIZAR (PED-pdv-02).

              O servidor recusa quando o preço vigente baixou (promoção, faixa,
              tabela do cliente) e o pagamento eletrônico passa do novo total —
              e manda, linha a linha, o preço de agora. A tela caía no ramo
              genérico: faixa vermelha com o carrinho no preço velho, e o
              operador refazia a mesma venda para tomar a mesma recusa. Aqui as
              linhas passam ao preço de agora, o pagamento fecha (o valor mudou)
              e a faixa diz o que mudou. A chave da venda é a mesma: nada foi
              gravado, e nada é cobrado duas vezes.
            */
            const detalhe = apiError.details as { linhas?: unknown } | undefined;
            const mudadas = (Array.isArray(detalhe?.linhas) ? detalhe.linhas : [])
              .map((l) => l as { productId?: unknown; name?: unknown; informadoCents?: unknown; vigenteCents?: unknown })
              .filter(
                (l): l is { productId: string; name: unknown; informadoCents: number; vigenteCents: number } =>
                  typeof l.productId === 'string'
                  && typeof l.vigenteCents === 'number'
                  && typeof l.informadoCents === 'number',
              );
            setShowPayment(false);
            setPendingPayments(null);
            if (mudadas.length > 0) {
              const porProduto = new Map(mudadas.map((l) => [l.productId, l.vigenteCents]));
              setLines((prev) =>
                prev.map((l) => {
                  const vigente = porProduto.get(l.product.id);
                  if (vigente === undefined) return l;
                  return comDescontoDentroDoTeto({
                    ...l,
                    unitPriceCents: vigente,
                    precoNegociadoCents: l.precoDigitado ? vigente : l.precoNegociadoCents,
                    product: { ...l.product, effective_price_cents: vigente },
                    // O número veio do servidor, para ESTE cliente e ESTA quantidade.
                    precificadaPara: clienteDaVenda(customer?.id),
                    precificadaQtd: l.quantity,
                  });
                }),
              );
              for (const l of mudadas) esquecerRascunhos(l.productId);
              setMessage({
                tone: 'error',
                text:
                  'Venda NÃO finalizada: '
                  + mudadas
                    .map(
                      (l) =>
                        `o preço de "${String(l.name ?? 'item')}" mudou de ${formatCents(l.informadoCents)} `
                        + `para ${formatCents(l.vigenteCents)}`,
                    )
                    .join('; ')
                  + ' — confira com o cliente e finalize de novo. Se o cartão já passou na maquininha, '
                  + 'estorne a diferença no aparelho.',
              });
            } else {
              setMessage({ tone: 'error', text: apiError.message });
            }
          } else if (apiError?.code === 'CORE_IDEMPOTENCY_KEY_REUSED') {
            /*
              A TENTATIVA JÁ REGISTROU OUTRA VENDA (RES-IDEM-TELA) — lida pelo
              CÓDIGO, e dita na língua do caixa. O pagamento sai de cena e o
              diálogo pergunta: voltar ao carrinho, ou registrar este carrinho
              como venda nova. Nada é reenviado sem a escolha.
            */
            const detalhe = apiError.details as { saleId?: unknown; saleNumber?: unknown } | undefined;
            setShowPayment(false);
            setPendingPayments(null);
            setVendaDaTentativa(null);
            setTentativaReusada({
              saleId: typeof detalhe?.saleId === 'string' ? detalhe.saleId : null,
              saleNumber: typeof detalhe?.saleNumber === 'number' ? detalhe.saleNumber : null,
              reenvio: { payments, authId: authId ?? null, surchargeCents, customerCreditCents },
            });
          } else if (showPayment) {
            setPaymentError(apiError?.message ?? 'Falha ao finalizar a venda.');
          } else {
            setMessage({
              tone: 'error',
              text: apiError?.message ?? 'Falha ao finalizar a venda.',
            });
          }
        }
      } finally {
        busyRef.current = false;
        setBusy(false);
        vendaEmCurso.current = null;
        terminarVenda();
      }
    },
    // `sellerId` entra na lista: sem ele a venda fecharia sempre com o
    // vendedor inicial. As linhas e o rastro de cancelados NÃO entram: são
    // lidos das refs depois de a leitura em curso chegar (o rastro, junto com
    // a redução ainda em digitação — `fecharReducoesEmDigitacao`).
    [cash, vendaSemGaveta, saleKey, limparVenda, customer, descontoTexto, note, authorizationId, showPayment, loadedQuote, sellerId, fecharReducoesEmDigitacao, caixaDoComputador, registrarVendaConcluida, precoDoCarrinhoEmDia, recarregarCaixa, empresaDaSessao, esquecerRascunhos, larguraDoCupom],
  );

  /** Fecha em dinheiro pelo valor exato — o caminho rápido do balcão (F8). */
  const finalizeCashExact = useCallback(() => {
    // O valor é calculado DEPOIS de a leitura em curso entrar (D-pdv-teclado-02).
    void finalize('dinheiro-exato');
  }, [finalize]);

  /**
   * "Registrar como venda nova" (RES-IDEM-TELA): o carrinho ATUAL, com o
   * pagamento que o caixa acabou de montar, sai com chave NOVA. A venda #N que
   * a tentativa já registrou continua como está.
   */
  const registrarComoVendaNova = useCallback(() => {
    if (!tentativaReusada) return;
    const { reenvio } = tentativaReusada;
    const nova = newIdempotencyKey();
    setSaleKey(nova);
    setTentativaReusada(null);
    setVendaDaTentativa(null);
    void finalize(reenvio.payments, reenvio.authId, reenvio.surchargeCents, reenvio.customerCreditCents, nova);
  }, [tentativaReusada, finalize]);

  /** Voltar ao carrinho: nada é reenviado, e a chave fica — reenviar a mesma cesta devolve a #N. */
  const voltarDaTentativaReusada = useCallback(() => {
    setTentativaReusada(null);
    setVendaDaTentativa(null);
  }, []);

  /** "Ver a venda #N": ler não é registrar. */
  const verVendaDaTentativa = useCallback(async () => {
    const saleId = tentativaReusada?.saleId;
    if (!saleId) return;
    setVendaDaTentativa('carregando');
    try {
      setVendaDaTentativa(await coreApi.getSale(saleId));
    } catch {
      setVendaDaTentativa('erro');
    }
  }, [tentativaReusada?.saleId]);

  /**
   * Abre a lista de documentos abertos esperando o balcão.
   *
   * ORÇAMENTO TAMBÉM ENTRA (GAP-V68), e a ausência dele aqui era um caminho a
   * mais para o operador sem nenhuma proteção em troca: `POST
   * /quotes/:id/convert` sempre aceitou orçamento, sempre foi testado e herda a
   * mesma idempotência. Filtrando `kind: 'pre_venda'`, o cliente que fechava na
   * hora obrigava dois passos — Aprovar (que cria pré-venda e RESERVA
   * mercadoria por sete dias) e só então F9 —, ou fazia o operador redigitar
   * tudo no balcão, que é como o preço aprovado se perde.
   *
   * A lista continua sendo só de documento ABERTO. Cada linha diz de que tipo
   * é, porque a diferença importa para quem olha: a pré-venda já tirou a peça
   * do disponível, o orçamento não tirou nada e pode esbarrar em falta de saldo
   * na hora de fechar — e é melhor descobrir isso lendo a linha do que no erro.
   */
  const openQuotes = useCallback(async () => {
    setShowQuotes(true);
    setQuotes(null);
    try {
      const abertos = await coreApi.listQuotes({ status: 'aberto' });
      setQuotes(abertos);
    } catch (err) {
      setQuotes([]);
      setMessage({
        tone: 'error',
        text: err instanceof ApiRequestError ? err.message : 'Falha ao listar os documentos.',
      });
    }
  }, []);

  /** Carrega os itens da pré-venda no carrinho — sem redigitar produto. */
  const loadQuote = useCallback(async (quote: Quote) => {
    try {
      const detail = await coreApi.getQuote(quote.id);
      const carregadas: CartLine[] = [];
      // As motos já postas numa linha não voltam para a seguinte do mesmo produto.
      const usadas = new Set<string>();
      for (const item of detail.items) {
        if (!item.product_id) continue;
        const product = await coreApi.getProduct(item.product_id);
        /*
          A MOTO DO DOCUMENTO ENTRA NA LINHA COM O CHASSI (GAP-PRD-025/111).

          A conversão era recusada por não saber qual moto sai. A linha já nasce
          com a que a pré-venda segura e, faltando, a mais antiga LIVRE — e
          MOSTRA o chassi, para o operador conferir contra a moto no pátio. Se
          for outra, ele bipa o chassi certo na busca, que troca a da linha.
          Falhando a lista, a linha vai sem chassi e o servidor escolhe.
        */
        let unidades: ProductUnit[] | undefined;
        if (product.serialized === 1) {
          try {
            const noEstoque = await coreApi.listUnits(product.id, 'in_stock');
            unidades = escolherUnidadesDoDocumento(noEstoque, quote.id, item.quantity, usadas);
            unidades.forEach((u) => usadas.add(u.id));
          } catch {
            unidades = undefined;
          }
        }
        carregadas.push({
          product,
          quantity: item.quantity,
          unitPriceCents: item.unit_price_cents,
          ...(unidades
            ? {
                unitIds: unidades.map((u) => u.id),
                unitLabel: unidades.map(rotuloDaUnidade).join(', '),
                unidadesSemPlaquinha: contarSemPlaquinha(unidades),
              }
            : {}),
          /*
            PREÇO DE DOCUMENTO É NEGOCIAÇÃO GRAVADA, não herança do vigente.

            O cliente aprovou um número. Deixar a reprecificação escrever por
            cima faria a pré-venda aprovada por R$ 10.000 virar R$ 12.000 na
            hora de faturar, porque a tabela subiu no intervalo — e quem
            explicaria isso ao cliente é o operador, que não teve parte na
            decisão. `precoDigitado` faz a reprecificação apenas LIMITAR o valor
            ao novo vigente: se o preço caiu (o cliente virou revendedor no
            meio-tempo), ele leva o menor; se subiu, continua valendo o
            aprovado.
          */
          precoDigitado: true,
          // O número que o cliente aprovou no documento. É contra ele que o
          // teto é medido, e não contra o preço já reescrito pela tela.
          precoNegociadoCents: item.unit_price_cents,
          /*
            Sem marca de cliente de propósito: o item veio do documento e nunca
            passou pela precificação desta tela. Indefinido não bate com cliente
            nenhum — nem com "sem cliente" —, então a linha é conferida contra o
            servidor assim que entra, que é o que atualiza o VIGENTE dela. Sem
            isso, o painel de concessão mediria a pré-venda contra o preço de
            cadastro e acusaria desconto que ninguém deu.
          */
        });
      }
      /*
        O CLIENTE DO DOCUMENTO VEM JUNTO — e sem isto a tela e o servidor
        faturavam clientes diferentes.

        A pré-venda foi feita PARA alguém. Carregá-la deixando o carrinho no
        cliente anterior (ou em nenhum) criava a divergência mais cara desta
        rodada: a tela reprecificava pelo cliente do CARRINHO e o servidor
        faturava pelo cliente do DOCUMENTO, que é o que `createSale` recebe. O
        operador via um total e o cupom saía com outro, sem erro em lugar
        nenhum.

        O cliente é buscado de verdade, e não montado à mão com id e nome: um
        objeto parcial mentiria sobre a tabela de preço dele, que é justamente
        o campo que decide o valor daqui para a frente.
      */
      if (detail.customer_id) {
        try {
          /*
            A FICHA DO SERVIDOR, e não um objeto montado à mão: `{ id, name }`
            na marra pareceria funcionar e mentiria sobre a tabela de preço
            dele, que é justamente o campo que decide o valor daqui para a
            frente. E só a ficha — ela não abre o painel de escolha: carregar
            pré-venda não é pedir para trocar de cliente.

            PELO ID, e não procurando na lista (GAP-PRD-070): a lista sem
            termo traz só os 100 primeiros em ordem de nome. A pré-venda da
            "Zuleide" carregava com o carrinho em "Consumidor final" enquanto
            o servidor faturava para ela — exatamente a divergência que este
            bloco existe para impedir.
          */
          const cliente = await coreApi.getCustomer(detail.customer_id);
          setCustomer(cliente?.id === detail.customer_id ? cliente : null);
        } catch {
          // Cliente inacessível: a venda segue sem ele, e as linhas ficam
          // pendentes de precificação — que é o estado honesto.
          setCustomer(null);
        }
      } else {
        setCustomer(null);
      }

      setLines(carregadas);
      // O documento no balcão é o carrinho novo: o painel da venda anterior
      // sai aqui (PED-pdv-10), e não no F6 do carrinho vazio.
      setLastSaleId(null);
      setDisparoFiscal(null);
      // O desconto do DOCUMENTO entra escrito em reais no campo do rodapé —
      // que fica travado enquanto a pré-venda estiver no balcão, porque a
      // conversão cobra o que está no documento, não o que a tela mostrar.
      setDescontoTexto(reaisNoCampo(detail.discount_cents ?? 0));
      setLoadedQuote(quote);
      setShowQuotes(false);
      setMessage({
        tone: 'ok',
        text:
          `${rotuloDoDocumento(quote.kind)} #${quote.number} carregado — `
          + `${carregadas.length} item(ns). Finalize para faturar.`,
      });
    } catch (err) {
      setMessage({
        tone: 'error',
        text: err instanceof ApiRequestError ? err.message : 'Falha ao carregar o documento.',
      });
    }
  }, []);

  /**
   * O DOCUMENTO QUE VEIO PELA URL — a mão dada por Orçamentos (GAP-V68).
   *
   * "Faturar" na tela de orçamentos navega para `/pdv?documento=<id>`, e o
   * balcão o carrega pelo MESMO caminho do F9. Não há um segundo carregador: a
   * lista e a URL chamam a mesma função, então tudo o que ela aprendeu a fazer
   * — congelar o preço aprovado, trazer o cliente do documento, travar o
   * desconto — vale igual nos dois caminhos.
   *
   * O parâmetro é CONSUMIDO ao entrar (`replace: true`): sem isso, um F5 no
   * balcão recarregaria o documento por cima de um carrinho já digitado.
   */
  useEffect(() => {
    const documentoId = searchParams.get('documento');
    if (!documentoId) return;
    setSearchParams({}, { replace: true });
    void (async () => {
      try {
        const detail = await coreApi.getQuote(documentoId);
        await loadQuote(detail);
      } catch (err) {
        setMessage({
          tone: 'error',
          text: err instanceof ApiRequestError ? err.message : 'Falha ao abrir o documento.',
        });
      }
    })();
  }, [searchParams, setSearchParams, loadQuote]);

  const openPayment = useCallback(() => {
    if (lines.length === 0) {
      // Bipe e F10 no mesmo instante: a leitura ainda está chegando. O
      // pagamento abre quando ela entrar, em vez de dizer "Carrinho vazio".
      if (leiturasPendentes.current.length > 0) {
        void filaDeLeitura.current.then(() => {
          if (linhasRef.current.length > 0) {
            setPaymentError(null);
            setShowPayment(true);
          }
        });
        return;
      }
      setMessage({ tone: 'error', text: 'Carrinho vazio.' });
      return;
    }
    // A recusa chega ANTES de o cliente escolher a forma de pagamento — não
    // depois de ele já ter contado o dinheiro no balcão.
    if (vendaSemGaveta) {
      setMessage({ tone: 'error', text: 'Caixa fechado — abra o caixa antes de vender.' });
      setShowCaixa(true);
      return;
    }
    /*
      O PAGAMENTO ABRE COM O PREÇO EM DIA (G-offline-sync-M01). Com a linha
      pendente de preço (o terceiro bipe que muda a faixa), o diálogo abria no
      total de antes, o operador passava esse valor na maquininha, e o servidor
      recusava a sobra. A tela espera a resposta de preço; sem resposta (a rede),
      abre assim mesmo — quem decide é o servidor.
    */
    if (precoNoAr.current || linhasParaReprecificar(linhasRef.current, idDoCliente).length > 0) {
      void precoDoCarrinhoEmDia().then(() => {
        setPaymentError(null);
        setShowPayment(true);
      });
      return;
    }
    setPaymentError(null);
    setShowPayment(true);
  }, [lines.length, vendaSemGaveta, idDoCliente, precoDoCarrinhoEmDia]);

  /** O gestor digita a credencial e a venda segue de onde parou. */
  const confirmAuthorization = useCallback(
    async (login: string, password: string, justificativa?: string) => {
      setAuthBusy(true);
      setAuthError(null);
      try {
        /*
          O MOTIVO REGISTRADO PRECISA SER A CONCESSÃO INTEIRA.

          Estava `Desconto de ${discount}` — o desconto do RODAPÉ. No PDV esse
          campo é quase sempre zero: não há onde digitá-lo, ele só chega de uma
          pré-venda carregada. Ou seja, a autorização mais comum do balcão ficava
          registrada como "Desconto de R$ 0,00", e o dono lendo a auditoria
          depois via um gestor liberando nada.

          A fonte é a recusa do servidor quando ela existe — é o número que
          motivou a liberação —, e a prévia da tela como segunda opção.
        */
        const fonte = recusaDeAlcada ?? concessao;
        const de = origensEmPalavras(fonte.origens, formatCents);
        /*
          OS NÚMEROS VÃO COMO NÚMERO, e não só dentro da frase.

          Esta chamada mandava os três valores costurados no `reason` e mais
          nada. O servidor guardava a frase, e uma frase não se compara com
          carrinho nenhum: a liberação nascia SEM TETO. Ela continuava valendo
          uma vez só — o consumo já era gasto no documento —, mas essa uma vez
          valia para QUALQUER valor. O gestor autorizava 28% olhando a tela, o
          operador voltava ao carrinho, rebaixava mais o preço e fechava com
          60% usando o mesmo "sim". Nada no sistema notava, porque não havia o
          que notar: o número que o gestor viu nunca foi gravado como número.

          Com `concedidoCents` e `brutoCents` no corpo, o servidor guarda o
          teto em `granted_concession_cents`/`granted_gross_cents`, e
          `consumirLiberacaoDeConcessao` recalcula o percentual na hora de
          gastar a liberação: documento que concede mais do que foi liberado é
          recusado com os dois percentuais na mensagem.

          O `reason` CONTINUA, e não é redundância. Ele é o que a pessoa lê na
          tela de autorizações — "Concessão de R$ 3.400,00 (28%) sobre
          R$ 12.000,00 na venda X, de R$ 400,00 de desconto no rodapé" conta a
          história que dois inteiros não contam. Um é para conferir, o outro é
          para comparar; trocar um pelo outro perde metade.

          A fonte é a mesma dos dois: `recusaDeAlcada ?? concessao`. Assim o
          que o gestor LÊ e o que o servidor MEDE saem do mesmo lugar — se
          fossem calculados em pontos diferentes, a frase poderia dizer 28%
          enquanto o teto gravado dizia outra coisa, e aí a liberação recusaria
          a própria venda que a motivou.
        */
        const granted = await coreApi.authorize({
          action: 'desconto_acima_limite',
          login,
          password,
          concedidoCents: fonte.concedidoCents,
          brutoCents: fonte.brutoCents,
          reason:
            `Concessão de ${formatCents(fonte.concedidoCents)} (${fonte.percentual}%) `
            + `sobre ${formatCents(fonte.brutoCents)} na venda ${saleKey}`
            + (de.length > 0 ? ` — ${de.join(', ')}` : ''),
          // O PORQUÊ digitado (P0 da Preço Justo); vazio não viaja.
          justificativa: justificativa || undefined,
        });
        setAuthorizationId(granted.id);
        setShowAuth(false);
        await finalize(pendingPayments ?? 'dinheiro-exato', granted.id);
      } catch (err) {
        setAuthError(
          err instanceof ApiRequestError ? err.message : 'Não foi possível autorizar.',
        );
      } finally {
        setAuthBusy(false);
      }
    },
    // `discount` saiu e `concessao`/`recusaDeAlcada` entraram: o motivo
    // registrado passou a ser a concessão inteira, e não só o rodapé.
    [concessao, recusaDeAlcada, saleKey, finalize, pendingPayments],
  );

  // F2 e o botão "Cliente" abrem o MESMO diálogo — busca viva, cadastro
  // rápido e o consumidor final moram todos em `ClientePdvDialog`.
  const openCustomers = useCallback(() => {
    setShowClientes(true);
  }, []);

  /*
    ESC FECHA O QUE A TELA DIZ QUE ESC FECHA.

    O botão do modal de pré-vendas se chama "Fechar (Esc)" e a ajuda ensina
    que Esc fecha modal. Este era escrito à mão, sem `onKeyDown` e sem ouvinte
    — e o handler da página está desligado justamente enquanto ele está
    aberto, então a tecla não ia para lugar nenhum. Prometer tecla que não
    funciona é pior que não prometer: a pessoa aperta duas, três vezes antes
    de desconfiar.
  */
  useEffect(() => {
    if (!showQuotes) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      setShowQuotes(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [showQuotes]);

  // A mesma regra para o diálogo da observação: Esc fecha SEM salvar — o
  // rascunho morre e a observação que já existia continua valendo.
  useEffect(() => {
    if (!showNota) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      setShowNota(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [showNota]);

  // Atalhos de balcão. Enquanto um modal está aberto ele é quem responde às
  // teclas — senão F5 dispararia a venda por baixo da tela de pagamento.
  useEffect(() => {
    // `showCaixa` estava fora desta lista, e o diálogo do caixa é o único que
    // não trata tecla nenhuma: F8 finalizava a venda POR BAIXO dele. Desde
    // que a abertura sobe sozinha, esse é o estado mais comum da tela no
    // começo do dia.
    // `tentativaReusada` idem (RES-IDEM-TELA): o F8 por reflexo, com a recusa
    // da chave na tela, finalizava por baixo dela — um POST sem escolha, e a
    // recusa que voltava trocava o pagamento guardado para o reenvio por
    // "dinheiro, valor exato".
    if (showPayment || showAuth || showQuotes || showCaixa || showNota || showPesquisa || showClientes || showOsAReceber || showAbrirOs || tentativaReusada || confirmarCancelamento) return;
    const onKey = (e: KeyboardEvent) => {
      /*
        MODAL DE FORA DO PDV TAMBÉM RESPONDE ÀS TECLAS (RES-IDEM-TELA).

        A lista acima só conhece os modais DESTA página. "Regularizar" (a venda
        guardada que o servidor recusou) abre por cima do balcão pela barra de
        conexão — e é para lá que a recusa da chave reusada manda relançar como
        venda nova. Com ele aberto e o carrinho montado, F8 finalizava a venda
        do carrinho POR BAIXO, em dinheiro, sem o caixa ver. Qualquer diálogo
        modal na tela desliga os atalhos.
      */
      if (document.querySelector('[aria-modal="true"]')) return;
      // Observação saiu de F12 para Alt+O. Vem antes do mapa porque o `e.key`
      // de Alt+O é a própria letra, e não uma tecla de função.
      if (e.altKey && (e.key === 'o' || e.key === 'O')) {
        e.preventDefault();
        editarObservacao();
        return;
      }

      /*
        OS ATALHOS DE GAVETA — Ctrl+F3 (sangria) e Shift+F3 (suprimento).

        Vêm antes do mapa porque o mapa não olha modificador: sem este desvio,
        Ctrl+F3 cairia no F3 comum e o atalho viraria sinônimo silencioso.
        Nenhum dos dois lança dinheiro: abrem o MESMO diálogo do caixa com a
        ação nomeada e o botão dela marcado — digitar e confirmar continua
        sendo gesto da pessoa.
      */
      if (e.key === 'F3' && (e.ctrlKey || e.shiftKey)) {
        e.preventDefault();
        setAcaoDoCaixa(e.ctrlKey ? 'sangria' : 'suprimento');
        setShowCaixa(true);
        return;
      }

      // Este mapa e a lista SHORTCUTS precisam concordar: a ajuda na tela
      // declarava F7, F12 e Esc que o handler não tratava, e o operador
      // apertava sem nada acontecer. Há teste cobrando a equivalência.
      //
      // F5, F11 e F12 estão FORA de propósito. Eram usadas aqui (F5 abria o
      // pagamento, F12 a observação) e o `preventDefault` abaixo engolia as
      // duas: no balcão, recarregar a página tinha virado abrir pagamento.
      // Tecla do sistema operacional pertence ao sistema operacional.
      const map: Record<string, () => void> = {
        F1: () => setShowHelp((v) => !v),
        F2: openCustomers,
        // F3 puro zera a ação: o caixa abre genérico, como sempre abriu.
        F3: () => {
          setAcaoDoCaixa(null);
          setShowCaixa(true);
        },
        // F4 abre a pesquisa avançada — o rótulo "Pesq. avançada (F4)" parou
        // de mentir nesta rodada (GAP-V57): antes a tecla só focava o campo.
        F4: () => setShowPesquisa(true),
        // Com carrinho, pergunta antes (D-pdv-teclado-12).
        F6: pedirCancelamento,
        F7: aguardarVenda,
        F8: finalizeCashExact,
        F9: () => void openQuotes(),
        F10: openPayment,
      };
      const action = map[e.key];
      if (action) {
        e.preventDefault();
        action();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openPayment, finalizeCashExact, pedirCancelamento, openCustomers, openQuotes, aguardarVenda, editarObservacao, showPayment, showAuth, showQuotes, showCaixa, showNota, showPesquisa, showClientes, showOsAReceber, showAbrirOs, tentativaReusada, confirmarCancelamento]);

  linhasRef.current = lines;
  removidosRef.current = removidos;
  loadedQuoteRef.current = loadedQuote;
  concluidaRef.current = concluida;
  runSearchRef.current = runSearch;
  // Lista nova, destaque no primeiro. O carimbo de QUAL termo a produziu é
  // posto por quem a produziu (`runSearch`, D-pdv-teclado-11): carimbar aqui,
  // com o termo que está na tela quando a lista chega, dava à resposta
  // atrasada o carimbo do termo novo — e o Enter escolhia da lista errada.
  useEffect(() => {
    setDestaque(0);
  }, [results]);

  /*
    AS TECLAS DE FUNÇÃO DO PDV NÃO VÃO PARA O NAVEGADOR, NEM COM DIÁLOGO
    ABERTO (D-pdv-teclado-18).

    O ouvinte dos atalhos sai de cena com qualquer diálogo aberto — e saía
    ANTES do `preventDefault`. No pagamento, o F6 por hábito punha o foco na
    barra de endereço do Chrome: o próximo bipe digitava o código lá e o Enter
    navegava para uma busca, levando o carrinho junto. F3 abria a busca da
    página, que passava a receber os bipes; F1 abria a ajuda do Chrome numa aba
    nova. Este ouvinte só SEGURA a tecla (sem `stopPropagation`): quem executa
    o atalho continua sendo o de sempre, e os diálogos continuam recebendo o
    F10 deles. F5, F11 e F12 seguem sendo do navegador.
  */
  useEffect(() => {
    const segurar = (e: KeyboardEvent) => {
      if (PDV_SHORTCUT_KEYS.includes(e.key)) e.preventDefault();
    };
    window.addEventListener('keydown', segurar, true);
    return () => window.removeEventListener('keydown', segurar, true);
  }, []);

  /*
    O BIPE QUE CAIU NO CAMPO ERRADO VOLTA PARA O CAMPO DE LEITURA
    (D-pdv-teclado-05).

    Quantidade, Preço Unitário e os campos da linha não devolviam o foco: o
    caixa corrigia a linha para "3", bipava o próximo produto, e o código ia
    para o campo — 37 trilhões de unidades, ou um desconto que zerava a linha.
    O produto bipado não entrava. Aqui a tela reconhece o leitor pelo ritmo
    (seis ou mais caracteres com menos de 50 ms entre eles, fechando em Enter),
    DESFAZ o que ele escreveu no campo errado (volta o valor de antes da
    rajada) e manda o código para a leitura. Gente não digita nesse ritmo; e o
    Enter comum desses campos devolve o foco ao campo de leitura.
  */
  useEffect(() => {
    let rajada: { campo: HTMLInputElement; antes: string; codigo: string; ultima: number } | null = null;
    const onKey = (e: KeyboardEvent) => {
      const campo = e.target;
      if (
        !(campo instanceof HTMLInputElement)
        || campo === searchRef.current
        || campo.closest('[aria-modal="true"]')
        || !campo.closest('[data-testid="pdv-raiz"]')
      ) {
        rajada = null;
        return;
      }
      if (e.key === 'Enter') {
        const r = rajada;
        rajada = null;
        if (
          r
          && r.campo === campo
          && r.codigo.length >= 6
          && e.timeStamp - r.ultima <= ENTRE_TECLAS_DO_LEITOR_MS
        ) {
          e.preventDefault();
          e.stopPropagation();
          // Síncrono: o valor desfeito precisa estar no estado antes da busca,
          // que lê Quantidade e Preço Unitário.
          flushSync(() => escreverNoCampo(campo, r.antes));
          searchRef.current?.focus();
          void runSearchRef.current?.(undefined, r.codigo);
        }
        return;
      }
      /*
        TECLA SEGURADA NÃO É LEITOR (PED-pdv-06). O navegador repete a tecla
        segurada a cada ~30 ms: seis repetições e um Enter cabiam no ritmo do
        leitor, e o campo voltava ao valor de antes com a "leitura" indo para a
        busca. O leitor manda cada caractere uma vez — repetição zera a rajada.
      */
      if (e.key.length !== 1 || e.ctrlKey || e.altKey || e.metaKey || e.repeat) {
        rajada = null;
        return;
      }
      if (!rajada || rajada.campo !== campo || e.timeStamp - rajada.ultima > ENTRE_TECLAS_DO_LEITOR_MS) {
        // A tecla ainda não entrou no campo: o valor de agora é o de ANTES.
        rajada = { campo, antes: campo.value, codigo: e.key, ultima: e.timeStamp };
      } else {
        rajada.codigo += e.key;
        rajada.ultima = e.timeStamp;
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // O rascunho da venda acompanha cada mudança do carrinho (D-pdv-teclado-06).
  useEffect(() => {
    if (lines.length === 0 && !loadedQuote) {
      gravarRascunhoDaVenda(chaveDoRascunho, null);
      return;
    }
    gravarRascunhoDaVenda(chaveDoRascunho, {
      lines,
      customer: customer ? { id: customer.id, name: customer.name } : null,
      descontoTexto,
      note,
      removidos,
      saleKey,
      loadedQuote,
      guardadoEm: new Date().toISOString(),
    });
  }, [chaveDoRascunho, lines, customer, descontoTexto, note, removidos, saleKey, loadedQuote]);

  /*
    Fechar ou recarregar a aba com venda montada (ou com o Finalizar no ar)
    PERGUNTA antes. E o rascunho só sobrevive à saída da PÁGINA (recarregar,
    fechar): sair do PDV por dentro do sistema desmonta a tela, e aí o rascunho
    sai junto — senão ele reapareceria semanas depois, com preço de outro dia.
  */
  useEffect(() => {
    let saindoDaPagina = false;
    const aoSair = (e: BeforeUnloadEvent) => {
      if (linhasRef.current.length > 0 || busyRef.current) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    const aoEsconder = () => {
      saindoDaPagina = true;
    };
    window.addEventListener('beforeunload', aoSair);
    window.addEventListener('pagehide', aoEsconder);
    return () => {
      window.removeEventListener('beforeunload', aoSair);
      window.removeEventListener('pagehide', aoEsconder);
      if (!saindoDaPagina) gravarRascunhoDaVenda(chaveDoRascunho, null);
    };
  }, [chaveDoRascunho]);

  // Com a pergunta do F6 na tela, F6 de novo confirma (D-pdv-teclado-12).
  useEffect(() => {
    if (!confirmarCancelamento) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'F6') return;
      e.preventDefault();
      e.stopPropagation();
      setConfirmarCancelamento(false);
      // O carrinho que sai da tela deixa rastro (D-pdv-teclado-12).
      cancelarVendaMontada();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [confirmarCancelamento, cancelarVendaMontada]);

  const fecharConcluida = useCallback(() => {
    setConcluida(null);
    setErroDaImpressao(null);
    setImprimindoConcluida(false);
    // A próxima venda começa com o leitor pronto: foco no campo, sem mouse.
    setTimeout(() => searchRef.current?.focus(), 0);
  }, []);

  const imprimirConcluida = useCallback(() => {
    if (!concluida) return;
    setErroDaImpressao(null);
    // Offline: o papel é montado aqui — o servidor não está alcançável. NÃO FISCAL, e diz isso.
    if (!concluida.saleId) {
      const ok = imprimirComprovanteNaoFiscal(
        htmlDoComprovanteNaoFiscal({
          ...concluida.comprovante,
          loja: lojaDoPapel?.nome ?? session?.company.tradeName ?? '',
          cnpj: lojaDoPapel?.cnpj ?? null,
          endereco: lojaDoPapel?.endereco ?? null,
          telefone: lojaDoPapel?.telefone ?? null,
        }),
      );
      if (!ok) {
        setErroDaImpressao('O navegador bloqueou a janela de impressão. Libere pop-ups para este endereço e tente de novo.');
        return;
      }
      fecharConcluida();
      return;
    }
    setImprimindoConcluida(true);
    const terminalId = caixaDoComputador?.terminal?.id ?? null;
    /*
      A IMPRESSÃO É DESTA VENDA, E SÓ MEXE NA TELA DESTA VENDA
      (F-cupom-fiscal-11, D-pdv-teclado-15).

      O `then` fechava e o `catch` sujava QUALQUER tela aberta: pelo agente a
      espera vai até 20 s, o caixa fechava a venda A (Esc), fechava a B com F8,
      e o fim da impressão de A fechava a tela de B antes de ele ler o troco —
      ou escrevia nela "Não foi possível imprimir", e ele reimprimia a venda
      errada. Se a tela de A já fechou e o papel falhou, a falha vai para a
      faixa do PDV, com o número da venda: antes ia para um estado que ninguém
      via, e o caixa achava que o cupom tinha saído.
    */
    const idImpresso = concluida.saleId;
    const numero = concluida.numero;
    const tipoFiscal = concluida.estadoFiscal.tipo;
    const documentoNaTela = concluida.documentoFiscalId;
    /*
      O PAPEL É ESCOLHIDO PELO ESTADO DE AGORA, E NÃO PELO DA TELA
      (F-cupom-fiscal-M02).

      Com a nota "pendente" na tela, o Enter imprimia o comprovante NÃO fiscal
      — e a SEFAZ lenta podia ter autorizado segundos antes, enquanto o cliente
      contava o dinheiro: o DANFCE já existia e o cliente que pediu a nota saía
      sem ela. Pendente na tela, o Imprimir pergunta ao servidor antes:
      autorizada ou em contingência vira DANFCE (e a tela passa ao estado
      certo); o resto, o comprovante. Sem resposta, o comprovante — como antes.
    */
    const escolherPapel = async (): Promise<{ tipo: 'DANFCE' | 'SALE_RECEIPT'; id: string }> => {
      if ((tipoFiscal === 'autorizada' || tipoFiscal === 'contingencia') && documentoNaTela) {
        return { tipo: 'DANFCE', id: documentoNaTela };
      }
      if (tipoFiscal === 'pendente') {
        const s = await coreApi.getFiscalStatusForSale(idImpresso).catch(() => null);
        const doc = s?.document;
        if (doc && (doc.status === 'AUTHORIZED' || s?.contingencia?.pendente)) {
          const autorizada = doc.status === 'AUTHORIZED';
          setConcluida((c) =>
            c && c.saleId === idImpresso
              ? {
                  ...c,
                  documentoFiscalId: doc.id,
                  estadoFiscal: autorizada
                    ? { tipo: 'autorizada' }
                    : { tipo: 'contingencia', prazo: s?.contingencia?.prazoDeTransmissao ?? null },
                }
              : c,
          );
          return { tipo: 'DANFCE', id: doc.id };
        }
      }
      return { tipo: 'SALE_RECEIPT', id: idImpresso };
    };
    // Reimprimir não refaz nada: é um papel novo para o mesmo documento — sem estoque, sem caixa.
    // Em contingência o papel é o DANFCE de contingência, obrigatório (F-cupom-fiscal-02).
    const pedido = escolherPapel().then((papel) => printDocument(papel.tipo, papel.id, { terminalId }));
    pedido
      .then((feita) => {
        if (concluidaRef.current?.saleId === idImpresso) fecharConcluida();
        // O motivo de o papel ter caído no navegador existe no job e era
        // descartado (F-cupom-fiscal-18): a térmica sem endereço, o agente fora.
        if (feita?.aviso) {
          setMessage({ tone: 'ok', text: `O cupom da venda #${numero} saiu pelo navegador: ${feita.aviso}` });
        }
      })
      .catch((err: unknown) => {
        /*
          O MOTIVO DE VERDADE (F-cupom-fiscal-10): pop-up bloqueado, "sem papel"
          do agente, "não confirmou" chegam como `Error` comum — só o
          `ApiRequestError` era mostrado, e o resto virava "Confira a
          impressora": o caixa conferia cabo e papel quando o problema era o
          bloqueador de pop-up.
        */
        const motivo =
          err instanceof Error && err.message ? err.message : 'Confira a impressora e tente de novo.';
        if (concluidaRef.current?.saleId === idImpresso) {
          setImprimindoConcluida(false);
          setErroDaImpressao(`Não foi possível imprimir: ${motivo}`);
          return;
        }
        setMessage({ tone: 'error', text: `O cupom da venda #${numero} não saiu: ${motivo}` });
      });
  }, [concluida, caixaDoComputador, session, fecharConcluida, lojaDoPapel]);

  /*
    A NFC-E QUE SAIU PARA A SEFAZ É ACOMPANHADA ATÉ O DESFECHO — e cada
    desfecho vira o estado certo (F-cupom-fiscal-01/02).

    Só AUTHORIZED e REJECTED eram reconhecidos, e REJECTED virava "pendente —
    a nota segue na fila e será transmitida": falso, rejeitada não volta
    sozinha. ERROR sem nova tentativa ficava "pendente" para sempre, e a
    CONTINGÊNCIA off-line — que já vale no balcão — ficava "pendente" mandando
    entregar o comprovante não fiscal no lugar do DANFCE obrigatório.

    E a vigília é da VENDA, não da tela de venda concluída: o bipe do próximo
    produto fecha aquela tela num segundo, e a rejeição que chega depois
    precisa aparecer mesmo assim — na faixa própria (`notaSemNota`).
  */
  /*
    UMA VIGÍLIA POR VENDA (PED-pdv-07), COM RECUO (F-cupom-fiscal-M02).

    As vigílias vivem num mapa fora do estado: entrar uma venda nova na lista
    não reinicia (nem mata) a vigília das anteriores. E a consulta não desiste
    em 11 s com a tela aberta: a SEFAZ lenta autoriza em 15 s enquanto o cliente
    conta o dinheiro, e a faixa ficava "PENDENTE" para sempre. Oito conferências
    rápidas; depois, enquanto a tela DESTA venda estiver aberta, uma a cada 5 s.
  */
  const vigias = useRef(new Map<string, () => void>());
  useEffect(() => {
    const ativas = vigias.current;
    for (const [id, parar] of ativas) {
      if (!vendasVigiadas.some((v) => v.saleId === id)) {
        parar();
        ativas.delete(id);
      }
    }
    for (const { saleId: vigiada, numero } of vendasVigiadas) {
      if (ativas.has(vigiada)) continue;
      let vivo = true;
      let tentativas = 0;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const encerrar = () => {
        vivo = false;
        setVendasVigiadas((lista) => lista.filter((v) => v.saleId !== vigiada));
      };
      const naTela = (mudar: (c: VendaNaTela) => VendaNaTela) =>
        setConcluida((c) => (c && c.saleId === vigiada ? mudar(c) : c));
      const semNota = (estado: 'rejeitada' | 'erro', motivo: string) =>
        setNotasSemNota((lista) => [
          ...lista.filter((n) => n.saleId !== vigiada),
          { saleId: vigiada, numero, estado, motivo },
        ]);
      const conferir = async () => {
        tentativas += 1;
        try {
          const s = await coreApi.getFiscalStatusForSale(vigiada);
          if (!vivo) return;
          const doc = s?.document;
          if (doc?.status === 'AUTHORIZED') {
            naTela((c) => ({ ...c, estadoFiscal: { tipo: 'autorizada' }, documentoFiscalId: doc.id }));
            encerrar();
            return;
          }
          if (doc && s?.contingencia?.pendente) {
            naTela((c) => ({
              ...c,
              estadoFiscal: { tipo: 'contingencia', prazo: s.contingencia?.prazoDeTransmissao ?? null },
              documentoFiscalId: doc.id,
            }));
            encerrar();
            return;
          }
          if (doc?.status === 'REJECTED') {
            const motivo =
              [doc.cStat, doc.xMotivo].filter(Boolean).join(' — ') || s?.statusLabel || 'NFC-e rejeitada';
            naTela((c) => ({ ...c, estadoFiscal: { tipo: 'rejeitada', motivo } }));
            semNota('rejeitada', motivo);
            encerrar();
            return;
          }
          // ERROR com nova tentativa marcada ainda anda sozinho; sem fila, ou
          // com a fila morta, não anda mais.
          if (doc?.status === 'ERROR' && (!s?.queue || s.queue.status === 'dead')) {
            const motivo =
              s?.queue?.errorMessage || doc.xMotivo || s?.statusLabel || 'Falha na emissão da NFC-e';
            naTela((c) => ({ ...c, estadoFiscal: { tipo: 'erro', motivo } }));
            semNota('erro', motivo);
            encerrar();
            return;
          }
        } catch {
          // Conferir a nota não trava o balcão: o painel fiscal segue mostrando.
        }
        if (!vivo) return;
        const telaAberta = concluidaRef.current?.saleId === vigiada;
        if (tentativas < 8) timer = setTimeout(() => void conferir(), 1500);
        else if (telaAberta && tentativas < 8 + 60) timer = setTimeout(() => void conferir(), 5000);
        else encerrar();
      };
      timer = setTimeout(() => void conferir(), 800);
      ativas.set(vigiada, () => {
        vivo = false;
        if (timer) clearTimeout(timer);
      });
    }
  }, [vendasVigiadas]);
  // A tela saiu: nenhuma vigília continua perguntando por ela.
  useEffect(
    () => () => {
      for (const parar of vigias.current.values()) parar();
      vigias.current.clear();
    },
    [],
  );

  /*
    O CAMPO DE LEITURA É O CENTRO DO BALCÃO — e responde ao teclado.

      ↑ ↓          escolhem na lista de resultados      Enter  põe o destacado
      Alt+↑ Alt+↓  mais/menos um no último item          Esc    limpa a busca
      Ctrl+Del     tira o último item do carrinho (fica no rastro de cancelados)
  */
  const teclaNaBusca = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        if (lines.length === 0) return;
        e.preventDefault();
        const ultima = lines[lines.length - 1];
        // Pesável corrige no campo da linha, com casas decimais (M06); peça
        // controlada por unidade soma bipando a identidade dela — mais um no
        // número sem escolher QUAL peça faria o chassi do documento mentir.
        if (ehPesavel(ultima.product)) {
          setMessage({
            tone: 'error',
            text: `"${ultima.product.name}" é vendido a peso: corrija a quantidade no campo da linha (ex.: 1,250).`,
          });
          return;
        }
        if (ultima.product.serialized === 1 || (ultima.unitIds?.length ?? 0) > 0) {
          setMessage({
            tone: 'error',
            text:
              `"${ultima.product.name}" é controlado por peça: bipe a identidade da peça para somar, ou use `
              + 'o ✕ da linha para tirar.',
          });
          return;
        }
        const sobe = e.key === 'ArrowUp';
        const nova = ultima.quantity + (sobe ? 1 : -1);
        if (!Number.isInteger(ultima.quantity) || nova < 1 || nova > QTD_MAXIMA_DA_LINHA) return;
        mudarQtdDaLinha(ultima.product.id, nova);
        // Uma unidade a menos é mercadoria saindo da venda: fica no rastro de
        // itens cancelados (D-pdv-teclado-07).
        if (!sobe) registrarRemocao(ultima, 1);
        return;
      }
      if (results.length > 0 && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        e.preventDefault();
        setDestaque((i) => (e.key === 'ArrowDown' ? Math.min(results.length - 1, i + 1) : Math.max(0, i - 1)));
        return;
      }
      if (e.key === 'Enter' && results.length > 0 && termoDosResultados.current === term.trim()) {
        e.preventDefault();
        const escolhido = results[destaque] ?? results[0];
        const qtd = lerQuantidade(quantity);
        if (qtd === null) return;
        const preco = precoDigitadoCents();
        /*
          A LISTA FECHA NO ENTER, e a escolha entra na fila das leituras
          (D-pdv-teclado-22). Lista e termo ficavam na tela durante a consulta
          das peças: um segundo Enter repetia a escolha e as duas pegavam a
          MESMA peça (o mesmo IMEI) duas vezes.
        */
        setResults([]);
        setTerm('');
        // A linha da etiqueta da balança leva o peso dela, e não o do campo
        // Quantidade (D-pdv-teclado-16).
        void enfileirar(() =>
          temEtiquetaDaBalanca(escolhido)
            ? entrarPelaEtiquetaDaBalanca(escolhido, qtd, preco)
            : addProductResolvendoUnidade(escolhido, qtd, preco),
        );
        return;
      }
      if (e.key === 'Escape' && (term || results.length > 0 || quantity !== '1' || unitPrice)) {
        e.preventDefault();
        setTerm('');
        setResults([]);
        // Esc desiste da leitura INTEIRA: a quantidade "3*" e o preço digitado
        // não podem cair no próximo bipe (D-pdv-teclado-13).
        setQuantity('1');
        setUnitPrice('');
        return;
      }
      if (e.key === 'Delete' && e.ctrlKey && lines.length > 0) {
        e.preventDefault();
        const indice = lines.length - 1;
        const linha = lines[indice];
        removerLinha(linha, indice);
        setMessage({ tone: 'ok', text: `Item removido: ${linha.product.name}.` });
      }
    },
    [results, lines, term, destaque, quantity, unitPrice, mudarQtdDaLinha, registrarRemocao, lerQuantidade, enfileirar, addProductResolvendoUnidade, entrarPelaEtiquetaDaBalanca, precoDigitadoCents, removerLinha],
  );

  const statusMessage = message
    ? message.text
    : lines.length === 0
      ? 'Liberado para uma nova venda ;)'
      : `${formatQuantity(itemCount)} item(ns) no carrinho`;

  return (
    /*
      A COR DO BALCÃO É A DA LOJA.

      `tokens.css` já tem a paleta das cinco marcas em escopos `[data-marca]`,
      e quem escrevia esse atributo era só a casca da loja pública. No PDV os
      seis saíam idênticos: mesmo roxo, mesmo letreiro. Uma linha liga ao
      balcão a paleta que já existe e já é testada.
    */
    <div
      data-testid="pdv-raiz"
      data-marca={session?.company.slug}
      className="min-h-screen flex flex-col bg-[var(--gs-canvas)]"
    >
      {/* ------------------------------------------------------- faixa superior */}
      <header
        className="relative flex items-center px-6 py-4 text-white shrink-0"
        style={{ background: 'var(--gs-header-gradient)' }}
      >
        {/*
          QUEM ESTÁ VENDENDO É A LOJA, NÃO O GRUPO.

          Aqui morava "GRUPO SAMPAIO" em 26px e mais nada: o nome da loja
          aparecia em 13px, na segunda faixa, depois do nome do operador. Seis
          empresas com o mesmo letreiro no topo — e o operador que atende em
          duas delas descobria onde estava pelo canto da tela.

          O grupo vira sobrenome; a loja assume o tamanho. A cor da faixa já é
          da marca (`--gs-header-gradient` muda por empresa) — faltava o nome.
        */}
        <span className="flex flex-col leading-none" data-testid="pdv-identidade">
          <span className="text-[length:var(--gs-text-xs)] tracking-[0.14em] opacity-80">
            GRUPO SAMPAIO
          </span>
          <strong
            data-testid="pdv-loja"
            className="font-bold text-[26px] tracking-tight whitespace-nowrap mt-1"
          >
            {session?.company.tradeName ?? '—'}
          </strong>
        </span>

        <span
          className={`absolute left-1/2 -translate-x-1/2 font-bold text-[26px] text-center px-4 ${
            message?.tone === 'error' ? 'text-[#ffd9d2]' : 'text-white'
          }`}
        >
          {statusMessage}
        </span>

        <div className="ml-auto flex items-start gap-6 text-center">
          <a href="/sistema/painel" className="text-white no-underline leading-tight">
            <span aria-hidden className="block text-[16px]">
              ⌂
            </span>
            <span className="text-[length:var(--gs-text-xs)]">Início</span>
          </a>
          <button
            type="button"
            onClick={() => setShowHelp((v) => !v)}
            aria-expanded={showHelp}
            className="bg-transparent border-0 text-white cursor-pointer leading-tight p-0"
          >
            <span aria-hidden className="block text-[16px]">
              ?
            </span>
            <span className="text-[length:var(--gs-text-xs)]">Ajuda</span>
          </button>
        </div>
      </header>

      {/*
        O PDV é onde a fila importa: aqui parar de vender custa dinheiro. A
        barra some sozinha quando há conexão e nada pendente.
      */}
      <PainelAuxiliar nome="conexão">
        <EstadoConexao />
      </PainelAuxiliar>

      <div
        className="px-6 py-1.5 text-white text-[length:var(--gs-text-sm)] flex items-center justify-end gap-3"
        style={{ background: 'var(--gs-purple-900)' }}
      >
        {/* Situação fiscal e pendências ficam aqui: é a faixa que o operador
            olha entre um cliente e outro. */}
        <PainelAuxiliar nome="selo fiscal">
          <FiscalBadgePdv recarregarEm={fiscalTick} />
        </PainelAuxiliar>
        {/*
          O CAMINHO PARA A GAVETA COM O CAIXA ABERTO.

          A faixa com o botão "Abrir caixa (F3)" é `{!cash && ...}`: assim que
          o caixa abre, ela some e não sobra nenhum controle de caixa na tela.
          Os seis botões do rodapé são de venda, e este texto era um <span>
          morto. Sangria, suprimento e fechamento passavam a depender de
          alguém ter lido o F3 dentro do popup de ajuda.

          O estado que o operador já olha entre um cliente e outro vira o
          próprio caminho — sem gastar espaço novo numa tela cheia.
        */}
        <button
          type="button"
          onClick={() => setShowCaixa(true)}
          className="bg-transparent border-0 text-white cursor-pointer p-0
            text-[length:var(--gs-text-sm)] underline decoration-white/40 underline-offset-4"
        >
          {cash ? 'Caixa aberto' : 'Caixa fechado'}
          {/* A gaveta da lembrança, e não da resposta (G-offline-sync-02): a faixa não afirma o que não confirmou. */}
          {cash && caixaNaoConfirmado && (
            <span data-testid="pdv-caixa-nao-confirmado"> (não confirmado — servidor fora de alcance)</span>
          )}
          {/* O servidor respondeu com ERRO (PED-pdv-09): a gaveta na tela é a da última resposta boa, e a faixa diz o que ele disse agora. */}
          {cash && erroDoCaixa && (
            <span data-testid="pdv-caixa-erro"> (não confirmado — {erroDoCaixa})</span>
          )}
          {/* QUAL gaveta (GAP-PRD-039): com dois caixas, "caixa aberto" sozinho não diz de quem. */}
          {caixaDoComputador?.terminal ? ` · ${caixaDoComputador.terminal.name}` : ''} · Op.:{' '}
          <strong>{session?.user.displayName ?? '—'}</strong>
          {' · '}
          {session?.company.tradeName ?? ''}
        </button>
      </div>

      {showHelp && (
        <div className="absolute right-6 top-24 z-50 bg-[var(--gs-surface)] rounded-[var(--gs-radius)] shadow-[var(--gs-shadow-lg)] p-5 w-[330px]">
          <div className="flex justify-between items-start mb-3">
            <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
              Você pode apertar as seguintes teclas para acessar rapidamente as funcionalidades:
            </p>
            <button
              type="button"
              aria-label="Fechar ajuda"
              onClick={() => setShowHelp(false)}
              className="bg-[var(--gs-orange-500)] text-white border-0 rounded-full w-6 h-6 cursor-pointer shrink-0 ml-2"
            >
              ✕
            </button>
          </div>
          <ul className="list-none p-0 m-0 flex flex-col gap-2">
            {SHORTCUTS.map(([key, label]) => (
              <li key={key} className="flex items-center gap-2 text-[length:var(--gs-text-sm)]">
                <kbd className="bg-[var(--gs-surface-hover)] border border-[var(--gs-border-strong)] rounded px-2 py-0.5 font-bold text-[var(--gs-purple-800)]">
                  {key}
                </kbd>
                <span className="text-[var(--gs-text-soft)]">— {label}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!cash && (
        <div
          role="alert"
          className="px-6 py-2 bg-[var(--gs-warning-bg)] text-[var(--gs-warning)]
            text-[length:var(--gs-text-sm)] flex items-center justify-between gap-3"
        >
          {/*
            A frase antiga — "a venda será registrada sem movimento de gaveta"
            — descrevia com honestidade um comportamento que não deveria
            existir: o dinheiro entrava sem gaveta, e o fechamento do dia não
            tinha como bater. Agora a venda é impedida, e a faixa diz o que
            fazer em vez de avisar sobre o estrago.
          */}
          <span>
            {caixaConhecido && caixaDoComputador?.exigeTerminal
              ? 'Esta operação tem mais de um caixa: diga qual caixa é este computador para abrir a gaveta dele.'
              : caixaConhecido
                ? 'Nenhum caixa aberto — não é possível vender. Abra o caixa para começar.'
                : erroDoCaixa
                  ? `Não foi possível confirmar o caixa: ${erroDoCaixa}`
                  : 'Não foi possível confirmar o caixa. Abra o caixa antes de vender.'}
          </span>
          {/* Avisar sem oferecer o conserto obrigava o operador a sair do PDV
              para uma tela de gestão só para começar o dia. */}
          <button
            type="button"
            onClick={() => setShowCaixa(true)}
            className="bg-[var(--gs-warning)] text-white border-0 rounded-[var(--gs-radius)]
              px-3 py-1 cursor-pointer font-semibold shrink-0"
          >
            {caixaDoComputador?.exigeTerminal ? 'Escolher o caixa (F3)' : 'Abrir caixa (F3)'}
          </button>
        </div>
      )}

      {/*
        A GAVETA ESQUECIDA (GAP-PRD-131). A Gringa abriria a segunda-feira
        vendendo na gaveta de 12/08, com o esperado somando trinta dias, e
        nenhuma tela dizia. A faixa não trava o balcão — uma loja que passa da
        meia-noite continua vendendo —, mas diz desde quando e leva ao
        fechamento com um clique.
      */}
      {cash && caixaDoComputador?.deOutroDia && (
        <div className="px-6 py-2">
          <AvisoGavetaDeOutroDia
            gaveta={caixaDoComputador.deOutroDia}
            onFechar={() => setShowCaixa(true)}
          />
        </div>
      )}

      {linhasSemSaldo.length > 0 && (
        <div
          role="alert"
          data-testid="pdv-sem-saldo"
          className="px-6 py-2 bg-[var(--gs-danger-bg)] text-[var(--gs-danger)]
            text-[length:var(--gs-text-sm)] flex items-center gap-2 flex-wrap"
        >
          <strong>Estoque insuficiente:</strong>
          {linhasSemSaldo.map((l) => (
            <span key={l.product.id}>
              {l.product.name} (saldo {formatQuantity(l.product.stock_quantity ?? 0)},
              {' '}pedido {formatQuantity(l.quantity)})
            </span>
          ))}
          <span>— a venda será recusada. Acerte o estoque antes de cobrar.</span>
        </div>
      )}

      {/*
        A NOTA QUE FICOU SEM NOTA (F-cupom-fiscal-01). Rejeitada não volta
        sozinha: a faixa fica até alguém dizer que viu — e fica fora do painel
        fiscal, que some no primeiro bipe do próximo cliente.
      */}
      {/* Uma faixa por venda sem nota, com o número dela (PED-pdv-07). */}
      {notasSemNota.map((nota) => (
        <div
          key={nota.saleId}
          role="alert"
          data-testid="pdv-nota-sem-nota"
          className="px-6 py-2 bg-[var(--gs-danger-bg)] text-[var(--gs-danger)]
            text-[length:var(--gs-text-sm)] flex items-center justify-between gap-3"
        >
          <span>
            <strong>
              NFC-e da venda {nota.numero !== null ? `#${nota.numero}` : 'anterior'}{' '}
              {nota.estado === 'rejeitada' ? 'REJEITADA' : 'COM ERRO'}
            </strong>{' '}
            — a venda está sem nota ({nota.motivo}). Chame a gerência para corrigir: ela não
            sai sozinha.
          </span>
          <button
            type="button"
            onClick={() => setNotasSemNota((lista) => lista.filter((n) => n.saleId !== nota.saleId))}
            className="font-semibold underline shrink-0"
          >
            entendi
          </button>
        </div>
      ))}

      {/* Com documento no balcão a espera fica fora de alcance (D-pdv-teclado-M01). */}
      {esperas.length > 0 && !loadedQuote && (
        <div
          data-testid="pdv-esperas"
          className="px-6 py-2 bg-[var(--gs-purple-100)] text-[var(--gs-purple-800)]
            text-[length:var(--gs-text-sm)] flex items-center gap-2 flex-wrap"
        >
          <strong>Em espera:</strong>
          {esperas.map((v) => (
            <span key={v.id} className="inline-flex items-center gap-1">
              <button
                type="button"
                onClick={() => retomarEspera(v.id)}
                className="bg-[var(--gs-surface)] border border-[var(--gs-purple-700)]
                  rounded-[var(--gs-radius)] px-2 py-0.5 cursor-pointer font-semibold"
              >
                {v.rotulo}
              </button>
              <button
                type="button"
                aria-label={`Descartar espera ${v.rotulo}`}
                onClick={() => {
                  emEspera.descartar(v.id);
                  recarregarEsperas();
                }}
                className="bg-transparent border-0 cursor-pointer text-[var(--gs-muted)]"
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}

      {concluida && (
        <VendaConcluidaDialog
          venda={concluida}
          imprimindo={imprimindoConcluida}
          erroDeImpressao={erroDaImpressao}
          onImprimir={imprimirConcluida}
          onNovaVenda={fecharConcluida}
          /*
            O scanner já no próximo produto: a tela fecha SEM imprimir e o que foi
            bipado vai para o campo de leitura — o resto do código cai lá direto,
            porque o foco já está nele, e o Enter do leitor vira busca.
          */
          onDigitacao={(tecla) => {
            /*
              A TELA SAI ANTES DE O FOCO ENTRAR NO CAMPO (F-cupom-fiscal-12,
              D-pdv-teclado-10).

              O `focus()` na busca era síncrono com a tela ainda montada: a
              armadilha de foco o puxava de volta para dentro dela, e na
              desmontagem devolvia o foco a QUEM ABRIU — o botão "Finalizar
              (F10)" quando o pagamento foi aberto pelo mouse. O resto do código
              se perdia e o Enter do leitor clicava Finalizar ("Carrinho
              vazio."). Com `flushSync` a tela desmonta (e a armadilha devolve o
              foco a quem quiser) AGORA, dentro deste mesmo keydown — e só então
              o foco vai para o campo de leitura, antes da próxima tecla.
            */
            flushSync(() => {
              setConcluida(null);
              setErroDaImpressao(null);
              setImprimindoConcluida(false);
            });
            searchRef.current?.focus();
            setTerm((t) => t + tecla);
          }}
        />
      )}

      {/* Comprovante da venda recém-fechada. Imprimir de novo NÃO refaz a
          venda: cria apenas um job novo para o mesmo documento. */}
      {lastSaleId && lines.length === 0 && (
        <PainelAuxiliar nome="painel fiscal">
          <PainelFiscalPdv
            saleId={lastSaleId}
            disparo={disparoFiscal}
            /*
              O DANFCE REABERTO SAI NA BOBINA DESTE CAIXA (PED-pdv-08). O caixa
              que o servidor confirmou para este computador — ou, sem resposta
              ainda, o que este computador guardou.
            */
            terminalId={caixaDoComputador?.terminal?.id ?? caixaDesteComputador(empresaDaSessao)}
            onDispensar={() => setLastSaleId(null)}
            /*
              REIMPRESSÃO QUE FALHA PRECISA DIZER QUE FALHOU.

              O `void` engolia a rejeição: se a impressora não responde ou o
              bloqueador de pop-up barra a janela, o cupom não sai e a tela não
              muda. O operador clica de novo, e de novo, achando que o clique
              não pegou — enquanto o cliente espera pelo papel.

              Reimprimir não refaz venda nem mexe em caixa: cria um job novo
              para o mesmo documento. O único estrago possível aqui é o
              silêncio.
            */
            /*
              O PAPEL CERTO, PELA IMPRESSORA DESTE CAIXA (F-cupom-fiscal-03).

              Era sempre `SALE_RECEIPT` e sem o caixa: o "Imprimir" ao lado de
              "Ver DANFCE" entregava o comprovante NÃO fiscal ao cliente que
              pediu a nota, e sem `terminalId` a térmica de agente do caixa
              ficava de fora — para quem tem acesso a alguns caixas só, o
              servidor recusava com "Escolha o caixa". O painel diz qual papel.
            */
            onImprimir={(tipo, id) => {
              void printDocument(tipo, id, { terminalId: caixaDoComputador?.terminal?.id ?? null })
                .then((feita) => {
                  if (feita?.aviso) setMessage({ tone: 'ok', text: `O papel saiu pelo navegador: ${feita.aviso}` });
                })
                .catch((err: unknown) => {
                  setMessage({
                    tone: 'error',
                    text: `Não foi possível imprimir: ${
                      err instanceof Error && err.message ? err.message : 'confira a impressora e tente de novo.'
                    }`,
                  });
                });
            }}
          />
        </PainelAuxiliar>
      )}

      {/*
        A GAVETA E A IMPRESSÃO, SEM PROMESSA (GAP-V55).

        Aparece junto do cupom, que é quando o operador vai atrás da gaveta. A
        frase vem do SERVIDOR — é ele que sabe se há agente local registrado
        nesta operação — para que a tela não tenha uma segunda opinião sobre
        hardware.

        Não há botão aqui, e a ausência dele é a entrega: enquanto o transporte
        for o navegador, nenhum clique abre gaveta. Dizer isso custa uma linha e
        evita o operador clicar três vezes com o cliente esperando o troco.
      */}
      {lastSaleId && lines.length === 0 && gaveta && (
        <p
          data-testid="pdv-gaveta-verdade"
          className="px-6 py-2 m-0 bg-[var(--gs-canvas)] text-[var(--gs-text-soft)]
            text-[length:var(--gs-text-sm)]"
        >
          <strong>Gaveta e impressão:</strong> {gaveta.message}
        </p>
      )}

      {/* O operador precisa saber que este carrinho pertence a uma pré-venda:
          finalizar aqui fatura o documento e solta a reserva, não abre venda
          avulsa. Esvaziar sem faturar mantém a mercadoria reservada. */}
      {loadedQuote && (
        <div
          role="status"
          className="px-6 py-2 bg-[var(--gs-success-bg)] text-[var(--gs-success)] text-[length:var(--gs-text-sm)]
            flex items-center justify-between gap-4"
        >
          <span>
            Faturando{' '}
            <strong>
              {rotuloDoDocumento(loadedQuote.kind).toLowerCase()} #{loadedQuote.number}
            </strong>{' '}
            {loadedQuote.kind === 'pre_venda'
              ? '— mercadoria já reservada. Finalizar conclui o documento.'
              : '— orçamento NÃO reserva mercadoria: o saldo é conferido no Finalizar.'}
          </span>
          <button
            type="button"
            // O mesmo caminho do F6 com documento (D-pdv-teclado-R02).
            onClick={() => soltarDocumentoDoBalcao(loadedQuote)}
            className="font-semibold underline shrink-0"
          >
            soltar do balcão
          </button>
        </div>
      )}

      <div className="flex-1 grid grid-cols-1 lg:grid-cols-[1fr_580px] gap-6 p-6 min-h-0">
        {/* ------------------------------------------- coluna esquerda: entrada */}
        <div className="flex flex-col gap-4 min-h-0">
          <SearchInput
            inputRef={searchRef}
            autoFocus
            value={term}
            onChange={setTerm}
            onEnter={() => void runSearch()}
            onKeyDown={teclaNaBusca}
            placeholder="Pesquise por código, cód. barras, produto ou referência"
          />
          <p
            data-testid="pdv-atalhos"
            className="m-0 -mt-2 text-[length:var(--gs-text-xs)] text-[var(--gs-muted)] leading-relaxed"
          >
            <kbd>Enter</kbd> adiciona · <kbd>↑</kbd><kbd>↓</kbd> escolhe na lista · <kbd>3*</kbd>código = quantidade ·{' '}
            <kbd>Alt+↑↓</kbd> qtd. do último · <kbd>Ctrl+Del</kbd> remove o último · <kbd>Esc</kbd> limpa ·{' '}
            <kbd>F10</kbd> pagar · <kbd>F8</kbd> dinheiro exato · <kbd>F6</kbd> cancela · <kbd>F4</kbd> pesquisa
          </p>
          <div className="flex items-center justify-between gap-4 -mt-2">
            {/*
              O INTERRUPTOR DAS PEÇAS.

              Desligado por padrão — a peça tem preço de reposição e o balcão
              vende mercadoria. Ligado, a busca por NOME passa a devolvê-la
              também, que é como se vende uma peça avulsa sem ter o código de
              barras dela na mão. O servidor já atendia `?includeParts=1`; até
              aqui ninguém pedia, e opção sem chamador é opção que não existe.

              Ligar refaz a busca na hora, com o valor novo: deixar o resultado
              antigo na tela faria o interruptor parecer quebrado.
            */}
            <label className="flex items-center gap-2 cursor-pointer text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
              <input
                type="checkbox"
                checked={incluirPecas}
                onChange={(e) => {
                  const ligado = e.target.checked;
                  setIncluirPecas(ligado);
                  if (term.trim()) void runSearch(ligado);
                }}
                className="w-4 h-4 accent-[var(--gs-purple-700)] cursor-pointer"
              />
              Incluir peças da oficina
            </label>
            <button
              type="button"
              /*
                O RÓTULO PAROU DE MENTIR — GAP-V57. Este onClick era
                `runSearch()`: a "pesquisa avançada" era a mesma busca textual
                do campo grande, e quem clicava esperando filtros recebia o que
                já tinha. Agora abre o diálogo com filtros de verdade (nome,
                código, barras, categoria) — a MESMA promessa da tecla F4.
              */
              onClick={() => setShowPesquisa(true)}
              className="bg-transparent border-0 cursor-pointer p-0
                text-[var(--gs-info)] text-[length:var(--gs-text-sm)] font-semibold"
            >
              Pesq. avançada (F4)
            </button>
          </div>

          {/*
            A PEÇA BIPADA PÁRA AQUI — e não no carrinho.

            O casamento exato do código de barras entrava direto e a venda de
            balcão concluía: a gaveta da bancada esvaziava sem ninguém ver, e
            nem uma linha da tela dizia que aquilo era peça. Vender continua
            permitido, porque recusar empurra o operador a cadastrar o mesmo
            item de novo e rachar o saldo em dois cadastros — o desfecho pior.
            O que muda é que agora é uma DECISÃO, com o nome da bancada escrito
            na frente de quem decide.
          */}
          {pecaParaConfirmar && (
            <div
              role="alertdialog"
              aria-label="Confirmar venda de peça de oficina"
              className="bg-[var(--gs-warning-bg)] border border-[var(--gs-warning)]
                rounded-[var(--gs-radius)] p-4 flex flex-col gap-3"
            >
              <div className="flex items-center gap-2 flex-wrap">
                <strong className="text-[var(--gs-text)]">{pecaParaConfirmar.product.name}</strong>
                <Badge tone="warning">{distintivoDePeca(pecaParaConfirmar.product)}</Badge>
              </div>
              <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
                Este item é peça de{' '}
                <strong>{pecaParaConfirmar.product.workshop_name ?? 'uma oficina'}</strong> e o
                saldo dele sustenta os consertos. Vender no balcão é permitido, e tira a peça da
                gaveta da bancada.
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="danger"
                  onClick={() => {
                    const escolhida = pecaParaConfirmar;
                    setPecaParaConfirmar(null);
                    if (escolhida.unidades) {
                      addProduct(
                        escolhida.product,
                        escolhida.quantity,
                        escolhida.precoCents,
                        escolhida.unidades,
                      );
                      return;
                    }
                    void addProductResolvendoUnidade(
                      escolhida.product,
                      escolhida.quantity,
                      escolhida.precoCents,
                    );
                  }}
                >
                  Vender assim mesmo
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setPecaParaConfirmar(null);
                    // A leitura acabou sem item: quantidade e preço digitados
                    // não caem no próximo bipe (D-pdv-teclado-13).
                    setQuantity('1');
                    setUnitPrice('');
                    searchRef.current?.focus();
                  }}
                >
                  Cancelar
                </Button>
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-6 max-w-[640px]">
            <label className="flex flex-col gap-2">
              <span className="text-[length:var(--gs-text-lg)] font-bold text-[var(--gs-purple-800)]">
                Quantidade
              </span>
              <input
                type="number"
                min="0.001"
                step="any"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                // Enter confirma e devolve o leitor ao campo de leitura (D-pdv-teclado-05).
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return;
                  e.preventDefault();
                  searchRef.current?.focus();
                }}
                className="h-[58px] px-4 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)]
                  bg-[var(--gs-surface)] text-right text-[26px] text-[var(--gs-purple-900)]"
              />
            </label>
            <label className="flex flex-col gap-2">
              <span className="text-[length:var(--gs-text-lg)] font-bold text-[var(--gs-purple-800)]">
                Preço Unitário
              </span>
              <input
                inputMode="decimal"
                value={unitPrice}
                onChange={(e) => setUnitPrice(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return;
                  e.preventDefault();
                  searchRef.current?.focus();
                }}
                placeholder="R$ 0,00"
                className="h-[58px] px-4 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)]
                  bg-[var(--gs-surface-muted)] text-right text-[26px] text-[var(--gs-muted)]"
              />
            </label>
          </div>

          {catalogoVazio && (
            <div
              data-testid="pdv-catalogo-vazio"
              role="status"
              className="bg-[var(--gs-surface)] border border-[var(--gs-border)] rounded-[var(--gs-radius)] px-4 py-3"
            >
              <strong className="text-[var(--gs-purple-900)]">Nenhum produto cadastrado.</strong>{' '}
              {podeCadastrarProduto ? (
                <>
                  Cadastre o primeiro para começar a vender:{' '}
                  <a href="/sistema/produtos/novo" className="font-semibold text-[var(--gs-purple-800)]">
                    Cadastrar produto
                  </a>
                </>
              ) : (
                'Peça a quem cuida do catálogo para cadastrar os produtos da loja.'
              )}
            </div>
          )}

          {results.length > 0 && (
            <div className="bg-[var(--gs-surface)] border border-[var(--gs-border)] rounded-[var(--gs-radius)] shadow-[var(--gs-shadow)] overflow-auto max-h-[320px]">
              <ul className="list-none m-0 p-0">
                {results.map((product, indice) => (
                  <li key={product.id} className="border-b border-[var(--gs-border)] last:border-0">
                    <button
                      type="button"
                      aria-selected={indice === destaque}
                      data-destaque={indice === destaque ? 'sim' : undefined}
                      onMouseEnter={() => setDestaque(indice)}
                      onClick={() => {
                        const qtd = lerQuantidade(quantity);
                        if (qtd === null) return;
                        const preco = precoDigitadoCents();
                        // A lista fecha no clique, como no Enter (D-pdv-teclado-22).
                        setResults([]);
                        setTerm('');
                        // A etiqueta da balança leva o peso dela (D-pdv-teclado-16).
                        void enfileirar(() =>
                          temEtiquetaDaBalanca(product)
                            ? entrarPelaEtiquetaDaBalanca(product, qtd, preco)
                            : addProductResolvendoUnidade(product, qtd, preco),
                        );
                      }}
                      className={`w-full flex items-center justify-between gap-4 px-4 py-3
                        border-0 cursor-pointer text-left hover:bg-[var(--gs-surface-hover)] ${
                          indice === destaque
                            ? 'bg-[var(--gs-surface-hover)] outline outline-2 -outline-offset-2 outline-[var(--gs-purple-700)]'
                            : 'bg-transparent'
                        }`}
                    >
                      {/*
                        A FOTO NA LISTA DA BUSCA (P0 da Preço Justo).

                        A lista não tinha foto, e o operador distinguia dois
                        tamanhos da mesma blusa lendo o código. A miniatura é
                        a do balcão (160 px, poucos KB): o original nem chega
                        a esta tela — a busca não o manda. Sem foto, ou sem
                        rede, o espaço neutro do mesmo tamanho.
                      */}
                      <span className="flex items-center gap-3 min-w-0">
                        <MiniaturaDoProduto thumbUrl={product.thumb_url} />
                        <span className="min-w-0">
                          <span className="flex items-center gap-2 flex-wrap font-semibold text-[var(--gs-text)]">
                            {product.name}
                            {/* Peça achada pela bipagem ou pelo interruptor: sem
                                este distintivo ela é indistinguível de
                                mercadoria na lista, que é como ela entrava no
                                carrinho sem ninguém perceber. */}
                            {ehPecaDeBancada(product) && (
                              <Badge tone="warning">{distintivoDePeca(product)}</Badge>
                            )}
                            {/* O que a NFC-e recusaria, ANTES do pagamento. */}
                            {rotuloFiscalIncompleto(product) && (
                              <Badge tone="warning">{rotuloFiscalIncompleto(product)}</Badge>
                            )}
                          </span>
                          <span className="block text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                            {product.internal_code}
                            {product.barcode ? ` · ${product.barcode}` : ''} · saldo{' '}
                            {formatQuantity(product.stock_quantity ?? 0)}
                            {/* Na lista, a etiqueta diz quanto entra se escolhida (D-pdv-teclado-16). */}
                            {temEtiquetaDaBalanca(product) && product.balanca.quantidade !== null
                              ? ` · etiqueta da balança: ${formatQuantity(product.balanca.quantidade)} kg`
                              : ''}
                          </span>
                        </span>
                      </span>
                      {/* Em promoção, o operador precisa ver o "de/por": é o que
                          ele confere quando o cliente pergunta o preço. */}
                      <span className="text-right whitespace-nowrap">
                        {product.on_sale && (
                          <span className="block text-[length:var(--gs-text-xs)] text-[var(--gs-muted)] line-through">
                            {formatCents(product.price_cents)}
                          </span>
                        )}
                        <span className="font-bold text-[var(--gs-purple-800)]">
                          {formatCents(product.effective_price_cents ?? product.price_cents)}
                        </span>
                        {product.on_sale && (
                          <span className="block text-[length:var(--gs-text-xs)] text-[var(--gs-success)]">
                            promoção
                          </span>
                        )}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* ------------------------------------------------ ações do rodapé */}
          <div className="mt-auto grid grid-cols-3 gap-3 max-w-[640px]">
            <PdvButton tone="solid" onClick={aguardarVenda}>
              Aguardar (F7)
            </PdvButton>
            {/*
              A ESPERA QUE CRUZA TERMINAIS (GAP-V59).

              Ao lado do F7 de propósito: são o mesmo gesto com preços
              diferentes, e o rótulo diz qual é qual. O F7 é instantâneo e local
              (morre com o turno e com a máquina); este vira ORÇAMENTO — número,
              servidor, retomável em qualquer caixa pelo F9 — e não reserva
              mercadoria, porque carrinho parado não pode segurar prateleira.
            */}
            <PdvButton tone="solid" onClick={() => void guardarNoServidor()} disabled={busy}>
              Guardar no servidor
            </PdvButton>
            <PdvButton tone="solid" onClick={pedirCancelamento}>
              Cancelar (F6)
            </PdvButton>
            <PdvButton tone="solid" onClick={finalizeCashExact} disabled={busy}>
              Finalizar Rápido (F8)
            </PdvButton>
            <PdvButton tone="soft" onClick={() => void openQuotes()}>
              Orçamento/Pré-venda (F9)
            </PdvButton>
            <PdvButton tone="soft" onClick={openCustomers}>
              Cliente (F2)
            </PdvButton>
            <PdvButton tone="soft" onClick={editarObservacao}>
              Observações (Alt+O)
            </PdvButton>
            {/*
              A FILA DA OFICINA NO BALCÃO (GAP-PRD-042).

              Só aparece para quem recebe OS (caixa e gerente da oficina, e o
              dono) e só em empresa com bancada — é a fila que diz as duas
              coisas. A mesma trava de gaveta da venda vale aqui: receber OS
              com o caixa fechado é o mesmo dinheiro sem turno.
            */}
            {filaOs?.temOficina && (
              <PdvButton
                tone="soft"
                onClick={() => {
                  if (vendaSemGaveta) {
                    setMessage({ tone: 'error', text: 'Caixa fechado — abra o caixa antes de receber a OS.' });
                    setShowCaixa(true);
                    return;
                  }
                  carregarFilaOs();
                  setShowOsAReceber(true);
                }}
              >
                OS a receber ({filaOs.total})
              </PdvButton>
            )}
            {/*
              O BALCÃO DA OFICINA ABRE A OS (GAP-PRD-099). O cliente chega com o
              aparelho, e quem está no balcão é o caixa — que não alcança o
              quadro da oficina. Não mexe em dinheiro, então não pede gaveta.
            */}
            {filaOs?.temOficina && (
              <PdvButton tone="soft" onClick={() => setShowAbrirOs(true)}>
                Abrir OS
              </PdvButton>
            )}
          </div>
        </div>

        {/* -------------------------------------------- coluna direita: carrinho */}
        <aside className="flex flex-col gap-4 min-h-0">
          <div className="bg-[var(--gs-surface)] border border-[var(--gs-border)] rounded-[var(--gs-radius)] shadow-[var(--gs-shadow)] p-5 grid grid-cols-[auto_1fr] gap-x-6 gap-y-3 items-center">
            {/*
              O verbo "Escolha" era mentira: isto aqui era um <span> mostrando
              o nome de quem estava logado, e o servidor gravava esse mesmo
              usuário como vendedor de toda venda. "Vendas por vendedor" era,
              na prática, "vendas por operador de caixa".
            */}
            <span className="font-bold text-[var(--gs-purple-800)]">Vendedor</span>
            {equipe.length > 1 ? (
              <select
                value={sellerId}
                onChange={(e) => setSellerId(e.target.value)}
                aria-label="Vendedor desta venda"
                className="h-9 px-2 rounded-[var(--gs-radius-sm)] border border-[var(--gs-border-strong)]
                  bg-[var(--gs-surface)] text-[var(--gs-text)] max-w-[240px]"
              >
                {equipe.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.displayName}
                  </option>
                ))}
              </select>
            ) : (
              // Loja de uma pessoa só: seletor com uma opção é atrito à toa.
              <span className="text-[var(--gs-muted)]">
                {session?.user.displayName ?? 'Vendedor'}
              </span>
            )}
            <span className="font-bold text-[var(--gs-purple-800)]">Cliente</span>
            <span className="text-[var(--gs-muted)]">{customer?.name ?? 'Consumidor final'}</span>
            {/*
              A CONDIÇÃO COMERCIAL, ESCRITA — porque preço que cai sozinho
              assusta.

              Sem esta linha, o operador escolhe o revendedor, vê o total do
              carrinho diminuir e não tem como saber se foi ele quem apertou
              alguma coisa errada. Com ela, o susto vira confirmação, e é a
              mesma frase que ele repete ao cliente quando perguntam por que o
              preço é esse.

              Só aparece quando há tabela valendo: uma faixa permanente em toda
              venda de balcão vira parte do cenário, e no dia em que trouxer um
              nome de verdade ninguém lê.
            */}
            {tabelaVigente && (
              <>
                <span className="font-bold text-[var(--gs-purple-800)]">Tabela</span>
                <span data-testid="pdv-tabela-do-cliente">
                  <Badge tone="success">{condicaoEmPalavras(tabelaVigente)}</Badge>
                </span>
              </>
            )}
          </div>

          <div className="flex-1 bg-[var(--gs-surface)] border border-[var(--gs-border)] rounded-[var(--gs-radius)] shadow-[var(--gs-shadow)] flex flex-col min-h-0">
            <div className="grid grid-cols-[36px_1fr_110px] gap-2 px-4 py-3 border-b border-[var(--gs-border)] text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
              <span>#</span>
              <span>Produto</span>
              <span className="text-right">Total</span>
            </div>

            <div className="flex-1 overflow-y-auto">
              {lines.length === 0 ? (
                <p className="p-5 text-[var(--gs-muted)] italic m-0">
                  Não há nenhum produto vendido.
                </p>
              ) : (
                <ul className="list-none m-0 p-0">
                  {lines.map((line, index) => (
                    <li
                      key={line.product.id}
                      // A LINHA OFENSORA FICA MARCADA. Um carrinho com doze
                      // itens e uma faixa vermelha no rodapé deixa o operador
                      // procurando qual deles é; a marca resolve isso sem ele
                      // ter de ler nome por nome.
                      //
                      // São DUAS recusas que apontam linha: a do produto sem
                      // preço e a do desconto que não cabe. A segunda vivia no
                      // ramo genérico e não marcava nada — e, quando passou a
                      // marcar, marcava UMA só: com duas linhas estouradas ao
                      // mesmo tempo ela desistia das duas. Por isso a do
                      // desconto pergunta a uma LISTA, e não a um id.
                      data-linha-ofensora={
                        recusaSemPreco?.productId === line.product.id
                        || recusaDeDesconto?.productIds.includes(line.product.id)
                          ? 'sim'
                          : undefined
                      }
                      className={`grid grid-cols-[36px_1fr_110px_28px] gap-2 items-center px-4 py-3
                        border-b border-[var(--gs-border)] ${
                          recusaSemPreco?.productId === line.product.id
                          || recusaDeDesconto?.productIds.includes(line.product.id)
                            ? 'bg-[var(--gs-danger-bg)]'
                            : unitarioCobradoCents(line) <= 0
                              ? 'bg-[var(--gs-warning-bg)]'
                              : ''
                        }`}
                    >
                      <span className="text-[var(--gs-muted)]">{index + 1}</span>
                      <span className="min-w-0">
                        <span className="block font-semibold truncate">{line.product.name}</span>
                        {/* O distintivo acompanha a linha até o fim da venda: a
                            conferência do carrinho é a última chance de alguém
                            notar que está saindo peça da bancada. */}
                        {ehPecaDeBancada(line.product) && (
                          <span className="block mt-0.5">
                            <Badge tone="warning">{distintivoDePeca(line.product)}</Badge>
                          </span>
                        )}
                        {/* O fiscal incompleto também acompanha a linha: o item
                            que entrou pela bipagem nunca passou pela lista. */}
                        {rotuloFiscalIncompleto(line.product) && (
                          <span className="block mt-0.5">
                            <Badge tone="warning">{rotuloFiscalIncompleto(line.product)}</Badge>
                          </span>
                        )}
                        {/*
                          O PREÇO MOSTRADO É O QUE VAI SER COBRADO.

                          Em preço fechado o servidor aplica teto no vigente, e a
                          linha exibia o digitado — a tela dizia R$ 500 e o
                          comprovante saía R$ 400. Quando os dois diferem, o
                          vigente aparece riscado ao lado: é a mesma leitura de
                          "de/por" que o operador já faz na lista de busca.
                        */}
                        <span className="flex items-center gap-1.5 flex-wrap text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                          {/*
                            QUANTIDADE EDITÁVEL NA LINHA — GAP-V56.

                            Corrigir "2" para "3" exigia rebipar (que SOMA) e
                            errar para menos exigia remover a linha inteira.
                            Serializado fica de FORA: a quantidade dele é o
                            número de peças escolhidas (o chassi vai para o
                            documento), e mexer no número sem escolher peça
                            faria a linha mentir sobre QUAL peça sai.
                          */}
                          {line.product.serialized === 1 || (line.unitIds?.length ?? 0) > 0 ? (
                            <span>{formatQuantity(line.quantity)}</span>
                          ) : (
                            <input
                              // Pesável é decimal, em kg (D-pdv-teclado-M06).
                              type={ehPesavel(line.product) ? 'text' : 'number'}
                              min={ehPesavel(line.product) ? undefined : 1}
                              step={ehPesavel(line.product) ? undefined : 1}
                              inputMode={ehPesavel(line.product) ? 'decimal' : 'numeric'}
                              aria-label={`Quantidade de ${line.product.name}`}
                              value={
                                qtdDaLinha[line.product.id]
                                ?? (ehPesavel(line.product)
                                  ? String(line.quantity).replace('.', ',')
                                  : String(line.quantity))
                              }
                              // A quantidade de quando o campo ganhou o foco: é
                              // contra ela que a redução é medida (D-pdv-teclado-07).
                              onFocus={() => {
                                if (!(line.product.id in qtdNaEntrada.current)) {
                                  qtdNaEntrada.current[line.product.id] = line.quantity;
                                }
                              }}
                              onChange={(e) => definirQtdDaLinha(line.product.id, e.target.value)}
                              // Enter confirma e devolve o leitor ao campo de
                              // leitura (D-pdv-teclado-05).
                              onKeyDown={(e) => {
                                if (e.key !== 'Enter') return;
                                e.preventDefault();
                                confirmarQtdDaLinha(line.product.id);
                                searchRef.current?.focus();
                              }}
                              // O rascunho morre na confirmação: se sobrou "0"
                              // ou vazio no campo, volta a valer a última
                              // quantidade válida da linha.
                              onBlur={() => confirmarQtdDaLinha(line.product.id)}
                              className="h-7 w-16 px-1.5 rounded-[var(--gs-radius-sm)] border
                                border-[var(--gs-border-strong)] bg-[var(--gs-surface)]
                                text-right tabular-nums text-[var(--gs-text)]"
                            />
                          )}
                          {/* "0,352 kg": o pesável diz a unidade — "0,352" sozinho, ao lado de
                              "× R$ 49,90", não diz que é o quilo (D-pdv-teclado-16). */}
                          {ehPesavel(line.product) && (
                            <span data-testid={`pdv-unidade-${line.product.id}`}>kg</span>
                          )}
                          <span>× {formatCents(unitarioCobradoCents(line))}</span>
                          {unitarioCobradoCents(line) < precoVigenteCents(line) && (
                            <span className="line-through">
                              {formatCents(precoVigenteCents(line))}
                            </span>
                          )}
                          {/*
                            DESCONTO POR ITEM — GAP-V54. O servidor sempre
                            aceitou items[].discountCents e sempre o mediu na
                            alçada; faltava onde digitá-lo. Limitado ao valor
                            da própria linha (ver definirDescontoDaLinha).
                          */}
                          <span className="text-[length:var(--gs-text-xs)] text-[var(--gs-purple-800)] font-semibold ml-1">
                            Desc.
                          </span>
                          <input
                            inputMode="decimal"
                            aria-label={`Desconto de ${line.product.name}`}
                            placeholder="R$ 0,00"
                            value={
                              descontoDaLinha[line.product.id]
                              ?? reaisNoCampo(line.discountCents ?? 0)
                            }
                            onChange={(e) =>
                              definirDescontoDaLinha(line.product.id, e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key !== 'Enter') return;
                              e.preventDefault();
                              searchRef.current?.focus();
                            }}
                            className="h-7 w-24 px-1.5 rounded-[var(--gs-radius-sm)] border
                              border-[var(--gs-border-strong)] bg-[var(--gs-surface)]
                              text-right tabular-nums text-[var(--gs-text)]"
                          />
                        </span>
                        {/*
                          O CAMPO QUE A RECUSA DO SERVIDOR MANDA USAR.

                          "digite o valor na linha" só é uma instrução honesta
                          se a linha tiver onde digitar. Ver
                          `definirPrecoDaLinha` para por que ele existe só em
                          preço aberto.

                          `aria-label` com o nome do produto porque num carrinho
                          com três serviços há três campos iguais: "Valor
                          combinado" sozinho não diria de qual deles o leitor de
                          tela está falando.
                        */}
                        {ehPrecoAberto(line) && (
                          <span className="flex items-center gap-2 mt-1">
                            <span className="text-[length:var(--gs-text-xs)] text-[var(--gs-purple-800)] font-semibold">
                              Valor combinado
                            </span>
                            <input
                              inputMode="decimal"
                              aria-label={`Valor combinado de ${line.product.name}`}
                              placeholder="R$ 0,00"
                              value={
                                precoDaLinha[line.product.id]
                                ?? reaisNoCampo(line.unitPriceCents)
                              }
                              onChange={(e) =>
                                definirPrecoDaLinha(line.product.id, e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key !== 'Enter') return;
                                e.preventDefault();
                                searchRef.current?.focus();
                              }}
                              className="h-8 w-28 px-2 rounded-[var(--gs-radius-sm)] border
                                border-[var(--gs-border-strong)] bg-[var(--gs-surface)]
                                text-right tabular-nums text-[var(--gs-text)]"
                            />
                          </span>
                        )}
                        {/* A peça escolhida, para o operador conferir contra o
                            que está na mão antes de fechar a venda. */}
                        {line.unitLabel && (
                          <span className="block font-mono text-[length:var(--gs-text-xs)] text-[var(--gs-purple-800)] truncate">
                            {line.unitLabel}
                          </span>
                        )}
                        {/*
                          AVISO, NÃO TRAVA.

                          A venda segue: peça sem plaquinha é a regra para
                          celular e acessório, e travar o balcão por isso pararia
                          a loja. Mas se for moto, o comprador vai sair daqui sem
                          portal e sem garantia rastreável — e este é o último
                          momento em que dá para mandar vincular, porque depois
                          da venda a unidade fica `sold` e o vínculo não se faz
                          mais.
                        */}
                        {temPlaquinha && (line.unidadesSemPlaquinha ?? 0) > 0 && (
                          <span className="block text-[length:var(--gs-text-xs)] text-[var(--gs-warning)]">
                            {line.unidadesSemPlaquinha === 1
                              ? 'sem plaquinha da oficina'
                              : `${line.unidadesSemPlaquinha} sem plaquinha da oficina`}{' '}
                            — sendo moto, o comprador não terá portal nem garantia rastreável.
                          </span>
                        )}
                      </span>
                      <strong className="text-right tabular-nums">
                        {/* O total da linha já líquido do desconto dela — a
                            mesma conta do servidor (unitário × qtd − desc). */}
                        {formatCents(
                          Math.max(
                            0,
                            Math.round(unitarioCobradoCents(line) * line.quantity)
                              - Math.round(line.discountCents ?? 0),
                          ),
                        )}
                      </strong>
                      <button
                        type="button"
                        aria-label={`Remover ${line.product.name}`}
                        // A remoção deixa RASTRO (GAP-V52): o retrato da linha
                        // entra em `removidos` antes de ela sumir da tela.
                        onClick={() => removerLinha(line, index)}
                        className="bg-transparent border-0 cursor-pointer text-[var(--gs-danger)]"
                      >
                        ✕
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Régua de totais, como no rodapé do card da referência. */}
            <div className="grid grid-cols-5 gap-2 px-4 py-3 border-t border-[var(--gs-border)] text-[length:var(--gs-text-xs)]">
              {[
                ['Venda:', 'Livre'],
                ['Total de itens:', formatQuantity(itemCount)],
                /*
                  O CONTADOR PAROU DE MENTIR — GAP-V52. Era o literal '0'
                  imitando o layout de referência: o gestor achava que o
                  número existia. Agora é a quantidade removida DESTA venda,
                  contada ao vivo, e ela viaja no POST quando a venda fecha.
                */
                ['Itens cancelados:', formatQuantity(itensCancelados)],
              ].map(([label, value]) => (
                <span key={label} className="flex flex-col">
                  <span className="text-[var(--gs-muted)]">{label}</span>
                  <strong className="text-[var(--gs-text)]">{value}</strong>
                </span>
              ))}
              {/*
                O DESCONTO DE RODAPÉ, DIGITÁVEL — GAP-V54. "50" é R$ 50,00 e
                "10%" é dez por cento do subtotal (a conversão mora em
                `descontoDoRodapeCents`). Quem mede a alçada é o SERVIDOR — se
                passar do limite, o 403 dele abre o diálogo do gestor, o mesmo
                caminho do preço rebaixado.

                Com pré-venda no balcão o campo TRAVA: a conversão cobra o que
                está no documento, e um campo vivo aqui prometeria um desconto
                que o faturamento não vai aplicar.
              */}
              <label className="flex flex-col gap-0.5">
                <span className="text-[var(--gs-muted)]">Total de desconto:</span>
                <input
                  inputMode="decimal"
                  aria-label="Desconto da venda (R$ ou %)"
                  placeholder="0,00 ou %"
                  title={
                    loadedQuote
                      ? 'O desconto desta pré-venda é o do documento — solte-a do balcão para mudar.'
                      : 'Digite em reais (50) ou em porcentagem (10%)'
                  }
                  disabled={Boolean(loadedQuote)}
                  value={descontoTexto}
                  onChange={(e) => setDescontoTexto(e.target.value)}
                  className="h-7 w-full px-1.5 rounded-[var(--gs-radius-sm)] border
                    border-[var(--gs-border-strong)] bg-[var(--gs-surface)] text-right
                    tabular-nums text-[var(--gs-text)] disabled:opacity-60"
                />
                {/* O que o texto virou em dinheiro — é este número que viaja. */}
                <strong className="text-[var(--gs-text)]">{formatCents(discount)}</strong>
              </label>
              <span className="flex flex-col">
                <span className="text-[var(--gs-muted)]">Total de acréscimo:</span>
                <strong className="text-[var(--gs-text)]">{formatCents(0)}</strong>
              </span>
            </div>
          </div>

          {/*
            ---------------------------------------------------- a concessão

            Tudo o que a loja está deixando de cobrar nesta venda, com de ONDE
            veio, antes de o Finalizar ser apertado.

            Só aparece quando há concessão: uma faixa permanente dizendo "R$
            0,00 concedidos" em toda venda de balcão vira parte do cenário, e no
            dia em que trouxer um número de verdade ninguém lê.
          */}
          {(concessao.concedidoCents > 0 || recusaDeAlcada) &&
            (() => {
              // Quando o servidor falou, é a palavra DELE que fica na tela. A
              // prévia é a estimativa da tela; a recusa é o fato, e mostrar as
              // duas com números diferentes seria a tela discutindo consigo
              // mesma na frente do cliente.
              const fonte = recusaDeAlcada ?? concessao;
              const limite = recusaDeAlcada?.limite ?? limitePercent;
              /*
                A FAIXA SÓ FALA EM LIMITE ONDE O LIMITE É COBRADO.

                Aqui estava o defeito mais fácil de deixar passar: o carrinho
                vindo de pré-venda acusava "Acima do limite de 10%" e a venda
                passava lisa. Faturar uma pré-venda NÃO é `POST /core/sales` —
                é a conversão do documento, e ela não mede alçada por decisão
                escrita (ver o cabeçalho de `convertQuote`): o documento já foi
                conferido quando foi CRIADO, que é onde o preço é escrito e onde
                não há cliente esperando. O que cresce depois vem do reajuste da
                tabela, que o caixa não opera — e a conversão registra isso em
                auditoria em vez de barrar.

                Uma faixa que acusa e não barra é a pior das duas opções: ela
                ensina o operador a ignorar faixa vermelha, e no dia em que uma
                delas for de verdade ele já aprendeu a passar por cima. Então
                nesse caminho ela diz o que É verdade — o documento já passou
                pela alçada — e não opina sobre um limite que ninguém vai
                cobrar aqui.
              */
              const preVenda = recusaDeAlcada ? null : loadedQuote;
              const acima = !preVenda && limite !== null && fonte.percentual > limite;
              const partes = origensEmPalavras(fonte.origens, formatCents);
              return (
                <FaixaPdv
                  tom={recusaDeAlcada ? 'danger' : acima ? 'warning' : 'info'}
                  titulo={
                    recusaDeAlcada
                      ? 'Precisa da liberação de um gestor'
                      : preVenda
                        ? `Concessão d${preVenda.kind === 'pre_venda' ? 'a pré-venda' : 'o orçamento'} #${preVenda.number}`
                        : 'Concessão nesta venda'
                  }
                >
                  <span>
                    <strong className="tabular-nums">{formatCents(fonte.concedidoCents)}</strong>{' '}
                    ({fonte.percentual}%) sobre{' '}
                    <strong className="tabular-nums">{formatCents(fonte.brutoCents)}</strong> de
                    preço vigente.
                  </span>
                  {/*
                    DE ONDE VEIO — o motivo de `origens` existir.

                    Quem carregou uma pré-venda antiga no PDV não digitou
                    desconto nenhum e ainda assim está concedendo: a tabela subiu
                    desde que o documento foi feito. Dizer só "acima do limite"
                    para essa pessoa é mandá-la procurar um desconto que ela não
                    deu.
                  */}
                  {partes.length > 0 && <span>Vem de {partes.join(', ')}.</span>}
                  {preVenda ? (
                    <>
                      {/*
                        O QUE O OPERADOR PRECISA SABER AQUI é outra coisa: não
                        "vai pedir gestor?" (não vai), e sim que o que ele
                        mexer no carrinho não chega ao faturamento. A conversão
                        lê os itens e o desconto do DOCUMENTO — tirar uma linha
                        daqui não tira a linha da venda. Sem esta frase, o
                        operador remove um item, fatura, e a nota sai com ele.
                      */}
                      <span>
                        Este documento já passou pela alçada quando foi criado — faturar não pede
                        gestor de novo. Se o número acima cresceu, foi o preço de tabela que subiu
                        desde então, e isso fica registrado na auditoria da conversão.
                      </span>
                      <span>
                        O faturamento cobra o que está na pré-venda: mexer no carrinho aqui não
                        muda a venda. Para trocar item ou preço, solte o documento do balcão e
                        refaça-o.
                      </span>
                    </>
                  ) : (
                    limite !== null && (
                      <span>
                        {acima
                          ? `Acima do limite de ${limite}% desta operação.`
                          : `Dentro do limite de ${limite}% desta operação.`}
                      </span>
                    )
                  )}
                </FaixaPdv>
              );
            })()}

          {/*
            ------------------------------------------ produto sem preço vigente

            A recusa do servidor, com o texto dele. O conserto agora é diferente
            conforme o produto, e os dois estão ao alcance da mão:

              - preço ABERTO: o texto do servidor manda digitar o valor na
                linha, e a linha passou a ter o campo "Valor combinado". Corrigir
                ali apaga esta faixa na hora, sem tirar nada do carrinho;
              - preço zero de cadastro: não há o que digitar no balcão — o
                produto veio de uma entrada de nota e ninguém o precificou. Aí o
                botão é o caminho: tirar a linha e alguém precifica em Produtos.
          */}
          {recusaSemPreco && (
            <FaixaPdv
              tom="danger"
              titulo={
                recusaSemPreco.motivo === 'nao_vendavel'
                  ? 'Venda recusada: produto que não pode mais ser vendido'
                  : 'Venda recusada: produto sem preço'
              }
            >
              <span role="alert">{recusaSemPreco.texto}</span>
              {recusaSemPreco.productId && (
                <span>
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => {
                      // Também é remoção, também deixa rastro (GAP-V52): a
                      // linha sem preço saiu do carrinho como qualquer outra.
                      const ofensora = lines.find(
                        (l) => l.product.id === recusaSemPreco.productId,
                      );
                      if (ofensora) registrarRemocao(ofensora);
                      setLines((prev) => prev.filter((l) => l.product.id !== recusaSemPreco.productId));
                      if (recusaSemPreco.productId) esquecerRascunhos(recusaSemPreco.productId);
                      setRecusaSemPreco(null);
                      searchRef.current?.focus();
                    }}
                  >
                    Tirar do carrinho
                  </Button>
                </span>
              )}
            </FaixaPdv>
          )}

          {/*
            ----------------------------------------- desconto que não cabe

            A recusa `CORE_INVALID_DISCOUNT`, com a linha apontada. Antes disto
            ela caía no ramo genérico: a frase do servidor aparecia sozinha e o
            carrinho não dizia QUAL linha estava errada.

            O conserto é de um clique e não tira nada do carrinho: zerar o
            desconto das linhas ofensoras. Tirar a linha seria destruir a venda
            por um número digitado a mais.

            E o clique vale para TODAS as marcadas de uma vez. Quando eram duas
            e a tela marcava uma, o operador consertava, clicava em Finalizar,
            tomava a mesma recusa pela outra e recomeçava — com o cliente na
            frente, a cada volta.
          */}
          {recusaDeDesconto && (
            <div data-testid="recusa-de-desconto">
              <FaixaPdv tom="danger" titulo="Venda recusada: desconto maior que o item">
                <span role="alert">{recusaDeDesconto.texto}</span>
                {recusaDeDesconto.productIds.length > 0 ? (
                  <span>
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => {
                        const marcadas = recusaDeDesconto.productIds;
                        setLines((prev) =>
                          prev.map((l) =>
                            marcadas.includes(l.product.id)
                              ? { ...l, discountCents: undefined }
                              : l,
                          ),
                        );
                        for (const id of marcadas) esquecerODescontoDigitado(id);
                        setRecusaDeDesconto(null);
                      }}
                    >
                      {recusaDeDesconto.productIds.length === 1
                        ? 'Zerar o desconto desta linha'
                        : `Zerar o desconto das ${recusaDeDesconto.productIds.length} linhas marcadas`}
                    </Button>
                  </span>
                ) : (
                  /*
                    "NÃO SEI QUAL LINHA" É UM ESTADO, e diferente de "é esta".
                    Marcar uma por chute mandaria consertar o que não está
                    quebrado; calar deixaria o operador com doze linhas. Dizer
                    quais TÊM desconto reduz a busca sem afirmar nada falso.
                  */
                  <span>
                    {recusaDeDesconto.comDesconto.length > 0
                      ? `O servidor não disse qual linha. Têm desconto: ${
                        recusaDeDesconto.comDesconto.join(', ')}.`
                      : 'O servidor não disse qual linha, e nenhuma linha deste carrinho tem '
                        + 'desconto — confira o desconto do rodapé.'}
                  </span>
                )}
              </FaixaPdv>
            </div>
          )}

          {/*
            O MESMO PROBLEMA, ANTES DE ELE VIRAR RECUSA.

            A linha entra no carrinho com preço zero e nada na tela diz nada até
            o Finalizar — com o cliente na frente. Aqui ele aparece assim que o
            item entra. Some quando a recusa do servidor está na tela, para não
            haver duas caixas sobre o mesmo produto.
          */}
          {(!recusaSemPreco || recusaSemPreco.motivo === 'nao_vendavel') && concessao.semPreco.length > 0 && (
            <FaixaPdv tom="warning" titulo="Item sem preço no carrinho">
              <span>
                {concessao.semPreco.map((i) => i.nome).join(', ')} —{' '}
                {/*
                  A instrução aponta para o campo que EXISTE, e ele mudou: o
                  valor combinado passou a ser digitado na própria linha. Mandar
                  a pessoa ao "Preço Unitário" da busca a faria tirar o item do
                  carrinho e bipar de novo para consertar algo que está a um
                  campo de distância.
                */}
                {concessao.semPreco.some((i) => i.aberto)
                  ? 'produto de preço aberto precisa do valor digitado em "Valor combinado", na própria linha.'
                  : 'produto sem preço de venda cadastrado.'}{' '}
                A venda vai ser recusada assim que for finalizada.
              </span>
            </FaixaPdv>
          )}

          {/*
            Preço digitado ACIMA do vigente. Não impede nada e não é erro de
            quem digitou — mas o servidor cobra o vigente, e sem este aviso a
            tela prometeria ao cliente um total que a venda não fecha.
          */}
          {concessao.acimaDoVigente.length > 0 && (
            <FaixaPdv tom="warning" titulo="Acima do preço vigente">
              {concessao.acimaDoVigente.map((i) => (
                <span key={i.productId}>
                  {i.nome}: a venda cobra o preço vigente, {formatCents(i.vigenteCents)}. Acréscimo
                  de verdade — juros, frete — entra no pagamento, onde fica visível.
                </span>
              ))}
            </FaixaPdv>
          )}

          <div className="bg-[var(--gs-surface)] border border-[var(--gs-border)] rounded-[var(--gs-radius)] shadow-[var(--gs-shadow)] p-4 flex items-center justify-between gap-4">
            <button
              type="button"
              disabled={busy}
              onClick={openPayment}
              className="bg-[var(--gs-orange-500)] hover:bg-[var(--gs-orange-600)] text-white
                border-0 rounded-[var(--gs-radius)] px-8 py-4 text-[length:var(--gs-text-lg)] font-bold
                cursor-pointer disabled:opacity-50"
            >
              Finalizar (F10)
            </button>
            <span className="flex items-baseline gap-2">
              <span className="text-[length:var(--gs-text-xl)] font-bold text-[var(--gs-orange-600)]">
                R$
              </span>
              <strong className="text-[44px] leading-none text-[var(--gs-orange-600)] tabular-nums">
                {(total / 100).toLocaleString('pt-BR', {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}
              </strong>
            </span>
          </div>
        </aside>
      </div>

      {/*
        O CLIENTE DA VENDA — busca viva e cadastro rápido (F2, GAP-V53).

        Escolher (ou cadastrar) aplica NA HORA: `setCustomer` muda o
        `idDoCliente` e o efeito de reprecificação — o mecanismo que já
        existia — pergunta os preços da tabela dele ao servidor. Fechar sem
        escolher não toca em nada: carrinho e cliente ficam como estavam.
      */}
      {showClientes && (
        <ClientePdvDialog
          onClose={() => {
            setShowClientes(false);
            // O leitor de código de barras precisa de um campo focado — a
            // mesma lição do clearSale.
            searchRef.current?.focus();
          }}
          onSelect={(escolhido) => {
            setCustomer(escolhido);
            setShowClientes(false);
            searchRef.current?.focus();
          }}
        />
      )}

      {/* A fila da oficina e o recebimento da OS (GAP-PRD-042/104). */}
      {showOsAReceber && filaOs && (
        <OsAReceberDialog
          fila={filaOs}
          cashSessionId={cash?.id ?? null}
          onClose={() => {
            setShowOsAReceber(false);
            searchRef.current?.focus();
          }}
          onRecebido={(r) => {
            setShowOsAReceber(false);
            // O painel do comprovante é o MESMO da venda do balcão: imprimir o
            // cupom e conferir o fiscal da OS recebida sem sair da tela.
            setLastSaleId(r.sale.id);
            setFiscalTick((t) => t + 1);
            setMessage({
              tone: 'ok',
              text: r.replay
                ? `OS #${r.order.number} já estava recebida — venda #${r.sale.number}. Nada foi cobrado de novo.`
                : r.sale.change_cents > 0
                  ? `OS #${r.order.number} recebida — venda #${r.sale.number} — TROCO ${formatCents(r.sale.change_cents)}`
                  : `OS #${r.order.number} recebida — venda #${r.sale.number}`,
            });
            carregarFilaOs();
            searchRef.current?.focus();
          }}
        />
      )}

      {/* O aparelho do cliente entra pelo balcão da oficina (GAP-PRD-099). */}
      {showAbrirOs && (
        <AbrirOsDialog
          onClose={() => {
            setShowAbrirOs(false);
            searchRef.current?.focus();
          }}
          onAberta={(os) => {
            setShowAbrirOs(false);
            setMessage({
              tone: 'ok',
              text: `OS #${os.number} aberta — já está no quadro da oficina, em aberto, para o mecânico assumir.`,
            });
            searchRef.current?.focus();
          }}
        />
      )}

      {showCaixa && (
        <CaixaPdvDialog
          cash={cash}
          caixaDoComputador={caixaDoComputador}
          onEscolherCaixa={escolherCaixa}
          tetoSangriaCents={tetoSangriaCents}
          vendasEmEspera={esperas.length}
          // A ação pedida pelo atalho (Ctrl+F3/Shift+F3) morre no fechamento:
          // a próxima abertura comum não pode herdar um destaque que ninguém
          // pediu.
          acaoInicial={acaoDoCaixa}
          aviso={avisoDoCaixa}
          onClose={() => {
            setShowCaixa(false);
            setAcaoDoCaixa(null);
            setAvisoDoCaixa(null);
          }}
          onChanged={(proximo) => {
            setCash(proximo);
            // O aviso da venda recusada era sobre a gaveta que FALTAVA: aberta
            // (ou fechada) a gaveta, ele descreve um estado que já passou.
            setAvisoDoCaixa(null);
            /*
              O SERVIDOR ACABOU DE RESPONDER SOBRE A GAVETA (revisão de PED-pdv-09).

              O DEFEITO: `erroDoCaixa` e `caixaNaoConfirmado` só eram limpos pela
              releitura de `/cash/open`. Com essa leitura dando 500 (ou a rede
              piscando), o operador abria o caixa aqui, o servidor ACEITAVA — e o
              cabeçalho seguia "Caixa aberto (não confirmado — o servidor não
              conseguiu informar o caixa…)" sobre a gaveta que ele acabara de
              confirmar. E `caixaConhecido` ficava falso: fechado o turno aqui, a
              tela não sabia que não havia gaveta e deixava vender sem ela. O
              diálogo só chama isto com a resposta do servidor (abertura,
              movimento, fechamento, ou a recusa "caixa já fechado"): ela vale
              como confirmação.
            */
            setCaixaConhecido(true);
            setCaixaNaoConfirmado(false);
            setErroDoCaixa(null);
            /*
              A LEMBRANÇA DA GAVETA SEGUE O CAIXA (revisão de G-offline-sync-02).

              Só a releitura de `/cash/open` gravava a lembrança. Fechar o turno
              AQUI (F3 › Fechar) deixava guardada a sessão que acabou de fechar:
              com o servidor fora no F5 seguinte — ou na manhã seguinte, dentro
              do prazo —, a tela mostrava "Caixa aberto" e mandava para a fila
              vendas com a gaveta FECHADA, que o reenvio recusa uma a uma. E a
              gaveta aberta aqui não virava lembrança até a próxima volta do
              foco. O diálogo só chama isto depois de o servidor aceitar a
              abertura ou o fechamento: é resposta do servidor, e vale gravar.
            */
            gravarUltimoCaixa(
              empresaDaSessao,
              proximo
                ? {
                    session: proximo,
                    terminal: caixaDoComputador?.terminal ?? null,
                    confirmadoEm: new Date().toISOString(),
                  }
                : null,
            );
            // A gaveta mudou de estado: o aviso de "outro dia" era da gaveta
            // anterior e não pode sobreviver a ela.
            if (proximo?.id !== cash?.id) {
              setCaixaDoComputador((atual) => (atual ? { ...atual, deOutroDia: null } : atual));
            }
            // Fechou o caixa: as esperas do turno vão junto. Deixá-las na tela
            // sugeriria que ainda podem ser faturadas no turno que acabou.
            if (!proximo) emEspera.limparEscopo(escopoEspera);
            recarregarEsperas();
          }}
        />
      )}

      {showPayment && (
        <PagamentoDialog
          totalCents={total}
          // O cliente do carrinho: é ele que traz (ou não) crédito de loja, e é
          // o nome dele que o diálogo mostra ao lado do saldo.
          customerId={customer?.id ?? null}
          customerName={customer?.name ?? null}
          // A maquininha é por caixa (GAP-PRD-014): o PinPad deste computador.
          terminalId={caixaDoComputador?.terminal?.id ?? null}
          busy={busy}
          error={paymentError}
          onCancel={() => {
            setShowPayment(false);
            setPaymentError(null);
          }}
          // O troco do diálogo desce junto: é ele que vale na venda offline e
          // no faturamento de documento (D-pdv-teclado-08/09).
          onConfirm={(payments, troco, acrescimo, credito) =>
            void finalize(payments, null, acrescimo, credito, undefined, troco)
          }
        />
      )}

      {showQuotes && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
          role="dialog"
          aria-modal="true"
          ref={prenderFoco}
          tabIndex={-1}
          aria-label="Documentos abertos"
        >
          <div className="w-full max-w-2xl max-h-[85vh] overflow-y-auto rounded-[var(--gs-radius-lg)] bg-[var(--gs-surface)] shadow-2xl">
            <header className="px-6 py-4 border-b border-[var(--gs-border)]">
              <h2 className="text-[length:var(--gs-text-lg)] font-bold text-[var(--gs-purple-900)]">
                Documentos abertos para faturar
              </h2>
              <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
                Pré-venda já reservou a mercadoria. Orçamento não reservou nada — o saldo é
                conferido no Finalizar.
              </p>
            </header>
            <div className="px-6 py-5 flex flex-col gap-3">
              {quotes === null ? (
                <p role="status" className="text-[var(--gs-text-soft)]">
                  Carregando…
                </p>
              ) : quotes.length === 0 ? (
                <p className="text-[var(--gs-text-soft)]">
                  Nenhum documento aberto. Monte um em Vendas › Orçamentos e pré-vendas para
                  que ele apareça aqui.
                </p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {quotes.map((q) => (
                    <li key={q.id}>
                      <button
                        type="button"
                        onClick={() => void loadQuote(q)}
                        className="w-full text-left px-4 py-3 rounded-[var(--gs-radius)]
                          bg-[var(--gs-canvas)] hover:bg-[var(--gs-surface-hover)]
                          flex items-center justify-between"
                      >
                        <span>
                          <strong className="block text-[var(--gs-purple-900)]">
                            {rotuloDoDocumento(q.kind)} #{q.number}
                          </strong>
                          <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
                            {dataBR(q.created_at)}
                            {q.valid_until
                              ? ` · vale até ${dataBR(q.valid_until)}`
                              : ''}
                            {q.kind === 'pre_venda' ? ' · mercadoria reservada' : ' · sem reserva'}
                          </span>
                        </span>
                        <strong className="text-[var(--gs-orange-600)] tabular-nums">
                          {formatCents(q.total_cents)}
                        </strong>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex justify-end pt-2">
                <button
                  type="button"
                  onClick={() => setShowQuotes(false)}
                  className="px-4 py-2 rounded-[var(--gs-radius)] font-semibold text-[var(--gs-purple-800)]"
                >
                  Fechar (Esc)
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/*
        A TENTATIVA QUE JÁ REGISTROU OUTRA VENDA (RES-IDEM-TELA), no diálogo da
        casa: foco preso, Esc volta ao carrinho, e o foco começa em "Voltar" —
        Enter por reflexo não registra venda em dobro.
      */}
      {/* A pergunta do F6 (D-pdv-teclado-12): o foco nasce em "Voltar". */}
      {confirmarCancelamento && (
        <DialogoBase
          /*
            Com documento no balcão a pergunta é outra (D-pdv-teclado-R02): o F6
            SOLTA a pré-venda ou o orçamento, não cancela — ele continua aberto
            no servidor. "Cancelar a venda" prometia um cancelamento que não
            acontece.
          */
          titulo={
            loadedQuote
              ? `Soltar ${rotuloDoDocumento(loadedQuote.kind).toLowerCase()} #${loadedQuote.number} do balcão?`
              : 'Cancelar a venda em aberto?'
          }
          onFechar={() => {
            setConfirmarCancelamento(false);
            searchRef.current?.focus();
          }}
          focoInicial="[data-foco-inicial]"
          testId="pdv-confirmar-cancelamento"
          rodape={
            <>
              <Button
                type="button"
                variant="ghost"
                data-foco-inicial
                onClick={() => {
                  setConfirmarCancelamento(false);
                  searchRef.current?.focus();
                }}
              >
                Voltar ao carrinho
              </Button>
              <Button
                type="button"
                variant="danger"
                onClick={() => {
                  setConfirmarCancelamento(false);
                  // O carrinho que sai da tela deixa rastro (D-pdv-teclado-12).
                  cancelarVendaMontada();
                }}
              >
                {loadedQuote ? 'Soltar do balcão (F6)' : 'Cancelar a venda (F6)'}
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-2 text-[length:var(--gs-text-base)] text-[var(--gs-text)]">
            {loadedQuote ? (
              <p className="m-0">
                <strong>
                  {rotuloDoDocumento(loadedQuote.kind)} #{loadedQuote.number} NÃO é{' '}
                  {loadedQuote.kind === 'pre_venda' ? 'cancelada' : 'cancelado'}
                </strong>
                : sai da tela e continua {loadedQuote.kind === 'pre_venda' ? 'aberta' : 'aberto'} no servidor
                {loadedQuote.kind === 'pre_venda' ? ', com a mercadoria reservada' : ''} — volta pelo F9.
              </p>
            ) : (
              <p className="m-0">
                <strong>
                  {lines.length} item(ns) — {formatCents(total)}
                </strong>{' '}
                saem da tela e não viram venda.
              </p>
            )}
            <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
              {loadedQuote
                ? 'Enter volta ao carrinho. Para soltar, aperte F6 de novo ou clique em "Soltar do balcão".'
                : 'Enter volta ao carrinho. Para cancelar, aperte F6 de novo ou clique em "Cancelar a venda".'}
            </p>
          </div>
        </DialogoBase>
      )}

      {tentativaReusada && (
        <DialogoBase
          titulo="Esta tentativa já registrou uma venda"
          onFechar={voltarDaTentativaReusada}
          focoInicial="[data-foco-inicial]"
          testId="pdv-tentativa-reusada"
          rodape={
            <>
              <Button type="button" variant="ghost" data-foco-inicial onClick={voltarDaTentativaReusada}>
                Voltar ao carrinho
              </Button>
              <Button type="button" disabled={busy} onClick={registrarComoVendaNova}>
                Registrar como venda nova
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-3 text-[length:var(--gs-text-base)] text-[var(--gs-text)]">
            <p className="m-0">
              <strong>
                {tentativaReusada.saleNumber
                  ? `Esta tentativa já registrou a venda #${tentativaReusada.saleNumber}, com outros itens.`
                  : 'Esta tentativa já registrou outra venda, com outros itens.'}
              </strong>{' '}
              Nada foi registrado agora.
            </p>
            <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
              Se o cliente está levando
              {tentativaReusada.saleNumber ? ` a venda #${tentativaReusada.saleNumber}` : ' aquela venda'} e mais
              este carrinho, registre este carrinho como venda nova. Se ela era este mesmo atendimento antes de o
              carrinho mudar, não registre de novo: volte ao carrinho e chame o gerente para cancelá-la.
            </p>
            {tentativaReusada.saleId && vendaDaTentativa === null && (
              <Button
                type="button"
                variant="ghost"
                className="self-start"
                onClick={() => void verVendaDaTentativa()}
              >
                {tentativaReusada.saleNumber ? `Ver a venda #${tentativaReusada.saleNumber}` : 'Ver essa venda'}
              </Button>
            )}
            {vendaDaTentativa === 'carregando' && (
              <p role="status" className="m-0 text-[var(--gs-muted)]">Carregando a venda…</p>
            )}
            {vendaDaTentativa === 'erro' && (
              <p role="alert" className="m-0 text-[var(--gs-danger)]">
                Não foi possível abrir a venda agora. O que ela registrou está na tela Vendas.
              </p>
            )}
            {vendaDaTentativa !== null && typeof vendaDaTentativa === 'object' && (
              <div
                data-testid="venda-da-tentativa"
                className="px-3 py-2 rounded-[var(--gs-radius)] bg-[var(--gs-canvas)] text-[length:var(--gs-text-sm)]"
              >
                <strong>
                  Venda #{vendaDaTentativa.number} — {formatCents(vendaDaTentativa.total_cents)}
                  {vendaDaTentativa.status === 'cancelled' ? ' (cancelada)' : ''}
                </strong>
                <ul className="m-0 mt-1 pl-5">
                  {vendaDaTentativa.items.map((i) => (
                    <li key={i.id}>
                      {i.quantity}× {i.description}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </DialogoBase>
      )}

      {/*
        A OBSERVAÇÃO NUM DIÁLOGO DA CASA — GAP-V58.

        O `window.prompt` era uma linha só, sem estilo, bloqueava a aba — e
        alguns kiosks/navegadores o desabilitam, caso em que a observação
        sumia SEM erro. O diálogo edita um rascunho: só o Salvar escreve na
        venda, e o valor continua indo no POST como sempre foi.
      */}
      {showNota && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
          role="dialog"
          aria-modal="true"
          ref={prenderFoco}
          tabIndex={-1}
          aria-label="Observação da venda (Alt+O)"
        >
          <div className="w-full max-w-lg rounded-[var(--gs-radius-lg)] bg-[var(--gs-surface)] shadow-2xl">
            <header className="px-6 py-4 border-b border-[var(--gs-border)]">
              <h2 className="m-0 text-[length:var(--gs-text-lg)] font-bold text-[var(--gs-purple-900)]">
                Observação da venda
              </h2>
            </header>
            <div className="px-6 py-5 flex flex-col gap-4">
              <textarea
                autoFocus
                rows={4}
                aria-label="Observação da venda"
                placeholder="Ex.: cliente busca às 18h"
                value={notaRascunho}
                onChange={(e) => setNotaRascunho(e.target.value)}
                className="w-full px-3 py-2 rounded-[var(--gs-radius)] border
                  border-[var(--gs-border-strong)] bg-[var(--gs-surface)]
                  text-[var(--gs-text)] resize-y"
              />
              <div className="flex justify-end gap-3">
                <Button variant="ghost" onClick={() => setShowNota(false)}>
                  Cancelar
                </Button>
                <Button
                  onClick={() => {
                    setNote(notaRascunho);
                    setShowNota(false);
                    // O leitor de código de barras precisa de um campo focado
                    // — a mesma lição do clearSale.
                    searchRef.current?.focus();
                  }}
                >
                  Salvar observação
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* A pesquisa avançada de verdade — F4 e o rótulo abrem a mesma coisa. */}
      {showPesquisa && (
        <PesquisaAvancadaDialog
          incluirPecas={incluirPecas}
          onClose={() => {
            setShowPesquisa(false);
            searchRef.current?.focus();
          }}
          onPick={(product) => {
            setShowPesquisa(false);
            // A escolha respeita os campos Quantidade e Preço Unitário da
            // coluna de busca — o mesmo contrato do clique na lista comum.
            const qtd = lerQuantidade(quantity);
            if (qtd === null) return;
            const preco = precoDigitadoCents();
            void enfileirar(() => addProductResolvendoUnidade(product, qtd, preco));
          }}
        />
      )}

      {showAuth && (
        <AutorizacaoGerenteDialog
          motivo={authReason}
          busy={authBusy}
          error={authError}
          justificativa={{ obrigatorio: motivoObrigatorio }}
          onCancel={() => {
            setShowAuth(false);
            setAuthError(null);
            setPendingPayments(null);
          }}
          onConfirm={(login, password, justificativa) =>
            void confirmAuthorization(login, password, justificativa)
          }
        />
      )}
    </div>
  );
}
