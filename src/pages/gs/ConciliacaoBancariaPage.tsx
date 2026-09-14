/**
 * Financeiro › Conciliação bancária.
 *
 * A terceira verdade sobre o mesmo dinheiro: a venda diz que recebeu, o
 * financeiro diz que baixou, e o banco diz o que caiu na conta.
 *
 * ESTA TELA NÃO TEM BOTÃO DE CORRIGIR, e é de propósito — a mesma decisão da
 * conciliação do Asaas. Ajustar o lado que parece errado é acertar a balança
 * empurrando o prato: some com o sintoma, mantém a causa, e a próxima
 * conferência já parte de um número adulterado. Quem decide é quem responde
 * pelo caixa.
 *
 * O que a tela FAZ é casar linha com baixa — e casar é ato de quem confere. A
 * sugestão vem por valor e data; confirmar é clique humano. Casamento
 * automático engoliria justamente o caso que interessa: dois valores iguais no
 * mesmo dia que são fatos diferentes.
 *
 * E DESFAZER TAMBÉM É ATO DE QUEM CONFERE (GAP-V26). Desfazer não corrige
 * dinheiro nenhum: ele retira uma AFIRMAÇÃO humana ("esta linha é aquela
 * baixa") que se revelou errada, e devolve a divergência ao relatório, que é
 * onde ela deve estar. A rota e o client existiam desde sempre sem nenhuma
 * chamada em tela: quem casava a linha errada — o erro mais provável daqui —
 * ficava sem volta, e o engano se escondia justamente no relatório feito para
 * mostrá-lo.
 */
import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/gs/AppShell';
import { Badge, Button, Card, EmptyState, Field, Input, PageHeader } from '@/components/gs/ui';
import { ApiRequestError } from '@/lib/api/client';
import {
  coreApi,
  type BankDivergenceKind,
  type BankLine,
  type BankReconciliationReport,
  type BankSettlementSuggestion,
} from '@/lib/api/core';
import { dataBR } from '@/lib/datas';
import { parseExtratoCsv, type LinhaDoExtrato } from '@/components/gs/extratoCsv';
import {
  lerArquivoDeExtrato,
  lerTextoDoArquivo,
  type FormatoDoExtrato,
} from '@/components/gs/extratoOfx';
import { QuitacoesSemBaixaCard } from '@/components/gs/QuitacoesSemBaixaCard';

function formatCents(cents: number): string {
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

const ROTULO: Record<BankDivergenceKind, string> = {
  no_extrato_sem_baixa: 'No extrato, sem baixa',
  baixado_sem_extrato: 'Baixado, sem extrato',
  valor_divergente: 'Valor divergente',
};

const EXPLICACAO: Record<BankDivergenceKind, string> = {
  no_extrato_sem_baixa: 'Entrou na conta e o financeiro não sabe — é o que mais esconde receita.',
  baixado_sem_extrato: 'O financeiro diz que recebeu e o banco não viu — infla o resultado.',
  valor_divergente: 'Os dois existem e não batem. Tarifa costuma explicar; diferença redonda, não.',
};

const TOM: Record<BankDivergenceKind, 'warning' | 'danger'> = {
  no_extrato_sem_baixa: 'warning',
  baixado_sem_extrato: 'danger',
  valor_divergente: 'warning',
};

/**
 * Lê CSV simples: data;descrição;valor — um lançamento por linha.
 *
 * O parse mora aqui e não no servidor porque o formato varia por banco e é o
 * usuário quem sabe qual baixou. O servidor recebe linhas já estruturadas e
 * não tenta adivinhar layout de arquivo.
 */
/** O arquivo escolhido, já lido — o que vai ser importado quando houver. */
interface ArquivoLido {
  nome: string;
  formato: FormatoDoExtrato;
  linhas: LinhaDoExtrato[];
  erros: number;
}

export default function ConciliacaoBancariaPage() {
  const [relatorio, setRelatorio] = useState<BankReconciliationReport | null>(null);
  const [pendentes, setPendentes] = useState<BankLine[]>([]);
  /**
   * As linhas JÁ casadas — a matéria-prima do "Desfazer" (GAP-V26).
   *
   * A tela só listava as pendentes. Quem casava a linha errada (o erro humano
   * mais provável daqui: dois recebimentos de mesmo valor no mesmo dia são
   * indistinguíveis para a sugestão) não tinha nem como VER o que casou, quanto
   * mais como voltar atrás — a rota e o client existiam há rodadas, sem
   * nenhuma chamada em tela nenhuma.
   */
  const [casadas, setCasadas] = useState<BankLine[]>([]);
  /**
   * QUANTAS EXISTEM, não quantas vieram (GAP-PRD-177).
   *
   * O servidor devolvia 500 linhas sem avisar que havia mais, e num mês cheio
   * o fim do extrato — com as pendências dele — sumia da tela. Os totais vêm
   * do servidor; a tela diz "mostrando X de Y" e busca o resto sob pedido.
   */
  const [totalPendentes, setTotalPendentes] = useState(0);
  const [totalCasadas, setTotalCasadas] = useState(0);
  const [carregandoMais, setCarregandoMais] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  const [conta, setConta] = useState('Conta corrente');
  const [csv, setCsv] = useState('');
  const [arquivo, setArquivo] = useState<ArquivoLido | null>(null);
  const [linhaAberta, setLinhaAberta] = useState<string | null>(null);
  const [sugestoes, setSugestoes] = useState<BankSettlementSuggestion[]>([]);
  /** Desfazer pede confirmação: apaga o autor e a data da conferência. */
  const [desfazendo, setDesfazendo] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    setErro(null);
    try {
      setRelatorio(await coreApi.bankReconciliation());
      // Pendentes e casadas em páginas SEPARADAS: numa lista só, 500 casadas
      // antigas empurravam as pendências novas para fora do corte.
      const [p, c] = await Promise.all([
        coreApi.listBankLinesPage({ onlyUnmatched: true }),
        coreApi.listBankLinesPage({ onlyMatched: true }),
      ]);
      setPendentes(p.items);
      setTotalPendentes(p.total);
      setCasadas(c.items);
      setTotalCasadas(c.total);
    } catch (err) {
      setRelatorio(null);
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao carregar a conciliação.');
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  /** A próxima página de uma das duas listas, acrescentada ao fim. */
  const carregarMais = async (qual: 'pendentes' | 'casadas') => {
    setCarregandoMais(true);
    setErro(null);
    try {
      const atuais = qual === 'pendentes' ? pendentes : casadas;
      const pagina = await coreApi.listBankLinesPage(
        qual === 'pendentes'
          ? { onlyUnmatched: true, offset: atuais.length }
          : { onlyMatched: true, offset: atuais.length },
      );
      if (qual === 'pendentes') {
        setPendentes([...atuais, ...pagina.items]);
        setTotalPendentes(pagina.total);
      } else {
        setCasadas([...atuais, ...pagina.items]);
        setTotalCasadas(pagina.total);
      }
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao carregar mais linhas.');
    } finally {
      setCarregandoMais(false);
    }
  };

  /**
   * O ARQUIVO DO BANCO, sem passar pelo bloco de notas (GAP-V27).
   *
   * O formato é decidido pelo CONTEÚDO — banco que entrega OFX com nome `.txt`
   * existe. O CSV escolhido como arquivo cai no MESMO textarea de sempre, para
   * que a pessoa veja e corrija o que o leitor não entendeu; o OFX vira
   * lançamentos direto, porque ali não há o que ajustar à mão.
   */
  const escolherArquivo = async (file: File | null) => {
    setErro(null);
    setAviso(null);
    if (!file) {
      setArquivo(null);
      return;
    }
    try {
      const texto = await lerTextoDoArquivo(file);
      const lido = lerArquivoDeExtrato(texto);
      if (lido.formato === 'csv') {
        setArquivo(null);
        setCsv(texto);
        setAviso(
          `${file.name} carregado. Confira as linhas abaixo antes de importar` +
            (lido.erros > 0 ? ` — ${lido.erros} linha(s) não foram entendidas.` : '.'),
        );
        return;
      }
      if (lido.linhas.length === 0) {
        setArquivo(null);
        setErro(`Nenhum lançamento reconhecido em ${file.name}.`);
        return;
      }
      setCsv('');
      setArquivo({ nome: file.name, formato: lido.formato, linhas: lido.linhas, erros: lido.erros });
    } catch {
      setArquivo(null);
      setErro('Não foi possível ler o arquivo.');
    }
  };

  const importar = async () => {
    setOcupado(true);
    setErro(null);
    setAviso(null);
    try {
      // O arquivo tem precedência sobre o texto colado — é o que a pessoa
      // acabou de escolher. Sem arquivo, vale o textarea de sempre.
      const { linhas, erros } = arquivo
        ? { linhas: arquivo.linhas, erros: arquivo.erros }
        : parseExtratoCsv(csv);
      if (linhas.length === 0) {
        setErro('Nenhuma linha reconhecida. Use: data;descrição;valor');
        return;
      }
      const res = await coreApi.importBankStatement({
        accountLabel: conta,
        // De onde veio o extrato fica gravado: na hora de explicar uma
        // divergência, saber que o arquivo era o `extrato-agosto.ofx` é metade
        // da resposta.
        sourceName: arquivo?.nome ?? null,
        lines: linhas,
      });
      setAviso(
        `${res.imported} linha(s) importada(s)` +
          (res.skipped > 0 ? `, ${res.skipped} já conhecida(s)` : '') +
          (erros > 0 ? ` — ${erros} linha(s) do arquivo não foram entendidas.` : '.'),
      );
      setCsv('');
      setArquivo(null);
      await carregar();
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao importar o extrato.');
    } finally {
      setOcupado(false);
    }
  };

  /** Desfaz o casamento — depois da confirmação, e com trilha no servidor. */
  const desfazer = async (lineId: string) => {
    setErro(null);
    try {
      await coreApi.unmatchBankLine(lineId);
      setDesfazendo(null);
      setAviso('Conciliação desfeita. A linha voltou para a lista de pendentes.');
      await carregar();
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao desfazer a conciliação.');
    }
  };

  const abrirSugestoes = async (lineId: string) => {
    setLinhaAberta(lineId);
    setSugestoes([]);
    try {
      setSugestoes(await coreApi.bankSuggestions(lineId));
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao buscar sugestões.');
    }
  };

  const casar = async (lineId: string, settlementId: string) => {
    setErro(null);
    try {
      await coreApi.matchBankLine(lineId, settlementId);
      setLinhaAberta(null);
      setAviso('Conciliado.');
      await carregar();
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao conciliar.');
    }
  };

  return (
    <AppShell>
      <PageHeader
        breadcrumb={['Financeiro', 'Conciliação']}
        title="Conciliação bancária"
        subtitle="O que o banco diz × o que o financeiro registrou. Relata a diferença — não corrige."
      />

      {erro && (
        <p role="alert" className="text-[var(--gs-danger)] text-[length:var(--gs-text-sm)]">
          {erro}
        </p>
      )}
      {aviso && <p className="text-[var(--gs-success)] text-[length:var(--gs-text-sm)]">{aviso}</p>}

      {relatorio && (
        <Card title="Resumo">
          <div className="grid gap-4 sm:grid-cols-4">
            <div>
              <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">No extrato</p>
              <p className="m-0 text-[length:var(--gs-text-lg)] font-bold">
                {formatCents(relatorio.bankTotalCents)}
              </p>
            </div>
            <div>
              <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">No financeiro</p>
              <p className="m-0 text-[length:var(--gs-text-lg)] font-bold">
                {formatCents(relatorio.financeTotalCents)}
              </p>
            </div>
            <div>
              <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">Diferença</p>
              <p
                className={`m-0 text-[length:var(--gs-text-lg)] font-bold ${
                  relatorio.differenceCents !== 0 ? 'text-[var(--gs-danger)]' : ''
                }`}
              >
                {formatCents(relatorio.differenceCents)}
              </p>
            </div>
            <div>
              <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">Conciliados</p>
              <p className="m-0 text-[length:var(--gs-text-lg)] font-bold">{relatorio.matched}</p>
            </div>
          </div>
        </Card>
      )}

      {/* As quitações anteriores ao registro de baixas (GAP-PRD-171): só
          aparece quando há o que decidir. */}
      <QuitacoesSemBaixaCard onCriou={carregar} />

      <Card title="Importar extrato">
        <div className="grid gap-4 md:grid-cols-3 mb-3">
          <Field label="Conta">
            {(p) => <Input {...p} value={conta} onChange={(e) => setConta(e.target.value)} />}
          </Field>
          <Field
            label="Arquivo do banco"
            hint="OFX (o do Money/Quicken, no mesmo menu do CSV) ou CSV exportado."
          >
            {(p) => (
              <input
                {...p}
                type="file"
                accept=".ofx,.csv,.txt,text/plain,text/csv"
                onChange={(e) => void escolherArquivo(e.target.files?.[0] ?? null)}
                className="w-full text-[length:var(--gs-text-sm)]"
              />
            )}
          </Field>
        </div>

        {arquivo && (
          <div
            data-testid="extrato-arquivo"
            className="mb-3 rounded-[var(--gs-radius)] border border-[var(--gs-purple-600)]
              bg-[var(--gs-canvas)] px-4 py-3 flex flex-wrap items-center justify-between gap-3"
          >
            <span className="text-[length:var(--gs-text-sm)]">
              <strong>{arquivo.nome}</strong> · {arquivo.formato.toUpperCase()} ·{' '}
              {arquivo.linhas.length} lançamento(s)
              {arquivo.erros > 0 && (
                <span className="text-[var(--gs-warning)]">
                  {' '}
                  · {arquivo.erros} não entendido(s)
                </span>
              )}
              {/*
                O FITID é o que torna a reimportação segura, e vale dizer: quem
                baixa o extrato duas vezes no mesmo mês precisa saber que a
                segunda vez não duplica nada.
              */}
              <span className="block text-[var(--gs-muted)]">
                O arquivo traz a identidade de cada lançamento (FITID): reimportar não duplica.
              </span>
            </span>
            <Button variant="ghost" onClick={() => setArquivo(null)}>
              Descartar arquivo
            </Button>
          </div>
        )}

        <Field
          label="Linhas do extrato"
          hint="Uma por linha, no formato: data;descrição;valor — valor negativo para saída"
        >
          {(p) => (
            <textarea
              {...p}
              value={csv}
              onChange={(e) => setCsv(e.target.value)}
              rows={5}
              placeholder={'10/08/2026;PIX recebido;150,00\n11/08/2026;Tarifa;-35,00'}
              className="w-full rounded-[var(--gs-radius)] border border-[var(--gs-border)]
                bg-[var(--gs-surface)] px-3 py-2 font-mono text-[length:var(--gs-text-sm)]"
            />
          )}
        </Field>
        <Button
          onClick={() => void importar()}
          loading={ocupado}
          disabled={!arquivo && !csv.trim()}
          className="mt-3"
        >
          Importar
        </Button>
        <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
          Reimportar o mesmo arquivo é seguro quando ele traz a identidade do banco (o FITID do
          OFX): a linha já conhecida é ignorada, não duplicada. No CSV colado essa identidade não
          existe, e a repetição é risco assumido de quem cola duas vezes.
        </p>
      </Card>

      {pendentes.length > 0 && (
        <Card title="Linhas sem conciliação">
          <div className="overflow-x-auto">
            <table className="w-full text-[length:var(--gs-text-sm)] border-collapse">
              <thead>
                <tr className="text-left text-[var(--gs-muted)]">
                  <th className="py-2">Data</th>
                  <th className="py-2">Descrição</th>
                  <th className="py-2 text-right">Valor</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {pendentes.map((l) => (
                  <>
                    <tr key={l.id} className="border-t border-[var(--gs-border)]">
                      <td className="py-2">
                        {dataBR(l.occurred_at)}
                      </td>
                      <td className="py-2">{l.description}</td>
                      <td
                        className={`py-2 text-right font-semibold ${
                          l.amount_cents < 0 ? 'text-[var(--gs-danger)]' : ''
                        }`}
                      >
                        {formatCents(l.amount_cents)}
                      </td>
                      <td className="py-2 text-right">
                        <Button size="sm" variant="ghost" onClick={() => void abrirSugestoes(l.id)}>
                          Conciliar
                        </Button>
                      </td>
                    </tr>
                    {linhaAberta === l.id && (
                      <tr key={`${l.id}-sug`}>
                        <td colSpan={4} className="py-2 pl-6">
                          {sugestoes.length === 0 ? (
                            <span className="text-[var(--gs-muted)]">
                              Nenhuma baixa de mesmo valor por perto. Isso não é erro do sistema: é
                              a divergência que a conciliação existe para mostrar.
                            </span>
                          ) : (
                            sugestoes.map((s) => (
                              <div key={s.id} className="flex items-center gap-2 py-1">
                                <span>
                                  {dataBR(s.settled_at)} ·{' '}
                                  {s.entry_description} · {formatCents(s.amount_cents)}
                                </span>
                                <Button size="sm" onClick={() => void casar(l.id, s.id)}>
                                  É esta
                                </Button>
                              </div>
                            ))
                          )}
                        </td>
                      </tr>
                    )}
                  </>
                ))}
              </tbody>
            </table>
          </div>
          <MaisLinhas
            nome="linhas sem conciliação"
            mostradas={pendentes.length}
            total={totalPendentes}
            ocupado={carregandoMais}
            onMais={() => void carregarMais('pendentes')}
          />
        </Card>
      )}

      {casadas.length > 0 && (
        /*
          AS LINHAS JÁ CONCILIADAS, E O CAMINHO DE VOLTA (GAP-V26).

          Casar a linha errada é o erro mais provável desta tela — a sugestão
          não distingue dois recebimentos de mesmo valor no mesmo dia, e quem
          confere clica no primeiro. Sem esta lista, o engano ficava invisível:
          a linha sumia das pendências, a divergência real sumia do relatório, e
          só um SELECT na mão desfaria.

          DESFAZER PERGUNTA ANTES. Não por cerimônia: desfazer APAGA quem casou
          e quando — e é justamente esse rastro que alguém procuraria depois
          para entender a conferência. A confirmação diz isso com todas as
          letras, e o servidor grava `bank.line_unmatched` na trilha central.
        */
        <Card
          title="Linhas conciliadas"
          subtitle="Casou a linha errada? Desfazer devolve a divergência ao relatório."
        >
          <div className="overflow-x-auto">
            <table className="w-full text-[length:var(--gs-text-sm)] border-collapse">
              <thead>
                <tr className="text-left text-[var(--gs-muted)]">
                  <th className="py-2">Data</th>
                  <th className="py-2">Descrição</th>
                  <th className="py-2 text-right">Valor</th>
                  <th className="py-2">Conferido por</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {casadas.map((l) => (
                  <tr key={l.id} className="border-t border-[var(--gs-border)]">
                    <td className="py-2">{dataBR(l.occurred_at)}</td>
                    <td className="py-2">{l.description}</td>
                    <td
                      className={`py-2 text-right font-semibold ${
                        l.amount_cents < 0 ? 'text-[var(--gs-danger)]' : ''
                      }`}
                    >
                      {formatCents(l.amount_cents)}
                    </td>
                    <td className="py-2 text-[var(--gs-muted)]">
                      {l.matched_by_name ?? '—'}
                      {l.matched_at ? ` · ${dataBR(l.matched_at)}` : ''}
                    </td>
                    <td className="py-2 text-right">
                      {desfazendo === l.id ? (
                        <span
                          role="alertdialog"
                          aria-label="Desfazer a conciliação?"
                          className="inline-flex flex-wrap items-center justify-end gap-2"
                        >
                          <span className="text-[var(--gs-warning)] font-semibold">
                            Desfazer apaga quem conferiu e devolve a divergência ao relatório.
                          </span>
                          <Button size="sm" variant="ghost" onClick={() => setDesfazendo(null)}>
                            Manter
                          </Button>
                          <Button size="sm" onClick={() => void desfazer(l.id)}>
                            Desfazer mesmo assim
                          </Button>
                        </span>
                      ) : (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setDesfazendo(l.id)}
                          aria-label={`Desfazer a conciliação de ${l.description}`}
                        >
                          Desfazer
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <MaisLinhas
            nome="linhas conciliadas"
            mostradas={casadas.length}
            total={totalCasadas}
            ocupado={carregandoMais}
            onMais={() => void carregarMais('casadas')}
          />
        </Card>
      )}

      <Card title="Divergências">
        {relatorio === null ? (
          <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">Carregando…</p>
        ) : relatorio.divergences.length === 0 ? (
          <EmptyState
            title={
              relatorio.bankTotalCents === 0 && relatorio.financeTotalCents === 0
                ? 'Nada a conferir'
                : 'Tudo confere'
            }
            description={
              relatorio.bankTotalCents === 0 && relatorio.financeTotalCents === 0
                ? 'Sem extrato importado e sem baixas no período — não há o que comparar.'
                : 'Cada linha do extrato tem baixa correspondente, com o mesmo valor.'
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[length:var(--gs-text-sm)] border-collapse">
              <thead>
                <tr className="text-left text-[var(--gs-muted)]">
                  <th className="py-2">Data</th>
                  <th className="py-2">O que é</th>
                  <th className="py-2">Descrição</th>
                  <th className="py-2 text-right">Banco</th>
                  <th className="py-2 text-right">Financeiro</th>
                </tr>
              </thead>
              <tbody>
                {relatorio.divergences.map((d, i) => (
                  <tr key={`${d.lineId ?? d.settlementId}-${i}`} className="border-t border-[var(--gs-border)]">
                    <td className="py-2">{dataBR(d.occurredAt)}</td>
                    <td className="py-2">
                      <Badge tone={TOM[d.kind]}>{ROTULO[d.kind]}</Badge>
                      <p className="m-0 text-[var(--gs-muted)]">{EXPLICACAO[d.kind]}</p>
                    </td>
                    <td className="py-2">{d.description}</td>
                    <td className="py-2 text-right">
                      {d.bankCents === null ? '—' : formatCents(d.bankCents)}
                    </td>
                    <td className="py-2 text-right">
                      {d.financeCents === null ? '—' : formatCents(d.financeCents)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
          Esta tela não corrige nada, e não tem botão para isso. Ajustar o lado que parece errado
          esconderia a causa — quem decide o que fazer é quem responde pelo caixa.
        </p>
      </Card>
    </AppShell>
  );
}

/**
 * "MOSTRANDO X DE Y" — a truncagem dita, não escondida (GAP-PRD-177).
 *
 * Só aparece quando há mais do que a lista mostra. Os números do resumo e das
 * divergências nunca foram cortados; é a lista de trabalho que pagina, e ela
 * precisa dizer que pagina.
 */
function MaisLinhas({
  nome,
  mostradas,
  total,
  ocupado,
  onMais,
}: {
  nome: string;
  mostradas: number;
  total: number;
  ocupado: boolean;
  onMais: () => void;
}) {
  if (total <= mostradas) return null;
  return (
    <div
      role="status"
      className="mt-3 flex flex-wrap items-center justify-between gap-3 px-3 py-2
        rounded-[var(--gs-radius)] bg-[var(--gs-warning-bg)] text-[length:var(--gs-text-sm)]"
    >
      <span className="text-[var(--gs-warning)] font-semibold">
        Mostrando {mostradas} de {total} {nome}. O resumo e as divergências contam todas.
      </span>
      <Button size="sm" variant="ghost" loading={ocupado} onClick={onMais}>
        Mostrar mais
      </Button>
    </div>
  );
}
