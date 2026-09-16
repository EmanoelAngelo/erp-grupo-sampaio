/**
 * MODELOS DE ETIQUETA — a loja desenha as etiquetas dela, em milímetro.
 *
 * Os formatos prontos continuam valendo, mas agora como PONTO DE PARTIDA: o
 * gestor cria "Rolo 40 × 30", "Rolo 30 × 20 — 2 colunas", "Gôndola", com a
 * medida real do papel que comprou, escolhe o que aparece (nome, preço em
 * destaque, código de barras, código interno, SKU, marca, unidade, descrição
 * curta, um texto próprio) e vê a prévia antes de gastar o rolo.
 *
 * A conta do papel é conferida aqui, enquanto se digita (a última coluna
 * cabe?), e de novo no servidor, que é quem recusa de verdade. O modelo não é a
 * impressora: a preferida fica anotada, e o mesmo modelo sai em qualquer outra
 * pelo diálogo de impressão do sistema (a térmica instalada no Windows aparece
 * lá, com o driver dela).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, Button, Card, EmptyState } from '@/components/gs/ui';
import { ApiRequestError } from '@/lib/api/client';
import {
  coreApi,
  type CampoDeEtiqueta,
  type LabelFormatOption,
  type ModeloDeEtiqueta,
  type PerfilDeImpressao,
  type Printer,
  type RascunhoDeModelo,
} from '@/lib/api/core';

const ROTULO = 'text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-text-soft)]';
const CAIXA =
  'h-10 px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)] ' +
  'bg-[var(--gs-surface)] text-[var(--gs-text)] text-[length:var(--gs-text-base)]';

const NOVO: RascunhoDeModelo = {
  name: '',
  midia: 'rolo',
  paperWidthMm: 40,
  paperHeightMm: null,
  widthMm: 40,
  heightMm: 30,
  columns: 1,
  rows: null,
  gapXmm: 0,
  gapYmm: 0,
  marginTopMm: 1,
  marginLeftMm: 0,
  orientation: 'retrato',
  scalePercent: 100,
  // Rolo nasce com a térmica de balcão (Argox, Elgin, Zebra de entrada): 203 dpi.
  dpi: 203,
  // A grade entra por padrão: sem ela, as variantes P/M/G de uma grade saíam
  // com etiquetas de título idêntico (hoje o título vira o nome completo da
  // variante quando a grade não está marcada, mas a linha é a forma clara).
  fields: ['nome', 'atributos', 'preco', 'barras', 'ean', 'codigo'],
  priceHighlight: true,
  complementText: null,
  printerId: null,
  isDefault: false,
  // A saída e a impressora física nascem no padrão: navegador, sem
  // deslocamento, sem corte, sensor de vão, e o resto a cargo da impressora.
  outputProfile: null,
  offsetXmm: 0,
  offsetYmm: 0,
  darkness: null,
  printSpeed: null,
  cutMode: 'nenhum',
  mediaType: 'vao',
  mediaGapMm: null,
  feedAfterMm: 0,
};

/** Um formato pronto vira rascunho de modelo — com a largura de papel que ele ocupa. */
type FormatoCompleto = LabelFormatOption &
  Partial<{ gapXmm: number; gapYmm: number; marginTopMm: number; marginLeftMm: number; paperWidthMm: number; paperHeightMm: number | null }>;
function doFormato(f: FormatoCompleto): RascunhoDeModelo {
  const gapX = f.gapXmm ?? 0;
  const folha = f.midia === 'folha';
  const larguraDoRolo = f.columns * f.widthMm + (f.columns - 1) * gapX;
  return {
    ...NOVO,
    name: f.label.slice(0, 60),
    midia: f.midia,
    // A folha Carta (215,9 × 279,4) traz o próprio papel; forçar 210 × 297 fazia
    // o modelo "a partir do formato" desalinhar numa folha que não é A4.
    paperWidthMm: folha ? (f.paperWidthMm ?? 210) : Math.round(larguraDoRolo * 100) / 100,
    paperHeightMm: folha ? (f.paperHeightMm ?? 297) : null,
    widthMm: f.widthMm,
    heightMm: f.heightMm,
    columns: f.columns,
    rows: folha ? f.rows : null,
    gapXmm: gapX,
    gapYmm: folha ? (f.gapYmm ?? 0) : 0,
    marginTopMm: f.marginTopMm ?? 0,
    marginLeftMm: folha ? (f.marginLeftMm ?? 0) : 0,
    // O mesmo palpite que o servidor faz para o formato pronto: folha sai em
    // jato de tinta ou laser (300), rolo em térmica de balcão (203).
    dpi: folha ? 300 : 203,
    fields: f.campos,
  };
}

function larguraOcupada(m: RascunhoDeModelo): number {
  return m.marginLeftMm + m.columns * m.widthMm + (m.columns - 1) * m.gapXmm;
}

const mm = (n: number) => n.toLocaleString('pt-BR', { maximumFractionDigits: 2 });

export function ModelosDeEtiqueta({
  podeEditar,
  formatosProntos,
  onMudou,
  perfis = [],
}: {
  podeEditar: boolean;
  formatosProntos: LabelFormatOption[];
  onMudou?: (modelos: ModeloDeEtiqueta[]) => void;
  /** As saídas de impressão (do catálogo) — para a saída padrão do modelo. */
  perfis?: PerfilDeImpressao[];
}) {
  const [modelos, setModelos] = useState<ModeloDeEtiqueta[]>([]);
  const [campos, setCampos] = useState<CampoDeEtiqueta[]>([]);
  const [impressoras, setImpressoras] = useState<Printer[]>([]);
  const [editando, setEditando] = useState<{ id: string | null; m: RascunhoDeModelo } | null>(null);
  const [previa, setPrevia] = useState<{
    html: string;
    etiquetas: number;
    folhas: number;
    avisos?: string[];
    /** A saída que desenhou a prévia — a do modelo (ver o comentário da prévia, abaixo). */
    perfil?: PerfilDeImpressao['id'];
  } | null>(null);
  const [erroDaPrevia, setErroDaPrevia] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const carregar = useCallback(async () => {
    try {
      const r = await coreApi.labelTemplates();
      setModelos(r.items);
      setCampos(r.campos);
      onMudou?.(r.items);
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao carregar os modelos de etiqueta.');
    }
  }, [onMudou]);

  useEffect(() => {
    void carregar();
    void coreApi
      .listPrinters()
      .then(setImpressoras)
      .catch(() => setImpressoras([]));
  }, [carregar]);

  // A prévia acompanha a edição, com espera: uma requisição por pausa, não por tecla.
  useEffect(() => {
    if (!editando) {
      setPrevia(null);
      return;
    }
    const t = setTimeout(() => {
      coreApi
        .previewLabelTemplate({ template: { ...editando.m, name: editando.m.name || 'Rascunho' } })
        .then((r) => {
          setPrevia(r);
          setErroDaPrevia(null);
        })
        .catch((err) => {
          setPrevia(null);
          setErroDaPrevia(err instanceof ApiRequestError ? err.message : 'Não foi possível montar a prévia.');
        });
    }, 400);
    return () => clearTimeout(t);
  }, [editando]);

  const m = editando?.m ?? null;
  const ocupada = m ? larguraOcupada(m) : 0;
  const cabe = m ? ocupada <= m.paperWidthMm + 0.001 : true;
  const impressorasDeEtiqueta = useMemo(
    () => impressoras.filter((p) => p.kind === 'etiqueta' || p.kind === 'a4'),
    [impressoras],
  );

  const set = <K extends keyof RascunhoDeModelo>(chave: K, valor: RascunhoDeModelo[K]) =>
    setEditando((e) => (e ? { ...e, m: { ...e.m, [chave]: valor } } : e));
  // `minimo`: a calibração vai para os dois lados (−10 a 10 mm); o resto começa no zero.
  const num = (chave: keyof RascunhoDeModelo, rotulo: string, passo = 0.5, desabilitado = false, minimo = 0) => (
    <label className="flex flex-col gap-1">
      <span className={ROTULO}>{rotulo}</span>
      <input
        type="number"
        step={passo}
        min={minimo}
        disabled={desabilitado}
        value={m ? String(m[chave] ?? '') : ''}
        onChange={(e) => set(chave, (e.target.value === '' ? null : Number(e.target.value)) as never)}
        aria-label={rotulo}
        className={`${CAIXA} w-full disabled:opacity-50`}
      />
    </label>
  );

  async function salvar() {
    if (!editando) return;
    setBusy(true);
    setErro(null);
    try {
      const salvo = editando.id
        ? await coreApi.updateLabelTemplate(editando.id, editando.m)
        : await coreApi.createLabelTemplate(editando.m);
      // O servidor salva e diz o que pode dar errado no papel: a frase vai junto.
      const avisos = Array.isArray(salvo?.avisos) ? salvo.avisos : [];
      setAviso(`Modelo "${editando.m.name}" salvo.${avisos.length ? ` Atenção: ${avisos.join(' ')}` : ''}`);
      setEditando(null);
      await carregar();
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Não foi possível salvar o modelo.');
    } finally {
      setBusy(false);
    }
  }

  // Apagar pergunta NA TELA (nada de diálogo do navegador): a linha de confirmação
  // aparece acima da lista, com o nome do modelo, e só o segundo clique apaga.
  const [paraApagar, setParaApagar] = useState<ModeloDeEtiqueta | null>(null);

  async function excluir(modelo: ModeloDeEtiqueta) {
    setErro(null);
    try {
      await coreApi.deleteLabelTemplate(modelo.id);
      setAviso(`Modelo "${modelo.name}" apagado.`);
      setParaApagar(null);
      await carregar();
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Não foi possível apagar o modelo.');
    }
  }

  return (
    <Card
      title="Modelos de etiqueta"
      subtitle="Medida real do papel em milímetro, o que aparece e a impressora preferida. A prévia mostra o papel antes de imprimir."
      className="mb-5"
      actions={
        podeEditar && !editando ? (
          <div className="flex gap-2 items-center flex-wrap">
            <select
              aria-label="Criar a partir de um formato pronto"
              className={CAIXA}
              value=""
              onChange={(e) => {
                const f = formatosProntos.find((x) => x.id === e.target.value);
                if (f) setEditando({ id: null, m: doFormato(f as FormatoCompleto) });
              }}
            >
              <option value="">A partir de um formato pronto…</option>
              {formatosProntos.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
            </select>
            <Button size="sm" onClick={() => setEditando({ id: null, m: { ...NOVO } })}>
              Novo modelo
            </Button>
          </div>
        ) : undefined
      }
    >
      {erro && (
        <p role="alert" className="mb-3 px-3 py-2 rounded-[var(--gs-radius)] bg-[var(--gs-danger-bg)] text-[var(--gs-danger)] text-[length:var(--gs-text-sm)]">
          {erro}
        </p>
      )}
      {aviso && !erro && (
        <p role="status" className="mb-3 px-3 py-2 rounded-[var(--gs-radius)] bg-[var(--gs-success-bg)] text-[var(--gs-success)] text-[length:var(--gs-text-sm)]">
          {aviso}
        </p>
      )}

      {!editando &&
        (modelos.length === 0 ? (
          <EmptyState
            title="Nenhum modelo ainda"
            description={
              podeEditar
                ? 'Crie o primeiro com as medidas do rolo ou da folha que a loja usa — ou parta de um formato pronto.'
                : 'Peça a quem configura a impressão da loja para cadastrar os modelos.'
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[length:var(--gs-text-sm)]" aria-label="Modelos de etiqueta">
              <thead>
                <tr className="text-left text-[var(--gs-text-soft)] border-b border-[var(--gs-border)]">
                  <th className="py-2 px-3 font-semibold">Modelo</th>
                  <th className="py-2 px-3 font-semibold">Etiqueta</th>
                  <th className="py-2 px-3 font-semibold">Papel</th>
                  <th className="py-2 px-3 font-semibold">Impressora</th>
                  <th className="py-2 px-3" />
                </tr>
              </thead>
              <tbody>
                {modelos.map((mo) => (
                  <tr key={mo.id} className="border-b border-[var(--gs-border)] last:border-0">
                    <td className="py-2 px-3">
                      <strong>{mo.name}</strong> {mo.isDefault && <Badge tone="info">padrão</Badge>}
                    </td>
                    <td className="py-2 px-3 tabular-nums">
                      {mm(mo.widthMm)} × {mm(mo.heightMm)} mm · {mo.columns} coluna(s)
                      {mo.orientation === 'paisagem' ? ' · paisagem' : ''}
                    </td>
                    <td className="py-2 px-3 tabular-nums">
                      {mo.midia === 'folha' ? `Folha ${mm(mo.paperWidthMm)} × ${mm(mo.paperHeightMm ?? 297)} mm` : `Rolo ${mm(mo.paperWidthMm)} mm`}
                    </td>
                    <td className="py-2 px-3">{mo.printerName ?? <span className="text-[var(--gs-muted)]">a escolher ao imprimir</span>}</td>
                    <td className="py-2 px-3 text-right whitespace-nowrap">
                      {podeEditar && paraApagar?.id === mo.id && (
                        <span role="alert" className="inline-flex items-center gap-2 text-[length:var(--gs-text-sm)]">
                          Apagar mesmo? As etiquetas já impressas não mudam.
                          <Button size="sm" variant="danger" onClick={() => void excluir(mo)}>
                            Sim, apagar
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setParaApagar(null)}>
                            Manter
                          </Button>
                        </span>
                      )}
                      {podeEditar && paraApagar?.id !== mo.id && (
                        <>
                          <Button size="sm" variant="ghost" onClick={() => setEditando({ id: mo.id, m: { ...mo } })}>
                            Editar
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setParaApagar(mo)}>
                            Apagar
                          </Button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}

      {editando && m && (
        <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-6" aria-label="Editor do modelo de etiqueta">
          <div className="flex flex-col gap-4">
            <label className="flex flex-col gap-1">
              <span className={ROTULO}>Nome do modelo *</span>
              <input
                value={m.name}
                onChange={(e) => set('name', e.target.value)}
                placeholder='Ex.: "Rolo 40 × 30" ou "Gôndola"'
                aria-label="Nome do modelo"
                className={`${CAIXA} w-full`}
              />
            </label>

            <div className="flex gap-4 flex-wrap">
              {(['rolo', 'folha'] as const).map((md) => (
                <label key={md} className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="midia"
                    checked={m.midia === md}
                    onChange={() =>
                      setEditando((e) =>
                        e
                          ? {
                              ...e,
                              m: {
                                ...e.m,
                                midia: md,
                                paperHeightMm: md === 'folha' ? (e.m.paperHeightMm ?? 297) : null,
                                rows: md === 'folha' ? e.m.rows : null,
                                // DEFEITO QUE ISTO CORRIGE (revisão do C-etiquetas-05): o
                                // "Novo modelo" nasce rolo com 203 dpi, e trocar para folha
                                // mantinha o 203 — que ia EXPLÍCITO ao servidor, então o
                                // padrão da folha (300, jato de tinta ou laser) nunca valia e
                                // a folha nova arredondava as barras para pontos de térmica.
                                // Enquanto o dpi for o padrão da mídia de antes, ele segue a
                                // mídia; o que a pessoa escolheu à mão fica.
                                dpi:
                                  (e.m.dpi ?? 203) === (e.m.midia === 'folha' ? 300 : 203)
                                    ? md === 'folha' ? 300 : 203
                                    : e.m.dpi,
                              },
                            }
                          : e,
                      )
                    }
                  />
                  {md === 'rolo' ? 'Rolo (térmica de etiqueta)' : 'Folha (A4 adesiva ou outra)'}
                </label>
              ))}
            </div>

            <fieldset className="grid grid-cols-2 md:grid-cols-4 gap-3 border border-[var(--gs-border)] rounded-[var(--gs-radius)] p-3">
              <legend className={`${ROTULO} px-1`}>Papel e etiqueta (mm)</legend>
              {num('paperWidthMm', 'Largura do papel')}
              {num('paperHeightMm', 'Altura do papel', 0.5, m.midia !== 'folha')}
              {num('widthMm', 'Largura da etiqueta')}
              {num('heightMm', 'Altura da etiqueta')}
              {num('columns', 'Colunas', 1)}
              {num('rows', 'Linhas por folha', 1, m.midia !== 'folha')}
              {num('gapXmm', 'Espaço entre colunas')}
              {num('gapYmm', 'Espaço entre linhas', 0.5, m.midia !== 'folha')}
              {num('marginTopMm', 'Margem superior')}
              {num('marginLeftMm', 'Margem esquerda')}
              {num('scalePercent', 'Escala do texto (%)', 5)}
              <label className="flex flex-col gap-1">
                <span className={ROTULO}>Orientação</span>
                <select
                  value={m.orientation}
                  onChange={(e) => set('orientation', e.target.value as RascunhoDeModelo['orientation'])}
                  aria-label="Orientação"
                  className={CAIXA}
                >
                  <option value="retrato">Retrato</option>
                  <option value="paisagem">Paisagem (conteúdo girado 90°)</option>
                </select>
              </label>
              {/* O servidor arredonda cada barra do código para os pontos DESTA
                  resolução: com a errada, as barras saem desiguais e o leitor falha. */}
              <label className="flex flex-col gap-1">
                <span className={ROTULO}>Resolução da impressora (dpi)</span>
                <select
                  value={String(m.dpi ?? 203)}
                  onChange={(e) => set('dpi', Number(e.target.value))}
                  aria-label="Resolução da impressora (dpi)"
                  className={CAIXA}
                >
                  <option value="203">203 dpi (térmica de balcão)</option>
                  <option value="300">300 dpi</option>
                  <option value="600">600 dpi (laser)</option>
                </select>
              </label>
            </fieldset>

            <p
              data-testid="conta-do-papel"
              className={`m-0 text-[length:var(--gs-text-sm)] ${cabe ? 'text-[var(--gs-success)]' : 'text-[var(--gs-danger)] font-semibold'}`}
            >
              {cabe
                ? `As ${m.columns} coluna(s) ocupam ${mm(ocupada)} mm de ${mm(m.paperWidthMm)} mm do papel.`
                : `As ${m.columns} coluna(s) ocupam ${mm(ocupada)} mm e o papel tem ${mm(m.paperWidthMm)} mm: a última coluna sairia cortada.`}
            </p>

            <fieldset className="border border-[var(--gs-border)] rounded-[var(--gs-radius)] p-3">
              <legend className={`${ROTULO} px-1`}>O que aparece na etiqueta</legend>
              <div className="grid grid-cols-2 gap-2">
                {campos.map((c) => (
                  <label key={c.id} className="flex items-center gap-2 text-[length:var(--gs-text-sm)]">
                    <input
                      type="checkbox"
                      checked={m.fields.includes(c.id)}
                      onChange={() =>
                        set('fields', m.fields.includes(c.id) ? m.fields.filter((x) => x !== c.id) : [...m.fields, c.id])
                      }
                    />
                    {c.rotulo}
                  </label>
                ))}
              </div>
              <label className="flex items-center gap-2 mt-3 text-[length:var(--gs-text-sm)]">
                <input type="checkbox" checked={m.priceHighlight} onChange={(e) => set('priceHighlight', e.target.checked)} />
                Preço em destaque (grande)
              </label>
              {m.fields.includes('complemento') && (
                <input
                  value={m.complementText ?? ''}
                  onChange={(e) => set('complementText', e.target.value)}
                  placeholder='Texto próprio (ex.: "Troca em até 30 dias")'
                  aria-label="Texto próprio"
                  className={`${CAIXA} w-full mt-2`}
                />
              )}
            </fieldset>

            <label className="flex flex-col gap-1">
              <span className={ROTULO}>Impressora preferida</span>
              <select
                value={m.printerId ?? ''}
                onChange={(e) => set('printerId', e.target.value || null)}
                aria-label="Impressora preferida"
                className={CAIXA}
              >
                <option value="">Escolher no diálogo ao imprimir</option>
                {impressorasDeEtiqueta.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <span className="text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
                Cadastre impressoras em Configurações › Impressoras. A etiqueta sai pelo driver da impressora
                instalada no computador (USB, rede ou Windows); densidade e velocidade ficam no driver.
              </span>
            </label>

            {/* A SAÍDA E A IMPRESSORA FÍSICA (P0 das etiquetas). A calibração
                corrige a impressora que puxa o papel torto; densidade,
                velocidade, corte, sensor e vão vão DENTRO do arquivo ZPL, EPL e
                TSPL — no navegador e no driver, ficam no driver. */}
            <fieldset
              aria-label="Saída, calibração e mídia"
              className="grid grid-cols-2 md:grid-cols-4 gap-3 border border-[var(--gs-border)] rounded-[var(--gs-radius)] p-3"
            >
              <legend className={`${ROTULO} px-1`}>Saída, calibração e mídia</legend>
              <label className="flex flex-col gap-1 col-span-2">
                <span className={ROTULO}>Saída padrão</span>
                <select
                  value={m.outputProfile ?? ''}
                  onChange={(e) => set('outputProfile', e.target.value || null)}
                  aria-label="Saída padrão"
                  className={CAIXA}
                >
                  <option value="">Navegador (diálogo de impressão)</option>
                  {perfis
                    .filter((p) => p.id !== 'navegador')
                    .map((p) => (
                      <option key={p.id} value={p.id} disabled={m.midia === 'folha' && !p.aceitaFolha}>
                        {p.rotulo}
                        {m.midia === 'folha' && !p.aceitaFolha ? ' — só rolo' : ''}
                      </option>
                    ))}
                </select>
              </label>
              {num('offsetXmm', 'Deslocamento horizontal (mm)', 0.25, false, -10)}
              {num('offsetYmm', 'Deslocamento vertical (mm)', 0.25, false, -10)}
              {num('darkness', 'Densidade (0 a 30)', 1)}
              {num('printSpeed', 'Velocidade (pol/s)', 1)}
              <label className="flex flex-col gap-1">
                <span className={ROTULO}>Corte</span>
                <select
                  value={m.cutMode ?? 'nenhum'}
                  onChange={(e) => set('cutMode', e.target.value as RascunhoDeModelo['cutMode'])}
                  aria-label="Corte"
                  className={CAIXA}
                >
                  <option value="nenhum">Sem corte (destacar)</option>
                  <option value="cada_etiqueta">A cada etiqueta</option>
                  <option value="fim_do_lote">Só no fim do lote</option>
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className={ROTULO}>Sensor da mídia</span>
                <select
                  value={m.mediaType ?? 'vao'}
                  onChange={(e) => set('mediaType', e.target.value as RascunhoDeModelo['mediaType'])}
                  aria-label="Sensor da mídia"
                  className={CAIXA}
                >
                  <option value="vao">Vão entre etiquetas</option>
                  <option value="marca">Marca preta no verso</option>
                  <option value="continua">Papel contínuo</option>
                </select>
              </label>
              {num('mediaGapMm', 'Vão entre etiquetas (mm)', 0.5, m.mediaType === 'continua')}
              {num('feedAfterMm', 'Avanço ao fim do lote (mm)', 1)}
              <span className="col-span-2 md:col-span-4 text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
                Calibração: imprima a etiqueta de teste e desloque até a moldura ficar centrada no adesivo (positivo = para a
                direita / para baixo). Densidade, velocidade, corte, sensor e vão vão dentro do arquivo ZPL, EPL e TSPL; no
                navegador e no driver, ajuste no próprio driver.
              </span>
            </fieldset>

            <label className="flex items-center gap-2 text-[length:var(--gs-text-sm)]">
              <input type="checkbox" checked={m.isDefault} onChange={(e) => set('isDefault', e.target.checked)} />
              Modelo padrão da loja (vem escolhido ao imprimir)
            </label>

            <div className="flex gap-2">
              <Button onClick={() => void salvar()} loading={busy} disabled={!cabe || !m.name.trim()}>
                Salvar modelo
              </Button>
              <Button variant="secondary" onClick={() => setEditando(null)}>
                Cancelar
              </Button>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            {/*
              A PRÉVIA É DESENHADA PELA SAÍDA DO MODELO (P00 das etiquetas).

              O DEFEITO: o servidor desenhava a prévia sempre em HTML/CSS (o
              desenho do navegador), mesmo no modelo cuja saída padrão é ZPL,
              EPL, TSPL, PDF ou o driver — que passam por outro desenhista, em
              pontos da impressora. O gestor montava o modelo olhando um adesivo
              que não era o que a térmica dele ia imprimir. Agora é o mesmo
              caminho da impressão, e a legenda diz qual saída desenhou.
            */}
            <span className={ROTULO}>
              Prévia {previa ? `— ${previa.etiquetas} etiqueta(s) de exemplo em ${previa.folhas} página(s)` : ''}
              {previa?.perfil && (
                <span data-testid="saida-da-previa" className="font-normal text-[var(--gs-muted)]">
                  {` · desenhada pela saída ${perfis.find((p) => p.id === previa.perfil)?.rotulo ?? previa.perfil}`}
                </span>
              )}
            </span>
            {erroDaPrevia ? (
              <p role="alert" className="m-0 px-3 py-2 rounded-[var(--gs-radius)] bg-[var(--gs-warning-bg)] text-[length:var(--gs-text-sm)]">
                {erroDaPrevia}
              </p>
            ) : (
              <iframe
                title="Prévia da etiqueta"
                srcDoc={previa?.html ?? ''}
                className="w-full h-[420px] border border-[var(--gs-border)] rounded-[var(--gs-radius)] bg-white"
              />
            )}
            {/* A prévia usa a amostra de PIOR caso (nome longo, preço de quatro dígitos em promoção)
                e o servidor diz o que não fecha: barra abaixo do mínimo GS1, campos que não cabem. */}
            {previa?.avisos && previa.avisos.length > 0 && (
              <ul
                data-testid="avisos-do-modelo"
                className="m-0 pl-5 px-3 py-2 rounded-[var(--gs-radius)] bg-[var(--gs-warning-bg)] text-[length:var(--gs-text-sm)]"
              >
                {previa.avisos.map((a) => (
                  <li key={a}>{a}</li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}
