/**
 * ============================================================================
 * AUDITORIA — a trilha ganha leitor
 * ============================================================================
 *
 * ## O que esta tela é
 *
 * `core_audit_log` tem 128 escritores no servidor e, até a rodada 32, um
 * leitor que nenhuma tela chamava. O rastro era gravado e ilegível: o dono não
 * conseguia responder "quem deu esse desconto? quem cancelou essa venda?" sem
 * abrir o banco na mão. Esta tela é o leitor — e SÓ o leitor: a trilha é
 * append-only e não há aqui botão que escreva nada.
 *
 * ## QUEM CHEGA AQUI — e por que não é o escritório inteiro
 *
 * `GET /core/audit` é guardada por `requireProfile(req)` sem perfis nomeados:
 * `admin_geral` e `gestor`, e mais ninguém. A auditoria expõe as ações de TODO
 * MUNDO, inclusive as dos gerentes — desconto liberado, venda cancelada, preço
 * mexido. Abri-la ao `gerente_loja` faria o vigiado ler o próprio diário de
 * vigilância. Quem investiga responde pelo grupo; quem opera aparece na
 * trilha. O roteador declara `DONOS_DO_GRUPO` e o menu declara o mesmo — as
 * três afirmações são a mesma lista, e `menu-e-rotas.test.tsx` quebra no dia
 * em que uma mudar sozinha.
 *
 * ## FILTRO E PÁGINA SÃO DO SERVIDOR
 *
 * Toda mudança de filtro, busca ou página vira uma consulta nova. Filtrar no
 * navegador só filtraria a página carregada — e "quem cancelou essa venda em
 * março?" mora justamente nas páginas que a tela nunca puxou. O `total` volta
 * filtrado, senão a numeração contaria um universo errado.
 */
import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/gs/AppShell';
import { Badge, Button, Card, DataTable, EmptyState, Input, PageHeader } from '@/components/gs/ui';
import { ApiRequestError } from '@/lib/api/client';
import {
  coreApi,
  type LiberacaoDeGestor,
  type PaginaDeAuditoria,
  type RegistroDeAuditoria,
} from '@/lib/api/core';
import { dataHoraBR } from '@/lib/datas';

const POR_PAGINA = 50;

/** Quando aconteceu, com hora: numa trilha, o dia sozinho não separa turnos. */
/** O carimbo da auditoria, no relógio da loja. */
function quando(iso: string): string {
  return dataHoraBR(iso, iso);
}

/**
 * O `detail` gravado, legível.
 *
 * O escritor grava JSON livre (cada um dos 128 grava o seu), e mostrar o JSON
 * cru obrigaria o dono a ler chaves e aspas. Um objeto plano vira pares
 * "chave: valor"; o que não for plano (lista, texto, número) sai como veio —
 * inventar formato para o desconhecido esconderia justamente o dado estranho
 * que quem investiga procura.
 */
function detalheLegivel(detail: string | null): string {
  if (!detail) return '—';
  try {
    const dado: unknown = JSON.parse(detail);
    if (dado === null) return '—';
    if (typeof dado !== 'object' || Array.isArray(dado)) return String(detail);
    return (
      Object.entries(dado as Record<string, unknown>)
        .map(([chave, valor]) => `${chave}: ${typeof valor === 'object' ? JSON.stringify(valor) : String(valor)}`)
        .join(' · ') || '—'
    );
  } catch {
    // Detalhe que não é JSON é raro, mas não é erro: sai como o escritor gravou.
    return detail;
  }
}

export default function AuditoriaPage() {
  const [pagina, setPagina] = useState<PaginaDeAuditoria | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(true);

  // O filtro APLICADO, que é o que viaja na consulta. A caixa de busca tem
  // estado próprio (`buscaDigitada`) para a consulta só sair no Enter/botão —
  // uma consulta por tecla digitada martelaria a tabela que mais cresce.
  const [acao, setAcao] = useState('');
  const [busca, setBusca] = useState('');
  const [buscaDigitada, setBuscaDigitada] = useState('');
  const [deslocamento, setDeslocamento] = useState(0);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro(null);
    try {
      setPagina(
        await coreApi.listAudit({
          limit: POR_PAGINA,
          offset: deslocamento,
          action: acao || undefined,
          q: busca || undefined,
        }),
      );
    } catch (err) {
      // Nulo, e não página vazia: "não pude ler" e "a trilha não tem nada com
      // esse filtro" são fatos diferentes e não podem exibir a mesma coisa.
      setPagina(null);
      setErro(
        err instanceof ApiRequestError && err.status === 403
          ? 'Só quem responde pelo grupo (administrador ou gestor) lê a auditoria — quem opera aparece na trilha, não a lê.'
          : err instanceof ApiRequestError
            ? err.message
            : 'Falha ao carregar a trilha de auditoria.',
      );
    } finally {
      setCarregando(false);
    }
  }, [acao, busca, deslocamento]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const aplicarBusca = () => {
    setDeslocamento(0);
    setBusca(buscaDigitada.trim());
  };

  const total = pagina?.total ?? 0;
  const de = total === 0 ? 0 : deslocamento + 1;
  const ate = Math.min(deslocamento + (pagina?.items.length ?? 0), deslocamento + POR_PAGINA);

  return (
    <AppShell>
      <PageHeader
        breadcrumb={['Relatórios', 'Auditoria']}
        title="Auditoria"
        subtitle="Quem fez o quê, e quando. A trilha só se lê — nada aqui escreve nela."
      />

      {erro && (
        <div
          role="alert"
          className="mb-4 px-4 py-3 rounded-[var(--gs-radius)] border
            border-[var(--gs-danger)] bg-[var(--gs-danger-bg)]
            text-[var(--gs-danger)] text-[length:var(--gs-text-base)]"
        >
          {erro}
        </div>
      )}

      <Card
        title="Trilha de auditoria"
        subtitle="Cada linha é um fato consumado. Filtro e busca valem para o histórico inteiro, não só para esta página."
      >
        <form
          className="flex flex-wrap items-end gap-3 mb-4"
          onSubmit={(e) => {
            e.preventDefault();
            aplicarBusca();
          }}
        >
          <label className="flex flex-col gap-1.5">
            <span className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-text-soft)]">
              Ação
            </span>
            {/* As opções vêm do servidor — as ações que EXISTEM nesta empresa.
                Uma lista fixa aqui envelheceria a cada escritor novo. */}
            <select
              aria-label="Filtrar por ação"
              value={acao}
              onChange={(e) => {
                setDeslocamento(0);
                setAcao(e.target.value);
              }}
              className="h-10 px-3 rounded-[var(--gs-radius)] border
                border-[var(--gs-border-strong)] bg-[var(--gs-surface)]
                text-[var(--gs-text)] text-[length:var(--gs-text-base)] max-w-[320px]"
            >
              <option value="">Todas as ações</option>
              {(pagina?.actions ?? []).map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1.5 flex-1 min-w-[220px] max-w-md">
            <span className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-text-soft)]">
              Buscar no rastro
            </span>
            <Input
              value={buscaDigitada}
              onChange={(e) => setBuscaDigitada(e.target.value)}
              placeholder="Ação, entidade, id ou detalhe…"
            />
          </label>

          <Button type="submit" variant="secondary">
            Buscar
          </Button>
        </form>

        {carregando && <p className="text-[var(--gs-muted)]">Carregando…</p>}

        {pagina && (
          <>
            <DataTable
              rows={pagina.items}
              keyOf={(r) => r.id}
              empty={
                <EmptyState
                  title="Nada encontrado"
                  description={
                    acao || busca
                      ? 'Nenhum registro atende ao filtro. A trilha inteira foi consultada, não só esta página.'
                      : 'A trilha ainda não tem registros nesta operação.'
                  }
                />
              }
              columns={[
                { header: 'Quando', render: (r: RegistroDeAuditoria) => quando(r.created_at) },
                {
                  header: 'Quem',
                  render: (r: RegistroDeAuditoria) =>
                    r.user_name ? (
                      <span className="font-semibold text-[var(--gs-purple-900)]">
                        {r.user_name}
                      </span>
                    ) : (
                      // Sem usuário não é lacuna: webhook, job e migração agem
                      // sozinhos, e a trilha registra isso como "sistema".
                      <span className="text-[var(--gs-muted)]">sistema</span>
                    ),
                },
                {
                  header: 'Ação',
                  render: (r: RegistroDeAuditoria) => (
                    <Badge tone="neutral">
                      <span className="font-mono">{r.action}</span>
                    </Badge>
                  ),
                },
                {
                  header: 'Entidade',
                  render: (r: RegistroDeAuditoria) => (
                    <span className="text-[length:var(--gs-text-sm)]">
                      {r.entity_type}
                      {r.entity_id && (
                        // O id completo fica no title: truncado na célula para a
                        // tabela caber, inteiro no passar do mouse para quem for
                        // cruzar com outra tela.
                        <span
                          className="block font-mono text-[length:var(--gs-text-xs)] text-[var(--gs-muted)] max-w-[180px] truncate"
                          title={r.entity_id}
                        >
                          {r.entity_id}
                        </span>
                      )}
                    </span>
                  ),
                },
                {
                  header: 'Detalhe',
                  render: (r: RegistroDeAuditoria) => (
                    <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
                      {detalheLegivel(r.detail)}
                    </span>
                  ),
                },
              ]}
            />

            <div className="flex items-center justify-between mt-4">
              <Button
                variant="ghost"
                disabled={deslocamento === 0}
                onClick={() => setDeslocamento((d) => Math.max(0, d - POR_PAGINA))}
              >
                Anterior
              </Button>
              {/* O total é do UNIVERSO FILTRADO, vindo do servidor: numerar
                  páginas de outro universo mentiria sobre quanto falta ler. */}
              <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                {total === 0 ? 'Nenhum registro' : `${de}–${ate} de ${total} registros`}
              </span>
              <Button
                variant="ghost"
                disabled={deslocamento + POR_PAGINA >= total}
                onClick={() => setDeslocamento((d) => d + POR_PAGINA)}
              >
                Próxima
              </Button>
            </div>
          </>
        )}
      </Card>

      <div className="mt-6">
        <LiberacoesDeGestor />
      </div>
    </AppShell>
  );
}

/**
 * ============================================================================
 * LIBERAÇÕES DE GESTOR — a rota órfã ganha leitor (GAP-V62)
 * ============================================================================
 *
 * ## Por que uma seção aqui, e não uma tela própria
 *
 * `GET /core/authorizations` existia desde a primeira rodada da alçada e
 * NENHUMA tela a chamava. Cada senha de gerente digitada no balcão virava linha
 * no banco e o dono só a alcançava abrindo o SQLite — que é a mesma forma de
 * "existe e é inalcançável" que esta tela inteira nasceu para consertar.
 *
 * Ela é uma seção da Auditoria, e não uma entrada nova de menu, por três
 * razões que apontam para o mesmo lugar:
 *
 *   MESMA PERGUNTA. "Quem cancelou essa venda?" e "quem autorizou aquele
 *   desconto?" são a mesma investigação, e quem faz uma faz a outra em
 *   seguida. Separá-las em duas telas obrigaria a pessoa a saber de antemão
 *   em qual das duas o fato está.
 *
 *   MESMO ALCANCE. A trilha e as liberações expõem as ações de TODO MUNDO,
 *   inclusive as dos gerentes — e aqui é pior: a linha nomeia o gerente que
 *   ASSINOU. `admin_geral` e `gestor`, e mais ninguém; o guarda do servidor
 *   estreitou nesta rodada para casar exatamente com esta tela.
 *
 *   MENU QUE NÃO CRESCE POR DENTRO. Um item novo obrigaria a decidir perfis,
 *   rota e guarda em três arquivos — e o `o-menu-nao-promete` cobraria a
 *   correspondência. A seção herda tudo de quem já a tem certa.
 *
 * ## Ela lê SOZINHA, e o 403 dela não apaga a trilha
 *
 * Estado próprio, e não um campo a mais na consulta da trilha: se a lista de
 * liberações falhar, a auditoria continua na tela. Duas consultas independentes
 * é o que evita que um erro numa derrube a outra.
 */
function LiberacoesDeGestor() {
  const [itens, setItens] = useState<LiberacaoDeGestor[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    let vivo = true;
    coreApi
      .listAuthorizations(POR_PAGINA)
      .then((lista) => {
        if (vivo) setItens(lista);
      })
      .catch((err: unknown) => {
        if (!vivo) return;
        setItens(null);
        setErro(
          err instanceof ApiRequestError ? err.message : 'Falha ao carregar as liberações.',
        );
      });
    return () => {
      vivo = false;
    };
  }, []);

  return (
    <Card
      title="Liberações de gestor"
      subtitle="Toda vez que alguém sem alçada precisou de um gestor: quem pediu, quem assinou, e de onde."
    >
      {erro && (
        <p role="alert" className="text-[var(--gs-danger)] text-[length:var(--gs-text-sm)]">
          {erro}
        </p>
      )}

      {!erro && itens === null && <p className="text-[var(--gs-muted)]">Carregando…</p>}

      {itens && (
        <DataTable
          rows={itens}
          keyOf={(r) => r.id}
          empty={
            <EmptyState
              title="Nenhuma liberação registrada"
              description="Ninguém precisou da credencial de um gestor nesta operação — nem desconto acima do limite, nem sangria, nem cancelamento."
            />
          }
          columns={[
            { header: 'Quando', render: (r: LiberacaoDeGestor) => quando(r.created_at) },
            {
              /*
                OS DOIS NOMES NA MESMA CÉLULA, e nesta ordem. Quem PEDIU é a
                pergunta que a lista responde melhor — "o caixa novo pediu seis
                liberações esta semana" é o padrão que se vê aqui e em lugar
                nenhum. Quem ASSINOU vem logo abaixo porque é quem responde.
              */
              header: 'Quem pediu → quem liberou',
              render: (r: LiberacaoDeGestor) => (
                <span className="text-[length:var(--gs-text-sm)]">
                  <span className="font-semibold text-[var(--gs-purple-900)]">
                    {r.requested_by_name ?? 'usuário removido'}
                  </span>
                  <span className="block text-[var(--gs-text-soft)]">
                    liberado por {r.authorized_by_name ?? 'usuário removido'}
                  </span>
                </span>
              ),
            },
            {
              header: 'Ação',
              render: (r: LiberacaoDeGestor) => (
                <Badge tone="neutral">
                  <span className="font-mono">{r.action}</span>
                </Badge>
              ),
            },
            {
              header: 'Recurso',
              render: (r: LiberacaoDeGestor) =>
                r.reference_id ? (
                  <span
                    className="font-mono text-[length:var(--gs-text-xs)] text-[var(--gs-muted)] block max-w-[160px] truncate"
                    title={r.reference_id}
                  >
                    {r.reference_id}
                  </span>
                ) : (
                  // As liberações de dinheiro (desconto, sangria) não têm alvo:
                  // o que as prende é o VALOR, e inventar um traço de recurso
                  // aqui faria parecer que faltou preencher.
                  <span className="text-[var(--gs-muted)]">—</span>
                ),
            },
            {
              /*
                ONDE A SENHA FOI DIGITADA — a coluna que só existe porque o IP
                deixou de ser descartado. É ela que responde "o gerente estava no
                balcão?" numa conferência de caixa feita no dia seguinte.
              */
              header: 'Terminal / IP',
              render: (r: LiberacaoDeGestor) => (
                <span className="text-[length:var(--gs-text-sm)]">
                  {r.terminal_id ?? <span className="text-[var(--gs-muted)]">sem terminal</span>}
                  <span className="block font-mono text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
                    {r.ip ?? '—'}
                  </span>
                </span>
              ),
            },
            {
              /*
                USADA ou NÃO — e a diferença importa. A liberação é um bilhete de
                uma viagem só: a que ficou por usar é uma senha de gerente que
                foi digitada e não virou nada, e várias delas seguidas são um
                padrão que alguém precisa olhar.
              */
              header: 'Situação',
              render: (r: LiberacaoDeGestor) =>
                r.consumed_at ? (
                  <Badge tone="success">usada</Badge>
                ) : (
                  <Badge tone="warning">não usada</Badge>
                ),
            },
            {
              header: 'Motivo',
              render: (r: LiberacaoDeGestor) => (
                <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
                  {r.reason ?? '—'}
                </span>
              ),
            },
          ]}
        />
      )}
    </Card>
  );
}
