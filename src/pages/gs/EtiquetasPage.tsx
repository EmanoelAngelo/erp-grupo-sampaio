/**
 * Etiquetas.
 *
 * Dois tipos distintos, deliberadamente separados:
 *
 *  - ETIQUETA COMERCIAL: código de barras + preço, para a prateleira e para o
 *    leitor do PDV. Sete origens, os formatos prontos e os modelos da loja,
 *    três modos de quantidade.
 *  - PLAQUINHA DE OFICINA: QR + #ID, colada no equipamento. O QR aponta para
 *    um token opaco — nunca carrega dado do proprietário.
 *
 * ## A folha é desenhada no SERVIDOR
 *
 * Esta tela não desenha mais etiqueta. Antes ela montava a folha em PIXELS e
 * chamava `window.print()` da própria página: pixel não tem tamanho físico, e
 * sem `@page` a folha herdava o A4 retrato com margem de documento declarado em
 * `src/index.css`. O adesivo saía no tamanho errado.
 *
 * Agora o servidor devolve um HTML autocontido medido em MILÍMETRO, que abre em
 * janela própria. O que sobra aqui é o que a tela sabe fazer melhor: escolher
 * de onde vêm os produtos, montar a fila e decidir a quantidade.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AppShell } from '@/components/gs/AppShell';
import { Badge, Button, Card, EmptyState, PageHeader, SearchInput } from '@/components/gs/ui';
import { formatCents, formatQuantity } from '@/components/gs/format';
import { useSession } from '@/hooks/useSession';
import { useCan } from '@/hooks/useCan';
import { ModelosDeEtiqueta } from '@/components/gs/ModelosDeEtiqueta';
import { ApiRequestError, apiRequest, exigirCampos } from '@/lib/api/client';
import {
  coreApi,
  type LabelCandidate,
  type LabelCandidates,
  type LabelFormatOption,
  type LabelSourceOption,
  type ModeloDeEtiqueta,
  type QuantityModeOption,
} from '@/lib/api/core';

/** O que a tela precisa conferir ANTES de gastar folha adesiva. */
interface ResumoPlaquinha {
  formatId: string;
  plaquinhas: number;
  folhas: number;
  qrMm: number;
  moduloMm: number;
  abaixoDoPiso: boolean;
  baseUrl: string;
  baseUrlConfigurada: boolean;
  problemas: { equipmentId: string; motivo: string }[];
}

interface FormatoPlaquinha {
  id: string;
  label: string;
  hint: string;
}

interface Equipment {
  id: string;
  publicIdLabel?: string;
  public_id: number;
  brand: string | null;
  model: string | null;
}

type Tab = 'produtos' | 'equipamentos';
type Documento = { purchaseOrderId?: string; noteId?: string; countId?: string; productId?: string };

const ROTULO = 'text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-text-soft)]';
const CAIXA_SELECT =
  'h-10 px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)] ' +
  'bg-[var(--gs-surface)] text-[var(--gs-text)] text-[length:var(--gs-text-base)]';

/** Os mesmos tetos do servidor (BarcodeService): por item e por folha gerada. */
const TETO_POR_ITEM = 200;
const TETO_DA_FOLHA = 3000;

/**
 * O que foi digitado na quantidade, conferido: inteiro de 1 a 200, ou nulo.
 *
 * O campo guardava NÚMERO e trocava o vazio por 1 na hora: apagar o "1" e
 * digitar 30 dava 130 etiquetas. Agora ele guarda o TEXTO enquanto se digita.
 */
function lerQuantidade(texto: string): number | null {
  const t = texto.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n >= 1 && n <= TETO_POR_ITEM ? n : null;
}

/** A quantidade que o modo sugere, SEM o teto — a tela avisa quando corta. */
function sugestaoBruta(c: LabelCandidate, modo: QuantityModeOption['id']): number {
  if (modo === 'saldo') return Math.max(1, Math.round(c.stockQuantity));
  if (modo === 'documento') return Math.max(1, Math.round(c.documentQuantity ?? 1));
  return 1;
}

export default function EtiquetasPage() {
  const session = useSession();
  const isWorkshop = session?.company.kind === 'workshop';
  const [params] = useSearchParams();
  const [tab, setTab] = useState<Tab>('produtos');
  const [error, setError] = useState<string | null>(null);
  /*
    Avisos e erro são estados SEPARADOS. Antes tudo ia para o mesmo `error`
    (a caixa vermelha): com o pop-up bloqueado, o "a folha foi baixada" era
    apagado pelo aviso de promoção logo em seguida, e uma folha gerada com
    sucesso aparecia como falha — a pessoa clicava de novo e gerava outra.
  */
  const [avisos, setAvisos] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  // Catálogo do que a tela pode oferecer — vem do servidor, uma verdade só.
  const [sources, setSources] = useState<LabelSourceOption[]>([]);
  const [formats, setFormats] = useState<LabelFormatOption[]>([]);
  const [modes, setModes] = useState<QuantityModeOption[]>([]);
  const [formatId, setFormatId] = useState('');
  const [mode, setMode] = useState<QuantityModeOption['id']>('manual');
  // Os MODELOS da loja (medida real, campos, impressora). O seletor oferece os
  // modelos primeiro e os formatos prontos depois; o valor de um modelo é "modelo:<id>".
  const [modelos, setModelos] = useState<ModeloDeEtiqueta[]>([]);
  const podeConfigurar = useCan('settings.printers.manage');
  // Gravar código de barras no produto sem código é mexer no CADASTRO: a folha
  // só faz isso para quem tem products.manage. Quem só imprime precisa saber
  // disso ANTES de gerar a folha, e não pelo aviso depois do papel gasto.
  const podeGerarCodigo = useCan('products.manage');
  /** A pessoa escolheu o formato no seletor — o padrão da loja não passa por cima dela. */
  const escolhidoAMao = useRef(false);
  /** O formato padrão do catálogo, para quando o modelo escolhido some. */
  const padraoDoCatalogo = useRef('');

  /*
    O MODELO PADRÃO DA LOJA NÃO DEPENDE DA ORDEM DAS RESPOSTAS.

    O efeito do filho (ModelosDeEtiqueta) pede os modelos ANTES de o pai pedir o
    catálogo. Quando os modelos respondiam primeiro, este callback escolhia o
    "modelo padrão da loja" — e em seguida o catálogo chegava e trocava, sem
    condição, para o formato A4. O estoquista mandava para a térmica uma folha
    A4 de 30 etiquetas, de vez em quando. Agora: o catálogo só preenche o que
    está VAZIO, e o modelo padrão vence qualquer formato que ninguém escolheu à mão.

    E quando o modelo escolhido é apagado (e não há padrão), a escolha cai no
    primeiro modelo ou no formato padrão — nunca em "" (o seletor mostrava uma
    opção e o servidor imprimia outra).
  */
  const aoMudarModelos = useCallback((lista: ModeloDeEtiqueta[]) => {
    setModelos(lista);
    setFormatId((atual) => {
      if (atual.startsWith('modelo:') && lista.some((m) => `modelo:${m.id}` === atual)) return atual;
      if (atual && !atual.startsWith('modelo:') && escolhidoAMao.current) return atual;
      const padrao = lista.find((m) => m.isDefault);
      if (padrao) return `modelo:${padrao.id}`;
      if (atual && !atual.startsWith('modelo:')) return atual;
      if (atual.startsWith('modelo:') && lista[0]) return `modelo:${lista[0].id}`;
      return padraoDoCatalogo.current || '';
    });
  }, []);

  // Origem escolhida e o que ela devolveu.
  const [source, setSource] = useState<LabelSourceOption['id']>('catalogo');
  const [busca, setBusca] = useState('');
  const [lowOnly, setLowOnly] = useState(false);
  const [codigos, setCodigos] = useState('');
  const [achados, setAchados] = useState<LabelCandidates | null>(null);

  /*
    A FILA: produto → quantas etiquetas. É o que vai para o papel.

    Ela SOBREVIVE a uma busca nova. Antes cada busca a zerava: marcar "sabão",
    buscar "detergente" e a fila sumia — só dava para imprimir um produto por
    vez, uma folha A4 de 30 para cada etiqueta. Por isso ela guarda o candidato
    inteiro (nome, código, saldo) e aparece em "Na fila", com o botão de tirar:
    o que vai para o papel está sempre à vista.
  */
  const [fila, setFila] = useState<Record<string, number>>({});
  const [itensDaFila, setItensDaFila] = useState<Record<string, LabelCandidate>>({});
  /** O texto sendo digitado numa quantidade (pode estar vazio no meio da digitação). */
  const [rascunhoQtd, setRascunhoQtd] = useState<Record<string, string>>({});
  /** Itens cuja sugestão passava do teto de 200 — e quanto era. */
  const [cortados, setCortados] = useState<Record<string, number>>({});
  const [comecarEm, setComecarEm] = useState('1');

  // Plaquinha de oficina: a folha vem PRONTA do servidor, em milímetro.
  // A tela não desenha mais o adesivo — só escolhe e confere.
  const [equipment, setEquipment] = useState<Equipment[]>([]);
  const [equipSelecao, setEquipSelecao] = useState<Record<string, number>>({});
  const [resumoPlaquinha, setResumoPlaquinha] = useState<ResumoPlaquinha | null>(null);
  const [formatoPlaquinha, setFormatoPlaquinha] = useState('plaq_a4_63x33_3col');
  const [formatosPlaquinha, setFormatosPlaquinha] = useState<FormatoPlaquinha[]>([]);

  useEffect(() => {
    void (async () => {
      try {
        const c = await coreApi.labelCatalog();
        setSources(c.sources);
        setFormats(c.formats);
        setModes(c.quantityModes);
        padraoDoCatalogo.current = c.defaultFormat;
        // Só preenche o que está vazio: o modelo padrão pode ter chegado antes.
        setFormatId((atual) => atual || c.defaultFormat);
      } catch (err) {
        setError(err instanceof ApiRequestError ? err.message : 'Falha ao carregar os formatos.');
      }
    })();
  }, []);

  /*
    "Imprimir etiquetas desta entrada": a Entrada de notas abre esta tela com
    `?origem=nota&nota=<id>` e a fila já vem com o que entrou, na quantidade da
    nota.
  */
  useEffect(() => {
    const nota = params.get('nota');
    if (params.get('origem') !== 'nota' || !nota) return;
    setSource('nota');
    setMode('documento');
    void (async () => {
      try {
        setAchados(await coreApi.labelCandidates({ source: 'nota', noteId: nota }));
      } catch (err) {
        setError(err instanceof ApiRequestError ? err.message : 'Não foi possível carregar a nota.');
      }
    })();
    // Só na abertura: o endereço é o ponto de partida, não um filtro vivo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const origemAtual = useMemo(() => sources.find((s) => s.id === source), [sources, source]);
  const formatoAtual = useMemo(() => formats.find((f) => f.id === formatId), [formats, formatId]);
  const modeloAtual = useMemo(
    () => (formatId.startsWith('modelo:') ? modelos.find((m) => `modelo:${m.id}` === formatId) ?? null : null),
    [formatId, modelos],
  );
  const geometria = modeloAtual ?? formatoAtual;
  // Os campos do que vai para o papel. Sem formato conhecido ainda, vale o que o
  // servidor faz sem campos: trata como etiqueta que imprime o código.
  const camposDaEtiqueta: readonly string[] | undefined = modeloAtual?.fields ?? formatoAtual?.campos;
  const formatoImprimeCodigo = !camposDaEtiqueta || camposDaEtiqueta.includes('barras') || camposDaEtiqueta.includes('ean');

  function limparFila() {
    setFila({});
    setItensDaFila({});
    setRascunhoQtd({});
    setCortados({});
  }

  /**
   * Trocar de origem LIMPA a fila.
   *
   * Sem isto, um item escolhido na busca continuava na fila depois de mudar
   * para o inventário — e as quantidades de documento de uma origem não valem
   * na outra.
   */
  function trocarOrigem(id: LabelSourceOption['id']) {
    setSource(id);
    limparFila();
    setAchados(null);
    setError(null);
    setAvisos([]);
    setBusca('');
    setCodigos('');
    const origem = sources.find((s) => s.id === id);
    if (mode === 'documento' && !origem?.temQuantidadeDeDocumento) setMode('manual');
  }

  const carregar = useCallback(
    async (extra?: Documento) => {
      setError(null);
      try {
        const r =
          source === 'codigos'
            ? await coreApi.labelCandidatesFromCodes(codigos)
            : await coreApi.labelCandidates({ source, search: busca, lowOnly, ...extra });
        // A fila NÃO é zerada aqui: ela guarda o que já foi marcado nas buscas anteriores.
        setAchados(r);
      } catch (err) {
        setError(
          err instanceof ApiRequestError ? err.message : 'Não foi possível carregar a lista.',
        );
        setAchados(null);
      }
    },
    [source, busca, lowOnly, codigos],
  );

  /** Busca com espera: sem isto era uma requisição por caractere digitado. */
  useEffect(() => {
    if (source !== 'catalogo' || busca.trim().length < 2) return;
    const t = setTimeout(() => void carregar(), 300);
    return () => clearTimeout(t);
  }, [source, busca, carregar]);

  useEffect(() => {
    if (source === 'estoque') void carregar();
  }, [source, lowOnly, carregar]);

  useEffect(() => {
    if (tab !== 'equipamentos') return;
    void (async () => {
      try {
        const [data, fmts] = await Promise.all([
          apiRequest<{ items: Equipment[] }>('/core/equipment').then((r) => exigirCampos(r, 'items')),
          apiRequest<{ items: FormatoPlaquinha[] }>('/core/labels/equipment/formats').then((r) => exigirCampos(r, 'items')),
        ]);
        setEquipment(data.items);
        setFormatosPlaquinha(fmts.items);
      } catch (err) {
        setError(err instanceof ApiRequestError ? err.message : 'Falha ao carregar.');
      }
    })();
  }, [tab]);

  /**
   * Põe candidatos na fila com a quantidade do modo — limitada a 200, o teto
   * do servidor. A sugestão NÃO tinha teto: com saldo 350, a tela prometia
   * "350 etiqueta(s)" e o servidor cortava para 200 em silêncio. Agora o corte
   * acontece aqui, e a tela diz qual item foi cortado e quanto era.
   */
  function porNaFila(lista: LabelCandidate[], modo: QuantityModeOption['id']) {
    setFila((prev) => {
      const next = { ...prev };
      for (const c of lista) next[c.productId] = Math.min(TETO_POR_ITEM, sugestaoBruta(c, modo));
      return next;
    });
    setItensDaFila((prev) => {
      const next = { ...prev };
      for (const c of lista) next[c.productId] = c;
      return next;
    });
    setCortados((prev) => {
      const next = { ...prev };
      for (const c of lista) {
        const bruta = sugestaoBruta(c, modo);
        if (bruta > TETO_POR_ITEM) next[c.productId] = bruta;
        else delete next[c.productId];
      }
      return next;
    });
    setRascunhoQtd((prev) => {
      const next = { ...prev };
      for (const c of lista) delete next[c.productId];
      return next;
    });
  }

  function tirarDaFila(id: string) {
    const semEle = <T,>(prev: Record<string, T>) => {
      const next = { ...prev };
      delete next[id];
      return next;
    };
    setFila(semEle);
    setItensDaFila(semEle);
    setRascunhoQtd(semEle);
    setCortados(semEle);
  }

  function alternar(c: LabelCandidate) {
    if (fila[c.productId] !== undefined) tirarDaFila(c.productId);
    else porNaFila([c], mode);
  }

  function todos() {
    if (!achados) return;
    porNaFila(achados.candidates, mode);
  }

  /**
   * Trocar o modo REESCREVE as quantidades da fila inteira.
   *
   * Depois disso cada linha continua editável à mão — é a diferença entre
   * "preencher para mim" e "decidir por mim".
   */
  function trocarModo(id: QuantityModeOption['id']) {
    setMode(id);
    porNaFila(Object.values(itensDaFila), id);
  }

  function mudarQuantidade(id: string, bruto: string) {
    const texto = bruto.replace(/[^\d]/g, '').slice(0, 4);
    setRascunhoQtd((prev) => ({ ...prev, [id]: texto }));
    const n = lerQuantidade(texto);
    if (n !== null) {
      setFila((prev) => ({ ...prev, [id]: n }));
      setCortados((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    }
  }

  /** Ao sair do campo: acima do teto vira 200, zero vira 1, vazio volta ao último valor válido. */
  function fecharQuantidade(id: string) {
    const texto = rascunhoQtd[id];
    if (texto === undefined) return;
    if (/^\d+$/.test(texto)) {
      const n = Math.max(1, Math.min(TETO_POR_ITEM, Number(texto)));
      setFila((prev) => ({ ...prev, [id]: n }));
    }
    setRascunhoQtd((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }

  const plaquinhasNaFila = Object.keys(equipSelecao).length;
  const naFila = Object.keys(fila).length;
  const totalEtiquetas = Object.values(fila).reduce((t, q) => t + q, 0);
  const cabemNaFolha = geometria ? geometria.columns * (geometria.rows ?? 1) : 1;
  const posicaoInicial = (() => {
    /*
      Onde só cabe uma etiqueta por "folha" (o rolo), o campo nem aparece — e
      o valor que ficou de uma folha maior (ex.: 20, na A4 de 33) não pode
      travar "Gerar folha" com um motivo que aponta para um campo escondido.
    */
    if (cabemNaFolha <= 1) return 1;
    const t = comecarEm.trim();
    if (!/^\d+$/.test(t)) return null;
    const n = Number(t);
    return n >= 1 && n <= cabemNaFolha ? n : null;
  })();
  const folhasPrevistas = geometria && totalEtiquetas > 0
    ? Math.ceil((totalEtiquetas + (posicaoInicial ?? 1) - 1) / cabemNaFolha)
    : 0;
  const qtdInvalida = Object.entries(rascunhoQtd).some(([id, t]) => fila[id] !== undefined && lerQuantidade(t) === null);
  const acimaDoTeto = totalEtiquetas > TETO_DA_FOLHA;
  const motivoParaNaoGerar =
    naFila === 0
      ? 'Selecione ao menos um produto.'
      : !formatId
        ? 'Escolha o formato da etiqueta.'
        : qtdInvalida
          ? `Informe a quantidade de cada item: de 1 a ${TETO_POR_ITEM}.`
          : acimaDoTeto
            ? `São ${totalEtiquetas.toLocaleString('pt-BR')} etiquetas e o limite é ${TETO_DA_FOLHA.toLocaleString('pt-BR')} por folha gerada: divida em mais de uma impressão.`
            : posicaoInicial === null
              ? `Posição inicial: de 1 a ${cabemNaFolha}.`
              : null;

  /** O papel que o diálogo do sistema tem de estar usando para o adesivo sair certo. */
  function papelDaImpressao(): string {
    if (modeloAtual) {
      return modeloAtual.midia === 'folha'
        ? `${modeloAtual.paperWidthMm} × ${modeloAtual.paperHeightMm ?? 297} mm`
        : `${modeloAtual.paperWidthMm} × ${modeloAtual.heightMm} mm`;
    }
    if (!formatoAtual) return 'o do formato';
    const f = formatoAtual as LabelFormatOption & { paperWidthMm?: number; paperHeightMm?: number | null; gapXmm?: number };
    if (f.midia === 'folha') return f.paperWidthMm ? `${f.paperWidthMm} × ${f.paperHeightMm ?? 297} mm (Carta)` : 'A4 (210 × 297 mm)';
    return `${Math.round((f.columns * f.widthMm + (f.columns - 1) * (f.gapXmm ?? 0)) * 100) / 100} × ${f.heightMm} mm`;
  }

  async function gerarFolha() {
    const items = Object.entries(fila).map(([productId, quantity]) => ({ productId, quantity }));
    if (motivoParaNaoGerar) {
      setError(motivoParaNaoGerar);
      return;
    }
    setBusy(true);
    setError(null);
    setAvisos([]);
    /*
      A janela abre AGORA, ainda dentro do clique, e recebe o conteúdo depois.
      Abri-la após o `await` faz o navegador tratá-la como pop-up não pedido e
      bloquear — o que acontecia em toda geração, não de vez em quando.
    */
    const janela = window.open('', '_blank');
    try {
      const inicio = posicaoInicial && posicaoInicial > 1 ? { startAt: posicaoInicial } : {};
      // Um modelo da loja vai pelo id dele; um formato pronto, pelo id do formato.
      const r = await coreApi.labelSheet(
        modeloAtual ? { templateId: modeloAtual.id, items, ...inicio } : { formatId, items, ...inicio },
      );
      // O que saiu de verdade, pelo servidor — e não o que a tela calculou.
      const mensagens: string[] = [`Saíram ${r.etiquetas} etiqueta(s) em ${r.folhas} folha(s).`];
      if (janela) {
        janela.document.open();
        janela.document.write(r.html);
        janela.document.close();
        /*
          A IMPRESSORA PREFERIDA É DITA NA HORA DE IMPRIMIR. Ela aparecia só no
          subtítulo, e o diálogo do sistema abre na ÚLTIMA impressora usada —
          a laser do orçamento, e o adesivo saía numa folha comum. Nenhum código
          escolhe a impressora do diálogo; o que se pode é dizer qual escolher.
        */
        mensagens.push(
          `Na janela de impressão, escolha ${modeloAtual?.printerName ? `"${modeloAtual.printerName}"` : 'a impressora de etiqueta'}, `
            + `papel ${papelDaImpressao()}, escala 100 % e sem "ajustar à página".`,
        );
        janela.focus();
        janela.print();
      } else {
        // Sem janela, o arquivo desce como papel a abrir na mão. Melhor que
        // perder a folha que o servidor já montou.
        const url = URL.createObjectURL(new Blob([r.html], { type: 'text/html' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = `etiquetas-${formatId.replace(':', '-')}.html`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
        mensagens.push(
          'O navegador bloqueou a janela de impressão, então a folha foi BAIXADA: abra o arquivo e imprima — '
            + 'ou libere pop-ups para este endereço. Não é preciso gerar de novo.',
        );
      }
      if (r.codigosGerados?.length) {
        mensagens.push(
          `${r.codigosGerados.length} produto(s) ganharam código de barras interno agora: `
            + `${r.codigosGerados.slice(0, 5).map((c) => `${c.name} (${c.barcode})`).join(', ')}.`,
        );
      }
      if (r.semCodigo?.length) {
        mensagens.push(
          `${r.semCodigo.length} item(ns) saíram SEM código de barras: seu acesso não inclui gerar código no cadastro. `
            + `Peça a quem cuida do cadastro para gerar: ${r.semCodigo.slice(0, 5).join(', ')}.`,
        );
      }
      if (r.codigosSemDesenho?.length) {
        mensagens.push(
          `${r.codigosSemDesenho.length} código(s) não viraram barras: `
            + `${r.codigosSemDesenho.slice(0, 5).map((p) => `${p.name} — ${p.motivo}`).join('; ')}`,
        );
      }
      // Os avisos saem todos juntos: mostrar um e engolir o outro faria a
      // pessoa corrigir metade do problema e imprimir de novo.
      if (r.semPreco.length > 0) {
        mensagens.push(
          `${r.semPreco.length} item(ns) saíram com R$ 0,00 — o preço anunciado obriga a loja. ` +
            `Confira o cadastro de: ${r.semPreco.slice(0, 5).join(', ')}.`,
        );
      }
      if (r.promocoes.length > 0) {
        mensagens.push(
          `${r.promocoes.length} item(ns) estão em promoção e a etiqueta saiu com o preço promocional. ` +
            `Quando a promoção acabar, o caixa vai cobrar mais que o papel — reimprima: ${r.promocoes.slice(0, 5).join(', ')}.`,
        );
      }
      setAvisos(mensagens);
    } catch (err) {
      // A janela já foi aberta em branco; deixá-la aberta seria sujeira.
      janela?.close();
      setError(err instanceof ApiRequestError ? err.message : 'Falha ao gerar as etiquetas.');
    } finally {
      setBusy(false);
    }
  }

  async function gerarPlaquinhas() {
    const ids = Object.keys(equipSelecao);
    if (ids.length === 0) {
      setError('Selecione ao menos um equipamento.');
      return;
    }
    setBusy(true);
    setError(null);
    /*
      A janela abre AGORA, dentro do clique — o mesmo cuidado da folha de
      produto. Abri-la depois do `await` faz o navegador tratá-la como pop-up
      não pedido e bloquear.
    */
    const janela = window.open('', '_blank');
    try {
      const res = await apiRequest<ResumoPlaquinha & { html: string }>(
        '/core/labels/equipment/sheet',
        {
          method: 'POST',
          // O `baseUrl` NÃO vai mais daqui: o endereço do QR sai da
          // configuração do servidor. Mandar `window.location.origin` gravava
          // no adesivo o endereço da máquina que imprimiu — que morre na
          // próxima troca de rede.
          body: { equipmentIds: ids, formatId: formatoPlaquinha },
        },
      );
      const { html, ...resumo } = res;
      setResumoPlaquinha(resumo);
      if (janela) {
        janela.document.open();
        janela.document.write(html);
        janela.document.close();
      } else {
        const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = `plaquinhas-${formatoPlaquinha}.html`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
        setError('O navegador bloqueou a janela, então a folha foi baixada.');
      }
    } catch (err) {
      janela?.close();
      setError(err instanceof ApiRequestError ? err.message : 'Falha ao gerar plaquinhas.');
    } finally {
      setBusy(false);
    }
  }

  const listaDaFila = Object.values(itensDaFila).filter((c) => fila[c.productId] !== undefined);
  const listaCortados = Object.entries(cortados).filter(([id]) => fila[id] !== undefined);

  return (
    <AppShell>
      <PageHeader
        breadcrumb={['Produtos', 'Etiquetas']}
        title="Etiquetas"
        subtitle="A folha é desenhada no servidor, em milímetro, e abre em janela própria para imprimir."
        actions={
          tab === 'produtos' ? (
            <Button
              onClick={() => void gerarFolha()}
              loading={busy}
              disabled={motivoParaNaoGerar !== null}
              title={motivoParaNaoGerar ?? undefined}
            >
              Gerar folha {naFila > 0 ? `(${totalEtiquetas})` : ''}
            </Button>
          ) : (
            <Button
              onClick={() => void gerarPlaquinhas()}
              loading={busy}
              disabled={Object.keys(equipSelecao).length === 0}
            >
              Gerar folha {plaquinhasNaFila > 0 ? `(${plaquinhasNaFila})` : ''}
            </Button>
          )
        }
      />

      {error && (
        <div
          role="alert"
          className="mb-5 px-4 py-3 rounded-[var(--gs-radius)] bg-[var(--gs-danger-bg)] text-[var(--gs-danger)]"
        >
          {error}
        </div>
      )}
      {avisos.length > 0 && (
        <div
          role="status"
          data-testid="avisos-da-folha"
          className="mb-5 px-4 py-3 rounded-[var(--gs-radius)] bg-[var(--gs-warning-bg)] text-[var(--gs-text)]"
        >
          <ul className="m-0 pl-5">
            {avisos.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        </div>
      )}

      <div
        role="tablist"
        aria-label="Tipo de etiqueta"
        className="flex gap-1 p-1 bg-[var(--gs-surface-hover)] rounded-[var(--gs-radius)] mb-5 max-w-lg"
      >
        {(
          [
            ['produtos', 'Etiqueta comercial'],
            ['equipamentos', 'Plaquinha de oficina'],
          ] as [Tab, string][]
        ).map(([id, label]) => (
          <button
            key={id}
            role="tab"
            type="button"
            aria-selected={tab === id}
            disabled={id === 'equipamentos' && !isWorkshop}
            onClick={() => {
              setTab(id);
              setError(null);
              setAvisos([]);
              setResumoPlaquinha(null);
            }}
            className={`flex-1 px-3 py-2 rounded-[var(--gs-radius-sm)] border-0 cursor-pointer
              text-[length:var(--gs-text-sm)] font-semibold disabled:opacity-40
              disabled:cursor-not-allowed ${
                tab === id
                  ? 'bg-[var(--gs-surface)] text-[var(--gs-purple-800)] shadow-[var(--gs-shadow-sm)]'
                  : 'bg-transparent text-[var(--gs-muted)]'
              }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'produtos' && (
        <>
          <ModelosDeEtiqueta podeEditar={podeConfigurar} formatosProntos={formats} onMudou={aoMudarModelos} />

          <Card title="De onde vêm os produtos" subtitle={origemAtual?.hint} className="mb-5">
            <div className="flex flex-wrap gap-2 mb-4">
              {sources.map((s) => (
                <Button
                  key={s.id}
                  variant={s.id === source ? 'primary' : 'secondary'}
                  size="sm"
                  onClick={() => trocarOrigem(s.id)}
                >
                  {s.label}
                </Button>
              ))}
            </div>

            {source === 'catalogo' && (
              <SearchInput
                value={busca}
                onChange={setBusca}
                placeholder="Nome, código interno ou código de barras"
              />
            )}

            {source === 'estoque' && (
              <label className="flex items-center gap-2 text-[length:var(--gs-text-sm)]">
                <input
                  type="checkbox"
                  checked={lowOnly}
                  onChange={(e) => setLowOnly(e.target.checked)}
                />
                Só o que está abaixo do estoque mínimo
              </label>
            )}

            {source === 'codigos' && (
              <div className="flex flex-col gap-2">
                <textarea
                  value={codigos}
                  onChange={(e) => setCodigos(e.target.value)}
                  rows={5}
                  placeholder={'GS-000001\nGS-000002\n7891234567895'}
                  aria-label="Códigos, um por linha"
                  className="w-full p-3 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)]
                    bg-[var(--gs-surface)] text-[var(--gs-text)] font-mono text-[length:var(--gs-text-sm)]"
                />
                <div>
                  <Button variant="secondary" onClick={() => void carregar()}>
                    Resolver códigos
                  </Button>
                </div>
              </div>
            )}

            {(source === 'compra' || source === 'nota' || source === 'inventario' || source === 'grade') && (
              <SeletorDeDocumento
                source={source}
                onEscolher={(extra) => void carregar(extra)}
                onErro={setError}
              />
            )}
          </Card>

          {achados && (
            <Card
              title="Produtos encontrados"
              subtitle={
                achados.truncado
                  ? 'Mostrando os primeiros 300 — refine a busca para ver o resto.'
                  : 'Marque o que vai para a fila. A fila guarda o que você marcou entre uma busca e outra.'
              }
              actions={
                achados.candidates.length > 0 ? (
                  <Button variant="ghost" size="sm" onClick={todos}>
                    Marcar todos
                  </Button>
                ) : undefined
              }
              className="mb-5"
            >
              {achados.problemas.length > 0 && (
                <div className="mb-4 px-4 py-3 rounded-[var(--gs-radius)] bg-[var(--gs-warning-bg)]">
                  <p className={`${ROTULO} mb-1`}>
                    {achados.problemas.length} item(ns) não podem ser etiquetados:
                  </p>
                  <ul className="m-0 pl-5 text-[length:var(--gs-text-sm)]">
                    {achados.problemas.map((p, i) => (
                      <li key={i}>
                        <strong>{p.descricao}</strong> — {p.motivo}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {achados.candidates.length === 0 ? (
                <EmptyState
                  title="Nada para etiquetar"
                  description="Nenhum produto veio desta origem."
                />
              ) : (
                <div className="overflow-x-auto max-h-[380px] overflow-y-auto">
                  <table className="w-full text-[length:var(--gs-text-sm)]">
                    <thead>
                      <tr className="text-left text-[var(--gs-text-soft)] border-b border-[var(--gs-border)]">
                        <th className="py-2.5 px-3 font-semibold w-8" />
                        <th className="py-2.5 px-3 font-semibold">Produto</th>
                        <th className="py-2.5 px-3 font-semibold">Código</th>
                        <th className="py-2.5 px-3 font-semibold text-right">Preço na etiqueta</th>
                        <th className="py-2.5 px-3 font-semibold text-right">Saldo</th>
                        <th className="py-2.5 px-3 font-semibold text-right">Etiquetas</th>
                      </tr>
                    </thead>
                    <tbody>
                      {achados.candidates.map((c) => (
                        <tr
                          key={c.productId}
                          className="border-b border-[var(--gs-border)] last:border-0"
                        >
                          <td className="py-2 px-3">
                            <input
                              type="checkbox"
                              checked={fila[c.productId] !== undefined}
                              onChange={() => alternar(c)}
                              aria-label={`Selecionar ${c.name}`}
                            />
                          </td>
                          <td className="py-2 px-3">
                            {c.name}{' '}
                            {/* DEFEITO QUE ISTO CORRIGE (C-etiquetas-R01): o selo olhava só
                                "sem código" e prometia "gera código ao imprimir" também no
                                cartaz de gôndola (formato sem barras nem número: o servidor
                                não gera nada) e para quem não tem products.manage (a folha
                                sai SEM barras). Agora ele segue a mesma regra do servidor. */}
                            {!c.barcode && formatoImprimeCodigo && podeGerarCodigo && (
                              <Badge tone="warning">gera código ao imprimir</Badge>
                            )}
                            {!c.barcode && formatoImprimeCodigo && !podeGerarCodigo && (
                              <Badge tone="warning">sem código — sai sem barras</Badge>
                            )}
                            {c.avisoDoCodigo && (
                              <span className="block text-[length:var(--gs-text-xs)] text-[var(--gs-danger)]">
                                {c.avisoDoCodigo}
                              </span>
                            )}
                          </td>
                          <td className="py-2 px-3 font-mono text-[length:var(--gs-text-xs)]">
                            {c.internalCode}
                          </td>
                          <td className="py-2 px-3 text-right tabular-nums">
                            {c.priceCents > 0 ? (
                              <>
                                {formatCents(c.priceCents)}
                                {/* O preço que SAI na etiqueta é o vigente: com promoção, a
                                    fila diz as duas coisas antes de imprimir. */}
                                {c.onSale && typeof c.listPriceCents === 'number' && (
                                  <span className="block text-[length:var(--gs-text-xs)] text-[var(--gs-text-soft)]">
                                    promoção; tabela {formatCents(c.listPriceCents)}
                                  </span>
                                )}
                              </>
                            ) : (
                              <Badge tone="danger">sem preço</Badge>
                            )}
                          </td>
                          <td className="py-2 px-3 text-right tabular-nums text-[var(--gs-text-soft)]">
                            {formatQuantity(c.stockQuantity)}
                          </td>
                          <td className="py-2 px-3 text-right tabular-nums">
                            {fila[c.productId] !== undefined ? fila[c.productId] : ''}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          )}

          {listaDaFila.length > 0 && (
            <Card title="Na fila" subtitle="É isto que vai para o papel. Ajuste a quantidade ou tire um item." className="mb-5">
              <ul className="list-none m-0 p-0 divide-y divide-[var(--gs-border)]" aria-label="Itens na fila">
                {listaDaFila.map((c) => (
                  <li key={c.productId} className="flex items-center gap-3 py-2 flex-wrap">
                    <span className="flex-1 min-w-[12rem]">
                      {c.name}{' '}
                      <span className="font-mono text-[length:var(--gs-text-xs)] text-[var(--gs-text-soft)]">{c.internalCode}</span>
                    </span>
                    <input
                      type="text"
                      inputMode="numeric"
                      value={rascunhoQtd[c.productId] ?? String(fila[c.productId])}
                      onChange={(e) => mudarQuantidade(c.productId, e.target.value)}
                      onBlur={() => fecharQuantidade(c.productId)}
                      aria-label={`Quantidade de etiquetas de ${c.name}`}
                      aria-invalid={rascunhoQtd[c.productId] !== undefined && lerQuantidade(rascunhoQtd[c.productId]) === null}
                      className="w-20 px-2 py-1 text-right rounded-[var(--gs-radius-sm)]
                        border border-[var(--gs-border-strong)]"
                    />
                    <Button size="sm" variant="ghost" onClick={() => tirarDaFila(c.productId)} aria-label={`Tirar ${c.name} da fila`}>
                      Tirar
                    </Button>
                  </li>
                ))}
              </ul>
              {/* DEFEITO QUE ISTO CORRIGE: com só "Etiquetas de produto", a folha sai
                  SEM barras para o produto sem código (gravar código é do cadastro,
                  products.manage) — e a tela só dizia isso DEPOIS de imprimir. */}
              {/* E só quando o formato escolhido IMPRIME código (barras ou número): o
                  servidor só precisa do código nesse caso (`precisaDeCodigo` de
                  buildLabels). Numa etiqueta só de nome e preço o aviso era falso. */}
              {!podeGerarCodigo && formatoImprimeCodigo && listaDaFila.some((c) => !c.barcode) && (
                <p data-testid="aviso-sem-codigo" className="mt-3 mb-0 text-[length:var(--gs-text-sm)] text-[var(--gs-warning)]">
                  Sem código de barras:{' '}
                  {listaDaFila
                    .filter((c) => !c.barcode)
                    .slice(0, 5)
                    .map((c) => c.name)
                    .join(', ')}
                  . Seu acesso imprime etiquetas, mas não grava código no cadastro: estas saem SEM barras. Peça a quem
                  cuida do cadastro para gerar o código (Produtos › o produto › Gerar código de barras) e imprima depois.
                </p>
              )}
              {listaCortados.length > 0 && (
                <p data-testid="aviso-do-teto" className="mt-3 mb-0 text-[length:var(--gs-text-sm)] text-[var(--gs-warning)]">
                  {listaCortados.length} item(ns) passavam de {TETO_POR_ITEM} etiquetas e ficaram em {TETO_POR_ITEM}, o
                  máximo por item:{' '}
                  {listaCortados
                    .slice(0, 5)
                    .map(([id, bruta]) => `${itensDaFila[id]?.name ?? id} (${mode === 'saldo' ? 'saldo' : 'documento'} ${bruta})`)
                    .join(', ')}
                  . Gere outra folha para o restante.
                </p>
              )}
            </Card>
          )}

          <Card
            title="Formato e quantidade"
            subtitle={
              geometria
                ? `${geometria.widthMm} × ${geometria.heightMm} mm · ${geometria.columns} por linha${modeloAtual?.printerName ? ` · impressora: ${modeloAtual.printerName}` : ''}`
                : undefined
            }
          >
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              <div className="flex flex-col gap-2">
                <label className="flex flex-col gap-1.5">
                  <span className={ROTULO}>Formato da etiqueta</span>
                  <select
                    aria-label="Formato da etiqueta"
                    value={formatId}
                    onChange={(e) => {
                      escolhidoAMao.current = true;
                      setFormatId(e.target.value);
                    }}
                    className={CAIXA_SELECT}
                  >
                    {/* Sem formato, o seletor diz isso — e não mostra uma opção que o servidor não vai usar. */}
                    <option value="" disabled>
                      Escolha o formato
                    </option>
                    {modelos.length > 0 && (
                      <optgroup label="Modelos da loja">
                        {modelos.map((m) => (
                          <option key={m.id} value={`modelo:${m.id}`}>
                            {m.name} — {m.widthMm} × {m.heightMm} mm, {m.columns} col.
                          </option>
                        ))}
                      </optgroup>
                    )}
                    <optgroup label="Formatos prontos">
                      {formats.map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.label}
                        </option>
                      ))}
                    </optgroup>
                  </select>
                </label>
                {formatoAtual && (
                  <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] m-0">
                    {formatoAtual.hint}
                  </p>
                )}
                {cabemNaFolha > 1 && (
                  <label className="flex flex-col gap-1.5">
                    <span className={ROTULO}>Começar na posição</span>
                    <input
                      type="text"
                      inputMode="numeric"
                      value={comecarEm}
                      onChange={(e) => setComecarEm(e.target.value.replace(/[^\d]/g, '').slice(0, 3))}
                      aria-label="Começar na posição"
                      aria-invalid={posicaoInicial === null}
                      className="w-24 h-10 px-3 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)]"
                    />
                    <span className="text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
                      Para reaproveitar uma folha já usada: as posições antes desta (de 1 a {cabemNaFolha}, da esquerda para a
                      direita, de cima para baixo) ficam em branco.
                    </span>
                  </label>
                )}
              </div>

              <div className="flex flex-col gap-2">
                <span className={ROTULO}>Quantas etiquetas de cada item</span>
                <div className="flex flex-wrap gap-2">
                  {modes.map((m) => {
                    // Desabilitar com MOTIVO escrito, em vez de sumir com a
                    // opção: sumir faz parecer que ela nunca existiu.
                    const indisponivel =
                      m.id === 'documento' && !origemAtual?.temQuantidadeDeDocumento;
                    return (
                      <Button
                        key={m.id}
                        variant={m.id === mode ? 'primary' : 'secondary'}
                        size="sm"
                        disabled={indisponivel}
                        title={
                          indisponivel
                            ? 'Esta origem não vem de um documento com quantidade.'
                            : m.hint
                        }
                        onClick={() => trocarModo(m.id)}
                      >
                        {m.label}
                      </Button>
                    );
                  })}
                </div>
                <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] m-0">
                  {modes.find((m) => m.id === mode)?.hint}
                </p>
              </div>
            </div>

            {naFila > 0 && (
              <p className="mt-4 mb-0 text-[length:var(--gs-text-sm)]">
                <strong>{naFila}</strong> produto(s) na fila ·{' '}
                <strong>{totalEtiquetas}</strong> etiqueta(s) ·{' '}
                <strong>{folhasPrevistas}</strong> folha(s)
              </p>
            )}
            {motivoParaNaoGerar && naFila > 0 && (
              <p data-testid="motivo-para-nao-gerar" className="mt-2 mb-0 text-[length:var(--gs-text-sm)] text-[var(--gs-danger)]">
                {motivoParaNaoGerar}
              </p>
            )}
          </Card>
        </>
      )}

      {tab === 'equipamentos' && (
        <>
          <Card title="Selecione os equipamentos" className="mb-5" padded={false}>
            <div className="max-h-[320px] overflow-y-auto">
              {equipment.length === 0 ? (
                <EmptyState
                  title="Nada para etiquetar"
                  description="Cadastre equipamentos na oficina para gerar as plaquinhas."
                />
              ) : (
                <ul className="list-none m-0 p-0">
                  {equipment.map((item) => {
                    // O rótulo pode não vir do servidor; sem o alternativo o
                    // leitor de tela anunciava "Selecionar equipamento undefined".
                    const etiqueta = item.publicIdLabel ?? `#${item.public_id}`;
                    return (
                      <li
                        key={item.id}
                        className="flex items-center gap-3 px-4 py-3 border-b border-[var(--gs-border)] last:border-0"
                      >
                        <input
                          type="checkbox"
                          checked={Boolean(equipSelecao[item.id])}
                          onChange={() =>
                            setEquipSelecao((prev) => {
                              const next = { ...prev };
                              if (next[item.id]) delete next[item.id];
                              else next[item.id] = 1;
                              return next;
                            })
                          }
                          aria-label={`Selecionar equipamento ${etiqueta}`}
                        />
                        <strong className="text-[var(--gs-purple-800)] w-20">{etiqueta}</strong>
                        <span className="flex-1 text-[var(--gs-text-soft)]">
                          {[item.brand, item.model].filter(Boolean).join(' ') ||
                            'Sem identificação'}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </Card>

          {formatosPlaquinha.length > 0 && (
            <Card title="Formato da plaquinha" className="mb-5">
              <div className="flex flex-wrap gap-3 items-center">
                <select
                  aria-label="Formato da plaquinha"
                  value={formatoPlaquinha}
                  onChange={(e) => setFormatoPlaquinha(e.target.value)}
                  className={CAIXA_SELECT}
                >
                  {formatosPlaquinha.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.label}
                    </option>
                  ))}
                </select>
                <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                  {formatosPlaquinha.find((f) => f.id === formatoPlaquinha)?.hint}
                </span>
              </div>
            </Card>
          )}

          {/*
            A PRÉ-VISUALIZAÇÃO ANTES DE GASTAR ADESIVO.

            Aqui não se desenha mais a plaquinha: ela é montada no servidor, em
            milímetro, e abre em janela própria para imprimir — como a folha de
            etiqueta de produto já faz. O que fica é o que a pessoa precisa
            conferir ANTES: quantas folhas, que tamanho o QR terá, e para onde
            ele aponta.

            O endereço importa mais do que parece: o adesivo fica colado no
            equipamento por anos, e um QR apontando para o lugar errado só é
            descoberto quando um cliente tenta escanear.
          */}
          {resumoPlaquinha && (
            <Card title="Antes de imprimir">
              <p className="m-0">
                <strong>{resumoPlaquinha.plaquinhas}</strong> plaquinha(s) em{' '}
                <strong>{resumoPlaquinha.folhas}</strong> folha(s) · QR de{' '}
                {resumoPlaquinha.qrMm} mm ({resumoPlaquinha.moduloMm} mm por módulo)
              </p>
              <p className="m-0 mt-1 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                O QR aponta para <code>{resumoPlaquinha.baseUrl}</code>
                {!resumoPlaquinha.baseUrlConfigurada && (
                  <>
                    {' '}
                    — <strong>endereço de reserva</strong>. Configure o endereço público
                    antes de imprimir em quantidade.
                  </>
                )}
              </p>
              {resumoPlaquinha.abaixoDoPiso && (
                <p className="m-0 mt-2 text-[var(--gs-danger)]">
                  Neste formato o módulo do QR fica abaixo de 0,5 mm. Celular comum pode
                  não ler — prefira um formato maior.
                </p>
              )}
              {resumoPlaquinha.problemas.length > 0 && (
                <div className="mt-2">
                  <p className="m-0 text-[length:var(--gs-text-sm)] font-semibold">
                    Fora da folha ({resumoPlaquinha.problemas.length}):
                  </p>
                  <ul className="m-0 mt-1 pl-4 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                    {resumoPlaquinha.problemas.map((p) => (
                      <li key={p.equipmentId}>{p.motivo}</li>
                    ))}
                  </ul>
                </div>
              )}
            </Card>
          )}
        </>
      )}
    </AppShell>
  );
}

/**
 * Escolha do documento de origem — pedido de compra, nota de entrada, contagem
 * ou modelo.
 *
 * Fica separado porque as origens compartilham a mesma forma: uma busca, uma
 * lista, e um clique que carrega os itens.
 */
function SeletorDeDocumento({
  source,
  onEscolher,
  onErro,
}: {
  source: 'compra' | 'nota' | 'inventario' | 'grade';
  onEscolher: (extra: Documento) => void;
  onErro: (m: string) => void;
}) {
  const [opcoes, setOpcoes] = useState<{ id: string; rotulo: string }[]>([]);
  const [carregou, setCarregou] = useState(false);
  const [termo, setTermo] = useState('');

  useEffect(() => {
    setCarregou(false);
    void (async () => {
      try {
        if (source === 'compra') {
          const r = await apiRequest<{ items: Record<string, unknown>[] }>('/core/purchase-orders').then((r) => exigirCampos(r, 'items'));
          setOpcoes(
            r.items.map((o) => ({
              id: String(o.id),
              rotulo: `Pedido ${o.number} · ${String(o.supplier_name ?? '')} · ${String(o.status)}`,
            })),
          );
        } else if (source === 'nota') {
          // Só as notas CONFIRMADAS: em conferência nada entrou no estoque, e a
          // estornada saiu dele — o servidor recusa as duas dizendo por quê.
          const r = await apiRequest<{ items: Record<string, unknown>[] }>('/core/purchases/notes').then((r) => exigirCampos(r, 'items'));
          setOpcoes(
            r.items
              .filter((o) => String(o.status) === 'recebida')
              .map((o) => {
                const quando = o.received_at ? new Date(String(o.received_at)).toLocaleDateString('pt-BR') : '';
                return {
                  id: String(o.id),
                  rotulo: `${String(o.doc_type) === 'manual' ? 'Entrada manual' : 'NF-e'} ${String(o.number ?? '')} · `
                    + `${String(o.supplier_name ?? '')}${quando ? ` · recebida em ${quando}` : ''}`,
                };
              }),
          );
        } else if (source === 'inventario') {
          // `/core/inventory-counts`, com hífen. O caminho com barra devolve
          // 404, e isso só apareceu abrindo a tela — nenhum teste de servidor
          // conhece o caminho que o cliente digita.
          const r = await apiRequest<{ items: Record<string, unknown>[] }>('/core/inventory-counts').then((r) => exigirCampos(r, 'items'));
          setOpcoes(
            r.items.map((o) => ({
              id: String(o.id),
              rotulo: `Contagem ${o.number} · ${String(o.status)}`,
            })),
          );
        }
      } catch (err) {
        onErro(err instanceof ApiRequestError ? err.message : 'Falha ao carregar a lista.');
      } finally {
        // Marca depois do sucesso E do erro: sem isto, a mensagem de "nenhum
        // documento" apareceria durante o carregamento e piscaria na tela.
        setCarregou(true);
      }
    })();
  }, [source, onErro]);

  if (source === 'grade') {
    return (
      <div className="flex flex-col gap-2">
        <SearchInput
          value={termo}
          onChange={setTermo}
          placeholder="Busque o modelo e escolha para trazer a grade"
        />
        <BuscaDeModelo termo={termo} onEscolher={(id) => onEscolher({ productId: id })} />
      </div>
    );
  }

  /*
    Lista vazia é dita com todas as letras. Um seletor com só "Escolha…" é
    indistinguível de um seletor que falhou ao carregar — e quem está na tela
    fica esperando algo que não vem.
  */
  if (carregou && opcoes.length === 0) {
    return (
      <p className="m-0 text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
        {source === 'compra'
          ? 'Nenhum pedido de compra nesta empresa. Crie um em Compras › Pedidos.'
          : source === 'nota'
            ? 'Nenhuma nota de entrada confirmada nesta empresa. Confirme a entrada em Compras › Entrada de notas.'
            : 'Nenhuma contagem de inventário nesta empresa. Abra uma em Estoque › Inventário.'}
      </p>
    );
  }

  const rotulo = source === 'compra' ? 'Pedido de compra' : source === 'nota' ? 'Nota de entrada' : 'Contagem';
  return (
    <label className="flex flex-col gap-1.5">
      <span className={ROTULO}>{rotulo}</span>
      <select
        className={CAIXA_SELECT}
        aria-label={rotulo}
        defaultValue=""
        onChange={(e) => {
          if (!e.target.value) return;
          onEscolher(
            source === 'compra'
              ? { purchaseOrderId: e.target.value }
              : source === 'nota'
                ? { noteId: e.target.value }
                : { countId: e.target.value },
          );
        }}
      >
        <option value="">Escolha…</option>
        {opcoes.map((o) => (
          <option key={o.id} value={o.id}>
            {o.rotulo}
          </option>
        ))}
      </select>
    </label>
  );
}

function BuscaDeModelo({ termo, onEscolher }: { termo: string; onEscolher: (id: string) => void }) {
  const [itens, setItens] = useState<{ id: string; name: string }[]>([]);

  useEffect(() => {
    if (termo.trim().length < 2) {
      setItens([]);
      return;
    }
    const t = setTimeout(() => {
      void coreApi
        .listProducts(termo.trim())
        .then((r) => setItens(r.slice(0, 8).map((p) => ({ id: p.id, name: p.name }))))
        .catch(() => setItens([]));
    }, 300);
    return () => clearTimeout(t);
  }, [termo]);

  if (itens.length === 0) return null;
  return (
    <ul className="border border-[var(--gs-border)] rounded-[var(--gs-radius)] divide-y divide-[var(--gs-border)] list-none m-0 p-0">
      {itens.map((i) => (
        <li key={i.id}>
          <button
            type="button"
            onClick={() => onEscolher(i.id)}
            className="w-full text-left px-4 py-2.5 bg-transparent border-0 cursor-pointer
              hover:bg-[var(--gs-surface-hover)]"
          >
            {i.name}
          </button>
        </li>
      ))}
    </ul>
  );
}
