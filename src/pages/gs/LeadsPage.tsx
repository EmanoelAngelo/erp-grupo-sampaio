/**
 * CRM › Leads e oportunidades.
 *
 * LEAD NÃO É CLIENTE, e a tela existe organizada em torno disso.
 *
 * Quem entra aqui é contato: pediu preço no Instagram, deixou telefone na
 * loja, mandou mensagem. Não comprou. Guardar essa gente no cadastro de
 * clientes inflaria toda conta feita por cliente — quantos clientes a loja tem,
 * ticket médio, taxa de recompra —, e o estrago não aparece como erro: aparece
 * como um ticket médio que caiu sem motivo.
 *
 * Quando compra, o botão "Virou cliente" faz a conversão, e ela aponta para o
 * cadastro que já existe quando a pessoa já é conhecida.
 *
 * O VALOR DA OPORTUNIDADE É ESTIMATIVA. A tela repete isso onde o número
 * aparece, porque soma de previsão parece faturamento e não é.
 */
import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/gs/AppShell';
import { usePedirMotivo } from '@/components/gs/PerguntaDaTela';
import { Badge, Button, Card, EmptyState, Field, Input, PageHeader } from '@/components/gs/ui';
import { ApiRequestError } from '@/lib/api/client';
import {
  coreApi,
  type CrmSummary,
  type Lead,
  type LeadStatus,
  type Opportunity,
} from '@/lib/api/core';

function formatCents(cents: number): string {
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

const TOM_LEAD: Record<LeadStatus, 'neutral' | 'info' | 'warning' | 'success' | 'danger'> = {
  novo: 'neutral',
  em_contato: 'info',
  qualificado: 'warning',
  convertido: 'success',
  perdido: 'danger',
};

const ROTULO_LEAD: Record<LeadStatus, string> = {
  novo: 'Novo',
  em_contato: 'Em contato',
  qualificado: 'Qualificado',
  convertido: 'Virou cliente',
  perdido: 'Perdido',
};

/** Situações que o operador escolhe. Convertido tem caminho próprio. */
const SITUACOES: LeadStatus[] = ['novo', 'em_contato', 'qualificado'];

export default function LeadsPage() {
  // As perguntas da tela no lugar de window.prompt/confirm (GAP-PRD-158).
  const { pedirMotivo, dialogoDeMotivo } = usePedirMotivo();
  const [leads, setLeads] = useState<Lead[] | null>(null);
  const [oportunidades, setOportunidades] = useState<Opportunity[] | null>(null);
  const [resumo, setResumo] = useState<CrmSummary | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  const [nome, setNome] = useState('');
  const [telefone, setTelefone] = useState('');
  const [documento, setDocumento] = useState('');
  const [origem, setOrigem] = useState('');
  const [salvando, setSalvando] = useState(false);

  const [oppDe, setOppDe] = useState<Lead | null>(null);
  const [oppTitulo, setOppTitulo] = useState('');
  const [oppValor, setOppValor] = useState('');

  const carregar = useCallback(async () => {
    setErro(null);
    try {
      setLeads(await coreApi.listLeads());
      setOportunidades(await coreApi.listOpportunities());
      setResumo(await coreApi.crmSummary());
    } catch (err) {
      setLeads(null);
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao carregar o CRM.');
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const criar = async () => {
    setSalvando(true);
    setErro(null);
    setAviso(null);
    try {
      await coreApi.createLead({
        name: nome,
        phone: telefone || null,
        document: documento || null,
        source: origem || null,
      });
      setNome('');
      setTelefone('');
      setDocumento('');
      setOrigem('');
      setAviso('Lead registrado. Ele não entra no cadastro de clientes até comprar.');
      await carregar();
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao registrar o lead.');
    } finally {
      setSalvando(false);
    }
  };

  const mudarSituacao = async (lead: Lead, status: LeadStatus) => {
    setErro(null);
    try {
      await coreApi.updateLeadStatus(lead.id, status);
      await carregar();
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao mudar a situação.');
    }
  };

  const perder = async (lead: Lead) => {
    const motivo = await pedirMotivo({
      titulo: 'Marcar este lead como perdido?',
      rotulo: 'Por que este lead foi perdido?',
      confirmar: 'Marcar como perdido',
      perigoso: true,
    });
    if (!motivo) return;
    setErro(null);
    try {
      await coreApi.updateLeadStatus(lead.id, 'perdido', motivo);
      await carregar();
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao registrar a perda.');
    }
  };

  const converter = async (lead: Lead) => {
    setErro(null);
    setAviso(null);
    try {
      const res = await coreApi.convertLead(lead.id);
      setAviso(
        res.reusedExisting
          ? `${lead.name} já era cliente — o lead foi ligado ao cadastro existente, sem duplicar.`
          : `${lead.name} virou cliente.`,
      );
      await carregar();
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao converter.');
    }
  };

  const criarOportunidade = async () => {
    if (!oppDe) return;
    setErro(null);
    try {
      await coreApi.createOpportunity({
        leadId: oppDe.id,
        title: oppTitulo,
        amountCents: Math.round((Number(oppValor) || 0) * 100),
      });
      setOppDe(null);
      setOppTitulo('');
      setOppValor('');
      await carregar();
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao criar a oportunidade.');
    }
  };

  const fechar = async (opp: Opportunity, status: 'ganha' | 'perdida') => {
    setErro(null);
    try {
      if (status === 'perdida') {
        const motivo = await pedirMotivo({
          titulo: 'Encerrar esta oportunidade como perdida?',
          rotulo: 'Por que foi perdida?',
          confirmar: 'Encerrar como perdida',
          perigoso: true,
        });
        if (!motivo) return;
        await coreApi.closeOpportunity(opp.id, 'perdida', { lostReason: motivo });
      } else {
        await coreApi.closeOpportunity(opp.id, 'ganha');
      }
      await carregar();
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao encerrar.');
    }
  };

  return (
    <AppShell>
      {dialogoDeMotivo}
      <PageHeader
        breadcrumb={['CRM', 'Leads']}
        title="Leads e oportunidades"
        subtitle="Contato que ainda não comprou. Vira cliente na conversão — e só aí entra no cadastro."
      />

      {erro && (
        <p role="alert" className="text-[var(--gs-danger)] text-[length:var(--gs-text-sm)]">
          {erro}
        </p>
      )}
      {aviso && <p className="text-[var(--gs-success)] text-[length:var(--gs-text-sm)]">{aviso}</p>}

      {resumo && (
        <Card title="Funil">
          <div className="grid gap-4 sm:grid-cols-4">
            <div>
              <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">Em aberto</p>
              <p className="m-0 text-[length:var(--gs-text-lg)] font-bold">
                {resumo.leads.novo + resumo.leads.em_contato + resumo.leads.qualificado}
              </p>
            </div>
            <div>
              <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">Viraram cliente</p>
              <p className="m-0 text-[length:var(--gs-text-lg)] font-bold">{resumo.leads.convertido}</p>
            </div>
            <div>
              <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">Perdidos</p>
              <p className="m-0 text-[length:var(--gs-text-lg)] font-bold">{resumo.leads.perdido}</p>
            </div>
            <div>
              {/*
                Rotulado como estimado onde o número aparece: soma de previsão
                parece faturamento, e não é.
              */}
              <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                Em negociação (estimado)
              </p>
              <p className="m-0 text-[length:var(--gs-text-lg)] font-bold">
                {formatCents(resumo.opportunities.abertoEstimadoCents)}
              </p>
            </div>
          </div>
          <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] m-0">
            O valor em negociação é estimativa — não entra no financeiro nem conta como
            faturamento.
          </p>
        </Card>
      )}

      <Card title="Novo lead">
        <div className="grid gap-4 md:grid-cols-4">
          <Field label="Nome" required>
            {(p) => <Input {...p} value={nome} onChange={(e) => setNome(e.target.value)} />}
          </Field>
          <Field label="Telefone">
            {(p) => (
              <Input {...p} value={telefone} onChange={(e) => setTelefone(e.target.value)} />
            )}
          </Field>
          <Field label="CPF/CNPJ" hint="Permite reaproveitar o cadastro se já for cliente">
            {(p) => (
              <Input {...p} value={documento} onChange={(e) => setDocumento(e.target.value)} />
            )}
          </Field>
          <Field label="Origem">
            {(p) => (
              <Input
                {...p}
                value={origem}
                onChange={(e) => setOrigem(e.target.value)}
                placeholder="Instagram, indicação, balcão…"
              />
            )}
          </Field>
        </div>
        <Button
          onClick={() => void criar()}
          loading={salvando}
          disabled={!nome.trim()}
          className="mt-3"
        >
          Registrar lead
        </Button>
      </Card>

      {oppDe && (
        <Card title={`Nova oportunidade — ${oppDe.name}`}>
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="O que está sendo negociado" required>
              {(p) => (
                <Input
                  {...p}
                  value={oppTitulo}
                  onChange={(e) => setOppTitulo(e.target.value)}
                  placeholder="Kit completo, 3 peças…"
                />
              )}
            </Field>
            <Field label="Valor estimado (R$)" hint="Estimativa — não é receita">
              {(p) => (
                <Input
                  {...p}
                  type="number"
                  min={0}
                  step="0.01"
                  value={oppValor}
                  onChange={(e) => setOppValor(e.target.value)}
                />
              )}
            </Field>
          </div>
          <div className="flex gap-2 mt-3">
            <Button onClick={() => void criarOportunidade()} disabled={!oppTitulo.trim()}>
              Criar
            </Button>
            <Button variant="ghost" onClick={() => setOppDe(null)}>
              Cancelar
            </Button>
          </div>
        </Card>
      )}

      <Card title="Leads">
        {leads === null ? (
          <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">Carregando…</p>
        ) : leads.length === 0 ? (
          <EmptyState
            title="Nenhum lead"
            description="Registre quem demonstrou interesse. Só entra no cadastro de clientes quando comprar."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[length:var(--gs-text-sm)] border-collapse">
              <thead>
                <tr className="text-left text-[var(--gs-muted)]">
                  <th className="py-2">Nome</th>
                  <th className="py-2">Contato</th>
                  <th className="py-2">Origem</th>
                  <th className="py-2">Situação</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {leads.map((l) => (
                  <tr key={l.id} className="border-t border-[var(--gs-border)]">
                    <td className="py-2">
                      {l.name}
                      {l.customer_name && (
                        <span className="text-[var(--gs-muted)]"> · cliente {l.customer_name}</span>
                      )}
                    </td>
                    <td className="py-2">{l.phone ?? l.email ?? '—'}</td>
                    <td className="py-2">{l.source ?? '—'}</td>
                    <td className="py-2">
                      <Badge tone={TOM_LEAD[l.status]}>{ROTULO_LEAD[l.status]}</Badge>
                      {l.lost_reason && (
                        <span className="text-[var(--gs-muted)]"> · {l.lost_reason}</span>
                      )}
                    </td>
                    <td className="py-2 text-right whitespace-nowrap">
                      {l.status !== 'convertido' && l.status !== 'perdido' && (
                        <>
                          <select
                            value={l.status}
                            onChange={(e) => void mudarSituacao(l, e.target.value as LeadStatus)}
                            aria-label={`Situação de ${l.name}`}
                            className="rounded-[var(--gs-radius)] border border-[var(--gs-border)]
                              bg-[var(--gs-surface)] px-2 py-1 mr-2"
                          >
                            {SITUACOES.map((s) => (
                              <option key={s} value={s}>
                                {ROTULO_LEAD[s]}
                              </option>
                            ))}
                          </select>
                          <Button size="sm" variant="ghost" onClick={() => setOppDe(l)}>
                            Oportunidade
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => void converter(l)}>
                            Virou cliente
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => void perder(l)}>
                            Perdi
                          </Button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Oportunidades">
        {oportunidades === null || oportunidades.length === 0 ? (
          <EmptyState
            title="Nenhuma oportunidade"
            description="Registre o que está em negociação. O valor é estimativa e não entra no financeiro."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[length:var(--gs-text-sm)] border-collapse">
              <thead>
                <tr className="text-left text-[var(--gs-muted)]">
                  <th className="py-2">Negociação</th>
                  <th className="py-2">Com quem</th>
                  <th className="py-2">Situação</th>
                  <th className="py-2 text-right">Estimado</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {oportunidades.map((o) => (
                  <tr key={o.id} className="border-t border-[var(--gs-border)]">
                    <td className="py-2">{o.title}</td>
                    <td className="py-2">{o.customer_name ?? o.lead_name ?? '—'}</td>
                    <td className="py-2">
                      <Badge
                        tone={
                          o.status === 'ganha'
                            ? 'success'
                            : o.status === 'perdida'
                              ? 'danger'
                              : 'info'
                        }
                      >
                        {o.status === 'ganha'
                          ? 'Ganha'
                          : o.status === 'perdida'
                            ? 'Perdida'
                            : 'Aberta'}
                      </Badge>
                      {o.sale_number && (
                        <span className="text-[var(--gs-muted)]"> · venda #{o.sale_number}</span>
                      )}
                    </td>
                    <td className="py-2 text-right">{formatCents(o.amount_cents)}</td>
                    <td className="py-2 text-right whitespace-nowrap">
                      {o.status === 'aberta' && (
                        <>
                          <Button size="sm" variant="ghost" onClick={() => void fechar(o, 'ganha')}>
                            Ganhei
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => void fechar(o, 'perdida')}
                          >
                            Perdi
                          </Button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </AppShell>
  );
}
