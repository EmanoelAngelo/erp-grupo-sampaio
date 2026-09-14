/**
 * Comissões — regra, vínculo e apuração.
 *
 * ## O que esta tela mostra e o Painel não
 *
 * O card "Vendas por vendedor" do Painel soma faturamento BRUTO de vendas
 * concluídas, sem descontar devolução. Esta tela mostra o LÍQUIDO
 * comissionável. Os dois números não batem, e isso é de propósito — se
 * ninguém disser isso em algum lugar, alguém vai "consertar" um dos dois para
 * bater com o outro.
 *
 * ## O balde
 *
 * Venda de vendedor sem grupo, ou cujo valor não alcança faixa nenhuma, não
 * gera comissão. Ela aparece contada e somada num card à parte, em vez de
 * sumir — apuração que esconde o que não entrou dá a impressão de estar
 * completa quando metade da loja ficou de fora.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppShell } from '@/components/gs/AppShell';
import { Badge, Button, Card, EmptyState, Input, Kpi, PageHeader } from '@/components/gs/ui';
import { formatCents, parseReaisToCents } from '@/components/gs/format';
import { ApiRequestError } from '@/lib/api/client';
import {
  coreApi,
  type CommissionGroup,
  type CommissionSummaryRow,
  type TeamMember,
} from '@/lib/api/core';
import { hojeNaLoja } from '@/lib/datas';
import { useSearchParams } from 'react-router-dom';
import { FechamentosDeComissao } from '@/components/gs/FechamentosDeComissao';
import { PARAM_DO_FECHAMENTO } from '@/lib/rotasDeOrigem';

const ROTULO = 'text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-text-soft)]';
const TH = 'py-2.5 px-4 font-semibold';
const TD = 'py-3 px-4';
const CAIXA_SELECT =
  'h-10 px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)] ' +
  'bg-[var(--gs-surface)] text-[var(--gs-text)] text-[length:var(--gs-text-base)]';

type Aba = 'regras' | 'vendedores' | 'apuracao' | 'fechamentos';

const ABAS: { id: Aba; label: string }[] = [
  { id: 'regras', label: 'Grupos e faixas' },
  { id: 'vendedores', label: 'Vendedores' },
  { id: 'apuracao', label: 'Apuração' },
  // O histórico que o fechamento gravava e nenhuma tela lia (GAP-PRD-174).
  { id: 'fechamentos', label: 'Fechamentos' },
];

/** Basis points para texto: 250 vira "2,5". */
function bpsParaTexto(bps: number): string {
  return String(bps / 100).replace('.', ',');
}

/** "2,5" vira 250. Percentual em basis points evita erro de arredondamento. */
function textoParaBps(texto: string): number {
  const n = Number(texto.replace(',', '.'));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : 0;
}

function primeiroDiaDoMes(): string {
  return `${new Date().toISOString().slice(0, 7)}-01`;
}

export default function ComissoesPage() {
  // Quem chega pelo título da comissão no contas a pagar
  // (`?fechamento=<id>`) cai direto no fechamento que o gerou.
  const [params] = useSearchParams();
  const [aba, setAba] = useState<Aba>(params.get(PARAM_DO_FECHAMENTO) ? 'fechamentos' : 'regras');
  const [grupos, setGrupos] = useState<CommissionGroup[] | null>(null);
  const [membros, setMembros] = useState<Record<string, string>>({});
  const [equipe, setEquipe] = useState<TeamMember[]>([]);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);

  const [novoGrupo, setNovoGrupo] = useState('');
  const [grupoAberto, setGrupoAberto] = useState<string>('');
  const [faixaMin, setFaixaMin] = useState('');
  const [faixaPct, setFaixaPct] = useState('');

  const [de, setDe] = useState(primeiroDiaDoMes());
  const [ate, setAte] = useState(hojeNaLoja());
  const [resumo, setResumo] = useState<{
    rows: CommissionSummaryRow[];
    semComissao: { vendas: number; totalCents: number };
  } | null>(null);
  const [vencimento, setVencimento] = useState('');

  const carregar = useCallback(async () => {
    setErro(null);
    try {
      const [setup, time] = await Promise.all([coreApi.commissionSetup(), coreApi.listTeam()]);
      setGrupos(setup.groups);
      setMembros(Object.fromEntries(setup.members.map((m) => [m.user_id, m.group_id])));
      setEquipe(time.filter((p) => p.active));
    } catch (e) {
      setErro(e instanceof ApiRequestError ? e.message : 'Não foi possível carregar.');
      setGrupos([]);
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const carregarResumo = useCallback(async () => {
    setErro(null);
    try {
      setResumo(await coreApi.commissionSummary(de, ate));
    } catch (e) {
      setErro(e instanceof ApiRequestError ? e.message : 'Não foi possível apurar.');
      setResumo(null);
    }
  }, [de, ate]);

  useEffect(() => {
    if (aba === 'apuracao') void carregarResumo();
  }, [aba, carregarResumo]);

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

  const grupoSelecionado = useMemo(
    () => (grupos ?? []).find((g) => g.id === grupoAberto) ?? null,
    [grupos, grupoAberto],
  );

  return (
    <AppShell>
      <PageHeader
        breadcrumb={['Financeiro', 'Comissões']}
        title="Comissões"
        subtitle="O percentual vigente é congelado no momento da venda: mudar a regra hoje não altera o que já foi apurado."
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

      <div
        role="tablist"
        aria-label="Comissões"
        className="flex gap-1 p-1 bg-[var(--gs-surface-hover)] rounded-[var(--gs-radius)] mb-5 max-w-2xl"
      >
        {ABAS.map((a) => (
          <button
            key={a.id}
            role="tab"
            type="button"
            aria-selected={aba === a.id}
            onClick={() => {
              setAba(a.id);
              setErro(null);
              setAviso(null);
            }}
            className={`flex-1 px-3 py-2 rounded-[var(--gs-radius-sm)] border-0 cursor-pointer
              text-[length:var(--gs-text-sm)] font-semibold ${
                aba === a.id
                  ? 'bg-[var(--gs-surface)] text-[var(--gs-purple-800)] shadow-[var(--gs-shadow-sm)]'
                  : 'bg-transparent text-[var(--gs-muted)]'
              }`}
          >
            {a.label}
          </button>
        ))}
      </div>

      {aba === 'regras' && (
        <>
          <Card
            title="Grupos"
            subtitle="A faixa é por valor DA VENDA, não por acumulado do mês — meta mensal tornaria toda apuração retroativa."
            className="mb-5"
          >
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end mb-5">
              <label className="flex flex-col gap-1.5">
                <span className={ROTULO}>Nome do grupo</span>
                <Input
                  value={novoGrupo}
                  onChange={(e) => setNovoGrupo(e.target.value)}
                  placeholder="Loja"
                />
              </label>
              <Button
                disabled={salvando || !novoGrupo.trim()}
                onClick={() =>
                  void comSalvamento(async () => {
                    await coreApi.createCommissionGroup(novoGrupo);
                    setNovoGrupo('');
                  }, 'Grupo criado.')
                }
              >
                Adicionar grupo
              </Button>
            </div>

            {grupos === null ? (
              <p className="text-[var(--gs-text-soft)]">Carregando…</p>
            ) : grupos.length === 0 ? (
              <EmptyState
                title="Nenhum grupo"
                description="Crie um grupo e defina as faixas de percentual."
              />
            ) : (
              <div className="flex flex-wrap gap-2">
                {grupos.map((g) => (
                  <span key={g.id} className="flex items-center gap-1">
                    <Button
                      variant={g.id === grupoAberto ? 'primary' : 'secondary'}
                      size="sm"
                      onClick={() => setGrupoAberto(g.id)}
                    >
                      {g.name} ({g.tiers.length})
                      {g.active !== 1 && ' · inativo'}
                    </Button>
                    {/* Desativar não apaga: as linhas já apuradas apontam para
                        faixas deste grupo, e o histórico precisa continuar
                        explicável. Inativo apenas para de comissionar. */}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        void comSalvamento(
                          async () => {
                            await coreApi.updateCommissionGroup(g.id, { active: g.active !== 1 });
                          },
                          g.active === 1 ? 'Grupo desativado.' : 'Grupo reativado.',
                        )
                      }
                    >
                      {g.active === 1 ? 'Desativar' : 'Reativar'}
                    </Button>
                  </span>
                ))}
              </div>
            )}
          </Card>

          {grupoSelecionado && (
            <Card title={`Faixas de ${grupoSelecionado.name}`}>
              <div className="grid grid-cols-1 md:grid-cols-4 gap-3 items-end mb-5">
                <label className="flex flex-col gap-1.5">
                  <span className={ROTULO}>A partir de</span>
                  <Input
                    value={faixaMin}
                    onChange={(e) => setFaixaMin(e.target.value)}
                    inputMode="decimal"
                    placeholder="0,00"
                  />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className={ROTULO}>Paga (%)</span>
                  <Input
                    value={faixaPct}
                    onChange={(e) => setFaixaPct(e.target.value)}
                    inputMode="decimal"
                    placeholder="2,5"
                  />
                </label>
                <Button
                  disabled={salvando || !faixaPct.trim()}
                  onClick={() =>
                    void comSalvamento(async () => {
                      await coreApi.setCommissionTier(
                        grupoSelecionado.id,
                        faixaMin.trim() ? (parseReaisToCents(faixaMin) ?? 0) : 0,
                        textoParaBps(faixaPct),
                      );
                      setFaixaMin('');
                      setFaixaPct('');
                    }, 'Faixa gravada.')
                  }
                >
                  Gravar faixa
                </Button>
              </div>

              {/*
                Sem faixa a partir de zero, venda pequena não comissiona nada —
                e quem cadastrou não fica sabendo até o vendedor reclamar.
              */}
              {grupoSelecionado.tiers.length > 0 &&
                !grupoSelecionado.tiers.some((t) => t.min_cents === 0) && (
                  <div className="mb-4 px-4 py-3 rounded-[var(--gs-radius)] bg-[var(--gs-warning-bg)] text-[length:var(--gs-text-sm)]">
                    Não há faixa a partir de R$ 0,00: vendas abaixo de{' '}
                    <strong>
                      {formatCents(Math.min(...grupoSelecionado.tiers.map((t) => t.min_cents)))}
                    </strong>{' '}
                    não vão gerar comissão nenhuma.
                  </div>
                )}

              {grupoSelecionado.tiers.length === 0 ? (
                <EmptyState
                  title="Sem faixa"
                  description="Enquanto não houver faixa, este grupo não gera comissão."
                />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-[length:var(--gs-text-sm)]">
                    <thead>
                      <tr className="text-left text-[var(--gs-text-soft)] border-b border-[var(--gs-border)]">
                        <th className={TH}>A partir de</th>
                        <th className={`${TH} text-right`}>Percentual</th>
                        <th className={`${TH} text-right`} />
                      </tr>
                    </thead>
                    <tbody>
                      {grupoSelecionado.tiers.map((t) => (
                        <tr key={t.id} className="border-b border-[var(--gs-border)] last:border-0">
                          <td className={TD}>{formatCents(t.min_cents)}</td>
                          <td className={`${TD} text-right tabular-nums`}>
                            {bpsParaTexto(t.rate_bps)}%
                          </td>
                          <td className={`${TD} text-right`}>
                            <Button
                              variant="ghost"
                              onClick={() =>
                                void comSalvamento(async () => {
                                  await coreApi.removeCommissionTier(t.id);
                                }, 'Faixa removida.')
                              }
                            >
                              Remover
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          )}
        </>
      )}

      {aba === 'vendedores' && (
        <Card
          title="Quem comissiona"
          subtitle="Comissão não é perfil: qualquer pessoa da operação pode entrar num grupo."
        >
          {equipe.length === 0 ? (
            <EmptyState title="Nenhuma pessoa" description="Cadastre a equipe em Configurações." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[length:var(--gs-text-sm)]">
                <thead>
                  <tr className="text-left text-[var(--gs-text-soft)] border-b border-[var(--gs-border)]">
                    <th className={TH}>Pessoa</th>
                    <th className={TH}>Perfil</th>
                    <th className={TH}>Grupo de comissão</th>
                  </tr>
                </thead>
                <tbody>
                  {equipe.map((p) => (
                    <tr key={p.id} className="border-b border-[var(--gs-border)] last:border-0">
                      <td className={TD}>{p.displayName}</td>
                      <td className={`${TD} text-[var(--gs-text-soft)]`}>{p.profileCode}</td>
                      <td className={TD}>
                        <select
                          value={membros[p.id] ?? ''}
                          onChange={(e) =>
                            void comSalvamento(async () => {
                              await coreApi.setCommissionMember(p.id, e.target.value || null);
                            }, 'Vínculo atualizado.')
                          }
                          aria-label={`Grupo de comissão de ${p.displayName}`}
                          className={CAIXA_SELECT}
                        >
                          <option value="">Não comissiona</option>
                          {(grupos ?? []).map((g) => (
                            <option key={g.id} value={g.id}>
                              {g.name}
                            </option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {aba === 'apuracao' && (
        <>
          <Card title="Período" className="mb-5">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
              <label className="flex flex-col gap-1.5">
                <span className={ROTULO}>De</span>
                <Input type="date" value={de} onChange={(e) => setDe(e.target.value)} />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className={ROTULO}>Até</span>
                <Input type="date" value={ate} onChange={(e) => setAte(e.target.value)} />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className={ROTULO}>Vencimento do pagamento</span>
                <Input
                  type="date"
                  value={vencimento}
                  onChange={(e) => setVencimento(e.target.value)}
                />
              </label>
              <Button variant="secondary" onClick={() => void carregarResumo()}>
                Apurar
              </Button>
            </div>
          </Card>

          {resumo && (
            <>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-5">
                <Kpi
                  label="Apurado"
                  value={formatCents(resumo.rows.reduce((t, r) => t + r.apuradoCents, 0))}
                />
                <Kpi
                  label="Estornado"
                  value={formatCents(resumo.rows.reduce((t, r) => t + r.estornadoCents, 0))}
                  tone="warning"
                />
                <Kpi
                  label="A pagar"
                  value={formatCents(resumo.rows.reduce((t, r) => t + r.saldoCents, 0))}
                  tone="positive"
                />
              </div>

              <Card title="Por vendedor" className="mb-5">
                {resumo.rows.length === 0 ? (
                  <EmptyState
                    title="Nada apurado no período"
                    description="Vendas só geram comissão depois que o vendedor entra num grupo com faixa."
                  />
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-[length:var(--gs-text-sm)]">
                      <thead>
                        <tr className="text-left text-[var(--gs-text-soft)] border-b border-[var(--gs-border)]">
                          <th className={TH}>Vendedor</th>
                          <th className={`${TH} text-right`}>Apurado</th>
                          <th className={`${TH} text-right`}>Estornado</th>
                          <th className={`${TH} text-right`}>A pagar</th>
                          <th className={`${TH} text-right`} />
                        </tr>
                      </thead>
                      <tbody>
                        {resumo.rows.map((r) => (
                          <tr
                            key={r.sellerId}
                            className="border-b border-[var(--gs-border)] last:border-0"
                          >
                            <td className={TD}>
                              {r.sellerName ?? <Badge tone="warning">pessoa removida</Badge>}
                            </td>
                            <td className={`${TD} text-right tabular-nums`}>
                              {formatCents(r.apuradoCents)}
                            </td>
                            <td className={`${TD} text-right tabular-nums text-[var(--gs-warning)]`}>
                              {r.estornadoCents > 0 ? `−${formatCents(r.estornadoCents)}` : '—'}
                            </td>
                            <td className={`${TD} text-right tabular-nums font-semibold`}>
                              {formatCents(r.saldoCents)}
                            </td>
                            <td className={`${TD} text-right`}>
                              {r.aberto > 0 ? (
                                <Button
                                  variant="ghost"
                                  onClick={() =>
                                    void comSalvamento(async () => {
                                      const res = await coreApi.closeCommission({
                                        sellerId: r.sellerId,
                                        from: de,
                                        to: ate,
                                        dueDate: vencimento || null,
                                      });
                                      setAviso(
                                        res.financeEntryId
                                          ? `Período fechado: ${formatCents(res.totalCents)} lançados em contas a pagar.`
                                          : 'Período fechado. Saldo zero ou negativo não gera conta a pagar.',
                                      );
                                      await carregarResumo();
                                    }, 'Período fechado.')
                                  }
                                >
                                  Fechar e gerar a pagar
                                </Button>
                              ) : (
                                <Badge tone="success">fechado</Badge>
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
                O BALDE. Sem ele, apuração incompleta parece completa.
              */}
              {resumo.semComissao.vendas > 0 && (
                <Card title="Vendas sem comissão no período">
                  <p className="m-0 text-[length:var(--gs-text-sm)]">
                    <strong>{resumo.semComissao.vendas}</strong> venda(s), somando{' '}
                    <strong>{formatCents(resumo.semComissao.totalCents)}</strong>, não geraram
                    comissão — o vendedor não está em nenhum grupo, ou o valor não alcançou
                    faixa nenhuma.
                  </p>
                </Card>
              )}

              <p className="mt-5 mb-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                O card <strong>Vendas por vendedor</strong> do Painel mostra faturamento bruto e
                não desconta devolução. Esta tela mostra o líquido comissionável. Os dois números
                não batem de propósito.
              </p>
            </>
          )}
        </>
      )}

      {aba === 'fechamentos' && <FechamentosDeComissao />}
    </AppShell>
  );
}
