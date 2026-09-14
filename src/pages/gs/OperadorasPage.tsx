/**
 * Financeiro › Operadoras de cartão — taxa e prazo.
 *
 * ## O que esta tela liga
 *
 * Sem nenhuma taxa cadastrada, uma venda no cartão nasce como dinheiro que já
 * entrou, integral, no dia da venda. Na prática o dinheiro cai depois e cai
 * menor. Cadastrar a taxa aqui é o que faz o financeiro parar de contar dinheiro
 * que ainda não chegou.
 *
 * A tela diz isso em voz alta, porque é uma mudança de comportamento e quem
 * cadastra precisa saber o que está ligando.
 *
 * ## A taxa é por forma E por número de parcelas
 *
 * A operadora cobra diferente para débito, crédito à vista e crédito em 6×.
 * Faixa de "3 a 6 parcelas" foi recusada: a operadora cobra por número exato,
 * e aproximar aqui faria a conferência com o extrato nunca fechar.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppShell } from '@/components/gs/AppShell';
import { Badge, Button, Card, EmptyState, Input, PageHeader } from '@/components/gs/ui';
import { formatCents } from '@/components/gs/format';
import { ApiRequestError } from '@/lib/api/client';
import {
  coreApi,
  type Acquirer,
  type AcquirerRate,
  type PaymentMethodOption,
} from '@/lib/api/core';

const ROTULO = 'text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-text-soft)]';
const TH = 'py-2.5 px-4 font-semibold';
const TD = 'py-3 px-4';
const CAIXA_SELECT =
  'h-10 px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)] ' +
  'bg-[var(--gs-surface)] text-[var(--gs-text)] text-[length:var(--gs-text-base)]';

/** Basis points para texto: 350 vira "3,5". */
const bpsParaTexto = (bps: number) => String(bps / 100).replace('.', ',');

function textoParaBps(texto: string): number {
  const n = Number(texto.replace(',', '.'));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : 0;
}

export default function OperadorasPage() {
  const [operadoras, setOperadoras] = useState<Acquirer[] | null>(null);
  const [taxas, setTaxas] = useState<AcquirerRate[]>([]);
  const [metodos, setMetodos] = useState<PaymentMethodOption[]>([]);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);

  const [novoNome, setNovoNome] = useState('');
  const [opAberta, setOpAberta] = useState('');
  const [forma, setForma] = useState('credito');
  const [parcelas, setParcelas] = useState('1');
  const [taxa, setTaxa] = useState('');
  const [dias, setDias] = useState('30');

  const carregar = useCallback(async () => {
    setErro(null);
    try {
      const r = await coreApi.acquirerSetup();
      setOperadoras(r.acquirers);
      setTaxas(r.rates);
      // Só formas que passam por maquininha ou provedor têm taxa e prazo.
      setMetodos(r.methods.filter((m) => !m.cash));
    } catch (e) {
      setErro(e instanceof ApiRequestError ? e.message : 'Não foi possível carregar.');
      setOperadoras([]);
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  async function comSalvamento(acao: () => Promise<void>, mensagem: string) {
    setSalvando(true);
    setErro(null);
    setAviso(null);
    try {
      await acao();
      setAviso(mensagem);
      await carregar();
    } catch (e) {
      setErro(e instanceof ApiRequestError ? e.message : 'Não foi possível gravar.');
    } finally {
      setSalvando(false);
    }
  }

  const taxasDaOperadora = useMemo(
    () => taxas.filter((t) => t.acquirer_id === opAberta),
    [taxas, opAberta],
  );

  /** Enquanto não houver nenhuma taxa, o comportamento antigo segue valendo. */
  const desligado = taxas.length === 0;

  return (
    <AppShell>
      <PageHeader
        breadcrumb={['Financeiro', 'Operadoras']}
        title="Operadoras de cartão"
        subtitle="Quanto a maquininha cobra, e em quantos dias o dinheiro cai."
      />

      {erro && (
        <div
          role="alert"
          className="mb-5 px-4 py-3 rounded-[var(--gs-radius)] bg-[var(--gs-danger-bg)] text-[var(--gs-danger)]"
        >
          {erro}
        </div>
      )}
      {aviso && (
        <div className="mb-5 px-4 py-3 rounded-[var(--gs-radius)] bg-[var(--gs-success-bg)] text-[var(--gs-success)]">
          {aviso}
        </div>
      )}

      {/*
        Mudança de comportamento merece aviso: quem cadastra a primeira taxa
        precisa saber o que está ligando, e quem ainda não cadastrou precisa
        saber por que o número do cartão parece otimista.
      */}
      <div
        className={`mb-5 px-4 py-3 rounded-[var(--gs-radius)] text-[length:var(--gs-text-sm)] ${
          desligado ? 'bg-[var(--gs-warning-bg)]' : 'bg-[var(--gs-surface-hover)]'
        }`}
      >
        {desligado ? (
          <>
            <strong>Nenhuma taxa cadastrada.</strong> Enquanto isso, a venda no cartão entra no
            financeiro como dinheiro que já caiu, integral, no dia da venda — o que faz o caixa
            previsto ficar acima do real. Cadastre a taxa e o prazo para o sistema passar a
            registrar o dinheiro na data em que ele realmente entra.
          </>
        ) : (
          <>
            <strong>Ligado.</strong> Vendas no cartão passam a gerar uma parcela a receber por
            vencimento, mais uma linha de despesa com a taxa — que aparece no resultado como
            &ldquo;Taxa de cartão&rdquo;. Vendas anteriores não foram alteradas.
          </>
        )}
      </div>

      <Card title="Operadoras" className="mb-5">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end mb-5">
          <label className="flex flex-col gap-1.5">
            <span className={ROTULO}>Nome</span>
            <Input
              value={novoNome}
              onChange={(e) => setNovoNome(e.target.value)}
              placeholder="Cielo"
            />
          </label>
          <Button
            disabled={salvando || !novoNome.trim()}
            onClick={() =>
              void comSalvamento(async () => {
                await coreApi.createAcquirer({ name: novoNome });
                setNovoNome('');
              }, 'Operadora criada.')
            }
          >
            Adicionar
          </Button>
        </div>

        {operadoras === null ? (
          <p className="text-[var(--gs-text-soft)]">Carregando…</p>
        ) : operadoras.length === 0 ? (
          <EmptyState
            title="Nenhuma operadora"
            description="Cadastre a maquininha que a loja usa: Cielo, Rede, Stone, PagSeguro."
          />
        ) : (
          <div className="flex flex-wrap gap-2">
            {operadoras.map((o) => (
              <span key={o.id} className="flex items-center gap-1">
                <Button
                  variant={o.id === opAberta ? 'primary' : 'secondary'}
                  size="sm"
                  onClick={() => setOpAberta(o.id)}
                >
                  {o.name} ({taxas.filter((t) => t.acquirer_id === o.id).length})
                  {o.active !== 1 && ' · inativa'}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    void comSalvamento(
                      async () => {
                        await coreApi.updateAcquirer(o.id, { active: o.active !== 1 });
                      },
                      o.active === 1 ? 'Operadora desativada.' : 'Operadora reativada.',
                    )
                  }
                >
                  {o.active === 1 ? 'Desativar' : 'Reativar'}
                </Button>
              </span>
            ))}
          </div>
        )}
      </Card>

      {opAberta && (
        <Card
          title="Taxa e prazo"
          subtitle="A operadora cobra diferente por forma e por número de parcelas — por isso cada combinação tem sua linha."
        >
          <div className="grid grid-cols-1 md:grid-cols-5 gap-3 items-end mb-5">
            <label className="flex flex-col gap-1.5">
              <span className={ROTULO}>Forma</span>
              <select
                value={forma}
                onChange={(e) => setForma(e.target.value)}
                className={CAIXA_SELECT}
              >
                {metodos.map((m) => (
                  <option key={m.code} value={m.code}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1.5">
              <span className={ROTULO}>Parcelas</span>
              <Input
                value={parcelas}
                onChange={(e) => setParcelas(e.target.value)}
                inputMode="numeric"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className={ROTULO}>Taxa (%)</span>
              <Input
                value={taxa}
                onChange={(e) => setTaxa(e.target.value)}
                inputMode="decimal"
                placeholder="3,5"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className={ROTULO}>Dias por parcela</span>
              <Input value={dias} onChange={(e) => setDias(e.target.value)} inputMode="numeric" />
            </label>
            <Button
              disabled={salvando || !taxa.trim()}
              onClick={() =>
                void comSalvamento(async () => {
                  await coreApi.setAcquirerRate(opAberta, {
                    paymentMethod: forma,
                    installments: Math.max(1, Number(parcelas) || 1),
                    feeBps: textoParaBps(taxa),
                    settlementDays: Math.max(0, Number(dias) || 0),
                  });
                  setTaxa('');
                }, 'Taxa gravada.')
              }
            >
              Gravar
            </Button>
          </div>

          {taxasDaOperadora.length === 0 ? (
            <EmptyState
              title="Sem taxa cadastrada"
              description="Enquanto não houver, a venda nesta forma continua entrando como quitada no dia."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[length:var(--gs-text-sm)]">
                <thead>
                  <tr className="text-left text-[var(--gs-text-soft)] border-b border-[var(--gs-border)]">
                    <th className={TH}>Forma</th>
                    <th className={`${TH} text-right`}>Parcelas</th>
                    <th className={`${TH} text-right`}>Taxa</th>
                    <th className={`${TH} text-right`}>Cai em</th>
                    <th className={`${TH} text-right`}>Em R$ 100</th>
                    <th className={`${TH} text-right`} />
                  </tr>
                </thead>
                <tbody>
                  {taxasDaOperadora.map((t) => {
                    const liquido = 10_000 - Math.round((10_000 * t.fee_bps) / 10_000);
                    return (
                      <tr key={t.id} className="border-b border-[var(--gs-border)] last:border-0">
                        <td className={TD}>
                          {metodos.find((m) => m.code === t.payment_method)?.label ??
                            t.payment_method}
                        </td>
                        <td className={`${TD} text-right tabular-nums`}>{t.installments}×</td>
                        <td className={`${TD} text-right tabular-nums`}>
                          {bpsParaTexto(t.fee_bps)}%
                        </td>
                        <td className={`${TD} text-right tabular-nums`}>
                          {t.settlement_days === 0 ? (
                            <Badge tone="success">no dia</Badge>
                          ) : (
                            `${t.settlement_days} dia(s)`
                          )}
                          {t.installments > 1 && ' por parcela'}
                        </td>
                        {/* O número que o lojista realmente quer ver. */}
                        <td className={`${TD} text-right tabular-nums font-semibold`}>
                          {formatCents(liquido)}
                        </td>
                        <td className={`${TD} text-right`}>
                          <Button
                            variant="ghost"
                            onClick={() =>
                              void comSalvamento(async () => {
                                await coreApi.removeAcquirerRate(t.id);
                              }, 'Taxa removida.')
                            }
                          >
                            Remover
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
    </AppShell>
  );
}
