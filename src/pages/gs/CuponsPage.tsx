/**
 * Cupons de desconto da loja online — GAP-PRD-123.
 *
 * O código que o cliente digita no checkout. Desconta os ITENS do pedido
 * desta empresa (nunca o frete), com pedido mínimo, vigência e teto de usos.
 * Os padrões são os seguros: uma vez por cliente, e não cumulativo com
 * promoção — o dono liga "vale também sobre promoção" quando quiser.
 *
 * Encerrar desliga o código na hora; os pedidos que já o usaram continuam com
 * o desconto (é o retrato deles). O código não se reaproveita: ele conta a
 * história dos pedidos.
 */
import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/gs/AppShell';
import {
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  Field,
  Input,
  PageHeader,
} from '@/components/gs/ui';
import { formatCents, parseReaisToCents } from '@/components/gs/format';
import { ApiRequestError } from '@/lib/api/client';
import { cuponsApi, type Cupom, type CupomEntrada } from '@/lib/api/cupons';
import { dataBR } from '@/lib/datas';

interface Formulario {
  code: string;
  description: string;
  tipo: 'percentual' | 'valor';
  percentOff: string;
  valorReais: string;
  minimoReais: string;
  startsAt: string;
  endsAt: string;
  maxUses: string;
  porCliente: string;
  cumulativo: boolean;
}

const VAZIO: Formulario = {
  code: '',
  description: '',
  tipo: 'percentual',
  percentOff: '',
  valorReais: '',
  minimoReais: '',
  startsAt: '',
  endsAt: '',
  maxUses: '',
  // Uma vez por cliente: o padrão seguro de um código que circula.
  porCliente: '1',
  cumulativo: false,
};

const SELECT =
  'w-full px-3 py-2 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)]';

function situacao(c: Cupom) {
  if (!c.active) return <Badge>Encerrado</Badge>;
  const agora = Date.now();
  if (new Date(c.starts_at).getTime() > agora) return <Badge tone="info">Programado</Badge>;
  if (c.ends_at && new Date(c.ends_at).getTime() < agora) return <Badge>Vencido</Badge>;
  if (c.max_uses != null && (c.uses ?? 0) >= c.max_uses) return <Badge>Esgotado</Badge>;
  return <Badge tone="success">Valendo</Badge>;
}

export default function CuponsPage() {
  const [aberto, setAberto] = useState(false);
  const [form, setForm] = useState<Formulario>(VAZIO);
  const [erroDoFormulario, setErroDoFormulario] = useState<string | null>(null);
  const [mensagem, setMensagem] = useState<string | null>(null);
  const [lista, setLista] = useState<Cupom[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  const recarregar = useCallback(async () => {
    try {
      setLista(await cuponsApi.listar());
      setErro(null);
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao carregar os cupons.');
    }
  }, []);

  useEffect(() => {
    void recarregar();
  }, [recarregar]);

  const enviar = async (event: React.FormEvent) => {
    event.preventDefault();
    setErroDoFormulario(null);
    const valorCents = form.tipo === 'valor' ? parseReaisToCents(form.valorReais) : null;
    if (form.tipo === 'valor' && valorCents === null) {
      setErroDoFormulario('Informe o valor do desconto.');
      return;
    }
    const minimoCents = form.minimoReais.trim() ? parseReaisToCents(form.minimoReais) : 0;
    if (minimoCents === null) {
      setErroDoFormulario('Pedido mínimo inválido — use o formato 150,00.');
      return;
    }
    const corpo: CupomEntrada = {
      code: form.code,
      description: form.description || undefined,
      percentOff: form.tipo === 'percentual' && form.percentOff ? Number(form.percentOff) : undefined,
      amountCents: valorCents ?? undefined,
      minOrderCents: minimoCents,
      startsAt: form.startsAt || undefined,
      endsAt: form.endsAt || undefined,
      maxUses: form.maxUses.trim() ? Number(form.maxUses) : null,
      // Vazio = sem teto por cliente (a pessoa apagou o "1" de propósito).
      maxUsesPerCustomer: form.porCliente.trim() ? Number(form.porCliente) : null,
      accumulatesWithPromotions: form.cumulativo,
    };
    try {
      const criado = await cuponsApi.criar(corpo);
      setMensagem(`Cupom ${criado.code} criado. O cliente já pode usá-lo no checkout da loja online.`);
      setForm(VAZIO);
      setAberto(false);
      await recarregar();
    } catch (err) {
      setErroDoFormulario(err instanceof ApiRequestError ? err.message : 'Falha ao criar o cupom.');
    }
  };

  const encerrar = async (c: Cupom) => {
    setMensagem(null);
    try {
      await cuponsApi.encerrar(c.id);
      setMensagem(
        `Cupom ${c.code} encerrado: não vale mais no checkout. Os pedidos que já o usaram mantêm o desconto.`,
      );
      await recarregar();
    } catch (err) {
      setMensagem(err instanceof ApiRequestError ? err.message : 'Falha ao encerrar.');
    }
  };

  return (
    <AppShell>
      <PageHeader
        breadcrumb={['Produtos', 'Cupons de desconto']}
        title="Cupons de desconto"
        actions={
          <Button onClick={() => setAberto((v) => !v)}>{aberto ? 'Fechar' : 'Novo cupom'}</Button>
        }
      />

      <p className="mb-4 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
        O cupom vale na loja online, sobre os produtos desta empresa — nunca sobre o frete. Para
        baixar o preço também no balcão, use Promoções.
      </p>

      {aberto && (
        <Card title="Novo cupom" className="mb-5">
          <form onSubmit={(e) => void enviar(e)} className="grid gap-4 sm:grid-cols-3">
            <Field label="Código" required hint="3 a 30 letras sem acento, números, - ou _">
              {(p) => (
                <Input
                  {...p}
                  value={form.code}
                  onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
                />
              )}
            </Field>
            <Field label="Descrição" hint="Só para a equipe (ex.: campanha de inverno)">
              {(p) => (
                <Input
                  {...p}
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                />
              )}
            </Field>
            <Field label="Tipo de desconto">
              {(p) => (
                <select
                  {...p}
                  value={form.tipo}
                  onChange={(e) => setForm({ ...form, tipo: e.target.value as 'percentual' | 'valor' })}
                  className={SELECT}
                >
                  <option value="percentual">Percentual sobre os itens</option>
                  <option value="valor">Valor fixo</option>
                </select>
              )}
            </Field>
            {form.tipo === 'percentual' ? (
              <Field label="Desconto (%)" required hint="Maior que 0 e menor que 100">
                {(p) => (
                  <Input
                    {...p}
                    type="number"
                    min="0.01"
                    max="99.99"
                    step="0.01"
                    value={form.percentOff}
                    onChange={(e) => setForm({ ...form, percentOff: e.target.value })}
                  />
                )}
              </Field>
            ) : (
              <Field label="Valor do desconto" required hint="Ex.: 20,00">
                {(p) => (
                  <Input
                    {...p}
                    inputMode="decimal"
                    value={form.valorReais}
                    onChange={(e) => setForm({ ...form, valorReais: e.target.value })}
                  />
                )}
              </Field>
            )}
            <Field
              label="Pedido mínimo"
              hint={
                form.tipo === 'valor'
                  ? 'Obrigatório e maior que o desconto'
                  : 'Em branco, sem mínimo'
              }
            >
              {(p) => (
                <Input
                  {...p}
                  inputMode="decimal"
                  value={form.minimoReais}
                  onChange={(e) => setForm({ ...form, minimoReais: e.target.value })}
                />
              )}
            </Field>
            <Field label="Começa em" hint="Em branco, começa agora">
              {(p) => (
                <Input
                  {...p}
                  type="date"
                  value={form.startsAt}
                  onChange={(e) => setForm({ ...form, startsAt: e.target.value })}
                />
              )}
            </Field>
            <Field label="Válido até" hint="Em branco, sem prazo">
              {(p) => (
                <Input
                  {...p}
                  type="date"
                  value={form.endsAt}
                  onChange={(e) => setForm({ ...form, endsAt: e.target.value })}
                />
              )}
            </Field>
            <Field label="Usos no total" hint="Em branco, sem limite">
              {(p) => (
                <Input
                  {...p}
                  type="number"
                  min="1"
                  value={form.maxUses}
                  onChange={(e) => setForm({ ...form, maxUses: e.target.value })}
                />
              )}
            </Field>
            <Field label="Usos por cliente" hint="1 = uso único. Em branco, sem limite">
              {(p) => (
                <Input
                  {...p}
                  type="number"
                  min="1"
                  value={form.porCliente}
                  onChange={(e) => setForm({ ...form, porCliente: e.target.value })}
                />
              )}
            </Field>
            <label className="sm:col-span-3 flex items-center gap-2 text-[length:var(--gs-text-sm)]">
              <input
                type="checkbox"
                checked={form.cumulativo}
                onChange={(e) => setForm({ ...form, cumulativo: e.target.checked })}
              />
              Vale também sobre itens que já estão em promoção
            </label>
            <div className="sm:col-span-3 flex items-center gap-3">
              <Button type="submit">Criar cupom</Button>
            </div>
            {erroDoFormulario && (
              <p role="alert" className="sm:col-span-3 text-[var(--gs-danger)] m-0">
                {erroDoFormulario}
              </p>
            )}
          </form>
        </Card>
      )}

      {mensagem && (
        <p role="status" className="mb-4 text-[length:var(--gs-text-sm)]">
          {mensagem}
        </p>
      )}
      {erro && (
        <p role="alert" className="mb-4 text-[var(--gs-danger)]">
          {erro}
        </p>
      )}

      <Card padded={false}>
        <DataTable
          columns={[
            { header: 'Código', render: (c: Cupom) => <strong>{c.code}</strong> },
            {
              header: 'Desconto',
              render: (c: Cupom) =>
                c.percent_off != null ? `${c.percent_off}%` : formatCents(c.amount_cents ?? 0),
            },
            {
              header: 'Mínimo',
              render: (c: Cupom) => (c.min_order_cents > 0 ? formatCents(c.min_order_cents) : '—'),
            },
            {
              header: 'Vigência',
              render: (c: Cupom) => `${dataBR(c.starts_at)} a ${dataBR(c.ends_at, 'sem prazo')}`,
            },
            {
              header: 'Usos',
              render: (c: Cupom) =>
                c.max_uses != null ? `${c.uses ?? 0} de ${c.max_uses}` : String(c.uses ?? 0),
            },
            {
              header: 'Por cliente',
              render: (c: Cupom) =>
                c.max_uses_per_customer != null ? String(c.max_uses_per_customer) : 'Sem limite',
            },
            {
              header: 'Promoção',
              render: (c: Cupom) =>
                c.accumulates_with_promotions ? 'Acumula' : 'Só preço cheio',
            },
            { header: 'Situação', render: (c: Cupom) => situacao(c) },
            {
              header: '',
              render: (c: Cupom) =>
                c.active ? (
                  <Button size="sm" variant="secondary" onClick={() => void encerrar(c)}>
                    Encerrar
                  </Button>
                ) : null,
            },
          ]}
          rows={lista ?? []}
          keyOf={(c) => c.id}
          empty={
            <EmptyState
              title="Nenhum cupom"
              description="Crie um código para o cliente digitar no checkout da loja online."
            />
          }
        />
      </Card>
    </AppShell>
  );
}
