/**
 * Configurações › Impressoras.
 *
 * Uma impressora por finalidade: cupom (58/80mm), etiqueta e A4. O documento
 * sai na impressora do tipo certo — sem isso o cupom de venda iria parar na
 * impressora de etiqueta e sairia picotado.
 *
 * HONESTIDADE DO TRANSPORTE: o navegador NÃO imprime em silêncio, ele abre a
 * caixa de diálogo do sistema. Impressão direta (e a gaveta por comando) é do
 * AGENTE LOCAL do caixa (GAP-PRD-082) — o mesmo programa que fala com o
 * PinPad. A impressora de agente diz em qual caixa mora e o endereço dela
 * naquele computador; a tela mostra, para cada uma, se o agente está no ar e
 * o que falta, e só o teste confirmado pelo agente faz a prontidão dizer
 * "impressão direta". Sem o agente, o cupom sai pelo navegador e o PDV diz
 * por quê — em vez de o operador esperar um papel que nunca vai sair sozinho.
 */
import { useCallback, useEffect, useState } from 'react';
import { prenderFoco } from '@/components/gs/armadilhaDeFoco';
import { AppShell } from '@/components/gs/AppShell';
import { Badge, Button, Card, EmptyState, Input, PageHeader } from '@/components/gs/ui';
import { useHasProfile } from '@/hooks/useSession';
import { ApiRequestError } from '@/lib/api/client';
import { coreApi, type Printer, type SituacaoDaImpressora } from '@/lib/api/core';
import { acompanharNoAgente, impressaoApi } from '@/lib/api/impressao';
import { terminaisApi, type TerminalDeCaixa } from '@/lib/api/terminais';

const TIPOS: { id: Printer['kind']; label: string; hint: string }[] = [
  { id: 'cupom', label: 'Cupom', hint: 'Comprovante do PDV e fechamento de caixa' },
  { id: 'etiqueta', label: 'Etiqueta', hint: 'Código de barras do produto e plaquinha da oficina' },
  { id: 'a4', label: 'A4', hint: 'Orçamento, pré-venda e ordem de serviço' },
];

const TRANSPORTE_LABEL: Record<Printer['transport'], string> = {
  browser: 'Navegador',
  agent: 'Agente local',
};

type Prontidao = Awaited<ReturnType<typeof coreApi.printReadiness>>;
type Acompanhamento = { intervaloMs?: number; prazoMs?: number };

function quando(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** O que o servidor diz do agente desta impressora: caixa, endereço, no ar, último teste. */
function SituacaoDoAgente({ s }: { s: SituacaoDaImpressora | undefined }) {
  if (!s || s.transport !== 'agent') return null;
  return (
    <div
      data-testid={`situacao-${s.printerId}`}
      className="w-full flex flex-col gap-0.5 text-[length:var(--gs-text-sm)]"
    >
      <span className="text-[var(--gs-text-soft)]">
        {s.pdvTerminalName ? `Caixa: ${s.pdvTerminalName}` : 'Agente da operação (sem caixa)'}
        {s.agentDevice ? ` · endereço ${s.agentDevice}` : ''}
      </span>
      {s.problem ? (
        <span className="font-semibold text-[var(--gs-warning)]">{s.problem}</span>
      ) : (
        <span className="font-semibold text-[var(--gs-success)]">
          Agente local no ar{s.agent?.lastSeenAt ? ` (último sinal ${quando(s.agent.lastSeenAt)})` : ''}.
        </span>
      )}
      {s.lastTest?.status === 'printed' && <span>Página de teste impressa em {quando(s.lastTest.at)}.</span>}
      {s.lastTest?.status === 'failed' && (
        <span className="text-[var(--gs-danger)]">Último teste falhou: {s.lastTest.error ?? 'sem motivo informado'}</span>
      )}
      {s.lastTest && !['printed', 'failed'].includes(s.lastTest.status) && (
        <span>Página de teste esperando o agente.</span>
      )}
      {!s.lastTest && !s.problem && (
        <span className="text-[var(--gs-text-soft)]">
          Ainda sem página de teste: imprima uma antes de contar com esta impressora no balcão.
        </span>
      )}
    </div>
  );
}

export default function ImpressorasPage({ acompanhamento }: { acompanhamento?: Acompanhamento } = {}) {
  const [impressoras, setImpressoras] = useState<Printer[] | null>(null);
  const [prontidao, setProntidao] = useState<Prontidao | null>(null);
  const [caixas, setCaixas] = useState<TerminalDeCaixa[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [editando, setEditando] = useState<Partial<Printer> | null>(null);
  const [testando, setTestando] = useState<string | null>(null);
  const podeGerir = useHasProfile('gerente_loja', 'gerente_oficina');

  const carregar = useCallback(async () => {
    setError(null);
    try {
      setImpressoras(await coreApi.listPrinters());
      setProntidao(await coreApi.printReadiness());
    } catch (err) {
      setImpressoras(null);
      setError(err instanceof ApiRequestError ? err.message : 'Falha ao carregar.');
    }
  }, []);

  useEffect(() => {
    void carregar();
    // Os caixas só servem ao cadastro da impressora de agente: sem eles, a
    // impressora fica "da operação" e a tela continua funcionando.
    void terminaisApi
      .listar(true)
      .then((lista) => setCaixas(Array.isArray(lista) ? lista : []))
      .catch(() => setCaixas([]));
  }, [carregar]);

  const salvar = useCallback(
    async (dados: Partial<Printer> & { isDefault?: boolean }) => {
      setError(null);
      setAviso(null);
      const deAgente = dados.transport === 'agent';
      try {
        await coreApi.savePrinter({
          id: dados.id,
          name: String(dados.name ?? ''),
          kind: (dados.kind ?? 'cupom') as Printer['kind'],
          transport: (dados.transport ?? 'browser') as Printer['transport'],
          paperWidthMm: dados.paper_width_mm ?? null,
          isDefault: dados.isDefault,
          active: dados.active !== 0,
          pdvTerminalId: deAgente ? (dados.pdv_terminal_id ?? null) : null,
          agentDevice: deAgente ? (dados.agent_device ?? null) : null,
        });
        setAviso(`"${dados.name}" salva.`);
        setEditando(null);
        await carregar();
      } catch (err) {
        setError(err instanceof ApiRequestError ? err.message : 'Falha ao salvar.');
      }
    },
    [carregar],
  );

  const testar = useCallback(
    async (p: Printer) => {
      setTestando(p.id);
      setError(null);
      setAviso(null);
      try {
        const job = await impressaoApi.testarImpressora(p.id);
        const final = await acompanharNoAgente(job.id, { prazoMs: 30_000, ...acompanhamento });
        if (final.status === 'printed') {
          setAviso(`Página de teste impressa em "${p.name}". Esta impressora está confirmada para o balcão.`);
        } else if (final.status === 'failed') {
          setError(`A página de teste não saiu em "${p.name}": ${final.error ?? 'o agente não conseguiu imprimir'}.`);
        } else {
          setError('O agente não confirmou a página de teste. Confira a impressora e o agente do caixa.');
        }
      } catch (err) {
        setError(err instanceof ApiRequestError ? err.message : 'Falha ao pedir a página de teste.');
      } finally {
        setTestando(null);
        // Só a prontidão volta: recarregar tudo apagaria a frase do erro que
        // acabou de ser mostrada — justamente o motivo da recusa.
        try {
          setProntidao(await coreApi.printReadiness());
        } catch {
          // Fica a leitura anterior; o aviso do teste já está na tela.
        }
      }
    },
    [acompanhamento],
  );

  const situacaoDe = (id: string) => prontidao?.printers?.find((s) => s.printerId === id);

  return (
    <AppShell>
      <PageHeader
        breadcrumb={['Configurações', 'Impressoras']}
        title="Impressoras"
        subtitle="Uma por finalidade. O documento sai na impressora do tipo certo."
        actions={
          // Criar, editar e tornar padrão são de quem GERE a impressão. O
          // estoquista e o atendente veem a lista (settings.printers.view), e
          // os botões lhes prometiam o que o servidor recusava com 403.
          podeGerir ? (
            <Button onClick={() => setEditando({ kind: 'cupom', transport: 'browser' })}>
              Nova impressora
            </Button>
          ) : undefined
        }
      />

      {aviso && (
        <div
          role="status"
          className="mb-5 px-4 py-3 rounded-[var(--gs-radius)] bg-[var(--gs-success-bg)] text-[var(--gs-success)]"
        >
          {aviso}
        </div>
      )}
      {error && (
        <div
          role="alert"
          className="mb-5 px-4 py-3 rounded-[var(--gs-radius)] bg-[var(--gs-danger-bg)] text-[var(--gs-danger)]"
        >
          {error}
        </div>
      )}

      {/* O que o sistema consegue fazer hoje, dito sem enfeite. */}
      {prontidao && (
        <Card className="mb-6">
          <div className="flex flex-col gap-2">
            <Badge
              tone={
                prontidao.readiness === 'AGENT_READY'
                  ? 'success'
                  : prontidao.readiness === 'BROWSER_ONLY'
                    ? 'warning'
                    : 'neutral'
              }
            >
              {prontidao.readiness}
            </Badge>
            <p className="text-[length:var(--gs-text-base)]">{prontidao.message}</p>
          </div>
        </Card>
      )}

      <div className="flex flex-col gap-6">
        {TIPOS.map((tipo) => {
          const doTipo = (impressoras ?? []).filter((p) => p.kind === tipo.id);
          return (
            <Card key={tipo.id} title={tipo.label} subtitle={tipo.hint} padded={false}>
              {impressoras === null ? (
                <p role="status" className="px-6 py-5 text-[var(--gs-muted)]">
                  {error ? 'Não foi possível carregar.' : 'Carregando…'}
                </p>
              ) : doTipo.length === 0 ? (
                <div className="px-6 py-5">
                  <EmptyState
                    title={`Nenhuma impressora de ${tipo.label.toLowerCase()}`}
                    description={`Sem uma configurada, ${tipo.hint.toLowerCase()} sai pela impressora que o navegador escolher na caixa de diálogo.`}
                  />
                </div>
              ) : (
                <ul className="divide-y divide-[var(--gs-border)]">
                  {doTipo.map((p) => (
                    <li key={p.id} className="px-6 py-4 flex items-center justify-between gap-4 flex-wrap">
                      <span className="flex items-center gap-3 flex-wrap">
                        <strong className="text-[var(--gs-purple-900)]">{p.name}</strong>
                        {p.is_default === 1 && <Badge tone="success">Padrão</Badge>}
                        {p.active === 0 && <Badge>Inativa</Badge>}
                        <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
                          {TRANSPORTE_LABEL[p.transport]}
                          {p.paper_width_mm ? ` · ${p.paper_width_mm}mm` : ''}
                        </span>
                      </span>
                      <span className="flex gap-1">
                        {p.transport === 'agent' && podeGerir && (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={testando !== null}
                            onClick={() => void testar(p)}
                          >
                            {testando === p.id ? 'Esperando o agente…' : 'Imprimir teste'}
                          </Button>
                        )}
                        {podeGerir && p.is_default !== 1 && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => void salvar({ ...p, isDefault: true })}
                          >
                            Tornar padrão
                          </Button>
                        )}
                        {podeGerir && (
                          <Button size="sm" variant="ghost" onClick={() => setEditando(p)}>
                            Editar
                          </Button>
                        )}
                      </span>
                      <SituacaoDoAgente s={situacaoDe(p.id)} />
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          );
        })}
      </div>

      {editando && (
        <ImpressoraDialog
          inicial={editando}
          caixas={caixas}
          onClose={() => setEditando(null)}
          onSalvar={(dados) => void salvar(dados)}
        />
      )}
    </AppShell>
  );
}

function ImpressoraDialog({
  inicial,
  caixas,
  onClose,
  onSalvar,
}: {
  inicial: Partial<Printer>;
  caixas: TerminalDeCaixa[];
  onClose: () => void;
  onSalvar: (dados: Partial<Printer> & { isDefault?: boolean }) => void;
}) {
  const [name, setName] = useState(inicial.name ?? '');
  const [kind, setKind] = useState<Printer['kind']>(inicial.kind ?? 'cupom');
  // Só o cupom imprime pelo agente (ESC/POS). A impressora de etiqueta ou A4
  // cadastrada "de agente" antes desta trava abre como navegador — que é por
  // onde ela sempre imprimiu de fato.
  const [transport, setTransport] = useState<Printer['transport']>(
    (inicial.kind ?? 'cupom') === 'cupom' ? (inicial.transport ?? 'browser') : 'browser',
  );
  const [largura, setLargura] = useState(String(inicial.paper_width_mm ?? ''));
  const [padrao, setPadrao] = useState(inicial.is_default === 1);
  const [ativa, setAtiva] = useState(inicial.active !== 0);
  const [caixa, setCaixa] = useState(inicial.pdv_terminal_id ?? '');
  const [endereco, setEndereco] = useState(inicial.agent_device ?? '');

  const deAgente = transport === 'agent';
  const podeSalvar = Boolean(name.trim()) && (!deAgente || Boolean(endereco.trim()));

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
      role="dialog"
      aria-modal="true"
      ref={prenderFoco}
      tabIndex={-1}
      aria-label={inicial.id ? 'Editar impressora' : 'Nova impressora'}
    >
      <div className="w-full max-w-lg rounded-[var(--gs-radius-lg)] bg-[var(--gs-surface)] shadow-2xl">
        <header className="px-6 py-4 border-b border-[var(--gs-border)]">
          <h2 className="text-[length:var(--gs-text-lg)] font-bold text-[var(--gs-purple-900)]">
            {inicial.id ? 'Editar impressora' : 'Nova impressora'}
          </h2>
        </header>

        <form
          className="px-6 py-5 flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            onSalvar({
              id: inicial.id,
              name,
              kind,
              transport,
              paper_width_mm: largura ? Number(largura) : null,
              isDefault: padrao,
              active: ativa ? 1 : 0,
              pdv_terminal_id: caixa || null,
              agent_device: endereco.trim() || null,
            });
          }}
        >
          <label className="flex flex-col gap-1.5">
            <span className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-text-soft)]">
              Nome
            </span>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ex.: Cupom do balcão"
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-text-soft)]">
              Finalidade
            </span>
            <select
              value={kind}
              onChange={(e) => {
                const k = e.target.value as Printer['kind'];
                setKind(k);
                if (k !== 'cupom') setTransport('browser');
              }}
              className="h-11 px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border)] bg-white"
            >
              {TIPOS.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label} — {t.hint}
                </option>
              ))}
            </select>
          </label>

          {kind === 'cupom' && (
            <label className="flex flex-col gap-1.5">
              <span className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-text-soft)]">
                Largura do papel
              </span>
              <select
                value={largura}
                onChange={(e) => setLargura(e.target.value)}
                className="h-11 px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border)] bg-white"
              >
                <option value="">Não informada</option>
                <option value="58">58 mm</option>
                <option value="80">80 mm</option>
              </select>
            </label>
          )}

          <label className="flex flex-col gap-1.5">
            <span className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-text-soft)]">
              Como imprime
            </span>
            <select
              aria-label="Como imprime"
              value={transport}
              onChange={(e) => setTransport(e.target.value as Printer['transport'])}
              className="h-11 px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border)] bg-white"
            >
              <option value="browser">Navegador — abre a caixa de diálogo do sistema</option>
              {/*
                O agente fala ESC/POS, a língua da térmica de cupom. Oferecê-lo
                para etiqueta fazia a página de teste sair como lixo numa Argox
                PPLA ou numa Zebra ZPL — e a prontidão ainda dizia "impressão
                direta" para uma impressora que nunca recebe etiqueta pelo agente.
              */}
              {kind === 'cupom' && (
                <option value="agent">Agente local — impressão direta e gaveta por comando</option>
              )}
            </select>
            {kind !== 'cupom' && (
              <span className="text-[length:var(--gs-text-xs)] text-[var(--gs-text-soft)]">
                {kind === 'etiqueta' ? 'A etiqueta' : 'O A4'} sai pelo driver da impressora instalada no computador, no
                diálogo de impressão do sistema. O agente local só fala com a impressora de cupom.
              </span>
            )}
          </label>

          {deAgente && (
            <>
              <label className="flex flex-col gap-1.5">
                <span className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-text-soft)]">
                  Caixa (o computador onde o agente roda)
                </span>
                <select
                  aria-label="Caixa da impressora"
                  value={caixa}
                  onChange={(e) => setCaixa(e.target.value)}
                  className="h-11 px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border)] bg-white"
                >
                  <option value="">Operação inteira — o agente sem caixa</option>
                  {caixas.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-text-soft)]">
                  Endereço da impressora nesse computador
                </span>
                <Input
                  aria-label="Endereço da impressora"
                  value={endereco}
                  onChange={(e) => setEndereco(e.target.value)}
                  placeholder="tcp:192.168.0.50:9100"
                />
                <span className="text-[length:var(--gs-text-xs)] text-[var(--gs-text-soft)]">
                  Impressora de rede: tcp:IP:9100. USB compartilhada no Windows: \\CAIXA1\CUPOM (fila
                  &quot;Genérico / Somente texto&quot;). Serial: COM3. Paralela: LPT1.
                </span>
              </label>
              {/* O que faz o cupom sair sozinho, e o que acontece sem ele. */}
              <span className="text-[length:var(--gs-text-xs)] font-semibold text-[var(--gs-text-soft)]">
                Quem imprime é o agente local deste caixa — o mesmo programa da maquininha, pareado em
                Configurações › Maquininhas › Agente local (use --sem-tef se o caixa não tiver PinPad). Sem ele
                no ar, o cupom sai pelo navegador e o PDV diz por quê.
              </span>
            </>
          )}

          <div className="flex flex-col gap-2">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={padrao} onChange={(e) => setPadrao(e.target.checked)} />
              <span className="text-[length:var(--gs-text-sm)] font-semibold">
                Padrão para esta finalidade
              </span>
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={ativa} onChange={(e) => setAtiva(e.target.checked)} />
              <span className="text-[length:var(--gs-text-sm)] font-semibold">Ativa</span>
            </label>
          </div>

          <div className="flex justify-end gap-3">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancelar
            </Button>
            <Button type="submit" disabled={!podeSalvar}>
              Salvar
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
