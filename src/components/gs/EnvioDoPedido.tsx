/**
 * O ENVIO DO PEDIDO, na ficha do pedido (GAP-PRD-120, GAP-PRD-119).
 *
 * Antes a expedição era um código digitado num `window.prompt`, e a etiqueta
 * era comprada e impressa fora do sistema. Aqui:
 *
 *   - a PRONTIDÃO do servidor diz o que falta para comprar a etiqueta (token,
 *     medidas, endereço do remetente, NF-e), com o link da tela que resolve;
 *   - o operador CONFIRMA o destinatário (o endereço do pedido é texto livre;
 *     a separação em rua/número/bairro é só sugestão) e compra — com uma
 *     pergunta antes, porque a etiqueta é paga com o saldo da carteira;
 *   - cada envio mostra o estado, o código com o link da transportadora, a
 *     última consulta de rastreio (e a FALHA dela, quando houve) e os eventos
 *     com a origem: "pela transportadora" ou "pela loja (nome)".
 *
 * O que a tela pode oferecer em cada envio vem do servidor (`actions`): ela
 * não mantém uma segunda cópia das regras de estado.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Button, Card, Field, Input } from '@/components/gs/ui';
import { formatCents } from '@/components/gs/format';
import { ApiRequestError } from '@/lib/api/client';
import {
  enviosApi,
  type Destinatario,
  type Envio,
  type EstadoDoEnvio,
  type PendenciaDoEnvio,
  type ProntidaoDaEtiqueta,
  type ServicoCotado,
} from '@/lib/api/envios';

const TOM: Record<EstadoDoEnvio, 'neutral' | 'success' | 'warning' | 'info' | 'danger'> = {
  pendente: 'warning',
  paga: 'warning',
  etiqueta_gerada: 'info',
  postado: 'info',
  entregue: 'success',
  nao_entregue: 'danger',
  cancelado: 'neutral',
};

const VAZIO: Destinatario = {
  nome: '',
  documento: '',
  telefone: '',
  email: '',
  logradouro: '',
  numero: '',
  complemento: '',
  bairro: '',
  cidade: '',
  uf: '',
  cep: '',
};

function quando(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

/** Quem disse: a transportadora, ou a loja — e quem na loja. */
function origemDoEvento(origem: string, nome?: string | null): string {
  if (origem === 'provedor') return 'pela transportadora';
  if (origem === 'operador') return nome ? `pela loja (${nome})` : 'pela loja';
  return 'pelo sistema';
}

function mensagemDe(err: unknown, padrao: string): string {
  if (!(err instanceof ApiRequestError)) return padrao;
  const faltando = (err.details as { faltando?: PendenciaDoEnvio[] } | undefined)?.faltando;
  return faltando?.length ? faltando.map((f) => f.mensagem).join(' ') : err.message;
}

function CartaoDoEnvio({ envio, onMudou }: { envio: Envio; onMudou: () => void }) {
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [cancelando, setCancelando] = useState(false);
  const [motivo, setMotivo] = useState('');

  const executar = async (acao: () => Promise<string | null>, padrao: string) => {
    setOcupado(true);
    setErro(null);
    setAviso(null);
    try {
      const msg = await acao();
      if (msg) setAviso(msg);
    } catch (err) {
      setErro(mensagemDe(err, padrao));
    } finally {
      setOcupado(false);
      onMudou();
    }
  };

  return (
    <li className="py-3 border-t border-[var(--gs-border)] first:border-t-0" data-testid={`envio-${envio.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={TOM[envio.status] ?? 'neutral'}>{envio.statusLabel}</Badge>
        <strong>{envio.carrierName ?? envio.carrier}</strong>
        {envio.serviceName && <span className="text-[var(--gs-muted)]">· {envio.serviceName}</span>}
        {envio.environment === 'sandbox' && (
          <Badge tone="warning">SANDBOX — etiqueta de teste, sem valor na agência</Badge>
        )}
        {envio.channel === 'manual' && <Badge tone="neutral">Registrado no despacho</Badge>}
        {envio.priceCents !== null && <span>{formatCents(envio.priceCents)}</span>}
      </div>

      <p className="mt-2 mb-0 text-[length:var(--gs-text-sm)]">
        {envio.trackingCode ? (
          <>
            Rastreio: <span className="font-mono">{envio.trackingCode}</span>
            {envio.trackingUrl && (
              <>
                {' · '}
                <a href={envio.trackingUrl} target="_blank" rel="noreferrer" className="text-[var(--gs-purple-700)]">
                  Acompanhar na transportadora
                </a>
              </>
            )}
          </>
        ) : (
          <span className="text-[var(--gs-muted)]">Ainda sem código de rastreio.</span>
        )}
        {envio.deliveredAt && (
          <span className="block">
            Entregue em {quando(envio.deliveredAt)}{' '}
            {envio.deliveredOrigin === 'provedor' ? '— confirmado pela transportadora' : '— marcado pela loja'}
          </span>
        )}
      </p>

      {envio.lastError && (
        <p role="alert" className="mt-2 mb-0 text-[length:var(--gs-text-sm)] text-[var(--gs-danger)]">
          {envio.lastError}
        </p>
      )}
      {envio.lastSync && (
        envio.lastSync.ok ? (
          <p className="mt-1 mb-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
            Rastreio consultado em {quando(envio.lastSync.at)}.
          </p>
        ) : (
          <p role="alert" className="mt-1 mb-0 text-[length:var(--gs-text-sm)] text-[var(--gs-warning)]">
            A última consulta ao provedor falhou ({quando(envio.lastSync.at)}): {envio.lastSync.message}
          </p>
        )
      )}

      {envio.events.length > 0 && (
        <ul className="mt-2 mb-0 pl-5 text-[length:var(--gs-text-sm)]">
          {envio.events.map((ev, i) => (
            <li key={`${ev.occurredAt}-${i}`}>
              {quando(ev.occurredAt)} — {ev.description}{' '}
              <span className="text-[var(--gs-muted)]">({origemDoEvento(ev.origin, ev.userName)})</span>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        {envio.actions.pagarEGerar && (
          <Button
            size="sm"
            loading={ocupado}
            onClick={() =>
              void executar(async () => {
                const r = await enviosApi.continuar(envio.id);
                return r.aviso ?? 'Etiqueta gerada.';
              }, 'Não foi possível retomar a compra.')
            }
          >
            Tentar de novo (pagar e gerar)
          </Button>
        )}
        {envio.actions.imprimir && (
          <Button
            size="sm"
            variant="secondary"
            disabled={ocupado}
            onClick={() =>
              void executar(async () => {
                setLink((await enviosApi.linkDaEtiqueta(envio.id)).url);
                return null;
              }, 'Não foi possível pedir o link da etiqueta.')
            }
          >
            Imprimir etiqueta
          </Button>
        )}
        {envio.actions.sincronizar && (
          <Button
            size="sm"
            variant="secondary"
            disabled={ocupado}
            onClick={() =>
              void executar(async () => {
                const r = await enviosApi.atualizarRastreio(envio.id);
                return r.lastSync?.ok ? 'Rastreio atualizado.' : null;
              }, 'Não foi possível consultar o rastreio.')
            }
          >
            Atualizar rastreio
          </Button>
        )}
        {envio.actions.cancelar && !cancelando && (
          <Button size="sm" variant="ghost" disabled={ocupado} onClick={() => setCancelando(true)}>
            Cancelar etiqueta
          </Button>
        )}
      </div>

      {link && (
        <p className="mt-2 mb-0">
          <a href={link} target="_blank" rel="noreferrer" className="text-[var(--gs-purple-700)] font-semibold">
            Abrir a etiqueta para imprimir
          </a>
        </p>
      )}

      {cancelando && (
        <div className="mt-3 px-4 py-3 rounded-[var(--gs-radius)] border border-[var(--gs-warning)] bg-[var(--gs-warning-bg)] flex flex-col gap-3">
          <Field label="Motivo do cancelamento" hint="O valor volta para a carteira do Melhor Envio.">
            {(p) => <Input {...p} value={motivo} onChange={(e) => setMotivo(e.target.value)} />}
          </Field>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="danger"
              disabled={ocupado || motivo.trim().length < 3}
              onClick={() =>
                void executar(async () => {
                  await enviosApi.cancelar(envio.id, motivo.trim());
                  setCancelando(false);
                  return 'Etiqueta cancelada.';
                }, 'Não foi possível cancelar a etiqueta.')
              }
            >
              Sim, cancelar
            </Button>
            <Button size="sm" variant="ghost" disabled={ocupado} onClick={() => setCancelando(false)}>
              Voltar
            </Button>
          </div>
        </div>
      )}

      {aviso && (
        <p role="status" className="mt-2 mb-0 text-[length:var(--gs-text-sm)] text-[var(--gs-success)]">
          {aviso}
        </p>
      )}
      {erro && (
        <p role="alert" className="mt-2 mb-0 text-[length:var(--gs-text-sm)] text-[var(--gs-danger)]">
          {erro}
        </p>
      )}
    </li>
  );
}

const CAMPOS: { chave: keyof Destinatario; rotulo: string }[] = [
  { chave: 'nome', rotulo: 'Nome' },
  { chave: 'documento', rotulo: 'CPF ou CNPJ' },
  { chave: 'telefone', rotulo: 'Telefone' },
  { chave: 'email', rotulo: 'E-mail' },
  { chave: 'logradouro', rotulo: 'Rua' },
  { chave: 'numero', rotulo: 'Número' },
  { chave: 'complemento', rotulo: 'Complemento' },
  { chave: 'bairro', rotulo: 'Bairro' },
  { chave: 'cidade', rotulo: 'Cidade' },
  { chave: 'uf', rotulo: 'UF' },
  { chave: 'cep', rotulo: 'CEP' },
];

/** O formulário parte da sugestão do servidor; campo ausente vira vazio. */
function preencher(pronto: ProntidaoDaEtiqueta): Destinatario {
  const s = pronto.destinatarioSugerido;
  return {
    ...VAZIO,
    ...Object.fromEntries(Object.entries(s).map(([k, v]) => [k, v ?? ''])),
  } as Destinatario;
}

function CompraDaEtiqueta({
  orderId,
  pronto,
  onComprou,
}: {
  orderId: string;
  pronto: ProntidaoDaEtiqueta;
  onComprou: () => void;
}) {
  const [destinatario, setDestinatario] = useState<Destinatario>(() => preencher(pronto));
  const [servicos, setServicos] = useState<ServicoCotado[] | null>(null);
  const [servico, setServico] = useState<{ code: string; name: string } | null>(pronto.servico);
  const [confirmando, setConfirmando] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  // A sugestão do servidor preenche o formulário; quem confirma é o operador.
  // O `useState` acima já parte da sugestão da montagem: refazer isso no efeito
  // da montagem corria contra a primeira digitação (o efeito roda depois do
  // DOM aparecer e apagava o que o operador já tinha corrigido). Só uma
  // prontidão NOVA do servidor — depois de comprar ou recarregar — repreenche.
  const sugestaoAplicada = useRef(pronto);
  useEffect(() => {
    if (sugestaoAplicada.current === pronto) return;
    sugestaoAplicada.current = pronto;
    setDestinatario(preencher(pronto));
    setServico(pronto.servico);
  }, [pronto]);

  const cotar = async () => {
    setOcupado(true);
    setErro(null);
    try {
      const r = await enviosApi.servicos(orderId);
      setServicos(r.options);
      if (r.options.length === 0) setErro(r.message ?? 'Nenhum serviço disponível para este pacote.');
    } catch (err) {
      setErro(mensagemDe(err, 'Não foi possível cotar os serviços.'));
    } finally {
      setOcupado(false);
    }
  };

  const comprar = async () => {
    setOcupado(true);
    setErro(null);
    try {
      const r = await enviosApi.comprarEtiqueta(orderId, { destinatario, servico });
      setConfirmando(false);
      if (r.aviso) setErro(r.aviso);
      onComprou();
    } catch (err) {
      setErro(mensagemDe(err, 'Não foi possível comprar a etiqueta.'));
    } finally {
      setOcupado(false);
    }
  };

  const escolhido = servicos?.find((s) => s.code === servico?.code);

  return (
    <div className="mt-4 flex flex-col gap-3" data-testid="compra-da-etiqueta">
      <h3 className="m-0 text-[length:var(--gs-text-base)] font-semibold">Comprar etiqueta no Melhor Envio</h3>
      {pronto.canal.ambiente === 'sandbox' && (
        <p className="m-0 px-3 py-2 rounded-[var(--gs-radius)] bg-[var(--gs-warning-bg)] text-[length:var(--gs-text-sm)] text-[var(--gs-warning)]">
          Token de SANDBOX: a etiqueta sai do ambiente de teste do Melhor Envio e não vale na agência.
        </p>
      )}
      <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
        {pronto.nota
          ? `A NF-e nº ${pronto.nota.numero} vai na etiqueta.`
          : 'Sem NF-e: a etiqueta sai com declaração de conteúdo (decisão ligada em Loja → Logística).'}
        {pronto.remetente && ` Sai de ${pronto.remetente.cidade}/${pronto.remetente.uf}.`}
      </p>

      <div className="grid gap-3 sm:grid-cols-3">
        {CAMPOS.map((c) => (
          <Field key={c.chave} label={c.rotulo}>
            {(p) => (
              <Input
                {...p}
                value={destinatario[c.chave]}
                onChange={(e) => setDestinatario({ ...destinatario, [c.chave]: e.target.value })}
              />
            )}
          </Field>
        ))}
      </div>

      <div className="flex flex-wrap items-end gap-3">
        {pronto.servico ? (
          <p className="m-0">
            Serviço vendido no checkout: <strong>{pronto.servico.name}</strong>
          </p>
        ) : servicos && servicos.length > 0 ? (
          <Field label="Serviço">
            {(p) => (
              <select
                {...p}
                value={servico?.code ?? ''}
                onChange={(e) => {
                  const s = servicos.find((x) => x.code === e.target.value);
                  setServico(s ? { code: s.code, name: s.name } : null);
                }}
                className="h-10 px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)]
                  bg-[var(--gs-surface)] text-[var(--gs-text)]"
              >
                <option value="">Escolha…</option>
                {servicos.map((s) => (
                  <option key={s.code} value={s.code}>
                    {s.name} — {formatCents(s.priceCents)}
                    {s.estimatedDays ? ` — ${s.estimatedDays} dia(s)` : ''}
                  </option>
                ))}
              </select>
            )}
          </Field>
        ) : (
          <Button variant="secondary" loading={ocupado} onClick={() => void cotar()}>
            Cotar serviços para este pedido
          </Button>
        )}
      </div>

      {!confirmando ? (
        <div>
          <Button disabled={ocupado || !servico} onClick={() => setConfirmando(true)}>
            Comprar etiqueta
          </Button>
        </div>
      ) : (
        <div className="px-4 py-3 rounded-[var(--gs-radius)] border border-[var(--gs-warning)] bg-[var(--gs-warning-bg)] flex flex-col gap-3">
          <span className="text-[length:var(--gs-text-sm)]">
            Comprar a etiqueta de <strong>{servico?.name}</strong>
            {escolhido ? ` por ${formatCents(escolhido.priceCents)}` : ''}? O valor sai do saldo da carteira do
            Melhor Envio.
          </span>
          <div className="flex gap-2">
            <Button loading={ocupado} onClick={() => void comprar()}>
              Sim, comprar
            </Button>
            <Button variant="ghost" disabled={ocupado} onClick={() => setConfirmando(false)}>
              Voltar
            </Button>
          </div>
        </div>
      )}

      {erro && (
        <p role="alert" className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-danger)]">
          {erro}
        </p>
      )}
    </div>
  );
}

export function EnvioDoPedido({ orderId, onMudou }: { orderId: string; onMudou?: () => void }) {
  const [dados, setDados] = useState<{ readiness: ProntidaoDaEtiqueta; items: Envio[] } | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    setErro(null);
    try {
      setDados(await enviosApi.doPedido(orderId));
    } catch (err) {
      setDados(null);
      setErro(err instanceof ApiRequestError ? err.message : 'Não foi possível consultar o envio.');
    }
  }, [orderId]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const mudou = () => {
    void carregar();
    onMudou?.();
  };

  const pronto = dados?.readiness;
  const bloqueios = pronto?.faltando ?? [];
  // A compra só aparece quando o pedido está no ponto de ser enviado e não há
  // envio vivo; o que falta de FORA do formulário vem da prontidão. Pedido já
  // despachado, parado ou de retirada não tem etiqueta a comprar — e dizer
  // "falta: o pedido já saiu" seria ruído.
  const foraDeHora = bloqueios.some((f) => ['despachado', 'parado', 'retirada'].includes(f.chave));
  const podeTerCompra = pronto && pronto.pedido.entrega && !pronto.envioVivo && !foraDeHora;

  return (
    <Card>
      <h2 className="m-0 text-[length:var(--gs-text-lg)] font-semibold">Envio</h2>
      {!dados && !erro && (
        <p role="status" className="mt-2 mb-0 text-[var(--gs-muted)]">
          Consultando o envio…
        </p>
      )}
      {erro && (
        <p role="alert" className="mt-2 mb-0 text-[var(--gs-danger)]">
          {erro}
        </p>
      )}

      {dados && dados.items.length > 0 && (
        <ul className="list-none p-0 mt-3 mb-0">
          {dados.items.map((e) => (
            <CartaoDoEnvio key={e.id} envio={e} onMudou={mudou} />
          ))}
        </ul>
      )}

      {podeTerCompra && bloqueios.length > 0 && (
        <div className="mt-3" data-testid="envio-o-que-falta">
          <p className="mt-0 mb-1">Para comprar a etiqueta, falta:</p>
          <ul className="m-0 pl-5 text-[length:var(--gs-text-sm)]">
            {bloqueios.map((f) => (
              <li key={f.chave}>
                {f.mensagem}
                {f.onde && (
                  <>
                    {' '}
                    <Link to={f.onde} className="text-[var(--gs-purple-700)]">
                      Resolver
                    </Link>
                  </>
                )}
              </li>
            ))}
          </ul>
          <p className="mt-2 mb-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
            Postou por fora (agência, motoboy)? Despache pelo botão da lista informando quem leva e o código.
          </p>
        </div>
      )}

      {podeTerCompra && bloqueios.length === 0 && pronto && (
        <CompraDaEtiqueta orderId={orderId} pronto={pronto} onComprou={mudou} />
      )}
    </Card>
  );
}
