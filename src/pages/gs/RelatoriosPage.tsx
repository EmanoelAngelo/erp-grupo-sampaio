/**
 * Relatórios › Central — /sistema/relatorios/central
 *
 * ## O que esta tela conserta (GAP-V37)
 *
 * NENHUM relatório saía do sistema. O único gerador de CSV do repositório
 * vivia dentro do zip mensal do contador; em Posição de estoque,
 * Movimentações, DRE, BI e Auditoria não havia um botão de exportar. O gestor
 * que precisasse do DRE de um trimestre, do razão do estoque ou dos vencidos
 * por faixa copiava número a número para uma planilha.
 *
 * ## A TELA NÃO SABE NADA SOBRE OS RELATÓRIOS, e isso é o desenho
 *
 * Ela desenha o que o catálogo do servidor diz: os relatórios, os filtros que
 * cada um DE FATO usa, as colunas e o tipo de cada coluna. Nenhuma lista é
 * repetida aqui.
 *
 * Duas consequências que valem o preço:
 *
 *   - o décimo quinto relatório aparece nesta tela sem uma linha de código
 *     novo aqui — e, o que importa mais, sem o risco de nascer com um filtro
 *     que a tela oferece e a consulta ignora;
 *   - o filtro desenhado é sempre um filtro que funciona. Um seletor de
 *     situação num relatório que não olha situação é a promessa que o sistema
 *     não cumpre — o mesmo defeito do botão que não fazia nada, que este
 *     projeto já pagou caro.
 *
 * ## NÃO HÁ BOTÃO DE PDF, e a tela diz por quê
 *
 * Não existe biblioteca de PDF no servidor. Um botão "PDF" que gerasse HTML
 * com outro nome seria rótulo mentiroso. O que existe é CSV de verdade — o
 * mesmo formato do pacote do contador, que o Excel em português abre com
 * acento e soma sem ajuste — e a impressão em papel é a do navegador, dita com
 * essas palavras.
 *
 * ## O DOWNLOAD passa pelo Bearer, e não por um link
 *
 * `authMiddleware` lê o token SÓ do cabeçalho `Authorization`: uma navegação
 * disparada por `<a href>` não manda cabeçalho nenhum e receberia 401 no lugar
 * do arquivo. O caminho é `apiBinary` → `Blob` → `salvarArquivo`, o mesmo já
 * provado no pacote do contador.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AppShell } from '@/components/gs/AppShell';
import { Button, Card, EmptyState, Field, Input, PageHeader, SearchInput } from '@/components/gs/ui';
import { formatCents, formatQuantity } from '@/components/gs/format';
import { ApiRequestError } from '@/lib/api/client';
import { salvarArquivo } from '@/lib/download';
import { diasAtras, hojeNaLoja } from '@/lib/datas';
import {
  coreApi,
  type ReportColumn,
  type ReportDefinition,
  type ReportFilters,
  type ReportResult,
} from '@/lib/api/core';

/**
 * Como cada tipo de coluna vira texto na célula.
 *
 * O TIPO VEM DO SERVIDOR, e não é adivinhado pelo nome: `money` é centavo
 * inteiro e só aqui vira reais; `quantity` pode ser fracionária (0,75 kg) e
 * `number` não pode. Adivinhar pelo sufixo "_cents" funcionaria até o primeiro
 * relatório com uma coluna "valor" que não é dinheiro.
 */
function celula(valor: unknown, kind: ReportColumn['kind']): string {
  if (valor === null || valor === undefined || valor === '') return '—';
  if (kind === 'money') return formatCents(Number(valor));
  if (kind === 'quantity') return formatQuantity(Number(valor));
  if (kind === 'datetime') {
    const texto = String(valor);
    // Instante vira "dia às hora" pela fatia, e não por `new Date`: montar a
    // data no navegador usaria o relógio DELE, e o mesmo relatório mudaria de
    // dia conforme quem abre.
    return texto.length >= 16 ? `${texto.slice(8, 10)}/${texto.slice(5, 7)} ${texto.slice(11, 16)}` : texto;
  }
  if (kind === 'date') {
    const texto = String(valor);
    // AAAA-MM-DD é data de CALENDÁRIO. `new Date('2026-06-10')` a lê como
    // meia-noite UTC e `toLocaleDateString` a devolve como 09/06 no fuso da
    // loja — um dia a menos, em todo relatório. A fatia não erra.
    return /^\d{4}-\d{2}-\d{2}/.test(texto)
      ? `${texto.slice(8, 10)}/${texto.slice(5, 7)}/${texto.slice(0, 4)}`
      : texto;
  }
  return String(valor);
}

const SITUACOES_POR_RELATORIO: Record<string, { valor: string; rotulo: string }[]> = {
  vendas: [
    { valor: 'completed', rotulo: 'Concluídas' },
    { valor: 'cancelled', rotulo: 'Canceladas' },
    { valor: 'todas', rotulo: 'Todas' },
  ],
  financeiro: [
    { valor: '', rotulo: 'Todas' },
    { valor: 'open', rotulo: 'Em aberto' },
    { valor: 'overdue', rotulo: 'Vencidas' },
    { valor: 'settled', rotulo: 'Quitadas' },
  ],
  compras: [
    { valor: 'todas', rotulo: 'Todas' },
    { valor: 'recebida', rotulo: 'Recebidas' },
    { valor: 'conferida', rotulo: 'Conferidas' },
    { valor: 'importada', rotulo: 'Importadas' },
    { valor: 'estornada', rotulo: 'Estornadas' },
  ],
};

export default function RelatoriosPage() {
  const [catalogo, setCatalogo] = useState<ReportDefinition[] | null>(null);
  /*
    O RELATÓRIO PEDIDO PELO ENDEREÇO — `?relatorio=minimo` (GAP-PRD-164).

    O painel mostra dez produtos abaixo do mínimo e diz quantos são; o link
    "ver todos" chega aqui já no relatório certo. Um id que o catálogo não
    conhece cai no padrão assim que o catálogo chega.
  */
  const [paramsDaUrl] = useSearchParams();
  const [escolhido, setEscolhido] = useState<string>(paramsDaUrl.get('relatorio') || 'vendas');
  useEffect(() => {
    if (catalogo && catalogo.length > 0 && !catalogo.some((r) => r.id === escolhido)) {
      setEscolhido(catalogo.some((r) => r.id === 'vendas') ? 'vendas' : catalogo[0].id);
    }
  }, [catalogo, escolhido]);
  const [de, setDe] = useState(diasAtras(30));
  const [ate, setAte] = useState(hojeNaLoja());
  const [situacao, setSituacao] = useState('');
  const [direcao, setDirecao] = useState<'' | 'in' | 'out'>('');
  const [busca, setBusca] = useState('');
  const [resultado, setResultado] = useState<ReportResult | null>(null);
  const [carregando, setCarregando] = useState(false);
  const [baixando, setBaixando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  const definicao = useMemo(
    () => catalogo?.find((r) => r.id === escolhido) ?? null,
    [catalogo, escolhido],
  );

  /*
    OS FILTROS QUE VÃO NO PEDIDO SÃO OS QUE O RELATÓRIO DECLARA.

    Mandar `busca` para um relatório que não a usa não quebra nada hoje — o
    servidor a ignora. Mas o dia em que alguém a implementar naquele relatório,
    o filtro passaria a valer sem ninguém ter pedido, e o número mudaria
    sozinho. Recortar aqui mantém o pedido igual à tela.
  */
  const filtrosDoPedido = useCallback((): ReportFilters => {
    const usa = (f: string) => definicao?.filters.includes(f as never) ?? false;
    return {
      from: usa('periodo') ? de : undefined,
      to: usa('periodo') ? ate : undefined,
      situacao: usa('situacao') && situacao ? situacao : undefined,
      direcao: usa('direcao') && direcao ? direcao : undefined,
      busca: usa('busca') && busca.trim() ? busca.trim() : undefined,
    };
  }, [definicao, de, ate, situacao, direcao, busca]);

  useEffect(() => {
    void (async () => {
      try {
        setCatalogo(await coreApi.reportsCatalog());
      } catch (err) {
        setErro(err instanceof ApiRequestError ? err.message : 'Falha ao carregar os relatórios.');
      }
    })();
  }, []);

  const rodar = useCallback(async () => {
    if (!definicao) return;
    setCarregando(true);
    setErro(null);
    try {
      setResultado(await coreApi.report(definicao.id, filtrosDoPedido()));
    } catch (err) {
      setResultado(null);
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao gerar o relatório.');
    } finally {
      setCarregando(false);
    }
  }, [definicao, filtrosDoPedido]);

  useEffect(() => {
    void rodar();
  }, [rodar]);

  /*
    A EXPORTAÇÃO PEDE OS MESMOS FILTROS que a tela acabou de usar.

    Ela não reaproveita as linhas já carregadas de propósito: o CSV é montado
    no SERVIDOR, com cabeçalho de empresa, período e ressalva, e com o formato
    (BOM, ponto-e-vírgula, CRLF) que o Excel em português abre. Montá-lo aqui
    seria o segundo gerador de CSV do sistema — que é justamente o que esta
    rodada extraiu para um lugar só.
  */
  async function exportar() {
    if (!definicao) return;
    setBaixando(true);
    setErro(null);
    setAviso(null);
    try {
      const arquivo = await coreApi.reportCsv(definicao.id, filtrosDoPedido());
      salvarArquivo(arquivo.blob, arquivo.nomeArquivo);
      setAviso(`Arquivo ${arquivo.nomeArquivo} salvo na pasta de downloads.`);
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao exportar.');
    } finally {
      setBaixando(false);
    }
  }

  const usa = (f: string) => definicao?.filters.includes(f as never) ?? false;
  const situacoes = SITUACOES_POR_RELATORIO[escolhido] ?? [];
  const porGrupo = useMemo(() => {
    const mapa = new Map<string, ReportDefinition[]>();
    for (const r of catalogo ?? []) {
      mapa.set(r.group, [...(mapa.get(r.group) ?? []), r]);
    }
    return [...mapa.entries()];
  }, [catalogo]);

  return (
    <AppShell>
      <PageHeader
        breadcrumb={['Relatórios', 'Central']}
        title="Central de relatórios"
        subtitle="Os números da operação em tabela, com filtro e exportação em CSV."
      />

      {erro && (
        <p role="alert" className="text-[var(--gs-danger)] text-[length:var(--gs-text-sm)]">
          {erro}
        </p>
      )}
      {aviso && (
        <p role="status" className="text-[var(--gs-success)] text-[length:var(--gs-text-sm)]">
          {aviso}
        </p>
      )}

      <div className="grid gap-5 xl:grid-cols-[280px_1fr]">
        <Card title="Relatórios">
          {catalogo === null ? (
            <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">Carregando…</p>
          ) : (
            <div className="flex flex-col gap-4">
              {porGrupo.map(([grupo, itens]) => (
                <div key={grupo} className="flex flex-col gap-1">
                  <p className="m-0 text-[length:var(--gs-text-xs)] uppercase tracking-wide text-[var(--gs-muted)] font-semibold">
                    {grupo}
                  </p>
                  {itens.map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => {
                        setEscolhido(r.id);
                        // Filtro de um relatório não pode vazar para o
                        // seguinte: "situação = cancelada" carregada para o
                        // relatório de compras filtraria por um status que
                        // não existe lá, e a tabela viria vazia sem motivo
                        // visível.
                        setSituacao('');
                        setDirecao('');
                        setBusca('');
                      }}
                      aria-current={r.id === escolhido ? 'true' : undefined}
                      className={`text-left px-3 py-2 rounded-[var(--gs-radius-sm)] border-0 cursor-pointer
                        text-[length:var(--gs-text-sm)] ${
                          r.id === escolhido
                            ? 'bg-[var(--gs-purple-700)] text-white font-semibold'
                            : 'bg-transparent text-[var(--gs-text)] hover:bg-[var(--gs-surface-soft)]'
                        }`}
                    >
                      {r.label}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}
        </Card>

        <div className="flex flex-col gap-5">
          <Card
            title={definicao?.label ?? 'Relatório'}
            subtitle={definicao?.description}
            actions={
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => window.print()}
                  disabled={!resultado}
                >
                  Imprimir
                </Button>
                <Button
                  type="button"
                  size="sm"
                  loading={baixando}
                  disabled={!resultado}
                  onClick={() => void exportar()}
                >
                  Exportar CSV
                </Button>
              </div>
            }
          >
            <div className="flex flex-wrap items-end gap-4">
              {usa('periodo') && (
                <>
                  <Field label="De">
                    {(p) => (
                      <Input {...p} type="date" value={de} onChange={(e) => setDe(e.target.value)} />
                    )}
                  </Field>
                  <Field label="Até">
                    {(p) => (
                      <Input
                        {...p}
                        type="date"
                        value={ate}
                        onChange={(e) => setAte(e.target.value)}
                      />
                    )}
                  </Field>
                </>
              )}
              {usa('situacao') && situacoes.length > 0 && (
                <Field label="Situação">
                  {(p) => (
                    <select
                      {...p}
                      value={situacao}
                      onChange={(e) => setSituacao(e.target.value)}
                      className="h-[42px] px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)] bg-[var(--gs-surface)]"
                    >
                      {situacoes.map((s) => (
                        <option key={s.valor || 'padrao'} value={s.valor}>
                          {s.rotulo}
                        </option>
                      ))}
                    </select>
                  )}
                </Field>
              )}
              {usa('direcao') && (
                <Field label="Direção">
                  {(p) => (
                    <select
                      {...p}
                      value={direcao}
                      onChange={(e) => setDirecao(e.target.value as '' | 'in' | 'out')}
                      className="h-[42px] px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)] bg-[var(--gs-surface)]"
                    >
                      <option value="">A pagar e a receber</option>
                      <option value="in">Só a receber</option>
                      <option value="out">Só a pagar</option>
                    </select>
                  )}
                </Field>
              )}
              {usa('busca') && (
                <div className="min-w-[220px] flex-1">
                  <SearchInput
                    value={busca}
                    onChange={setBusca}
                    placeholder="Filtrar por nome ou código…"
                  />
                </div>
              )}
              {carregando && (
                <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                  Atualizando…
                </span>
              )}
            </div>

            {/*
              A RESSALVA DO RELATÓRIO VEM DO SERVIDOR e é renderizada inteira.

              É a mesma decisão do DRE: se a frase fosse texto solto neste
              componente, a primeira reescrita da tela deixaria de fora
              justamente a que incomoda — e um relatório que omite a própria
              limitação é um número que alguém usa para decidir.
            */}
            {definicao?.caveat && (
              <p className="mt-4 mb-0 px-4 py-3 rounded-[var(--gs-radius)] bg-[var(--gs-surface-soft)] text-[length:var(--gs-text-sm)] text-[var(--gs-text-soft)]">
                {definicao.caveat}
              </p>
            )}

            {/*
              O QUE ESTA CENTRAL NÃO OFERECE, dito na tela.

              Não há biblioteca de PDF no servidor. Oferecer o botão e entregar
              HTML com outro nome seria rótulo mentiroso; dizer o que existe é
              mais útil do que prometer o que não existe.
            */}
            <p className="mt-3 mb-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
              A exportação é em CSV (abre no Excel e no Google Planilhas). Não há geração de
              PDF: para papel, use a impressão do navegador no botão acima.
            </p>
          </Card>

          <Card
            title="Resultado"
            padded={false}
            /*
              O "PELO MENOS" QUE FALTAVA AQUI — a tela afirmava o que o arquivo
              relativiza, sobre a MESMA resposta.

              O CSV escreve "O relatório tem PELO MENOS {n} linhas e o arquivo
              traz as primeiras {m}" (ReportsService), e a ressalva está lá por
              um motivo: `rowCount` é o que a consulta CONSEGUIU trazer, e num
              relatório cuja FONTE tem teto próprio o total real pode ser maior.
              A tela escrevia o mesmo número como fato — e num assunto que é
              justamente truncagem honesta, o número da tela é o que vira
              decisão.

              Sem truncagem a ressalva NÃO entra: aí `rowCount` é exato, e um
              "pelo menos" ensinaria a desconfiar de um número que está certo.
              A ressalva acompanha o corte, exatamente como no arquivo.
            */
            subtitle={
              resultado
                ? `${resultado.truncated ? 'pelo menos ' : ''}${resultado.rowCount} linha(s)${
                    resultado.truncated
                      ? ` — o arquivo e a tabela mostram as primeiras ${resultado.rows.length}. Estreite o período.`
                      : ''
                  }`
                : undefined
            }
          >
            {!resultado || resultado.rows.length === 0 ? (
              <div className="p-5">
                <EmptyState
                  title="Nada no recorte"
                  description="Não há linhas para os filtros escolhidos. Altere o período ou o filtro."
                />
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-[length:var(--gs-text-sm)] border-collapse">
                  <thead>
                    <tr className="text-left text-[var(--gs-muted)]">
                      {resultado.report.columns.map((c) => (
                        <th
                          key={c.key}
                          className={`py-2 px-3 whitespace-nowrap ${
                            c.kind === 'money' || c.kind === 'quantity' || c.kind === 'number'
                              ? 'text-right'
                              : ''
                          }`}
                        >
                          {c.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {resultado.rows.map((linha, i) => (
                      <tr key={i} className="border-t border-[var(--gs-border)]">
                        {resultado.report.columns.map((c) => (
                          <td
                            key={c.key}
                            className={`py-2 px-3 ${
                              c.kind === 'money' || c.kind === 'quantity' || c.kind === 'number'
                                ? 'text-right tabular-nums'
                                : ''
                            }`}
                          >
                            {celula(linha[c.key], c.kind)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                  {/*
                    O RODAPÉ SOMA AS LINHAS QUE ESTÃO ACIMA — os totais vêm do
                    servidor, calculados sobre as MESMAS linhas que voltaram.
                    Um rodapé de outra consulta é o formato de erro que ninguém
                    confere: ele parece certo e discorda da tabela.
                  */}
                  <tfoot>
                    <tr className="border-t-2 border-[var(--gs-border-strong)] font-bold">
                      {resultado.report.columns.map((c, i) => (
                        <td
                          key={c.key}
                          className={`py-2 px-3 ${
                            c.kind === 'money' || c.kind === 'quantity' ? 'text-right tabular-nums' : ''
                          }`}
                        >
                          {i === 0
                            ? 'Total'
                            : c.key in resultado.totals
                              ? celula(resultado.totals[c.key], c.kind)
                              : ''}
                        </td>
                      ))}
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </Card>
        </div>
      </div>
    </AppShell>
  );
}
