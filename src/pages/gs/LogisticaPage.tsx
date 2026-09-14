/**
 * Logística: transportadoras, o que falta em cada uma, e cotação de conferência.
 *
 * O MÓDULO EXISTIA E NÃO ERA ALCANÇÁVEL POR NINGUÉM. O roteador `/logistics`
 * guarda toda rota com `requirePermission('logistics.view')`, e essa função
 * compara a string com os PERFIS do usuário — não existe perfil com esse nome.
 * Cotação, transportadoras, envios e homologação respondiam 403 para todo
 * mundo, gestor incluído. O item de menu dizia "em breve" para algo que já
 * estava escrito e testado.
 *
 * ONDE A ETIQUETA É COMPRADA (GAP-PRD-120)
 *
 * Não aqui: a etiqueta é de UM pedido, e é comprada na ficha dele (Pedidos →
 * nº do pedido → Envio), pelo Melhor Envio, com o token desta tela. Aqui fica
 * o que vale para todos os envios da operação — a credencial e "Envio e
 * etiqueta" (NF-e ou declaração de conteúdo, agência Jadlog). Etiqueta
 * simulada não existe: nenhuma agência aceita.
 *
 * CORREIOS E JADLOG NÃO TÊM INTEGRAÇÃO DIRETA (GAP-PRD-118): o cartão deles
 * diz isso num item só, em vez de acender um "IMPLEMENTADO" verde fixo. Os
 * serviços deles chegam pelo Melhor Envio.
 *
 * COTAÇÃO SIMULADA VEM MARCADA. É a informação mais importante da tela: preço
 * simulado lido como preço de transportadora vira prejuízo em todo pedido, e
 * quem lê a tela decide preço de frete na loja. A de SANDBOX também: é real,
 * mas de ambiente de teste, e tem tarja própria.
 *
 * A TARJA LÊ O CONTRATO (GAP-PRD-126). Ela dizia "PRODUÇÃO BLOQUEADA" lendo só
 * uma variável do servidor. Agora vem de `checkoutCarrier`, que o servidor
 * monta com a credencial guardada E a trava do processo — é a mesma resposta
 * que decide se o checkout cobra frete de transportadora.
 *
 * O TOKEN ENTRA POR AQUI (GAP-PRD-117) — ver `CredencialMelhorEnvio`.
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
import { formatCents } from '@/components/gs/format';
import { CredencialMelhorEnvio } from '@/components/gs/CredencialMelhorEnvio';
import { ConfiguracaoDeEnvio } from '@/components/gs/ConfiguracaoDeEnvio';
import { ApiRequestError } from '@/lib/api/client';
import {
  coreApi,
  type LogisticsCarrierStatus,
  type LogisticsQuote,
  type LogisticsReadiness,
} from '@/lib/api/core';

const NOME_TRANSPORTADORA: Record<string, string> = {
  correios: 'Correios',
  jadlog: 'Jadlog',
  melhor_envio: 'Melhor Envio',
};

const TOM_ITEM: Record<string, 'success' | 'warning' | 'danger'> = {
  ok: 'success',
  pending: 'warning',
  blocked: 'danger',
};

/** O que a cotação desta transportadora vale no checkout, em uma palavra. */
function noCheckout(r: LogisticsCarrierStatus): { texto: string; tom: 'success' | 'warning' | 'danger' | 'neutral' } {
  const modo = r.access?.mode ?? (r.configured ? 'simulated' : 'none');
  switch (modo) {
    case 'production':
      return { texto: 'Cobra do cliente', tom: 'success' };
    case 'sandbox':
      return { texto: 'Só conferência (sandbox)', tom: 'warning' };
    case 'simulated':
      return { texto: 'Simulada', tom: 'warning' };
    case 'blocked':
      return { texto: 'Travada', tom: 'danger' };
    default:
      return { texto: '—', tom: 'neutral' };
  }
}

/** A coluna Conexão mostra o último teste GUARDADO — abrir a tela não testa nada. */
function conexao(r: LogisticsCarrierStatus): string {
  if (!r.configured) return '—';
  if (r.connection.simulated) return 'Simulada';
  if (r.connection.tested === false) return 'Não testada';
  if (r.connection.tested) return r.connection.ok ? 'OK' : 'Falhou';
  // Resposta no formato antigo, sem `tested`.
  return r.connection.real ? (r.connection.ok ? 'OK' : 'Falhou') : 'Não testada';
}

function cepFormatado(digitos: string | null): string {
  if (!digitos || digitos.length !== 8) return '—';
  return `${digitos.slice(0, 5)}-${digitos.slice(5)}`;
}

export default function LogisticaPage() {
  const [prontidao, setProntidao] = useState<LogisticsReadiness | null>(null);
  const [transportadoras, setTransportadoras] = useState<LogisticsCarrierStatus[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  const [form, setForm] = useState({
    destinationZipCode: '',
    weightGrams: '',
    heightCm: '',
    widthCm: '',
    lengthCm: '',
  });
  const [cotacao, setCotacao] = useState<LogisticsQuote | null>(null);
  const [cotando, setCotando] = useState(false);

  const carregar = useCallback(async () => {
    setErro(null);
    try {
      const [p, c] = await Promise.all([
        coreApi.getLogisticsReadiness(),
        coreApi.getLogisticsCarriers(),
      ]);
      setProntidao(p);
      setTransportadoras(c.items);
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao carregar a logística.');
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const cotar = async () => {
    setCotando(true);
    setErro(null);
    setCotacao(null);
    try {
      setCotacao(
        await coreApi.quoteShipping({
          destinationZipCode: form.destinationZipCode,
          weightGrams: Number(form.weightGrams),
          heightCm: Number(form.heightCm),
          widthCm: Number(form.widthCm),
          lengthCm: Number(form.lengthCm),
        }),
      );
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao cotar.');
    } finally {
      setCotando(false);
    }
  };

  return (
    <AppShell>
      <PageHeader
        breadcrumb={['E-commerce', 'Logística']}
        title="Logística"
        subtitle="Transportadoras, prontidão e cotação de conferência."
      />

      {erro && (
        <div
          role="alert"
          className="mb-5 px-4 py-3 rounded-[var(--gs-radius)] bg-[var(--gs-danger-bg)]
            text-[var(--gs-danger)]"
        >
          {erro}
        </div>
      )}

      {/*
        A tarja de estado vem primeiro e é grande. Sem credencial nenhuma
        cotação vale para cobrar do cliente, e essa é a informação que muda a
        decisão de quem abre a tela.
      */}
      {prontidao && (prontidao.checkoutCarrier?.active ?? !prontidao.productionBlocked) ? (
        <div
          role="status"
          className="mb-5 px-4 py-3 rounded-[var(--gs-radius)] border-2
            border-[var(--gs-success)] bg-[var(--gs-success-bg)] text-[var(--gs-success)]"
        >
          <strong className="block">TRANSPORTADORA NO CHECKOUT</strong>
          <span className="text-[length:var(--gs-text-sm)]">
            {prontidao.checkoutCarrier?.message
              ?? 'A cotação de produção vale como preço de frete no checkout.'}
          </span>
        </div>
      ) : prontidao ? (
        <div
          role="status"
          className="mb-5 px-4 py-3 rounded-[var(--gs-radius)] border-2
            border-[var(--gs-warning)] bg-[var(--gs-warning-bg)] text-[var(--gs-warning)]"
        >
          <strong className="block">CHECKOUT SEM TRANSPORTADORA</strong>
          <span className="block text-[length:var(--gs-text-sm)]">
            {prontidao.checkoutCarrier?.message
              ?? 'Nenhuma transportadora com token de produção: o checkout oferece só retirada e a tabela da loja.'}
          </span>
          <span className="block text-[length:var(--gs-text-sm)] mt-1">
            Cotação simulada ou de sandbox serve para conferir tamanho de caixa e ordem de
            grandeza, não para cobrar do cliente.
          </span>
        </div>
      ) : null}

      <Card>
        <h2 className="m-0 text-[length:var(--gs-text-lg)] font-semibold">De onde a mercadoria sai</h2>
        <p className="mt-2 mb-0">
          CEP de origem: <strong>{cepFormatado(prontidao?.originZip ?? null)}</strong>
        </p>
        <p className="mt-1 mb-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
          {/* Pedir o mesmo CEP em duas telas criaria duas verdades sobre o
              mesmo galpão. Ele vem da configuração fiscal da operação. */}
          Declarado em Fiscal → Configuração, junto do endereço do emitente.
        </p>
      </Card>

      <div className="mt-5">
        <CredencialMelhorEnvio
          status={transportadoras?.find((t) => t.carrier === 'melhor_envio')}
          onMudou={() => void carregar()}
        />
      </div>

      {/* O que vai na etiqueta: NF-e ou declaração (decisão do contador), e a
          agência Jadlog (GAP-PRD-120). */}
      <div className="mt-5">
        <ConfiguracaoDeEnvio />
      </div>

      <div className="mt-5">
        <Card padded={false}>
          <DataTable
            columns={[
              {
                header: 'Transportadora',
                render: (r: LogisticsCarrierStatus) =>
                  NOME_TRANSPORTADORA[r.carrier] ?? r.carrier,
              },
              {
                header: 'Credencial',
                render: (r: LogisticsCarrierStatus) => (
                  <Badge tone={r.configured ? 'success' : 'warning'}>
                    {r.configured ? 'Configurada' : 'Não configurada'}
                  </Badge>
                ),
              },
              {
                header: 'Ambiente',
                render: (r: LogisticsCarrierStatus) =>
                  !r.configured ? '—' : r.environment === 'production' ? 'Produção' : 'Sandbox',
              },
              {
                header: 'Conexão',
                render: (r: LogisticsCarrierStatus) => (
                  <span title={r.connection.message ?? ''}>{conexao(r)}</span>
                ),
              },
              {
                header: 'No checkout',
                render: (r: LogisticsCarrierStatus) => {
                  const v = noCheckout(r);
                  return v.tom === 'neutral' ? v.texto : <Badge tone={v.tom}>{v.texto}</Badge>;
                },
              },
            ]}
            rows={transportadoras ?? []}
            keyOf={(r) => r.carrier}
            empty={
              <EmptyState
                title="Nenhuma transportadora"
                description="As integradoras aparecem aqui assim que o módulo responder."
              />
            }
          />
        </Card>
      </div>

      {/* O que falta, por transportadora, na ordem de resolver. */}
      {prontidao?.providers.map((p) => (
        <div className="mt-5" key={p.carrier}>
          <Card>
            <h2 className="m-0 text-[length:var(--gs-text-lg)] font-semibold">
              {NOME_TRANSPORTADORA[p.carrier] ?? p.carrier}
            </h2>
            <ul className="list-none p-0 mt-3 mb-0 grid gap-2 sm:grid-cols-2">
              {p.items.map((i) => (
                <li key={i.key} className="flex items-start gap-2">
                  <Badge tone={TOM_ITEM[i.status] ?? 'neutral'}>{i.label}</Badge>
                  {i.message && (
                    <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                      {i.message}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </Card>
        </div>
      ))}

      <div className="mt-5">
        <Card>
          <h2 className="m-0 text-[length:var(--gs-text-lg)] font-semibold">Cotação de conferência</h2>
          <p className="mt-2 mb-4 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
            {/* SEM DEFAULT SILENCIOSO: antes o sistema assumia 500 g e uma caixa
                10x15x20. O transportador cobra pelo pacote real, e a diferença
                aparece depois, com a mercadoria já vendida. */}
            Peso e as três medidas são obrigatórios. O servidor recusa cotar pacote incompleto em
            vez de assumir uma caixa que ninguém mediu.
          </p>

          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="CEP de destino">
              {(p) => (
                <Input
                  {...p}
                  value={form.destinationZipCode}
                  inputMode="numeric"
                  onChange={(e) => setForm({ ...form, destinationZipCode: e.target.value })}
                />
              )}
            </Field>
            <Field label="Peso (g)">
              {(p) => (
                <Input
                  {...p}
                  value={form.weightGrams}
                  inputMode="numeric"
                  onChange={(e) => setForm({ ...form, weightGrams: e.target.value })}
                />
              )}
            </Field>
            <Field label="Altura (cm)">
              {(p) => (
                <Input
                  {...p}
                  value={form.heightCm}
                  inputMode="numeric"
                  onChange={(e) => setForm({ ...form, heightCm: e.target.value })}
                />
              )}
            </Field>
            <Field label="Largura (cm)">
              {(p) => (
                <Input
                  {...p}
                  value={form.widthCm}
                  inputMode="numeric"
                  onChange={(e) => setForm({ ...form, widthCm: e.target.value })}
                />
              )}
            </Field>
            <Field label="Comprimento (cm)">
              {(p) => (
                <Input
                  {...p}
                  value={form.lengthCm}
                  inputMode="numeric"
                  onChange={(e) => setForm({ ...form, lengthCm: e.target.value })}
                />
              )}
            </Field>
          </div>

          <div className="mt-4">
            <Button onClick={() => void cotar()} disabled={cotando}>
              {cotando ? 'Cotando…' : 'Cotar'}
            </Button>
          </div>

          {cotacao?.code === 'SHIPPING_DATA_REQUIRED' && (
            <div
              role="status"
              className="mt-4 px-4 py-3 rounded-[var(--gs-radius)] bg-[var(--gs-warning-bg)]
                text-[var(--gs-warning)]"
            >
              Não dá para cotar sem: {(cotacao.missing ?? []).join(', ')}.
            </div>
          )}

          {cotacao && cotacao.code !== 'SHIPPING_DATA_REQUIRED' && (
            <div className="mt-4">
              {/* Inventada pelo simulador: sem chamada a transportadora nenhuma. */}
              {(cotacao.options.some((o) => o.simulated === true && o.real !== true)
                || (cotacao.simulated && !cotacao.real)) && (
                <div
                  className="mb-3 px-4 py-3 rounded-[var(--gs-radius)] border-2
                    border-[var(--gs-warning)] bg-[var(--gs-warning-bg)]
                    text-[var(--gs-warning)]"
                >
                  <strong className="block">COTAÇÃO SIMULADA</strong>
                  <span className="text-[length:var(--gs-text-sm)]">
                    Estes valores não vieram de transportadora. Não use para cobrar do cliente.
                  </span>
                </div>
              )}
              {/* Real, mas do ambiente de teste: confere a integração e só. */}
              {cotacao.options.some((o) => o.environment === 'sandbox') && (
                <div
                  className="mb-3 px-4 py-3 rounded-[var(--gs-radius)] border-2
                    border-[var(--gs-warning)] bg-[var(--gs-warning-bg)]
                    text-[var(--gs-warning)]"
                >
                  <strong className="block">COTAÇÃO DE SANDBOX</strong>
                  <span className="text-[length:var(--gs-text-sm)]">
                    Vieram do ambiente de teste do Melhor Envio: provam que a integração responde,
                    mas não valem para cobrar — o checkout não os oferece.
                  </span>
                </div>
              )}
              {cotacao.message && (
                <p className="mt-0 mb-3 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                  {cotacao.message}
                </p>
              )}
              <ul className="list-none p-0 m-0">
                {cotacao.options.map((o, i) => (
                  <li
                    key={`${o.carrier}-${o.serviceCode ?? o.service ?? ''}-${i}`}
                    className="flex justify-between gap-4 py-2 border-t border-[var(--gs-border)]"
                  >
                    <span>
                      {/* O servidor manda `serviceName`; a tela lia `service`,
                          que nunca vinha — saía "Melhor Envio · undefined". */}
                      {NOME_TRANSPORTADORA[o.carrier] ?? o.carrier} ·{' '}
                      {o.serviceName ?? o.service ?? o.serviceCode ?? 'serviço'}
                      {o.estimatedDays ? ` · ${o.estimatedDays} dia(s)` : ''}
                    </span>
                    <strong>{formatCents(o.priceInCents)}</strong>
                  </li>
                ))}
              </ul>
              {cotacao.options.length === 0 && (
                <p className="m-0 text-[var(--gs-muted)]">Nenhuma opção retornada.</p>
              )}
            </div>
          )}
        </Card>
      </div>
    </AppShell>
  );
}
