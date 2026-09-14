/**
 * Compras › Fornecedores.
 *
 * O cadastro já existia, mas nascia sozinho: importar um XML criava o
 * fornecedor com nome e documento. Dava para saber DE QUEM veio a nota, não
 * para comprar.
 *
 * A tela existe por causa de dois campos, e eles são o motivo de tudo:
 *
 *   PRAZO DE ENTREGA    quantos dias entre pedir e receber. Sem ele não há
 *                       quando repor — ou se compra cedo e o dinheiro fica
 *                       parado, ou tarde e a prateleira esvazia.
 *   PRAZO DE PAGAMENTO  quantos dias para pagar. É o que define o vencimento
 *                       da dívida, e portanto o caixa do mês.
 *
 * O histórico soma NOTA RECEBIDA, nunca pedido: pedido é intenção. Contar
 * pedido aqui inflaria o quanto se comprou de quem talvez não tenha entregue.
 */
import { useCallback, useEffect, useState } from 'react';
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
import { ApiRequestError } from '@/lib/api/client';
import { coreApi, type Supplier, type SupplierHistory, type SupplierInput } from '@/lib/api/core';
import { dataBR } from '@/lib/datas';

function formatCents(cents: number): string {
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function formatDocument(doc: string | null): string {
  if (!doc) return '—';
  if (doc.length === 14) {
    return doc.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
  }
  if (doc.length === 11) return doc.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
  return doc;
}

const VAZIO: SupplierInput = {
  name: '',
  tradeName: '',
  document: '',
  stateRegistration: '',
  email: '',
  phone: '',
  contactName: '',
  zip: '',
  street: '',
  number: '',
  district: '',
  city: '',
  state: '',
  paymentTermDays: 0,
  deliveryDays: 0,
  notes: '',
};

function paraFormulario(s: Supplier): SupplierInput {
  return {
    name: s.name,
    tradeName: s.trade_name ?? '',
    document: s.document ?? '',
    stateRegistration: s.state_registration ?? '',
    email: s.email ?? '',
    phone: s.phone ?? '',
    contactName: s.contact_name ?? '',
    zip: s.zip ?? '',
    street: s.street ?? '',
    number: s.number ?? '',
    district: s.district ?? '',
    city: s.city ?? '',
    state: s.state ?? '',
    paymentTermDays: s.payment_term_days,
    deliveryDays: s.delivery_days,
    notes: s.notes ?? '',
  };
}

export default function FornecedoresPage() {
  const [lista, setLista] = useState<Supplier[] | null>(null);
  const [busca, setBusca] = useState('');
  const [incluirInativos, setIncluirInativos] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);

  const [editandoId, setEditandoId] = useState<string | null>(null);
  const [form, setForm] = useState<SupplierInput | null>(null);
  const [detalhe, setDetalhe] = useState<(Supplier & { history: SupplierHistory }) | null>(null);

  const carregar = useCallback(async () => {
    setErro(null);
    try {
      setLista(await coreApi.listSuppliers({ search: busca, includeInactive: incluirInativos }));
    } catch (err) {
      setLista(null);
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao carregar fornecedores.');
    }
  }, [busca, incluirInativos]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const abrirNovo = () => {
    setEditandoId(null);
    setDetalhe(null);
    setForm({ ...VAZIO });
  };

  const abrirEdicao = async (s: Supplier) => {
    setForm(paraFormulario(s));
    setEditandoId(s.id);
    setErro(null);
    try {
      setDetalhe(await coreApi.getSupplier(s.id));
    } catch {
      setDetalhe(null);
    }
  };

  const salvar = async () => {
    if (!form) return;
    setSalvando(true);
    setErro(null);
    setAviso(null);
    try {
      if (editandoId) {
        await coreApi.updateSupplier(editandoId, form);
        setAviso(`"${form.name}" atualizado.`);
      } else {
        await coreApi.createSupplier(form);
        setAviso(`"${form.name}" cadastrado.`);
      }
      setForm(null);
      setEditandoId(null);
      setDetalhe(null);
      await carregar();
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao salvar.');
    } finally {
      setSalvando(false);
    }
  };

  const alternarAtivo = async (s: Supplier) => {
    setErro(null);
    try {
      await coreApi.setSupplierActive(s.id, s.active === 0);
      await carregar();
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao alterar.');
    }
  };

  const campo = (chave: keyof SupplierInput, valor: string | number) =>
    setForm((atual) => (atual ? { ...atual, [chave]: valor } : atual));

  return (
    <AppShell>
      <PageHeader
        title="Fornecedores"
        subtitle="De quem se compra, em quantos dias entrega e em quantos se paga"
        actions={<Button onClick={abrirNovo}>Novo fornecedor</Button>}
      />

      {erro && (
        <p role="alert" className="text-[var(--gs-danger)] text-[length:var(--gs-text-sm)]">
          {erro}
        </p>
      )}
      {aviso && <p className="text-[var(--gs-success)] text-[length:var(--gs-text-sm)]">{aviso}</p>}

      {form && (
        <Card title={editandoId ? 'Editar fornecedor' : 'Novo fornecedor'}>
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Razão social" required>
              {(p) => (
                <Input
                  {...p}
                  value={form.name}
                  onChange={(e) => campo('name', e.target.value)}
                  placeholder="Distribuidora Alfa Ltda"
                />
              )}
            </Field>
            <Field label="Nome fantasia">
              {(p) => (
                <Input
                  {...p}
                  value={form.tradeName ?? ''}
                  onChange={(e) => campo('tradeName', e.target.value)}
                />
              )}
            </Field>
            <Field label="CNPJ / CPF" hint="Com ou sem máscara — o sistema compara só os dígitos">
              {(p) => (
                <Input
                  {...p}
                  value={form.document ?? ''}
                  onChange={(e) => campo('document', e.target.value)}
                />
              )}
            </Field>
            <Field label="Inscrição estadual" hint="É ela que decide o crédito de ICMS na compra">
              {(p) => (
                <Input
                  {...p}
                  value={form.stateRegistration ?? ''}
                  onChange={(e) => campo('stateRegistration', e.target.value)}
                />
              )}
            </Field>

            <Field
              label="Prazo de entrega (dias)"
              hint="Usado para prever a chegada do pedido"
            >
              {(p) => (
                <Input
                  {...p}
                  type="number"
                  min={0}
                  value={form.deliveryDays ?? 0}
                  onChange={(e) => campo('deliveryDays', Number(e.target.value))}
                />
              )}
            </Field>
            <Field
              label="Prazo de pagamento (dias)"
              hint="Conta a partir do recebimento; define o vencimento da dívida"
            >
              {(p) => (
                <Input
                  {...p}
                  type="number"
                  min={0}
                  value={form.paymentTermDays ?? 0}
                  onChange={(e) => campo('paymentTermDays', Number(e.target.value))}
                />
              )}
            </Field>

            <Field label="Contato">
              {(p) => (
                <Input
                  {...p}
                  value={form.contactName ?? ''}
                  onChange={(e) => campo('contactName', e.target.value)}
                />
              )}
            </Field>
            <Field label="Telefone">
              {(p) => (
                <Input
                  {...p}
                  value={form.phone ?? ''}
                  onChange={(e) => campo('phone', e.target.value)}
                />
              )}
            </Field>
            <Field label="E-mail">
              {(p) => (
                <Input
                  {...p}
                  type="email"
                  value={form.email ?? ''}
                  onChange={(e) => campo('email', e.target.value)}
                />
              )}
            </Field>
            <Field label="Cidade / UF">
              {(p) => (
                <div className="flex gap-2">
                  <Input
                    {...p}
                    value={form.city ?? ''}
                    onChange={(e) => campo('city', e.target.value)}
                    placeholder="Cidade"
                  />
                  <Input
                    value={form.state ?? ''}
                    onChange={(e) => campo('state', e.target.value)}
                    placeholder="UF"
                    className="w-20"
                    maxLength={2}
                  />
                </div>
              )}
            </Field>
          </div>

          <div className="flex gap-2 mt-4">
            <Button onClick={() => void salvar()} loading={salvando} disabled={!form.name.trim()}>
              Salvar
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setForm(null);
                setEditandoId(null);
                setDetalhe(null);
              }}
            >
              Cancelar
            </Button>
          </div>
        </Card>
      )}

      {detalhe && (
        <Card title="Histórico de compras">
          <div className="grid gap-4 sm:grid-cols-4 mb-4">
            <div>
              <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">Notas recebidas</p>
              <p className="m-0 text-[length:var(--gs-text-lg)] font-bold">{detalhe.history.noteCount}</p>
            </div>
            <div>
              <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">Total comprado</p>
              <p className="m-0 text-[length:var(--gs-text-lg)] font-bold">
                {formatCents(detalhe.history.totalCents)}
              </p>
            </div>
            <div>
              <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">Em aberto</p>
              <p className="m-0 text-[length:var(--gs-text-lg)] font-bold">
                {formatCents(detalhe.history.openPayableCents)}
              </p>
            </div>
            <div>
              <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">Última compra</p>
              <p className="m-0 text-[length:var(--gs-text-lg)] font-bold">
                {detalhe.history.lastPurchaseAt
                  ? dataBR(detalhe.history.lastPurchaseAt)
                  : '—'}
              </p>
            </div>
          </div>
          {detalhe.history.noteCount === 0 && (
            <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] m-0">
              Nenhuma nota recebida deste fornecedor ainda. Nota importada e não conferida não
              conta aqui — ela ainda não entrou no estoque.
            </p>
          )}
        </Card>
      )}

      <Card title="Cadastrados">
        <div className="flex flex-wrap gap-3 items-center mb-3">
          <SearchInput
            value={busca}
            onChange={setBusca}
            placeholder="Nome, fantasia ou documento…"
          />
          <label className="flex items-center gap-2 text-[length:var(--gs-text-sm)]">
            <input
              type="checkbox"
              checked={incluirInativos}
              onChange={(e) => setIncluirInativos(e.target.checked)}
            />
            Mostrar desativados
          </label>
        </div>

        {lista === null ? (
          <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">Carregando…</p>
        ) : lista.length === 0 ? (
          <EmptyState
            title="Nenhum fornecedor"
            description="Cadastre quem fornece, ou importe um XML de NF-e — a importação cria o fornecedor com nome e documento."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[length:var(--gs-text-sm)] border-collapse">
              <thead>
                <tr className="text-left text-[var(--gs-muted)]">
                  <th className="py-2">Fornecedor</th>
                  <th className="py-2">Documento</th>
                  <th className="py-2">Entrega</th>
                  <th className="py-2">Pagamento</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {lista.map((s) => (
                  <tr key={s.id} className="border-t border-[var(--gs-border)]">
                    <td className="py-2">
                      <span className="font-semibold">{s.trade_name || s.name}</span>
                      {s.trade_name && (
                        <span className="text-[var(--gs-muted)]"> · {s.name}</span>
                      )}
                      {s.active === 0 && (
                        <span className="ml-2">
                          <Badge tone="neutral">Desativado</Badge>
                        </span>
                      )}
                    </td>
                    <td className="py-2 font-mono">{formatDocument(s.document)}</td>
                    <td className="py-2">
                      {s.delivery_days > 0 ? `${s.delivery_days} dias` : '—'}
                    </td>
                    <td className="py-2">
                      {s.payment_term_days > 0 ? `${s.payment_term_days} dias` : 'à vista'}
                    </td>
                    <td className="py-2 text-right whitespace-nowrap">
                      <Button size="sm" variant="ghost" onClick={() => void abrirEdicao(s)}>
                        Abrir
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => void alternarAtivo(s)}>
                        {s.active === 0 ? 'Reativar' : 'Desativar'}
                      </Button>
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
