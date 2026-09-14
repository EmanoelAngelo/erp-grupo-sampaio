/**
 * ============================================================================
 * CONSIGNAÇÃO / CONDICIONAL — a mercadoria que sai da loja sem venda (GAP-V65)
 * ============================================================================
 *
 * Gringa e Me Mimei mandam roupa "no condicional" todo dia; PJ Motors manda a
 * peça para o mecânico testar. Até esta rodada não havia nada disso no sistema,
 * e os dois contornos disponíveis mentiam sobre o estoque: a pré-venda diz que
 * a peça continua na arara (ela reserva, não retira) e não aceita retorno
 * parcial; o caderno não diz nada a ninguém.
 *
 * O que esta tela mostra, e nesta ordem, porque é a ordem em que a pergunta
 * aparece no balcão:
 *
 *   O QUE ESTÁ COM O CLIENTE. A coluna "Pendente" é o motivo da tela existir.
 *   Consignação sem essa coluna é uma lista de papéis.
 *
 *   O CICLO, em três botões. Devolveu (volta ao estoque), levou (vira venda de
 *   verdade, com receita e financeiro) e acabou (fecha). Nada aqui é um status
 *   que alguém carimba: cada botão move estoque ou dinheiro.
 *
 * A mercadoria SAI DO SALDO na remessa — não fica reservada. A tela diz isso em
 * palavras porque é a diferença que faz a contagem do mês fechar, e porque quem
 * usa pré-venda espera o contrário.
 *
 * NÃO CONFUNDIR com o equipamento 'consignado' da oficina, que é o oposto: lá a
 * moto do cliente ENTRA na loja para ser vendida por ela.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { prenderFoco } from '@/components/gs/armadilhaDeFoco';
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
import { formatCents, formatQuantity } from '@/components/gs/format';
import { ApiRequestError } from '@/lib/api/client';
import { uuid } from '@/lib/uuid';
import { dataBR } from '@/lib/datas';
import {
  coreApi,
  type Consignment,
  type ConsignmentDetail,
  type ConsignmentItem,
  type Product,
} from '@/lib/api/core';
import { BuscaDeCliente, type Escolhido } from '@/components/gs/BuscaDeCadastro';

type Situacao = 'aberta' | 'fechada';

interface Linha {
  product: Product;
  quantity: number;
}

const STATUS_TONE: Record<string, 'neutral' | 'success' | 'warning'> = {
  aberta: 'warning',
  fechada: 'success',
};

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return dataBR(iso);
}

export default function ConsignacoesPage() {
  const [situacao, setSituacao] = useState<Situacao>('aberta');
  const [lista, setLista] = useState<Consignment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [criando, setCriando] = useState(false);
  const [detalhe, setDetalhe] = useState<ConsignmentDetail | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setLista(await coreApi.listConsignments({ status: situacao }));
    } catch (err) {
      setError(
        err instanceof ApiRequestError ? err.message : 'Falha ao carregar as consignações.',
      );
    } finally {
      setLoading(false);
    }
  }, [situacao]);

  useEffect(() => {
    void load();
  }, [load]);

  const abrirDetalhe = useCallback(async (id: string) => {
    try {
      setDetalhe(await coreApi.getConsignment(id));
    } catch (err) {
      setMessage({
        tone: 'error',
        text: err instanceof ApiRequestError ? err.message : 'Falha ao abrir a consignação.',
      });
    }
  }, []);

  /** Reabre o detalhe depois de um movimento, para a tela não mentir. */
  const recarregar = useCallback(
    async (id: string) => {
      await load();
      try {
        setDetalhe(await coreApi.getConsignment(id));
      } catch {
        setDetalhe(null);
      }
    },
    [load],
  );

  const fechar = useCallback(
    async (consignacao: ConsignmentDetail) => {
      try {
        await coreApi.closeConsignment(consignacao.id);
        setMessage({
          tone: 'ok',
          text: `Consignação #${consignacao.number} fechada — nada ficou com o cliente.`,
        });
        setDetalhe(null);
        await load();
      } catch (err) {
        setMessage({
          tone: 'error',
          text: err instanceof ApiRequestError ? err.message : 'Falha ao fechar.',
        });
      }
    },
    [load],
  );

  return (
    <AppShell>
      <PageHeader
        title="Consignação (condicional)"
        subtitle="A mercadoria SAI do estoque na remessa e não vira receita. A receita nasce quando o cliente fica com a peça."
        actions={<Button onClick={() => setCriando(true)}>Nova consignação</Button>}
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

      <div className="flex gap-2 mb-5" role="tablist" aria-label="Situação">
        {(['aberta', 'fechada'] as Situacao[]).map((s) => (
          <button
            key={s}
            role="tab"
            aria-selected={situacao === s}
            onClick={() => setSituacao(s)}
            className={`px-5 py-2.5 rounded-[var(--gs-radius)] border font-semibold text-[length:var(--gs-text-sm)]
              ${
                situacao === s
                  ? 'bg-[var(--gs-purple-800)] text-white border-[var(--gs-purple-800)]'
                  : 'bg-[var(--gs-surface)] text-[var(--gs-text)] border-[var(--gs-border)]'
              }`}
          >
            {s === 'aberta' ? 'Em aberto' : 'Fechadas'}
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
        title={situacao === 'aberta' ? 'Mercadoria na rua' : 'Consignações encerradas'}
        subtitle={
          situacao === 'aberta'
            ? 'O que saiu e ainda não voltou nem foi faturado. O saldo do estoque já desceu.'
            : 'Tudo voltou ou virou venda.'
        }
      >
        {loading ? (
          <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]" role="status">
            Carregando…
          </p>
        ) : lista.length === 0 ? (
          <EmptyState
            title={situacao === 'aberta' ? 'Nenhuma consignação aberta' : 'Nenhuma fechada'}
            description={
              situacao === 'aberta'
                ? 'Quando a cliente levar peças no condicional, registre aqui: o estoque sai da '
                  + 'loja e só vira receita no que ela ficar.'
                : 'Consignações encerradas aparecem aqui.'
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[length:var(--gs-text-sm)]">
              <thead>
                <tr className="text-left text-[var(--gs-text-soft)] border-b border-[var(--gs-border)]">
                  <th className="py-2.5 pr-4 font-semibold">Nº</th>
                  <th className="py-2.5 pr-4 font-semibold">Cliente</th>
                  <th className="py-2.5 pr-4 font-semibold">Saiu em</th>
                  <th className="py-2.5 pr-4 font-semibold">Devolver até</th>
                  <th className="py-2.5 pr-4 font-semibold">Situação</th>
                  <th className="py-2.5 pr-4 font-semibold text-right">Com o cliente</th>
                  <th className="py-2.5 font-semibold text-right">Ações</th>
                </tr>
              </thead>
              <tbody>
                {lista.map((c) => (
                  <tr key={c.id} className="border-b border-[var(--gs-border)] last:border-0">
                    <td className="py-3 pr-4 font-bold tabular-nums">#{c.number}</td>
                    <td className="py-3 pr-4">{c.customer_name ?? '—'}</td>
                    <td className="py-3 pr-4">{formatDate(c.created_at)}</td>
                    <td className="py-3 pr-4">{formatDate(c.valid_until)}</td>
                    <td className="py-3 pr-4">
                      <Badge tone={STATUS_TONE[c.status] ?? 'neutral'}>
                        {c.status === 'aberta' ? 'em aberto' : 'fechada'}
                      </Badge>
                    </td>
                    {/*
                      A COLUNA QUE JUSTIFICA A TELA: quantas peças e quanto vale
                      o que está fora da loja. Sem ela, a lista seria um
                      arquivo morto de papéis.
                    */}
                    <td className="py-3 pr-4 text-right tabular-nums">
                      <strong>{formatQuantity(c.pending_qty)}</strong>
                      <span className="block text-[length:var(--gs-text-xs)] text-[var(--gs-text-soft)]">
                        {formatCents(c.pending_value_cents)}
                      </span>
                    </td>
                    <td className="py-3 text-right">
                      <Button size="sm" variant="ghost" onClick={() => void abrirDetalhe(c.id)}>
                        Ver
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {criando && (
        <NovaConsignacaoDialog
          onClose={() => setCriando(false)}
          onCreated={(doc) => {
            setCriando(false);
            setMessage({
              tone: 'ok',
              text:
                `Consignação #${doc.number} registrada — a mercadoria SAIU do estoque. `
                + 'Nenhuma receita foi lançada.',
            });
            void load();
          }}
        />
      )}

      {detalhe && (
        <DetalheConsignacaoDialog
          detalhe={detalhe}
          onClose={() => setDetalhe(null)}
          onMovimento={(texto) => {
            setMessage({ tone: 'ok', text: texto });
            void recarregar(detalhe.id);
          }}
          onErro={(texto) => setMessage({ tone: 'error', text: texto })}
          onFechar={() => void fechar(detalhe)}
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
          <h2 className="text-[length:var(--gs-text-lg)] font-bold text-[var(--gs-purple-900)]">
            {title}
          </h2>
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

function NovaConsignacaoDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (doc: Consignment) => void;
}) {
  const [term, setTerm] = useState('');
  const [results, setResults] = useState<Product[]>([]);
  const [linhas, setLinhas] = useState<Linha[]>([]);
  /*
    O CLIENTE POR BUSCA (GAP-PRD-070): o seletor carregava os 100 primeiros
    clientes sem termo, e a mercadoria não podia sair para o 101º.
  */
  const [cliente, setCliente] = useState<Escolhido | null>(null);
  const customerId = cliente?.id ?? '';
  const [sellers, setSellers] = useState<{ id: string; displayName: string }[]>([]);
  const [sellerId, setSellerId] = useState('');
  const [validUntil, setValidUntil] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void coreApi
      .listSellers()
      .then((l) => setSellers(l.filter((s) => s.active !== false)))
      .catch(() => setSellers([]));
  }, []);

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
      return [...prev, { product, quantity: 1 }];
    });
    setTerm('');
    setResults([]);
  }, []);

  /*
    O VALOR É ESTIMATIVA DA TELA, e o rótulo diz isso.

    Quem congela o preço é o SERVIDOR, no momento da remessa, com a tabela do
    cliente e a promoção do dia — a tela não conhece nenhuma das duas para um
    cliente que ela acabou de escolher. Mostrar este número como se fosse o
    definitivo faria a vendedora prometer um total que a nota não confirma.
  */
  const estimado = useMemo(
    () => linhas.reduce((acc, l) => acc + Math.round(l.product.price_cents * l.quantity), 0),
    [linhas],
  );

  const salvar = useCallback(async () => {
    if (!customerId) {
      setError('Escolha o cliente: mercadoria que sai da loja precisa ter dono conhecido.');
      return;
    }
    if (linhas.length === 0) {
      setError('Adicione ao menos um produto.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const doc = await coreApi.createConsignment(
        {
          customerId,
          sellerId: sellerId || null,
          items: linhas.map((l) => ({ productId: l.product.id, quantity: l.quantity })),
          // A data vai PURA: o servidor a fecha no último instante do dia da
          // LOJA, como faz com a validade do orçamento. Montada aqui, ela usaria
          // o fuso do navegador.
          validUntil: validUntil || null,
          note: note || null,
        },
        // A CHAVE DA REMESSA — o mesmo gesto do retorno e do faturamento logo
        // abaixo. `busy` segura o clique duplo DESTA aba e mais nada; a chave é
        // o que impede o reenvio de rede de tirar a mercadoria do saldo duas
        // vezes, sob dois números.
        uuid(),
      );
      onCreated(doc);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Falha ao registrar a remessa.');
    } finally {
      setBusy(false);
    }
  }, [customerId, sellerId, linhas, validUntil, note, onCreated]);

  return (
    <Modal title="Nova consignação" onClose={onClose}>
      <div className="flex flex-col gap-5">
        <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
          A mercadoria <strong>sai do estoque agora</strong> — não fica reservada, porque ela
          deixa a loja de verdade. Nenhuma receita é lançada: isso só acontece no que o cliente
          ficar.
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
          {/*
            CLIENTE OBRIGATÓRIO, e sem "Consumidor final" — ao contrário do
            orçamento. Mercadoria que sai da loja sem venda precisa ter dono
            conhecido: sem ele ninguém sabe de quem cobrar nem para quem ligar
            quando o prazo vencer.
          */}
          <BuscaDeCliente
            obrigatorio
            valor={cliente}
            aoMudar={(c) => setCliente(c ? { id: c.id, nome: c.name } : null)}
            dica="Obrigatório: é para ele que a mercadoria vai, e é dele que ela volta. Busque por nome, CPF, telefone ou código."
          />

          {sellers.length > 1 && (
            <Field label="Vendedor" hint="Quem entregou. A comissão vai para ele no faturamento.">
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

          <Field
            label="Devolver até"
            hint="Combinado com o cliente. A consignação NÃO expira sozinha — expirar devolveria
                  ao saldo mercadoria que continua na casa dele."
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
        </div>

        <label className="flex flex-col gap-1.5">
          <span className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-text-soft)]">
            Observação
          </span>
          <Input value={note} onChange={(e) => setNote(e.target.value)} />
        </label>

        <div className="flex items-center justify-between pt-2 border-t border-[var(--gs-border)]">
          <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
            Valor estimado{' '}
            <strong className="text-[var(--gs-purple-900)] tabular-nums">
              {formatCents(estimado)}
            </strong>
            {' — o preço é congelado pelo servidor na remessa, com a tabela do cliente.'}
          </span>
          <div className="flex gap-3">
            <Button variant="ghost" onClick={onClose}>
              Cancelar
            </Button>
            <Button loading={busy} onClick={() => void salvar()}>
              Registrar remessa
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

/** O que a pessoa está devolvendo ou levando, item a item. */
type Quantidades = Record<string, string>;

function DetalheConsignacaoDialog({
  detalhe,
  onClose,
  onMovimento,
  onErro,
  onFechar,
}: {
  detalhe: ConsignmentDetail;
  onClose: () => void;
  onMovimento: (texto: string) => void;
  onErro: (texto: string) => void;
  onFechar: () => void;
}) {
  const [modo, setModo] = useState<'retorno' | 'faturar' | null>(null);
  const [quantidades, setQuantidades] = useState<Quantidades>({});
  const [metodo, setMetodo] = useState('dinheiro');
  const [busy, setBusy] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const pendentes = detalhe.items.filter((i) => i.pending_qty > 0);
  const totalPendente = pendentes.reduce((acc, i) => acc + i.pending_qty, 0);

  /** As linhas escolhidas, já conferidas contra o pendente de cada item. */
  const escolhidas = useMemo(() => {
    const linhas: { item: ConsignmentItem; quantity: number }[] = [];
    for (const item of pendentes) {
      const bruto = Number((quantidades[item.product_id] ?? '').replace(',', '.'));
      if (!Number.isFinite(bruto) || bruto <= 0) continue;
      linhas.push({ item, quantity: Math.min(bruto, item.pending_qty) });
    }
    return linhas;
  }, [pendentes, quantidades]);

  /*
    O TOTAL É O DO PREÇO CONGELADO NA REMESSA — o mesmo que o servidor vai
    cobrar. Recalcular pelo preço de hoje faria a tela mostrar um número e a
    venda fechar por outro, e quem explicaria a diferença ao cliente é quem
    está no balcão.
  */
  const totalAFaturar = escolhidas.reduce(
    (acc, e) => acc + Math.round(e.item.unit_price_cents * e.quantity),
    0,
  );

  const enviar = useCallback(async () => {
    if (escolhidas.length === 0) {
      setErro('Informe a quantidade de ao menos um item.');
      return;
    }
    setBusy(true);
    setErro(null);
    try {
      const items = escolhidas.map((e) => ({
        productId: e.item.product_id,
        quantity: e.quantity,
      }));
      if (modo === 'retorno') {
        /*
          A CHAVE NASCE AQUI, e não no servidor: é ela que faz o clique duplo
          do balcão ser UM retorno. Gerada no envio, e não no render, para que
          duas tentativas legítimas seguidas (a primeira falhou na rede) não
          compartilhem a chave de eventos diferentes.
        */
        await coreApi.returnConsignment(detalhe.id, { items }, uuid());
        onMovimento(`Retorno registrado — a mercadoria voltou ao estoque.`);
      } else {
        const venda = await coreApi.invoiceConsignment(
          detalhe.id,
          { items, payments: [{ method: metodo, amountCents: totalAFaturar }] },
          uuid(),
        );
        onMovimento(
          `Consignação #${detalhe.number} faturada — venda #${venda.number}, `
            + `${formatCents(venda.totalCents)}.`,
        );
      }
      setModo(null);
      setQuantidades({});
    } catch (err) {
      const texto = err instanceof ApiRequestError ? err.message : 'Falha ao registrar.';
      setErro(texto);
      onErro(texto);
    } finally {
      setBusy(false);
    }
  }, [escolhidas, modo, detalhe, metodo, totalAFaturar, onMovimento, onErro]);

  return (
    <Modal title={`Consignação #${detalhe.number}`} onClose={onClose} width="max-w-4xl">
      <div className="flex flex-col gap-5">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Info rotulo="Cliente" valor={detalhe.customer_name ?? '—'} />
          <Info rotulo="Situação" valor={detalhe.status === 'aberta' ? 'em aberto' : 'fechada'} />
          <Info rotulo="Saiu em" valor={formatDate(detalhe.created_at)} />
          <Info rotulo="Devolver até" valor={formatDate(detalhe.valid_until)} />
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-[length:var(--gs-text-sm)]">
            <thead>
              <tr className="text-left text-[var(--gs-text-soft)] border-b border-[var(--gs-border)]">
                <th className="py-2 pr-3 font-semibold">Item</th>
                <th className="py-2 pr-3 font-semibold text-right">Saiu</th>
                <th className="py-2 pr-3 font-semibold text-right">Voltou</th>
                <th className="py-2 pr-3 font-semibold text-right">Vendido</th>
                <th className="py-2 pr-3 font-semibold text-right">Com o cliente</th>
                <th className="py-2 pr-3 font-semibold text-right">Preço</th>
                {modo && <th className="py-2 font-semibold text-right w-28">Quantidade</th>}
              </tr>
            </thead>
            <tbody>
              {detalhe.items.map((item) => (
                <tr key={item.id} className="border-b border-[var(--gs-border)] last:border-0">
                  <td className="py-2.5 pr-3">{item.description}</td>
                  <td className="py-2.5 pr-3 text-right tabular-nums">
                    {formatQuantity(item.delivered_qty)}
                  </td>
                  <td className="py-2.5 pr-3 text-right tabular-nums">
                    {formatQuantity(item.returned_qty)}
                  </td>
                  <td className="py-2.5 pr-3 text-right tabular-nums">
                    {formatQuantity(item.sold_qty)}
                  </td>
                  <td className="py-2.5 pr-3 text-right font-bold tabular-nums">
                    {formatQuantity(item.pending_qty)}
                  </td>
                  <td className="py-2.5 pr-3 text-right tabular-nums">
                    {formatCents(item.unit_price_cents)}
                  </td>
                  {modo && (
                    <td className="py-2.5 text-right">
                      {item.pending_qty > 0 ? (
                        <input
                          type="number"
                          min="0"
                          max={item.pending_qty}
                          step="any"
                          value={quantidades[item.product_id] ?? ''}
                          onChange={(e) =>
                            setQuantidades((prev) => ({
                              ...prev,
                              [item.product_id]: e.target.value,
                            }))
                          }
                          aria-label={`Quantidade de ${item.description}`}
                          className="w-24 h-9 px-2 text-right tabular-nums rounded-[var(--gs-radius)]
                            border border-[var(--gs-border)]"
                        />
                      ) : (
                        <span className="text-[var(--gs-muted)]">—</span>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {modo === 'faturar' && (
          <div className="flex items-end gap-4 flex-wrap">
            <label className="flex flex-col gap-1.5">
              <span className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-text-soft)]">
                Forma de pagamento
              </span>
              <select
                value={metodo}
                onChange={(e) => setMetodo(e.target.value)}
                aria-label="Forma de pagamento"
                className="h-11 px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border)] bg-white"
              >
                <option value="dinheiro">Dinheiro</option>
                <option value="pix">PIX</option>
                <option value="debito">Débito</option>
                <option value="credito">Crédito</option>
              </select>
            </label>
            <p className="text-[length:var(--gs-text-lg)]">
              Total{' '}
              <strong className="text-[var(--gs-orange-600)] tabular-nums">
                {formatCents(totalAFaturar)}
              </strong>
            </p>
          </div>
        )}

        {erro && (
          <p role="alert" className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-danger)]">
            {erro}
          </p>
        )}

        {/* A LINHA DO TEMPO da custódia: quando saiu, quando voltou, o que virou
            venda. É ela que responde "quando a cliente devolveu as três?" sem
            obrigar ninguém a cruzar o razão de estoque por horário. */}
        {detalhe.events?.length > 0 && (
          <div className="rounded-[var(--gs-radius)] bg-[var(--gs-canvas)] px-4 py-3">
            <p className="text-[length:var(--gs-text-xs)] font-semibold uppercase tracking-wide text-[var(--gs-text-soft)] mb-2">
              Histórico
            </p>
            <ul className="flex flex-col gap-1 text-[length:var(--gs-text-sm)]">
              {detalhe.events.map((e) => (
                <li key={e.id}>
                  <strong>{formatDate(e.created_at)}</strong> · {e.kind}
                  {e.sale_number ? ` · venda #${e.sale_number}` : ''}
                  {e.user_name ? ` · ${e.user_name}` : ''}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex justify-end gap-3 pt-2 border-t border-[var(--gs-border)] flex-wrap">
          {modo ? (
            <>
              <Button
                variant="ghost"
                onClick={() => {
                  setModo(null);
                  setQuantidades({});
                  setErro(null);
                }}
              >
                Voltar
              </Button>
              <Button loading={busy} onClick={() => void enviar()}>
                {modo === 'retorno' ? 'Confirmar retorno' : 'Faturar e receber'}
              </Button>
            </>
          ) : (
            <>
              {detalhe.status === 'aberta' && totalPendente > 0 && (
                <>
                  <Button variant="secondary" onClick={() => setModo('retorno')}>
                    Registrar retorno
                  </Button>
                  <Button onClick={() => setModo('faturar')}>Faturar o que ficou</Button>
                </>
              )}
              {/*
                FECHAR só aparece quando não sobrou nada. Oferecer o botão com
                mercadoria na rua ensinaria o operador a tentar e tomar recusa —
                e o servidor recusa mesmo, nomeando o que falta.
              */}
              {detalhe.status === 'aberta' && totalPendente === 0 && (
                <Button onClick={onFechar}>Fechar consignação</Button>
              )}
              {detalhe.status === 'aberta' && totalPendente > 0 && (
                <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)] self-center">
                  Ainda há {formatQuantity(totalPendente)} com o cliente — devolva ou fature antes
                  de fechar.
                </p>
              )}
            </>
          )}
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
