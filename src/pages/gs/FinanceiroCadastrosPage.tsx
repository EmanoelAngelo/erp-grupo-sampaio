/**
 * Financeiro › Cadastros — as três perguntas que dão sentido ao lançamento.
 *
 * | aba              | responde                     |
 * |------------------|------------------------------|
 * | Plano de contas  | PARA QUE foi o dinheiro      |
 * | Centros de custo | DE QUAL operação saiu        |
 * | Contas           | ONDE o dinheiro está         |
 *
 * ## O que esta tela deliberadamente não faz
 *
 * Não obriga a preencher nada para o sistema funcionar. As categorias de
 * sistema já vêm criadas e os lançamentos automáticos já nascem classificados
 * nelas — quem quiser detalhar, detalha; quem não quiser, vende do mesmo jeito.
 * Cadastro obrigatório antes do primeiro uso é o que faz o lojista abandonar o
 * módulo financeiro.
 *
 * ## O saldo da conta é derivado
 *
 * Nunca gravado: é o saldo de partida mais o que já foi QUITADO. Em cache ele
 * teria de ser mantido em dia por todo caminho que dá baixa, e divergiria no
 * primeiro que esquecesse — mesmo princípio do saldo por local.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppShell } from '@/components/gs/AppShell';
import { Badge, Button, Card, EmptyState, Input, PageHeader } from '@/components/gs/ui';
import { formatCents, parseReaisToCents } from '@/components/gs/format';
import { ApiRequestError } from '@/lib/api/client';
import {
  coreApi,
  type CostCenter,
  type FinanceAccount,
  type FinanceCategory,
} from '@/lib/api/core';

const ROTULO = 'text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-text-soft)]';
const TH = 'py-2.5 px-4 font-semibold';
const TD = 'py-3 px-4';
const CAIXA_SELECT =
  'h-10 px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)] ' +
  'bg-[var(--gs-surface)] text-[var(--gs-text)] text-[length:var(--gs-text-base)]';

type Aba = 'categorias' | 'centros' | 'contas';

const ABAS: { id: Aba; label: string; hint: string }[] = [
  { id: 'categorias', label: 'Plano de contas', hint: 'Para que foi o dinheiro' },
  { id: 'centros', label: 'Centros de custo', hint: 'De qual operação saiu' },
  { id: 'contas', label: 'Contas', hint: 'Onde o dinheiro está' },
];

const TIPOS_DE_CONTA: { id: FinanceAccount['kind']; label: string }[] = [
  { id: 'banco', label: 'Conta bancária' },
  { id: 'caixinha', label: 'Caixinha / cofre' },
  { id: 'carteira', label: 'Carteira digital' },
];

export default function FinanceiroCadastrosPage() {
  const [aba, setAba] = useState<Aba>('categorias');
  const [categorias, setCategorias] = useState<FinanceCategory[] | null>(null);
  const [centros, setCentros] = useState<CostCenter[]>([]);
  const [contas, setContas] = useState<FinanceAccount[]>([]);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);

  // Formulário de categoria.
  const [catDirecao, setCatDirecao] = useState<'in' | 'out'>('out');
  const [catNome, setCatNome] = useState('');
  const [catPai, setCatPai] = useState('');

  // Formulário de centro de custo.
  const [ccCodigo, setCcCodigo] = useState('');
  const [ccNome, setCcNome] = useState('');

  // Formulário de conta.
  const [contaNome, setContaNome] = useState('');
  const [contaTipo, setContaTipo] = useState<FinanceAccount['kind']>('banco');
  const [contaSaldo, setContaSaldo] = useState('');

  const carregar = useCallback(async () => {
    setErro(null);
    try {
      const r = await coreApi.financeSetup();
      setCategorias(r.categories);
      setCentros(r.costCenters);
      setContas(r.accounts);
    } catch (e) {
      setErro(e instanceof ApiRequestError ? e.message : 'Não foi possível carregar.');
      setCategorias([]);
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  async function comSalvamento(acao: () => Promise<void>, mensagem: string) {
    setSalvando(true);
    setErro(null);
    setAviso(null);
    try {
      await acao();
      setAviso(mensagem);
      await carregar();
    } catch (e) {
      setErro(e instanceof ApiRequestError ? e.message : 'Não foi possível gravar.');
    } finally {
      setSalvando(false);
    }
  }

  /** Só categorias principais da MESMA direção podem ser pai — a árvore tem dois níveis. */
  const paisPossiveis = useMemo(
    () => (categorias ?? []).filter((c) => c.direction === catDirecao && !c.parent_id),
    [categorias, catDirecao],
  );

  /** Pai seguido dos filhos, para a lista ler como plano de contas e não como sopa. */
  const categoriasEmArvore = useMemo(() => {
    const todas = categorias ?? [];
    const saida: { c: FinanceCategory; filho: boolean }[] = [];
    for (const direcao of ['in', 'out'] as const) {
      const raizes = todas.filter((c) => c.direction === direcao && !c.parent_id);
      for (const raiz of raizes) {
        saida.push({ c: raiz, filho: false });
        for (const f of todas.filter((x) => x.parent_id === raiz.id)) {
          saida.push({ c: f, filho: true });
        }
      }
    }
    return saida;
  }, [categorias]);

  return (
    <AppShell>
      <PageHeader
        breadcrumb={['Financeiro', 'Cadastros']}
        title="Cadastros do financeiro"
        subtitle="Para que foi o dinheiro, de qual operação saiu, e onde ele está."
      />

      {erro && (
        <div
          role="alert"
          className="mb-5 px-4 py-3 rounded-[var(--gs-radius)] bg-[var(--gs-danger-bg)] text-[var(--gs-danger)]"
        >
          {erro}
        </div>
      )}
      {aviso && (
        <div className="mb-5 px-4 py-3 rounded-[var(--gs-radius)] bg-[var(--gs-success-bg)] text-[var(--gs-success)]">
          {aviso}
        </div>
      )}

      <div
        role="tablist"
        aria-label="Cadastros do financeiro"
        className="flex gap-1 p-1 bg-[var(--gs-surface-hover)] rounded-[var(--gs-radius)] mb-5 max-w-2xl"
      >
        {ABAS.map((a) => (
          <button
            key={a.id}
            role="tab"
            type="button"
            aria-selected={aba === a.id}
            onClick={() => {
              setAba(a.id);
              setErro(null);
              setAviso(null);
            }}
            className={`flex-1 px-3 py-2 rounded-[var(--gs-radius-sm)] border-0 cursor-pointer
              text-[length:var(--gs-text-sm)] font-semibold ${
                aba === a.id
                  ? 'bg-[var(--gs-surface)] text-[var(--gs-purple-800)] shadow-[var(--gs-shadow-sm)]'
                  : 'bg-transparent text-[var(--gs-muted)]'
              }`}
          >
            {a.label}
          </button>
        ))}
      </div>

      {aba === 'categorias' && (
        <Card
          title="Plano de contas"
          subtitle="Dois níveis, de propósito: plano profundo é o que faz ninguém classificar."
        >
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3 items-end mb-5">
            <label className="flex flex-col gap-1.5">
              <span className={ROTULO}>Tipo</span>
              <select
                value={catDirecao}
                onChange={(e) => {
                  setCatDirecao(e.target.value as 'in' | 'out');
                  setCatPai('');
                }}
                className={CAIXA_SELECT}
              >
                <option value="out">Despesa</option>
                <option value="in">Receita</option>
              </select>
            </label>
            <label className="flex flex-col gap-1.5">
              <span className={ROTULO}>Nome</span>
              <Input
                value={catNome}
                onChange={(e) => setCatNome(e.target.value)}
                placeholder="Aluguel"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className={ROTULO}>Dentro de</span>
              <select
                value={catPai}
                onChange={(e) => setCatPai(e.target.value)}
                className={CAIXA_SELECT}
              >
                <option value="">Categoria principal</option>
                {paisPossiveis.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <Button
              disabled={salvando || !catNome.trim()}
              onClick={() =>
                void comSalvamento(async () => {
                  await coreApi.createFinanceCategory({
                    direction: catDirecao,
                    name: catNome,
                    parentId: catPai || null,
                  });
                  setCatNome('');
                  setCatPai('');
                }, 'Categoria criada.')
              }
            >
              Adicionar
            </Button>
          </div>

          {categorias === null ? (
            <p className="text-[var(--gs-text-soft)]">Carregando…</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[length:var(--gs-text-sm)]">
                <thead>
                  <tr className="text-left text-[var(--gs-text-soft)] border-b border-[var(--gs-border)]">
                    <th className={TH}>Categoria</th>
                    <th className={TH}>Tipo</th>
                    <th className={`${TH} text-right`} />
                  </tr>
                </thead>
                <tbody>
                  {categoriasEmArvore.map(({ c, filho }) => (
                    <tr
                      key={c.id}
                      className={`border-b border-[var(--gs-border)] last:border-0 ${
                        c.active === 1 ? '' : 'opacity-50'
                      }`}
                    >
                      <td className={TD}>
                        <span className={filho ? 'pl-6 text-[var(--gs-text-soft)]' : 'font-semibold'}>
                          {c.name}
                        </span>{' '}
                        {/* A de sistema é a que os lançamentos automáticos usam. */}
                        {c.system_code && <Badge tone="info">automática</Badge>}
                        {c.active !== 1 && <Badge tone="neutral">inativa</Badge>}
                      </td>
                      <td className={TD}>
                        <Badge tone={c.direction === 'in' ? 'success' : 'warning'}>
                          {c.direction === 'in' ? 'receita' : 'despesa'}
                        </Badge>
                      </td>
                      <td className={`${TD} text-right`}>
                        {/* Categoria de sistema não desliga: sem ela a venda
                            entraria sem classificação nenhuma. */}
                        {!c.system_code && (
                          <Button
                            variant="ghost"
                            onClick={() =>
                              void comSalvamento(
                                async () => {
                                  await coreApi.updateFinanceCategory(c.id, {
                                    active: c.active !== 1,
                                  });
                                },
                                c.active === 1 ? 'Categoria desativada.' : 'Categoria reativada.',
                              )
                            }
                          >
                            {c.active === 1 ? 'Desativar' : 'Reativar'}
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {aba === 'centros' && (
        <Card
          title="Centros de custo"
          subtitle="Por empresa: um centro compartilhado somaria despesa de outra operação."
        >
          {/*
            ESTA FRASE ERA A MAIS IMPORTANTE DA ABA, E DIZIA QUE A ABA NÃO
            SERVIA PARA NADA. Agora serve, e a frase mudou junto (GAP-V25).

            O que ela dizia, e era verdade: o centro de custo era GRAVADO no
            lançamento e nenhum relatório o lia. Quem cadastrasse "Loja centro"
            e "Oficina" aqui, e passasse a preencher o campo todo dia, estaria
            pagando um trabalho diário por um recorte que nunca apareceria. A
            rodada 24 cortou o consumo de propósito e declarou o corte na tela,
            que é melhor do que oferecer o cadastro em silêncio.

            O que mudou: o centro passou a ter DOIS leitores — o filtro na lista
            de contas e o bloco "Por centro de custo" no DRE, irmão da partição
            por categoria e com os mesmos totais do período.

            Manter a frase antiga agora seria o defeito ao contrário: uma tela
            avisando que não faz o que faz, e ensinando a não preencher o campo
            que finalmente responde alguma coisa.
          */}
          <p
            className="px-4 py-3 mb-5 rounded-[var(--gs-radius)] bg-[var(--gs-canvas)]
              text-[length:var(--gs-text-base)] text-[var(--gs-text-soft)] m-0"
          >
            O centro de custo já é lido em duas telas: filtra a lista em Contas a pagar e a
            receber, e ganha o recorte <strong>Por centro de custo</strong> no resultado do
            período (DRE), com o mesmo período e a mesma competência. Lançamento sem centro
            atribuído aparece lá como <strong>Sem centro de custo</strong> — é a linha que
            mede o quanto do rateio ainda falta.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end mb-5">
            <label className="flex flex-col gap-1.5">
              <span className={ROTULO}>Código</span>
              <Input
                value={ccCodigo}
                onChange={(e) => setCcCodigo(e.target.value)}
                placeholder="LOJA"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className={ROTULO}>Nome</span>
              <Input
                value={ccNome}
                onChange={(e) => setCcNome(e.target.value)}
                placeholder="Loja centro"
              />
            </label>
            <Button
              disabled={salvando || !ccCodigo.trim() || !ccNome.trim()}
              onClick={() =>
                void comSalvamento(async () => {
                  await coreApi.createCostCenter({ code: ccCodigo, name: ccNome });
                  setCcCodigo('');
                  setCcNome('');
                }, 'Centro de custo criado.')
              }
            >
              Adicionar
            </Button>
          </div>

          {centros.length === 0 ? (
            <EmptyState
              title="Nenhum centro de custo"
              description="Use para separar despesa por loja, por oficina ou por veículo."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[length:var(--gs-text-sm)]">
                <thead>
                  <tr className="text-left text-[var(--gs-text-soft)] border-b border-[var(--gs-border)]">
                    <th className={TH}>Código</th>
                    <th className={TH}>Nome</th>
                    <th className={`${TH} text-right`} />
                  </tr>
                </thead>
                <tbody>
                  {centros.map((cc) => (
                    <tr
                      key={cc.id}
                      className={`border-b border-[var(--gs-border)] last:border-0 ${
                        cc.active === 1 ? '' : 'opacity-50'
                      }`}
                    >
                      <td className={`${TD} font-mono text-[length:var(--gs-text-xs)]`}>{cc.code}</td>
                      <td className={TD}>
                        {cc.name} {cc.active !== 1 && <Badge tone="neutral">inativo</Badge>}
                      </td>
                      <td className={`${TD} text-right`}>
                        <Button
                          variant="ghost"
                          onClick={() =>
                            void comSalvamento(
                              async () => {
                                await coreApi.updateCostCenter(cc.id, { active: cc.active !== 1 });
                              },
                              cc.active === 1 ? 'Centro desativado.' : 'Centro reativado.',
                            )
                          }
                        >
                          {cc.active === 1 ? 'Desativar' : 'Reativar'}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {aba === 'contas' && (
        <Card
          title="Contas"
          subtitle="O caixa do PDV não entra aqui: ele já tem abertura, fechamento e sangria próprios."
        >
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3 items-end mb-5">
            <label className="flex flex-col gap-1.5">
              <span className={ROTULO}>Nome</span>
              <Input
                value={contaNome}
                onChange={(e) => setContaNome(e.target.value)}
                placeholder="Banco do Brasil"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className={ROTULO}>Tipo</span>
              <select
                value={contaTipo}
                onChange={(e) => setContaTipo(e.target.value as FinanceAccount['kind'])}
                className={CAIXA_SELECT}
              >
                {TIPOS_DE_CONTA.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1.5">
              <span className={ROTULO}>Saldo de partida</span>
              <Input
                value={contaSaldo}
                onChange={(e) => setContaSaldo(e.target.value)}
                inputMode="decimal"
                placeholder="0,00"
              />
            </label>
            <Button
              disabled={salvando || !contaNome.trim()}
              onClick={() =>
                void comSalvamento(async () => {
                  await coreApi.createFinanceAccount({
                    name: contaNome,
                    kind: contaTipo,
                    // O mesmo interpretador de dinheiro do resto do sistema:
                    // uma terceira implementação de parsing já deu bug antes.
                    openingBalanceCents: contaSaldo.trim()
                      ? parseReaisToCents(contaSaldo)
                      : 0,
                  });
                  setContaNome('');
                  setContaSaldo('');
                }, 'Conta criada.')
              }
            >
              Adicionar
            </Button>
          </div>

          {contas.length === 0 ? (
            <EmptyState
              title="Nenhuma conta"
              description="Cadastre onde o dinheiro entra e sai: banco, cofre ou carteira digital."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[length:var(--gs-text-sm)]">
                <thead>
                  <tr className="text-left text-[var(--gs-text-soft)] border-b border-[var(--gs-border)]">
                    <th className={TH}>Conta</th>
                    <th className={TH}>Tipo</th>
                    <th className={`${TH} text-right`}>Saldo</th>
                    <th className={`${TH} text-right`} />
                  </tr>
                </thead>
                <tbody>
                  {contas.map((c) => (
                    <tr
                      key={c.id}
                      className={`border-b border-[var(--gs-border)] last:border-0 ${
                        c.active === 1 ? '' : 'opacity-50'
                      }`}
                    >
                      <td className={TD}>
                        <span className="font-semibold">{c.name}</span>{' '}
                        {c.is_default === 1 && <Badge tone="info">padrão</Badge>}
                        {c.active !== 1 && <Badge tone="neutral">inativa</Badge>}
                      </td>
                      <td className={TD}>
                        {TIPOS_DE_CONTA.find((t) => t.id === c.kind)?.label ?? c.kind}
                      </td>
                      <td className={`${TD} text-right tabular-nums font-semibold`}>
                        {formatCents(c.balanceCents)}
                      </td>
                      <td className={`${TD} text-right whitespace-nowrap`}>
                        {c.is_default !== 1 && c.active === 1 && (
                          <Button
                            variant="ghost"
                            onClick={() =>
                              void comSalvamento(async () => {
                                await coreApi.updateFinanceAccount(c.id, { isDefault: true });
                              }, 'Conta padrão trocada.')
                            }
                          >
                            Tornar padrão
                          </Button>
                        )}
                        {/* A conta padrão não desliga sem outra assumir:
                            lançamento novo ficaria sem para onde apontar. */}
                        {c.is_default !== 1 && (
                          <Button
                            variant="ghost"
                            onClick={() =>
                              void comSalvamento(
                                async () => {
                                  await coreApi.updateFinanceAccount(c.id, {
                                    active: c.active !== 1,
                                  });
                                },
                                c.active === 1 ? 'Conta desativada.' : 'Conta reativada.',
                              )
                            }
                          >
                            {c.active === 1 ? 'Desativar' : 'Reativar'}
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <p className="mt-4 mb-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
            O saldo é o de partida mais o que já foi <strong>quitado</strong>. Conta em aberto não
            entra: dinheiro prometido não é dinheiro na conta.
          </p>
        </Card>
      )}
    </AppShell>
  );
}
