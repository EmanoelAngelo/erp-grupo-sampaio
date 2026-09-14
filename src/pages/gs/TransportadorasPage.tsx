/**
 * Compras › Transportadoras.
 *
 * A NF-e sempre trouxe um grupo <transp> — quem transportou, quem pagou o
 * frete, placa do caminhão, quantos volumes e quanto pesava — e o sistema
 * descartava tudo. O conferente da doca contava caixa sem saber quantas
 * esperar, e quem precisava reclamar de avaria não tinha para quem ligar.
 *
 * O cadastro nasce sozinho na importação, com o que o arquivo traz: nome,
 * documento e cidade. Esta tela existe para completar o que o XML não traz de
 * forma confiável — telefone, contato e inscrição estadual, que é a que decide
 * crédito de ICMS sobre o frete.
 *
 * NÃO CONFUNDIR com Logística: aquilo é cotação de frete de SAÍDA do
 * e-commerce (Melhor Envio, Correios). Esta é a transportadora da nota que a
 * loja RECEBE.
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
import { coreApi, type Carrier, type CarrierHistory, type CarrierInput } from '@/lib/api/core';
import { formatCents } from '@/components/gs/format';

function formatDocument(doc: string | null): string {
  if (!doc) return '—';
  if (doc.length === 14) {
    return doc.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
  }
  if (doc.length === 11) return doc.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
  return doc;
}

const VAZIO: CarrierInput = {
  name: '',
  tradeName: '',
  document: '',
  stateRegistration: '',
  email: '',
  phone: '',
  contactName: '',
  city: '',
  state: '',
  notes: '',
};

export default function TransportadorasPage() {
  const [lista, setLista] = useState<Carrier[]>([]);
  const [busca, setBusca] = useState('');
  const [incluirInativas, setIncluirInativas] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);
  const [form, setForm] = useState<CarrierInput | null>(null);
  const [editandoId, setEditandoId] = useState<string | null>(null);
  const [detalhe, setDetalhe] = useState<{ carrier: Carrier; history: CarrierHistory } | null>(
    null,
  );

  const carregar = useCallback(async () => {
    try {
      setErro(null);
      setLista(await coreApi.listCarriers({ search: busca, includeInactive: incluirInativas }));
    } catch (err) {
      setErro(
        err instanceof ApiRequestError ? err.message : 'Falha ao listar as transportadoras.',
      );
    }
  }, [busca, incluirInativas]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  async function salvar() {
    if (!form) return;
    setSalvando(true);
    setErro(null);
    try {
      if (editandoId) {
        await coreApi.updateCarrier(editandoId, form);
        setAviso('Transportadora atualizada.');
      } else {
        await coreApi.createCarrier(form);
        setAviso('Transportadora cadastrada.');
      }
      setForm(null);
      setEditandoId(null);
      await carregar();
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao salvar.');
    } finally {
      setSalvando(false);
    }
  }

  async function abrirDetalhe(id: string) {
    try {
      setErro(null);
      setDetalhe(await coreApi.getCarrier(id));
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao abrir a transportadora.');
    }
  }

  async function alternarAtiva(c: Carrier) {
    try {
      await coreApi.setCarrierActive(c.id, c.active !== 1);
      await carregar();
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao alterar.');
    }
  }

  function editar(c: Carrier) {
    setEditandoId(c.id);
    setForm({
      name: c.name,
      tradeName: c.trade_name ?? '',
      document: c.document ?? '',
      stateRegistration: c.state_registration ?? '',
      email: c.email ?? '',
      phone: c.phone ?? '',
      contactName: c.contact_name ?? '',
      city: c.city ?? '',
      state: c.state ?? '',
      notes: c.notes ?? '',
    });
  }

  function campo(k: keyof CarrierInput, rotulo: string, placeholder = '') {
    return (
      <Field key={k} label={rotulo}>
        {(p) => (
          <Input
            {...p}
            value={(form?.[k] as string) ?? ''}
            placeholder={placeholder}
            onChange={(e) => setForm((f) => (f ? { ...f, [k]: e.target.value } : f))}
          />
        )}
      </Field>
    );
  }

  return (
    <AppShell>
      <PageHeader
        breadcrumb={['Compras', 'Transportadoras']}
        title="Transportadoras"
        subtitle="Quem trouxe a mercadoria até a porta. O cadastro nasce da nota; aqui se completa o contato."
      />

      {erro && (
        <Card>
          <p role="alert">{erro}</p>
        </Card>
      )}
      {aviso && (
        <Card>
          <p>{aviso}</p>
        </Card>
      )}

      <Card>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <SearchInput
            value={busca}
            onChange={setBusca}
            placeholder="Nome ou CNPJ"
          />
          <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={incluirInativas}
              onChange={(e) => setIncluirInativas(e.target.checked)}
            />
            Mostrar inativas
          </label>
          <Button
            onClick={() => {
              setEditandoId(null);
              setForm({ ...VAZIO });
            }}
          >
            Nova transportadora
          </Button>
        </div>
      </Card>

      {form && (
        <Card>
          <h3>{editandoId ? 'Editar transportadora' : 'Nova transportadora'}</h3>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
              gap: 12,
            }}
          >
            {campo('name', 'Razão social')}
            {campo('tradeName', 'Nome de fantasia')}
            {campo('document', 'CNPJ ou CPF', 'Autônomo entra com CPF')}
            {campo('stateRegistration', 'Inscrição estadual', 'Decide crédito de ICMS do frete')}
            {campo('contactName', 'Contato')}
            {campo('phone', 'Telefone')}
            {campo('email', 'E-mail')}
            {campo('city', 'Cidade')}
            {campo('state', 'UF')}
            {campo('notes', 'Observações')}
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <Button onClick={() => void salvar()} disabled={salvando || !form.name.trim()}>
              {salvando ? 'Salvando…' : 'Salvar'}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setForm(null);
                setEditandoId(null);
              }}
            >
              Cancelar
            </Button>
          </div>
        </Card>
      )}

      <Card>
        {lista.length === 0 ? (
          <EmptyState
            title="Nenhuma transportadora"
            description="Elas aparecem sozinhas quando você importa uma nota que declara transporte."
          />
        ) : (
          <table>
            <thead>
              <tr>
                <th>Nome</th>
                <th>Documento</th>
                <th>Cidade</th>
                <th>Contato</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {lista.map((c) => (
                <tr key={c.id}>
                  <td>
                    {c.name}
                    {c.active !== 1 && (
                      <>
                        {' '}
                        <Badge tone="neutral">inativa</Badge>
                      </>
                    )}
                  </td>
                  <td>{formatDocument(c.document)}</td>
                  <td>{[c.city, c.state].filter(Boolean).join(' / ') || '—'}</td>
                  <td>{c.phone ?? c.contact_name ?? '—'}</td>
                  <td>
                    <Button variant="ghost" onClick={() => void abrirDetalhe(c.id)}>
                      Notas
                    </Button>
                    <Button variant="ghost" onClick={() => editar(c)}>
                      Editar
                    </Button>
                    <Button variant="ghost" onClick={() => void alternarAtiva(c)}>
                      {c.active === 1 ? 'Desativar' : 'Reativar'}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {detalhe && (
        <Card>
          <h3>{detalhe.carrier.name}</h3>
          <p>
            {detalhe.history.noteCount} nota(s) · {detalhe.history.volumesQty} volume(s) no total
          </p>
          {detalhe.history.notes.length === 0 ? (
            <EmptyState
              title="Nenhuma nota"
              description="Esta transportadora ainda não aparece em nota nenhuma."
            />
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Nota</th>
                  <th>Fornecedor</th>
                  <th>Volumes</th>
                  <th>Placa</th>
                  <th>Valor</th>
                </tr>
              </thead>
              <tbody>
                {detalhe.history.notes.map((n) => (
                  <tr key={n.id}>
                    <td>{n.number ?? '—'}</td>
                    <td>{n.supplier_name ?? '—'}</td>
                    <td>{n.volumes_qty ?? '—'}</td>
                    <td>{n.vehicle_plate ?? '—'}</td>
                    <td>{formatCents(n.total_cents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <Button variant="ghost" onClick={() => setDetalhe(null)}>
            Fechar
          </Button>
        </Card>
      )}
    </AppShell>
  );
}
