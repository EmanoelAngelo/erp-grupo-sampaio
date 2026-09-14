/**
 * Auxiliares do catálogo: unidade, grupo tributário, alíquota e tabela de preços.
 *
 * Quatro cadastros numa tela só, em abas. Separá-los em quatro itens de menu —
 * como faz a referência — obriga a sair e voltar quando se está montando o
 * cadastro pela primeira vez, que é justamente quando os quatro são mexidos
 * juntos. O menu aponta para cá uma vez; a aba faz o resto.
 *
 * As quatro listas chegam numa requisição (`getCatalogAux`): quatro chamadas em
 * sequência deixariam a tela abrindo por partes.
 */
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AppShell } from '@/components/gs/AppShell';
import { Badge, Button, Card, DataTable, EmptyState, Field, Input, PageHeader } from '@/components/gs/ui';
// O MESMO interpretador de dinheiro do resto do sistema. Uma terceira
// implementação de parsing já causou um bug neste projeto.
import { formatCents, parseReaisToCents } from '@/components/gs/format';
import { ApiRequestError } from '@/lib/api/client';
import {
  coreApi,
  type Aliquota,
  type CampoPersonalizado,
  type CatalogAux,
  type GrupoTributario,
  type PrecoFixado,
  type Product,
  type TabelaDePreco,
  type Unidade,
} from '@/lib/api/core';
import { useHasProfile } from '@/hooks/useSession';

type Aba = 'unidades' | 'tributarios' | 'aliquotas' | 'tabelas' | 'personalizados';

const ABAS: { id: Aba; label: string; hint: string }[] = [
  {
    id: 'unidades',
    label: 'Unidades',
    hint: 'Como cada produto é medido — e quantas casas decimais a quantidade aceita',
  },
  {
    id: 'tributarios',
    label: 'Grupos tributários',
    hint: 'A regra fiscal que vários produtos compartilham',
  },
  { id: 'aliquotas', label: 'Alíquotas', hint: 'Percentuais nomeados, para não repetir o número' },
  {
    id: 'tabelas',
    label: 'Tabelas de preço',
    hint: 'Preço diferenciado por tabela — atacado, cliente especial',
  },
  {
    id: 'personalizados',
    label: 'Campos próprios',
    hint: 'Atributos que só esta operação usa: voltagem, aro, prazo de garantia',
  },
];

const REGIMES: { valor: string; rotulo: string }[] = [
  { valor: 'simples', rotulo: 'Simples Nacional / MEI' },
  { valor: 'simples_excesso', rotulo: 'Simples Nacional — excesso de sublimite' },
  { valor: 'normal', rotulo: 'Regime normal' },
];

// 'icms' saiu quando nada no servidor o lia, e VOLTOU com o leitor (GAP-PRD-021):
// o grupo tributário escolhe a alíquota de ICMS dos CST 00, 20 e 90, e a de FCP
// que se soma a ela. O porquê inteiro está em CatalogAuxService.TIPOS_ALIQUOTA.
const TIPOS_ALIQUOTA = ['pis', 'cofins', 'ipi', 'icms', 'fcp'] as const;

export default function AuxiliaresCatalogoPage() {
  /*
    `?aba=` ABRE DIRETO NUMA ABA (GAP-PRD-095): o checklist fiscal aponta para
    os grupos tributários, e cair em "Unidades" faria a pessoa procurar.
  */
  const [params] = useSearchParams();
  const [aba, setAba] = useState<Aba>(() => {
    const pedida = params.get('aba');
    return ABAS.some((a) => a.id === pedida) ? (pedida as Aba) : 'unidades';
  });
  const [dados, setDados] = useState<CatalogAux | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(true);
  const podeEditar = useHasProfile('gerente_loja', 'gerente_oficina', 'estoquista');
  /*
    FIXAR PREÇO é mais estreito que editar os auxiliares, porque o guarda do
    servidor é: `PUT/DELETE /catalog/price-tables/:id/items/:productId` nomeiam
    só `gerente_loja` e `gerente_oficina` — fixar um valor fechado numa
    negociação é decisão de gerente, não de quem confere mercadoria. O
    estoquista continua VENDO a lista de fixados (o GET é do escritório
    inteiro); o que ele não ganha é um formulário cujo salvar responderia 403.
  */
  const podeFixar = useHasProfile('gerente_loja', 'gerente_oficina');

  /**
   * As definições de campo próprio (GAP-V07).
   *
   * Vêm de rota SEPARADA, e não de `/catalog/aux`: aquela resposta é carregada
   * pelo formulário de produto a cada abertura, e ele não precisa desta lista —
   * ele precisa dos VALORES do produto, que são outra rota. Enfiar mais uma
   * lista lá dentro faria todo cadastro pagar por uma tela que quase ninguém
   * abre.
   */
  const [campos, setCampos] = useState<CampoPersonalizado[]>([]);

  const recarregar = useCallback(async () => {
    setCarregando(true);
    try {
      setDados(await coreApi.getCatalogAux());
      // Falha aqui não derruba os outros quatro cadastros: é uma aba, não a
      // tela.
      setCampos(await coreApi.listCustomFields().catch(() => []));
      setErro(null);
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao carregar os auxiliares.');
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => {
    void recarregar();
  }, [recarregar]);

  /** Executa e traduz o erro do servidor, que é quem sabe explicar a recusa. */
  const executar = async (acao: () => Promise<unknown>, sucesso: string) => {
    setErro(null);
    setAviso(null);
    try {
      await acao();
      await recarregar();
      setAviso(sucesso);
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Não foi possível salvar.');
    }
  };

  return (
    <AppShell>
      <PageHeader
        breadcrumb={['Produtos', 'Auxiliares']}
        title="Auxiliares do catálogo"
        subtitle="O vocabulário que o cadastro de produto usa"
      />

      <div
        role="tablist"
        aria-label="Auxiliares"
        className="flex flex-wrap gap-1 p-1 bg-[var(--gs-surface-hover)] rounded-[var(--gs-radius)] mb-5"
      >
        {ABAS.map((t) => (
          <button
            key={t.id}
            role="tab"
            type="button"
            aria-selected={aba === t.id}
            onClick={() => {
              setAba(t.id);
              setErro(null);
              setAviso(null);
            }}
            className={`px-4 py-2 rounded-[var(--gs-radius-sm)] border-0 cursor-pointer
              text-[length:var(--gs-text-sm)] font-semibold transition-colors ${
                aba === t.id
                  ? 'bg-[var(--gs-surface)] text-[var(--gs-purple-800)] shadow-[var(--gs-shadow-sm)]'
                  : 'bg-transparent text-[var(--gs-muted)]'
              }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] mt-0 mb-4">
        {ABAS.find((t) => t.id === aba)?.hint}
      </p>

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
          className="mb-4 px-3 py-2 rounded-[var(--gs-radius)] bg-[var(--gs-success-bg,var(--gs-surface-hover))] text-[var(--gs-text)] text-[length:var(--gs-text-sm)]"
        >
          {aviso}
        </div>
      )}

      {carregando && <p className="text-[var(--gs-muted)]">Carregando…</p>}

      {dados && aba === 'unidades' && (
        <PainelUnidades
          unidades={dados.units}
          podeEditar={podeEditar}
          onSalvar={(u) => executar(() => coreApi.saveUnit(u), 'Unidade salva.')}
          onExcluir={(id) => executar(() => coreApi.deleteUnit(id), 'Unidade excluída.')}
        />
      )}

      {dados && aba === 'tributarios' && (
        <PainelGruposTributarios
          grupos={dados.taxGroups}
          // As alíquotas vêm junto porque o IPI do grupo aponta para UMA delas
          // pelo código (GAP-V08): um campo de texto livre aqui deixaria digitar
          // um código que não existe, e a recusa só apareceria na emissão.
          aliquotas={dados.taxRates}
          podeEditar={podeEditar}
          onSalvar={(g) => executar(() => coreApi.saveTaxGroup(g), 'Grupo salvo.')}
          onExcluir={(id) => executar(() => coreApi.deleteTaxGroup(id), 'Grupo excluído.')}
        />
      )}

      {dados && aba === 'aliquotas' && (
        <PainelAliquotas
          aliquotas={dados.taxRates}
          podeEditar={podeEditar}
          onSalvar={(a) => executar(() => coreApi.saveTaxRate(a), 'Alíquota salva.')}
          onExcluir={(id) => executar(() => coreApi.deleteTaxRate(id), 'Alíquota excluída.')}
        />
      )}

      {dados && aba === 'tabelas' && (
        <PainelTabelasDePreco
          tabelas={dados.priceTables}
          podeEditar={podeEditar}
          podeFixar={podeFixar}
          onSalvar={(t) => executar(() => coreApi.savePriceTable(t), 'Tabela salva.')}
          onExcluir={(id) => executar(() => coreApi.deletePriceTable(id), 'Tabela excluída.')}
          // A contagem "Preços fixados" da lista vem do servidor: quando o
          // painel fixa ou remove um preço, a lista de tabelas precisa ser
          // relida, senão o número mente até o próximo F5.
          onFixadosMudaram={() => void recarregar()}
        />
      )}

      {dados && aba === 'personalizados' && (
        <PainelCamposPersonalizados
          campos={campos}
          podeEditar={podeEditar}
          onSalvar={(c) => executar(() => coreApi.saveCustomField(c), 'Campo salvo.')}
          onExcluir={(id) => executar(() => coreApi.deleteCustomField(id), 'Campo excluído.')}
        />
      )}
    </AppShell>
  );
}

// ------------------------------------------------------- campos personalizados

/**
 * A DEFINIÇÃO dos campos próprios da operação (GAP-V07).
 *
 * Atributos que só aquele negócio tem — voltagem, aro, prazo de garantia — e
 * que não cabem em descrição (texto solto não se filtra) nem em
 * `variant_attributes` (aquele é da GRADE: cada valor vira um produto próprio,
 * com EAN e saldo).
 *
 * O CÓDIGO é imutável depois de criado, como no grupo tributário e na unidade:
 * é ele que o valor guarda. O RÓTULO se corrige à vontade, e é isso que
 * permite consertar "Voltagen" sem perder os cem produtos já preenchidos.
 */
function PainelCamposPersonalizados({
  campos,
  podeEditar,
  onSalvar,
  onExcluir,
}: {
  campos: CampoPersonalizado[];
  podeEditar: boolean;
  onSalvar: (c: Record<string, unknown>) => void;
  onExcluir: (id: string) => void;
}) {
  const vazio = { id: '', code: '', label: '', kind: 'text', options: '', position: '0' };
  const [form, setForm] = useState(vazio);
  const editando = Boolean(form.id);

  return (
    <div className="flex flex-col gap-5">
      {podeEditar && (
        <Card title={editando ? `Editando ${form.code}` : 'Novo campo próprio'}>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Código" required hint="Imutável: é ele que o valor guarda">
              {(p) => (
                <Input
                  {...p}
                  value={form.code}
                  onChange={(e) =>
                    setForm({ ...form, code: e.target.value.toUpperCase().replace(/\s+/g, '_') })
                  }
                  placeholder="VOLTAGEM"
                  disabled={editando}
                />
              )}
            </Field>
            <Field label="Rótulo" required hint="O que aparece no cadastro do produto">
              {(p) => (
                <Input
                  {...p}
                  value={form.label}
                  onChange={(e) => setForm({ ...form, label: e.target.value })}
                  placeholder="Voltagem"
                />
              )}
            </Field>
            <Field label="Tipo">
              {(p) => (
                <select
                  {...p}
                  value={form.kind}
                  onChange={(e) => setForm({ ...form, kind: e.target.value })}
                  className="h-10 px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)] bg-[var(--gs-surface)] text-[var(--gs-text)]"
                >
                  <option value="text">Texto</option>
                  <option value="number">Número</option>
                  <option value="date">Data</option>
                  <option value="select">Lista de opções</option>
                </select>
              )}
            </Field>
            {form.kind === 'select' && (
              <Field label="Opções" required hint="Uma por linha">
                {(p) => (
                  <textarea
                    {...p}
                    value={form.options}
                    onChange={(e) => setForm({ ...form, options: e.target.value })}
                    rows={4}
                    placeholder={'110V\n220V\nBivolt'}
                    className="w-full px-3 py-2 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)] bg-[var(--gs-surface)] text-[var(--gs-text)]"
                  />
                )}
              </Field>
            )}
            <Field label="Ordem" hint="Menor aparece primeiro no formulário">
              {(p) => (
                <Input
                  {...p}
                  inputMode="numeric"
                  value={form.position}
                  onChange={(e) => setForm({ ...form, position: e.target.value })}
                />
              )}
            </Field>
          </div>
          <div className="flex gap-2 mt-4">
            <Button
              onClick={() => {
                onSalvar({
                  ...form,
                  id: form.id || undefined,
                  position: Number(form.position) || 0,
                });
                setForm(vazio);
              }}
              disabled={!form.code.trim() || !form.label.trim()}
            >
              Salvar
            </Button>
            {editando && (
              <Button variant="ghost" onClick={() => setForm(vazio)}>
                Cancelar
              </Button>
            )}
          </div>
        </Card>
      )}

      <Card padded={false}>
        {campos.length === 0 ? (
          <EmptyState
            title="Nenhum campo próprio ainda"
            description="Crie um campo para que ele apareça na aba Campos próprios do cadastro de todos os produtos desta operação."
          />
        ) : (
          <DataTable
            columns={[
              { header: 'Código', render: (c: CampoPersonalizado) => <strong>{c.code}</strong> },
              { header: 'Rótulo', render: (c: CampoPersonalizado) => c.label },
              {
                header: 'Tipo',
                render: (c: CampoPersonalizado) =>
                  ({ text: 'Texto', number: 'Número', date: 'Data', select: 'Lista' })[c.kind] ??
                  c.kind,
              },
              {
                header: 'Produtos',
                align: 'right',
                render: (c: CampoPersonalizado) => (c.usage > 0 ? c.usage : '—'),
              },
              {
                header: '',
                render: (c: CampoPersonalizado) =>
                  podeEditar && (
                    <div className="flex gap-2 justify-end">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          setForm({
                            id: c.id,
                            code: c.code,
                            label: c.label,
                            kind: c.kind,
                            options: c.options ?? '',
                            position: String(c.position),
                          })
                        }
                      >
                        Editar
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => onExcluir(c.id)}>
                        Excluir
                      </Button>
                    </div>
                  ),
              },
            ]}
            rows={campos}
            keyOf={(c) => c.id}
          />
        )}
      </Card>
    </div>
  );
}

// ----------------------------------------------------------------- unidades

function PainelUnidades({
  unidades,
  podeEditar,
  onSalvar,
  onExcluir,
}: {
  unidades: Unidade[];
  podeEditar: boolean;
  onSalvar: (u: { id?: string; code: string; name: string; decimals: number }) => void;
  onExcluir: (id: string) => void;
}) {
  const [form, setForm] = useState({ id: '', code: '', name: '', decimals: 0 });
  const editando = Boolean(form.id);

  return (
    <div className="flex flex-col gap-5">
      {podeEditar && (
        <Card title={editando ? `Editando ${form.code}` : 'Nova unidade'}>
          <div className="grid gap-4 sm:grid-cols-4">
            <Field label="Sigla" required>
              {(p) => (
                <Input
                  {...p}
                  value={form.code}
                  onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
                  placeholder="UN"
                  maxLength={6}
                  /* A sigla é o que o produto guarda: mudá-la órfã os produtos
                     que a usam, e o servidor recusa. Bloquear aqui evita que a
                     pessoa digite para só então descobrir. */
                  disabled={editando}
                />
              )}
            </Field>
            <Field label="Nome" required>
              {(p) => (
                <Input
                  {...p}
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="Unidade"
                />
              )}
            </Field>
            <Field label="Casas decimais">
              {(p) => (
                <div {...p} className="flex items-center gap-4 h-10">
                  {[0, 1, 2, 3].map((n) => (
                    <label key={n} className="flex items-center gap-1.5 cursor-pointer">
                      <input
                        type="radio"
                        name="decimals"
                        checked={form.decimals === n}
                        onChange={() => setForm({ ...form, decimals: n })}
                      />
                      <span className="text-[length:var(--gs-text-sm)]">{n}</span>
                    </label>
                  ))}
                </div>
              )}
            </Field>
            <div className="flex items-end gap-2">
              <Button
                onClick={() => {
                  onSalvar({
                    id: form.id || undefined,
                    code: form.code,
                    name: form.name,
                    decimals: form.decimals,
                  });
                  setForm({ id: '', code: '', name: '', decimals: 0 });
                }}
                disabled={!form.code.trim() || !form.name.trim()}
              >
                Salvar
              </Button>
              {editando && (
                <Button
                  variant="ghost"
                  onClick={() => setForm({ id: '', code: '', name: '', decimals: 0 })}
                >
                  Cancelar
                </Button>
              )}
            </div>
          </div>
          <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] mt-3 mb-0">
            Casas decimais é o que impede vender meia caixa: quantidade fora do que a unidade
            aceita é erro de digitação, não arredondamento.
          </p>
        </Card>
      )}

      <Card padded={false}>
        {unidades.length === 0 ? (
          <EmptyState title="Nenhuma unidade ainda" description="Vamos começar?" />
        ) : (
          <DataTable
            columns={[
              { header: 'Sigla', render: (u: Unidade) => <strong>{u.code}</strong> },
              { header: 'Unidade', render: (u: Unidade) => u.name },
              { header: 'Casas decimais', align: 'right', render: (u: Unidade) => u.decimals },
              {
                header: 'Produtos',
                align: 'right',
                render: (u: Unidade) => (u.usage > 0 ? u.usage : '—'),
              },
              {
                header: 'Ativo',
                render: (u: Unidade) => (
                  <Badge tone={u.active ? 'success' : 'neutral'}>{u.active ? 'Sim' : 'Não'}</Badge>
                ),
              },
              {
                header: '',
                render: (u: Unidade) =>
                  podeEditar && (
                    <div className="flex gap-2 justify-end">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          setForm({ id: u.id, code: u.code, name: u.name, decimals: u.decimals })
                        }
                      >
                        Editar
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => onExcluir(u.id)}>
                        Excluir
                      </Button>
                    </div>
                  ),
              },
            ]}
            rows={unidades}
            keyOf={(u) => u.id}
          />
        )}
      </Card>
    </div>
  );
}

// -------------------------------------------------------- grupos tributários

/**
 * CST de IPI que valem numa SAÍDA — a metade da tabela que este sistema emite.
 *
 * Os de 00 a 49 são de ENTRADA, e o servidor os recusa. Oferecê-los aqui seria
 * montar a recusa junto com a pessoa.
 *
 * Os cinco do meio (51 a 55) não têm valor: o bloco do layout leva só o código.
 * Os dois com valor (50 e 99) exigem alíquota — e este sistema ainda não cobra
 * imposto por fora, então a emissão os recusa com a razão por extenso. O rótulo
 * avisa antes, para ninguém escolher e descobrir na venda.
 */
const CST_IPI_SAIDA: { valor: string; rotulo: string }[] = [
  { valor: '', rotulo: 'Sem IPI (padrão do varejo no Simples)' },
  { valor: '51', rotulo: '51 — Saída tributada com alíquota zero' },
  { valor: '52', rotulo: '52 — Saída isenta' },
  { valor: '53', rotulo: '53 — Saída não-tributada' },
  { valor: '54', rotulo: '54 — Saída imune' },
  { valor: '55', rotulo: '55 — Saída com suspensão' },
  { valor: '50', rotulo: '50 — Saída tributada (a emissão ainda recusa: veja o aviso)' },
  { valor: '99', rotulo: '99 — Outras saídas (a emissão ainda recusa: veja o aviso)' },
];

/** Os dois CST que destacam valor — e que a emissão ainda não sabe cobrar. */
const CST_IPI_COM_VALOR = new Set(['50', '99']);

/**
 * A ORIGEM DA MERCADORIA — tabela A da NF-e, de 0 a 8.
 *
 * Lista FECHADA por lei, e não uma relação interna que cresce: o layout aceita
 * estes nove códigos e mais nenhum. Vem como seletor pelo mesmo motivo do CST
 * de IPI — digitar "9" aqui só seria descoberto na rejeição da SEFAZ.
 */
/*
  ============================================================================
  O ICMS DO GRUPO, NAS TABELAS DO LEIAUTE (GAP-PRD-021)
  ============================================================================

  CSOSN e CST de ICMS eram campos de texto: "999" entrava e a recusa só vinha
  com o cliente no caixa. Viram seletores com a tabela do leiaute — a mesma que
  o servidor usa para recusar no cadastro (`TabelasDoIcms`) — e cada código diz
  se a emissão o monta. Os que ela recusa aparecem marcados, com o aviso do
  porquê logo abaixo do formulário, como o IPI destacado já fazia.
*/
const CSOSN_DO_LEIAUTE: { valor: string; rotulo: string }[] = [
  { valor: '', rotulo: '— (regime normal: vale o CST de ICMS)' },
  { valor: '101', rotulo: '101 — Tributada com permissão de crédito' },
  { valor: '102', rotulo: '102 — Tributada sem permissão de crédito' },
  { valor: '103', rotulo: '103 — Isenção por faixa de receita bruta' },
  { valor: '300', rotulo: '300 — Imune' },
  { valor: '400', rotulo: '400 — Não tributada' },
  { valor: '500', rotulo: '500 — ICMS cobrado antes por ST (o fornecedor recolheu)' },
  { valor: '900', rotulo: '900 — Outros' },
  { valor: '201', rotulo: '201 — Com crédito e ST cobrada por esta empresa (recusada)' },
  { valor: '202', rotulo: '202 — Sem crédito e ST cobrada por esta empresa (recusada)' },
  { valor: '203', rotulo: '203 — Isenção por faixa e ST cobrada por esta empresa (recusada)' },
];

const CST_ICMS_DO_LEIAUTE: { valor: string; rotulo: string }[] = [
  { valor: '', rotulo: '— (Simples: vale o CSOSN)' },
  { valor: '00', rotulo: '00 — Tributada integralmente' },
  { valor: '20', rotulo: '20 — Com redução de base de cálculo' },
  { valor: '40', rotulo: '40 — Isenta' },
  { valor: '41', rotulo: '41 — Não tributada' },
  { valor: '50', rotulo: '50 — Suspensão' },
  { valor: '60', rotulo: '60 — ICMS cobrado antes por ST (o fornecedor recolheu)' },
  { valor: '90', rotulo: '90 — Outras' },
  { valor: '10', rotulo: '10 — Tributada e ST cobrada por esta empresa (recusada)' },
  { valor: '30', rotulo: '30 — Isenta e ST cobrada por esta empresa (recusada)' },
  { valor: '70', rotulo: '70 — Redução de base e ST cobrada por esta empresa (recusada)' },
  { valor: '51', rotulo: '51 — Diferimento (recusada)' },
  { valor: '02', rotulo: '02 — Monofásico de combustíveis (recusada)' },
  { valor: '15', rotulo: '15 — Monofásico de combustíveis com retenção (recusada)' },
  { valor: '53', rotulo: '53 — Monofásico de combustíveis diferido (recusada)' },
  { valor: '61', rotulo: '61 — Monofásico de combustíveis cobrado antes (recusada)' },
];

/** A ST calculada por esta empresa: cobrada por fora, e por isso recusada na emissão. */
const ST_POR_FORA = new Set(['201', '202', '203', '10', '30', '70']);
/** Combustível e diferimento: fora do que o cadastro descreve. */
const ICMS_FORA_DO_VAREJO = new Set(['51', '02', '15', '53', '61']);
/** Os CST que destacam ICMS próprio — os únicos que leem a alíquota de ICMS. */
const CST_COM_ALIQUOTA = new Set(['00', '20', '90']);
const CST_ALIQUOTA_OBRIGATORIA = new Set(['00', '20']);
/** A redução de base: obrigatória no 20, opcional no 90. */
const CST_COM_REDUCAO = new Set(['20', '90']);

/** O seletor mostra o valor gravado mesmo fora da tabela — para ser corrigido, não escondido. */
function comValorAtual(
  opcoes: { valor: string; rotulo: string }[],
  atual: string,
): { valor: string; rotulo: string }[] {
  return !atual || opcoes.some((o) => o.valor === atual)
    ? opcoes
    : [...opcoes, { valor: atual, rotulo: `${atual} — fora da tabela do leiaute (corrija)` }];
}

const ORIGENS_DA_MERCADORIA: { valor: string; rotulo: string }[] = [
  { valor: '', rotulo: '— (o contador informa qual é)' },
  { valor: '0', rotulo: '0 — Nacional' },
  { valor: '1', rotulo: '1 — Estrangeira, importação direta' },
  { valor: '2', rotulo: '2 — Estrangeira, comprada no mercado interno' },
  { valor: '3', rotulo: '3 — Nacional com importação acima de 40% e até 70%' },
  { valor: '4', rotulo: '4 — Nacional por processo produtivo básico' },
  { valor: '5', rotulo: '5 — Nacional com importação de até 40%' },
  { valor: '6', rotulo: '6 — Estrangeira sem similar nacional (lista CAMEX)' },
  { valor: '7', rotulo: '7 — Estrangeira do mercado interno, sem similar (CAMEX)' },
  { valor: '8', rotulo: '8 — Nacional com importação acima de 70%' },
];

/*
  ============================================================================
  O SALVAR REESCREVE O GRUPO INTEIRO — ENTÃO O FORMULÁRIO CARREGA O GRUPO
  INTEIRO
  ============================================================================

  ## O defeito, medido

  `upsertTaxGroup` grava TODAS as colunas a cada salvar, e `opcional(undefined)`
  devolve `null`. O formulário montava o corpo com DOZE chaves escritas à mão e
  o grupo tem QUINZE colunas graváveis: `cfopInternal`, `cfopExternal`,
  `origin` e `cstIcms` ficaram de fora. Editar só o NOME de um grupo APAGAVA os
  quatro, em silêncio, com a tela respondendo "Grupo salvo.".

  O estrago aparecia longe e depois: `TributacaoDoItem` passa a recusar todo
  produto sem CFOP próprio ("não tem CFOP, e o grupo X não tem CFOP interno"),
  e em regime normal a recusa vira "não tem CST de ICMS" — com o cliente no
  balcão, meses depois de alguém ter corrigido um acento.

  ## Por que a lista escrita à mão era a doença, e não os quatro campos

  O comentário anterior deste arquivo já descrevia o mesmo defeito ("tinha seis
  campos e o grupo tem treze") e a rodada que o leu completou a lista com PIS,
  COFINS, pCredSN e IPI — deixando estes quatro. É a assinatura da lista por
  complemento: alguém tem de LEMBRAR de completá-la quando uma coluna nasce, e
  a única prova de que esqueceu é uma emissão recusada.

  A troca é esta: as colunas passam a sair do TIPO. `ColunaDoGrupo` é
  `keyof GrupoTributario` menos as três que não se editam, e `CAMPOS_DO_GRUPO`
  é um `Record` TOTAL sobre elas. Uma coluna nova em `GrupoTributario` deixa o
  literal incompleto, e o build QUEBRA aqui — antes de ir para a loja — em vez
  de gravar nulo em produção.
*/
type ColunaDoGrupo = Exclude<keyof GrupoTributario, 'id' | 'active' | 'usage'>;

/**
 * Para cada coluna: a chave que o servidor lê no corpo e o valor com que o
 * formulário nasce. Os nomes do corpo são os de `upsertTaxGroup`.
 */
const CAMPOS_DO_GRUPO: Record<ColunaDoGrupo, { corpo: string; vazio: string }> = {
  code: { corpo: 'code', vazio: '' },
  name: { corpo: 'name', vazio: '' },
  regime: { corpo: 'regime', vazio: 'simples' },
  ncm: { corpo: 'ncm', vazio: '' },
  cest: { corpo: 'cest', vazio: '' },
  cfop_internal: { corpo: 'cfopInternal', vazio: '' },
  cfop_external: { corpo: 'cfopExternal', vazio: '' },
  origin: { corpo: 'origin', vazio: '' },
  cst_icms: { corpo: 'cstIcms', vazio: '' },
  csosn: { corpo: 'csosn', vazio: '' },
  p_cred_sn: { corpo: 'pCredSn', vazio: '' },
  cst_pis: { corpo: 'cstPis', vazio: '' },
  cst_cofins: { corpo: 'cstCofins', vazio: '' },
  cst_ipi: { corpo: 'cstIpi', vazio: '' },
  ipi_rate_code: { corpo: 'ipiRateCode', vazio: '' },
  // O ICMS do regime normal e o benefício fiscal (GAP-PRD-021).
  icms_rate_code: { corpo: 'icmsRateCode', vazio: '' },
  p_red_bc: { corpo: 'pRedBc', vazio: '' },
  fcp_rate_code: { corpo: 'fcpRateCode', vazio: '' },
  c_benef: { corpo: 'cBenef', vazio: '' },
};

const COLUNAS_DO_GRUPO = Object.keys(CAMPOS_DO_GRUPO) as ColunaDoGrupo[];

/** O formulário: uma casa por coluna gravável, mais o id da edição. */
type FormularioDoGrupo = Record<ColunaDoGrupo, string> & { id: string };

function grupoVazio(): FormularioDoGrupo {
  const colunas = {} as Record<ColunaDoGrupo, string>;
  for (const coluna of COLUNAS_DO_GRUPO) colunas[coluna] = CAMPOS_DO_GRUPO[coluna].vazio;
  return { ...colunas, id: '' };
}

/** O grupo da lista, carregado inteiro — é isto que o Salvar vai reescrever. */
function grupoNoFormulario(g: GrupoTributario): FormularioDoGrupo {
  const colunas = {} as Record<ColunaDoGrupo, string>;
  for (const coluna of COLUNAS_DO_GRUPO) colunas[coluna] = String(g[coluna] ?? '');
  return { ...colunas, id: g.id };
}

/**
 * O corpo do POST, montado da MESMA relação que o formulário carrega.
 *
 * `id` ausente é cadastro novo; presente é edição. Mandar string vazia faria o
 * servidor procurar um grupo de id "" e responder 404.
 */
function corpoDoGrupo(form: FormularioDoGrupo): Record<string, unknown> {
  const corpo: Record<string, unknown> = { id: form.id || undefined };
  for (const coluna of COLUNAS_DO_GRUPO) corpo[CAMPOS_DO_GRUPO[coluna].corpo] = form[coluna];
  return corpo;
}

function PainelGruposTributarios({
  grupos,
  aliquotas,
  podeEditar,
  onSalvar,
  onExcluir,
}: {
  grupos: GrupoTributario[];
  aliquotas: Aliquota[];
  podeEditar: boolean;
  onSalvar: (g: Record<string, unknown>) => void;
  onExcluir: (id: string) => void;
}) {
  /*
    O FORMULÁRIO CARREGA TUDO O QUE O SALVAR ESCREVE — a relação sai do TIPO,
    e não de uma lista escrita à mão. Ver `CAMPOS_DO_GRUPO`, logo acima, para o
    defeito que isso encerra.
  */
  const [form, setForm] = useState<FormularioDoGrupo>(grupoVazio);
  const editando = Boolean(form.id);

  return (
    <div className="flex flex-col gap-5">
      {podeEditar && (
        <Card title={editando ? `Editando ${form.code}` : 'Novo grupo tributário'}>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Código" required>
              {(p) => (
                <Input
                  {...p}
                  value={form.code}
                  onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
                  placeholder="PADRAO"
                  disabled={editando}
                />
              )}
            </Field>
            <Field label="Nome" required>
              {(p) => (
                <Input
                  {...p}
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="Padrão"
                />
              )}
            </Field>
            <Field label="Enquadramento">
              {(p) => (
                <select
                  {...p}
                  value={form.regime}
                  onChange={(e) => setForm({ ...form, regime: e.target.value })}
                  className="h-10 px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)] bg-[var(--gs-surface)] text-[var(--gs-text)]"
                >
                  {REGIMES.map((r) => (
                    <option key={r.valor} value={r.valor}>
                      {r.rotulo}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field label="NCM">
              {(p) => (
                <Input
                  {...p}
                  value={form.ncm}
                  onChange={(e) => setForm({ ...form, ncm: e.target.value })}
                  placeholder="23061000"
                />
              )}
            </Field>
            <Field label="CEST">
              {(p) => (
                <Input
                  {...p}
                  value={form.cest}
                  onChange={(e) => setForm({ ...form, cest: e.target.value })}
                  placeholder="2806200"
                />
              )}
            </Field>
            <Field label="CSOSN" hint="Simples e MEI — o 500 é a mercadoria de ST já recolhida">
              {(p) => (
                <select
                  {...p}
                  value={form.csosn}
                  onChange={(e) => setForm({ ...form, csosn: e.target.value })}
                  className="h-10 px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)] bg-[var(--gs-surface)] text-[var(--gs-text)]"
                >
                  {comValorAtual(CSOSN_DO_LEIAUTE, form.csosn).map((c) => (
                    <option key={c.valor} value={c.valor}>
                      {c.rotulo}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            {/*
              CFOP, ORIGEM E CST DE ICMS passam a APARECER — os quatro campos
              que o salvar reescrevia sem que a tela os conhecesse. Sem eles,
              corrigir um nome deixava o grupo sem CFOP, e a emissão recusava
              TODO produto que dependia dele.

              O CFOP é dois porque a UF do destinatário decide qual vale
              (`TributacaoDoItem`): interno para venda dentro do estado,
              interestadual para fora. Um campo só faria a nota de fora sair com
              o CFOP de dentro.
            */}
            <Field label="CFOP interno" hint="Venda dentro do estado — 5102, 5405…">
              {(p) => (
                <Input
                  {...p}
                  value={form.cfop_internal}
                  onChange={(e) => setForm({ ...form, cfop_internal: e.target.value })}
                  placeholder="5102"
                />
              )}
            </Field>
            <Field label="CFOP interestadual" hint="Venda para outro estado — 6102, 6404…">
              {(p) => (
                <Input
                  {...p}
                  value={form.cfop_external}
                  onChange={(e) => setForm({ ...form, cfop_external: e.target.value })}
                  placeholder="6102"
                />
              )}
            </Field>
            <Field
              label="Origem da mercadoria"
              hint="O produto pode ter a própria; esta vale para o grupo"
            >
              {(p) => (
                <select
                  {...p}
                  value={form.origin}
                  onChange={(e) => setForm({ ...form, origin: e.target.value })}
                  className="h-10 px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)] bg-[var(--gs-surface)] text-[var(--gs-text)]"
                >
                  {ORIGENS_DA_MERCADORIA.map((o) => (
                    <option key={o.valor} value={o.valor}>
                      {o.rotulo}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field label="CST de ICMS" hint="Só no regime normal — no Simples vale o CSOSN">
              {(p) => (
                <select
                  {...p}
                  value={form.cst_icms}
                  onChange={(e) => {
                    const cst = e.target.value;
                    setForm({
                      ...form,
                      cst_icms: cst,
                      // O campo que o novo CST não lê é limpo: o servidor
                      // recusaria gravá-lo, e ninguém o leria na emissão.
                      icms_rate_code: CST_COM_ALIQUOTA.has(cst) ? form.icms_rate_code : '',
                      fcp_rate_code: CST_COM_ALIQUOTA.has(cst) ? form.fcp_rate_code : '',
                      p_red_bc: CST_COM_REDUCAO.has(cst) ? form.p_red_bc : '',
                    });
                  }}
                  className="h-10 px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)] bg-[var(--gs-surface)] text-[var(--gs-text)]"
                >
                  {comValorAtual(CST_ICMS_DO_LEIAUTE, form.cst_icms).map((c) => (
                    <option key={c.valor} value={c.valor}>
                      {c.rotulo}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            {/*
              O ICMS PRÓPRIO DO REGIME NORMAL (GAP-PRD-021): a alíquota vem do
              cadastro de Alíquotas (tipo ICMS), pelo código — o mesmo desenho do
              IPI. Só os CST 00, 20 e 90 a leem; nos outros o campo fica preso.
            */}
            <Field label="Alíquota de ICMS" hint="CST 00 e 20 exigem; no 90 é opcional">
              {(p) => (
                <select
                  {...p}
                  value={form.icms_rate_code}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      icms_rate_code: e.target.value,
                      fcp_rate_code: e.target.value ? form.fcp_rate_code : '',
                    })
                  }
                  disabled={!CST_COM_ALIQUOTA.has(form.cst_icms)}
                  className="h-10 px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)] bg-[var(--gs-surface)] text-[var(--gs-text)]"
                >
                  <option value="">—</option>
                  {aliquotas
                    .filter((a) => a.kind === 'icms' && a.active !== 0)
                    .map((a) => (
                      <option key={a.id} value={a.code}>
                        {a.code} · {a.name} · {a.percent}%
                      </option>
                    ))}
                </select>
              )}
            </Field>
            <Field label="Redução da base do ICMS (%)" hint="Obrigatória no CST 20; opcional no 90">
              {(p) => (
                <Input
                  {...p}
                  value={form.p_red_bc}
                  onChange={(e) => setForm({ ...form, p_red_bc: e.target.value })}
                  disabled={!CST_COM_REDUCAO.has(form.cst_icms)}
                  placeholder="41.18"
                  inputMode="decimal"
                />
              )}
            </Field>
            <Field label="Alíquota de FCP" hint="Fundo de combate à pobreza — soma-se ao ICMS">
              {(p) => (
                <select
                  {...p}
                  value={form.fcp_rate_code}
                  onChange={(e) => setForm({ ...form, fcp_rate_code: e.target.value })}
                  disabled={!form.icms_rate_code}
                  className="h-10 px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)] bg-[var(--gs-surface)] text-[var(--gs-text)]"
                >
                  <option value="">—</option>
                  {aliquotas
                    .filter((a) => a.kind === 'fcp' && a.active !== 0)
                    .map((a) => (
                      <option key={a.id} value={a.code}>
                        {a.code} · {a.name} · {a.percent}%
                      </option>
                    ))}
                </select>
              )}
            </Field>
            <Field
              label="Benefício fiscal (cBenef)"
              hint="8 ou 10 caracteres da tabela da SEFAZ — só quando a UF exige"
            >
              {(p) => (
                <Input
                  {...p}
                  value={form.c_benef}
                  onChange={(e) => setForm({ ...form, c_benef: e.target.value.toUpperCase() })}
                  placeholder="RS801001"
                />
              )}
            </Field>

            {/*
              O AVISO HONESTO SOBRE O ICMS (GAP-PRD-021) — o mesmo gesto do aviso do
              IPI: dizer aqui o que a emissão vai recusar, em vez de o balcão
              descobrir com o cliente esperando.
            */}
            {(ST_POR_FORA.has(form.csosn) || ST_POR_FORA.has(form.cst_icms)) && (
              <p
                role="note"
                className="sm:col-span-3 m-0 text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-warning)]"
              >
                Com {ST_POR_FORA.has(form.csosn) ? `CSOSN ${form.csosn}` : `CST ${form.cst_icms}`} a
                emissão vai RECUSAR os produtos deste grupo: é substituição tributária calculada por
                esta empresa, e o ICMS-ST é cobrado por fora — o total da nota passaria a divergir do
                que o cliente pagou. Se o fornecedor já recolheu a ST, use o CSOSN 500 ou o CST 60.
              </p>
            )}
            {ICMS_FORA_DO_VAREJO.has(form.cst_icms) && (
              <p
                role="note"
                className="sm:col-span-3 m-0 text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-warning)]"
              >
                Com CST {form.cst_icms} a emissão vai RECUSAR os produtos deste grupo: combustível e
                diferimento exigem valores que este cadastro não descreve.
              </p>
            )}
            {CST_ALIQUOTA_OBRIGATORIA.has(form.cst_icms) && !form.icms_rate_code && (
              <p
                role="note"
                className="sm:col-span-3 m-0 text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-warning)]"
              >
                O CST {form.cst_icms} destaca ICMS: escolha a alíquota de ICMS (cadastre-a em
                Alíquotas, tipo ICMS). Sem ela a emissão recusa os produtos deste grupo.
              </p>
            )}
            {form.cst_icms === '20' && !form.p_red_bc.trim() && (
              <p
                role="note"
                className="sm:col-span-3 m-0 text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-warning)]"
              >
                O CST 20 é com redução de base: informe o percentual que o contador passar.
              </p>
            )}
            {/*
              PIS, COFINS e pCredSN passam a APARECER — antes eram gravados como
              nulo a cada salvar por não estarem no formulário, e a emissão
              recusava depois, longe de quem apagou.
            */}
            <Field label="CST de PIS" hint="Obrigatório no layout da nota">
              {(p) => (
                <Input
                  {...p}
                  value={form.cst_pis}
                  onChange={(e) => setForm({ ...form, cst_pis: e.target.value })}
                  placeholder="49"
                />
              )}
            </Field>
            <Field label="CST de COFINS" hint="Obrigatório no layout da nota">
              {(p) => (
                <Input
                  {...p}
                  value={form.cst_cofins}
                  onChange={(e) => setForm({ ...form, cst_cofins: e.target.value })}
                  placeholder="49"
                />
              )}
            </Field>
            <Field
              label="pCredSN (%)"
              hint="Só para CSOSN 101 e 201 — o contador informa o percentual"
            >
              {(p) => (
                <Input
                  {...p}
                  value={form.p_cred_sn}
                  onChange={(e) => setForm({ ...form, p_cred_sn: e.target.value })}
                  placeholder="2.50"
                />
              )}
            </Field>
            {/*
              O IPI (GAP-V08): o XML levava vIPI 0,00 cravado e a alíquota de
              IPI cadastrável não tinha NENHUM leitor na emissão. Estes dois
              campos são o leitor.
            */}
            <Field label="CST de IPI" hint="Vazio: a nota sai sem IPI, como hoje">
              {(p) => (
                <select
                  {...p}
                  value={form.cst_ipi}
                  onChange={(e) => setForm({ ...form, cst_ipi: e.target.value })}
                  className="h-10 px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)] bg-[var(--gs-surface)] text-[var(--gs-text)]"
                >
                  {CST_IPI_SAIDA.map((c) => (
                    <option key={c.valor} value={c.valor}>
                      {c.rotulo}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field label="Alíquota de IPI" hint="Só os CST 50 e 99 usam alíquota">
              {(p) => (
                <select
                  {...p}
                  value={form.ipi_rate_code}
                  onChange={(e) => setForm({ ...form, ipi_rate_code: e.target.value })}
                  disabled={!CST_IPI_COM_VALOR.has(form.cst_ipi)}
                  className="h-10 px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)] bg-[var(--gs-surface)] text-[var(--gs-text)]"
                >
                  <option value="">—</option>
                  {aliquotas
                    .filter((a) => a.kind === 'ipi' && a.active !== 0)
                    .map((a) => (
                      <option key={a.id} value={a.code}>
                        {a.code} · {a.name} · {a.percent}%
                      </option>
                    ))}
                </select>
              )}
            </Field>
          </div>

          {/*
            O AVISO HONESTO SOBRE O DESTAQUE (GAP-V08).

            Este sistema resolve o IPI a partir do grupo e o declara no XML —
            mas não sabe COBRAR imposto por fora: o total da nota sai do que o
            cliente pagou, e somar o IPI a ele faria vNF divergir dos
            pagamentos. Em vez de emitir uma nota que a SEFAZ rejeitaria, a
            emissão recusa antes de reservar o número. Dizer isso aqui é o que
            impede alguém de descobrir com o cliente no balcão.
          */}
          {CST_IPI_COM_VALOR.has(form.cst_ipi) && (
            <p className="mt-3 mb-0 text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-warning)]">
              Com CST {form.cst_ipi} a emissão vai RECUSAR os produtos deste grupo: o IPI
              destacado é cobrado por fora, e o total da nota passaria a divergir do que o cliente
              pagou. Use um CST sem valor (51 a 55) enquanto a cobrança por fora não existir.
            </p>
          )}

          <div className="flex gap-2 mt-4">
            <Button
              onClick={() => {
                // O corpo sai do MESMO mapa que carregou o formulário — não de
                // um objeto espalhado aqui, que é onde os quatro campos se
                // perdiam.
                onSalvar(corpoDoGrupo(form));
                setForm(grupoVazio());
              }}
              disabled={!form.code.trim() || !form.name.trim()}
            >
              Salvar
            </Button>
            {editando && (
              <Button variant="ghost" onClick={() => setForm(grupoVazio())}>
                Cancelar
              </Button>
            )}
          </div>
        </Card>
      )}

      <Card padded={false}>
        {grupos.length === 0 ? (
          <EmptyState
            title="Nenhum grupo tributário ainda"
            description="O grupo reúne a regra fiscal que vários produtos compartilham — mudar a regra alcança todos de uma vez."
          />
        ) : (
          <DataTable
            columns={[
              { header: 'Código', render: (g: GrupoTributario) => <strong>{g.code}</strong> },
              { header: 'Grupo tributário', render: (g: GrupoTributario) => g.name },
              {
                header: 'Enquadramento',
                render: (g: GrupoTributario) =>
                  REGIMES.find((r) => r.valor === g.regime)?.rotulo ?? g.regime,
              },
              { header: 'NCM', render: (g: GrupoTributario) => g.ncm ?? '—' },
              {
                header: 'Produtos',
                align: 'right',
                render: (g: GrupoTributario) => (g.usage > 0 ? g.usage : '—'),
              },
              {
                header: '',
                render: (g: GrupoTributario) =>
                  podeEditar && (
                    <div className="flex gap-2 justify-end">
                      <Button
                        size="sm"
                        variant="ghost"
                        // O grupo INTEIRO entra no formulário, coluna por
                        // coluna, porque é ele inteiro que o Salvar reescreve.
                        // Carregar à mão era o que deixava campo para trás.
                        onClick={() => setForm(grupoNoFormulario(g))}
                      >
                        Editar
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => onExcluir(g.id)}>
                        Excluir
                      </Button>
                    </div>
                  ),
              },
            ]}
            rows={grupos}
            keyOf={(g) => g.id}
          />
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- alíquotas

function PainelAliquotas({
  aliquotas,
  podeEditar,
  onSalvar,
  onExcluir,
}: {
  aliquotas: Aliquota[];
  podeEditar: boolean;
  onSalvar: (a: Record<string, unknown>) => void;
  onExcluir: (id: string) => void;
}) {
  const vazio = { id: '', code: '', name: '', kind: 'pis', percent: '' };
  const [form, setForm] = useState(vazio);

  return (
    <div className="flex flex-col gap-5">
      {podeEditar && (
        <Card title={form.id ? `Editando ${form.code}` : 'Nova alíquota'}>
          <div className="grid gap-4 sm:grid-cols-5">
            <Field label="Código" required>
              {(p) => (
                <Input
                  {...p}
                  value={form.code}
                  onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
                  placeholder="ICMS18"
                />
              )}
            </Field>
            <Field label="Nome" required>
              {(p) => (
                <Input
                  {...p}
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="ICMS 18%"
                />
              )}
            </Field>
            <Field label="Tipo">
              {(p) => (
                <select
                  {...p}
                  value={form.kind}
                  onChange={(e) => setForm({ ...form, kind: e.target.value })}
                  className="h-10 px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)] bg-[var(--gs-surface)] text-[var(--gs-text)]"
                >
                  {TIPOS_ALIQUOTA.map((t) => (
                    <option key={t} value={t}>
                      {t.toUpperCase()}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field label="Percentual" required>
              {(p) => (
                <Input
                  {...p}
                  value={form.percent}
                  onChange={(e) => setForm({ ...form, percent: e.target.value })}
                  placeholder="18"
                  inputMode="decimal"
                />
              )}
            </Field>
            <div className="flex items-end gap-2">
              <Button
                onClick={() => {
                  onSalvar({
                    ...form,
                    id: form.id || undefined,
                    percent: Number(form.percent.replace(',', '.')) || 0,
                  });
                  setForm(vazio);
                }}
                disabled={!form.code.trim() || !form.name.trim()}
              >
                Salvar
              </Button>
            </div>
          </div>
        </Card>
      )}

      <Card padded={false}>
        {aliquotas.length === 0 ? (
          <EmptyState title="Nenhuma alíquota ainda" description="Vamos começar?" />
        ) : (
          <DataTable
            columns={[
              { header: 'Código', render: (a: Aliquota) => <strong>{a.code}</strong> },
              { header: 'Alíquota', render: (a: Aliquota) => a.name },
              { header: 'Tipo', render: (a: Aliquota) => a.kind.toUpperCase() },
              {
                header: 'Percentual',
                align: 'right',
                render: (a: Aliquota) => `${a.percent.toFixed(2)}%`,
              },
              {
                header: '',
                render: (a: Aliquota) =>
                  podeEditar && (
                    <div className="flex gap-2 justify-end">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          setForm({
                            id: a.id,
                            code: a.code,
                            name: a.name,
                            kind: a.kind,
                            percent: String(a.percent),
                          })
                        }
                      >
                        Editar
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => onExcluir(a.id)}>
                        Excluir
                      </Button>
                    </div>
                  ),
              },
            ]}
            rows={aliquotas}
            keyOf={(a) => a.id}
          />
        )}
      </Card>
    </div>
  );
}

// --------------------------------------------------------- tabelas de preço

function PainelTabelasDePreco({
  tabelas,
  podeEditar,
  podeFixar,
  onSalvar,
  onExcluir,
  onFixadosMudaram,
}: {
  tabelas: TabelaDePreco[];
  podeEditar: boolean;
  podeFixar: boolean;
  onSalvar: (t: { id?: string; name: string; percentOff: number; active?: boolean }) => void;
  onExcluir: (id: string) => void;
  onFixadosMudaram: () => void;
}) {
  const [form, setForm] = useState({ id: '', name: '', percentOff: '', active: true });
  /** Qual tabela está com o painel de preços fixados aberto. */
  const [fixandoId, setFixandoId] = useState<string | null>(null);
  const tabelaAberta = tabelas.find((t) => t.id === fixandoId) ?? null;

  return (
    <div className="flex flex-col gap-5">
      {podeEditar && (
        <Card title={form.id ? `Editando ${form.name}` : 'Nova tabela de preços'}>
          <div className="grid gap-4 sm:grid-cols-4">
            <Field label="Nome" required>
              {(p) => (
                <Input
                  {...p}
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="Atacado"
                />
              )}
            </Field>
            <Field label="Desconto sobre o preço de venda">
              {(p) => (
                <Input
                  {...p}
                  value={form.percentOff}
                  onChange={(e) => setForm({ ...form, percentOff: e.target.value })}
                  placeholder="5"
                  inputMode="decimal"
                />
              )}
            </Field>
            {/*
              A CAIXA "ATIVA" existe porque a ausência dela ERA um defeito.

              O formulário não mandava `active`, e o servidor trata ausente como
              1: editar o nome de uma tabela desativada a REATIVAVA em silêncio,
              e todos os clientes vinculados voltavam a ter desconto sem
              ninguém ter decidido isso. Enquanto a tabela não alterava preço
              nenhum era invisível; agora ela altera.

              Desmarcar aqui é a porta ao lado de excluir: as duas fazem a
              tabela parar de valer para quem está vinculado. O servidor recusa
              as duas com o mesmo 409, dizendo quantos clientes dependem dela —
              e a recusa aparece na faixa vermelha do topo desta tela.
            */}
            <label className="flex items-end gap-2 pb-2 cursor-pointer">
              <input
                type="checkbox"
                checked={form.active}
                onChange={(e) => setForm({ ...form, active: e.target.checked })}
              />
              <span className="text-[length:var(--gs-text-sm)]">Ativa</span>
            </label>
            <div className="flex items-end gap-2">
              <Button
                onClick={() => {
                  onSalvar({
                    id: form.id || undefined,
                    name: form.name,
                    percentOff: Number(form.percentOff.replace(',', '.')) || 0,
                    active: form.active,
                  });
                  setForm({ id: '', name: '', percentOff: '', active: true });
                }}
                disabled={!form.name.trim()}
              >
                Salvar
              </Button>
            </div>
          </div>
          <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] mt-3 mb-0">
            O percentual vale para a tabela inteira. Um produto pode ter preço fixado, e aí o
            preço fixado ganha — é assim que se negocia: desconto em tudo, menos naquele item
            combinado. O preço da tabela passa a ser o preço vigente do cliente vinculado: ele
            entra no balcão já com o desconto, sem ninguém digitar nada.
          </p>
        </Card>
      )}

      <Card padded={false}>
        {tabelas.length === 0 ? (
          <EmptyState
            title="Nenhuma tabela de preços ainda"
            description="Serve para atender atacado e cliente especial sem mexer no preço de cadastro."
          />
        ) : (
          <DataTable
            columns={[
              {
                header: 'Tabela',
                render: (t: TabelaDePreco) => (
                  <>
                    <strong>{t.name}</strong>
                    {t.active !== 1 && (
                      <span className="ml-2">
                        <Badge tone="neutral">desativada</Badge>
                      </span>
                    )}
                  </>
                ),
              },
              {
                header: 'Desconto',
                align: 'right',
                render: (t: TabelaDePreco) => `${t.percent_off.toFixed(2)}%`,
              },
              {
                /*
                  Era um número morto: dizia QUANTOS preços fixados a tabela
                  tem sem oferecer caminho nenhum para vê-los ou criar um. A
                  promessa do texto acima ("um produto pode ter preço fixado,
                  e aí o preço fixado ganha") existia no servidor desde a
                  rodada 26 e não tinha porta na tela. O botão da última
                  coluna é a porta.
                */
                header: 'Preços fixados',
                align: 'right',
                render: (t: TabelaDePreco) => (t.items > 0 ? t.items : '—'),
              },
              {
                /*
                  QUANTOS CLIENTES COMPRAM POR ELA — a razão de esta rodada
                  existir.

                  Esta tela prometia a regra de negociação de atacado e não
                  mostrava efeito nenhum: dava para criar dez tabelas e nunca
                  saber se alguma valia para alguém. Sem este número, "Excluir"
                  é um botão que ou apaga uma tabela que ninguém usa ou é
                  recusado com um 409 que o gerente não esperava.

                  Zero aparece como travessão, e não como "0": a tabela recém
                  criada ainda não foi ligada a ninguém, e um zero em toda linha
                  vira ruído. O que interessa ler de relance é QUAIS têm gente.
                */
                header: 'Clientes',
                align: 'right',
                render: (t: TabelaDePreco) =>
                  t.customers > 0 ? <Badge tone="info">{t.customers}</Badge> : '—',
              },
              {
                header: '',
                render: (t: TabelaDePreco) => (
                  <div className="flex gap-2 justify-end">
                    {/*
                      Visível para o escritório inteiro, ao contrário de
                      Editar/Excluir: LER o combinado (`GET .../items`) é
                      aberto a quem já lê o percentual da tabela na mesma
                      resposta. Quem não pode fixar abre o painel e vê a
                      lista, sem formulário.
                    */}
                    <Button
                      size="sm"
                      variant={fixandoId === t.id ? 'secondary' : 'ghost'}
                      onClick={() => setFixandoId(fixandoId === t.id ? null : t.id)}
                    >
                      {fixandoId === t.id ? 'Fechar fixados' : 'Preços fixados'}
                    </Button>
                    {podeEditar && (
                      <>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            setForm({
                              id: t.id,
                              name: t.name,
                              percentOff: String(t.percent_off),
                              active: t.active === 1,
                            })
                          }
                        >
                          Editar
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => onExcluir(t.id)}>
                          Excluir
                        </Button>
                      </>
                    )}
                  </div>
                ),
              },
            ]}
            rows={tabelas}
            keyOf={(t) => t.id}
          />
        )}
      </Card>

      {tabelaAberta && (
        <PrecosFixadosDaTabela
          key={tabelaAberta.id}
          tabela={tabelaAberta}
          podeFixar={podeFixar}
          onMudou={onFixadosMudaram}
        />
      )}
    </div>
  );
}

/**
 * OS PREÇOS FIXADOS DE UMA TABELA — a metade que faltava da promessa.
 *
 * O texto da aba promete desde a rodada 26: "um produto pode ter preço fixado,
 * e aí o preço fixado ganha". O servidor sempre cumpriu (`priceInTable` decide
 * na venda), mas as rotas `PUT/DELETE .../items/:productId` tinham ZERO
 * chamadores — não existia como FIXAR um preço pela tela, e o combinado com o
 * cliente de atacado só apareceria no cupom, tarde demais para conferir.
 *
 * O `key={tabela.id}` no chamador zera o estado ao trocar de tabela: sem ele,
 * o produto escolhido para fixar na tabela A sobreviveria à troca para a B e o
 * clique seguinte fixaria o preço na tabela ERRADA.
 *
 * O preço digitado passa por `parseReaisToCents` — o MESMO interpretador do
 * PDV e da alteração rápida. O servidor recusa zero e negativo com 400 nomeado
 * (fixado em R$ 0,00 seria produto de graça no cupom), e a recusa aparece
 * aqui, com a frase dele.
 */
function PrecosFixadosDaTabela({
  tabela,
  podeFixar,
  onMudou,
}: {
  tabela: TabelaDePreco;
  podeFixar: boolean;
  onMudou: () => void;
}) {
  // Nulo enquanto não carregou: "não pude ler" e "nenhum preço fixado" são
  // fatos diferentes e não podem exibir a mesma coisa.
  const [itens, setItens] = useState<PrecoFixado[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  const [termo, setTermo] = useState('');
  const [resultados, setResultados] = useState<Product[] | null>(null);
  const [escolhido, setEscolhido] = useState<Product | null>(null);
  const [preco, setPreco] = useState('');
  const [ocupado, setOcupado] = useState(false);

  useEffect(() => {
    let vivo = true;
    coreApi
      .listPriceTableItems(tabela.id)
      .then((r) => {
        if (vivo) setItens(r.items);
      })
      .catch((err) => {
        if (vivo)
          setErro(
            err instanceof ApiRequestError ? err.message : 'Falha ao carregar os preços fixados.',
          );
      });
    return () => {
      vivo = false;
    };
  }, [tabela.id]);

  const buscar = async () => {
    if (!termo.trim()) return;
    setErro(null);
    try {
      setResultados(await coreApi.searchProducts(termo.trim()));
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao buscar produtos.');
    }
  };

  const centavos = parseReaisToCents(preco);

  const fixar = async () => {
    if (!escolhido || centavos === null) return;
    setOcupado(true);
    setErro(null);
    try {
      // A lista volta na resposta do PUT: a tela re-renderiza o que o servidor
      // AFIRMA que ficou gravado, não o que ela acha que aconteceu.
      const r = await coreApi.setPriceTableItem(tabela.id, escolhido.id, centavos);
      setItens(r.items);
      setEscolhido(null);
      setResultados(null);
      setTermo('');
      setPreco('');
      onMudou();
    } catch (err) {
      // A frase do servidor, não "não foi possível salvar": é ele quem sabe
      // dizer que zero é produto de graça, e a pessoa precisa ler isso.
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao fixar o preço.');
    } finally {
      setOcupado(false);
    }
  };

  const remover = async (productId: string) => {
    setErro(null);
    try {
      const r = await coreApi.removePriceTableItem(tabela.id, productId);
      setItens(r.items);
      onMudou();
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao remover o preço fixado.');
    }
  };

  return (
    <Card
      title={`Preços fixados — ${tabela.name}`}
      subtitle={`O item fixado ganha do desconto de ${tabela.percent_off.toFixed(2)}% da tabela. Remover o fixado devolve o item ao percentual.`}
    >
      {erro && (
        <div
          role="alert"
          className="mb-4 px-3 py-2 rounded-[var(--gs-radius)] bg-[var(--gs-danger-bg)] text-[var(--gs-danger)] text-[length:var(--gs-text-sm)]"
        >
          {erro}
        </div>
      )}

      {podeFixar && (
        <div className="mb-5 flex flex-col gap-3">
          {!escolhido && (
            <>
              <div className="flex flex-wrap items-end gap-2">
                <div className="flex-1 min-w-[240px] max-w-md">
                  <Field label="Fixar preço de um produto" hint="Busque por nome ou código">
                    {(p) => (
                      <Input
                        {...p}
                        value={termo}
                        onChange={(e) => setTermo(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            void buscar();
                          }
                        }}
                        placeholder="Capacete, 7891234…"
                      />
                    )}
                  </Field>
                </div>
                <Button variant="secondary" onClick={() => void buscar()} disabled={!termo.trim()}>
                  Buscar produto
                </Button>
              </div>

              {resultados && resultados.length === 0 && (
                <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] m-0">
                  Nenhum produto encontrado com “{termo}”.
                </p>
              )}
              {resultados && resultados.length > 0 && (
                <ul className="m-0 p-0 list-none flex flex-col gap-1 max-w-xl">
                  {resultados.slice(0, 8).map((prod) => (
                    <li key={prod.id}>
                      <button
                        type="button"
                        onClick={() => {
                          setEscolhido(prod);
                          setResultados(null);
                        }}
                        className="w-full text-left px-3 py-2 rounded-[var(--gs-radius-sm)]
                          border border-[var(--gs-border)] bg-[var(--gs-surface)]
                          hover:bg-[var(--gs-surface-hover)] cursor-pointer
                          text-[length:var(--gs-text-sm)] text-[var(--gs-text)]"
                      >
                        <strong>{prod.name}</strong>
                        <span className="text-[var(--gs-muted)]">
                          {' '}
                          · {prod.internal_code} · cadastro {formatCents(prod.price_cents)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}

          {escolhido && (
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex flex-col gap-1">
                <span className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-text-soft)]">
                  Produto
                </span>
                <span className="text-[length:var(--gs-text-base)]">
                  <strong>{escolhido.name}</strong>{' '}
                  <span className="text-[var(--gs-muted)]">
                    · cadastro {formatCents(escolhido.price_cents)}
                  </span>
                </span>
              </div>
              <div className="w-40">
                <Field label="Preço fixado" required hint="Em reais. Zero não vale — seria de graça.">
                  {(p) => (
                    <Input
                      {...p}
                      value={preco}
                      onChange={(e) => setPreco(e.target.value)}
                      inputMode="decimal"
                      placeholder="120,00"
                    />
                  )}
                </Field>
              </div>
              <Button
                onClick={() => void fixar()}
                loading={ocupado}
                disabled={centavos === null || centavos <= 0}
              >
                Fixar preço
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setEscolhido(null);
                  setPreco('');
                }}
              >
                Trocar produto
              </Button>
            </div>
          )}
        </div>
      )}

      {itens === null && !erro && (
        <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">Carregando…</p>
      )}

      {itens && itens.length === 0 && (
        <EmptyState
          title="Nenhum preço fixado nesta tabela"
          description="Todos os produtos seguem o percentual. Fixe um preço quando a negociação combinar um valor fechado para um item."
        />
      )}

      {itens && itens.length > 0 && (
        <DataTable
          rows={itens}
          keyOf={(i) => i.product_id}
          columns={[
            {
              header: 'Produto',
              render: (i: PrecoFixado) => (
                <div className="flex flex-col">
                  <strong>{i.product_name}</strong>
                  <span className="font-mono text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
                    {i.internal_code}
                    {i.barcode ? ` · ${i.barcode}` : ''}
                  </span>
                </div>
              ),
            },
            {
              // O "de/por" do combinado: sem o preço de cadastro ao lado, um
              // fixado de R$ 120,00 não diz se foi desconto ou aumento.
              header: 'Preço de cadastro',
              align: 'right',
              render: (i: PrecoFixado) => formatCents(i.base_price_cents),
            },
            {
              header: 'Preço fixado',
              align: 'right',
              render: (i: PrecoFixado) => (
                <strong className="text-[var(--gs-purple-900)]">
                  {formatCents(i.price_cents)}
                </strong>
              ),
            },
            {
              header: '',
              render: (i: PrecoFixado) =>
                podeFixar && (
                  <div className="flex justify-end">
                    <Button size="sm" variant="ghost" onClick={() => void remover(i.product_id)}>
                      Remover
                    </Button>
                  </div>
                ),
            },
          ]}
        />
      )}
    </Card>
  );
}
