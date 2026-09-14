/**
 * Financeiro › Fluxo de caixa (GAP-PRD-094).
 *
 * A pergunta desta tela é a do gestor na segunda-feira: "tenho caixa para
 * pagar o fornecedor dia 20?". Até aqui ela exigia filtrar Contas a receber e
 * Contas a pagar por vencimento e somar de cabeça — nenhuma rota, nenhuma
 * tela juntava as duas com o saldo das contas.
 *
 * O servidor faz a conta (e diz o que ficou de fora dela). A tela escolhe o
 * recorte — 30, 60 ou 90 dias, uma conta ou todas, dia ou semana, o que fazer
 * com os vencidos —, destaca o menor saldo e o primeiro dia negativo, e abre
 * cada período para mostrar QUAIS títulos entram e saem.
 *
 * OS VENCIDOS SÃO ESCOLHA, E A TELA DIZ QUAL. O padrão conta a dívida vencida
 * como saída de hoje e deixa de fora o recebível atrasado: a leitura que não
 * promete dinheiro que já atrasou. Trocar é um clique, e a frase embaixo muda
 * junto.
 */
import { Fragment, useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AppShell } from '@/components/gs/AppShell';
import { Badge, Button, Card, EmptyState, Field, Kpi, PageHeader } from '@/components/gs/ui';
import { formatCents } from '@/components/gs/format';
import { ApiRequestError } from '@/lib/api/client';
import { coreApi, type FinanceAccount } from '@/lib/api/core';
import {
  fluxoDeCaixaApi,
  type FluxoDeCaixa,
  type GranularidadeDoFluxo,
  type VencidosNoFluxo,
} from '@/lib/api/fluxoDeCaixa';
import { destinoDaOrigem } from '@/lib/rotasDeOrigem';
import { dataBR } from '@/lib/datas';

const HORIZONTES = [30, 60, 90] as const;

const VENCIDOS: { valor: VencidosNoFluxo; rotulo: string }[] = [
  { valor: 'payables', rotulo: 'Contar só as contas a pagar vencidas (padrão)' },
  { valor: 'both', rotulo: 'Contar a pagar e a receber vencidos' },
  { valor: 'none', rotulo: 'Não contar os vencidos' },
];

const CAIXA_SELECT =
  'h-11 w-full px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border)] ' +
  'bg-[var(--gs-surface)] text-[length:var(--gs-text-base)] text-[var(--gs-text)]';

function periodo(p: { start: string; end: string }): string {
  return p.start === p.end ? dataBR(p.start) : `${dataBR(p.start)} a ${dataBR(p.end)}`;
}

export default function FluxoDeCaixaPage() {
  const [dias, setDias] = useState<(typeof HORIZONTES)[number]>(30);
  const [contaId, setContaId] = useState('');
  const [granularidade, setGranularidade] = useState<GranularidadeDoFluxo | ''>('');
  const [vencidos, setVencidos] = useState<VencidosNoFluxo>('payables');
  const [contas, setContas] = useState<FinanceAccount[]>([]);
  const [fluxo, setFluxo] = useState<FluxoDeCaixa | null>(null);
  const [aberto, setAberto] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(false);

  useEffect(() => {
    let vivo = true;
    coreApi
      .financeSetup()
      .then((r) => {
        if (vivo) setContas(r.accounts.filter((c) => c.active === 1));
      })
      // A lista de contas é só o seletor; sem ela a projeção de todas as
      // contas continua valendo.
      .catch(() => undefined);
    return () => {
      vivo = false;
    };
  }, []);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro(null);
    try {
      setFluxo(
        await fluxoDeCaixaApi.projetar({
          days: dias,
          accountId: contaId || null,
          granularity: granularidade || undefined,
          overdue: vencidos,
        }),
      );
      setAberto(null);
    } catch (e) {
      setFluxo(null);
      setErro(e instanceof ApiRequestError ? e.message : 'Não foi possível projetar o fluxo de caixa.');
    } finally {
      setCarregando(false);
    }
  }, [dias, contaId, granularidade, vencidos]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  return (
    <AppShell>
      <PageHeader
        breadcrumb={['Financeiro', 'Fluxo de caixa']}
        title="Fluxo de caixa"
        subtitle="O que entra e o que sai nos próximos dias, pelo vencimento de cada conta, e onde o saldo vai parar."
      />

      {erro && (
        <p role="alert" className="px-3 py-2 mb-4 rounded-[var(--gs-radius)] bg-[var(--gs-danger-bg)] text-[var(--gs-danger)] text-[length:var(--gs-text-sm)]">
          {erro}
        </p>
      )}

      <Card title="Recorte" className="mb-5">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 items-end">
          <div className="flex flex-col gap-1.5">
            <span className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-text-soft)]">Horizonte</span>
            <div role="group" aria-label="Horizonte" className="flex gap-2">
              {HORIZONTES.map((h) => (
                <Button
                  key={h}
                  size="sm"
                  variant={dias === h ? 'primary' : 'secondary'}
                  aria-pressed={dias === h}
                  onClick={() => setDias(h)}
                >
                  {h} dias
                </Button>
              ))}
            </div>
          </div>
          <Field label="Conta">
            {(p) => (
              <select {...p} value={contaId} onChange={(e) => setContaId(e.target.value)} className={CAIXA_SELECT}>
                <option value="">Todas as contas</option>
                {contas.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Agrupar por">
            {(p) => (
              <select
                {...p}
                value={granularidade}
                onChange={(e) => setGranularidade(e.target.value as GranularidadeDoFluxo | '')}
                className={CAIXA_SELECT}
              >
                <option value="">Automático (dia até 31 dias, semana acima)</option>
                <option value="day">Dia</option>
                <option value="week">Semana</option>
              </select>
            )}
          </Field>
          <Field label="Vencidos em aberto">
            {(p) => (
              <select
                {...p}
                value={vencidos}
                onChange={(e) => setVencidos(e.target.value as VencidosNoFluxo)}
                className={CAIXA_SELECT}
              >
                {VENCIDOS.map((v) => (
                  <option key={v.valor} value={v.valor}>
                    {v.rotulo}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </div>
      </Card>

      {carregando && !fluxo && <p className="text-[var(--gs-text-soft)]">Projetando…</p>}

      {fluxo && (
        <>
          {fluxo.firstNegativeDate ? (
            <p
              role="alert"
              className="px-4 py-3 mb-5 rounded-[var(--gs-radius)] bg-[var(--gs-danger-bg)] text-[var(--gs-danger)] font-semibold"
            >
              O saldo projetado fica negativo em {dataBR(fluxo.firstNegativeDate)}. O menor saldo do período é{' '}
              {formatCents(fluxo.lowestBalance.cents)}, em {dataBR(fluxo.lowestBalance.date)}.
            </p>
          ) : (
            <p
              role="status"
              className="px-4 py-3 mb-5 rounded-[var(--gs-radius)] bg-[var(--gs-success-bg)] text-[var(--gs-success)] font-semibold"
            >
              O saldo projetado não fica negativo até {dataBR(fluxo.to)}. O menor saldo do período é{' '}
              {formatCents(fluxo.lowestBalance.cents)}, em {dataBR(fluxo.lowestBalance.date)}.
            </p>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-5">
            <Kpi
              label={fluxo.account ? `Saldo de hoje — ${fluxo.account.name}` : 'Saldo de hoje'}
              value={formatCents(fluxo.openingBalanceCents)}
              hint={
                fluxo.account
                  ? 'Partida da conta + o que já foi quitado por ela'
                  : `${fluxo.accountsConsidered} conta(s) cadastrada(s)`
              }
            />
            <Kpi label="Entra no período" value={formatCents(fluxo.totals.inCents)} tone="positive" hint="A receber, pelo vencimento" />
            <Kpi label="Sai no período" value={formatCents(fluxo.totals.outCents)} tone="warning" hint="A pagar, pelo vencimento" />
            <Kpi
              label={`Saldo em ${dataBR(fluxo.to)}`}
              value={formatCents(fluxo.closingBalanceCents)}
              tone={fluxo.closingBalanceCents < 0 ? 'warning' : 'neutral'}
              hint="Projetado"
            />
          </div>

          {fluxo.overdue.count > 0 && (
            <Card title="Vencidos em aberto" className="mb-5">
              <p className="m-0 text-[length:var(--gs-text-sm)]">
                {fluxo.overdue.count} título(s) já venceram e continuam em aberto:{' '}
                <strong>{formatCents(fluxo.overdue.outCents)}</strong> a pagar e{' '}
                <strong>{formatCents(fluxo.overdue.inCents)}</strong> a receber.{' '}
                {fluxo.overdueMode === 'payables' &&
                  'A projeção conta a dívida vencida como saída de hoje e deixa de fora o recebível atrasado.'}
                {fluxo.overdueMode === 'both' &&
                  'A projeção conta os dois como se fossem acertados hoje.'}
                {fluxo.overdueMode === 'none' && 'A projeção não conta nenhum dos dois.'}{' '}
                <Link
                  to="/sistema/financeiro/contas-a-receber"
                  className="text-[var(--gs-purple-700)] font-semibold underline"
                >
                  Cobrar os atrasados
                </Link>
              </p>
            </Card>
          )}

          <Card
            title={fluxo.granularity === 'day' ? 'Dia a dia' : 'Semana a semana'}
            subtitle={`De ${dataBR(fluxo.from)} a ${dataBR(fluxo.to)}. Abra um período para ver o que entra e o que sai.`}
            className="mb-5"
          >
            {fluxo.totals.inCents === 0 && fluxo.totals.outCents === 0 ? (
              <EmptyState
                title="Nada vence no período"
                description="Nenhuma conta a receber ou a pagar em aberto vence neste recorte. O saldo fica como está."
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-[length:var(--gs-text-sm)] border-collapse" aria-label="Fluxo por período">
                  <thead>
                    <tr className="text-left text-[var(--gs-text-soft)] border-b border-[var(--gs-border)]">
                      <th className="py-2.5 px-3">Período</th>
                      <th className="py-2.5 px-3 text-right">Entra</th>
                      <th className="py-2.5 px-3 text-right">Sai</th>
                      <th className="py-2.5 px-3 text-right">Líquido</th>
                      <th className="py-2.5 px-3 text-right">Saldo projetado</th>
                      <th className="py-2.5 px-3" />
                    </tr>
                  </thead>
                  <tbody>
                    {fluxo.periods.map((p) => (
                      <Fragment key={p.start}>
                        <tr className="border-b border-[var(--gs-border)]">
                          <td className="py-2 px-3">{periodo(p)}</td>
                          <td className="py-2 px-3 text-right tabular-nums">
                            {p.inCents ? formatCents(p.inCents) : '—'}
                          </td>
                          <td className="py-2 px-3 text-right tabular-nums">
                            {p.outCents ? formatCents(p.outCents) : '—'}
                          </td>
                          <td className="py-2 px-3 text-right tabular-nums">{p.count ? formatCents(p.netCents) : '—'}</td>
                          <td
                            className={`py-2 px-3 text-right tabular-nums font-semibold ${
                              p.balanceCents < 0 ? 'text-[var(--gs-danger)]' : ''
                            }`}
                          >
                            {formatCents(p.balanceCents)}
                          </td>
                          <td className="py-2 px-3 text-right">
                            {p.count > 0 && (
                              <Button
                                size="sm"
                                variant="ghost"
                                aria-expanded={aberto === p.start}
                                aria-label={`Ver os títulos de ${periodo(p)}`}
                                onClick={() => setAberto(aberto === p.start ? null : p.start)}
                              >
                                {p.count} título(s)
                              </Button>
                            )}
                          </td>
                        </tr>
                        {aberto === p.start && (
                          <tr>
                            <td colSpan={6} className="py-2 px-3 bg-[var(--gs-canvas)]">
                              <ul className="list-none m-0 p-0 flex flex-col gap-1">
                                {p.items.map((i) => {
                                  const destino = destinoDaOrigem(i.originType, i.originId);
                                  return (
                                    <li key={i.id} className="flex flex-wrap items-center gap-2">
                                      <Badge tone={i.direction === 'in' ? 'success' : 'warning'}>
                                        {i.direction === 'in' ? 'entra' : 'sai'}
                                      </Badge>
                                      <span>{i.dueDate ? dataBR(i.dueDate) : ''}</span>
                                      <span className="font-semibold">{i.description}</span>
                                      {i.counterpartyName && (
                                        <span className="text-[var(--gs-muted)]">· {i.counterpartyName}</span>
                                      )}
                                      <span className="tabular-nums">{formatCents(i.balanceCents)}</span>
                                      {destino && (
                                        <Link to={destino} className="text-[var(--gs-purple-700)] underline">
                                          abrir a origem
                                        </Link>
                                      )}
                                    </li>
                                  );
                                })}
                                {p.count > p.items.length && (
                                  <li className="text-[var(--gs-muted)]">
                                    … e mais {p.count - p.items.length} título(s) — veja em Contas a receber/pagar.
                                  </li>
                                )}
                              </ul>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          {fluxo.caveats.length > 0 && (
            <Card title="O que esta projeção não conta" className="mb-5">
              <ul className="m-0 pl-5 flex flex-col gap-1 text-[length:var(--gs-text-sm)]">
                {fluxo.caveats.map((c) => (
                  <li key={c}>{c}</li>
                ))}
                {fluxo.beyond.count > 0 && (
                  <li>
                    Depois de {dataBR(fluxo.to)} ainda vencem {fluxo.beyond.count} título(s):{' '}
                    {formatCents(fluxo.beyond.inCents)} a receber e {formatCents(fluxo.beyond.outCents)} a pagar.
                  </li>
                )}
              </ul>
            </Card>
          )}
        </>
      )}
    </AppShell>
  );
}
