/**
 * Alteração rápida: preço de muitos produtos numa tela só.
 *
 * O caminho normal é abrir o cadastro, mudar, salvar, voltar, abrir o próximo.
 * Para reajustar trinta itens isso são cento e cinquenta cliques, e quem faz
 * desiste no décimo — o preço fica desatualizado por semanas.
 *
 * QUATRO DECISÕES QUE ESTA TELA TOMA
 *
 * 1. PAGINAÇÃO ANTES DE TUDO. Uma grade que carrega o catálogo inteiro trava
 *    com dois mil produtos, e o primeiro sinal disso seria a tela em branco na
 *    loja com mais itens. Vem paginada desde a primeira versão.
 *
 * 2. QUANTIDADE É LEITURA. A referência deixa editar o saldo aqui. Não deixo:
 *    saldo se move por MOVIMENTO, com motivo e rastro — é o que faz o razão
 *    fechar e o que permite responder "por que tinha 10 e agora tem 7". Um
 *    campo que grava saldo direto apagaria essa resposta. A coluna aparece
 *    para conferência, e o ajuste continua em Estoque.
 *
 * 3. SÓ SALVA O QUE MUDOU. A tela guarda o valor original de cada linha e
 *    manda ao servidor apenas as diferenças. Salvar tudo reescreveria o
 *    catálogo inteiro a cada uso, carimbando `updated_at` em produto que
 *    ninguém tocou — e o histórico deixaria de dizer quem mexeu em quê.
 *
 * 4. SÓ O CAMPO QUE MUDOU, E COM O QUE A TELA VIU (A-produto-07). Dentro da
 *    linha vale a mesma regra: quem mexeu só no custo não manda o preço. E
 *    cada linha diz ao servidor o custo e a venda que MOSTRAVA; se outra pessoa
 *    gravou por cima nesse meio-tempo, a linha é recusada (409) em vez de
 *    desfazer a alteração dela — ver `corpoDaLinha`.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppShell } from '@/components/gs/AppShell';
import { Button, Card, DataTable, EmptyState, Field, Input, PageHeader } from '@/components/gs/ui';
import { ApiRequestError } from '@/lib/api/client';
import { coreApi, type Product } from '@/lib/api/core';
import { useHasProfile } from '@/hooks/useSession';
import { formatCents, parseReaisToCents } from '@/components/gs/format';

const POR_PAGINA = 25;

/**
 * As duas pontas da conversão de dinheiro, e por que elas TÊM que combinar.
 *
 * `parseReaisToCents` é pt-BR: vírgula é decimal e PONTO É MILHAR — "1.500,00"
 * são mil e quinhentos. Escrevi esta tela formatando com `toFixed(2)`, que
 * produz "58.00" com ponto decimal, e mandei esse texto para lá. Resultado:
 * cada linha era lida como 5.800 reais, toda linha parecia alterada, e o botão
 * oferecia salvar doze produtos que ninguém tocou.
 *
 * Formatar em pt-BR fecha o ciclo — o que a tela escreve é exatamente o que a
 * função sabe ler, e o que o usuário digita segue o mesmo formato.
 */
function reais(cents: number | null | undefined): string {
  return ((cents ?? 0) / 100).toLocaleString('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * Os centavos do campo — ou `null` quando o texto não se lê como dinheiro.
 *
 * VALOR ILEGÍVEL NÃO VIRA ZERO (reauditoria do cadastro). Isto devolvia 0 para
 * campo apagado ou "abc": a linha contava como alterada e o Salvar gravava o
 * produto a R$ 0,00 sem aviso — e o PDV passava a vender de graça. Agora o
 * Salvar recusa a linha e diz qual campo refazer (`campoIlegivel`).
 */
function centavos(texto: string): number | null {
  return parseReaisToCents(texto);
}

type Campo = 'custo' | 'venda';
const idDoCampo = (id: string, campo: Campo) => `alteracao-${campo}-${id}`;

/** Markup e margem, para a grade. Mesma regra do cadastro. */
function markupDe(custo: number, venda: number): number | null {
  if (custo <= 0) return null;
  return ((venda - custo) / custo) * 100;
}
function margemDe(custo: number, venda: number): number | null {
  if (venda <= 0) return null;
  return ((venda - custo) / venda) * 100;
}

interface Linha {
  id: string;
  internalCode: string;
  barcode: string;
  name: string;
  unit: string;
  quantity: number;
  /** O que está no banco — a régua para saber o que mudou. */
  custoOriginal: number;
  vendaOriginal: number;
  /** O que está na tela. */
  custo: string;
  venda: string;
}

const mudouCusto = (l: Linha) => centavos(l.custo) !== l.custoOriginal;
const mudouVenda = (l: Linha) => centavos(l.venda) !== l.vendaOriginal;

function mudou(l: Linha): boolean {
  return mudouCusto(l) || mudouVenda(l);
}

/** O campo alterado que não se lê como dinheiro: a linha não vai ao servidor. */
function campoIlegivel(l: Linha): Campo | null {
  if (mudouCusto(l) && centavos(l.custo) === null) return 'custo';
  if (mudouVenda(l) && centavos(l.venda) === null) return 'venda';
  return null;
}

/**
 * O QUE UMA LINHA MANDA AO SERVIDOR (A-produto-07, a metade da Alteração rápida).
 *
 * O DEFEITO: toda linha alterada ia com custo E venda, e sem dizer o que a tela
 * tinha visto. Às 10:00 A abre esta tela com o perfume a R$ 39,90; às 10:05 B
 * baixa o preço para R$ 29,90 no formulário e imprime as etiquetas; às 10:10 A
 * muda só o CUSTO dessa linha — e o PUT levava `priceCents: 3990`, devolvendo o
 * preço a R$ 39,90 sem aviso. A prateleira anuncia 29,90 e o caixa cobra 39,90.
 * O servidor já sabia recusar (`expected` → 409 CORE_PRODUCT_STALE), mas só
 * confere o que vem em `expected`, e esta tela não mandava nada.
 *
 * O CONSERTO, o mesmo contrato do formulário: vai só o campo que a pessoa mudou,
 * e em `expected` o custo e a venda que a linha MOSTRAVA. Os dois vão em
 * `expected` mesmo quando só um mudou, porque a linha os apresenta como par: o
 * markup e a margem que a pessoa leu antes de decidir saem dos dois. Se o banco
 * já não tem o que ela viu, nada daquela linha é gravado.
 */
function corpoDaLinha(l: Linha): Record<string, unknown> {
  const corpo: Record<string, unknown> = {};
  if (mudouCusto(l)) corpo.costCents = centavos(l.custo);
  if (mudouVenda(l)) corpo.priceCents = centavos(l.venda);
  corpo.expected = { costCents: l.custoOriginal, priceCents: l.vendaOriginal };
  return corpo;
}

/**
 * O que a outra pessoa deixou gravado, lido dos campos que o 409 devolve
 * ("Preço de venda agora é R$ 29,90"). Sem os campos, fica a frase do servidor.
 */
function oQueEstaGravadoAgora(err: ApiRequestError): string | null {
  const campos = (err.details as { fields?: { label?: string; agora?: string | null }[] } | undefined)
    ?.fields;
  if (!Array.isArray(campos) || campos.length === 0) return null;
  return campos
    .map((c) => `${c.label ?? 'um campo'} agora é ${c.agora ?? 'em branco'}`)
    .join('; ');
}

export default function AlteracaoRapidaPage() {
  const [busca, setBusca] = useState('');
  const [pagina, setPagina] = useState(0);
  const [linhas, setLinhas] = useState<Linha[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);
  /** O motivo de cada linha que não salvou, mostrado NA linha (A-produto-07). */
  const [problemas, setProblemas] = useState<Record<string, string>>({});
  const podeEditar = useHasProfile('gerente_loja', 'gerente_oficina', 'estoquista');

  /** Devolve se a grade foi relida — o Salvar precisa saber (A-produto-07). */
  const carregar = useCallback(async (): Promise<boolean> => {
    setCarregando(true);
    try {
      const r = await coreApi.listProductsWithShipping({
        search: busca,
        limit: POR_PAGINA,
        offset: pagina * POR_PAGINA,
      });
      setLinhas(
        r.items.map((p: Product) => ({
          id: String(p.id),
          internalCode: p.internal_code ?? '',
          barcode: p.barcode ?? '',
          name: p.name ?? '',
          unit: p.unit ?? 'UN',
          quantity: Number(p.stock_quantity ?? 0),
          custoOriginal: Number(p.cost_cents ?? 0),
          vendaOriginal: Number(p.price_cents ?? 0),
          custo: reais(p.cost_cents),
          venda: reais(p.price_cents),
        })),
      );
      setErro(null);
      return true;
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao carregar os produtos.');
      return false;
    } finally {
      setCarregando(false);
    }
  }, [busca, pagina]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const pendentes = useMemo(() => linhas.filter(mudou), [linhas]);

  const alterar = (id: string, campo: 'custo' | 'venda', valor: string) => {
    setLinhas((atual) => atual.map((l) => (l.id === id ? { ...l, [campo]: valor } : l)));
  };

  const salvar = async () => {
    if (pendentes.length === 0) return;
    /*
      Nenhuma linha vai ao servidor enquanto houver campo ilegível: o motivo fica
      NA linha e o foco vai para o primeiro campo a refazer. Gravar as legíveis
      e deixar as outras para trás faria a pessoa caçar, numa grade de 25, o que
      ficou sem salvar.
    */
    const ilegiveis = pendentes
      .map((l) => ({ l, campo: campoIlegivel(l) }))
      .filter((x): x is { l: Linha; campo: Campo } => x.campo !== null);
    if (ilegiveis.length > 0) {
      const naLinha: Record<string, string> = {};
      for (const { l, campo } of ilegiveis) {
        naLinha[l.id] = `${campo === 'custo' ? 'Custo' : 'Valor de venda'} ilegível: digite no formato 29,90.`;
      }
      setProblemas(naLinha);
      setAviso(null);
      setErro(
        `Nada foi gravado: ${ilegiveis.length} linha(s) com valor ilegível — `
          + ilegiveis.map((x) => x.l.name).join(' · '),
      );
      document.getElementById(idDoCampo(ilegiveis[0].l.id, ilegiveis[0].campo))?.focus();
      return;
    }
    setSalvando(true);
    setErro(null);
    setAviso(null);
    setProblemas({});

    const falhas: string[] = [];
    const naLinha: Record<string, string> = {};
    /*
      O QUE A PESSOA DIGITOU NAS LINHAS QUE NÃO SALVARAM. Depois do Salvar a
      grade é relida, e a releitura trocava tudo pelo banco: a linha recusada
      perdia o que a pessoa digitou, e ela nem sabia qual refazer. Aqui guardo
      SÓ o campo que ela mudou — o outro vem da releitura, com o valor que a
      outra pessoa gravou. Reaplicar o campo que ela não tocou seria reverter o
      preço do outro no Salvar seguinte, que é o defeito que esta tela fecha.
    */
    const redigitar: { id: string; custo?: string; venda?: string }[] = [];
    /** Linhas recusadas por concorrência, com o que o 409 disse estar gravado. */
    const conflitos: { id: string; agora: string | null }[] = [];
    for (const l of pendentes) {
      try {
        const salvo = await coreApi.updateProduct(l.id, corpoDaLinha(l));
        /*
          A RÉGUA DA LINHA GRAVADA SAI DA RESPOSTA DO PUT (revisão, A-produto-07).
          Ela só era trocada pela releitura do fim; se esse GET falhasse, a linha
          gravada seguia "alterada" com o custo/venda de ANTES, e o Salvar
          seguinte mandava esse par velho em `expected` — 409 "outra pessoa
          alterou", contra a gravação da própria pessoa. Com a régua da resposta,
          a linha fica como gravada mesmo sem a releitura.
        */
        setLinhas((atual) =>
          atual.map((x) =>
            x.id === l.id
              ? {
                  ...x,
                  custoOriginal: Number(salvo.cost_cents ?? 0),
                  vendaOriginal: Number(salvo.price_cents ?? 0),
                  custo: reais(salvo.cost_cents),
                  venda: reais(salvo.price_cents),
                }
              : x,
          ),
        );
      } catch (err) {
        if (err instanceof ApiRequestError && err.code === 'CORE_PRODUCT_STALE') {
          // A frase da linha é montada depois da releitura: ela diz "a linha já
          // mostra o que está gravado agora", e isso só é verdade se a grade
          // foi relida.
          conflitos.push({ id: l.id, agora: oQueEstaGravadoAgora(err) });
          falhas.push(`${l.name}: alterado por outra pessoa enquanto você editava`);
        } else {
          const motivo = err instanceof ApiRequestError ? err.message : 'falha ao salvar';
          naLinha[l.id] = motivo;
          falhas.push(`${l.name}: ${motivo}`);
        }
        redigitar.push({
          id: l.id,
          ...(mudouCusto(l) ? { custo: l.custo } : {}),
          ...(mudouVenda(l) ? { venda: l.venda } : {}),
        });
      }
    }

    // A releitura vem ANTES das mensagens: `carregar` zera o erro quando lê
    // bem, e o "3 de 10 não salvaram" sumia no mesmo instante em que aparecia.
    const releu = await carregar();
    for (const c of conflitos) {
      naLinha[c.id] =
        'Outra pessoa alterou este produto enquanto você editava'
        + (c.agora ? ` (${c.agora})` : '')
        + '. Nada desta linha foi gravado. '
        + (releu
          ? 'A linha já mostra o que está gravado agora, com o que você digitou por cima: '
            + 'confira e salve de novo se a sua mudança ainda valer.'
          : 'A grade não pôde ser relida: recarregue a página para ver o que está gravado '
            + 'antes de salvar de novo.');
    }
    if (redigitar.length > 0) {
      setLinhas((atual) =>
        atual.map((l) => {
          const r = redigitar.find((x) => x.id === l.id);
          return r ? { ...l, custo: r.custo ?? l.custo, venda: r.venda ?? l.venda } : l;
        }),
      );
    }
    setProblemas(naLinha);
    setSalvando(false);
    if (falhas.length > 0) {
      // Salvamento parcial é dito por extenso. "Erro ao salvar" depois de
      // vinte linhas gravadas faria a pessoa refazer tudo.
      // Sem a releitura, não apago o motivo dela: a pessoa precisa saber que a
      // grade mostra o que havia antes do Salvar.
      setErro(
        `${falhas.length} de ${pendentes.length} não salvaram: ${falhas.join(' · ')}`
          + (releu ? '' : ' — e a grade não pôde ser relida; recarregue a página antes de salvar de novo.'),
      );
    } else {
      setAviso(`${pendentes.length} produto(s) atualizado(s).`);
    }
  };

  return (
    <AppShell>
      <PageHeader
        breadcrumb={['Produtos', 'Alteração rápida']}
        title="Alteração rápida"
        subtitle="Custo e preço de muitos produtos sem abrir um a um"
        actions={
          podeEditar && (
            <Button loading={salvando} disabled={pendentes.length === 0} onClick={() => void salvar()}>
              {pendentes.length === 0
                ? 'Nada alterado'
                : `Salvar ${pendentes.length} alteração(ões)`}
            </Button>
          )
        }
      />

      {erro && (
        <div
          role="alert"
          className="mb-4 px-3 py-2 rounded-[var(--gs-radius)] bg-[var(--gs-danger-bg)] text-[var(--gs-danger)] text-[length:var(--gs-text-sm)]"
        >
          {erro}
        </div>
      )}
      {aviso && (
        <div
          role="status"
          className="mb-4 px-3 py-2 rounded-[var(--gs-radius)] bg-[var(--gs-surface-hover)] text-[var(--gs-text)] text-[length:var(--gs-text-sm)]"
        >
          {aviso}
        </div>
      )}

      <Card className="mb-5">
        <div className="flex flex-wrap items-end gap-4">
          <div className="flex-1 min-w-[240px]">
            <Field label="Buscar">
              {(p) => (
                <Input
                  {...p}
                  value={busca}
                  onChange={(e) => {
                    setBusca(e.target.value);
                    setPagina(0);
                  }}
                  placeholder="Nome, código interno ou código de barras"
                />
              )}
            </Field>
          </div>
          {pendentes.length > 0 && (
            <p className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-warning)] pb-2 m-0">
              {pendentes.length} linha(s) alterada(s) e não salva(s).
            </p>
          )}
        </div>
      </Card>

      <Card padded={false}>
        {carregando ? (
          <p className="p-6 text-[var(--gs-muted)] m-0">Carregando…</p>
        ) : linhas.length === 0 ? (
          <EmptyState
            title="Nenhum produto encontrado"
            description={busca ? 'Refaça a busca.' : 'Cadastre um produto para começar.'}
          />
        ) : (
          <DataTable
            columns={[
              { header: 'Código', render: (l: Linha) => l.internalCode },
              { header: 'Cód. barras', render: (l: Linha) => l.barcode || '—' },
              {
                header: 'Produto',
                // O motivo da recusa fica NA linha: numa grade de 25, a frase
                // lá em cima não diz qual linha conferir.
                render: (l: Linha) => (
                  <>
                    {l.name}
                    {problemas[l.id] && (
                      <p
                        data-testid={`problema-${l.id}`}
                        className="m-0 mt-1 text-[length:var(--gs-text-xs)] text-[var(--gs-danger)]"
                      >
                        {problemas[l.id]}
                      </p>
                    )}
                  </>
                ),
              },
              {
                // Saldo é LEITURA aqui: ele se move por movimento, com motivo e
                // rastro. Um campo que grava direto apagaria a resposta a "por
                // que tinha 10 e agora tem 7".
                header: 'Qtd.',
                align: 'right',
                render: (l: Linha) => (
                  <span title="O saldo se ajusta em Estoque, com motivo">
                    {l.quantity} {l.unit}
                  </span>
                ),
              },
              {
                header: 'Custo',
                align: 'right',
                render: (l: Linha) =>
                  podeEditar ? (
                    <Input
                      id={idDoCampo(l.id, 'custo')}
                      aria-invalid={centavos(l.custo) === null || undefined}
                      value={l.custo}
                      onChange={(e) => alterar(l.id, 'custo', e.target.value)}
                      inputMode="decimal"
                      aria-label={`Custo de ${l.name}`}
                      className="w-24 text-right"
                    />
                  ) : (
                    formatCents(l.custoOriginal)
                  ),
              },
              {
                header: 'Venda',
                align: 'right',
                render: (l: Linha) =>
                  podeEditar ? (
                    <Input
                      id={idDoCampo(l.id, 'venda')}
                      aria-invalid={centavos(l.venda) === null || undefined}
                      value={l.venda}
                      onChange={(e) => alterar(l.id, 'venda', e.target.value)}
                      inputMode="decimal"
                      aria-label={`Venda de ${l.name}`}
                      className="w-24 text-right"
                    />
                  ) : (
                    formatCents(l.vendaOriginal)
                  ),
              },
              {
                header: 'Markup',
                align: 'right',
                render: (l: Linha) => {
                  const c = centavos(l.custo);
                  const v = centavos(l.venda);
                  const m = c === null || v === null ? null : markupDe(c, v);
                  if (m === null) return <span className="text-[var(--gs-muted)]">—</span>;
                  return (
                    <span className={m < 0 ? 'text-[var(--gs-danger)] font-semibold' : ''}>
                      {m.toFixed(1)}%
                    </span>
                  );
                },
              },
              {
                header: 'Margem',
                align: 'right',
                render: (l: Linha) => {
                  const c = centavos(l.custo);
                  const v = centavos(l.venda);
                  const m = c === null || v === null ? null : margemDe(c, v);
                  if (m === null) return <span className="text-[var(--gs-muted)]">—</span>;
                  return (
                    <span className={m < 0 ? 'text-[var(--gs-danger)] font-semibold' : ''}>
                      {m.toFixed(1)}%
                    </span>
                  );
                },
              },
            ]}
            rows={linhas}
            keyOf={(l) => l.id}
          />
        )}
      </Card>

      {/* Paginação desde a primeira versão: grade que carrega o catálogo
          inteiro trava, e o primeiro a descobrir seria a loja com mais itens. */}
      <div className="flex items-center justify-between mt-4">
        <Button
          variant="ghost"
          disabled={pagina === 0}
          onClick={() => setPagina((p) => Math.max(0, p - 1))}
        >
          Anterior
        </Button>
        <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
          Página {pagina + 1}
        </span>
        <Button
          variant="ghost"
          disabled={linhas.length < POR_PAGINA}
          onClick={() => setPagina((p) => p + 1)}
        >
          Próxima
        </Button>
      </div>
    </AppShell>
  );
}
