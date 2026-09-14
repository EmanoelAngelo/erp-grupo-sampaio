/**
 * Sincronização com o banco central (Supabase).
 *
 * A pergunta que esta tela responde é uma só: **a central está em dia com esta
 * loja?** Tudo o mais é detalhe.
 *
 * Ela existe porque a arquitetura é híbrida de propósito. O PDV vende com a
 * internet caída — o SQLite local é o banco operacional — e os fatos sobem
 * para a central quando a conexão volta. Sem uma tela, o atraso da fila seria
 * invisível até alguém notar que o relatório consolidado não bate com o caixa.
 *
 * OS ESTADOS SÃO HONESTOS, e a distinção importa:
 *
 *   AGUARDANDO CREDENCIAL → o servidor não tem chave própria
 *   AGUARDANDO SCHEMA     → tem chave, mas a central não tem as tabelas
 *   AGUARDANDO CARGA      → tem tabelas, mas o histórico nunca subiu
 *   SINCRONIZANDO         → tudo no lugar
 *
 * Nenhum deles se chama "ONLINE": ter conexão não é ter dado consistente, e
 * confundir os dois é como o gestor descobre tarde que o consolidado está
 * incompleto.
 *
 * A credencial não aparece aqui, nem mascarada.
 */
import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/gs/AppShell';
import { Badge, Button, Card, PageHeader } from '@/components/gs/ui';
import { ApiRequestError, apiRequest, exigirCampos } from '@/lib/api/client';
import { dataHoraBR } from '@/lib/datas';

type Readiness =
  | 'READY_FOR_CREDENTIAL'
  | 'READY_FOR_SCHEMA'
  | 'READY_FOR_BOOTSTRAP'
  | 'SYNC_READY';

interface SyncStatus {
  readiness: Readiness;
  missing: string[];
  transport: string;
  isTestTransport: boolean;
  centralSchemaCheckedAt: string | null;
  bootstrapCompletedAt: string | null;
  /** O ciclo de fundo está mesmo rodando? Vem do servidor, não é suposição. */
  workerRunning: boolean;
  outbox: {
    nodeId: string;
    pending: number;
    processing: number;
    retry: number;
    synced: number;
    dead: number;
    oldestPendingAt: string | null;
    lastSyncedAt: string | null;
    lastSyncedEventType: string | null;
    lastError: string | null;
    /**
     * A natureza da última falha (GAP-PRD-047): `TRANSPORTE` = a central não
     * respondeu e a fila insiste sozinha; `RECUSA` = a central disse não.
     */
    lastErrorKind?: 'TRANSPORTE' | 'RECUSA' | null;
    lagSeconds: number | null;
  };
  /**
   * De quem são as contagens (GAP-PRD-136): `no` para quem responde pelo grupo
   * inteiro; `operacao` para os demais, que veem só a fila da própria loja.
   * Ausente = servidor anterior, que contava o nó para todos.
   */
  escopo?: 'no' | 'operacao';
  /** Os botões que o servidor aceita desta sessão — calculados pelas regras que recusam. */
  acoes?: {
    cargaInicial: boolean;
    conferirSchema: boolean;
    reviver: boolean;
    sincronizar: boolean;
  };
  /**
   * Entregar não é projetar (GAP-PRD-048): o último erro de projeção, quando
   * aconteceu, e quando a central aceitou uma projeção pela última vez.
   */
  projecao?: {
    ultimoErro: string | null;
    ultimoErroEm: string | null;
    ultimaAceitaEm: string | null;
  };
}

const ESTADO: Record<Readiness, { rotulo: string; tom: 'warning' | 'success'; texto: string }> = {
  READY_FOR_CREDENTIAL: {
    rotulo: 'AGUARDANDO CREDENCIAL',
    tom: 'warning',
    texto:
      'A fila está guardando tudo, mas nada sobe: o servidor ainda não tem credencial própria '
      + 'da Supabase. A chave publicável usada pelo navegador não serve aqui — ela é para '
      + 'leitura com RLS, e gravar a central com ela seria confiar no navegador.',
  },
  READY_FOR_SCHEMA: {
    rotulo: 'AGUARDANDO SCHEMA',
    tom: 'warning',
    texto:
      'A credencial existe, mas a central ainda não tem as tabelas. Rode os três arquivos de '
      + 'docs/supabase no SQL Editor, na ordem, e confira aqui.',
  },
  READY_FOR_BOOTSTRAP: {
    rotulo: 'AGUARDANDO CARGA INICIAL',
    tom: 'warning',
    texto:
      'A central tem as tabelas, mas o histórico deste nó nunca subiu. A fila só carrega o que '
      + 'aconteceu depois que ela passou a existir — produtos, clientes e vendas anteriores '
      + 'precisam da carga inicial.',
  },
  SYNC_READY: {
    rotulo: 'SINCRONIZANDO',
    tom: 'success',
    // "A fila sobe sozinha" era promessa: o trabalhador de fundo nunca era
    // ligado. Quem responde por isso agora é a linha do ciclo, logo abaixo, que
    // vem do servidor.
    texto: 'Credencial, schema e carga inicial no lugar.',
  },
};

function dataHora(iso: string): string {
  return dataHoraBR(iso);
}

/** O atraso em palavras. É o número que o gestor remoto realmente lê. */
function atrasoEmPalavras(segundos: number): string {
  if (segundos < 60) return `${segundos} segundo(s)`;
  if (segundos < 3600) return `${Math.floor(segundos / 60)} minuto(s)`;
  if (segundos < 86400) return `${Math.floor(segundos / 3600)} hora(s)`;
  return `${Math.floor(segundos / 86400)} dia(s)`;
}

export default function SincronizacaoPage() {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [mensagem, setMensagem] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    try {
      setStatus(await apiRequest<SyncStatus>('/core/sync/status').then((r) => exigirCampos(r, 'readiness', 'missing', 'transport', 'isTestTransport', 'centralSchemaCheckedAt', 'bootstrapCompletedAt', 'outbox')));
      setErro(null);
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao ler a situação da fila.');
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const acao = async (nome: string, caminho: string, descreve: (r: never) => string) => {
    setOcupado(nome);
    setMensagem(null);
    try {
      const r = await apiRequest<never>(caminho, { method: 'POST' });
      setMensagem(descreve(r));
      await carregar();
    } catch (err) {
      setMensagem(err instanceof ApiRequestError ? err.message : 'Falha na operação.');
    } finally {
      setOcupado(null);
    }
  };

  const estado = status ? ESTADO[status.readiness] : null;
  const emDia = status ? status.outbox.pending + status.outbox.retry === 0 : false;
  /*
    BOTÃO QUE O SERVIDOR FECHA NÃO APARECE (GAP-PRD-136, GAP-PRD-149). Sem
    `acoes` (servidor anterior), oferece o que sempre ofereceu.
  */
  const pode = (acao: keyof NonNullable<SyncStatus['acoes']>) => status?.acoes?.[acao] !== false;

  return (
    <AppShell>
      <PageHeader
        breadcrumb={['Integrações', 'Banco central']}
        title="Sincronização com a central"
        subtitle="O PDV vende offline. Os fatos sobem para o banco central quando a conexão volta."
      />

      {erro && (
        <div
          role="alert"
          className="mb-5 px-4 py-3 rounded-[var(--gs-radius)] bg-[var(--gs-danger-bg)] text-[var(--gs-danger)]"
        >
          {erro}
        </div>
      )}

      {status && estado && (
        <>
          <Card>
            <div className="flex flex-wrap items-center gap-3 mb-2">
              <Badge tone={estado.tom}>{estado.rotulo}</Badge>
              {status.isTestTransport && (
                <Badge tone="warning">CENTRAL DE TESTE — NÃO É PRODUÇÃO</Badge>
              )}
            </div>
            <p className="m-0 text-[length:var(--gs-text-sm)]">{estado.texto}</p>
            {status.readiness === 'READY_FOR_CREDENTIAL' && status.missing.length > 0 && (
              <p className="mt-2 mb-0 text-[length:var(--gs-text-sm)]">
                Falta configurar <strong>{status.missing.join(' e ')}</strong> no ambiente do
                servidor.
              </p>
            )}
            {/*
              O QUE ACONTECE DEPOIS DE PREENCHER (GAP-PRD-065). A tela mandava
              preencher e não dizia mais nada — e o servidor só lia no boot. Agora
              ele relê a credencial da central do .env a cada ciclo, e a tela diz.
            */}
            {status.readiness === 'READY_FOR_CREDENTIAL' && (
              <p className="mt-2 mb-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                O servidor relê a credencial do arquivo <span className="font-mono">.env</span> a
                cada ciclo: depois de salvar, <strong>não precisa reiniciar a API</strong>. Só é
                preciso reiniciar se a variável estiver definida no ambiente do sistema (fora do{' '}
                <span className="font-mono">.env</span>).
              </p>
            )}
            {/*
              O CICLO DE FUNDO, DITO COMO FATO.

              A tela afirmava "a fila sobe sozinha" enquanto `startSyncWorker`
              não tinha um único chamador: nada subia, e o gestor só descobriria
              olhando a fila crescer. Agora a resposta vem do servidor, e é ela
              que sustenta a frase.
            */}
            <p className="mt-3 mb-0 text-[length:var(--gs-text-sm)]">
              Ciclo automático:{' '}
              <strong>
                {status.workerRunning
                  ? 'rodando — a fila sobe sozinha a cada 15 segundos'
                  : 'parado'}
              </strong>
              {!status.workerRunning && (
                <span className="text-[var(--gs-muted)]">
                  {' '}
                  — sem credencial não há para onde enviar. A fila acumula, nada se perde, e
                  &quot;sincronizar agora&quot; segue disponível para envio manual.
                </span>
              )}
            </p>
            {status.escopo === 'operacao' && (
              <p
                data-testid="sync-escopo"
                className="mt-3 mb-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]"
              >
                As contagens abaixo são <strong>desta operação</strong>. A fila do servidor é
                uma só para todas as operações; a visão do servidor inteiro e a carga inicial
                são de quem responde pelo grupo.
              </p>
            )}
          </Card>

          <div className="grid gap-4 md:grid-cols-4 my-5">
            <Card>
              <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] block">
                Esperando para subir
              </span>
              <strong className="text-[length:var(--gs-text-2xl)]">{status.outbox.pending}</strong>
            </Card>
            <Card>
              <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] block">
                Em nova tentativa
              </span>
              <strong className="text-[length:var(--gs-text-2xl)]">{status.outbox.retry}</strong>
            </Card>
            <Card>
              <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] block">
                Já na central
              </span>
              <strong className="text-[length:var(--gs-text-2xl)]">{status.outbox.synced}</strong>
            </Card>
            <Card>
              <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] block">
                Parados, esperando você
              </span>
              <strong
                className={`text-[length:var(--gs-text-2xl)] ${
                  status.outbox.dead > 0 ? 'text-[var(--gs-danger)]' : ''
                }`}
              >
                {status.outbox.dead}
              </strong>
            </Card>
          </div>

          <Card>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <Badge tone={emDia ? 'success' : 'warning'}>
                  {emDia ? 'CENTRAL EM DIA' : 'CENTRAL ATRASADA'}
                </Badge>
                {status.outbox.lagSeconds !== null && status.outbox.lagSeconds > 0 && (
                  <p
                    data-testid="sync-lag"
                    className="mt-2 mb-0 text-[length:var(--gs-text-sm)] text-[var(--gs-warning)]"
                  >
                    Central {atrasoEmPalavras(status.outbox.lagSeconds)} atrasada.
                  </p>
                )}
                <p className="mt-2 mb-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                  Nó: <span className="font-mono">{status.outbox.nodeId}</span>
                </p>
                {status.outbox.lastSyncedAt && (
                  <p className="mt-1 mb-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                    Última sincronização: {dataHora(status.outbox.lastSyncedAt)}
                    {status.outbox.lastSyncedEventType
                      ? ` · último evento: ${status.outbox.lastSyncedEventType}`
                      : ''}
                  </p>
                )}
              </div>

              <div className="flex flex-wrap gap-2">
                {pode('conferirSchema') && (
                  <Button
                    variant="secondary"
                    onClick={() =>
                      void acao('probe', '/core/sync/probe', (r: never) =>
                        (r as { ok: boolean; detail?: string }).ok
                          ? 'Schema da central conferido.'
                          : `Central sem schema: ${(r as { detail?: string }).detail ?? '—'}`,
                      )
                    }
                    disabled={ocupado !== null || status.readiness === 'READY_FOR_CREDENTIAL'}
                  >
                    {ocupado === 'probe' ? 'Conferindo…' : 'Conferir schema'}
                  </Button>
                )}

                {pode('cargaInicial') && (
                  <Button
                    variant="secondary"
                    onClick={() =>
                      void acao('bootstrap', '/core/sync/bootstrap', (r: never) => {
                        const x = r as { enqueued: number };
                        return `${x.enqueued} fato(s) do histórico enfileirado(s) para a central.`;
                      })
                    }
                    disabled={ocupado !== null}
                  >
                    {ocupado === 'bootstrap' ? 'Enfileirando…' : 'Carga inicial'}
                  </Button>
                )}

                <Button
                  onClick={() =>
                    void acao('run', '/core/sync/run', (r: never) => {
                      const x = r as {
                        sent: number;
                        failed: number;
                        error?: string;
                        projected?: { written: number; skippedByOrder: number };
                      };
                      if (x.error) return `A central recusou: ${x.error}`;
                      // ENTREGAR E PROJETAR SÃO COISAS DIFERENTES. Dizer só
                      // "enviados" faria o gestor acreditar que o consolidado
                      // do grupo já mostra a venda — e ele mostraria zero até
                      // a projeção rodar.
                      const projecao = x.projected
                        ? ` ${x.projected.written} linha(s) projetada(s) na central.`
                        : ' Projeção não executada: sem credencial da central.';
                      return `${x.sent} evento(s) enviado(s), ${x.failed} pendente(s).${projecao}`;
                    })
                  }
                  disabled={ocupado !== null || status.readiness === 'READY_FOR_CREDENTIAL'}
                >
                  {ocupado === 'run' ? 'Enviando…' : 'Sincronizar agora'}
                </Button>
              </div>
            </div>

            {mensagem && (
              <p role="status" className="mt-3 mb-0 text-[length:var(--gs-text-sm)]">
                {mensagem}
              </p>
            )}

            {status.outbox.lastError && (
              <p className="mt-3 mb-0 text-[length:var(--gs-text-sm)] text-[var(--gs-danger)]">
                Última falha: {status.outbox.lastError}
                {status.outbox.lastErrorKind === 'TRANSPORTE'
                  && ' — a central não respondeu; a fila tenta de novo sozinha, sem limite de tentativas.'}
                {status.outbox.lastErrorKind === 'RECUSA'
                  && ' — a central recusou o evento; insistir não resolve, é preciso tratar a causa.'}
              </p>
            )}

            {status.outbox.dead > 0 && (
              <div className="mt-4 p-3 rounded-[var(--gs-radius)] bg-[var(--gs-danger-bg)]">
                <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-danger)]">
                  <strong>{status.outbox.dead} evento(s) parado(s).</strong> Eles falharam vezes
                  demais e não tentam mais sozinhos — insistir não resolveria. Resolva a causa
                  (schema, credencial, rede) e devolva-os à fila.
                  {!pode('reviver') && ' Quem devolve à fila é o gerente da loja ou a gestão do grupo.'}
                </p>
                {pode('reviver') && (
                  <Button
                    variant="secondary"
                    onClick={() =>
                      void acao('revive', '/core/sync/revive', (r: never) => {
                        const x = r as { revived: number };
                        return `${x.revived} evento(s) devolvido(s) à fila.`;
                      })
                    }
                    disabled={ocupado !== null}
                  >
                    {ocupado === 'revive' ? 'Devolvendo…' : 'Tentar novamente'}
                  </Button>
                )}
              </div>
            )}

            {status.outbox.oldestPendingAt && (
              <p className="mt-3 mb-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                O fato mais antigo na fila aconteceu em {dataHora(status.outbox.oldestPendingAt)}.
                Nada se perde enquanto espera — a fila só é liberada com a confirmação da central.
              </p>
            )}
          </Card>

          {/*
            ENTREGAR NÃO É PROJETAR (GAP-PRD-048).

            O fato chega à aterrissagem da central e, numa segunda chamada, vira
            linha nas tabelas do consolidado. O último erro dessa segunda chamada
            era gravado e nunca lido: "faltou um dia" e "continua faltando"
            eram indistinguíveis sem abrir o painel da Supabase.
          */}
          {status.projecao && (
            <div className="mt-5">
              <Card>
                <div data-testid="sync-projecao">
                  <Badge
                    tone={
                      status.projecao.ultimoErro
                        ? 'danger'
                        : status.projecao.ultimaAceitaEm
                          ? 'success'
                          : 'warning'
                    }
                  >
                    {status.projecao.ultimoErro
                      ? 'PROJEÇÃO FALHANDO'
                      : status.projecao.ultimaAceitaEm
                        ? 'PROJEÇÃO ACEITA'
                        : 'NENHUMA PROJEÇÃO AINDA'}
                  </Badge>
                  {status.projecao.ultimoErro && (
                    <>
                      <p className="mt-2 mb-0 text-[length:var(--gs-text-sm)] text-[var(--gs-danger)]">
                        A última projeção falhou em{' '}
                        {status.projecao.ultimoErroEm
                          ? dataHora(status.projecao.ultimoErroEm)
                          : 'data desconhecida (registrada por uma versão anterior)'}
                        : {status.projecao.ultimoErro}
                      </p>
                      <p className="mt-2 mb-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                        O fato está salvo na aterrissagem da central, mas o consolidado do grupo não o
                        mostra até a projeção voltar. Se o erro fala em PGRST202, a função
                        erp_apply_projections não existe na central: rode docs/supabase/03-projecao.sql
                        no SQL Editor e depois o comando reprojetar-central.
                      </p>
                    </>
                  )}
                  <p className="mt-2 mb-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                    {status.projecao.ultimaAceitaEm
                      ? `Última projeção aceita pela central: ${dataHora(status.projecao.ultimaAceitaEm)}.`
                      : 'Nenhuma projeção aceita pela central registrada neste nó.'}
                  </p>
                </div>
              </Card>
            </div>
          )}
        </>
      )}
    </AppShell>
  );
}
