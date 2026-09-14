/**
 * ============================================================================
 * MAQUININHAS — Configurações › Maquininhas (GAP-PRD-076, sobre o GAP-PRD-014)
 * ============================================================================
 *
 * ## O que faltava
 *
 * O módulo de maquininha tinha rotas e nenhuma tela: cadastrar o aparelho,
 * guardar credencial, testar a conexão, parear o agente local, acompanhar a
 * homologação, ver as cobranças e a fila de comandos exigiam `curl` com
 * Idempotency-Key. Para qualquer passo de maquininha, "chamar o
 * desenvolvedor".
 *
 * ## O que o gerente faz aqui, na ordem em que a instalação acontece
 *
 * 1. PRONTIDÃO: o que falta, dito pelo nome (sem agente, agente fora do ar,
 *    cliente TEF sem resposta, homologação incompleta).
 * 2. MAQUININHAS: cadastra (provedor, caixa, nome do PinPad), edita, guarda a
 *    credencial no cofre, testa a conexão, liga e desliga com motivo. O
 *    caminho "pela nuvem da adquirente" aparece com o motivo de não existir —
 *    a tela não oferece o que o servidor recusa.
 * 3. AGENTE LOCAL: gera o código de pareamento (uso único, dez minutos) para
 *    o computador de um caixa, vê cada agente — último sinal, cliente TEF,
 *    PinPad — e revoga com motivo.
 * 4. HOMOLOGAÇÃO: a lista de operações reais que provam a maquininha, marcada
 *    pela evidência (a cobrança que aconteceu), nunca por um botão.
 * 5. COBRANÇAS: comprovante, segunda via, cancelar/estornar (pelo aparelho) e
 *    "consultar no aparelho" a cobrança não confirmada.
 * 6. FILA: os comandos que o agente não retirou ou não respondeu a tempo.
 *
 * O alcance é o do servidor: gerente de loja/oficina, admin e gestor.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { prenderFoco } from '@/components/gs/armadilhaDeFoco';
import { AppShell } from '@/components/gs/AppShell';
import { Badge, Button, Card, EmptyState, Input, PageHeader } from '@/components/gs/ui';
import { formatCents } from '@/components/gs/format';
import { ApiRequestError } from '@/lib/api/client';
import { dataHoraBR } from '@/lib/datas';
import { terminaisApi, type TerminalDeCaixa } from '@/lib/api/terminais';
import {
  maquininhasApi,
  NOME_DO_PROVEDOR,
  ROTULO_DA_PRONTIDAO,
  type AgenteLocal,
  type CobrancaDaMaquininha,
  type CodigoDePareamento,
  type ComandoDoAgente,
  type Comprovante,
  type ConfiguracaoDeMaquininha,
  type MaquininhasDaOperacao,
  type PainelDaMaquininha,
  type ProntidaoDasMaquininhas,
} from '@/lib/api/maquininhas';

const mensagemDe = (err: unknown, padrao: string) =>
  err instanceof ApiRequestError ? err.message : padrao;

const PROVEDORES_REAIS = ['stone', 'cielo', 'rede', 'getnet', 'pagbank', 'mercado_pago', 'generic_tef'];

const CLASSE_SELECT =
  'px-3 py-2 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)] bg-[var(--gs-surface)]';

function Rotulo({ children }: { children: ReactNode }) {
  return (
    <span className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-text-soft)]">{children}</span>
  );
}

function Aviso({ tipo, children }: { tipo: 'ok' | 'erro' | 'atencao'; children: ReactNode }) {
  const estilo =
    tipo === 'ok'
      ? 'bg-[var(--gs-success-bg)] text-[var(--gs-success)]'
      : tipo === 'erro'
        ? 'bg-[var(--gs-danger-bg)] text-[var(--gs-danger)]'
        : 'border border-[var(--gs-warning)] bg-[var(--gs-warning-bg)] text-[var(--gs-warning)]';
  return (
    <div role={tipo === 'ok' ? 'status' : 'alert'} className={`mb-4 px-4 py-3 rounded-[var(--gs-radius)] ${estilo}`}>
      {children}
    </div>
  );
}

function Dialogo({
  titulo,
  children,
  onClose,
}: {
  titulo: string;
  children: ReactNode;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
      role="dialog"
      aria-modal="true"
      ref={prenderFoco}
      tabIndex={-1}
      aria-label={titulo}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      <div className="w-full max-w-xl rounded-[var(--gs-radius-lg)] bg-[var(--gs-surface)] shadow-2xl max-h-[90vh] overflow-y-auto">
        <header className="px-6 py-4 border-b border-[var(--gs-border)]">
          <h2 className="text-[length:var(--gs-text-lg)] font-bold text-[var(--gs-purple-900)] m-0">{titulo}</h2>
        </header>
        <div className="px-6 py-5 flex flex-col gap-4">{children}</div>
      </div>
    </div>
  );
}

/** Pede um motivo antes de uma ação que fica na auditoria. */
function DialogoDeMotivo({
  titulo,
  explicacao,
  rotulo,
  exemplo,
  confirmar,
  perigo,
  extra,
  onClose,
  onConfirmar,
}: {
  titulo: string;
  explicacao: string;
  rotulo: string;
  exemplo: string;
  confirmar: string;
  perigo?: boolean;
  extra?: ReactNode;
  onClose: () => void;
  onConfirmar: (motivo: string) => Promise<void>;
}) {
  const [motivo, setMotivo] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  return (
    <Dialogo titulo={titulo} onClose={onClose}>
      <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)] m-0">{explicacao}</p>
      {extra}
      <label className="flex flex-col gap-1.5">
        <Rotulo>{rotulo}</Rotulo>
        <Input aria-label={rotulo} value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder={exemplo} />
      </label>
      {erro && (
        <p role="alert" className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-danger)] m-0">
          {erro}
        </p>
      )}
      <div className="flex justify-end gap-3">
        <Button variant="ghost" onClick={onClose}>
          Voltar
        </Button>
        <Button
          variant={perigo ? 'danger' : 'primary'}
          loading={ocupado}
          disabled={!motivo.trim()}
          onClick={() => {
            setOcupado(true);
            setErro(null);
            onConfirmar(motivo.trim())
              .catch((err: unknown) => setErro(mensagemDe(err, 'Falha ao registrar.')))
              .finally(() => setOcupado(false));
          }}
        >
          {confirmar}
        </Button>
      </div>
    </Dialogo>
  );
}

// ============================================================================

export default function MaquininhasPage() {
  const [dados, setDados] = useState<MaquininhasDaOperacao | null>(null);
  const [prontidao, setProntidao] = useState<ProntidaoDasMaquininhas | null>(null);
  const [agentes, setAgentes] = useState<AgenteLocal[] | null>(null);
  const [caixas, setCaixas] = useState<TerminalDeCaixa[]>([]);
  const [cobrancas, setCobrancas] = useState<CobrancaDaMaquininha[] | null>(null);
  const [fila, setFila] = useState<ComandoDoAgente[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    setErro(null);
    // Cada bloco carrega por conta própria: a fila fora do ar não pode
    // esconder as maquininhas, e vice-versa. Mas o primeiro erro aparece.
    const falhas: string[] = [];
    await Promise.all([
      maquininhasApi
        .listar()
        .then(setDados)
        .catch((err: unknown) => {
          setDados(null);
          falhas.push(mensagemDe(err, 'Não foi possível listar as maquininhas.'));
        }),
      maquininhasApi
        .prontidao()
        .then(setProntidao)
        .catch(() => setProntidao(null)),
      maquininhasApi
        .agentes()
        .then(setAgentes)
        .catch((err: unknown) => {
          setAgentes(null);
          falhas.push(mensagemDe(err, 'Não foi possível listar os agentes locais.'));
        }),
      terminaisApi
        .listar(true)
        .then(setCaixas)
        .catch(() => setCaixas([])),
      maquininhasApi
        .cobrancas()
        .then(setCobrancas)
        .catch(() => setCobrancas(null)),
      maquininhasApi
        .comandos()
        .then(setFila)
        .catch(() => setFila(null)),
    ]);
    if (falhas.length) setErro(falhas[0]);
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const nomeDoCaixa = useMemo(() => {
    const mapa = new Map(caixas.map((c) => [c.id, c.name]));
    return (id: string | null | undefined) => (id ? (mapa.get(id) ?? 'caixa desativado') : 'Toda a operação');
  }, [caixas]);

  const mudou = (texto: string) => {
    setAviso(texto);
    void carregar();
  };

  return (
    <AppShell>
      <PageHeader
        breadcrumb={['Configurações', 'Maquininhas']}
        title="Maquininhas"
        subtitle="O PinPad de cada caixa, o agente local que fala com ele, a homologação e as cobranças — sem chamar o desenvolvedor."
        actions={
          <Button variant="ghost" onClick={() => void carregar()}>
            Atualizar
          </Button>
        }
      />

      {aviso && <Aviso tipo="ok">{aviso}</Aviso>}
      {erro && <Aviso tipo="erro">{erro}</Aviso>}

      <ProntidaoCard prontidao={prontidao} ambiente={dados?.environmentBlocksTestProvider ?? null} />

      <div className="mt-6">
        <MaquininhasCard dados={dados} caixas={caixas} nomeDoCaixa={nomeDoCaixa} onMudou={mudou} />
      </div>

      <div className="mt-6">
        <AgentesCard agentes={agentes} caixas={caixas} nomeDoCaixa={nomeDoCaixa} onMudou={mudou} />
      </div>

      <div className="mt-6">
        <HomologacaoCard dados={dados} nomeDoCaixa={nomeDoCaixa} />
      </div>

      <div className="mt-6">
        <CobrancasCard cobrancas={cobrancas} onMudou={mudou} />
      </div>

      <div className="mt-6">
        <FilaCard fila={fila} />
      </div>
    </AppShell>
  );
}

// ============================================================================
// 1. PRONTIDÃO
// ============================================================================

function ProntidaoCard({
  prontidao,
  ambiente,
}: {
  prontidao: ProntidaoDasMaquininhas | null;
  ambiente: string | null;
}) {
  const tom =
    prontidao?.overallStatus === 'homologated'
      ? 'success'
      : prontidao?.overallStatus === 'ready_for_homologation'
        ? 'info'
        : 'warning';
  return (
    <Card
      title="Prontidão"
      subtitle="Maquininha integrada é o PinPad do caixa com o cliente TEF da adquirente, alcançado pelo agente local instalado naquele computador."
    >
      {prontidao === null ? (
        <p role="status" className="text-[var(--gs-muted)] m-0">
          Carregando…
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <Badge tone={tom}>{ROTULO_DA_PRONTIDAO[prontidao.overallStatus] ?? prontidao.overallStatus}</Badge>
            {ambiente && (
              <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
                Ambiente {ambiente}: a maquininha de TESTE é ignorada aqui.
              </span>
            )}
          </div>
          {prontidao.blockingReasons.length > 0 ? (
            <ul aria-label="O que falta" className="m-0 pl-5 text-[length:var(--gs-text-sm)]">
              {prontidao.blockingReasons.slice(0, 12).map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          ) : (
            <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
              {prontidao.overallStatus === 'pending'
                ? 'Sem maquininha integrada, o cartão é lançado à mão contra o comprovante da maquininha avulsa.'
                : 'Nada pendente.'}
            </p>
          )}
          <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
            Integração pela nuvem da adquirente (maquininha &quot;smart&quot;): não disponível neste sistema. O caminho
            que existe é o agente local.
          </p>
        </div>
      )}
    </Card>
  );
}

// ============================================================================
// 2. AS MAQUININHAS
// ============================================================================

type AcaoDaMaquininha =
  | { tipo: 'editar'; config: ConfiguracaoDeMaquininha }
  | { tipo: 'credencial'; config: ConfiguracaoDeMaquininha }
  | { tipo: 'ligar' | 'desligar'; config: ConfiguracaoDeMaquininha };

function situacaoDoAgente(c: ConfiguracaoDeMaquininha): { texto: string; tom: 'success' | 'warning' | 'danger' | 'neutral' } {
  if (c.channel === 'mock') return { texto: 'não se aplica', tom: 'neutral' };
  if (c.channel !== 'local_agent') return { texto: 'caminho indisponível', tom: 'danger' };
  if (!c.agent) return { texto: 'sem agente pareado', tom: 'warning' };
  if (!c.agent.online) return { texto: 'agente fora do ar', tom: 'danger' };
  if (c.agent.health?.tefClient !== 'ok') return { texto: 'cliente TEF sem resposta', tom: 'warning' };
  return { texto: 'agente online · TEF ok', tom: 'success' };
}

function MaquininhasCard({
  dados,
  caixas,
  nomeDoCaixa,
  onMudou,
}: {
  dados: MaquininhasDaOperacao | null;
  caixas: TerminalDeCaixa[];
  nomeDoCaixa: (id: string | null | undefined) => string;
  onMudou: (texto: string) => void;
}) {
  const [novo, setNovo] = useState(false);
  const [acao, setAcao] = useState<AcaoDaMaquininha | null>(null);
  const [conexao, setConexao] = useState<{ id: string; ok: boolean; texto: string } | null>(null);
  const [testando, setTestando] = useState<string | null>(null);

  const testar = async (c: ConfiguracaoDeMaquininha) => {
    setTestando(c.id);
    try {
      const r = await maquininhasApi.testarConexao(c.provider);
      setConexao({ id: c.id, ok: r.ok, texto: r.message ?? (r.ok ? 'Conexão OK.' : 'Sem conexão.') });
    } catch (err) {
      setConexao({ id: c.id, ok: false, texto: mensagemDe(err, 'Falha ao testar a conexão.') });
    } finally {
      setTestando(null);
    }
  };

  return (
    <Card
      title="Maquininhas desta operação"
      subtitle="Ligada, o cartão do caixa passa pelo aparelho e só entra na venda com a cobrança aprovada. A maquininha real nasce desligada: pareie o agente do caixa e depois ligue."
      actions={
        <Button size="sm" onClick={() => setNovo(true)}>
          Nova maquininha
        </Button>
      }
    >
      {dados === null ? (
        <p role="status" className="text-[var(--gs-muted)] m-0">
          Não foi possível listar as maquininhas.
        </p>
      ) : dados.items.length === 0 ? (
        <EmptyState
          title="Nenhuma maquininha integrada"
          description="O cartão desta operação é lançado à mão, contra o comprovante da maquininha avulsa da adquirente."
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[length:var(--gs-text-sm)]">
            <thead>
              <tr className="text-left text-[var(--gs-text-soft)] border-b border-[var(--gs-border)]">
                <th className="py-2.5 pr-4 font-semibold">Maquininha</th>
                <th className="py-2.5 pr-4 font-semibold">Caixa</th>
                <th className="py-2.5 pr-4 font-semibold">Caminho</th>
                <th className="py-2.5 pr-4 font-semibold">Situação</th>
                <th className="py-2.5 font-semibold text-right">Ações</th>
              </tr>
            </thead>
            <tbody>
              {dados.items.map((c) => {
                const agente = situacaoDoAgente(c);
                return (
                  <tr key={c.id} className="border-b border-[var(--gs-border)] last:border-0 align-top">
                    <td className="py-3 pr-4">
                      <div className="font-semibold">{c.displayName || c.terminalIdentifier || c.id}</div>
                      <div className="text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
                        {NOME_DO_PROVEDOR[c.provider] ?? c.provider}
                        {c.terminalIdentifier ? ` · ${c.terminalIdentifier}` : ''}
                        {c.hasCredentials ? ' · credencial no cofre' : ''}
                      </div>
                      {c.simulated && <Badge tone="warning">TESTE — simulada</Badge>}
                    </td>
                    <td className="py-3 pr-4">{nomeDoCaixa(c.pdvTerminalId)}</td>
                    <td className="py-3 pr-4">
                      <div>{c.channelLabel ?? c.channel}</div>
                      {c.implemented === false && (
                        <div className="text-[length:var(--gs-text-xs)] text-[var(--gs-danger)]">{c.channelReason}</div>
                      )}
                      <Badge tone={agente.tom}>{agente.texto}</Badge>
                    </td>
                    <td className="py-3 pr-4">
                      {c.active ? (
                        c.blockedInThisEnvironment ? (
                          <Badge tone="warning">Ligada, ignorada neste ambiente</Badge>
                        ) : (
                          <Badge tone="success">Ligada</Badge>
                        )
                      ) : (
                        <Badge tone="neutral">Desligada</Badge>
                      )}
                      {c.readinessStatus && (
                        <div className="mt-1 text-[length:var(--gs-text-xs)] text-[var(--gs-text-soft)]">
                          {ROTULO_DA_PRONTIDAO[c.readinessStatus] ?? c.readinessStatus}
                        </div>
                      )}
                      {conexao?.id === c.id && (
                        <div
                          role="status"
                          aria-label={`Conexão de ${c.displayName ?? c.id}`}
                          className={`mt-1 text-[length:var(--gs-text-xs)] ${conexao.ok ? 'text-[var(--gs-success)]' : 'text-[var(--gs-danger)]'}`}
                        >
                          {conexao.texto}
                        </div>
                      )}
                    </td>
                    <td className="py-3 text-right">
                      <div className="flex flex-wrap justify-end gap-2">
                        <Button size="sm" variant="ghost" loading={testando === c.id} onClick={() => void testar(c)}>
                          Testar conexão
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setAcao({ tipo: 'editar', config: c })}>
                          Editar
                        </Button>
                        {!c.simulated && c.implemented !== false && (
                          <Button size="sm" variant="ghost" onClick={() => setAcao({ tipo: 'credencial', config: c })}>
                            Credencial
                          </Button>
                        )}
                        {c.active ? (
                          <Button size="sm" variant="danger" onClick={() => setAcao({ tipo: 'desligar', config: c })}>
                            Desligar
                          </Button>
                        ) : (
                          <Button size="sm" variant="secondary" onClick={() => setAcao({ tipo: 'ligar', config: c })}>
                            Ligar
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {novo && (
        <NovaMaquininha
          caixas={caixas}
          onClose={() => setNovo(false)}
          onFeito={(texto) => {
            setNovo(false);
            onMudou(texto);
          }}
        />
      )}
      {acao?.tipo === 'editar' && (
        <EditarMaquininha
          config={acao.config}
          caixas={caixas}
          onClose={() => setAcao(null)}
          onFeito={(texto) => {
            setAcao(null);
            onMudou(texto);
          }}
        />
      )}
      {acao?.tipo === 'credencial' && (
        <CredencialDaMaquininha
          config={acao.config}
          onClose={() => setAcao(null)}
          onFeito={(texto) => {
            setAcao(null);
            onMudou(texto);
          }}
        />
      )}
      {(acao?.tipo === 'ligar' || acao?.tipo === 'desligar') && (
        <DialogoDeMotivo
          titulo={`${acao.tipo === 'ligar' ? 'Ligar' : 'Desligar'} — ${acao.config.displayName ?? acao.config.id}`}
          explicacao={
            acao.tipo === 'ligar'
              ? 'Ligada, o cartão deste caixa passa a exigir a cobrança aprovada no aparelho. O servidor recusa ligar sem o agente do caixa pareado.'
              : 'Desligada, o cartão volta a ser lançado à mão contra o comprovante. O registro fica na auditoria com o seu nome.'
          }
          rotulo="Motivo"
          exemplo={acao.tipo === 'ligar' ? 'Ex.: PinPad instalado e testado' : 'Ex.: PinPad em manutenção'}
          confirmar={acao.tipo === 'ligar' ? 'Ligar' : 'Desligar'}
          perigo={acao.tipo === 'desligar'}
          onClose={() => setAcao(null)}
          onConfirmar={async (motivo) => {
            const nome = acao.config.displayName ?? acao.config.id;
            if (acao.tipo === 'ligar') await maquininhasApi.religar(acao.config.id, motivo);
            else await maquininhasApi.desligar(acao.config.id, motivo);
            setAcao(null);
            onMudou(
              acao.tipo === 'ligar'
                ? `Maquininha "${nome}" ligada. O cartão deste caixa passa pelo aparelho.`
                : `Maquininha "${nome}" desligada. O cartão volta a ser lançado à mão.`,
            );
          }}
        />
      )}
    </Card>
  );
}

function SeletorDeCaixa({
  caixas,
  valor,
  onChange,
}: {
  caixas: TerminalDeCaixa[];
  valor: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <Rotulo>Caixa</Rotulo>
      <select aria-label="Caixa da maquininha" value={valor} onChange={(e) => onChange(e.target.value)} className={CLASSE_SELECT}>
        <option value="">Toda a operação (sem caixa)</option>
        {caixas.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function NovaMaquininha({
  caixas,
  onClose,
  onFeito,
}: {
  caixas: TerminalDeCaixa[];
  onClose: () => void;
  onFeito: (texto: string) => void;
}) {
  const [provider, setProvider] = useState('stone');
  const [caminho, setCaminho] = useState<'local_agent' | 'cloud'>('local_agent');
  const [nome, setNome] = useState('');
  const [identificador, setIdentificador] = useState('');
  const [caixa, setCaixa] = useState(caixas.length === 1 ? caixas[0].id : '');
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const salvar = async () => {
    setOcupado(true);
    setErro(null);
    try {
      const criada = await maquininhasApi.cadastrar({
        provider,
        connectionMode: caminho,
        displayName: nome.trim(),
        terminalIdentifier: identificador.trim() || null,
        pdvTerminalId: caixa || null,
      });
      onFeito(
        `Maquininha "${criada.displayName ?? nome}" cadastrada e DESLIGADA. Agora gere o código de pareamento para o agente do caixa e, com ele online, ligue-a.`,
      );
    } catch (err) {
      setErro(mensagemDe(err, 'Não foi possível cadastrar a maquininha.'));
    } finally {
      setOcupado(false);
    }
  };

  return (
    <Dialogo titulo="Nova maquininha" onClose={onClose}>
      <label className="flex flex-col gap-1.5">
        <Rotulo>Adquirente</Rotulo>
        <select aria-label="Adquirente" value={provider} onChange={(e) => setProvider(e.target.value)} className={CLASSE_SELECT}>
          {PROVEDORES_REAIS.map((p) => (
            <option key={p} value={p}>
              {NOME_DO_PROVEDOR[p]}
            </option>
          ))}
        </select>
      </label>
      <fieldset className="flex flex-col gap-2 border-0 p-0 m-0">
        <legend className="mb-1">
          <Rotulo>Caminho até o aparelho</Rotulo>
        </legend>
        <label className="flex items-start gap-2">
          <input
            type="radio"
            name="caminho"
            checked={caminho === 'local_agent'}
            onChange={() => setCaminho('local_agent')}
          />
          <span>
            Agente local — PinPad ligado ao computador do caixa, com o cliente TEF da adquirente instalado.
          </span>
        </label>
        <label className="flex items-start gap-2 text-[var(--gs-muted)]">
          <input type="radio" name="caminho" disabled checked={caminho === 'cloud'} onChange={() => setCaminho('cloud')} />
          <span>
            Nuvem da adquirente (maquininha &quot;smart&quot;) — não disponível: a integração pela nuvem não está
            implementada neste sistema.
          </span>
        </label>
      </fieldset>
      <label className="flex flex-col gap-1.5">
        <Rotulo>Nome</Rotulo>
        <Input aria-label="Nome da maquininha" value={nome} onChange={(e) => setNome(e.target.value)} placeholder="Ex.: PinPad do Caixa 1" />
      </label>
      <label className="flex flex-col gap-1.5">
        <Rotulo>Identificador do aparelho (opcional)</Rotulo>
        <Input
          aria-label="Identificador do aparelho"
          value={identificador}
          onChange={(e) => setIdentificador(e.target.value)}
          placeholder="Número de série do PinPad ou código do terminal no TEF"
        />
      </label>
      <SeletorDeCaixa caixas={caixas} valor={caixa} onChange={setCaixa} />
      {erro && (
        <p role="alert" className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-danger)] m-0">
          {erro}
        </p>
      )}
      <div className="flex justify-end gap-3">
        <Button variant="ghost" onClick={onClose}>
          Voltar
        </Button>
        <Button loading={ocupado} disabled={!nome.trim()} onClick={() => void salvar()}>
          Cadastrar
        </Button>
      </div>
    </Dialogo>
  );
}

function EditarMaquininha({
  config,
  caixas,
  onClose,
  onFeito,
}: {
  config: ConfiguracaoDeMaquininha;
  caixas: TerminalDeCaixa[];
  onClose: () => void;
  onFeito: (texto: string) => void;
}) {
  const [nome, setNome] = useState(config.displayName ?? '');
  const [identificador, setIdentificador] = useState(config.terminalIdentifier ?? '');
  const [caixa, setCaixa] = useState(config.pdvTerminalId ?? '');
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  return (
    <Dialogo titulo={`Editar — ${config.displayName ?? config.id}`} onClose={onClose}>
      <label className="flex flex-col gap-1.5">
        <Rotulo>Nome</Rotulo>
        <Input aria-label="Nome da maquininha" value={nome} onChange={(e) => setNome(e.target.value)} />
      </label>
      <label className="flex flex-col gap-1.5">
        <Rotulo>Identificador do aparelho</Rotulo>
        <Input aria-label="Identificador do aparelho" value={identificador} onChange={(e) => setIdentificador(e.target.value)} />
      </label>
      <SeletorDeCaixa caixas={caixas} valor={caixa} onChange={setCaixa} />
      {config.active && (
        <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
          Ela está ligada: trocar o caixa exige o agente do caixa novo pareado.
        </p>
      )}
      {erro && (
        <p role="alert" className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-danger)] m-0">
          {erro}
        </p>
      )}
      <div className="flex justify-end gap-3">
        <Button variant="ghost" onClick={onClose}>
          Voltar
        </Button>
        <Button
          loading={ocupado}
          disabled={!nome.trim()}
          onClick={() => {
            setOcupado(true);
            setErro(null);
            maquininhasApi
              .editar(config.id, {
                displayName: nome.trim(),
                terminalIdentifier: identificador.trim() || null,
                pdvTerminalId: caixa || null,
              })
              .then(() => onFeito(`Maquininha "${nome.trim()}" atualizada.`))
              .catch((err: unknown) => setErro(mensagemDe(err, 'Não foi possível salvar.')))
              .finally(() => setOcupado(false));
          }}
        >
          Salvar
        </Button>
      </div>
    </Dialogo>
  );
}

function CredencialDaMaquininha({
  config,
  onClose,
  onFeito,
}: {
  config: ConfiguracaoDeMaquininha;
  onClose: () => void;
  onFeito: (texto: string) => void;
}) {
  const [chave, setChave] = useState('');
  const [estabelecimento, setEstabelecimento] = useState('');
  const [codigoDaLoja, setCodigoDaLoja] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  return (
    <Dialogo titulo={`Credencial — ${config.displayName ?? config.id}`} onClose={onClose}>
      <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
        Vai selada para o cofre do servidor e nunca volta para a tela. Pelo agente local, quem fala com a adquirente é
        o cliente TEF instalado no computador do caixa — guarde aqui os dados do contrato para a conferência.
        {config.hasCredentials ? ' Já existe uma credencial guardada: salvar substitui.' : ''}
      </p>
      <label className="flex flex-col gap-1.5">
        <Rotulo>Chave / token da adquirente</Rotulo>
        <Input
          aria-label="Chave da adquirente"
          type="password"
          autoComplete="off"
          value={chave}
          onChange={(e) => setChave(e.target.value)}
        />
      </label>
      <label className="flex flex-col gap-1.5">
        <Rotulo>Código do estabelecimento (opcional)</Rotulo>
        <Input aria-label="Código do estabelecimento" value={estabelecimento} onChange={(e) => setEstabelecimento(e.target.value)} />
      </label>
      <label className="flex flex-col gap-1.5">
        <Rotulo>Código da loja no TEF (opcional)</Rotulo>
        <Input aria-label="Código da loja no TEF" value={codigoDaLoja} onChange={(e) => setCodigoDaLoja(e.target.value)} />
      </label>
      {erro && (
        <p role="alert" className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-danger)] m-0">
          {erro}
        </p>
      )}
      <div className="flex justify-end gap-3">
        <Button variant="ghost" onClick={onClose}>
          Voltar
        </Button>
        <Button
          loading={ocupado}
          disabled={!chave.trim()}
          onClick={() => {
            setOcupado(true);
            setErro(null);
            maquininhasApi
              .salvarCredencial({
                configurationId: config.id,
                provider: config.provider,
                accessToken: chave.trim(),
                merchantId: estabelecimento.trim() || undefined,
                establishmentCode: codigoDaLoja.trim() || undefined,
              })
              .then(() => onFeito(`Credencial de "${config.displayName ?? config.id}" guardada no cofre.`))
              .catch((err: unknown) => setErro(mensagemDe(err, 'Não foi possível guardar a credencial.')))
              .finally(() => setOcupado(false));
          }}
        >
          Guardar no cofre
        </Button>
      </div>
    </Dialogo>
  );
}

// ============================================================================
// 3. O AGENTE LOCAL
// ============================================================================

function AgentesCard({
  agentes,
  caixas,
  nomeDoCaixa,
  onMudou,
}: {
  agentes: AgenteLocal[] | null;
  caixas: TerminalDeCaixa[];
  nomeDoCaixa: (id: string | null | undefined) => string;
  onMudou: (texto: string) => void;
}) {
  const [caixa, setCaixa] = useState('');
  const [codigo, setCodigo] = useState<CodigoDePareamento | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [revogando, setRevogando] = useState<AgenteLocal | null>(null);
  const servidor = typeof window !== 'undefined' ? window.location.origin : '';

  const gerar = async () => {
    setOcupado(true);
    setErro(null);
    try {
      setCodigo(await maquininhasApi.gerarCodigo(caixa || null));
    } catch (err) {
      setErro(mensagemDe(err, 'Não foi possível gerar o código.'));
    } finally {
      setOcupado(false);
    }
  };

  const pareados = (agentes ?? []).filter((a) => a.status !== 'pairing');

  return (
    <Card
      title="Agente local"
      subtitle="O programa que roda no computador do caixa e fala com o PinPad pelo cliente TEF. O navegador nunca toca no aparelho."
    >
      <div className="grid gap-3 sm:grid-cols-3 items-end mb-4">
        <SeletorDeCaixa caixas={caixas} valor={caixa} onChange={setCaixa} />
        <Button loading={ocupado} onClick={() => void gerar()}>
          Gerar código de pareamento
        </Button>
      </div>
      {erro && <Aviso tipo="erro">{erro}</Aviso>}
      {codigo && (
        <div
          role="status"
          aria-label="Código de pareamento"
          className="mb-4 px-4 py-3 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)] bg-[var(--gs-surface-hover)]"
        >
          <div className="text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
            Código para {codigo.pdvTerminalName ?? 'a operação inteira'} — vale até {dataHoraBR(codigo.expiresAt)}, uma
            vez só:
          </div>
          <div className="font-mono text-[28px] font-bold tracking-[0.2em]">{codigo.pairingCode}</div>
          <div className="mt-2 text-[length:var(--gs-text-sm)]">
            No computador do caixa, com o cliente TEF instalado, rode:
            <pre className="mt-1 p-2 rounded bg-[var(--gs-surface)] overflow-x-auto text-[length:var(--gs-text-xs)]">
              {`node dist/local-agent/main.js parear --servidor ${servidor}/api/v1 --codigo ${codigo.pairingCode}`}
            </pre>
          </div>
        </div>
      )}

      {agentes === null ? (
        <p role="status" className="text-[var(--gs-muted)] m-0">
          Não foi possível listar os agentes.
        </p>
      ) : pareados.length === 0 ? (
        <EmptyState
          title="Nenhum agente pareado"
          description="Gere o código acima e informe-o no agente instalado no computador do caixa."
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[length:var(--gs-text-sm)]">
            <thead>
              <tr className="text-left text-[var(--gs-text-soft)] border-b border-[var(--gs-border)]">
                <th className="py-2.5 pr-4 font-semibold">Caixa</th>
                <th className="py-2.5 pr-4 font-semibold">Computador</th>
                <th className="py-2.5 pr-4 font-semibold">Último sinal</th>
                <th className="py-2.5 pr-4 font-semibold">Cliente TEF / PinPad</th>
                <th className="py-2.5 pr-4 font-semibold">Situação</th>
                <th className="py-2.5 font-semibold text-right">Ação</th>
              </tr>
            </thead>
            <tbody>
              {pareados.map((a) => (
                <tr key={a.agentId} className="border-b border-[var(--gs-border)] last:border-0 align-top">
                  <td className="py-3 pr-4">{nomeDoCaixa(a.pdvTerminalId)}</td>
                  <td className="py-3 pr-4">
                    <div>{a.hostname ?? '—'}</div>
                    <div className="text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">versão {a.version ?? '—'}</div>
                  </td>
                  <td className="py-3 pr-4">{dataHoraBR(a.lastSeenAt)}</td>
                  <td className="py-3 pr-4">
                    {a.health ? `${a.health.tefClient ?? '—'} / ${a.health.pinpad ?? '—'}` : '—'}
                    {a.health?.message && (
                      <div className="text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">{a.health.message}</div>
                    )}
                  </td>
                  <td className="py-3 pr-4">
                    {a.status === 'revoked' ? (
                      <Badge tone="neutral">Revogado</Badge>
                    ) : a.online ? (
                      <Badge tone="success">Online</Badge>
                    ) : (
                      <Badge tone="danger">Fora do ar</Badge>
                    )}
                    {a.status === 'revoked' && a.revocationReason && (
                      <div className="mt-1 text-[length:var(--gs-text-xs)] text-[var(--gs-text-soft)]">
                        {dataHoraBR(a.revokedAt)} — {a.revocationReason}
                      </div>
                    )}
                  </td>
                  <td className="py-3 text-right">
                    {a.status !== 'revoked' && (
                      <Button size="sm" variant="danger" onClick={() => setRevogando(a)}>
                        Revogar
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {revogando && (
        <DialogoDeMotivo
          titulo={`Revogar agente — ${nomeDoCaixa(revogando.pdvTerminalId)}`}
          explicacao="Revogado, o segredo do agente é apagado e todo pedido dele passa a ser recusado. A maquininha daquele caixa para de cobrar até um agente novo ser pareado."
          rotulo="Motivo"
          exemplo="Ex.: computador do caixa trocado"
          confirmar="Revogar"
          perigo
          onClose={() => setRevogando(null)}
          onConfirmar={async (motivo) => {
            await maquininhasApi.revogarAgente(revogando.agentId, motivo);
            setRevogando(null);
            onMudou('Agente revogado.');
          }}
        />
      )}
    </Card>
  );
}

// ============================================================================
// 4. HOMOLOGAÇÃO
// ============================================================================

function HomologacaoCard({
  dados,
  nomeDoCaixa,
}: {
  dados: MaquininhasDaOperacao | null;
  nomeDoCaixa: (id: string | null | undefined) => string;
}) {
  const comRoteiro = (dados?.items ?? []).filter((c) => c.homologation);
  return (
    <Card
      title="Homologação"
      subtitle="A maquininha se prova com cobranças REAIS no aparelho. Cada item só fica verde quando a operação aconteceu — nenhum botão declara."
    >
      {comRoteiro.length === 0 ? (
        <p className="m-0 text-[var(--gs-muted)]">Cadastre uma maquininha pelo agente local para ver o roteiro.</p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {comRoteiro.map((c) => {
            const h = c.homologation!;
            const feitos = h.items.filter((i) => i.required && i.status === 'ok').length;
            const exigidos = h.items.filter((i) => i.required).length;
            return (
              <section
                key={c.id}
                aria-label={`Homologação de ${c.displayName ?? c.id}`}
                className="border border-[var(--gs-border)] rounded-[var(--gs-radius)] p-4"
              >
                <div className="flex items-center justify-between gap-2 mb-2">
                  <strong>{c.displayName ?? c.id}</strong>
                  <Badge tone={h.homologated ? 'success' : 'warning'}>
                    {h.homologated ? 'Homologada' : `${feitos} de ${exigidos}`}
                  </Badge>
                </div>
                <div className="text-[length:var(--gs-text-xs)] text-[var(--gs-muted)] mb-2">{nomeDoCaixa(c.pdvTerminalId)}</div>
                <ul className="m-0 pl-0 list-none flex flex-col gap-1 text-[length:var(--gs-text-sm)]">
                  {h.items.map((i) => (
                    <li key={i.key} className="flex items-start gap-2">
                      <span aria-hidden="true">{i.status === 'ok' ? '✔' : '○'}</span>
                      <span>
                        {i.label}
                        {!i.required && <span className="text-[var(--gs-muted)]"> (opcional)</span>}
                        {i.at && <span className="text-[var(--gs-muted)]"> — {dataHoraBR(i.at)}</span>}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </Card>
  );
}

// ============================================================================
// 5. COBRANÇAS
// ============================================================================

const ROTULO_DA_COBRANCA: Record<string, string> = {
  authorized: 'Aprovada',
  confirmed: 'Aprovada',
  declined: 'Recusada',
  cancelled: 'Cancelada',
  refunded: 'Estornada',
  partially_refunded: 'Estornada em parte',
  timeout_uncertain: 'NÃO CONFIRMADA',
  in_progress: 'No aparelho',
  failed: 'Falhou (nada cobrado)',
};

/*
  O ÚLTIMO PEDIDO DE CANCELAMENTO/ESTORNO DA COBRANÇA (GAP-PRD-075). O servidor
  gravava cada pedido — inclusive o que a operadora não confirmou — e a lista
  não o mostrava. O desfecho vem cru; os que o servidor escreve hoje estão
  aqui, e um desconhecido aparece como veio.
*/
const ROTULO_DO_PEDIDO: Record<string, string> = {
  confirmed: 'confirmado pela operadora',
  confirmed_manually: 'conferido à mão pela gerência',
  pending_provider: 'aguardando a operadora',
  queued_to_agent: 'enviado ao agente do caixa',
  not_delivered: 'o agente não retirou o pedido',
  no_answer: 'sem resposta do aparelho',
  declined: 'recusado pela operadora',
  error: 'falhou ao falar com a operadora',
};

function resumoDoPedido(p: NonNullable<CobrancaDaMaquininha['ultimoPedido']>): string {
  const acao = p.operacao === 'cancel' ? 'Cancelamento' : 'Estorno';
  const quando = p.requestedAt ? ` em ${dataHoraBR(p.requestedAt)}` : '';
  const desfecho = ROTULO_DO_PEDIDO[p.outcome] ?? p.outcome;
  const motivo = p.reason ? ` Motivo: ${p.reason}` : '';
  return `${acao} pedido${quando} — ${desfecho}.${motivo}`;
}

type AcaoDaCobranca =
  | { tipo: 'comprovante'; cobranca: CobrancaDaMaquininha }
  | { tipo: 'cancelar' | 'estornar'; cobranca: CobrancaDaMaquininha };

function CobrancasCard({
  cobrancas,
  onMudou,
}: {
  cobrancas: CobrancaDaMaquininha[] | null;
  onMudou: (texto: string) => void;
}) {
  const [acao, setAcao] = useState<AcaoDaCobranca | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [painel, setPainel] = useState<PainelDaMaquininha | null>(null);
  useEffect(() => {
    let vivo = true;
    maquininhasApi
      .painel()
      .then((p) => {
        if (vivo) setPainel(p);
      })
      // Sem os números a lista continua útil; nulo esconde a linha em vez de mostrar zeros falsos.
      .catch(() => {
        if (vivo) setPainel(null);
      });
    return () => {
      vivo = false;
    };
  }, [cobrancas]);
  const recentes = useMemo(
    () =>
      [...(cobrancas ?? [])]
        .sort((a, b) => String(b.startedAt ?? '').localeCompare(String(a.startedAt ?? '')))
        .slice(0, 50),
    [cobrancas],
  );

  const consultar = async (c: CobrancaDaMaquininha) => {
    setErro(null);
    try {
      await maquininhasApi.consultarNoAparelho(c.id);
      onMudou('Consulta enviada ao agente do caixa. A cobrança muda quando o aparelho responder.');
    } catch (err) {
      setErro(mensagemDe(err, 'Não foi possível pedir a consulta.'));
    }
  };

  return (
    <Card
      title="Cobranças recentes"
      subtitle="O que o aparelho respondeu. Cobrança que pagou uma venda se desfaz cancelando ou devolvendo a VENDA."
    >
      {erro && <Aviso tipo="erro">{erro}</Aviso>}
      {painel && (
        <dl aria-label="Números da maquininha" className="grid grid-cols-2 sm:grid-cols-4 gap-3 m-0 mb-4">
          {[
            ['Aprovadas', String(painel.authorized + (painel.confirmed ?? 0))],
            ['Recusadas', String(painel.declined)],
            ['Não confirmadas', String(painel.timeoutUncertain)],
            ['Bruto aprovado', formatCents(painel.grossAmountInCents)],
          ].map(([rotulo, valor]) => (
            <div key={rotulo} className="p-3 rounded-[var(--gs-radius)] border border-[var(--gs-border)]">
              <dt className="text-[length:var(--gs-text-xs)] text-[var(--gs-text-soft)]">{rotulo}</dt>
              <dd className="m-0 text-[length:var(--gs-text-lg)] font-bold">{valor}</dd>
            </div>
          ))}
        </dl>
      )}
      {cobrancas === null ? (
        <p role="status" className="text-[var(--gs-muted)] m-0">
          Não foi possível listar as cobranças.
        </p>
      ) : recentes.length === 0 ? (
        <EmptyState title="Nenhuma cobrança na maquininha" description="As cobranças do PDV aparecem aqui." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[length:var(--gs-text-sm)]">
            <thead>
              <tr className="text-left text-[var(--gs-text-soft)] border-b border-[var(--gs-border)]">
                <th className="py-2.5 pr-4 font-semibold">Quando</th>
                <th className="py-2.5 pr-4 font-semibold">Valor</th>
                <th className="py-2.5 pr-4 font-semibold">Situação</th>
                <th className="py-2.5 pr-4 font-semibold">NSU / autorização</th>
                <th className="py-2.5 pr-4 font-semibold">Venda</th>
                <th className="py-2.5 font-semibold text-right">Ações</th>
              </tr>
            </thead>
            <tbody>
              {recentes.map((c) => {
                const status = String(c.status ?? '');
                const pago = ['authorized', 'confirmed', 'partially_refunded'].includes(status);
                return (
                  <tr key={c.id} className="border-b border-[var(--gs-border)] last:border-0 align-top">
                    <td className="py-3 pr-4">{dataHoraBR(c.startedAt)}</td>
                    <td className="py-3 pr-4">
                      {formatCents(Number(c.amountInCents ?? 0))}
                      <div className="text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
                        {c.paymentMethod} {c.maskedCard ?? ''} {c.cardBrand ?? ''}
                      </div>
                    </td>
                    <td className="py-3 pr-4">
                      <Badge tone={status === 'timeout_uncertain' ? 'danger' : pago ? 'success' : 'neutral'}>
                        {ROTULO_DA_COBRANCA[status] ?? status}
                      </Badge>
                      {c.simulated && <Badge tone="warning">simulada</Badge>}
                      {c.ultimoPedido && (
                        <div className="mt-1 text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
                          <div>{resumoDoPedido(c.ultimoPedido)}</div>
                          {c.ultimoPedido.providerMessage && <div>{c.ultimoPedido.providerMessage}</div>}
                        </div>
                      )}
                    </td>
                    <td className="py-3 pr-4 font-mono text-[length:var(--gs-text-xs)]">
                      {c.providerNsu ?? '—'} / {c.providerAuthorizationCode ?? '—'}
                    </td>
                    <td className="py-3 pr-4">{c.saleNumber ? `#${c.saleNumber}` : c.saleId ? 'vinculada' : '—'}</td>
                    <td className="py-3 text-right">
                      <div className="flex flex-wrap justify-end gap-2">
                        {pago && (
                          <Button size="sm" variant="ghost" onClick={() => setAcao({ tipo: 'comprovante', cobranca: c })}>
                            Comprovante
                          </Button>
                        )}
                        {pago && !c.saleId && (
                          <>
                            <Button size="sm" variant="ghost" onClick={() => setAcao({ tipo: 'cancelar', cobranca: c })}>
                              Cancelar
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setAcao({ tipo: 'estornar', cobranca: c })}>
                              Estornar
                            </Button>
                          </>
                        )}
                        {status === 'timeout_uncertain' && c.channel === 'local_agent' && (
                          <Button size="sm" variant="secondary" onClick={() => void consultar(c)}>
                            Consultar no aparelho
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {acao?.tipo === 'comprovante' && <VerComprovante cobranca={acao.cobranca} onClose={() => setAcao(null)} />}
      {(acao?.tipo === 'cancelar' || acao?.tipo === 'estornar') && (
        <DesfazerCobranca
          tipo={acao.tipo}
          cobranca={acao.cobranca}
          onClose={() => setAcao(null)}
          onFeito={(texto) => {
            setAcao(null);
            onMudou(texto);
          }}
        />
      )}
    </Card>
  );
}

function DesfazerCobranca({
  tipo,
  cobranca,
  onClose,
  onFeito,
}: {
  tipo: 'cancelar' | 'estornar';
  cobranca: CobrancaDaMaquininha;
  onClose: () => void;
  onFeito: (texto: string) => void;
}) {
  const restante = Number(cobranca.amountInCents ?? 0) - Number(cobranca.refundedAmountInCents ?? 0);
  const [valor, setValor] = useState((restante / 100).toFixed(2).replace('.', ','));
  const centavos = Math.round(Number(valor.replace(/\./g, '').replace(',', '.')) * 100);
  return (
    <DialogoDeMotivo
      titulo={`${tipo === 'cancelar' ? 'Cancelar' : 'Estornar'} cobrança de ${formatCents(Number(cobranca.amountInCents ?? 0))}`}
      explicacao="O pedido vai para a operadora (pelo agente do caixa, quando a cobrança foi feita por ele). A cobrança só muda quando a operadora confirmar."
      rotulo="Motivo"
      exemplo="Ex.: cliente desistiu antes de levar"
      confirmar={tipo === 'cancelar' ? 'Pedir cancelamento' : 'Pedir estorno'}
      perigo
      extra={
        tipo === 'estornar' ? (
          <label className="flex flex-col gap-1.5">
            <Rotulo>Valor do estorno (R$)</Rotulo>
            <Input aria-label="Valor do estorno" value={valor} onChange={(e) => setValor(e.target.value)} />
          </label>
        ) : undefined
      }
      onClose={onClose}
      onConfirmar={async (motivo) => {
        const r =
          tipo === 'cancelar'
            ? await maquininhasApi.cancelar(cobranca.id, motivo)
            : await maquininhasApi.estornar(cobranca.id, motivo, Number.isFinite(centavos) ? centavos : null);
        onFeito(
          r.queuedToAgent
            ? (r.message ?? 'Pedido enviado ao agente do caixa.')
            : tipo === 'cancelar'
              ? 'Cobrança cancelada.'
              : 'Estorno registrado.',
        );
      }}
    />
  );
}

function VerComprovante({ cobranca, onClose }: { cobranca: CobrancaDaMaquininha; onClose: () => void }) {
  const [via, setVia] = useState<'merchant' | 'customer'>('customer');
  const [comprovante, setComprovante] = useState<Comprovante | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    let vivo = true;
    setComprovante(null);
    setErro(null);
    maquininhasApi
      .comprovante(cobranca.id, via)
      .then((c) => {
        if (vivo) setComprovante(c);
      })
      .catch((err: unknown) => {
        if (vivo) setErro(mensagemDe(err, 'Não foi possível abrir o comprovante.'));
      });
    return () => {
      vivo = false;
    };
  }, [cobranca.id, via]);

  return (
    <Dialogo titulo="Comprovante" onClose={onClose}>
      <div className="flex gap-2">
        <Button size="sm" variant={via === 'customer' ? 'primary' : 'ghost'} onClick={() => setVia('customer')}>
          Via do cliente
        </Button>
        <Button size="sm" variant={via === 'merchant' ? 'primary' : 'ghost'} onClick={() => setVia('merchant')}>
          Via do estabelecimento
        </Button>
      </div>
      {erro && (
        <p role="alert" className="m-0 text-[var(--gs-danger)]">
          {erro}
        </p>
      )}
      {comprovante && (
        <>
          <pre
            aria-label="Texto do comprovante"
            className="m-0 p-3 rounded bg-[var(--gs-surface-hover)] whitespace-pre-wrap font-mono text-[length:var(--gs-text-xs)]"
          >
            {comprovante.receiptText}
          </pre>
          <p className="m-0 text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
            Segundas vias já emitidas: {comprovante.reprintCount}
          </p>
        </>
      )}
      <div className="flex justify-end gap-3">
        <Button variant="ghost" onClick={onClose}>
          Fechar
        </Button>
        <Button
          disabled={!comprovante}
          onClick={() => {
            void maquininhasApi
              .reimprimir(cobranca.id, via)
              .then(setComprovante)
              .catch((err: unknown) => setErro(mensagemDe(err, 'Não foi possível registrar a segunda via.')));
          }}
        >
          Registrar segunda via
        </Button>
      </div>
    </Dialogo>
  );
}

// ============================================================================
// 6. A FILA DO AGENTE
// ============================================================================

const ROTULO_DO_COMANDO: Record<string, string> = {
  startPayment: 'Cobrança',
  queryStatus: 'Consulta',
  cancel: 'Cancelamento',
  refund: 'Estorno',
  reprint: 'Segunda via',
  health: 'Saúde',
};

function FilaCard({ fila }: { fila: ComandoDoAgente[] | null }) {
  const vencidos = (fila ?? []).filter((c) => c.status === 'expired');
  const pendentes = (fila ?? []).filter((c) => c.status === 'queued' || c.status === 'delivered');
  return (
    <Card
      title="Fila do agente"
      subtitle="Comando não retirado a tempo nunca chegou ao aparelho (nada foi cobrado). Retirado e sem resposta vira cobrança NÃO CONFIRMADA na Conferência de maquininha."
    >
      {fila === null ? (
        <p role="status" className="m-0 text-[var(--gs-muted)]">
          Não foi possível ler a fila.
        </p>
      ) : vencidos.length === 0 && pendentes.length === 0 ? (
        <p className="m-0 text-[var(--gs-text-soft)]">Nada esperando e nada vencido.</p>
      ) : (
        <ul aria-label="Comandos do agente" className="m-0 pl-5 text-[length:var(--gs-text-sm)] flex flex-col gap-1">
          {pendentes.map((c) => (
            <li key={c.id}>
              {ROTULO_DO_COMANDO[c.command] ?? c.command}
              {c.amountInCents ? ` de ${formatCents(c.amountInCents)}` : ''} —{' '}
              {c.status === 'queued' ? 'esperando o agente retirar' : 'no aparelho, sem resposta ainda'} (desde{' '}
              {dataHoraBR(c.createdAt)})
            </li>
          ))}
          {vencidos.map((c) => (
            <li key={c.id} className="text-[var(--gs-danger)]">
              {ROTULO_DO_COMANDO[c.command] ?? c.command}
              {c.amountInCents ? ` de ${formatCents(c.amountInCents)}` : ''} —{' '}
              {c.deliveredAt ? 'retirado e sem resposta' : 'não retirado (nada foi feito no aparelho)'} em{' '}
              {dataHoraBR(c.expiredAt)}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
