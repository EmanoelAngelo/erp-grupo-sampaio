/**
 * Balança — o arquivo de produtos que o equipamento importa, e a etiqueta que
 * ela imprime e o PDV lê.
 *
 * Balança de varejo não conversa com o ERP: ela lê um arquivo de texto com a
 * lista de produtos pesáveis. Esta tela monta e baixa esse arquivo.
 *
 * ## O que esta tela diz sobre si mesma
 *
 * O layout de Toledo, Urano e Filizola NÃO foi conferido contra equipamento
 * real, e a tela avisa isso onde a pessoa vai clicar — não numa nota de rodapé.
 * Um arquivo que a balança recusa sem explicar faz o lojista culpar o sistema;
 * é mais honesto (e mais barato) declarar a incerteza antes.
 *
 * O que ficou de FORA do arquivo aparece com o motivo escrito. Um arquivo com
 * 4 linhas quando se esperava 40 precisa se explicar antes do download, não
 * depois.
 *
 * ## A etiqueta da balança no PDV (D-pdv-teclado-16, a tela)
 *
 * O DEFEITO: o servidor já sabia ler a etiqueta que a balança imprime (EAN-13
 * com prefixo 21–29, PLU e peso ou preço embutidos), e a rota para declarar o
 * formato existia — mas nenhuma tela a chamava. Sem declaração a leitura fica
 * desligada, e a etiqueta bipada no caixa não acha produto nenhum: o lojista
 * conclui que "a balança não funciona com o sistema".
 *
 * O bloco "Etiqueta da balança no PDV" declara o formato com o exemplo do
 * código montado ao vivo (é o jeito de conferir contra a etiqueta que está na
 * mão), avisa o PLU que não cabe na etiqueta declarada, e mostra o erro do
 * servidor ali mesmo — o prefixo já ocupado por um código cadastrado, por
 * exemplo. Só quem tem `products.manage` vê os controles; o resto da gestão vê
 * o que está declarado.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppShell } from '@/components/gs/AppShell';
import { Badge, Button, Card, EmptyState, Field, PageHeader } from '@/components/gs/ui';
import { formatCents } from '@/components/gs/format';
import { useCan } from '@/hooks/useCan';
import { ApiRequestError } from '@/lib/api/client';
import {
  coreApi,
  type ScaleFormatOption,
  type ScaleLabelConfig,
  type WeighableProduct,
} from '@/lib/api/core';

const ROTULO = 'text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-text-soft)]';
const TH = 'py-2.5 px-4 font-semibold';
const TD = 'py-3 px-4';
const SELECT = `h-10 px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)]
  bg-[var(--gs-surface)] text-[var(--gs-text)] text-[length:var(--gs-text-base)]`;

interface Resultado {
  filename: string;
  content: string;
  lineCount: number;
  confirmado: boolean;
  skipped: { productId: string; name: string; reason: string }[];
}

// ------------------------------------------------ etiqueta da balança no PDV

/**
 * De 21 a 29 — e só. O 20 é o dos códigos internos que o sistema gera para
 * produto sem EAN; oferecê-lo seria oferecer o erro que o servidor recusa.
 */
const PREFIXOS_DA_BALANCA = ['21', '22', '23', '24', '25', '26', '27', '28', '29'];

/** O que o formulário mostra enquanto nada foi declarado: o formato mais comum. */
const ETIQUETA_PADRAO: ScaleLabelConfig = { prefixo: '21', digitosDoPlu: 5, valorEmbutido: 'peso' };

/** Verificador GTIN: módulo 10, pesos 1 e 3 a partir da esquerda dos 12 dígitos. */
function verificadorGtin(doze: string): number {
  let soma = 0;
  for (let i = 0; i < doze.length; i += 1) soma += Number(doze[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - (soma % 10)) % 10;
}

/**
 * O código que a balança imprimiria para o PLU 123 com 0,352 kg (ou R$ 19,90),
 * montado pela declaração — prefixo, PLU, valor até o 12º dígito, verificador.
 * É a mesma conta de `lerEtiquetaDaBalanca` no servidor, ao contrário.
 */
function exemploDaEtiqueta(c: ScaleLabelConfig) {
  const plu = '123'.padStart(c.digitosDoPlu, '0');
  const casasDoValor = 12 - c.prefixo.length - c.digitosDoPlu;
  const valor = (c.valorEmbutido === 'peso' ? '352' : '1990').padStart(casasDoValor, '0');
  const doze = `${c.prefixo}${plu}${valor}`;
  const verificador = String(verificadorGtin(doze));
  return {
    codigo: `${doze}${verificador}`,
    partes: [
      { rotulo: 'prefixo', digitos: c.prefixo },
      { rotulo: 'PLU', digitos: plu },
      { rotulo: c.valorEmbutido === 'peso' ? 'peso em gramas' : 'preço em centavos', digitos: valor },
      { rotulo: 'verificador', digitos: verificador },
    ],
    /*
      A frase da etiqueta de PREÇO não promete o centavo (revisão).

      O DEFEITO: dizia "cobra R$ 19,90". O PDV não cobra o total impresso: ele
      lança total ÷ preço do quilo arredondado ao GRAMA e cobra quantidade ×
      preço — a R$ 49,90/kg, 0,399 kg dá R$ 19,91 (`recusaDaEtiquetaDaBalanca`
      aceita essa diferença de arredondamento). Quem conferisse o cupom contra o
      exemplo acharia o sistema errado.
    */
    leitura:
      c.valorEmbutido === 'peso'
        ? 'o PDV acha o produto de PLU 123 e lança 0,352 kg'
        : 'o PDV acha o produto de PLU 123 e lança o peso que R$ 19,90 compra pelo preço do quilo '
          + '(arredondado ao grama, o total cobrado pode diferir em alguns centavos)',
  };
}

function descreverEtiqueta(c: ScaleLabelConfig): string {
  const valor = c.valorEmbutido === 'peso' ? 'o peso em gramas' : 'o preço total em centavos';
  return `prefixo ${c.prefixo}, PLU de ${c.digitosDoPlu} dígitos e ${valor}`;
}

/**
 * Os produtos pesáveis que a etiqueta declarada NÃO acha: o servidor casa o PLU
 * sem os zeros à esquerda, então um PLU com mais dígitos significativos do que
 * cabem na etiqueta (ou com letra, ou só zeros) nunca é encontrado. Sem PLU
 * nenhum já é avisado na lista de produtos.
 */
function pluQueNaoCabe(produtos: WeighableProduct[], digitos: number): WeighableProduct[] {
  return produtos.filter((p) => {
    const plu = (p.pluCode ?? '').trim();
    if (!plu) return false;
    const semZeros = plu.replace(/^0+/, '');
    return !/^\d+$/.test(plu) || semZeros === '' || semZeros.length > digitos;
  });
}

function mensagemDe(e: unknown, padrao: string): string {
  return e instanceof ApiRequestError ? e.message : padrao;
}

function EtiquetaDaBalancaNoPdv({ produtos }: { produtos: WeighableProduct[] | null }) {
  const podeMudar = useCan('products.manage');
  const [estado, setEstado] = useState<'carregando' | 'pronto' | 'falhou'>('carregando');
  const [salva, setSalva] = useState<ScaleLabelConfig | null>(null);
  const [form, setForm] = useState<ScaleLabelConfig>(ETIQUETA_PADRAO);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [gravando, setGravando] = useState<'salvar' | 'desligar' | null>(null);

  const carregar = useCallback(async () => {
    setEstado('carregando');
    setErro(null);
    try {
      const c = await coreApi.scaleLabelConfig();
      setSalva(c);
      setForm(c ?? ETIQUETA_PADRAO);
      setEstado('pronto');
    } catch (e) {
      // Sem saber o que está declarado, não há "ligada" nem "desligada" para
      // mostrar — e o botão de desligar não teria o que desligar.
      setErro(mensagemDe(e, 'Não foi possível ler o formato da etiqueta da balança. Tente de novo.'));
      setEstado('falhou');
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  async function gravar(corpo: ScaleLabelConfig | null) {
    setGravando(corpo ? 'salvar' : 'desligar');
    setErro(null);
    setAviso(null);
    try {
      const c = await coreApi.saveScaleLabelConfig(corpo);
      setSalva(c);
      if (c) setForm(c);
      setAviso(
        c
          ? `Formato salvo: ${descreverEtiqueta(c)}. O PDV já lê essa etiqueta.`
          : 'Leitura desligada. O PDV volta a buscar o código da etiqueta como um código de barras comum.',
      );
    } catch (e) {
      setErro(
        mensagemDe(e, 'Não foi possível gravar o formato da etiqueta. Confira a conexão e tente de novo.'),
      );
    } finally {
      setGravando(null);
    }
  }

  function mudar(parte: Partial<ScaleLabelConfig>) {
    setForm((f) => ({ ...f, ...parte }));
    setAviso(null);
    // O DEFEITO (revisão): o erro do último Salvar ficava na tela depois da troca
    // — "já começa com 21" em vermelho com o 22 escolhido. O erro fala da
    // escolha que foi recusada; mudou a escolha, ele sai. (O erro de LEITURA
    // não passa por aqui: no estado "falhou" não há seletor.)
    setErro(null);
  }

  const mudou =
    !salva
    || salva.prefixo !== form.prefixo
    || salva.digitosDoPlu !== form.digitosDoPlu
    || salva.valorEmbutido !== form.valorEmbutido;
  // Quem declara vê o exemplo do que está escolhendo; quem só consulta, o do declarado.
  const vista = podeMudar ? form : salva;
  const exemplo = vista ? exemploDaEtiqueta(vista) : null;
  const naoCabem = vista ? pluQueNaoCabe(produtos ?? [], vista.digitosDoPlu) : [];

  return (
    <div role="region" aria-label="Etiqueta da balança no PDV" className="mb-5">
      <Card
        title="Etiqueta da balança no PDV"
        subtitle="A etiqueta que a balança imprime no pacote: o PDV acha o produto pelo PLU e lança o peso (ou o preço) que vem no código. Declare aqui o mesmo formato configurado na balança."
        actions={
          estado === 'pronto' ? (
            salva ? <Badge tone="success">Leitura ligada</Badge> : <Badge>Leitura desligada</Badge>
          ) : undefined
        }
      >
        {erro && (
          <div
            role="alert"
            className="mb-4 px-4 py-3 rounded-[var(--gs-radius)] bg-[var(--gs-danger-bg)] text-[var(--gs-danger)] text-[length:var(--gs-text-sm)]"
          >
            {erro}
          </div>
        )}
        {aviso && (
          <div
            role="status"
            className="mb-4 px-4 py-3 rounded-[var(--gs-radius)] bg-[var(--gs-success-bg)] text-[var(--gs-success)] text-[length:var(--gs-text-sm)]"
          >
            {aviso}
          </div>
        )}

        {estado === 'carregando' && <p className="m-0 text-[var(--gs-text-soft)]">Carregando…</p>}

        {estado === 'falhou' && (
          <Button variant="secondary" onClick={() => void carregar()}>
            Tentar de novo
          </Button>
        )}

        {estado === 'pronto' && (
          <>
            {podeMudar ? (
              <div className="grid gap-4 sm:grid-cols-3 max-w-3xl">
                <Field
                  label="Prefixo da etiqueta"
                  hint="De 21 a 29. O 20 é dos códigos internos que o sistema gera."
                >
                  {(p) => (
                    <select
                      {...p}
                      value={form.prefixo}
                      onChange={(e) => mudar({ prefixo: e.target.value })}
                      className={SELECT}
                    >
                      {PREFIXOS_DA_BALANCA.map((x) => (
                        <option key={x} value={x}>
                          {x}
                        </option>
                      ))}
                    </select>
                  )}
                </Field>
                <Field
                  label="Dígitos do PLU"
                  hint={`Com PLU de ${form.digitosDoPlu}, o valor ocupa ${12 - form.prefixo.length - form.digitosDoPlu} dígitos.`}
                >
                  {(p) => (
                    <select
                      {...p}
                      value={String(form.digitosDoPlu)}
                      onChange={(e) => mudar({ digitosDoPlu: e.target.value === '4' ? 4 : 5 })}
                      className={SELECT}
                    >
                      <option value="4">4 dígitos</option>
                      <option value="5">5 dígitos</option>
                    </select>
                  )}
                </Field>
                <Field label="Valor embutido" hint="O que a balança põe depois do PLU.">
                  {(p) => (
                    <select
                      {...p}
                      value={form.valorEmbutido}
                      onChange={(e) =>
                        mudar({ valorEmbutido: e.target.value === 'preco' ? 'preco' : 'peso' })
                      }
                      className={SELECT}
                    >
                      <option value="peso">Peso (gramas)</option>
                      <option value="preco">Preço total (centavos)</option>
                    </select>
                  )}
                </Field>
              </div>
            ) : (
              <p className="m-0 text-[length:var(--gs-text-sm)]">
                {salva
                  ? `Declarado: ${descreverEtiqueta(salva)}.`
                  : 'Nenhum formato declarado: o PDV não lê a etiqueta da balança, e o código dela é buscado como um código de barras comum.'}{' '}
                <span className="text-[var(--gs-muted)]">
                  Só quem cadastra produtos muda este formato.
                </span>
              </p>
            )}

            {exemplo && (
              <div className="mt-4 px-4 py-3 rounded-[var(--gs-radius)] bg-[var(--gs-surface-hover)]">
                <p className={`${ROTULO} m-0 mb-1`}>Exemplo do código montado</p>
                <p className="m-0 font-mono text-[length:var(--gs-text-lg)] tracking-wider">
                  {exemplo.codigo}
                </p>
                <ul className="m-0 mt-1 p-0 list-none flex flex-wrap gap-x-4 gap-y-1 text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
                  {exemplo.partes.map((parte) => (
                    <li key={parte.rotulo}>
                      <span className="font-mono text-[var(--gs-text)]">{parte.digitos}</span>{' '}
                      {parte.rotulo}
                    </li>
                  ))}
                </ul>
                <p className="m-0 mt-2 text-[length:var(--gs-text-sm)]">
                  Lendo este código, {exemplo.leitura}.
                </p>
              </div>
            )}

            {vista && naoCabem.length > 0 && (
              <div className="mt-3 px-4 py-3 rounded-[var(--gs-radius)] bg-[var(--gs-warning-bg)] text-[length:var(--gs-text-sm)]">
                <strong>
                  {naoCabem.length} produto(s) com PLU que não cabe na etiqueta de {vista.digitosDoPlu}{' '}
                  dígitos:
                </strong>{' '}
                {naoCabem
                  .slice(0, 5)
                  .map((p) => `${p.name} (PLU ${p.pluCode})`)
                  .join(', ')}
                {naoCabem.length > 5 ? ' e outros' : ''}. A etiqueta deles não será achada no PDV.{' '}
                {vista.digitosDoPlu === 4
                  ? 'Troque o PLU no cadastro e na balança, ou declare PLU de 5 dígitos.'
                  : 'Troque o PLU no cadastro e na balança por um número de até 5 dígitos.'}
              </div>
            )}

            {podeMudar && (
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <Button
                  onClick={() => void gravar(form)}
                  loading={gravando === 'salvar'}
                  disabled={gravando !== null || !mudou}
                >
                  Salvar
                </Button>
                {salva && (
                  <Button
                    variant="secondary"
                    onClick={() => void gravar(null)}
                    loading={gravando === 'desligar'}
                    disabled={gravando !== null}
                  >
                    Desligar leitura
                  </Button>
                )}
                {salva && mudou && (
                  <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                    Alteração ainda não salva.
                  </span>
                )}
              </div>
            )}
          </>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- a tela

export default function BalancaPage() {
  const [formatos, setFormatos] = useState<ScaleFormatOption[]>([]);
  const [formatId, setFormatId] = useState('csv_generico');
  const [produtos, setProdutos] = useState<WeighableProduct[] | null>(null);
  const [resultado, setResultado] = useState<Resultado | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [gerando, setGerando] = useState(false);

  const carregar = useCallback(async () => {
    setErro(null);
    try {
      const [f, p] = await Promise.all([coreApi.scaleFormats(), coreApi.weighableProducts()]);
      setFormatos(f);
      setProdutos(p);
    } catch (e) {
      setErro(e instanceof ApiRequestError ? e.message : 'Não foi possível carregar.');
      setProdutos([]);
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const formatoAtual = useMemo(
    () => formatos.find((f) => f.id === formatId),
    [formatos, formatId],
  );

  async function gerar() {
    setGerando(true);
    setErro(null);
    setResultado(null);
    try {
      setResultado(await coreApi.scaleExport({ formatId }));
    } catch (e) {
      setErro(e instanceof ApiRequestError ? e.message : 'Não foi possível gerar o arquivo.');
    } finally {
      setGerando(false);
    }
  }

  function baixar() {
    if (!resultado) return;
    // Texto puro com CRLF: o importador da balança roda em Windows.
    const url = URL.createObjectURL(
      new Blob([resultado.content], { type: 'text/plain;charset=us-ascii' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = resultado.filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  const semPlu = (produtos ?? []).filter((p) => !p.pluCode).length;

  return (
    <AppShell>
      <PageHeader
        breadcrumb={['Produtos', 'Balança']}
        title="Balança"
        subtitle="Gera o arquivo de produtos que a balança importa. O código de barras não vai no arquivo — a balança monta o dela."
        actions={
          <Button onClick={() => void gerar()} loading={gerando}>
            Gerar arquivo
          </Button>
        }
      />

      {erro && (
        <div
          role="alert"
          className="mb-5 px-4 py-3 rounded-[var(--gs-radius)] bg-[var(--gs-danger-bg)] text-[var(--gs-danger)]"
        >
          {erro}
        </div>
      )}

      <Card title="Formato do arquivo" className="mb-5">
        <label className="flex flex-col gap-1.5 max-w-lg">
          <span className={ROTULO}>Marca da balança</span>
          <select
            value={formatId}
            onChange={(e) => {
              setFormatId(e.target.value);
              setResultado(null);
            }}
            className={SELECT}
          >
            {formatos.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </select>
        </label>

        {formatoAtual && (
          <>
            <p className="mt-3 mb-1 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
              Arquivo: <strong className="font-mono">{formatoAtual.filename}</strong>
            </p>
            <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
              {formatoAtual.observacao}
            </p>
            {/*
              O aviso fica AQUI, onde a pessoa escolhe — não no rodapé. É a
              diferença entre avisar e se justificar depois.
            */}
            {!formatoAtual.confirmado && (
              <div className="mt-3 px-4 py-3 rounded-[var(--gs-radius)] bg-[var(--gs-warning-bg)] text-[length:var(--gs-text-sm)]">
                <strong>Layout ainda não confirmado.</strong> Este formato não foi testado numa
                balança real. Se ela recusar o arquivo, exporte um arquivo pela própria balança com
                dois ou três produtos e mande para ajustarmos as posições — um arquivo desses
                resolve a marca inteira. Enquanto isso, o <strong>CSV genérico</strong> é o caminho
                mais seguro.
              </div>
            )}
          </>
        )}
      </Card>

      {resultado && (
        <Card
          title="Arquivo gerado"
          subtitle={`${resultado.lineCount} produto(s) no arquivo`}
          actions={
            <Button onClick={baixar} disabled={resultado.lineCount === 0}>
              Baixar {resultado.filename}
            </Button>
          }
          className="mb-5"
        >
          {resultado.lineCount === 0 ? (
            <EmptyState
              title="Nenhum produto entrou no arquivo"
              description="Marque os produtos como pesáveis e dê um PLU a cada um, no cadastro."
            />
          ) : (
            <pre
              className="m-0 p-3 rounded-[var(--gs-radius)] bg-[var(--gs-surface-hover)]
                font-mono text-[length:var(--gs-text-xs)] overflow-x-auto max-h-48"
            >
              {resultado.content.split('\r\n').slice(0, 12).join('\n')}
            </pre>
          )}

          {resultado.skipped.length > 0 && (
            <div className="mt-4">
              <p className={`${ROTULO} mb-2`}>
                {resultado.skipped.length} produto(s) ficaram de fora:
              </p>
              <ul className="m-0 pl-5 text-[length:var(--gs-text-sm)] max-h-40 overflow-y-auto">
                {resultado.skipped.map((s) => (
                  <li key={s.productId}>
                    <strong>{s.name}</strong> — {s.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>
      )}

      <EtiquetaDaBalancaNoPdv produtos={produtos} />

      <Card
        title="Produtos pesáveis"
        subtitle={
          semPlu > 0
            ? `${semPlu} sem PLU — a balança acha o produto por esse número`
            : 'Marque "pesável" e dê um PLU no cadastro do produto'
        }
      >
        {produtos === null ? (
          <p className="text-[var(--gs-text-soft)]">Carregando…</p>
        ) : produtos.length === 0 ? (
          <EmptyState
            title="Nenhum produto pesável"
            description="No cadastro do produto, marque a opção de venda por peso e informe o PLU."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[length:var(--gs-text-sm)]">
              <thead>
                <tr className="text-left text-[var(--gs-text-soft)] border-b border-[var(--gs-border)]">
                  <th className={TH}>PLU</th>
                  <th className={TH}>Produto</th>
                  <th className={`${TH} text-right`}>Preço por kg</th>
                  <th className={`${TH} text-right`}>Tara (g)</th>
                </tr>
              </thead>
              <tbody>
                {produtos.map((p) => (
                  <tr
                    key={p.productId}
                    className="border-b border-[var(--gs-border)] last:border-0"
                  >
                    <td className={`${TD} font-mono text-[length:var(--gs-text-xs)]`}>
                      {p.pluCode ?? <Badge tone="warning">sem PLU</Badge>}
                    </td>
                    <td className={TD}>{p.name}</td>
                    <td className={`${TD} text-right tabular-nums`}>
                      {formatCents(p.priceCents)}
                    </td>
                    <td className={`${TD} text-right tabular-nums`}>{p.tareGrams ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </AppShell>
  );
}
