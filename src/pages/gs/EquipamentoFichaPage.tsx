/**
 * A FICHA da máquina — identidade, garantia e tudo o que já aconteceu.
 *
 * ## O buraco que esta tela fecha
 *
 * `core_equipment_events` gravava desde que nasceu — criação, venda, OS
 * aberta, serviço concluído, plaquinha, vínculo de estoque — e NENHUMA tela
 * jamais leu (a auditoria da rodada 14 mediu: seis escritores, zero
 * leitores). O mecânico que recebia a mesma moto pela terceira vez não tinha
 * como saber que ela já tinha vindo duas.
 *
 * ## A garantia é calculada aqui, na frente de quem pergunta
 *
 * O servidor manda o COMBINADO (meses) e a data-base; o estado sai da conta,
 * toda vez. O sistema anterior gravava "em garantia" num campo e nunca
 * recalculava — a moto seguia em garantia na tela anos depois de vencer.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AppShell } from '@/components/gs/AppShell';
import { Badge, Button, Card, EmptyState, Field, Input, PageHeader } from '@/components/gs/ui';
import { formatCents } from '@/components/gs/format';
import { ApiRequestError, apiRequest } from '@/lib/api/client';
import { useHasProfile } from '@/hooks/useSession';
import { dataBR } from '@/lib/datas';
import { PlaquinhaDaMaquinaCard } from '@/components/gs/PlaquinhaDaMaquinaCard';
import { CorrigirIdentidadeCard } from '@/components/gs/CorrigirIdentidadeCard';
import { FotosDoEquipamentoCard } from '@/components/gs/FotosDoEquipamentoCard';
import { VendaAMaoCard } from '@/components/gs/VendaAMaoCard';
import {
  placaLegivel,
  rotuloDaCategoria,
  temPlacaEKm,
} from '@/lib/api/equipamentoIdentidade';

interface Garantia {
  months: number | null;
  baseKind: 'venda' | 'entrada' | null;
  baseDate: string | null;
  expiresAt: string | null;
  status: 'sem_garantia' | 'vigente' | 'vence_em_breve' | 'vencida';
  daysLeft: number | null;
}

interface Ficha {
  equipment: Record<string, unknown>;
  warranty: Garantia;
  assemblyMechanicName: string | null;
  ownerName: string | null;
  workshopName: string | null;
  publicIdLabel: string;
  /**
   * O que a ficha pode fazer com o adesivo (GAP-PRD-107): a empresa usa o
   * pool, e a bancada dá QR à máquina. Ausente em servidor antigo = não
   * oferece a troca.
   */
  plaquinha?: { empresaUsa: boolean; bancadaUsa: boolean };
  /** Como falar com o dono (GAP-PRD-106). */
  ownerPhone?: string | null;
  /**
   * A unidade da loja que manda em chassi, motor e série, quando a máquina
   * foi adotada pelo estoque (GAP-PRD-106). A correção trava os três.
   */
  vinculoDeEstoque?: { unitId: string; companyName: string } | null;
  /** Plaquinha interna vendida à mão, sem venda no sistema (GAP-PRD-189). */
  vendaAMao?: boolean;
  events: {
    id: string;
    event_type: string;
    description: string | null;
    order_number: number | null;
    user_name: string | null;
    created_at: string;
  }[];
  orders: {
    id: string;
    number: number;
    status: string;
    complaint: string | null;
    total_cents: number;
    created_at: string;
    closed_at: string | null;
  }[];
}

const GARANTIA_ROTULO: Record<Garantia['status'], { texto: string; tom: 'neutral' | 'success' | 'warning' | 'danger' }> = {
  sem_garantia: { texto: 'Sem garantia', tom: 'neutral' },
  vigente: { texto: 'Em garantia', tom: 'success' },
  vence_em_breve: { texto: 'Vence em breve', tom: 'warning' },
  vencida: { texto: 'Garantia vencida', tom: 'danger' },
};

/** O que cada acontecimento da máquina quer dizer, em português. */
const EVENTO_ROTULO: Record<string, string> = {
  created: 'Cadastrada',
  sold: 'Vendida',
  order_opened: 'OS aberta',
  service_completed: 'Serviço concluído',
  label_printed: 'Plaquinha impressa',
  unit_linked: 'Vinculada ao estoque',
  unit_unlinked: 'Desvinculada do estoque',
  chassis_removed: 'Chassi corrigido',
  ficha_atualizada: 'Ficha atualizada',
  plaquinha_trocada: 'Plaquinha trocada',
  identidade_corrigida: 'Identidade corrigida',
  km_registrado: 'Quilometragem registrada',
  stock_linked: 'Vinculada ao estoque',
  sale_reverted: 'Venda desfeita',
};

const STATUS_OS: Record<string, string> = {
  em_aberto: 'Em aberto',
  em_andamento: 'Em andamento',
  manutencao_externa: 'Manutenção externa',
  parada_setor: 'Parada no setor',
  aguardando_peca: 'Aguardando peça',
  aguardando_pagamento: 'Aguardando pagamento',
  finalizada: 'Finalizada',
};

/*
  DIA DE CALENDÁRIO E INSTANTE NÃO SE IMPRIMEM DO MESMO JEITO.

  `new Date('2026-08-12')` é meia-noite UTC, e o Brasil é UTC−3: o navegador
  imprime 11/08. Entrada, montagem, data-base e vencimento de garantia são
  dias — o que foi combinado, digitado ou prometido —, e têm de aparecer como
  foram escritos. Já o `created_at` do histórico e da OS é INSTANTE, e aí
  converter para o fuso de quem está na bancada é justamente o certo.

  Foi visto na tela, não no teste: máquina com entrada em 12/08 anunciava
  "Entrou em 11/08"; montagem informada em 01/08 virava 31/07.
*/
function quando(iso: string | null | undefined): string {
  if (!iso) return '—';
  const diaDeCalendario = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (diaDeCalendario) {
    const [, ano, mes, dia] = diaDeCalendario;
    return `${dia}/${mes}/${ano}`;
  }
  return dataBR(iso);
}

function texto(valor: unknown): string {
  const s = String(valor ?? '').trim();
  return s || '—';
}

export default function EquipamentoFichaPage() {
  const { id } = useParams<{ id: string }>();
  const [ficha, setFicha] = useState<Ficha | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [editando, setEditando] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const [form, setForm] = useState({ warrantyMonths: '', assembledAt: '', enteredAt: '' });
  const [montadorId, setMontadorId] = useState('');
  const [equipe, setEquipe] = useState<{ id: string; displayName: string }[]>([]);
  /** A equipe não pôde ser lida (403 para quem não é gerente). */
  const [equipeIndisponivel, setEquipeIndisponivel] = useState(false);
  const podeEditar = useHasProfile('mecanico', 'gerente_oficina');
  /** Os perfis de `POST /labels/equipment/sheet` e de `.../replace`. */
  const podeImprimirPlaquinha = useHasProfile(
    'gerente_oficina',
    'gerente_loja',
    'mecanico',
    'estoquista',
    'atendente',
  );
  const podeTrocarPlaquinha = useHasProfile('mecanico', 'gerente_oficina');
  /** Os perfis de `POST /equipment/:id/photos` e do `DELETE` (GAP-PRD-106). */
  const podeSubirFoto = useHasProfile('mecanico', 'gerente_oficina', 'operador_caixa_oficina', 'atendente');
  const podeApagarFoto = useHasProfile('mecanico', 'gerente_oficina');
  /** O perfil de `POST /equipment/:id/owner/desfazer` (GAP-PRD-189). */
  const podeDesfazerVenda = useHasProfile('gerente_oficina');
  const [corrigindo, setCorrigindo] = useState(false);

  const carregar = useCallback(async () => {
    if (!id) return;
    setCarregando(true);
    setErro(null);
    try {
      const dados = await apiRequest<Ficha>(`/core/equipment/${id}`);
      setFicha(dados);
      setForm({
        warrantyMonths: dados.warranty.months ? String(dados.warranty.months) : '',
        assembledAt: String(dados.equipment.assembled_at ?? '').slice(0, 10),
        enteredAt: String(dados.equipment.entered_at ?? '').slice(0, 10),
      });
      setMontadorId(String(dados.equipment.assembly_mechanic_id ?? ''));
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao abrir a ficha.');
    } finally {
      setCarregando(false);
    }
  }, [id]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  /*
    A lista de montadores é de QUEM MONTA, não da equipe inteira.

    `workshopStaff=1` devolve quem atende a oficina — mecânico, gerente e
    CAIXA. O caixa aparecia no seletor "Montada por", e o servidor agora o
    recusa (`CORE_NOT_A_MECHANIC`): oferecer o que leva 400 é pior que não
    oferecer.
  */
  useEffect(() => {
    if (!editando || equipe.length > 0) return;
    void apiRequest<{ items: { id: string; displayName: string; profileCode: string }[] }>(
      '/core/team?workshopStaff=1',
    )
      .then((r) => {
        setEquipe(
          (r.items ?? []).filter(
            (p) => p.profileCode === 'mecanico' || p.profileCode === 'gerente_oficina',
          ),
        );
        setEquipeIndisponivel(false);
      })
      /*
        Falhar aqui não pode virar "não tem montador".

        A rota da equipe é de GESTÃO e o PATCH da ficha aceita `mecanico`: o
        mecânico leva 403 justamente nesta leitura. Engolindo o erro, o seletor
        abria em "Não informado" numa máquina que JÁ tinha montador — e salvar
        a garantia APAGAVA quem montou, sem uma palavra na tela.
      */
      .catch(() => {
        setEquipe([]);
        setEquipeIndisponivel(true);
      });
  }, [editando, equipe.length]);

  const salvar = async () => {
    setOcupado(true);
    setErro(null);
    try {
      await apiRequest(`/core/equipment/${id}`, {
        method: 'PATCH',
        body: {
          warrantyMonths: form.warrantyMonths.trim() ? Number(form.warrantyMonths) : 0,
          assembledAt: form.assembledAt || null,
          enteredAt: form.enteredAt || null,
          /*
            Campo que não pôde ser editado NÃO viaja.

            O patch é estreito por campo presente: mandar `assemblyMechanicId`
            quando a equipe não carregou faria a tela sobrescrever o montador
            gravado com o que ela conseguiu mostrar.
          */
          ...(equipeIndisponivel ? {} : { assemblyMechanicId: montadorId || null }),
        },
      });
      setEditando(false);
      await carregar();
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Não foi possível salvar.');
    } finally {
      setOcupado(false);
    }
  };

  if (carregando) {
    return (
      <AppShell>
        <p role="status" className="text-[var(--gs-muted)]">
          Carregando…
        </p>
      </AppShell>
    );
  }

  if (!ficha) {
    return (
      <AppShell>
        <Card>
          <EmptyState
            title="Equipamento não encontrado"
            description={erro ?? 'Confira a plaquinha e tente de novo.'}
          />
          <Link to="/sistema/equipamentos">
            <Button variant="secondary" className="mt-3">
              Voltar à lista
            </Button>
          </Link>
        </Card>
      </AppShell>
    );
  }

  const eq = ficha.equipment;
  const garantia = GARANTIA_ROTULO[ficha.warranty.status];

  return (
    <AppShell>
      <PageHeader
        breadcrumb={['Oficina', 'Equipamentos', ficha.publicIdLabel]}
        title={`${texto(eq.brand)} ${texto(eq.model)}`.trim()}
        subtitle={ficha.workshopName ?? undefined}
        actions={
          <Link to="/sistema/equipamentos">
            <Button variant="secondary">Voltar à lista</Button>
          </Link>
        }
      />

      {erro && (
        <p
          role="alert"
          className="mb-5 px-4 py-3 rounded-[var(--gs-radius)] bg-[var(--gs-danger-bg)] text-[var(--gs-danger)]"
        >
          {erro}
        </p>
      )}

      <Card className="mb-5">
        <div className="flex flex-wrap gap-6 items-start">
          <div>
            <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">Plaquinha</p>
            <p className="m-0 text-[length:var(--gs-text-lg)] font-bold tabular-nums">
              {ficha.publicIdLabel}
            </p>
            <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
              {eq.origin === 'EXTERNAL_CUSTOMER' ? 'Máquina do cliente' : 'Máquina do grupo'}
            </p>
          </div>
          <div>
            <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">Dono</p>
            <p className="m-0 font-semibold">{ficha.ownerName ?? 'Sem dono registrado'}</p>
            {ficha.ownerPhone ? (
              <p className="m-0 text-[length:var(--gs-text-sm)]">
                <a href={`tel:${ficha.ownerPhone.replace(/[^\d+]/g, '')}`}>{ficha.ownerPhone}</a>
              </p>
            ) : null}
            {eq.sold_at ? (
              <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                Vendida em {quando(String(eq.sold_at))}
              </p>
            ) : null}
          </div>
          <div>
            <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">Garantia</p>
            <Badge tone={garantia.tom}>{garantia.texto}</Badge>
            <p className="m-0 mt-1 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
              {ficha.warranty.months
                ? `${ficha.warranty.months} meses · vence em ${quando(ficha.warranty.expiresAt)}`
                : 'Nenhuma garantia combinada'}
            </p>
            {ficha.warranty.baseKind && (
              <p className="m-0 text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
                Conta a partir da {ficha.warranty.baseKind === 'venda' ? 'venda' : 'entrada'} (
                {quando(ficha.warranty.baseDate)})
              </p>
            )}
          </div>
          <div>
            <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">Montada por</p>
            <p className="m-0 font-semibold">{ficha.assemblyMechanicName ?? '—'}</p>
            <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
              {eq.assembled_at ? `em ${quando(String(eq.assembled_at))}` : ''}
            </p>
          </div>
          {podeEditar && !editando && (
            <div className="ml-auto flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => setEditando(true)}>
                Completar ficha
              </Button>
              {!corrigindo && (
                <Button variant="secondary" onClick={() => setCorrigindo(true)}>
                  Corrigir identidade
                </Button>
              )}
            </div>
          )}
        </div>
      </Card>

      {/* Reimprimir e trocar o adesivo, onde se olha a máquina (GAP-PRD-107). */}
      <PlaquinhaDaMaquinaCard
        equipmentId={String(eq.id)}
        rotulo={ficha.publicIdLabel}
        empresaUsa={ficha.plaquinha?.empresaUsa ?? false}
        bancadaUsa={ficha.plaquinha?.bancadaUsa ?? false}
        podeImprimir={podeImprimirPlaquinha}
        podeTrocar={podeTrocarPlaquinha}
        onTrocada={() => void carregar()}
      />

      {/* A venda à mão sem venda no sistema tem volta pela tela (GAP-PRD-189). */}
      {ficha.vendaAMao && (
        <VendaAMaoCard
          equipmentId={String(eq.id)}
          ownerName={ficha.ownerName}
          soldAt={eq.sold_at ? String(eq.sold_at) : null}
          podeDesfazer={podeDesfazerVenda}
          onDesfeita={() => void carregar()}
        />
      )}

      {editando && (
        <Card title="Garantia e montagem" className="mb-5">
          <div className="grid gap-4 sm:grid-cols-4 items-end">
            <Field label="Garantia (meses)" hint="0 ou em branco = sem garantia.">
              {(p) => (
                <Input
                  {...p}
                  inputMode="numeric"
                  value={form.warrantyMonths}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      warrantyMonths: e.target.value.replace(/\D/g, '').slice(0, 3),
                    })
                  }
                />
              )}
            </Field>
            <Field label="Entrou em">
              {(p) => (
                <Input
                  {...p}
                  type="date"
                  value={form.enteredAt}
                  onChange={(e) => setForm({ ...form, enteredAt: e.target.value })}
                />
              )}
            </Field>
            <Field label="Montada em">
              {(p) => (
                <Input
                  {...p}
                  type="date"
                  value={form.assembledAt}
                  onChange={(e) => setForm({ ...form, assembledAt: e.target.value })}
                />
              )}
            </Field>
            <Field
              label="Montada por"
              hint={
                equipeIndisponivel
                  ? 'Não foi possível carregar a equipe — peça ao gerente da oficina.'
                  : undefined
              }
            >
              {(p) => (
                <select
                  {...p}
                  value={montadorId}
                  disabled={equipeIndisponivel}
                  onChange={(e) => setMontadorId(e.target.value)}
                  className="h-10 w-full px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)]"
                >
                  {/*
                    Sem a equipe, o seletor mostra QUEM ESTÁ GRAVADO e não
                    deixa trocar: "Não informado" ali seria a tela afirmando
                    que a máquina não tem montador — e o salvar apagaria o que
                    existe.
                  */}
                  {equipeIndisponivel ? (
                    <option value={montadorId}>
                      {ficha.assemblyMechanicName ?? 'Não informado'}
                    </option>
                  ) : (
                    <>
                      <option value="">Não informado</option>
                      {equipe.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.displayName}
                        </option>
                      ))}
                    </>
                  )}
                </select>
              )}
            </Field>
          </div>
          <div className="flex gap-2 mt-3">
            <Button disabled={ocupado} onClick={() => void salvar()}>
              Salvar ficha
            </Button>
            <Button variant="ghost" onClick={() => setEditando(false)}>
              Cancelar
            </Button>
          </div>
        </Card>
      )}

      {corrigindo && (
        <CorrigirIdentidadeCard
          equipmentId={String(eq.id)}
          equipamento={eq}
          lojaDoVinculo={ficha.vinculoDeEstoque?.companyName ?? null}
          onCorrigida={() => {
            setCorrigindo(false);
            void carregar();
          }}
          onCancelar={() => setCorrigindo(false)}
        />
      )}

      <Card title="Identificação" className="mb-5">
        <div className="grid gap-4 sm:grid-cols-4">
          {[
            ['Tipo', rotuloDaCategoria(eq.category)],
            // Placa e quilometragem são da MÁQUINA (GAP-PRD-106) — celular
            // não tem nenhuma das duas, e a ficha nem pergunta.
            ...(temPlacaEKm(String(eq.category ?? ''))
              ? [
                  ['Placa', placaLegivel(eq.plate)],
                  [
                    'Quilometragem',
                    eq.odometer_km !== null && eq.odometer_km !== undefined
                      ? `${Number(eq.odometer_km).toLocaleString('pt-BR')} km${
                          eq.odometer_at ? ` (em ${quando(String(eq.odometer_at))})` : ''
                        }`
                      : null,
                  ],
                ]
              : []),
            ['Ano', eq.year],
            ['Versão', eq.version],
            ['Cor', eq.color],
            ['Número de série', eq.serial_number],
            ['Chassi', eq.chassis],
            ['Número do motor', eq.motor_number],
            ['Bateria', eq.battery],
            ['Série da bateria', eq.battery_serial],
            ['Entrou em', eq.entered_at ? quando(String(eq.entered_at)) : null],
          ].map(([rotulo, valor]) => (
            <div key={String(rotulo)}>
              <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">{String(rotulo)}</p>
              <p className="m-0">{texto(valor)}</p>
            </div>
          ))}
        </div>
        {eq.notes ? (
          <p className="mt-3 mb-0 text-[length:var(--gs-text-sm)]">{String(eq.notes)}</p>
        ) : null}
        {ficha.vinculoDeEstoque ? (
          <p className="mt-3 mb-0 text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
            Chassi, motor e série vêm da unidade de estoque da {ficha.vinculoDeEstoque.companyName}.
          </p>
        ) : null}
      </Card>

      <FotosDoEquipamentoCard
        equipmentId={String(eq.id)}
        podeSubir={podeSubirFoto}
        podeApagar={podeApagarFoto}
      />

      <Card
        title={`Ordens de serviço (${ficha.orders.length})`}
        subtitle="Tudo o que esta máquina já passou na bancada."
        className="mb-5"
      >
        {ficha.orders.length === 0 ? (
          <EmptyState
            title="Nenhuma ordem de serviço"
            description="Esta máquina ainda não entrou na bancada."
          />
        ) : (
          <ul className="list-none p-0 m-0 flex flex-col gap-2">
            {ficha.orders.map((os) => (
              <li
                key={os.id}
                className="flex flex-wrap items-baseline justify-between gap-2 border-b border-[var(--gs-border)] pb-2 last:border-0"
              >
                <div>
                  <Link
                    to={`/sistema/oficina/os/${os.id}`}
                    className="font-semibold text-[var(--gs-purple-800)] no-underline hover:underline"
                  >
                    OS #{os.number}
                  </Link>
                  <span className="ml-2 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                    {quando(os.created_at)} · {STATUS_OS[os.status] ?? os.status}
                  </span>
                  {os.complaint && (
                    <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
                      {os.complaint}
                    </p>
                  )}
                </div>
                <span className="tabular-nums text-[length:var(--gs-text-sm)]">
                  {formatCents(os.total_cents)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card
        title="O que já aconteceu"
        subtitle="Registro append-only da máquina — nada aqui é editável."
      >
        {ficha.events.length === 0 ? (
          <EmptyState title="Sem histórico" description="Nada foi registrado ainda." />
        ) : (
          <ul className="list-none p-0 m-0 flex flex-col gap-3">
            {ficha.events.map((ev) => (
              <li key={ev.id} className="border-l-2 border-[var(--gs-border-strong)] pl-3">
                <p className="m-0 font-semibold text-[length:var(--gs-text-sm)]">
                  {EVENTO_ROTULO[ev.event_type] ?? ev.event_type}
                  {ev.order_number ? ` · OS #${ev.order_number}` : ''}
                </p>
                {ev.description && (
                  <p className="m-0 text-[length:var(--gs-text-sm)]">{ev.description}</p>
                )}
                <p className="m-0 text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
                  {new Date(ev.created_at).toLocaleString('pt-BR')}
                  {ev.user_name ? ` · ${ev.user_name}` : ''}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </AppShell>
  );
}
