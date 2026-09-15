/**
 * Orçamento e pré-venda.
 *
 * São três conceitos separados no sistema, e a tela precisa deixar isso óbvio:
 *
 *   ORÇAMENTO   cotação. Não segura estoque, não é receita. O cliente leva o
 *               papel para pensar.
 *   PRÉ-VENDA   aprovado, ainda não pago. SEGURA o estoque, para a peça não
 *               ser vendida no caixa ao lado enquanto o cliente busca dinheiro.
 *   VENDA       fato consumado. Só existe depois do pagamento, e é feita no PDV.
 *
 * O caminho é orçamento → pré-venda → venda, mas o orçamento também pode ir
 * direto para a venda quando o cliente fecha na hora. Em nenhum dos caminhos o
 * operador redigita produto: os itens viajam junto.
 *
 * Importa especialmente para PJ Motors e Oficina, onde o cliente costuma levar
 * o orçamento e voltar depois.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { prenderFoco } from '@/components/gs/armadilhaDeFoco';
import { useNavigate } from 'react-router-dom';
import { AppShell } from '@/components/gs/AppShell';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  PageHeader,
  SearchInput,
} from '@/components/gs/ui';
import { AutorizacaoGerenteDialog } from '@/components/gs/PagamentoDialog';
import { ChassiDaPreVendaCard } from '@/components/gs/ChassiDaPreVendaCard';
import { formatCents, formatQuantity, parseReaisToCents } from '@/components/gs/format';
import { ApiRequestError } from '@/lib/api/client';
import { printDocument } from '@/lib/print';
import { useHasProfile } from '@/hooks/useSession';

/**
 * `BALCAO_E_GERENCIA` do servidor (core.ts): os três caixas e os dois
 * gerentes. É a lista de `/quotes/:id/convert` e `/cancel`; somada ao
 * atendente, a de criar, editar, renovar e aprovar (GAP-PRD-149).
 */
const BALCAO_E_GERENCIA = [
  'operador_caixa',
  'operador_caixa_loja',
  'operador_caixa_oficina',
  'gerente_loja',
  'gerente_oficina',
] as const;
import {
  coreApi,
  detalheDeConcessao,
  type DetalheDeConcessao,
  type Product,
  type Quote,
  type QuoteDetail,
} from '@/lib/api/core';
import { origensEmPalavras } from './pdvConcessao';
import { dataBR } from '@/lib/datas';
import { BuscaDeCliente, type Escolhido } from '@/components/gs/BuscaDeCadastro';
import { Paginacao } from '@/components/gs/Paginacao';
import { paginaDeOrcamentos, type Pagina } from '@/lib/api/paginas';

type Kind = 'orcamento' | 'pre_venda';

interface Linha {
  product: Product;
  quantity: number;
  unitPriceCents: number;
}

/**
 * Vencido AGORA, e não "o status guardado diz vencido".
 *
 * A varredura que marca `expirado` roda na abertura de caixa. Entre o
 * vencimento e a próxima abertura, o documento continua com status 'aberto' e
 * uma data no passado — que é exatamente o estado em que ele precisa oferecer
 * a renovação, porque é o estado em que o cliente aparece com o papel na mão.
 */
function venceu(quote: { status: string; valid_until: string | null }): boolean {
  if (quote.status !== 'aberto' || !quote.valid_until) return false;
  return new Date(quote.valid_until).getTime() < Date.now();
}

const KIND_LABEL: Record<Kind, string> = {
  orcamento: 'Orçamento',
  pre_venda: 'Pré-venda',
};

const STATUS_TONE: Record<string, 'neutral' | 'success' | 'warning' | 'danger'> = {
  aberto: 'warning',
  convertido: 'success',
  expirado: 'danger',
  cancelado: 'neutral',
};

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return dataBR(iso);
}

/**
 * Data no formato do input, a partir de um prazo em dias.
 *
 * O `7` que morava na chamada desta função saiu daqui. Ele era a validade da
 * reserva do balcão inteiro escrita num formulário do frontend: mudar a
 * validade da pré-venda de uma loja exigia editar esta linha, e o servidor
 * — que é quem expira o documento e devolve o estoque — nunca soube que ela
 * existia. Agora o número vem da política comercial da operação.
 */
function inDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  /*
    DIA LOCAL, e não `toISOString().slice(0, 10)`.

    O que estava aqui somava milissegundos e lia o dia em UTC. O `<input
    type="date">` fala o calendário LOCAL, e no Brasil (UTC−3) todo documento
    aberto depois das 21h ganhava um dia a mais: "validade de 3 dias" virava 4
    na tela, sem ninguém digitar nada.

    Um dia a mais de pré-venda é um dia a mais de estoque reservado — a peça
    fora do disponível enquanto outro cliente a pede no balcão ao lado. O
    servidor tomou o mesmo cuidado nas datas de compra, e pelo mesmo motivo.
  */
  const mes = String(d.getMonth() + 1).padStart(2, '0');
  const dia = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mes}-${dia}`;
}

export default function OrcamentosPage() {
  const navigate = useNavigate();
  const [kind, setKind] = useState<Kind>('orcamento');
  const [quotes, setQuotes] = useState<Quote[]>([]);
  /*
    A PÁGINA (GAP-PRD-070): a lista parava no 100º documento sem dizer. O
    rodapé conta e anda; trocar de aba (orçamento/pré-venda) volta ao começo.
  */
  const [pagina, setPagina] = useState<Pagina<Quote> | null>(null);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const [creating, setCreating] = useState(false);
  const [detail, setDetail] = useState<QuoteDetail | null>(null);
  /**
   * O documento que está sendo EDITADO (GAP-V66).
   *
   * É o detalhe inteiro, e não só o id: o diálogo precisa dos itens, do
   * desconto e do cliente para abrir preenchido. Redigitar produto era
   * exatamente o custo que a edição existe para eliminar.
   */
  const [editando, setEditando] = useState<QuoteDetail | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const recebida = await paginaDeOrcamentos({ kind, offset: offset || undefined });
      setQuotes(recebida.items);
      setPagina(recebida);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Falha ao carregar os documentos.');
    } finally {
      setLoading(false);
    }
  }, [kind, offset]);

  useEffect(() => {
    void load();
  }, [load]);

  const abrirDetalhe = useCallback(async (id: string) => {
    try {
      setDetail(await coreApi.getQuote(id));
    } catch (err) {
      setMessage({
        tone: 'error',
        text: err instanceof ApiRequestError ? err.message : 'Falha ao abrir o documento.',
      });
    }
  }, []);

  /**
   * A aprovação esperando a liberação de um gestor.
   *
   * ## O beco que este estado abre
   *
   * A rodada da trava passou a cobrar alçada na aprovação de orçamento NUNCA
   * CONFERIDO — e "nunca conferido" é todo documento anterior àquela rodada,
   * porque a coluna `concession_cents` não existia. Quer dizer: o orçamento
   * antigo que o cliente aprova hoje bate num 403, e a tela não tinha onde
   * digitar liberação nenhuma. O balcão ficava sem saída — nem aprovar, nem
   * entender por quê.
   *
   * Guarda o orçamento e os números da recusa: os números são o que o gestor
   * lê antes de digitar a senha, e o orçamento é o que se reenvia depois.
   */
  const [aprovacaoPendente, setAprovacaoPendente] = useState<{
    quote: Quote;
    detalhe: DetalheDeConcessao | null;
    mensagem: string;
  } | null>(null);
  const [liberacaoErro, setLiberacaoErro] = useState<string | null>(null);
  const [liberando, setLiberando] = useState(false);

  const aprovar = useCallback(
    async (quote: Quote, authorizationId?: string) => {
      try {
        const preVenda = await coreApi.promoteQuote(quote.id, undefined, authorizationId);
        /*
          ATÉ QUANDO A RESERVA SEGURA — lido da resposta, não calculado aqui.

          A aprovação criava pré-venda SEM vencimento, e a varredura que expira
          documentos ignora justamente os sem data: a peça saía do disponível e
          não voltava nunca. O servidor passou a aplicar a validade da política,
          e a data que ele devolve é a que a tela mostra. Dizer "reservado" sem
          dizer até quando deixaria o operador sem o número que ele precisa para
          combinar o retorno com o cliente.
        */
        setMessage({
          tone: 'ok',
          text:
            `Orçamento #${quote.number} aprovado — pré-venda #${preVenda.number} criada, `
            + (preVenda.valid_until
              ? `estoque reservado até ${formatDate(preVenda.valid_until)}.`
              : 'estoque reservado.'),
        });
        setDetail(null);
        setAprovacaoPendente(null);
        await load();
      } catch (err) {
        /*
          A RECUSA DE ALÇADA NÃO É FALHA — é um pedido de assinatura.

          Mostrá-la como "Falha ao aprovar" numa faixa vermelha é o que
          transformava esta recusa em beco: a mensagem do servidor já diz para
          pedir a liberação de um gestor, e a tela não oferecia onde. O balcão
          lia "peça a liberação", olhava a tela, e não achava nada para clicar.

          Os números do 403 são guardados junto porque é o que o gestor precisa
          ver ANTES de digitar a senha: quanto o documento concede, sobre
          quanto, e qual o limite que ele está passando. Sem eles a liberação
          seria dada no escuro — o defeito que o PDV já corrigiu.
        */
        if (
          err instanceof ApiRequestError
          && err.code === 'CORE_DISCOUNT_NEEDS_AUTHORIZATION'
        ) {
          setAprovacaoPendente({
            quote,
            detalhe: detalheDeConcessao(err.details),
            mensagem: err.message,
          });
          setLiberacaoErro(null);
          setMessage(null);
          return;
        }
        setMessage({
          tone: 'error',
          text: err instanceof ApiRequestError ? err.message : 'Falha ao aprovar.',
        });
      }
    },
    [load],
  );

  /** O gestor digitou a credencial: pede a liberação e reenvia a aprovação. */
  const confirmarLiberacaoDaAprovacao = useCallback(
    async (login: string, password: string, justificativa?: string) => {
      if (!aprovacaoPendente) return;
      setLiberando(true);
      setLiberacaoErro(null);
      try {
        const { quote, detalhe } = aprovacaoPendente;
        const de = detalhe ? origensEmPalavras(detalhe.origens, formatCents) : [];
        /*
          OS NÚMEROS DO SERVIDOR, e não uma conta desta tela.

          `detalhe` vem do 403 — é a mesma medição que vai cobrar a liberação
          quando ela for gasta em `createQuote`. Recalcular aqui produziria um
          segundo número para o mesmo fato, e no dia em que os dois divergissem
          a liberação recusaria justamente o documento que a motivou.

          Quando o detalhe não vem (corpo engolido por um proxy, versão antiga
          do servidor), os campos ficam de fora e a liberação nasce sem teto —
          valendo uma vez só, como sempre valeu. É a porta estreita, e ela é
          preferível a INVENTAR um teto que ninguém decidiu.
        */
        const granted = await coreApi.authorize({
          action: 'desconto_acima_limite',
          login,
          password,
          concedidoCents: detalhe?.concedidoCents,
          brutoCents: detalhe?.brutoCents,
          reason:
            `Aprovação do orçamento #${quote.number}: concessão de `
            + `${formatCents(detalhe?.concedidoCents ?? 0)} (${detalhe?.percentual ?? 0}%) `
            + `sobre ${formatCents(detalhe?.brutoCents ?? 0)}`
            + (de.length > 0 ? ` — ${de.join(', ')}` : ''),
          // O PORQUÊ digitado (P0 da Preço Justo); vazio não viaja.
          justificativa: justificativa || undefined,
        });
        await aprovar(quote, granted.id);
      } catch (err) {
        setLiberacaoErro(
          err instanceof ApiRequestError ? err.message : 'Não foi possível autorizar.',
        );
      } finally {
        setLiberando(false);
      }
    },
    [aprovacaoPendente, aprovar],
  );

  const cancelar = useCallback(
    async (quote: Quote) => {
      try {
        await coreApi.cancelQuote(quote.id);
        setMessage({
          tone: 'ok',
          text:
            quote.kind === 'pre_venda'
              ? `Pré-venda #${quote.number} cancelada — estoque devolvido.`
              : `Orçamento #${quote.number} cancelado.`,
        });
        setDetail(null);
        await load();
      } catch (err) {
        setMessage({
          tone: 'error',
          text: err instanceof ApiRequestError ? err.message : 'Falha ao cancelar.',
        });
      }
    },
    [load],
  );

  /**
   * Abre o documento para EDIÇÃO (GAP-V66).
   *
   * Busca o detalhe antes de abrir porque a LISTA não traz itens — e um
   * diálogo que abrisse vazio para depois preencher piscaria o formulário na
   * cara de quem clicou, além de aceitar um "Salvar" apressado com nenhum item.
   */
  const editar = useCallback(async (quote: Quote) => {
    try {
      setEditando(await coreApi.getQuote(quote.id));
      setDetail(null);
    } catch (err) {
      setMessage({
        tone: 'error',
        text: err instanceof ApiRequestError ? err.message : 'Falha ao abrir o documento.',
      });
    }
  }, []);

  /**
   * Renova a validade do documento vencido (GAP-V66).
   *
   * Sem data: quem calcula o prazo é o SERVIDOR, pela política da operação, e é
   * ele também quem expira o documento depois. Uma data escolhida aqui criaria
   * a segunda conta para o mesmo prazo — e a divergência entre elas é reserva
   * solta antes da hora.
   */
  const renovar = useCallback(
    async (quote: Quote) => {
      try {
        const renovado = await coreApi.renewQuote(quote.id);
        setMessage({
          tone: 'ok',
          text:
            `${KIND_LABEL[quote.kind]} #${quote.number} renovado`
            + (renovado.valid_until ? ` — vale até ${formatDate(renovado.valid_until)}.` : '.'),
        });
        setDetail(null);
        await load();
      } catch (err) {
        setMessage({
          tone: 'error',
          text: err instanceof ApiRequestError ? err.message : 'Falha ao renovar a validade.',
        });
      }
    },
    [load],
  );

  /**
   * FATURAR DIRETO (GAP-V68) — o cliente que fecha na hora.
   *
   * Leva ao PDV com o documento na URL, e o PDV o carrega pelo MESMO caminho do
   * F9. Não converte daqui, e isso é decisão: a conversão precisa de meio de
   * pagamento, de gaveta aberta e da conferência de troco, e todas as três já
   * moram no balcão. Um segundo lugar que fechasse venda seria a segunda régua
   * sobre o mesmo ato — e a primeira coisa a divergir seria justamente a trava
   * de caixa fechado, que hoje existe num ponto só.
   */
  const faturar = useCallback(
    (quote: Quote) => {
      navigate(`/pdv?documento=${encodeURIComponent(quote.id)}`);
    },
    [navigate],
  );

  /*
    BOTÃO QUE O SERVIDOR FECHA NÃO APARECE (GAP-PRD-149).

    A tela é ROTA_GESTAO — o estoquista e o atendente chegam aqui —, mas cada
    ação tem o seu guarda em core.ts, e os três botões batiam na cara de quem
    ele recusa:

      - escrever (novo, editar, renovar, aprovar): `POST /quotes`, `PATCH`,
        `/renew`, `/promote` — BALCAO_E_GERENCIA + atendente;
      - fechar (Faturar, Cancelar): `/convert` e `/cancel` — BALCAO_E_GERENCIA;
      - liberar vencidos: `/expire-overdue` — os dois gerentes.

    `admin_geral` e `gestor` passam em todos, como no servidor.
  */
  const podeEscrever = useHasProfile(...BALCAO_E_GERENCIA, 'atendente');
  const podeFechar = useHasProfile(...BALCAO_E_GERENCIA);
  const podeLiberarVencidos = useHasProfile('gerente_loja', 'gerente_oficina');

  const liberarVencidos = useCallback(async () => {
    try {
      const { expired } = await coreApi.expireOverdueQuotes();
      setMessage({
        tone: 'ok',
        text:
          expired === 0
            ? 'Nenhum documento vencido.'
            : `${expired} documento(s) vencido(s) — estoque das pré-vendas devolvido.`,
      });
      await load();
    } catch (err) {
      setMessage({
        tone: 'error',
        text: err instanceof ApiRequestError ? err.message : 'Falha ao liberar vencidos.',
      });
    }
  }, [load]);

  return (
    <AppShell>
      <PageHeader
        title="Orçamentos e pré-vendas"
        subtitle="Orçamento não segura estoque. Pré-venda segura. Nenhum dos dois é venda — a receita só entra no PDV."
        actions={
          <div className="flex gap-2">
            {podeLiberarVencidos && (
              <Button variant="ghost" onClick={() => void liberarVencidos()}>
                Liberar vencidos
              </Button>
            )}
            {podeEscrever && (
              <Button onClick={() => setCreating(true)}>Novo {KIND_LABEL[kind].toLowerCase()}</Button>
            )}
          </div>
        }
      />

      {message && (
        <div
          role="status"
          className={`mb-5 px-4 py-3 rounded-[var(--gs-radius)] ${
            message.tone === 'ok'
              ? 'bg-[var(--gs-success-bg)] text-[var(--gs-success)]'
              : 'bg-[var(--gs-danger-bg)] text-[var(--gs-danger)]'
          }`}
        >
          {message.text}
        </div>
      )}

      {/* Alternância entre os dois documentos: são listas diferentes, com
          numeração própria, e misturá-las esconderia o que está reservado. */}
      <div className="flex gap-2 mb-5" role="tablist" aria-label="Tipo de documento">
        {(['orcamento', 'pre_venda'] as Kind[]).map((k) => (
          <button
            key={k}
            role="tab"
            aria-selected={kind === k}
            onClick={() => {
              setKind(k);
              setOffset(0);
            }}
            className={`px-5 py-2.5 rounded-[var(--gs-radius)] border font-semibold text-[length:var(--gs-text-sm)]
              ${
                kind === k
                  ? 'bg-[var(--gs-purple-800)] text-white border-[var(--gs-purple-800)]'
                  : 'bg-[var(--gs-surface)] text-[var(--gs-text)] border-[var(--gs-border)]'
              }`}
          >
            {KIND_LABEL[k]}
          </button>
        ))}
      </div>

      {error && (
        <div
          role="alert"
          className="mb-5 px-4 py-3 rounded-[var(--gs-radius)] bg-[var(--gs-danger-bg)] text-[var(--gs-danger)]"
        >
          {error}
        </div>
      )}

      <Card
        title={KIND_LABEL[kind]}
        subtitle={
          kind === 'orcamento'
            ? 'Cotação para o cliente levar. Não reserva mercadoria.'
            : 'Aprovado e com estoque reservado. Abra no PDV para receber.'
        }
      >
        {loading ? (
          <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]" role="status">
            Carregando…
          </p>
        ) : quotes.length === 0 ? (
          <EmptyState
            title={`Nenhum ${KIND_LABEL[kind].toLowerCase()}`}
            description={
              kind === 'orcamento'
                ? 'Monte um orçamento para o cliente levar. Ele não tira mercadoria do estoque.'
                : 'Uma pré-venda nasce da aprovação de um orçamento, ou direto por aqui.'
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[length:var(--gs-text-sm)]">
              <thead>
                <tr className="text-left text-[var(--gs-text-soft)] border-b border-[var(--gs-border)]">
                  <th className="py-2.5 pr-4 font-semibold">Nº</th>
                  <th className="py-2.5 pr-4 font-semibold">Criado</th>
                  <th className="py-2.5 pr-4 font-semibold">Validade</th>
                  <th className="py-2.5 pr-4 font-semibold">Situação</th>
                  <th className="py-2.5 pr-4 font-semibold text-right">Total</th>
                  <th className="py-2.5 font-semibold text-right">Ações</th>
                </tr>
              </thead>
              <tbody>
                {quotes.map((q) => (
                  <tr key={q.id} className="border-b border-[var(--gs-border)] last:border-0">
                    <td className="py-3 pr-4 font-bold tabular-nums">#{q.number}</td>
                    <td className="py-3 pr-4">{formatDate(q.created_at)}</td>
                    <td className="py-3 pr-4">{formatDate(q.valid_until)}</td>
                    <td className="py-3 pr-4">
                      <Badge tone={STATUS_TONE[q.status] ?? 'neutral'}>{q.status}</Badge>
                    </td>
                    <td className="py-3 pr-4 text-right font-bold tabular-nums">
                      {formatCents(q.total_cents)}
                    </td>
                    <td className="py-3 text-right">
                      <div className="inline-flex gap-2 flex-wrap justify-end">
                        <Button size="sm" variant="ghost" onClick={() => void abrirDetalhe(q.id)}>
                          Ver
                        </Button>
                        {/*
                          VENCIDO OFERECE A SAÍDA, e só ele (GAP-V66). Um botão
                          "Renovar" fixo em toda linha ensinaria o operador a
                          esticar prazo por hábito — e prazo de pré-venda é
                          mercadoria fora do disponível. Aqui ele aparece
                          exatamente quando a faixa vermelha manda renovar.
                        */}
                        {podeEscrever && venceu(q) && (
                          <Button size="sm" onClick={() => void renovar(q)}>
                            Renovar validade
                          </Button>
                        )}
                        {q.status === 'aberto' && !venceu(q) && (
                          <>
                            {podeEscrever && (
                              <Button size="sm" variant="ghost" onClick={() => void editar(q)}>
                                Editar
                              </Button>
                            )}
                            {/*
                              FATURAR DIRETO (GAP-V68): o cliente fechou na
                              hora. Vale para os dois documentos — a rota de
                              conversão sempre aceitou orçamento, e era só a
                              tela que não oferecia.
                            */}
                            {podeFechar && (
                              <Button size="sm" variant="secondary" onClick={() => faturar(q)}>
                                Faturar
                              </Button>
                            )}
                          </>
                        )}
                        {podeEscrever && q.status === 'aberto' && q.kind === 'orcamento' && !venceu(q) && (
                          <Button size="sm" onClick={() => void aprovar(q)}>
                            Aprovar
                          </Button>
                        )}
                        {podeFechar && q.status === 'aberto' && (
                          <Button size="sm" variant="ghost" onClick={() => void cancelar(q)}>
                            Cancelar
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!loading && (
          <Paginacao
            pagina={pagina ? { ...pagina, quantidade: pagina.items.length } : null}
            rotulo={{ singular: 'documento', plural: 'documentos' }}
            onMudar={setOffset}
          />
        )}
      </Card>

      {creating && (
        <DocumentoDialog
          kind={kind}
          onClose={() => setCreating(false)}
          onSaved={(doc) => {
            setCreating(false);
            setMessage({
              tone: 'ok',
              text:
                doc.kind === 'pre_venda'
                  ? `Pré-venda #${doc.number} criada — estoque reservado.`
                  : `Orçamento #${doc.number} criado. Nenhuma mercadoria foi reservada.`,
            });
            void load();
          }}
        />
      )}

      {/*
        O MESMO diálogo edita e cria, e isso é o ponto (GAP-V66).

        Um formulário de edição separado divergiria do de criação na primeira
        manutenção — e as duas telas escrevem os MESMOS campos, passam pela
        MESMA alçada no servidor e produzem o mesmo documento. Foi por dois
        formulários parecidos que a validade acabou tendo duas contas.
      */}
      {editando && (
        <DocumentoDialog
          kind={editando.kind}
          quote={editando}
          onClose={() => setEditando(null)}
          onSaved={(doc) => {
            setEditando(null);
            setMessage({
              tone: 'ok',
              text: `${KIND_LABEL[doc.kind]} #${doc.number} atualizado — o número não mudou.`,
            });
            void load();
          }}
        />
      )}

      {detail && (
        <DetalheDialog
          detail={detail}
          podeEscrever={podeEscrever}
          podeFechar={podeFechar}
          onClose={() => setDetail(null)}
          onAprovar={() => void aprovar(detail)}
          onCancelar={() => void cancelar(detail)}
          onEditar={() => void editar(detail)}
          onRenovar={() => void renovar(detail)}
          onFaturar={() => faturar(detail)}
          onRecarregar={() => void abrirDetalhe(detail.id)}
        />
      )}

      {/*
        O MESMO diálogo que o PDV usa, e é isso que o torna certo aqui.

        A liberação é a mesma coisa nos dois lugares — credencial de gestor,
        `POST /core/authorizations`, senha que não sobrevive ao modal —, e a
        pessoa que digita é a mesma. Um segundo componente parecido faria a
        aprovação de orçamento divergir do balcão no primeiro ajuste que só um
        dos dois recebesse, e o gestor teria de aprender duas telas para a
        mesma decisão.

        O `motivo` monta a frase com os números do 403: é o que ele lê antes de
        assinar, e é o mesmo texto que vai gravado na liberação.
      */}
      {aprovacaoPendente && (
        <AutorizacaoGerenteDialog
          motivo={
            `${aprovacaoPendente.mensagem}`
            + (aprovacaoPendente.detalhe
              ? ` (${formatCents(aprovacaoPendente.detalhe.concedidoCents)} sobre `
                + `${formatCents(aprovacaoPendente.detalhe.brutoCents)}, `
                + `${aprovacaoPendente.detalhe.percentual}%`
                // O perfil pode não ter teto em % (só em R$ ou por item, P0):
                // aí o servidor manda nulo, e "limite null%" não diz nada.
                + (aprovacaoPendente.detalhe.limite !== null
                  ? `, limite ${aprovacaoPendente.detalhe.limite}%`
                  : '')
                + ')'
              : '')
          }
          busy={liberando}
          error={liberacaoErro}
          // O motivo aparece sempre; quem decide se é obrigatório é o servidor.
          justificativa={{ obrigatorio: false }}
          onCancel={() => {
            setAprovacaoPendente(null);
            setLiberacaoErro(null);
          }}
          onConfirm={(login, password, justificativa) =>
            void confirmarLiberacaoDaAprovacao(login, password, justificativa)
          }
        />
      )}
    </AppShell>
  );
}

// ------------------------------------------------------------------- modais

function Modal({
  title,
  onClose,
  children,
  width = 'max-w-3xl',
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  width?: string;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
      role="dialog"
      aria-modal="true"
      ref={prenderFoco}
      tabIndex={-1}
      aria-label={title}
    >
      <div
        className={`w-full ${width} max-h-[90vh] overflow-y-auto rounded-[var(--gs-radius-lg)]
          bg-[var(--gs-surface)] shadow-2xl`}
      >
        <header className="px-6 py-4 border-b border-[var(--gs-border)] flex items-center justify-between">
          <h2 className="text-[length:var(--gs-text-lg)] font-bold text-[var(--gs-purple-900)]">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar"
            className="text-[var(--gs-text-soft)] text-[length:var(--gs-text-lg)] leading-none px-2"
          >
            ×
          </button>
        </header>
        <div className="px-6 py-5">{children}</div>
      </div>
    </div>
  );
}

/**
 * Cria E EDITA o documento — o mesmo formulário para os dois (GAP-V66/V67/V69).
 *
 * `quote` ausente = novo documento. Presente = edição do que já existe, que
 * mantém número, histórico e a liberação de gestor já consumida.
 */
function DocumentoDialog({
  kind,
  quote,
  onClose,
  onSaved,
}: {
  kind: Kind;
  /** O documento a EDITAR. Ausente = novo. */
  quote?: QuoteDetail;
  onClose: () => void;
  onSaved: (doc: Quote) => void;
}) {
  const editando = Boolean(quote);
  const [term, setTerm] = useState('');
  const [results, setResults] = useState<Product[]>([]);
  const [linhas, setLinhas] = useState<Linha[]>([]);
  /*
    O CLIENTE POR BUSCA, E O DO DOCUMENTO PELO ID (GAP-PRD-070).

    O seletor antigo carregava os 100 primeiros clientes. O orçamento da "Zuleide"
    abria para edição com o seletor mostrando "Consumidor final" — o valor
    guardado não estava entre as opções — e salvava o cliente sem mostrar
    qual. Agora o escolhido é {id, nome}; o nome do cliente do documento vem da
    ficha dele, pedida pelo id.
  */
  const [cliente, setCliente] = useState<Escolhido | null>(
    quote?.customer_id ? { id: quote.customer_id, nome: 'Cliente do documento' } : null,
  );
  const customerId = cliente?.id ?? '';
  /**
   * A EQUIPE que pode vender — e o campo que faltava (GAP-V67).
   *
   * `listSellers` e não `listTeam`: a segunda exige gerente e devolve o
   * cadastro inteiro (login, e-mail, último acesso). O balcão tomava 403 num
   * catch silencioso e o seletor sumia — foi assim que o PDV descobriu isto.
   */
  const [sellers, setSellers] = useState<{ id: string; displayName: string }[]>([]);
  const [sellerId, setSellerId] = useState('');
  const [discount, setDiscount] = useState('');
  /**
   * Começa VAZIO, e não com uma data calculada de um número inventado aqui.
   *
   * Enquanto a política não chega — ou quando o perfil não pode lê-la — o campo
   * fica em branco, e `salvar` manda `validUntil: null`. Nulo faz o SERVIDOR
   * aplicar a validade da operação, que é a mesma regra que expira o documento
   * depois. Preencher com um palpite do frontend seria pior que deixar vazio:
   * o palpite VENCE o padrão do servidor, porque data explícita manda.
   */
  const [validUntil, setValidUntil] = useState('');
  /**
   * A data que a POLÍTICA sugeriu, guardada para saber se alguém a mudou.
   *
   * É o que permite mandar `null` quando ninguém mexeu — ver `salvar`. Sem
   * este espelho, a tela não teria como distinguir "o operador escolheu
   * justamente este dia" de "o operador não tocou no campo".
   */
  const [sugerida, setSugerida] = useState('');
  /** Nulo = a tela não sabe o prazo, e diz isso em vez de fingir que sabe. */
  const [validadeDias, setValidadeDias] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const id = quote?.customer_id;
    if (!id) return;
    let vivo = true;
    coreApi
      .getCustomer(id)
      .then((c) => {
        if (vivo && c?.id === id && c.name) setCliente({ id, nome: c.name });
      })
      .catch(() => {
        // Sem a ficha, o documento continua com o cliente dele — só sem o nome.
      });
    return () => {
      vivo = false;
    };
  }, [quote?.customer_id]);

  /*
    QUEM PODE VENDER — e o 403 aqui NÃO é falha (GAP-V67).

    `GET /core/sellers` nasceu porque o PDV chamava `GET /core/team`, que exige
    gerente: o 403 caía num catch silencioso e o seletor nunca aparecia para
    quem opera o caixa — e toda venda saía em nome de quem estava no balcão,
    comissão inclusive. Aqui vale o mesmo: sem a lista, o campo simplesmente
    não aparece, e o documento nasce sem vendedor declarado, como sempre nasceu.
  */
  useEffect(() => {
    void coreApi
      .listSellers()
      .then((lista) => setSellers(lista.filter((s) => s.active !== false)))
      .catch(() => setSellers([]));
  }, []);

  /*
    A VALIDADE VEM DA POLÍTICA DA OPERAÇÃO.

    `/core/sale-policies` exige perfil de gerente, e esta tela é ROTA_GESTAO —
    que abre também para atendente e estoquista. Quem não pode ler recebe 403 e
    o campo simplesmente fica em branco: o documento nasce com a validade que o
    servidor aplica, exatamente como se ninguém tivesse mexido. Um 403 aqui não
    é falha, é a divisão normal de quem decide política e quem faz orçamento.

    NA EDIÇÃO o campo nem existe: `PATCH /quotes/:id` não mexe em validade, e
    quem estica prazo é a renovação, que tem botão próprio. Um campo de data
    que a rota ignora seria pior que ausência — o operador mudaria a data,
    salvaria, e o documento continuaria vencendo no mesmo dia.
  */
  useEffect(() => {
    if (editando) return;
    void coreApi
      .getSalePolicy()
      .then((p) => {
        setValidadeDias(p.reservationValidDays);
        setValidUntil(inDays(p.reservationValidDays));
        setSugerida(inDays(p.reservationValidDays));
      })
      .catch(() => {
        setValidadeDias(null);
        setValidUntil('');
        setSugerida('');
      });
  }, [editando]);

  /*
    OS ITENS DO DOCUMENTO QUE ESTÁ SENDO EDITADO, com o PRODUTO de verdade.

    `core_quote_items` guarda descrição e preço congelados, mas a linha da tela
    precisa do produto inteiro — é dele que saem o saldo mostrado na busca e o
    id que volta no corpo. Buscar cada um é o que o PDV já faz ao carregar
    pré-venda pelo F9, e pelo mesmo motivo: um objeto montado à mão pareceria
    funcionar e mentiria sobre o cadastro.
  */
  useEffect(() => {
    if (!quote) return;
    let vivo = true;
    void (async () => {
      const carregadas: Linha[] = [];
      for (const item of quote.items) {
        if (!item.product_id) continue;
        try {
          const product = await coreApi.getProduct(item.product_id);
          carregadas.push({
            product,
            quantity: item.quantity,
            unitPriceCents: item.unit_price_cents,
          });
        } catch {
          // Produto inacessível (inativado depois do documento): a linha fica
          // de fora e a pessoa vê o que sobrou, em vez de um diálogo que não
          // abre. Salvar sem ela seria removê-la — e é isso que a tela mostra.
        }
      }
      if (vivo) setLinhas(carregadas);
    })();
    return () => {
      vivo = false;
    };
  }, [quote]);

  /*
    O desconto e o vendedor gravados voltam para os campos: editar um documento
    que abrisse com desconto zero apagaria o desconto de quem só quis trocar a
    quantidade.

    VÍRGULA, e não ponto — a mesma régua do PDV (`reaisNoCampo`). Foi visto na
    TELA, com o servidor de verdade respondendo: o campo reabria escrito
    "10.00". `parseReaisToCents` lê o ponto sem reclamar, então o valor não
    ficava errado; o que ficava errado era o campo ENSINAR a digitar com ponto
    num sistema em que todo o resto do dinheiro se escreve com vírgula. Zero
    devolve vazio de propósito: "0,00" pré-escrito pareceria um desconto
    decidido.
  */
  useEffect(() => {
    if (!quote) return;
    setDiscount(
      quote.discount_cents > 0 ? (quote.discount_cents / 100).toFixed(2).replace('.', ',') : '',
    );
    setSellerId(quote.seller_id ?? '');
    setNote(quote.note ?? '');
  }, [quote]);

  const subtotal = useMemo(
    () => linhas.reduce((acc, l) => acc + Math.round(l.unitPriceCents * l.quantity), 0),
    [linhas],
  );
  /*
    O DESCONTO É DIGITADO EM REAIS — GAP-V69.

    O que estava aqui era `Number(discount.replace(/\D/g, ''))`, com o rótulo
    "Desconto (centavos)": o campo pedia o número em centavos e jogava fora tudo
    que não fosse dígito. "10,00" virava 1000 por ACASO — a vírgula caía no
    filtro — e "10" virava R$ 0,10. Dez reais de desconto viravam dez centavos,
    sem erro em lugar nenhum.

    E não é só o valor errado: este campo alimenta a ALÇADA. Desconto de menos
    passa por baixo do limite e não chama gestor; desconto de mais (quem
    aprendeu a digitar "1000") o chama à toa. `parseReaisToCents` é a MESMA
    régua do PDV, com a mesma recusa de texto que não é dinheiro — nula vira
    zero, que é o estado honesto de campo vazio.
  */
  const discountCents = Math.max(0, parseReaisToCents(discount) ?? 0);
  const total = Math.max(0, subtotal - discountCents);

  const buscar = useCallback(async () => {
    const q = term.trim();
    if (!q) return;
    try {
      setResults(await coreApi.searchProducts(q));
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Falha na busca.');
    }
  }, [term]);

  const adicionar = useCallback((product: Product) => {
    setLinhas((prev) => {
      const i = prev.findIndex((l) => l.product.id === product.id);
      if (i >= 0) {
        const next = [...prev];
        next[i] = { ...next[i], quantity: next[i].quantity + 1 };
        return next;
      }
      return [...prev, { product, quantity: 1, unitPriceCents: product.price_cents }];
    });
    setTerm('');
    setResults([]);
  }, []);

  const salvar = useCallback(async () => {
    if (linhas.length === 0) {
      setError('Adicione ao menos um produto.');
      return;
    }
    setBusy(true);
    setError(null);
    const itens = linhas.map((l) => ({
      productId: l.product.id,
      quantity: l.quantity,
      unitPriceCents: l.unitPriceCents,
    }));
    try {
      /*
        EDITAR MANDA PATCH, e não um POST novo (GAP-V66).

        `discountCents` viaja SEMPRE na edição — inclusive zero — porque aqui
        zero é uma decisão: quem apagou o desconto quer apagá-lo. No servidor,
        ausente significa "não mexa", e um `|| undefined` faria o desconto
        antigo sobreviver ao gesto de tirá-lo.
      */
      if (quote) {
        const doc = await coreApi.updateQuote(quote.id, {
          items: itens,
          customerId: customerId || null,
          sellerId: sellerId || null,
          discountCents,
          note: note || null,
        });
        onSaved(doc);
        return;
      }
      const doc = await coreApi.createQuote({
        kind,
        items: itens,
        customerId: customerId || null,
        // QUEM VENDEU — o elo que faltava (GAP-V67). Sem ele, a conversão
        // propaga nulo e a comissão nasce para quem está no caixa.
        sellerId: sellerId || null,
        discountCents: discountCents || undefined,
        /*
          QUEM DECIDE A VALIDADE É O SERVIDOR — a tela só sugere e só fala
          quando o operador escolhe OUTRA data.

          Havia duas contas para o mesmo prazo, e elas não davam o mesmo
          instante: o servidor encerra a validade no FIM do dia
          (`validadeDaReserva`, 23:59:59.999 no relógio da loja) e a tela
          mandava a data do input reconstruída aqui. Data explícita vence o
          padrão do servidor, então era a conta da TELA que valia sempre que o
          campo vinha preenchido — inclusive quando ninguém o tinha preenchido,
          porque a sugestão o preenchia sozinha. Um instante calculado a menos
          é reserva solta antes da hora: a peça volta ao disponível e é vendida
          para outro cliente enquanto o primeiro ainda tem prazo.

          Campo intocado (ou vazio) viaja como `null`, e aí existe uma conta só,
          no lugar que também é quem EXPIRA o documento depois. A data explícita
          continua possível — é o operador combinando outro prazo com o cliente
          — e vai no fim do dia escolhido, com o mesmo milissegundo do servidor,
          para que os dois caminhos não deixem documentos vencendo em horas
          diferentes.
        */
        validUntil:
          !validUntil || validUntil === sugerida
            ? null
            : // A DATA VAI PURA: o servidor a fecha no último instante do dia da
              // LOJA. Montada aqui, ela usava o fuso do navegador.
              validUntil,
        note: note || null,
      });
      onSaved(doc);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Falha ao salvar.');
    } finally {
      setBusy(false);
    }
  }, [
    linhas,
    kind,
    quote,
    customerId,
    sellerId,
    discountCents,
    validUntil,
    sugerida,
    note,
    onSaved,
  ]);

  return (
    <Modal
      title={
        editando
          ? `${KIND_LABEL[kind]} #${quote?.number} — editar`
          : `Novo ${KIND_LABEL[kind].toLowerCase()}`
      }
      onClose={onClose}
    >
      <div className="flex flex-col gap-5">
        <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
          {editando
            ? kind === 'pre_venda'
              ? 'A reserva acompanha a edição: o que você acrescentar sai do disponível agora, e '
                + 'o que tirar volta. O número do documento não muda.'
              : 'O número do documento não muda — e a liberação de gestor que ele já tem '
                + 'continua valendo.'
            : kind === 'pre_venda'
              ? 'A pré-venda reserva a mercadoria assim que for salva. Sem saldo, ela não é criada.'
              : 'O orçamento não reserva mercadoria — pode ser feito mesmo sem saldo disponível.'}
        </p>

        <div className="flex gap-3 items-end">
          <div className="flex-1">
            <SearchInput
              value={term}
              onChange={setTerm}
              onEnter={() => void buscar()}
              placeholder="Pesquise o produto por nome, código ou código de barras"
            />
          </div>
          <Button variant="secondary" onClick={() => void buscar()}>
            Buscar
          </Button>
        </div>

        {results.length > 0 && (
          <ul className="flex flex-col gap-1.5 max-h-48 overflow-y-auto">
            {results.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => adicionar(p)}
                  className="w-full text-left px-3 py-2.5 rounded-[var(--gs-radius)]
                    bg-[var(--gs-canvas)] hover:bg-[var(--gs-surface-hover)] flex justify-between"
                >
                  <span>
                    <strong className="block">{p.name}</strong>
                    <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
                      {p.internal_code} · saldo {formatQuantity(Number(p.stock_quantity ?? 0))}
                    </span>
                  </span>
                  <span className="font-bold">{formatCents(p.price_cents)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {linhas.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-[length:var(--gs-text-sm)]">
              <thead>
                <tr className="text-left text-[var(--gs-text-soft)] border-b border-[var(--gs-border)]">
                  <th className="py-2 pr-3 font-semibold">Produto</th>
                  <th className="py-2 pr-3 font-semibold w-24">Qtde</th>
                  <th className="py-2 pr-3 font-semibold text-right">Unitário</th>
                  <th className="py-2 pr-3 font-semibold text-right">Total</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {linhas.map((l, i) => (
                  <tr key={l.product.id} className="border-b border-[var(--gs-border)] last:border-0">
                    <td className="py-2.5 pr-3">{l.product.name}</td>
                    <td className="py-2.5 pr-3">
                      <input
                        type="number"
                        min="1"
                        value={l.quantity}
                        onChange={(e) =>
                          setLinhas((prev) => {
                            const next = [...prev];
                            next[i] = { ...next[i], quantity: Math.max(1, Number(e.target.value)) };
                            return next;
                          })
                        }
                        aria-label={`Quantidade de ${l.product.name}`}
                        className="w-20 h-9 px-2 rounded-[var(--gs-radius)] border border-[var(--gs-border)]"
                      />
                    </td>
                    {/* Preço editável: orçamento é negociação. O valor
                        acertado aqui viaja para a pré-venda e para a venda. */}
                    <td className="py-2.5 pr-3 text-right">
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={(l.unitPriceCents / 100).toFixed(2)}
                        onChange={(e) =>
                          setLinhas((prev) => {
                            const next = [...prev];
                            next[i] = {
                              ...next[i],
                              unitPriceCents: Math.max(0, Math.round(Number(e.target.value) * 100)),
                            };
                            return next;
                          })
                        }
                        aria-label={`Preço unitário de ${l.product.name}`}
                        className="w-28 h-9 px-2 text-right tabular-nums rounded-[var(--gs-radius)]
                          border border-[var(--gs-border)]"
                      />
                    </td>
                    <td className="py-2.5 pr-3 text-right font-bold tabular-nums">
                      {formatCents(Math.round(l.unitPriceCents * l.quantity))}
                    </td>
                    <td className="py-2.5 text-right">
                      <button
                        type="button"
                        onClick={() => setLinhas((prev) => prev.filter((_, j) => j !== i))}
                        aria-label={`Remover ${l.product.name}`}
                        className="text-[var(--gs-danger)] font-semibold"
                      >
                        remover
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <BuscaDeCliente
            valor={cliente}
            aoMudar={(c) => setCliente(c ? { id: c.id, nome: c.name } : null)}
            rotuloVazio="Consumidor final"
          />

          {/*
            O VENDEDOR — o elo TELA→API que faltava (GAP-V67).

            Só aparece quando há mais de uma pessoa: loja de uma pessoa só
            ganharia um seletor de uma opção, que é atrito à toa — a mesma
            decisão do PDV. E quando a lista não chega (403), o campo some e o
            documento nasce sem vendedor, como sempre nasceu.
          */}
          {sellers.length > 1 && (
            <Field
              label="Vendedor"
              hint="Quem montou este documento. A comissão vai para ele quando a venda fechar,
                    mesmo que quem fature seja o caixa."
            >
              {(p) => (
                <select
                  {...p}
                  value={sellerId}
                  onChange={(e) => setSellerId(e.target.value)}
                  className="h-11 px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border)] bg-white"
                >
                  <option value="">Não informado</option>
                  {sellers.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.displayName}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          )}

          {/*
            DESCONTO EM REAIS — GAP-V69.

            O rótulo dizia "(centavos)" e o campo filtrava não-dígitos: "10"
            virava R$ 0,10 e "10,00" acertava por acaso. Agora é a mesma entrada
            do PDV, e o rótulo diz a unidade em que a pessoa pensa.
          */}
          <Field
            label="Desconto (R$)"
            hint="Em reais, como no balcão. Desconto acima do limite da operação pede liberação
                  de gestor."
          >
            {(p) => (
              <Input
                {...p}
                value={discount}
                onChange={(e) => setDiscount(e.target.value)}
                inputMode="decimal"
                placeholder="0,00"
              />
            )}
          </Field>

          {/*
            `Field` e não um <label> cru como os vizinhos: a linha de apoio
            precisa ser DESCRIÇÃO, e não parte do nome do campo. Dentro de um
            label que embrulha o input, o texto de apoio entra no nome acessível
            e o leitor de tela anuncia "Válido até Sugerido pela política do
            balcão 3 dias" como se fosse tudo o rótulo. `Field` põe a frase em
            aria-describedby, que é onde ela pertence.

            E a frase precisa existir: sem ela o operador não distingue "o
            sistema sugeriu" de "alguém digitou", e a validade da pré-venda é o
            que segura estoque — uma data esticada sem querer tira a peça do
            disponível por semanas.

            NA EDIÇÃO ele não aparece: `PATCH /quotes/:id` não mexe em validade,
            e quem estica prazo é o botão Renovar. Um campo que a rota ignora
            seria pior que ausência — a pessoa mudaria a data, salvaria, e o
            documento continuaria vencendo no mesmo dia.
          */}
          {!editando && (
            <Field
              label="Válido até"
              hint={
                validadeDias === null
                  ? 'Em branco: vale a validade padrão desta operação, aplicada pelo servidor.'
                  : `Sugerido pela política do balcão: ${validadeDias} dia(s) — sem mexer aqui, quem `
                    + 'data o documento é o servidor. Outra data vale até o fim do dia escolhido.'
              }
            >
              {(p) => (
                <Input
                  {...p}
                  type="date"
                  value={validUntil}
                  onChange={(e) => setValidUntil(e.target.value)}
                />
              )}
            </Field>
          )}
        </div>

        <label className="flex flex-col gap-1.5">
          <span className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-text-soft)]">
            Observação
          </span>
          <Input value={note} onChange={(e) => setNote(e.target.value)} />
        </label>

        <div className="flex items-center justify-between pt-2 border-t border-[var(--gs-border)]">
          <span className="text-[length:var(--gs-text-lg)]">
            Total{' '}
            <strong className="text-[var(--gs-orange-600)] text-[length:var(--gs-text-xl)] tabular-nums">
              {formatCents(total)}
            </strong>
          </span>
          <div className="flex gap-3">
            <Button variant="ghost" onClick={onClose}>
              Cancelar
            </Button>
            <Button loading={busy} onClick={() => void salvar()}>
              Salvar {KIND_LABEL[kind].toLowerCase()}
            </Button>
          </div>
        </div>

        {error && (
          <p role="alert" className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-danger)]">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}

function DetalheDialog({
  detail,
  podeEscrever,
  podeFechar,
  onClose,
  onAprovar,
  onCancelar,
  onEditar,
  onRenovar,
  onFaturar,
  onRecarregar,
}: {
  detail: QuoteDetail;
  /** O mesmo recorte dos botões da lista (GAP-PRD-149). */
  podeEscrever: boolean;
  podeFechar: boolean;
  onClose: () => void;
  onAprovar: () => void;
  onCancelar: () => void;
  onEditar: () => void;
  onRenovar: () => void;
  onFaturar: () => void;
  /** O documento mudou por dentro (o chassi segurado): reler do servidor. */
  onRecarregar: () => void;
}) {
  const podeAprovar =
    podeEscrever && detail.kind === 'orcamento' && detail.status === 'aberto' && !detail.expired;
  const abertoEValido = detail.status === 'aberto' && !detail.expired;

  return (
    <Modal
      title={`${KIND_LABEL[detail.kind]} #${detail.number}`}
      onClose={onClose}
    >
      <div className="flex flex-col gap-5">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Info rotulo="Situação" valor={detail.status} />
          <Info rotulo="Validade" valor={formatDate(detail.valid_until)} />
          <Info rotulo="Criado" valor={formatDate(detail.created_at)} />
          <Info rotulo="Total" valor={formatCents(detail.total_cents)} />
        </div>

        {/*
          A FAIXA DEIXOU DE SER BECO — GAP-V66.

          Ela sempre disse "Renove a validade antes de aprovar", e não havia
          rota, serviço nem botão que renovasse coisa alguma: a tela ensinava um
          gesto que o sistema não sabia fazer. O botão vive DENTRO da faixa, ao
          lado da frase que o pede, porque é ali que a pessoa está olhando.
        */}
        {detail.expired && detail.status === 'aberto' && (
          <div
            role="alert"
            className="px-4 py-3 rounded-[var(--gs-radius)] bg-[var(--gs-danger-bg)] text-[var(--gs-danger)]
              font-semibold flex items-center justify-between gap-4 flex-wrap"
          >
            <span>
              Vencido em {formatDate(detail.valid_until)}. Renove a validade antes de aprovar.
            </span>
            {podeEscrever && (
              <Button size="sm" onClick={onRenovar}>
                Renovar validade
              </Button>
            )}
          </div>
        )}

        {detail.kind === 'pre_venda' && detail.status === 'aberto' && (
          <p className="px-4 py-3 rounded-[var(--gs-radius)] bg-[var(--gs-success-bg)] text-[var(--gs-success)]">
            Mercadoria reservada. Abra esta pré-venda no PDV (tecla F9) para receber e faturar.
          </p>
        )}

        {/* A moto negociada é AQUELA moto (GAP-PRD-111). */}
        <ChassiDaPreVendaCard detail={detail} onAlterado={onRecarregar} />


        {/*
          QUEM LIBEROU O DESCONTO — a assinatura do gestor, na folha em que o
          documento é conferido.

          O servidor guardava esse vínculo desde que a alçada passou a medir o
          documento, e nenhuma tela o mostrava: o desconto grande aparecia no
          total, e o nome de quem autorizou ficava só no banco. Na conferência
          de caixa a pergunta é exatamente essa, e quem tinha de respondê-la
          abria o relatório de autorizações e cruzava por horário.

          Só aparece quando existe. Documento cujo desconto coube no limite não
          tem liberação, e um "Liberado por: —" fixo na tela ensinaria o
          operador a ignorar a linha justamente nos casos em que ela importa.
        */}
        {detail.liberacao && (
          <p className="px-4 py-3 rounded-[var(--gs-radius)] bg-[var(--gs-warning-bg)] text-[var(--gs-purple-900)]">
            <strong>Desconto liberado por {detail.liberacao.autorizado_por ?? 'gestor'}</strong>
            {' em '}
            {formatDate(detail.liberacao.created_at)}
            {detail.liberacao.granted_concession_cents !== null
              && ` — até ${formatCents(detail.liberacao.granted_concession_cents)} de concessão`}
            {detail.liberacao.reason && `. Motivo: ${detail.liberacao.reason}`}
          </p>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-[length:var(--gs-text-sm)]">
            <thead>
              <tr className="text-left text-[var(--gs-text-soft)] border-b border-[var(--gs-border)]">
                <th className="py-2 pr-3 font-semibold">Item</th>
                <th className="py-2 pr-3 font-semibold text-right">Qtde</th>
                <th className="py-2 pr-3 font-semibold text-right">Unitário</th>
                <th className="py-2 font-semibold text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {detail.items.map((item) => (
                <tr key={item.id} className="border-b border-[var(--gs-border)] last:border-0">
                  <td className="py-2.5 pr-3">{item.description}</td>
                  <td className="py-2.5 pr-3 text-right tabular-nums">
                    {formatQuantity(item.quantity)}
                  </td>
                  <td className="py-2.5 pr-3 text-right tabular-nums">
                    {formatCents(item.unit_price_cents)}
                  </td>
                  <td className="py-2.5 text-right font-bold tabular-nums">
                    {formatCents(item.total_cents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {detail.note && (
          <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">{detail.note}</p>
        )}

        <div className="flex justify-end gap-3 pt-2 border-t border-[var(--gs-border)]">
          <Button
            variant="ghost"
            onClick={() =>
              void printDocument(detail.kind === 'pre_venda' ? 'PRE_SALE' : 'QUOTE', detail.id)
            }
          >
            Imprimir / PDF
          </Button>
          {podeFechar && detail.status === 'aberto' && (
            <Button variant="ghost" onClick={onCancelar}>
              Cancelar documento
            </Button>
          )}
          {podeEscrever && abertoEValido && (
            <Button variant="ghost" onClick={onEditar}>
              Editar
            </Button>
          )}
          {/* O cliente fechou na hora: vai direto ao balcão (GAP-V68). */}
          {podeFechar && abertoEValido && (
            <Button variant="secondary" onClick={onFaturar}>
              Faturar no PDV
            </Button>
          )}
          {podeAprovar && <Button onClick={onAprovar}>Aprovar → pré-venda</Button>}
        </div>
      </div>
    </Modal>
  );
}

function Info({ rotulo, valor }: { rotulo: string; valor: string }) {
  return (
    <div className="rounded-[var(--gs-radius)] bg-[var(--gs-canvas)] px-4 py-3">
      <p className="text-[length:var(--gs-text-xs)] font-semibold uppercase tracking-wide text-[var(--gs-text-soft)]">
        {rotulo}
      </p>
      <p className="font-bold text-[var(--gs-purple-900)]">{valor}</p>
    </div>
  );
}
