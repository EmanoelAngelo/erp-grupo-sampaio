/**
 * Fiscal › Documentos.
 *
 * A tela responde: que notas saíram, quais valeram e quais não. O que não pode
 * acontecer aqui é uma nota rejeitada parecer igual a uma autorizada — quem
 * confere o movimento do dia decide pela cor e pelo selo, não lendo cStat.
 *
 * A reconciliação vive junto, e de propósito: quem abre a lista de documentos é
 * quem precisa saber que existem incoerências.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppShell } from '@/components/gs/AppShell';
import {
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  Field,
  Input,
  Kpi,
  PageHeader,
} from '@/components/gs/ui';
import { formatCents } from '@/components/gs/format';
import { CaminhoDoAtoFiscal } from '@/components/gs/CaminhoDoAtoFiscal';
import { FilaFiscalCard } from '@/components/gs/FilaFiscal';
import { ContingenciaFiscalCard } from '@/components/gs/ContingenciaFiscal';
import { filaFiscalApi } from '@/lib/api/filaFiscal';
import { podeEnviarAtoFiscal, usePlanoDoAtoFiscal } from '@/components/gs/planoDoAtoFiscal';
import { ApiRequestError, apiDocument } from '@/lib/api/client';
import {
  coreApi,
  type FiscalDocumentRow,
  type FiscalEvent,
  type ReconciliationReport,
} from '@/lib/api/core';
import { dataHoraBR } from '@/lib/datas';

const STATUS_TOM: Record<string, 'success' | 'danger' | 'warning' | 'neutral' | 'info'> = {
  AUTHORIZED: 'success',
  REJECTED: 'danger',
  CANCELLED: 'danger',
  ERROR: 'danger',
  SENDING: 'warning',
  QUEUED: 'warning',
  CONTINGENCY: 'warning',
  DRAFT: 'neutral',
  VALIDATED: 'neutral',
  SIGNED: 'info',
};

const STATUS_ROTULO: Record<string, string> = {
  DRAFT: 'Preparando',
  VALIDATED: 'Validada',
  SIGNED: 'Assinada',
  QUEUED: 'Na fila',
  SENDING: 'Enviando',
  AUTHORIZED: 'Autorizada',
  REJECTED: 'Rejeitada',
  CONTINGENCY: 'Contingência',
  CANCELLED: 'Cancelada',
  ERROR: 'Erro',
};

/**
 * Nomes dos eventos em português.
 *
 * A linha do tempo é lida por quem opera, não por quem escreveu o código.
 * `cce_rejected` na tela não informa nada — e é justamente o evento em que a
 * pessoa mais precisa entender o que aconteceu.
 */
const EVENTO_ROTULO: Record<string, string> = {
  cancel_requested: 'Cancelamento pedido',
  cancelled: 'Cancelamento autorizado',
  cancel_rejected: 'Cancelamento RECUSADO pela SEFAZ',
  cce_requested: 'Carta de correção enviada',
  cce_authorized: 'Carta de correção autorizada',
  cce_rejected: 'Carta de correção RECUSADA pela SEFAZ',
  void_requested: 'Inutilização pedida',
  void_authorized: 'Inutilização autorizada',
  void_rejected: 'Inutilização RECUSADA pela SEFAZ',
};

/** Eventos que precisam saltar aos olhos: nada foi feito, e alguém precisa agir. */
const EVENTO_RECUSA = new Set(['cancel_rejected', 'cce_rejected', 'void_rejected']);

/** Mudança de estado interna — não é evento fiscal, e a tela diz isso. */
function rotuloEvento(eventType: string): string {
  const conhecido = EVENTO_ROTULO[eventType];
  if (conhecido) return conhecido;
  const transicao = /^status:(\w+)->(\w+)$/.exec(eventType);
  if (!transicao) return eventType;
  const [, de, para] = transicao;
  if (de === para) return `${STATUS_ROTULO[para] ?? para} (início)`;
  return `${STATUS_ROTULO[de] ?? de} → ${STATUS_ROTULO[para] ?? para}`;
}

/**
 * Quem está do outro lado da nota.
 *
 * "Consumidor" é conceito de NFC-e — venda no balcão sem identificação. Numa
 * NF-e o destinatário é obrigatório, e escrever "Consumidor" ali seria dizer
 * algo que a nota não diz.
 */
function nomeContraparte(doc: FiscalDocumentRow): string {
  if (doc.customerName) return doc.customerName;
  return doc.model === '65' ? 'Consumidor' : '—';
}

/** Protocolo real da SEFAZ é numérico; o do provider de teste começa com TEST-. */
/**
 * NFC-e emitida em contingência off-line (tpEmis 9, posição 35 da chave) e
 * ainda sem desfecho: o DANFCE de contingência já vale no balcão, sem prévia
 * (GAP-PRD-098).
 */
function offlinePendente(doc: FiscalDocumentRow): boolean {
  return (
    doc.model === '65'
    && doc.accessKey?.charAt(34) === '9'
    && ['CONTINGENCY', 'QUEUED', 'SENDING'].includes(doc.status)
  );
}

function ehTeste(doc: FiscalDocumentRow): boolean {
  return Boolean(doc.protocol?.startsWith('TEST-'));
}

const dataHora = dataHoraBR;

export default function FiscalDocumentosPage() {
  const [itens, setItens] = useState<FiscalDocumentRow[] | null>(null);
  const [recon, setRecon] = useState<ReconciliationReport | null>(null);
  const [filtros, setFiltros] = useState({
    status: '',
    model: '',
    environment: '',
    from: '',
    to: '',
    search: '',
  });
  const [aberto, setAberto] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    setError(null);
    try {
      setItens(await coreApi.listFiscalDocuments(filtros));
    } catch (err) {
      setItens(null);
      setError(err instanceof ApiRequestError ? err.message : 'Falha ao carregar documentos.');
    }
  }, [filtros]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  // Falha ao abrir DANFE/XML não pode sumir no console: quem clicou está
  // esperando um documento e precisa saber por que ele não veio.
  const falhouAoAbrir = useCallback((err: unknown) => {
    setError(
      err instanceof ApiRequestError ? err.message : 'Não foi possível abrir o documento.',
    );
  }, []);

  useEffect(() => {
    // A reconciliação é de gestão; o caixa vê a lista mas não o diagnóstico.
    void coreApi
      .getFiscalReconciliation()
      .then(setRecon)
      .catch(() => setRecon(null));
  }, []);

  const resumo = useMemo(() => {
    const lista = itens ?? [];
    return {
      total: lista.length,
      autorizadas: lista.filter((d) => d.status === 'AUTHORIZED').length,
      rejeitadas: lista.filter((d) => d.status === 'REJECTED').length,
      pendentes: lista.filter((d) => ['QUEUED', 'SENDING', 'DRAFT', 'VALIDATED', 'SIGNED'].includes(d.status))
        .length,
    };
  }, [itens]);

  return (
    <AppShell>
      <PageHeader breadcrumb={['Fiscal', 'Documentos']} title="Documentos fiscais" />

      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4 mb-5">
        <Kpi label="No período" value={String(resumo.total)} />
        <Kpi label="Autorizadas" value={String(resumo.autorizadas)} tone="positive" />
        <Kpi
          label="Rejeitadas"
          value={String(resumo.rejeitadas)}
          tone={resumo.rejeitadas > 0 ? 'warning' : 'neutral'}
        />
        <Kpi label="Em andamento" value={String(resumo.pendentes)} />
      </div>

      {/* A fila de transmissão (GAP-PRD-020): o que espera, por quê, e o gesto
          de transmitir agora. Some para quem não é gestão. */}
      <div className="mb-5">
        <FilaFiscalCard onMudou={carregar} />
      </div>
      {/* A contingência da NFC-e (GAP-PRD-098): modalidade do contador, o
          período aberto e o gesto de abrir/fechar. */}
      <div className="mb-5">
        <ContingenciaFiscalCard onMudou={carregar} />
      </div>

      {recon && !recon.healthy && (
        <div className="mb-5">
          <ReconciliacaoCard relatorio={recon} />
        </div>
      )}

      <Card title="Documentos" subtitle="Ordenados do mais recente para o mais antigo.">
        <div className="grid grid-cols-1 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-4">
          <Field label="De">
            {(p) => (
              <Input
                {...p}
                type="date"
                value={filtros.from}
                onChange={(e) => setFiltros((f) => ({ ...f, from: e.target.value }))}
              />
            )}
          </Field>
          <Field label="Até">
            {(p) => (
              <Input
                {...p}
                type="date"
                value={filtros.to}
                onChange={(e) => setFiltros((f) => ({ ...f, to: e.target.value }))}
              />
            )}
          </Field>
          <Field label="Situação">
            {(p) => (
              <select
                {...p}
                value={filtros.status}
                onChange={(e) => setFiltros((f) => ({ ...f, status: e.target.value }))}
                className="h-11 px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border)]
                  bg-[var(--gs-surface)] text-[length:var(--gs-text-base)] text-[var(--gs-text)]"
              >
                <option value="">Todas</option>
                {Object.entries(STATUS_ROTULO).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Modelo">
            {(p) => (
              <select
                {...p}
                value={filtros.model}
                onChange={(e) => setFiltros((f) => ({ ...f, model: e.target.value }))}
                className="h-11 px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border)]
                  bg-[var(--gs-surface)] text-[length:var(--gs-text-base)] text-[var(--gs-text)]"
              >
                <option value="">Todos</option>
                <option value="65">NFC-e (65)</option>
                <option value="55">NF-e (55)</option>
              </select>
            )}
          </Field>
          <Field label="Ambiente">
            {(p) => (
              <select
                {...p}
                value={filtros.environment}
                onChange={(e) => setFiltros((f) => ({ ...f, environment: e.target.value }))}
                className="h-11 px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border)]
                  bg-[var(--gs-surface)] text-[length:var(--gs-text-base)] text-[var(--gs-text)]"
              >
                <option value="">Todos</option>
                <option value="homologation">Homologação</option>
                <option value="production">Produção</option>
              </select>
            )}
          </Field>
          <Field label="Cliente, chave ou número">
            {(p) => (
              <Input
                {...p}
                value={filtros.search}
                onChange={(e) => setFiltros((f) => ({ ...f, search: e.target.value }))}
              />
            )}
          </Field>
        </div>

        {error && (
          <p
            role="alert"
            className="px-3 py-2 mb-4 rounded-[var(--gs-radius)] bg-[var(--gs-danger-bg)]
              text-[length:var(--gs-text-sm)] text-[var(--gs-danger)]"
          >
            {error}
          </p>
        )}

        {itens && (
          <DataTable
            rows={itens}
            keyOf={(d) => d.id}
            empty={
              <EmptyState
                title="Nenhum documento"
                description="Nenhuma nota fiscal foi emitida com esses filtros."
              />
            }
            columns={[
              { header: 'Emissão', render: (d) => dataHora(d.createdAt) },
              {
                header: 'Documento',
                render: (d) => (
                  <div className="flex flex-col">
                    <span className="font-semibold text-[var(--gs-purple-900)]">
                      {d.model === '65' ? 'NFC-e' : 'NF-e'} {d.number}/{d.serie}
                    </span>
                    {d.saleNumber && (
                      <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                        Venda {d.saleNumber}
                      </span>
                    )}
                  </div>
                ),
              },
              { header: 'Cliente', render: (d) => nomeContraparte(d) },
              {
                header: 'Valor',
                align: 'right',
                render: (d) => (d.totalCents === null ? '—' : formatCents(d.totalCents)),
              },
              {
                header: 'Situação',
                render: (d) => (
                  <div className="flex flex-col gap-1 items-start">
                    <Badge tone={STATUS_TOM[d.status] ?? 'neutral'}>
                      {STATUS_ROTULO[d.status] ?? d.status}
                    </Badge>
                    {ehTeste(d) && <Badge tone="warning">TESTE</Badge>}
                    {d.cStat && (
                      <span className="text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
                        cStat {d.cStat}
                      </span>
                    )}
                  </div>
                ),
              },
              {
                header: 'Ações',
                align: 'right',
                render: (d) => (
                  <div className="flex gap-2 justify-end flex-wrap">
                    <Button size="sm" variant="ghost" onClick={() => setAberto(d.id)}>
                      Detalhes
                    </Button>
                    {/* Nota cancelada também tem espelho — com a tarja de
                        cancelamento. "Prévia técnica" ali diria que o documento
                        nunca valeu, e ele valeu. */}
                    {offlinePendente(d) ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void abrirEspelho(d, false).catch(falhouAoAbrir)}
                      >
                        DANFCE de contingência
                      </Button>
                    ) : d.status === 'AUTHORIZED' || d.status === 'CANCELLED' ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void abrirEspelho(d, false).catch(falhouAoAbrir)}
                      >
                        {nomeEspelho(d.model)}
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void abrirEspelho(d, true).catch(falhouAoAbrir)}
                      >
                        Prévia técnica
                      </Button>
                    )}
                  </div>
                ),
              },
            ]}
          />
        )}
      </Card>

      {aberto && (
        <DetalheDocumento
          id={aberto}
          onFechar={() => setAberto(null)}
          onMudou={carregar}
        />
      )}
    </AppShell>
  );
}

/** DANFE e DANFCE são documentos diferentes. Trocar o nome já é erro. */
function nomeEspelho(model: string): string {
  return model === '65' ? 'DANFCE' : 'DANFE';
}

/**
 * Abre o espelho impresso numa aba.
 *
 * A rota segue o MODELO, não o gosto de quem escreveu o botão: pedir o DANFCE
 * de uma NF-e devolve o layout errado, e quem imprime não tem como perceber.
 *
 * Documento não autorizado exige `preview=1` — o servidor recusa sem isso, e a
 * prévia sai com tarja. É a mesma regra dos dois lados.
 *
 * O conteúdo é BUSCADO AUTENTICADO e só então aberto. Apontar a aba nova para
 * a URL da API entregava um JSON de "autenticação obrigatória" a quem clicou
 * em DANFE — a aba não carrega o token da sessão.
 */
async function abrirEspelho(doc: FiscalDocumentRow, preview: boolean): Promise<void> {
  const rota = doc.model === '65' ? 'danfce' : 'danfe';
  const { content } = await apiDocument(
    `/core/fiscal/documents/${doc.id}/${rota}${preview ? '?preview=1' : ''}`,
  );
  abrirConteudo(content, 'text/html');
}

/** Abre conteúdo já baixado numa aba, sem passar pela rede de novo. */
function abrirConteudo(conteudo: string, tipo: string): void {
  const url = URL.createObjectURL(new Blob([conteudo], { type: `${tipo};charset=utf-8` }));
  window.open(url, '_blank', 'noopener');
  // A aba já leu o blob; segurar a URL só vazaria memória.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function ReconciliacaoCard({ relatorio }: { relatorio: ReconciliationReport }) {
  return (
    <Card
      title="Reconciliação fiscal"
      subtitle={`${relatorio.critical} crítica(s) e ${relatorio.warnings} aviso(s). Nada é corrigido automaticamente.`}
    >
      <ul className="list-none p-0 m-0 flex flex-col gap-3">
        {relatorio.issues.map((issue) => (
          <li
            key={issue.check}
            className={`p-3 rounded-[var(--gs-radius)] ${
              issue.severity === 'CRITICAL'
                ? 'bg-[var(--gs-danger-bg)]'
                : 'bg-[var(--gs-warning-bg)]'
            }`}
          >
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <Badge tone={issue.severity === 'CRITICAL' ? 'danger' : 'warning'}>
                {issue.severity === 'CRITICAL' ? 'CRÍTICO' : 'AVISO'}
              </Badge>
              <span className="font-semibold text-[length:var(--gs-text-base)]">{issue.summary}</span>
            </div>
            <p className="text-[length:var(--gs-text-sm)] m-0 mb-1">{issue.impact}</p>
            <p className="text-[length:var(--gs-text-sm)] font-semibold m-0">O que fazer: {issue.action}</p>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** Detalhe com a linha do tempo — a fonte é `core_fiscal_events`, append-only. */
function DetalheDocumento({
  id,
  onFechar,
  onMudou,
}: {
  id: string;
  onFechar: () => void;
  onMudou: () => Promise<void>;
}) {
  const [dados, setDados] = useState<{
    document: FiscalDocumentRow;
    events: FiscalEvent[];
  } | null>(null);
  const [acao, setAcao] = useState<'cancel' | 'cce' | null>(null);
  const [mensagem, setMensagem] = useState<string | null>(null);
  const [transmitindo, setTransmitindo] = useState(false);

  useEffect(() => {
    // Trocar de documento zera o que era daquele outro. "Nota cancelada" ficava
    // pendurado no detalhe da nota SEGUINTE, que não foi cancelada.
    setAcao(null);
    setMensagem(null);
    setDados(null);
    void coreApi
      .getFiscalDocument(id)
      .then(setDados)
      .catch(() => setDados(null));
  }, [id]);

  if (!dados) return null;
  const d = dados.document;

  return (
    <div className="mt-5">
      <Card
        title={`${d.model === '65' ? 'NFC-e' : 'NF-e'} ${d.number}/${d.serie}`}
        subtitle={`${STATUS_ROTULO[d.status] ?? d.status}${d.cStat ? ` · cStat ${d.cStat}` : ''}`}
      >
        <div className="flex flex-col gap-4">
          {ehTeste(d) && (
            <p
              role="status"
              className="px-3 py-2 rounded-[var(--gs-radius)] bg-[var(--gs-warning-bg)]
                text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-warning)]"
            >
              Autorizada pelo provider de TESTE — não é homologação SEFAZ real.
            </p>
          )}

          {/* QUEM DISSE O MOTIVO. Com cStat, foi a SEFAZ. Sem cStat, a recusa é
              da conferência local — leiaute pelo XSD, XML mal formado,
              autoconferência da assinatura (GAP-PRD-097) — e o documento nem
              chegou ao fisco. Chamar isso de "retorno da SEFAZ" mandaria a
              pessoa procurar o problema no lugar errado. */}
          {d.xMotivo && (
            <p className="text-[length:var(--gs-text-base)] m-0">
              <strong>
                {d.cStat ? 'Retorno da SEFAZ:' : 'Recusado na conferência local, antes da SEFAZ:'}
              </strong>{' '}
              {d.xMotivo}
            </p>
          )}

          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-2 m-0">
            <Linha rotulo="Chave de acesso" valor={d.accessKey ?? '—'} mono />
            <Linha rotulo="Protocolo" valor={d.protocol ?? '—'} mono />
            <Linha rotulo="Ambiente" valor={d.environment === 'production' ? 'Produção' : 'Homologação'} />
            <Linha rotulo="Autorizada em" valor={dataHora(d.authorizedAt)} />
            <Linha
              rotulo={d.model === '55' ? 'Destinatário' : 'Cliente'}
              valor={nomeContraparte(d)}
            />
            {d.recipientDocument && (
              <Linha rotulo="CNPJ/CPF do destinatário" valor={d.recipientDocument} mono />
            )}
            <Linha
              rotulo="Valor"
              valor={d.totalCents === null ? '—' : formatCents(d.totalCents)}
            />
          </dl>

          <div>
            <h3 className="text-[length:var(--gs-text-base)] font-semibold text-[var(--gs-purple-900)] m-0 mb-2">
              Linha do tempo
            </h3>
            <ul className="list-none p-0 m-0 flex flex-col gap-2">
              {dados.events.map((e, i) => (
                <li
                  key={`${e.createdAt}-${i}`}
                  className="flex gap-3 text-[length:var(--gs-text-sm)] items-start"
                >
                  <span className="text-[var(--gs-muted)] whitespace-nowrap">
                    {dataHora(e.createdAt)}
                  </span>
                  <span className="flex flex-col gap-0.5">
                    <span
                      className={
                        EVENTO_RECUSA.has(e.eventType)
                          ? 'font-semibold text-[var(--gs-danger)]'
                          : 'font-semibold'
                      }
                    >
                      {rotuloEvento(e.eventType)}
                      {e.eventType.startsWith('cce_') && ` nº ${e.sequence}`}
                    </span>
                    {/* O motivo da recusa é o que diz ao operador o que fazer
                        agora. Escondê-lo transforma "recusado" em beco sem saída. */}
                    {e.xMotivo && (
                      <span className="text-[var(--gs-text-soft)]">
                        {e.cStat ? `cStat ${e.cStat} — ` : ''}
                        {e.xMotivo}
                      </span>
                    )}
                    {/* Transição interna guarda JSON no mesmo campo; JSON cru na
                        tela não é informação, é ruído. */}
                    {e.detail && !e.eventType.startsWith('status:') && (
                      <span className="text-[var(--gs-muted)]">Justificativa: {e.detail}</span>
                    )}
                    {e.protocol && (
                      <span className="text-[var(--gs-muted)] font-mono break-all">
                        Protocolo {e.protocol}
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          {/* A NOTA QUE ESPERA TEM GESTO (GAP-PRD-020). Na fila ou em
              contingência, o gestor transmite agora — a contingência deixou de
              ser beco sem saída pela tela. O número e a chave não mudam. */}
          {(d.status === 'QUEUED' || d.status === 'CONTINGENCY') && (
            <div className="flex gap-2 flex-wrap pt-3 border-t border-[var(--gs-border)]">
              <Button
                loading={transmitindo}
                onClick={() => {
                  setTransmitindo(true);
                  setMensagem(null);
                  void filaFiscalApi
                    .transmitirAgora(d.id)
                    .then(async (r) => {
                      setMensagem(`${r.statusLabel}.`);
                      await onMudou();
                      setDados(await coreApi.getFiscalDocument(id));
                    })
                    .catch((err) =>
                      setMensagem(
                        err instanceof ApiRequestError ? err.message : 'Não foi possível transmitir agora.',
                      ),
                    )
                    .finally(() => setTransmitindo(false));
                }}
              >
                {d.status === 'CONTINGENCY' ? 'Devolver à fila e transmitir' : 'Transmitir agora'}
              </Button>
            </div>
          )}

          {/* Ações fiscais só existem para nota autorizada — e só de modelo 55
              no caso da carta, que é o que a lei prevê. */}
          {d.status === 'AUTHORIZED' && (
            <div className="flex gap-2 flex-wrap pt-3 border-t border-[var(--gs-border)]">
              <Button variant="ghost" onClick={() => setAcao('cancel')}>
                Cancelar {d.model === '55' ? 'NF-e' : 'NFC-e'}
              </Button>
              {d.model === '55' && (
                <Button variant="ghost" onClick={() => setAcao('cce')}>
                  Carta de correção
                </Button>
              )}
              <Button
                variant="ghost"
                onClick={() =>
                  void abrirXml(d.id).catch((err) =>
                    setMensagem(
                      err instanceof ApiRequestError
                        ? err.message
                        : 'Não foi possível abrir o XML.',
                    ),
                  )
                }
              >
                Ver XML
              </Button>
            </div>
          )}

          {acao === 'cancel' && (
            <CancelarDialog
              doc={d}
              onFechar={() => setAcao(null)}
              onConcluido={async (msg) => {
                setAcao(null);
                setMensagem(msg);
                await onMudou();
                setDados(await coreApi.getFiscalDocument(id));
              }}
            />
          )}

          {acao === 'cce' && (
            <CartaCorrecaoDialog
              doc={d}
              onFechar={() => setAcao(null)}
              onConcluido={async (msg) => {
                setAcao(null);
                setMensagem(msg);
                setDados(await coreApi.getFiscalDocument(id));
              }}
            />
          )}

          {mensagem && (
            <p
              role="status"
              className="px-3 py-2 rounded-[var(--gs-radius)] bg-[var(--gs-info-bg)]
                text-[length:var(--gs-text-sm)] text-[var(--gs-info)]"
            >
              {mensagem}
            </p>
          )}

          <div>
            <Button variant="ghost" onClick={onFechar}>
              Fechar
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}

/** O XML é o arquivo que vai para o contador — também precisa de sessão. */
async function abrirXml(documentId: string): Promise<void> {
  const { content } = await apiDocument(`/core/fiscal/documents/${documentId}/xml`);
  abrirConteudo(content, 'text/xml');
}

/**
 * Cancelamento.
 *
 * O aviso sobre a venda é obrigatório e fica em destaque: quem cancela a nota
 * costuma achar que cancelou o negócio. Não cancelou — o cliente pagou e levou
 * a mercadoria, e desfazer isso é outra decisão, em outro lugar.
 */
function CancelarDialog({
  doc,
  onFechar,
  onConcluido,
}: {
  doc: FiscalDocumentRow;
  onFechar: () => void;
  onConcluido: (mensagem: string) => Promise<void>;
}) {
  const [justificativa, setJustificativa] = useState('');
  const [senha, setSenha] = useState('');
  const [busy, setBusy] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  // Para onde o cancelamento vai — o servidor decide pela procedência da nota.
  const plano = usePlanoDoAtoFiscal(doc.id);

  const enviar = useCallback(async () => {
    setBusy(true);
    setErro(null);
    try {
      const r = await coreApi.cancelFiscalDocument(doc.id, justificativa, senha || undefined);
      // Recusa do fisco não é erro do sistema: a nota continua valendo, e o
      // operador precisa ler o motivo.
      await onConcluido(
        r.accepted
          ? `Nota cancelada. Protocolo do evento: ${r.protocol}.`
          : `A SEFAZ recusou o cancelamento${r.cStat ? ` (cStat ${r.cStat})` : ''}: `
            + `${r.xMotivo ?? 'sem motivo informado'}. A nota continua válida.`,
      );
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao cancelar.');
    } finally {
      setBusy(false);
    }
  }, [doc.id, justificativa, senha, onConcluido]);

  return (
    <Card
      title={`Cancelar ${doc.model === '55' ? 'NF-e' : 'NFC-e'} ${doc.number}/${doc.serie}`}
      subtitle={`Chave ${doc.accessKey ?? '—'}`}
    >
      <div className="flex flex-col gap-4">
        <div
          role="alert"
          className="px-4 py-3 rounded-[var(--gs-radius)] border-2 border-[var(--gs-warning)]
            bg-[var(--gs-warning-bg)] text-[var(--gs-warning)]"
        >
          <strong className="block text-[length:var(--gs-text-base)]">
            Cancelar a NF-e não cancela automaticamente a venda, o pagamento nem o estoque.
          </strong>
          <span className="text-[length:var(--gs-text-sm)]">
            O documento fiscal deixa de valer; o negócio continua registrado. Desfazer a venda é
            uma operação separada.
          </span>
        </div>

        <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)] m-0">
          Destinatário: {nomeContraparte(doc)}
        </p>

        <Field
          label="Justificativa"
          required
          hint="Mínimo de 15 caracteres — é o que explica o cancelamento a quem auditar depois."
        >
          {(p) => (
            <Input
              {...p}
              value={justificativa}
              onChange={(e) => setJustificativa(e.target.value)}
            />
          )}
        </Field>

        <CaminhoDoAtoFiscal estado={plano} senha={senha} onSenha={setSenha} />

        {erro && (
          <p role="alert" className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-danger)]">
            {erro}
          </p>
        )}

        <div className="flex gap-3">
          <Button
            loading={busy}
            disabled={justificativa.trim().length < 15 || !podeEnviarAtoFiscal(plano, senha)}
            onClick={() => void enviar()}
          >
            Confirmar cancelamento
          </Button>
          <Button variant="ghost" onClick={onFechar}>
            Voltar
          </Button>
        </div>
      </div>
    </Card>
  );
}

/**
 * Carta de correção.
 *
 * NÃO se chama "editar NF-e", e o texto da tela evita a palavra: a carta não
 * altera a nota — ela se soma a ela. Quem espera edição vai tentar corrigir
 * valor, e o sistema recusa.
 */
function CartaCorrecaoDialog({
  doc,
  onFechar,
  onConcluido,
}: {
  doc: FiscalDocumentRow;
  onFechar: () => void;
  onConcluido: (mensagem: string) => Promise<void>;
}) {
  const [texto, setTexto] = useState('');
  const [senha, setSenha] = useState('');
  const [aviso, setAviso] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const plano = usePlanoDoAtoFiscal(doc.id);

  useEffect(() => {
    // O aviso vem do domínio, não é texto solto na tela: se a política mudar,
    // muda num lugar só.
    void coreApi
      .getCorrectionLetterNotice()
      .then(setAviso)
      .catch(() => setAviso(null));
  }, []);

  const enviar = useCallback(async () => {
    setBusy(true);
    setErro(null);
    try {
      const r = await coreApi.createCorrectionLetter(doc.id, texto, senha || undefined);
      await onConcluido(
        r.accepted
          ? `Carta de correção nº ${r.sequence} registrada. Protocolo: ${r.protocol}.`
          : `A SEFAZ recusou a carta${r.cStat ? ` (cStat ${r.cStat})` : ''}: `
            + `${r.xMotivo ?? 'sem motivo informado'}.`,
      );
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao enviar a carta.');
    } finally {
      setBusy(false);
    }
  }, [doc.id, texto, senha, onConcluido]);

  return (
    <Card
      title={`Carta de correção — NF-e ${doc.number}/${doc.serie}`}
      subtitle="A sequência é atribuída pelo sistema."
    >
      <div className="flex flex-col gap-4">
        {aviso && (
          <p
            className="px-4 py-3 rounded-[var(--gs-radius)] bg-[var(--gs-info-bg)]
              text-[length:var(--gs-text-sm)] text-[var(--gs-info)] m-0"
          >
            {aviso}
          </p>
        )}

        <Field
          label="Texto da correção"
          required
          hint="Entre 15 e 1000 caracteres. Descreva o que está sendo esclarecido."
        >
          {(p) => (
            <Input {...p} value={texto} onChange={(e) => setTexto(e.target.value)} />
          )}
        </Field>

        <CaminhoDoAtoFiscal estado={plano} senha={senha} onSenha={setSenha} />

        {erro && (
          <p role="alert" className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-danger)]">
            {erro}
          </p>
        )}

        <div className="flex gap-3">
          <Button
            loading={busy}
            disabled={texto.trim().length < 15 || !podeEnviarAtoFiscal(plano, senha)}
            onClick={() => void enviar()}
          >
            Enviar carta de correção
          </Button>
          <Button variant="ghost" onClick={onFechar}>
            Voltar
          </Button>
        </div>
      </div>
    </Card>
  );
}

function Linha({ rotulo, valor, mono }: { rotulo: string; valor: string; mono?: boolean }) {
  return (
    <div className="flex flex-col">
      <dt className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">{rotulo}</dt>
      <dd className={`m-0 text-[length:var(--gs-text-base)] ${mono ? 'font-mono break-all' : ''}`}>
        {valor}
      </dd>
    </div>
  );
}
