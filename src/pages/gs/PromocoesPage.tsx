/**
 * Promoções — GAP-PRD-032, GAP-PRD-033, GAP-PRD-197, GAP-PRD-194.
 *
 * O QUE MUDOU
 *
 * - O produto se BUSCA pelo nome ou pelo código e se escolhe na lista (033).
 *   Antes era um campo "Código do produto" solto, e o código da etiqueta
 *   estourava em "Erro interno": só funcionava colando o id da URL da ficha.
 * - A tela diz o que o servidor recusa, com as palavras dele (032/197): preço
 *   negativo, percentual fora de 0 a 100, fim antes do início, produto de outra
 *   empresa. O GRÁTIS (100 % ou preço zero) pede confirmação explícita.
 * - A promoção se EDITA (194), tem faixa de HORÁRIO e ESTOQUE PROMOCIONAL. A
 *   lista mostra o produto pelo nome, o horário, quanto do limite já saiu e a
 *   linha antiga que a regra de hoje recusaria ("Inválida", com o motivo).
 *
 * O preço de tabela nunca é alterado: promoção é cálculo, não edição do
 * cadastro. Encerrar devolve o preço original sozinho. Quando mais de uma
 * promoção vale para o mesmo produto, o cliente paga o MENOR preço.
 */
import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/gs/AppShell';
import {
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  Field,
  Input,
  PageHeader,
} from '@/components/gs/ui';
import { formatCents, parseReaisToCents } from '@/components/gs/format';
import { SeletorDeProduto } from '@/components/gs/SeletorDeProduto';
import { ApiRequestError, apiRequest } from '@/lib/api/client';
import { promocoesApi, type Promocao, type PromocaoEntrada } from '@/lib/api/promocoes';
import { dataBR } from '@/lib/datas';

/**
 * Os dias, na ordem em que a semana acontece. O índice É o valor gravado
 * (0 domingo a 6 sábado) — dois lugares para a mesma correspondência é onde
 * nasce a promoção de quarta que cai na terça.
 */
const DIAS_DA_SEMANA = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

/** '3' → "Qua". Nulo/vazio → "Todos os dias". */
function diasEmPalavras(weekdays: string | null): string {
  const dias = String(weekdays ?? '').trim();
  if (!dias) return 'Todos os dias';
  return dias
    .split('')
    .map((d) => DIAS_DA_SEMANA[Number(d)] ?? d)
    .join(', ');
}

function horarioEmPalavras(p: Promocao): string | null {
  if (!p.starts_time && !p.ends_time) return null;
  return `${p.starts_time ?? '00:00'}–${p.ends_time ?? '24:00'}`;
}

/** O instante gravado, como o `<input type="date">` espera (dia de quem olha). */
function paraCampoDeData(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function alvoEmPalavras(p: Promocao): string {
  if (p.category) return p.category;
  if (p.product_id) {
    if (!p.product_name) return 'Produto de outra empresa ou removido';
    return p.product_code ? `${p.product_name} (${p.product_code})` : p.product_name;
  }
  return '—';
}

interface Formulario {
  alvo: 'categoria' | 'produto';
  category: string;
  /** O que vai ao servidor: o id escolhido na lista ou o código digitado. */
  productId: string;
  productLabel: string | null;
  tipo: 'percentual' | 'preco';
  percentOff: string;
  priceReais: string;
  confirmarGratis: boolean;
  startsAt: string;
  endsAt: string;
  startsTime: string;
  endsTime: string;
  maxUnits: string;
  /** VAZIO = todos os dias (e é assim que o formulário nasce). */
  weekdays: number[];
}

const VAZIO: Formulario = {
  alvo: 'categoria',
  category: '',
  productId: '',
  productLabel: null,
  tipo: 'percentual',
  percentOff: '',
  priceReais: '',
  confirmarGratis: false,
  startsAt: '',
  endsAt: '',
  startsTime: '',
  endsTime: '',
  maxUnits: '',
  weekdays: [],
};

function formularioDe(p: Promocao): Formulario {
  return {
    alvo: p.product_id ? 'produto' : 'categoria',
    category: p.category ?? '',
    productId: p.product_id ?? '',
    productLabel: p.product_id ? alvoEmPalavras(p) : null,
    tipo: p.price_cents != null ? 'preco' : 'percentual',
    percentOff: p.percent_off != null ? String(p.percent_off) : '',
    priceReais:
      p.price_cents != null ? (p.price_cents / 100).toFixed(2).replace('.', ',') : '',
    confirmarGratis: Number(p.free_confirmed ?? 0) === 1,
    startsAt: paraCampoDeData(p.starts_at),
    endsAt: paraCampoDeData(p.ends_at),
    startsTime: p.starts_time ?? '',
    endsTime: p.ends_time ?? '',
    maxUnits: p.max_units != null ? String(p.max_units) : '',
    weekdays: String(p.weekdays ?? '')
      .split('')
      .filter(Boolean)
      .map(Number),
  };
}

function situacao(r: Promocao) {
  if (!r.active) return <Badge>Encerrada</Badge>;
  if (r.problemas && r.problemas.length > 0) {
    return (
      <span className="flex flex-col gap-1">
        <Badge tone="danger">Inválida</Badge>
        {r.problemas.map((p) => (
          <span key={p} className="text-[length:var(--gs-text-xs)] text-[var(--gs-danger)]">
            {p}
          </span>
        ))}
      </span>
    );
  }
  // "Ativa" e "valendo agora" são coisas diferentes: uma promoção programada
  // para semana que vem está ativa e não desconta nada hoje.
  const agora = new Date();
  if (new Date(r.starts_at).getTime() > agora.getTime()) {
    return <Badge tone="info">Programada</Badge>;
  }
  if (r.ends_at && new Date(r.ends_at).getTime() < agora.getTime()) {
    return <Badge>Vencida</Badge>;
  }
  if (r.units_left != null && r.units_left <= 0) return <Badge>Esgotada</Badge>;
  /*
    Dia da semana e horário também decidem. `getDay()`/`getHours()` são o
    relógio de quem está OLHANDO A TELA — a pessoa está na loja, no fuso da
    loja. Quem decide o preço de verdade é o servidor; este selo é a leitura.
  */
  if (String(r.weekdays ?? '') && !r.weekdays!.includes(String(agora.getDay()))) {
    return <Badge tone="info">Fora do dia</Badge>;
  }
  const hora = `${String(agora.getHours()).padStart(2, '0')}:${String(agora.getMinutes()).padStart(2, '0')}`;
  if ((r.starts_time && hora < r.starts_time) || (r.ends_time && hora >= r.ends_time)) {
    return <Badge tone="info">Fora do horário</Badge>;
  }
  return <Badge tone="success">Valendo agora</Badge>;
}

const SELECT =
  'w-full px-3 py-2 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)]';

export function PromocoesPage() {
  const [aberto, setAberto] = useState(false);
  /** A promoção em edição; nulo = criando uma nova. */
  const [editando, setEditando] = useState<Promocao | null>(null);
  const [form, setForm] = useState<Formulario>(VAZIO);
  const [erroDoFormulario, setErroDoFormulario] = useState<string | null>(null);
  const [mensagem, setMensagem] = useState<string | null>(null);
  const [lista, setLista] = useState<Promocao[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [categorias, setCategorias] = useState<string[]>([]);

  const recarregar = useCallback(async () => {
    setCarregando(true);
    try {
      setLista(await promocoesApi.listar());
      setErro(null);
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao carregar as promoções.');
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => {
    void recarregar();
  }, [recarregar]);

  // As categorias do cadastro, para sugerir a grafia certa (o servidor ainda
  // normaliza). Falhar aqui não impede nada: o campo continua aceitando texto.
  useEffect(() => {
    apiRequest<{ categories?: { name: string; children?: { name: string }[] }[] }>('/core/taxonomy')
      .then((t) => {
        const nomes = (Array.isArray(t?.categories) ? t.categories : []).flatMap((c) => [
          c.name,
          ...(c.children ?? []).map((s) => s.name),
        ]);
        setCategorias([...new Set(nomes.filter(Boolean))]);
      })
      .catch(() => setCategorias([]));
  }, []);

  const precoCents = form.tipo === 'preco' ? parseReaisToCents(form.priceReais) : null;
  const pedeGratis =
    (form.tipo === 'percentual' && Number(form.percentOff) === 100)
    || (form.tipo === 'preco' && precoCents === 0);

  const abrirNova = () => {
    setEditando(null);
    setForm(VAZIO);
    setErroDoFormulario(null);
    setAberto((v) => !v);
  };

  const abrirEdicao = (p: Promocao) => {
    setEditando(p);
    setForm(formularioDe(p));
    setErroDoFormulario(null);
    setMensagem(null);
    setAberto(true);
  };

  const fechar = () => {
    setAberto(false);
    setEditando(null);
    setForm(VAZIO);
    setErroDoFormulario(null);
  };

  const enviar = async (event: React.FormEvent) => {
    event.preventDefault();
    setErroDoFormulario(null);
    if (form.tipo === 'preco' && precoCents === null) {
      setErroDoFormulario('Informe o preço promocional.');
      return;
    }
    if (pedeGratis && !form.confirmarGratis) {
      setErroDoFormulario(
        'Esta promoção deixa o produto de graça. Marque a confirmação do grátis, ou corrija o desconto.',
      );
      return;
    }
    const maxUnits = form.maxUnits.trim() ? Number(form.maxUnits.replace(',', '.')) : null;
    const corpo: PromocaoEntrada = {
      // Alvo e desconto vão em BLOCO: na edição, mandar só a categoria é
      // trocar o alvo, e o servidor lê assim.
      category: form.alvo === 'categoria' ? form.category || undefined : undefined,
      productId: form.alvo === 'produto' ? form.productId || undefined : undefined,
      percentOff:
        form.tipo === 'percentual' && form.percentOff ? Number(form.percentOff) : undefined,
      priceCents: precoCents ?? undefined,
      confirmarGratis: pedeGratis ? form.confirmarGratis : undefined,
      startsTime: form.startsTime || undefined,
      endsTime: form.endsTime || undefined,
      maxUnits: maxUnits ?? undefined,
      weekdays: form.weekdays.length > 0 ? form.weekdays : undefined,
      /*
        A DATA VAI CRUA ('2026-12-31'), e é o servidor que a converte em
        instante — a ponta final vale o dia inteiro da loja. `new Date(...)`
        aqui mataria a promoção às 21h do dia anterior. Em branco, começa agora.
      */
      startsAt: form.startsAt || undefined,
      endsAt: form.endsAt || undefined,
    };
    try {
      if (editando) {
        const original = formularioDe(editando);
        const edicao: PromocaoEntrada = {
          ...corpo,
          // Na edição, o que foi APAGADO precisa ir como nulo: ausente mantém.
          productId: form.alvo === 'produto' ? form.productId || null : null,
          category: form.alvo === 'categoria' ? form.category || null : null,
          percentOff: form.tipo === 'percentual' && form.percentOff ? Number(form.percentOff) : null,
          priceCents: form.tipo === 'preco' ? precoCents : null,
          startsTime: form.startsTime || null,
          endsTime: form.endsTime || null,
          maxUnits,
          weekdays: form.weekdays,
          // Datas só vão se mudaram: o campo mostra o dia, e reenviar o dia
          // mudaria o instante gravado sem ninguém ter pedido.
          startsAt: form.startsAt !== original.startsAt ? form.startsAt || null : undefined,
          endsAt: form.endsAt !== original.endsAt ? form.endsAt || null : undefined,
        };
        const r = await promocoesApi.editar(editando.id, edicao);
        setMensagem(avisoDeSobreposicao('Promoção atualizada.', r.sobreposicoes));
      } else {
        const r = await promocoesApi.criar(corpo);
        setMensagem(avisoDeSobreposicao('Promoção ativada.', r.sobreposicoes));
      }
      fechar();
      await recarregar();
    } catch (err) {
      setErroDoFormulario(
        err instanceof ApiRequestError ? err.message : 'Falha ao salvar a promoção.',
      );
    }
  };

  /**
   * Encerrar é DESATIVAR, não apagar: a promoção que já rodou explica o preço
   * das vendas daquele período.
   */
  const encerrar = async (id: string) => {
    setMensagem(null);
    try {
      await promocoesApi.encerrar(id);
      setMensagem('Promoção encerrada. O preço volta ao de tabela nos dois canais.');
      await recarregar();
    } catch (err) {
      setMensagem(err instanceof ApiRequestError ? err.message : 'Falha ao encerrar.');
    }
  };

  return (
    <AppShell>
      <PageHeader
        breadcrumb={['Produtos', 'Promoções']}
        title="Promoções"
        actions={
          <Button onClick={abrirNova}>{aberto && !editando ? 'Fechar' : 'Nova promoção'}</Button>
        }
      />

      {aberto && (
        <Card title={editando ? 'Editar promoção' : 'Nova promoção'} className="mb-5">
          <form onSubmit={(e) => void enviar(e)} className="grid gap-4 sm:grid-cols-3">
            <Field label="Aplica a">
              {(p) => (
                <select
                  {...p}
                  value={form.alvo}
                  onChange={(e) =>
                    setForm({ ...form, alvo: e.target.value as 'categoria' | 'produto' })
                  }
                  className={SELECT}
                >
                  <option value="categoria">Uma categoria inteira</option>
                  <option value="produto">Um produto específico</option>
                </select>
              )}
            </Field>

            {form.alvo === 'categoria' ? (
              <Field label="Categoria" required hint="Todos os produtos dela entram">
                {(p) => (
                  <>
                    <Input
                      {...p}
                      list="categorias-da-promocao"
                      value={form.category}
                      onChange={(e) => setForm({ ...form, category: e.target.value })}
                    />
                    <datalist id="categorias-da-promocao">
                      {categorias.map((c) => (
                        <option key={c} value={c} />
                      ))}
                    </datalist>
                  </>
                )}
              </Field>
            ) : (
              <Field
                label="Produto"
                required
                hint="Busque pelo nome, ou digite o código interno ou de barras"
              >
                {(p) => (
                  <SeletorDeProduto
                    inputProps={p}
                    valor={form.productId}
                    rotulo={form.productLabel}
                    onChange={(valor, rotulo) =>
                      setForm((f) => ({ ...f, productId: valor, productLabel: rotulo }))
                    }
                  />
                )}
              </Field>
            )}

            <Field label="Tipo de desconto">
              {(p) => (
                <select
                  {...p}
                  value={form.tipo}
                  onChange={(e) =>
                    setForm({ ...form, tipo: e.target.value as 'percentual' | 'preco' })
                  }
                  className={SELECT}
                >
                  <option value="percentual">Percentual sobre o preço</option>
                  <option value="preco">Preço promocional fixo</option>
                </select>
              )}
            </Field>

            {form.tipo === 'percentual' ? (
              <Field label="Desconto (%)" required hint="Maior que 0 e no máximo 100">
                {(p) => (
                  <Input
                    {...p}
                    type="number"
                    min="0.01"
                    max="100"
                    step="0.01"
                    value={form.percentOff}
                    onChange={(e) => setForm({ ...form, percentOff: e.target.value })}
                  />
                )}
              </Field>
            ) : (
              <Field
                label="Preço promocional"
                required
                hint="Ex.: 89,90 — menor que o preço de cadastro"
              >
                {(p) => (
                  <Input
                    {...p}
                    inputMode="decimal"
                    value={form.priceReais}
                    onChange={(e) => setForm({ ...form, priceReais: e.target.value })}
                  />
                )}
              </Field>
            )}

            {pedeGratis && (
              <label
                className="sm:col-span-3 flex items-start gap-2 px-3 py-2 rounded-[var(--gs-radius)]
                  bg-[var(--gs-warning-bg)] text-[var(--gs-warning)] text-[length:var(--gs-text-sm)]"
              >
                <input
                  type="checkbox"
                  checked={form.confirmarGratis}
                  onChange={(e) => setForm({ ...form, confirmarGratis: e.target.checked })}
                />
                <span>
                  Confirmo o grátis: com este desconto o produto sai por <strong>R$ 0,00</strong>{' '}
                  na loja online e no balcão.
                </span>
              </label>
            )}

            <Field label="Começa em" hint="Em branco, começa agora">
              {(p) => (
                <Input
                  {...p}
                  type="date"
                  value={form.startsAt}
                  onChange={(e) => setForm({ ...form, startsAt: e.target.value })}
                />
              )}
            </Field>

            <Field label="Válida até" hint="Em branco, sem prazo">
              {(p) => (
                <Input
                  {...p}
                  type="date"
                  value={form.endsAt}
                  onChange={(e) => setForm({ ...form, endsAt: e.target.value })}
                />
              )}
            </Field>

            <Field
              label="Limite de unidades"
              hint="Em branco, sem limite. Soma a loja online e o balcão"
            >
              {(p) => (
                <Input
                  {...p}
                  type="number"
                  min="1"
                  inputMode="decimal"
                  value={form.maxUnits}
                  onChange={(e) => setForm({ ...form, maxUnits: e.target.value })}
                />
              )}
            </Field>

            <Field label="Horário de início" hint="Relógio da loja. Em branco, o dia inteiro">
              {(p) => (
                <Input
                  {...p}
                  type="time"
                  value={form.startsTime}
                  onChange={(e) => setForm({ ...form, startsTime: e.target.value })}
                />
              )}
            </Field>

            <Field label="Horário de fim" hint="Não atravessa a meia-noite">
              {(p) => (
                <Input
                  {...p}
                  type="time"
                  value={form.endsTime}
                  onChange={(e) => setForm({ ...form, endsTime: e.target.value })}
                />
              )}
            </Field>

            {/*
              DIAS DA SEMANA (GAP-V03). O rótulo diz o que o vazio significa,
              porque é o caso comum e é o que o formulário mostra ao abrir.
            */}
            <fieldset className="sm:col-span-3 border-0 p-0 m-0">
              <legend className="text-[length:var(--gs-text-sm)] font-semibold mb-2 p-0">
                Dias da semana{' '}
                <span className="font-normal text-[var(--gs-muted)]">
                  — nenhum marcado: vale todos os dias
                </span>
              </legend>
              <div className="flex flex-wrap gap-3">
                {DIAS_DA_SEMANA.map((rotulo, dia) => (
                  <label key={rotulo} className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={form.weekdays.includes(dia)}
                      onChange={(e) =>
                        setForm((atual) => ({
                          ...atual,
                          weekdays: e.target.checked
                            ? [...atual.weekdays, dia].sort((a, b) => a - b)
                            : atual.weekdays.filter((d) => d !== dia),
                        }))
                      }
                    />
                    <span className="text-[length:var(--gs-text-sm)]">{rotulo}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            <div className="sm:col-span-3 flex flex-wrap items-center gap-3">
              <Button type="submit">{editando ? 'Salvar alterações' : 'Ativar promoção'}</Button>
              {editando && (
                <Button type="button" variant="secondary" onClick={fechar}>
                  Cancelar
                </Button>
              )}
              <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                Vale no PDV e na loja online. O preço de tabela não é alterado.
              </span>
            </div>
            {erroDoFormulario && (
              <p role="alert" className="sm:col-span-3 text-[var(--gs-danger)] m-0">
                {erroDoFormulario}
              </p>
            )}
          </form>
        </Card>
      )}

      {mensagem && (
        <p role="status" className="mb-4 text-[length:var(--gs-text-sm)]">
          {mensagem}
        </p>
      )}

      {erro && (
        <p role="alert" className="mb-4 text-[var(--gs-danger)]">
          {erro}
        </p>
      )}
      {carregando && !lista && (
        <p role="status" className="mb-4 text-[var(--gs-muted)]">
          Carregando…
        </p>
      )}

      <p className="mb-2 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
        Quando mais de uma promoção vale para o mesmo produto, o cliente paga o menor preço.
      </p>

      <Card padded={false}>
        <DataTable
          columns={[
            { header: 'Alvo', render: (r: Promocao) => alvoEmPalavras(r) },
            {
              header: 'Desconto',
              render: (r: Promocao) =>
                r.percent_off != null
                  ? `${r.percent_off}%`
                  : r.price_cents != null
                    ? formatCents(r.price_cents)
                    : '—',
            },
            { header: 'Início', render: (r: Promocao) => dataBR(r.starts_at) },
            { header: 'Fim', render: (r: Promocao) => dataBR(r.ends_at, 'Sem prazo') },
            {
              header: 'Dias',
              render: (r: Promocao) => {
                const horario = horarioEmPalavras(r);
                return horario
                  ? `${diasEmPalavras(r.weekdays)} · ${horario}`
                  : diasEmPalavras(r.weekdays);
              },
            },
            {
              header: 'Limite',
              render: (r: Promocao) =>
                r.max_units != null
                  ? `${r.units_used ?? 0} de ${r.max_units} un.`
                  : 'Sem limite',
            },
            { header: 'Situação', render: (r: Promocao) => situacao(r) },
            {
              header: '',
              render: (r: Promocao) =>
                r.active ? (
                  <span className="flex gap-2">
                    <Button size="sm" variant="secondary" onClick={() => abrirEdicao(r)}>
                      Editar
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => void encerrar(r.id)}>
                      Encerrar
                    </Button>
                  </span>
                ) : null,
            },
          ]}
          rows={lista ?? []}
          keyOf={(r) => r.id}
          empty={
            <EmptyState
              title="Nenhuma promoção"
              description="Crie uma promoção para alterar o preço no PDV e na loja online por um período."
            />
          }
        />
      </Card>
    </AppShell>
  );
}

function avisoDeSobreposicao(
  inicio: string,
  sobreposicoes: { alvo: string }[] | undefined,
): string {
  const lista = sobreposicoes ?? [];
  if (lista.length === 0) return inicio;
  return `${inicio} Atenção: ela se sobrepõe a ${
    lista.length === 1 ? 'outra promoção' : `${lista.length} outras promoções`
  } (${lista.map((s) => s.alvo).join(', ')}) — quando mais de uma vale, o cliente paga o menor preço.`;
}
