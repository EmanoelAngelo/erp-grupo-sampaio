/**
 * Importação de planilha — a loja nova nascendo com catálogo E saldo.
 *
 * ## O molde é o da entrada de notas, e de propósito
 *
 * `EntradaNotasPage` já resolveu a forma deste problema: o arquivo sobe, vira
 * uma lista conferível, e o estoque só se mexe quando alguém clica em
 * confirmar. Inventar aqui um segundo desenho para o mesmo gesto obrigaria
 * quem monta a loja a aprender duas telas para uma coisa só.
 *
 * O que MUDA é a desconfiança. A NF-e é documento de terceiro, conferido na
 * doca com a mercadoria à vista, item a item. A planilha é um arquivo que a
 * própria loja digitou, com duzentas linhas que ninguém vai reler — e o que
 * ela cria é o catálogo INTEIRO de uma operação. Por isso esta tela é mais
 * barulhenta que a da nota: ela precisa dizer, antes do clique, o que a loja
 * vai ganhar de errado se ninguém olhar.
 *
 * ## As duas frases que são o motivo desta tela existir
 *
 * Uma importação que só diz "200 produtos criados" entrega uma loja que
 * parece pronta e não é:
 *
 *   - produto SEM SALDO não vende. `applyMovement` recusa saída de estoque que
 *     não existe, e o PDV devolve a venda no balcão, com o cliente na frente.
 *   - produto SEM PREÇO vende de graça. Zero é preço legítimo (brinde), então
 *     o caixa não recusa nada: o cupom fecha, o estoque baixa e a loja não
 *     recebe. Ninguém descobre até o fechamento do dia.
 *
 * As duas contagens ficam no rodapé com destaque de aviso e explicadas POR
 * EXTENSO. Sem elas a tela promete uma loja pronta e entrega uma que não
 * vende — ou uma que vende sem cobrar.
 *
 * ## O arquivo sobe como BYTES
 *
 * `file.text()` decodifica SEMPRE como UTF-8. Um CSV salvo pelo Excel pt-BR é
 * windows-1252, e o acento morreria dentro do navegador, antes de qualquer
 * requisição — o servidor receberia "PARAFUSO SEXTAVADO 5/16" já sem o "Ç" e
 * não teria como saber que houve perda. Aqui vão os bytes crus em base64, e
 * quem decide a codificação é o servidor, que guarda os bytes e pode reler.
 *
 * ## Detectou errado custa um clique
 *
 * Codificação, separador e mapa de colunas aparecem como seletor, sempre à
 * vista. Trocar qualquer um chama `PUT .../leitura` e a tela se redesenha
 * sobre os MESMOS bytes. A alternativa — corrigir a planilha e subir de novo —
 * é o que faz alguém desistir da importação e cadastrar à mão.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppShell } from '@/components/gs/AppShell';
import { Badge, Button, Card, DataTable, EmptyState, PageHeader } from '@/components/gs/ui';
import { formatCents, formatQuantity } from '@/components/gs/format';
import { ApiRequestError, apiRequest, exigirCampos } from '@/lib/api/client';
import { useHasProfile } from '@/hooks/useSession';
import { dataBR } from '@/lib/datas';

type CampoImportado =
  | 'nome'
  | 'codigo_barras'
  | 'codigo_interno'
  | 'unidade'
  | 'preco'
  | 'custo'
  | 'quantidade';

/**
 * O mapa guarda ÍNDICE de coluna, nunca nome — a mesma decisão do servidor.
 *
 * Planilha de verdade tem cabeçalho repetido: duas colunas "preco", uma de
 * custo e uma de venda. Por nome as duas seriam a mesma coisa, e o remapeamento
 * manual — justamente o que salva esse arquivo — ficaria impossível de
 * expressar. O índice é sempre único, e é ele que a tela mostra ao lado do
 * texto do cabeçalho.
 */
type MapaDeColunas = Partial<Record<CampoImportado, number>>;

type EncodingCsv = 'utf-8' | 'windows-1252';
type SeparadorCsv = ';' | ',' | '\t';

interface ResumoDoLote {
  id: string;
  nomeArquivo: string;
  encoding: EncodingCsv;
  separador: SeparadorCsv;
  cabecalho: string[];
  mapa: MapaDeColunas;
  status: string;
  totalLinhas: number;
  novos: number;
  existentes: number;
  comSaldo: number;
  semSaldo: number;
  semPreco: number;
  erros: number;
  jaImportado: { id: string; confirmadoEm: string; criados: number; comSaldo: number } | null;
}

interface ItemDoLote {
  id: string;
  linha: number;
  nome: string | null;
  codigoBarras: string | null;
  codigoInterno: string | null;
  unidade: string | null;
  precoCents: number | null;
  custoCents: number | null;
  quantidade: number | null;
  produtoId: string | null;
  acao: 'novo' | 'existe' | 'erro';
  erroCodigo: string | null;
  erroDetalhe: string | null;
}

/** Uma linha do histórico, como `listarLotes` a devolve (colunas do banco). */
interface LoteNaLista {
  id: string;
  filename: string;
  status: string;
  created_at: string;
  confirmed_at: string | null;
  created_products: number | null;
  moved_products: number | null;
  skipped_rows: number | null;
}

/**
 * Cem por página, o mesmo teto que a rota usa por padrão.
 *
 * O limite do lote é de cinco mil linhas. Jogar cinco mil `<tr>` no DOM trava
 * exatamente a tela em que a pessoa mais precisa enxergar — e o travamento
 * apareceria na loja com a maior planilha, que é a que mais precisa disto.
 */
const POR_PAGINA = 100;

/**
 * Os rótulos dos campos, na ordem em que a pessoa pensa a planilha.
 *
 * Nome primeiro porque é o único campo sem o qual a linha não existe; a
 * quantidade por último porque é a que decide se a loja vende ou não, e é a
 * última coisa que se confere antes de confirmar.
 */
const CAMPOS: { campo: CampoImportado; rotulo: string }[] = [
  { campo: 'nome', rotulo: 'Nome do produto' },
  { campo: 'codigo_barras', rotulo: 'Código de barras' },
  { campo: 'codigo_interno', rotulo: 'Código interno' },
  { campo: 'unidade', rotulo: 'Unidade' },
  { campo: 'preco', rotulo: 'Preço de venda' },
  { campo: 'custo', rotulo: 'Custo' },
  { campo: 'quantidade', rotulo: 'Quantidade em estoque' },
];

/**
 * Os rótulos dizem de ONDE o arquivo veio, não o nome técnico.
 *
 * "windows-1252" não significa nada para quem exportou do Excel; "Excel
 * brasileiro" significa. Quem chega nesta tela porque os acentos vieram
 * quebrados precisa reconhecer a própria origem do arquivo na lista, e não
 * adivinhar entre dois códigos.
 */
const ENCODINGS: { valor: EncodingCsv; rotulo: string }[] = [
  { valor: 'utf-8', rotulo: 'UTF-8 — exportado de sistema ou salvo pela web' },
  { valor: 'windows-1252', rotulo: 'Windows-1252 — CSV salvo pelo Excel brasileiro' },
];

const SEPARADORES: { valor: SeparadorCsv; rotulo: string }[] = [
  { valor: ';', rotulo: 'Ponto e vírgula ( ; ) — Excel brasileiro' },
  { valor: ',', rotulo: 'Vírgula ( , ) — exportação estrangeira' },
  { valor: '\t', rotulo: 'Tabulação — colado direto da planilha' },
];

/**
 * Bytes crus para base64, em blocos.
 *
 * `String.fromCharCode(...bytes)` com o array inteiro estoura a pilha de
 * chamadas num arquivo de 2 MB — o teto que o servidor aceita. O erro sairia
 * como "Maximum call stack size exceeded" na tela de importação, que é o tipo
 * de mensagem que ninguém liga ao arquivo grande.
 */
function paraBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const BLOCO = 0x8000;
  let binario = '';
  for (let i = 0; i < bytes.length; i += BLOCO) {
    binario += String.fromCharCode(...bytes.subarray(i, i + BLOCO));
  }
  return btoa(binario);
}

/** Data legível. Sem hora: o que importa no aviso é o DIA em que já entrou. */
function dataCurta(iso: string): string {
  const d = new Date(iso);
  return dataBR(iso, iso);
}

export default function ImportacaoPlanilhaPage() {
  const arquivoRef = useRef<HTMLInputElement>(null);
  const [lotes, setLotes] = useState<LoteNaLista[]>([]);
  const [resumo, setResumo] = useState<ResumoDoLote | null>(null);
  const [itens, setItens] = useState<ItemDoLote[]>([]);
  const [total, setTotal] = useState(0);
  const [pagina, setPagina] = useState(0);
  const [apenasErros, setApenasErros] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const [mensagem, setMensagem] = useState<{ tom: 'ok' | 'erro' | 'info'; texto: string } | null>(
    null,
  );

  /**
   * O segundo clique, armado.
   *
   * Não é confirmação por educação: é o único ponto em que a pessoa lê o que
   * vai ser DESCARTADO (as linhas com erro) ou o que vai ser DUPLICADO (o
   * arquivo já importado antes) com o número na frente dela. Some sozinho a
   * cada releitura, porque uma releitura muda exatamente esses números.
   */
  const [armado, setArmado] = useState(false);

  /*
    QUEM CONFIRMA É A GERÊNCIA — espelho exato do guarda do servidor.

    `POST /core/import/produtos/:id/confirmar` exige `gerente_loja` ou
    `gerente_oficina` (com `admin_geral` e `gestor` por cima, dentro de
    `requireProfile`). O estoquista sobe, relê, remapeia e descarta — tudo o
    que a rota deixa —, mas confirmar cria o catálogo inteiro e move estoque.

    O botão SOME para ele em vez de aparecer desabilitado: botão apagado sem
    explicação vira chamado, e a linha de texto que fica no lugar diz de quem é
    a decisão. Oferecer o clique para receber 403 é a porta que bate na cara,
    o defeito que a rodada 23 proibiu.
  */
  const podeConfirmar = useHasProfile('gerente_loja', 'gerente_oficina');

  const carregarLotes = useCallback(async () => {
    try {
      const r = await apiRequest<{ items: LoteNaLista[] }>('/core/import/produtos').then(
        (x) => exigirCampos(x, 'items'),
      );
      setLotes(r.items);
    } catch (err) {
      setMensagem({
        tom: 'erro',
        texto: err instanceof ApiRequestError ? err.message : 'Falha ao listar as importações.',
      });
    }
  }, []);

  useEffect(() => {
    void carregarLotes();
  }, [carregarLotes]);

  const carregarItens = useCallback(
    async (batchId: string, paginaAlvo: number, soErros: boolean) => {
      try {
        const busca = new URLSearchParams({
          limit: String(POR_PAGINA),
          offset: String(paginaAlvo * POR_PAGINA),
        });
        if (soErros) busca.set('apenasErros', '1');
        const r = await apiRequest<{ itens: ItemDoLote[]; total: number }>(
          `/core/import/produtos/${batchId}/itens?${busca.toString()}`,
        );
        setItens(r.itens);
        setTotal(r.total);
      } catch (err) {
        setMensagem({
          tom: 'erro',
          texto: err instanceof ApiRequestError ? err.message : 'Falha ao listar as linhas.',
        });
      }
    },
    [],
  );

  useEffect(() => {
    if (!resumo) return;
    void carregarItens(resumo.id, pagina, apenasErros);
  }, [resumo, pagina, apenasErros, carregarItens]);

  /**
   * O arquivo vira BYTES, nunca texto.
   *
   * Ver a nota do cabeçalho: `file.text()` já teria destruído o acento aqui
   * dentro, sem erro nenhum, e o servidor não teria como saber. `arrayBuffer`
   * entrega o que estava no disco, e o seletor de codificação passa a ter o
   * que corrigir.
   */
  const enviarArquivo = async (evento: React.ChangeEvent<HTMLInputElement>) => {
    const arquivo = evento.target.files?.[0];
    if (!arquivo) return;
    setOcupado(true);
    setMensagem(null);
    try {
      const bytes = await arquivo.arrayBuffer();
      const novo = await apiRequest<ResumoDoLote>('/core/import/produtos', {
        method: 'POST',
        body: { arquivo: paraBase64(bytes), nomeArquivo: arquivo.name },
      });
      setArmado(false);
      setApenasErros(false);
      setPagina(0);
      setResumo(novo);
      setMensagem({
        tom: 'info',
        texto: 'Planilha lida. Confira o que o sistema entendeu antes de criar os produtos.',
      });
      await carregarLotes();
    } catch (err) {
      setMensagem({
        tom: 'erro',
        texto: err instanceof ApiRequestError ? err.message : 'Falha ao ler a planilha.',
      });
    } finally {
      setOcupado(false);
      if (arquivoRef.current) arquivoRef.current.value = '';
    }
  };

  /**
   * Relê os MESMOS bytes com outra instrução de leitura.
   *
   * Nada do que a tela mostra é fonte de dado: o navegador diz COMO ler, e
   * quem lê continua sendo o servidor, sobre o arquivo que ele guardou. É o
   * que faz "detectou o separador errado" custar um clique.
   *
   * Trocar separador ou codificação NÃO manda mapa de propósito: as colunas
   * passam a ser outras, e reaproveitar índices do arquivo lido errado
   * apontaria "preço" para uma coluna de nome.
   */
  const reler = async (mudanca: {
    separador?: SeparadorCsv;
    encoding?: EncodingCsv;
    mapa?: MapaDeColunas;
  }) => {
    if (!resumo) return;
    setOcupado(true);
    setMensagem(null);
    try {
      const novo = await apiRequest<ResumoDoLote>(`/core/import/produtos/${resumo.id}/leitura`, {
        method: 'PUT',
        body: mudanca,
      });
      setArmado(false);
      /*
        O FILTRO "SÓ OS ERROS" NÃO SOBREVIVE À RELEITURA — e sem esta linha ele
        ficava preso, exatamente no fim do fluxo para o qual esta tela existe.

        A sequência: a pessoa clica em "Ver só os 3 erros", descobre que a causa
        era o mapa de colunas, corrige o mapa aqui mesmo, e o servidor devolve
        `erros: 0`. Só que o botão que DESLIGA o filtro só é desenhado quando há
        erros — ele desaparecia junto —, enquanto `apenasErros` continuava
        ligado. A busca seguia pedindo só erros, a tabela ficava vazia, e a tela
        exibia "a planilha não trouxe nenhuma linha depois do cabeçalho" sobre
        um arquivo com 200 linhas boas. Não havia como sair dali sem reenviar.

        O filtro é uma vista SOBRE o conjunto de erros; quando o conjunto muda,
        a vista não pode continuar valendo. É o mesmo motivo do `setArmado(false)`
        logo acima: a releitura desfaz o que a pessoa já tinha decidido sobre a
        leitura anterior.
      */
      setApenasErros(false);
      setPagina(0);
      setResumo(novo);
    } catch (err) {
      setMensagem({
        tom: 'erro',
        texto: err instanceof ApiRequestError ? err.message : 'Falha ao reler a planilha.',
      });
    } finally {
      setOcupado(false);
    }
  };

  const confirmar = async () => {
    if (!resumo) return;
    setOcupado(true);
    setMensagem(null);
    try {
      const feito = await apiRequest<{
        criados: number;
        comSaldo: number;
        ignorados: number;
        unidadesEntradas: number;
      }>(`/core/import/produtos/${resumo.id}/confirmar`, { method: 'POST' });
      setArmado(false);
      setResumo(null);
      setItens([]);
      setMensagem({
        tom: 'ok',
        texto:
          `${feito.criados} produto(s) criado(s), ${feito.comSaldo} com saldo inicial ` +
          `(${formatQuantity(feito.unidadesEntradas)} unidade(s) no estoque). ` +
          `${feito.ignorados} linha(s) descartada(s).`,
      });
      await carregarLotes();
    } catch (err) {
      setMensagem({
        tom: 'erro',
        texto: err instanceof ApiRequestError ? err.message : 'Falha ao confirmar a importação.',
      });
    } finally {
      setOcupado(false);
    }
  };

  /**
   * Descarta um rascunho DA LISTA — inclusive um que não está aberto na tela.
   *
   * Separado de `descartar` porque os dois limpam coisas diferentes: aquele
   * fecha a conferência aberta; este só some com a linha. Reaproveitar um só
   * obrigaria a fechar a conferência atual para descartar um rascunho antigo,
   * que é o oposto do que a pessoa quer.
   */
  const descartarDaLista = async (lote: LoteNaLista) => {
    setOcupado(true);
    try {
      await apiRequest<void>(`/core/import/produtos/${lote.id}`, { method: 'DELETE' });
      // Se o rascunho descartado era o que estava aberto, a conferência some
      // junto — deixá-la na tela mostraria itens de um lote que não existe.
      if (resumo?.id === lote.id) {
        setResumo(null);
        setItens([]);
        setArmado(false);
      }
      setMensagem({ tom: 'info', texto: `Rascunho "${lote.filename}" descartado. Nada foi criado.` });
      await carregarLotes();
    } catch (err) {
      setMensagem({
        tom: 'erro',
        texto: err instanceof ApiRequestError ? err.message : 'Falha ao descartar o rascunho.',
      });
    } finally {
      setOcupado(false);
    }
  };

  const descartar = async () => {
    if (!resumo) return;
    setOcupado(true);
    try {
      await apiRequest<void>(`/core/import/produtos/${resumo.id}`, { method: 'DELETE' });
      setResumo(null);
      setItens([]);
      setArmado(false);
      setMensagem({ tom: 'info', texto: 'Rascunho descartado. Nada foi criado.' });
      await carregarLotes();
    } catch (err) {
      setMensagem({
        tom: 'erro',
        texto: err instanceof ApiRequestError ? err.message : 'Falha ao descartar o rascunho.',
      });
    } finally {
      setOcupado(false);
    }
  };

  /*
    O QUE EXIGE SEGUNDO CLIQUE.

    Duas situações, e as duas custam caro sem aviso: linha com erro é linha que
    o sistema vai PULAR calada, e arquivo já importado é duplicata de catálogo
    com estoque somado em cima. Fora desses dois casos o clique é único — pedir
    confirmação para tudo ensina a clicar duas vezes sem ler.
  */
  const precisaSegundoClique = !!resumo && (resumo.erros > 0 || resumo.jaImportado !== null);
  const aproveitadas = resumo ? resumo.totalLinhas - resumo.erros : 0;
  const paginas = Math.max(1, Math.ceil(total / POR_PAGINA));

  return (
    <AppShell>
      <PageHeader
        breadcrumb={['Estoque', 'Importação de planilha']}
        title="Importação de planilha"
        subtitle="Cria o catálogo e o saldo inicial a partir de um CSV. Nada é criado até você confirmar."
        actions={
          <>
            <input
              ref={arquivoRef}
              type="file"
              accept=".csv,.txt,text/csv,text/plain"
              onChange={(e) => void enviarArquivo(e)}
              className="sr-only"
              id="planilha-arquivo"
              aria-label="Arquivo da planilha"
            />
            <Button onClick={() => arquivoRef.current?.click()} loading={ocupado}>
              Enviar planilha
            </Button>
          </>
        }
      />

      {mensagem && (
        <div
          role={mensagem.tom === 'erro' ? 'alert' : 'status'}
          className={`mb-5 px-4 py-3 rounded-[var(--gs-radius)] ${
            mensagem.tom === 'ok'
              ? 'bg-[var(--gs-success-bg)] text-[var(--gs-success)]'
              : mensagem.tom === 'info'
                ? 'bg-[var(--gs-info-bg)] text-[var(--gs-info)]'
                : 'bg-[var(--gs-danger-bg)] text-[var(--gs-danger)]'
          }`}
        >
          {mensagem.texto}
        </div>
      )}

      {resumo && (
        <>
          {/*
            O AVISO DE REIMPORTAÇÃO — alto, e antes de qualquer contagem.

            Este é o erro mais caro que esta tela pode deixar acontecer, e o
            mais fácil de cometer: o mesmo arquivo, subido por outra pessoa,
            uma semana depois. Nada no resultado denuncia — os produtos são
            criados de novo, com outros códigos internos, e o estoque SOMA em
            cima do que já havia. A loja passa a ter dois catálogos e o dobro
            do saldo, e a descoberta é na contagem física.
          */}
          {resumo.jaImportado && (
            <div
              role="alert"
              className="mb-5 px-5 py-4 rounded-[var(--gs-radius)] border-2
                border-[var(--gs-danger)] bg-[var(--gs-danger-bg)] text-[var(--gs-danger)]"
            >
              <p className="m-0 font-bold text-[length:var(--gs-text-lg)]">
                Este arquivo já foi importado em {dataCurta(resumo.jaImportado.confirmadoEm)}.
              </p>
              <p className="mt-2 mb-0">
                Aquela importação criou {resumo.jaImportado.criados} produto(s) e deu saldo a{' '}
                {resumo.jaImportado.comSaldo}. Importar de novo NÃO atualiza o que existe: cria
                produtos DUPLICADOS e SOMA o estoque outra vez. Se a intenção era corrigir o
                catálogo, descarte este rascunho e use a alteração rápida.
              </p>
            </div>
          )}

          <Card
            title="Como o arquivo está sendo lido"
            subtitle={`${resumo.nomeArquivo} · ${resumo.cabecalho.length} coluna(s) · ${resumo.totalLinhas} linha(s)`}
            className="mb-5"
          >
            {/*
              O QUE FOI DETECTADO FICA À VISTA E EDITÁVEL.

              O palpite do servidor acerta na maioria dos arquivos e erra
              justamente nos que vieram de sistema antigo — que são os que mais
              precisam de importação. Escondido, o palpite errado vira "o
              sistema não leu minha planilha"; à vista, vira um clique.
            */}
            <div className="grid gap-4 sm:grid-cols-2 mb-5">
              <label className="flex flex-col gap-1.5">
                <span className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-text-soft)]">
                  Codificação do arquivo
                </span>
                <select
                  value={resumo.encoding}
                  disabled={ocupado}
                  onChange={(e) =>
                    void reler({
                      encoding: e.target.value as EncodingCsv,
                      separador: resumo.separador,
                    })
                  }
                  className="h-10 px-2 rounded-[var(--gs-radius)] border
                    border-[var(--gs-border-strong)] bg-[var(--gs-surface)]"
                >
                  {ENCODINGS.map((o) => (
                    <option key={o.valor} value={o.valor}>
                      {o.rotulo}
                    </option>
                  ))}
                </select>
              </label>

              <label className="flex flex-col gap-1.5">
                <span className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-text-soft)]">
                  Separador de colunas
                </span>
                <select
                  value={resumo.separador}
                  disabled={ocupado}
                  onChange={(e) =>
                    void reler({
                      separador: e.target.value as SeparadorCsv,
                      encoding: resumo.encoding,
                    })
                  }
                  className="h-10 px-2 rounded-[var(--gs-radius)] border
                    border-[var(--gs-border-strong)] bg-[var(--gs-surface)]"
                >
                  {SEPARADORES.map((o) => (
                    <option key={o.valor} value={o.valor}>
                      {o.rotulo}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {/*
              O MAPA POR ÍNDICE, com o texto do cabeçalho ao lado.

              Duas colunas chamadas "preco" — uma de custo, uma de venda — são o
              caso comum em export de fornecedor, e é exatamente onde o palpite
              erra. Listar por nome deixaria as duas opções idênticas na lista;
              o índice as distingue, e o texto do cabeçalho diz qual é qual.
            */}
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {CAMPOS.map(({ campo, rotulo }) => (
                <label key={campo} className="flex flex-col gap-1.5">
                  <span className="text-[length:var(--gs-text-sm)] font-semibold text-[var(--gs-text-soft)]">
                    {rotulo}
                  </span>
                  <select
                    value={resumo.mapa[campo] === undefined ? '' : String(resumo.mapa[campo])}
                    disabled={ocupado}
                    onChange={(e) => {
                      const mapa: MapaDeColunas = { ...resumo.mapa };
                      if (e.target.value === '') delete mapa[campo];
                      else mapa[campo] = Number(e.target.value);
                      void reler({
                        mapa,
                        separador: resumo.separador,
                        encoding: resumo.encoding,
                      });
                    }}
                    className="h-10 px-2 rounded-[var(--gs-radius)] border
                      border-[var(--gs-border-strong)] bg-[var(--gs-surface)]"
                  >
                    <option value="">— não usar —</option>
                    {resumo.cabecalho.map((texto, indice) => (
                      // A chave é o ÍNDICE porque o cabeçalho se repete: duas
                      // colunas "preco" com a mesma chave apagariam uma das
                      // opções da lista.
                      <option key={indice} value={indice}>
                        coluna {indice + 1} — {texto || '(sem título)'}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
          </Card>

          <Card title="O que esta planilha vai criar" className="mb-5">
            {/*
              O RODAPÉ DAS QUATRO CONTAGENS.

              Elas ficam juntas porque é a leitura em conjunto que decide: 200
              novos com 200 sem saldo é uma loja que não vende nada. Separadas
              em cantos diferentes da tela, cada número parece aceitável.
            */}
            <div className="flex flex-wrap items-center gap-3">
              <span className="px-3 py-2 rounded-[var(--gs-radius)] bg-[var(--gs-surface-hover)]">
                <strong>{resumo.novos}</strong> novo(s) · <strong>{resumo.existentes}</strong> já
                existe(m)
              </span>
              <span
                className={`px-3 py-2 rounded-[var(--gs-radius)] font-semibold ${
                  resumo.semSaldo > 0
                    ? 'bg-[var(--gs-warning-bg)] text-[var(--gs-warning)]'
                    : 'bg-[var(--gs-surface-hover)]'
                }`}
              >
                SEM SALDO: {resumo.semSaldo}
              </span>
              <span
                className={`px-3 py-2 rounded-[var(--gs-radius)] font-semibold ${
                  resumo.semPreco > 0
                    ? 'bg-[var(--gs-warning-bg)] text-[var(--gs-warning)]'
                    : 'bg-[var(--gs-surface-hover)]'
                }`}
              >
                SEM PREÇO: {resumo.semPreco}
              </span>
              <span
                className={`px-3 py-2 rounded-[var(--gs-radius)] font-semibold ${
                  resumo.erros > 0
                    ? 'bg-[var(--gs-danger-bg)] text-[var(--gs-danger)]'
                    : 'bg-[var(--gs-surface-hover)]'
                }`}
              >
                ERROS: {resumo.erros}
              </span>
            </div>

            {/*
              As duas frases por extenso. O número sozinho não ensina nada a
              quem nunca viu o PDV recusar uma venda por falta de saldo — e é
              essa pessoa, montando a primeira loja, quem está aqui.
            */}
            {resumo.semSaldo > 0 && (
              <p className="mt-4 mb-0 px-4 py-3 rounded-[var(--gs-radius)] bg-[var(--gs-warning-bg)] text-[var(--gs-warning)]">
                <strong>{resumo.semSaldo} produto(s) entram com estoque zero.</strong> O PDV RECUSA
                a venda de produto sem saldo: eles vão aparecer na busca do caixa e a venda vai ser
                barrada com o cliente na frente. Preencha a coluna de quantidade na planilha ou dê
                entrada depois.
              </p>
            )}

            {resumo.semPreco > 0 && (
              <p className="mt-3 mb-0 px-4 py-3 rounded-[var(--gs-radius)] bg-[var(--gs-warning-bg)] text-[var(--gs-warning)]">
                <strong>{resumo.semPreco} produto(s) entram com preço R$ 0,00.</strong> Produto a R$
                0,00 SAI DE GRAÇA no caixa: o PDV não recusa, porque zero é preço válido de brinde —
                o cupom fecha, o estoque baixa e a loja não recebe nada.
              </p>
            )}

            {/*
              "JÁ EXISTE" ERA A ÚNICA DAS QUATRO CONTAGENS SEM CONSEQUÊNCIA ESCRITA.

              E a palavra engana: "já existe" lê como "vai ser pulado". O que
              acontece é o contrário — a linha NÃO é pulada, a quantidade dela
              entra como estoque no produto que já está lá.

              O momento em que isso morde é o mais comum de todos. A pessoa
              importa, vê três erros, corrige as três células no Excel e sobe o
              arquivo de novo. Agora as 197 linhas boas casam com os produtos
              que a primeira importação criou: elas voltam como "já existe" e
              SOMAM saldo outra vez. O bloco vermelho de reimportação não pega
              esse caso, porque ele compara o arquivo byte a byte — e o arquivo
              mudou, foi corrigido.

              Então o aviso é aqui, ligado ao que a tela realmente sabe: há
              linhas que vão somar estoque em produto existente.
            */}
            {resumo.existentes > 0 && (
              <p className="mt-3 text-[var(--gs-warning)]">
                <strong>
                  {resumo.existentes} linha(s) casaram com produto que JÁ EXISTE no catálogo.
                </strong>{' '}
                Confirmar não altera nome nem preço desses produtos — mas a quantidade delas SOMA no
                estoque atual. Se esta planilha já foi importada antes (mesmo com alguma célula
                corrigida), o saldo vai entrar duas vezes.
              </p>
            )}

            <div className="flex flex-wrap items-center gap-3 mt-5">
              {podeConfirmar ? (
                armado ? (
                  <>
                    {/*
                      O segundo clique diz o que vai ficar de fora, com o
                      número — não "tem certeza?", que é a pergunta que todo
                      mundo responde sim sem ler.
                    */}
                    <Button variant="danger" loading={ocupado} onClick={() => void confirmar()}>
                      {resumo.erros > 0
                        ? `Sim: importar as ${aproveitadas} e descartar as ${resumo.erros}`
                        : `Sim: importar de novo as ${aproveitadas} linhas`}
                    </Button>
                    <Button variant="ghost" onClick={() => setArmado(false)}>
                      Cancelar
                    </Button>
                  </>
                ) : (
                  <Button
                    variant="success"
                    loading={ocupado}
                    onClick={() => {
                      if (precisaSegundoClique) {
                        setArmado(true);
                        return;
                      }
                      void confirmar();
                    }}
                  >
                    Criar os produtos e o saldo
                  </Button>
                )
              ) : (
                <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                  Criar o catálogo é decisão da gerência. Você pode conferir, corrigir a leitura e
                  descartar este rascunho.
                </span>
              )}
              <Button variant="ghost" onClick={() => void descartar()} disabled={ocupado}>
                Descartar rascunho
              </Button>
            </div>
          </Card>

          <Card
            title="Linha a linha"
            subtitle={
              resumo.erros > 0
                ? 'As linhas com erro vêm primeiro: são as que a confirmação vai pular.'
                : 'Nenhuma linha com erro nesta planilha.'
            }
            padded={false}
            actions={
              resumo.erros > 0 ? (
                <Button
                  size="sm"
                  variant={apenasErros ? 'primary' : 'secondary'}
                  onClick={() => {
                    setPagina(0);
                    setApenasErros((v) => !v);
                  }}
                >
                  {apenasErros ? 'Ver todas as linhas' : `Ver só os ${resumo.erros} erros`}
                </Button>
              ) : null
            }
          >
            <DataTable
              columns={[
                {
                  header: 'Linha',
                  align: 'right',
                  render: (i: ItemDoLote) => (
                    // O número da linha é o que liga o erro à planilha aberta
                    // ao lado. Sem ele, "nome vazio" não diz ONDE consertar.
                    <span className="font-mono">{i.linha}</span>
                  ),
                },
                {
                  header: 'Situação',
                  render: (i: ItemDoLote) =>
                    i.acao === 'erro' ? (
                      <Badge tone="danger">Erro</Badge>
                    ) : i.acao === 'existe' ? (
                      <Badge tone="info">Já existe</Badge>
                    ) : (
                      <Badge tone="success">Novo</Badge>
                    ),
                },
                { header: 'Nome', render: (i: ItemDoLote) => i.nome ?? '—' },
                {
                  header: 'Código de barras',
                  render: (i: ItemDoLote) => (
                    <span className="font-mono text-[length:var(--gs-text-sm)]">
                      {i.codigoBarras ?? '—'}
                    </span>
                  ),
                },
                { header: 'Un.', render: (i: ItemDoLote) => i.unidade ?? '—' },
                /*
                  TRÊS ESTADOS DIFERENTES, TRÊS TEXTOS DIFERENTES — e a primeira
                  versão desta tela mostrava um só.

                  Ela imprimia "R$ 0,00" e "0" para tudo que não fosse um número
                  positivo, e isso apagava a distinção em que a rodada inteira se
                  apoia:

                    - LINHA COM ERRO: o campo nunca chegou a ser lido. A leitura
                      para no primeiro problema, então uma linha sem nome sai
                      daqui com preço nulo mesmo tendo `10,00` escrito na célula.
                      Mostrar "R$ 0,00" ali é afirmar um valor que a planilha não
                      diz — e logo abaixo do aviso que ensina a desconfiar de
                      exatamente esse número. Traço.

                    - NULO numa linha boa: "a planilha não disse". É o que o
                      rodapé conta como sem preço/sem saldo, e é aviso.

                    - ZERO de verdade: "a planilha disse que não tem". Também é
                      aviso, e precisa ser distinguível do anterior — porque
                      quem escreveu zero conferiu, e quem deixou vazio esqueceu.
                */
                {
                  header: 'Preço',
                  align: 'right',
                  render: (i: ItemDoLote) => {
                    if (i.acao === 'erro') return <span className="opacity-50">—</span>;
                    if (i.precoCents === null) {
                      return (
                        <span className="text-[var(--gs-warning)] font-semibold" title="A planilha não trouxe preço para esta linha.">
                          sem preço
                        </span>
                      );
                    }
                    if (i.precoCents === 0) {
                      return (
                        <span className="text-[var(--gs-warning)] font-semibold">R$ 0,00</span>
                      );
                    }
                    return formatCents(i.precoCents);
                  },
                },
                {
                  header: 'Custo',
                  align: 'right',
                  render: (i: ItemDoLote) =>
                    i.custoCents === null || i.acao === 'erro' ? '—' : formatCents(i.custoCents),
                },
                {
                  header: 'Qtd.',
                  align: 'right',
                  render: (i: ItemDoLote) => {
                    if (i.acao === 'erro') return <span className="opacity-50">—</span>;
                    if (i.quantidade === null) {
                      return (
                        <span className="text-[var(--gs-warning)] font-semibold" title="A planilha não trouxe quantidade para esta linha.">
                          sem saldo
                        </span>
                      );
                    }
                    if (i.quantidade === 0) {
                      return <span className="text-[var(--gs-warning)] font-semibold">0</span>;
                    }
                    return formatQuantity(i.quantidade);
                  },
                },
                {
                  header: 'O que houve',
                  render: (i: ItemDoLote) =>
                    i.acao === 'erro' ? (
                      <span className="text-[var(--gs-danger)]">
                        {i.erroDetalhe ?? i.erroCodigo ?? 'Linha inválida.'}
                      </span>
                    ) : (
                      <span className="text-[var(--gs-muted)]">—</span>
                    ),
                },
              ]}
              rows={itens}
              keyOf={(i) => i.id}
              empty={
                <EmptyState
                  title="Nenhuma linha para mostrar"
                  description="A planilha não trouxe nenhuma linha depois do cabeçalho."
                />
              }
            />

            {/*
              Paginação com o TOTAL à vista: sem ele, a pessoa que vê cem
              linhas acredita que a planilha tinha cem.
            */}
            <div className="flex items-center justify-between px-5 py-4 border-t border-[var(--gs-border)]">
              <Button
                variant="ghost"
                disabled={pagina === 0}
                onClick={() => setPagina((p) => Math.max(0, p - 1))}
              >
                Anterior
              </Button>
              <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
                {/* Frase montada em JS, e não com pedaços interpolados no JSX:
                    o React quebraria em vários nós de texto, e a linha deixaria
                    de ser legível de uma vez por leitor de tela e por teste. */}
                {`${total} linha(s) · página ${pagina + 1} de ${paginas}`}
              </span>
              <Button
                variant="ghost"
                disabled={pagina + 1 >= paginas}
                onClick={() => setPagina((p) => p + 1)}
              >
                Próxima
              </Button>
            </div>
          </Card>
        </>
      )}

      {/*
        O histórico é LEITURA, e o rascunho se reabre reenviando o arquivo.

        Não há rota de servidor que devolva o resumo de um lote sem reler os
        bytes, e reler sem mapa refaz o palpite — reabrir por aqui apagaria o
        remapeamento manual de quem parou no meio. Reenviar o mesmo arquivo
        substitui o rascunho anterior (o servidor apaga o lote em conferência de
        mesmo conteúdo), então nada duplica.
      */}
      <Card
        title="Importações anteriores"
        subtitle="Rascunho do MESMO arquivo é substituído ao reenviar. Corrigiu a planilha e subiu outra versão? O rascunho velho fica aqui — descarte-o."
        padded={false}
      >
        <DataTable
          columns={[
            { header: 'Arquivo', render: (l: LoteNaLista) => l.filename },
            { header: 'Enviado em', render: (l: LoteNaLista) => dataCurta(l.created_at) },
            {
              header: 'Situação',
              render: (l: LoteNaLista) =>
                l.status === 'confirmado' ? (
                  <Badge tone="success">Confirmada</Badge>
                ) : (
                  <Badge tone="warning">Em conferência</Badge>
                ),
            },
            {
              header: 'Criados',
              align: 'right',
              render: (l: LoteNaLista) => (l.status === 'confirmado' ? (l.created_products ?? 0) : '—'),
            },
            {
              header: 'Com saldo',
              align: 'right',
              render: (l: LoteNaLista) => (l.status === 'confirmado' ? (l.moved_products ?? 0) : '—'),
            },
            {
              header: 'Descartadas',
              align: 'right',
              render: (l: LoteNaLista) => (l.status === 'confirmado' ? (l.skipped_rows ?? 0) : '—'),
            },
            /*
              O RASCUNHO DE OUTRO ARQUIVO FICAVA PRESO AQUI PARA SEMPRE.

              O subtítulo desta lista diz "envie o mesmo arquivo de novo — ele
              substitui o rascunho", e isso é verdade só para o arquivo
              IDÊNTICO: o servidor compara o conteúdo byte a byte. O caso comum
              é o outro — a pessoa vê o erro, CORRIGE a planilha no Excel e
              sobe a versão nova. O conteúdo mudou, o rascunho velho não é
              substituído, e ele fica em conferência sem nenhuma ação na tela.

              Cada rascunho carrega o arquivo inteiro guardado no banco, e esta
              lista mostra os últimos 50: rascunho abandonado empurra
              importação confirmada para fora do histórico.

              A rota de descarte já existia e já aceitava o estoquista. Faltava
              o botão — que é o defeito clássico deste projeto, código sem
              ninguém que o alcance.
            */
            {
              header: '',
              align: 'right',
              render: (l: LoteNaLista) =>
                l.status === 'confirmado' ? null : (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void descartarDaLista(l)}
                    disabled={ocupado}
                  >
                    Descartar
                  </Button>
                ),
            },
          ]}
          rows={lotes}
          keyOf={(l) => l.id}
          empty={
            <EmptyState
              title="Nenhuma planilha importada"
              description="Envie um CSV com nome, código de barras, preço e quantidade para montar o catálogo da operação."
            />
          }
        />
      </Card>
    </AppShell>
  );
}
