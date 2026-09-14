/**
 * ============================================================================
 * O PACOTE QUE VAI PARA O CONTADOR
 * ============================================================================
 *
 * ## O problema, na mesa de quem trabalha
 *
 * Todo mês alguém tem que entregar ao contador o que a empresa emitiu, o que
 * recebeu e o que apurou. Hoje isso é feito clicando arquivo por arquivo em
 * telas diferentes — e o que não tem botão simplesmente não é entregue. O XML
 * da nota de entrada, por exemplo, não existia em lugar nenhum até a rodada 27.
 *
 * Este serviço monta UM arquivo com tudo o que o sistema realmente tem, e
 * escreve dentro dele o que ele NÃO tem e por quê. A segunda metade é tão
 * importante quanto a primeira: um pacote silencioso sobre suas próprias
 * lacunas faz o contador assumir que o mês está completo.
 *
 * ## AS CINCO ARMADILHAS QUE ESTE ARQUIVO EXISTE PARA DESARMAR
 *
 * Todas foram medidas no código, uma a uma, e todas produziriam um pacote com
 * cara de correto:
 *
 * 1. REUSAR AS CONSULTAS DAS TELAS. `listFiscalDocuments` termina em
 *    LIMIT 300 e `listVoidRanges` em LIMIT 200. Servem à tela, onde ninguém
 *    rola mil linhas. Num pacote fiscal, um LIMIT trunca um mês real EM
 *    SILÊNCIO — o arquivo sai, abre, parece completo, e faltam notas. Por isso
 *    cada consulta aqui é PRÓPRIA e nenhuma tem LIMIT.
 *
 * 2. RECORTAR EVENTO PELA DATA DA NOTA. Cancelamento e carta de correção de
 *    uma nota de março podem acontecer em abril — e é em abril que o contador
 *    precisa deles. Um pacote que percorresse só os documentos do período
 *    perderia exatamente os eventos que importam. O recorte do evento é pela
 *    data DO EVENTO.
 *
 * 3. MISTURAR HOMOLOGAÇÃO E TESTE COM PRODUÇÃO. Existem três marcas de
 *    documento que não é real: `environment` diferente de 'production', a
 *    assinatura de fixture (`FIXTURE_SIGNATURE_MARK`) e o prefixo `TEST-` de
 *    protocolo do provider de teste. Um documento de homologação dentro do
 *    pacote é escrituração de nota que não existe.
 *
 * 4. COMPOR O procNFe A PARTIR DA RESPOSTA DA SEFAZ. Está tratado em
 *    `FiscalProcNfe.ts`, e o resumo é: a resposta guardada passou por
 *    `sanitizeResponse`, que apaga o conteúdo da assinatura. Aqui a `<NFe>`
 *    vem sempre de `xml_signed`.
 *
 * 5. PASTA VAZIA DENTRO DO ZIP. Uma pasta `emitidas/` sem nenhum arquivo é
 *    lida como perda de dado — "sumiram as notas". Pasta sem conteúdo não
 *    entra, e o LEIA-ME diz que ela não entrou e por quê.
 *
 * ## O QUE ESTE SERVIÇO NÃO FAZ, DE PROPÓSITO
 *
 * Não grava histórico de fechamento e não compara um mês com o outro. Nada
 * disso muda o que o contador leva. O HASH ele calcula, desde o GAP-PRD-176:
 * SHA-256 de cada arquivo no MANIFESTO, do MANIFESTO no LEIA-ME, e do zip no
 * cabeçalho do download, na trilha de auditoria e no corpo do e-mail. Também não dá
 * VEREDITO: com zero notas emitidas no banco real, qualquer regra do tipo
 * "não fecha sem X" dispararia todo mês e viraria carimbo — as pendências são
 * listadas para quem lê decidir, e o download nunca é bloqueado por elas.
 */
import { ensureCoreSchema } from '../../db/schema.js';
import { createHash } from 'node:crypto';
import {
  diaDaLoja,
  diaDaLojaSql,
  FUSO_DA_LOJA,
  horaDaLoja,
  limitesDoMes,
} from './CalendarioOperacional.js';
/*
  O CSV É O DA CASA, e agora ele mora fora daqui.

  `campoCsv`/`linhaCsv`/`montarCsv` nasceram neste arquivo e eram privados —
  o zip do mês era o único lugar do repositório que gerava CSV. A Central de
  Relatórios (GAP-V37) exporta catorze relatórios com o MESMO formato, e
  copiá-las para lá criaria o segundo CSV do sistema: no dia em que alguém
  consertasse um escape de um lado só, o contador abriria dois arquivos do
  mesmo sistema com formatos diferentes.

  Elas saíram inteiras para `Csv.ts`, sem mudar um byte do resultado —
  `fechamento-contador.test.ts` confere o conteúdo do zip contra o banco e
  continua verde. O `reais` local também virou `reaisCsv` lá.
*/
import { linhaCsv, montarCsv, reaisCsv as reais } from './Csv.js';
import { getConnection } from '../../db/sqlite.js';
import { ApiError } from '../../utils/errors.js';
import { getCertificateView } from './CertificateStatusService.js';
import {
  NOTA_ESTORNADA,
  NOTA_IMPORTADA,
  NOTA_RECEBIDA,
  type InboundNoteStatus,
} from './InboundNoteStatus.js';
import { FIXTURE_SIGNATURE_MARK } from './FiscalPipelineService.js';
import { montarProcNfe } from './FiscalProcNfe.js';
import { incomeStatement } from './IncomeStatementService.js';
import { SEFAZ_ENDPOINTS } from './SefazAdapter.js';
import { TEST_PROTOCOL_PREFIX } from './SefazTestAdapter.js';
import { montarZip, type ArquivoDoZip } from './ZipWriter.js';

// ---------------------------------------------------------------------------
// O período
// ---------------------------------------------------------------------------

export interface LimitesDoPeriodo {
  /** O que veio na URL, já validado: 'AAAA-MM'. */
  period: string;
  /** 'AAAA-MM-01'. */
  primeiroDia: string;
  /** 'AAAA-MM-28|29|30|31', conforme o mês. */
  ultimoDia: string;
  /** Instante inicial, para comparar com carimbo ISO completo. */
  inicio: string;
  /** Instante final, inclusivo até o último milissegundo do último dia. */
  fim: string;
}

/**
 * A regra do formato AAAA-MM mora AQUI, e só aqui.
 *
 * Três rotas e duas funções precisam do mesmo recorte. Se cada uma validasse
 * por conta própria, uma delas divergiria — e o jeito clássico de divergir é
 * aceitar '2026-13' em um lugar e recusar no outro, produzindo um pacote vazio
 * que parece "mês sem movimento". Um dono só para a regra.
 *
 * O mês é conferido de 01 a 12 pela própria expressão. Isso importa: um regex
 * frouxo do tipo dois dígitos aceitaria '2026-00', que o construtor de datas
 * interpreta como dezembro do ano anterior — o pacote sairia com o mês errado
 * e ninguém desconfiaria.
 *
 * ## O fuso, resolvido
 *
 * Este comentário dizia, com todas as letras, que o recorte comparava texto
 * ISO em UTC e que a venda das 22h do dia 31 caía no mês seguinte — e defendia
 * a escolha com uma razão boa: manter a MESMA convenção do resto do sistema,
 * porque mudá-la só aqui criaria duas verdades.
 *
 * A razão continua valendo; a convenção é que mudou. `CalendarioOperacional`
 * passou a ser o dono único do "que dia é hoje na loja", e o recorte do pacote
 * sai de lá junto com o do painel, o do DRE e o das listas. O pacote do
 * contador é o lugar onde essa diferença custa mais caro: uma venda no mês
 * errado é escrituração no mês errado.
 */
export function periodBounds(period: string): LimitesDoPeriodo {
  const texto = String(period ?? '').trim();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(texto)) {
    throw new ApiError(
      'CORE_FISCAL_PERIODO_INVALIDO',
      `Período "${texto}" não é um mês válido. Use o formato AAAA-MM, com mês de 01 a 12.`,
      400,
      { period: texto },
    );
  }

  return limitesDoMes(texto);
}

// ---------------------------------------------------------------------------
// Os tetos
// ---------------------------------------------------------------------------

/**
 * Acima disto o pacote é recusado, com o número medido na mensagem.
 *
 * O motivo é de memória: `montarZip` monta o arquivo INTEIRO em um Buffer, e
 * cada XML é lido do SQLite para a memória antes disso. Um mês de dez mil
 * documentos derrubaria o processo do servidor — e derrubaria para todo mundo,
 * não só para quem clicou. Recusar com um número é a diferença entre "o
 * servidor caiu" e "o mês de março tem 7.412 documentos; peça o pacote em duas
 * metades".
 *
 * Os valores são folgados de propósito: o banco real tem UMA nota. Eles
 * existem como teto, não como cota.
 */
export const TETO_DE_DOCUMENTOS = 5000;
export const TETO_DE_BYTES = 60 * 1024 * 1024;

// ---------------------------------------------------------------------------
// A prévia
// ---------------------------------------------------------------------------

export interface PendenciaDoFechamento {
  /** Código estável, para a tela agrupar sem comparar frase. */
  codigo: string;
  titulo: string;
  /** O que fazer a respeito, em português de quem opera. */
  detalhe: string;
  quantidade: number;
}

export interface PreviaDoFechamento {
  period: string;
  primeiroDia: string;
  ultimoDia: string;
  empresa: { nome: string; slug: string };
  /** O nome que o arquivo terá, para a tela dizer o que vai baixar. */
  nomeArquivo: string;
  contagens: {
    emitidasAutorizadas: number;
    emitidasCanceladas: number;
    eventos: number;
    recebidasComArquivo: number;
    /**
     * SÓ o XML perdido: a nota de fornecedor anterior à versão 58, cujo
     * arquivo foi lido e descartado. Já contou também a entrada manual e a
     * nota estornada, e as três diziam coisas diferentes — ver
     * `baldeDaEntrada`.
     */
    recebidasSemArquivo: number;
    /** Compra SEM nota fiscal (entrada manual): nunca teve XML. */
    recebidasSemNota: number;
    /** Entradas do período que foram DESFEITAS: documento morto. */
    recebidasEstornadas: number;
    faixasInutilizadas: number;
  };
  pendencias: PendenciaDoFechamento[];
  /**
   * Os meses que TÊM matéria-prima, do mais recente para o mais antigo.
   *
   * Existe para o seletor da tela abrir no lugar certo. Sem isto ele abriria
   * no mês corrente — que, num sistema com uma nota de abril, mostra um pacote
   * vazio e faz o operador concluir que a função não funciona.
   *
   * Vem junto da prévia, e não numa rota própria, porque é a MESMA pergunta
   * feita ao mesmo dado: quais meses têm documento, evento ou nota de entrada.
   * Lista vazia é resposta legítima e significa "não há nada em mês nenhum".
   */
  mesesComMateriaPrima: string[];
}

/** Uma nota emitida do período, com as duas metades do procNFe. */
interface DocumentoEmitido {
  id: string;
  model: string;
  serie: number;
  number: number;
  accessKey: string | null;
  status: string;
  xmlSigned: string | null;
  xmlAuthorized: string | null;
}

/** Um evento de documento (cancelamento, carta de correção) do período. */
interface EventoDoPeriodo {
  id: string;
  eventType: string;
  sequence: number;
  xml: string;
  /**
   * O procEventoNFe íntegro, quando foi guardado (GAP-V32, eventos novos).
   * Quando existe, é ELE que entra no zip; `xml` — o retorno sanitizado, com
   * a assinatura trocada por "[removido]" — vira o caminho do legado.
   */
  xmlProc: string | null;
  createdAt: string;
  accessKey: string | null;
}

interface NotaRecebida {
  id: string;
  accessKey: string;
  number: string | null;
  entrada: string;
  status: string;
  docType: string;
  xmlOriginal: string | null;
}

interface FaixaInutilizada {
  model: string;
  serie: number;
  numberFrom: number;
  numberTo: number;
  protocol: string | null;
  justification: string | null;
  createdAt: string;
  /** O retorno da SEFAZ, sanitizado. O caminho do legado. */
  xml: string | null;
  /**
   * O procInutNFe íntegro — o inutNFe ASSINADO costurado com o retInutNFe —,
   * guardado desde a rodada que fechou o resíduo do GAP-V32. Quando existe, é
   * ELE que entra no zip.
   */
  xmlProc: string | null;
}

// ---------------------------------------------------------------------------
// Em que balde do pacote uma nota de ENTRADA cai
// ---------------------------------------------------------------------------

/**
 * Os quatro destinos possíveis de uma nota de entrada dentro do pacote.
 *
 * ## Por que quatro, e não "tem XML" contra "não tem"
 *
 * O pacote perguntava UMA coisa — `xml_original` está vazio? — e mandava todo
 * mundo que respondesse "sim" para o mesmo balde, cuja explicação escrita é
 * específica e irreversível: "esta nota entrou antes da versão 58, o arquivo
 * do fornecedor foi lido e descartado, não existe mais em lugar nenhum".
 *
 * Essa frase é verdadeira para UM caso e mentira para dois:
 *
 *  - a ENTRADA MANUAL (GAP-V17) nunca teve XML porque nota fiscal não houve —
 *    é a compra da feira, do autônomo, do produtor rural. Mandar o contador
 *    procurar um arquivo que jamais existiu gasta o tempo dele e, pior,
 *    esconde o que ele precisa saber: houve compra SEM documento fiscal, e
 *    isso tem tratamento próprio na escrituração;
 *
 *  - a nota ESTORNADA (GAP-V20) é documento MORTO: a entrada foi confirmada e
 *    depois desfeita, o estoque voltou e o título foi cancelado. Ela pode até
 *    ter o XML guardado — o que não pode é ser escriturada como compra.
 *
 * A ordem das perguntas importa: a morte vence a espécie (uma entrada manual
 * estornada é, antes de tudo, uma entrada desfeita) e a espécie vence o
 * arquivo (a compra sem nota não tem XML por definição, não por perda).
 */
type BaldeDaEntrada = 'com_arquivo' | 'sem_nfe' | 'estornada' | 'xml_perdido';

function baldeDaEntrada(nota: { status: string; docType: string; temXml: boolean }): BaldeDaEntrada {
  if (nota.status === NOTA_ESTORNADA) return 'estornada';
  if (nota.docType === 'manual') return 'sem_nfe';
  return nota.temXml ? 'com_arquivo' : 'xml_perdido';
}

/**
 * "Ainda em conferência" é UM estado nomeado, e nunca "todo o resto".
 *
 * A contagem da pendência era `status <> 'recebida'` — uma lista por
 * COMPLEMENTO. Quando o estorno criou o terceiro estado, ele entrou calado no
 * balde da conferência: a prévia passou a pedir que alguém conferisse a
 * mercadoria de uma entrada que o próprio sistema já tinha desfeito.
 *
 * Este mapa existe para que isso não se repita. Ele é indexado pelo tipo
 * `InboundNoteStatus`: um quarto estado no domínio quebra a COMPILAÇÃO aqui e
 * obriga quem o criou a decidir o que ele significa para o contador — em vez
 * de herdar a resposta de um `<>` escrito anos antes.
 */
const CONTA_COMO_EM_CONFERENCIA: Record<InboundNoteStatus, boolean> = {
  [NOTA_IMPORTADA]: true,
  [NOTA_RECEBIDA]: false,
  [NOTA_ESTORNADA]: false,
};

/**
 * O filtro que separa documento REAL de ensaio.
 *
 * Três marcas independentes, e as três precisam bater. `COALESCE` em volta de
 * cada coluna anulável não é zelo decorativo: em SQL, `NULL NOT LIKE 'TEST-%'`
 * é NULL, e NULL não passa no WHERE — sem ele, um documento legítimo sem
 * protocolo ficaria de fora sem nenhum motivo visível.
 */
const SO_PRODUCAO = `
      AND d.environment = 'production'
      AND COALESCE(d.protocol, '') NOT LIKE '${TEST_PROTOCOL_PREFIX}%'
      AND COALESCE(d.xml_signed, '') NOT LIKE '%${FIXTURE_SIGNATURE_MARK}%'`;

/*
  O MESMO FILTRO PARA O EVENTO QUE NÃO TEM DOCUMENTO — e a falta dele era o
  defeito mais caro desta rodada.

  `SO_PRODUCAO` pergunta ao DOCUMENTO: ambiente, protocolo e marca de fixture
  moram em `core_fiscal_documents`. Só que a INUTILIZAÇÃO não tem documento —
  ela é uma faixa de números queimada, uma linha solta em
  `core_fiscal_events` — e por isso escapava inteira da peneira.

  O estrago: hoje, sem certificado e sem endereço de SEFAZ configurado, TODA
  inutilização que existe no sistema é simulada, com protocolo `TEST-`. O
  pacote sairia com `numeracao/inutilizadas.csv` listando faixas fabricadas, e
  o contador leria aquilo como fato — faixa de número queimada é obrigação
  acessória, não enfeite. Entregar dado de teste dentro de um pacote fiscal é
  pior do que entregar pacote vazio: o vazio se percebe.

  O mesmo raciocínio vale para o protocolo do PRÓPRIO evento de cancelamento:
  o documento pode ser de produção e a resposta do cancelamento ter vindo do
  adaptador de teste.

  As TRÊS consultas (prévia, medição e pacote) usam esta constante. Se só uma
  usasse, a tela contaria uma faixa que o zip não traz — e divergência entre o
  que se promete e o que se entrega é exatamente o que esta rodada existe para
  não fazer.
*/
const SO_EVENTO_REAL = `
      AND COALESCE(e.protocol, '') NOT LIKE '${TEST_PROTOCOL_PREFIX}%'`;

/** Igual ao de cima, para as consultas em que a tabela de eventos não tem apelido. */
const SO_EVENTO_REAL_SEM_APELIDO = `
      AND COALESCE(protocol, '') NOT LIKE '${TEST_PROTOCOL_PREFIX}%'`;

/**
 * A data pela qual um documento emitido pertence a um mês.
 *
 * É a data de EMISSÃO, porque é ela que o layout fiscal chama de dhEmi e é por
 * ela que o contador escritura a saída. `created_at` entra só como último
 * recurso: um documento sem data de emissão é rascunho, e rascunho não chega
 * aqui — mas deixá-lo cair fora de todo mês seria pior que colocá-lo no mês em
 * que a linha nasceu.
 */
const DATA_DA_EMISSAO = "COALESCE(d.issued_at, d.created_at)";

/**
 * A data pela qual uma nota RECEBIDA pertence a um mês: a data da ENTRADA.
 *
 * Não é a data de emissão do fornecedor, e a diferença é a regra de trabalho
 * do contador: compra é escriturada quando a mercadoria ENTRA. Uma nota
 * emitida em 28/02 que chegou em 03/03 é março. `created_at` cobre a nota que
 * ainda está em conferência — ela ainda não tem entrada, e o mês em que
 * apareceu no sistema é a melhor verdade disponível.
 */
const DATA_DA_ENTRADA = 'COALESCE(n.received_at, n.created_at)';

function empresaDe(companyId: string): { nome: string; slug: string } {
  const row = getConnection()
    .prepare('SELECT trade_name, legal_name, slug FROM core_companies WHERE id = ?')
    .get(companyId) as { trade_name?: string; legal_name?: string; slug?: string } | undefined;
  if (!row) {
    throw new ApiError('CORE_COMPANY_NOT_FOUND', 'Empresa não encontrada.', 404);
  }
  /*
    O SLUG SAI CRU DAQUI, e a limpeza acontece em UM lugar só: `nomeDoPacote`.
    Limpar nos dois seria duas cópias da mesma regra para divergir depois — e,
    pior, esconderia a falha do dia em que alguém apagasse a de baixo, que é a
    que realmente protege. Aqui o valor vira JSON, onde aspas e quebra de linha
    são escapadas pelo próprio formato; lá ele vira nome de arquivo e cabeçalho
    HTTP, onde não são.
  */
  return {
    nome: String(row.trade_name || row.legal_name || row.slug || 'empresa'),
    slug: String(row.slug ?? ''),
  };
}

/**
 * O slug que pode entrar num nome de arquivo e num cabeçalho HTTP.
 *
 * `Content-Disposition` é um cabeçalho de texto: aspas, ponto-e-vírgula e
 * quebra de linha dentro dele mudam o significado do cabeçalho inteiro, e uma
 * quebra de linha permite ANEXAR outro cabeçalho à resposta. O slug da empresa
 * é dado de cadastro — vem de gente digitando —, então ele nunca é interpolado
 * cru. Aqui ele é reduzido ao alfabeto que não significa nada em cabeçalho
 * nenhum: letra minúscula, dígito e hífen.
 *
 * Vazio depois da limpeza vira 'empresa'. Um nome de arquivo que começa com
 * hífen ou fica só com a extensão confunde o próprio Windows.
 */
function slugSeguro(bruto: string): string {
  const limpo = bruto
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return limpo || 'empresa';
}

/** O nome do arquivo. Montado só com peças já validadas. */
export function nomeDoPacote(slug: string, period: string): string {
  return `pacote-${slugSeguro(slug)}-${periodBounds(period).period}.zip`;
}

/**
 * Os meses que têm alguma coisa — documento emitido, evento ou nota de entrada.
 *
 * Une três recortes de data diferentes porque é exatamente essa a pergunta do
 * seletor: "em que mês existe matéria-prima para um pacote?". Um mês com só
 * uma nota de entrada continua sendo um mês com pacote.
 */
function mesesComMateriaPrima(companyId: string): string[] {
  const rows = getConnection()
    .prepare(
      `SELECT DISTINCT mes FROM (
         SELECT substr(${diaDaLojaSql(DATA_DA_EMISSAO)}, 1, 7) AS mes
           FROM core_fiscal_documents d
          WHERE d.company_id = ? AND d.status IN ('AUTHORIZED', 'CANCELLED')${SO_PRODUCAO}
         UNION
         SELECT substr(${diaDaLojaSql('e.created_at')}, 1, 7) AS mes
           FROM core_fiscal_events e
          WHERE e.company_id = ? AND e.xml IS NOT NULL AND e.xml <> ''
         UNION
         SELECT substr(${diaDaLojaSql(DATA_DA_ENTRADA)}, 1, 7) AS mes
           FROM core_inbound_notes n
          WHERE n.company_id = ?
       )
       WHERE mes IS NOT NULL AND length(mes) = 7
       ORDER BY mes DESC`,
    )
    .all(companyId, companyId, companyId) as unknown as { mes: string }[];
  return rows.map((r) => String(r.mes));
}

/**
 * O que o mês tem e o que falta nele — sem veredito.
 *
 * Nenhuma pendência impede o download, e isso é decisão, não omissão: no banco
 * real deste ERP não há uma única nota emitida, então um critério bloqueante
 * do tipo "não fecha sem emissão" reprovaria todos os meses, todos os meses.
 * Um alerta que sempre acende deixa de ser lido em duas semanas.
 */
export function previaDoFechamento(companyId: string, period: string): PreviaDoFechamento {
  ensureCoreSchema();
  const limites = periodBounds(period);
  const db = getConnection();
  const empresa = empresaDe(companyId);

  const emitidas = db
    .prepare(
      `SELECT
         SUM(CASE WHEN d.status = 'AUTHORIZED' THEN 1 ELSE 0 END) AS autorizadas,
         SUM(CASE WHEN d.status = 'CANCELLED'  THEN 1 ELSE 0 END) AS canceladas,
         SUM(CASE WHEN COALESCE(d.xml_signed, '') = '' THEN 1 ELSE 0 END) AS semAssinado
         FROM core_fiscal_documents d
        WHERE d.company_id = ?
          AND d.status IN ('AUTHORIZED', 'CANCELLED')
          AND ${DATA_DA_EMISSAO} >= ? AND ${DATA_DA_EMISSAO} <= ?${SO_PRODUCAO}`,
    )
    .get(companyId, limites.inicio, limites.fim) as {
    autorizadas: number | null;
    canceladas: number | null;
    semAssinado: number | null;
  };

  const eventos = db
    .prepare(
      `SELECT COUNT(*) AS total FROM core_fiscal_events e
         JOIN core_fiscal_documents d ON d.id = e.document_id
        WHERE e.company_id = ?
          AND e.event_type IN ('cancelled', 'cce_authorized')
          AND e.xml IS NOT NULL AND e.xml <> ''
          AND COALESCE(e.protocol, '') <> ''
          AND e.created_at >= ? AND e.created_at <= ?${SO_PRODUCAO}${SO_EVENTO_REAL}`,
    )
    .get(companyId, limites.inicio, limites.fim) as { total: number };

  /*
    A CLASSIFICAÇÃO DAS ENTRADAS SAI DO SQL E VAI PARA O TypeScript — de
    propósito.

    Ela era três `SUM(CASE ...)` numa consulta só, e um deles perguntava pelo
    COMPLEMENTO (`status <> 'recebida'`). Enquanto a regra mora no SQL, o dia
    em que nascer o quarto estado da nota de entrada não produz erro nenhum:
    ele entra silenciosamente no balde de quem sobrou. Em `baldeDaEntrada` e
    `CONTA_COMO_EM_CONFERENCIA` o mesmo dia produz erro de compilação.

    O agrupamento é por (status, espécie, tem arquivo) — três colunas de
    domínio pequeno —, então a consulta devolve um punhado de linhas mesmo num
    mês de milhares de notas. Nenhum XML é carregado aqui.
  */
  const gruposDeEntrada = db
    .prepare(
      `SELECT n.status                                                    AS status,
              COALESCE(n.doc_type, 'nfe')                                 AS docType,
              CASE WHEN COALESCE(n.xml_original, '') <> '' THEN 1 ELSE 0 END AS temXml,
              COUNT(*)                                                    AS total
         FROM core_inbound_notes n
        WHERE n.company_id = ?
          AND ${DATA_DA_ENTRADA} >= ? AND ${DATA_DA_ENTRADA} <= ?
        GROUP BY n.status, COALESCE(n.doc_type, 'nfe'), temXml`,
    )
    .all(companyId, limites.inicio, limites.fim) as unknown as {
    status: string;
    docType: string;
    temXml: number;
    total: number;
  }[];

  const recebidas = { comArquivo: 0, semArquivo: 0, semNota: 0, estornadas: 0 };
  let naoConferidas = 0;
  for (const grupo of gruposDeEntrada) {
    const quantos = Number(grupo.total ?? 0);
    const balde = baldeDaEntrada({
      status: grupo.status,
      docType: grupo.docType,
      temXml: Number(grupo.temXml) === 1,
    });
    if (balde === 'com_arquivo') recebidas.comArquivo += quantos;
    else if (balde === 'sem_nfe') recebidas.semNota += quantos;
    else if (balde === 'estornada') recebidas.estornadas += quantos;
    else recebidas.semArquivo += quantos;

    if (CONTA_COMO_EM_CONFERENCIA[grupo.status as InboundNoteStatus] === true) {
      naoConferidas += quantos;
    }
  }

  const faixas = db
    .prepare(
      `SELECT COUNT(*) AS total FROM core_fiscal_events
        WHERE company_id = ? AND event_type = 'void_authorized'
          AND created_at >= ? AND created_at <= ?${SO_EVENTO_REAL_SEM_APELIDO}`,
    )
    .get(companyId, limites.inicio, limites.fim) as { total: number };

  const contagens = {
    emitidasAutorizadas: Number(emitidas.autorizadas ?? 0),
    emitidasCanceladas: Number(emitidas.canceladas ?? 0),
    eventos: Number(eventos.total ?? 0),
    recebidasComArquivo: recebidas.comArquivo,
    recebidasSemArquivo: recebidas.semArquivo,
    recebidasSemNota: recebidas.semNota,
    recebidasEstornadas: recebidas.estornadas,
    faixasInutilizadas: Number(faixas.total ?? 0),
  };

  const pendencias: PendenciaDoFechamento[] = [];

  if (contagens.recebidasSemArquivo > 0) {
    pendencias.push({
      codigo: 'RECEBIDA_SEM_ARQUIVO',
      titulo: 'Nota recebida sem o XML guardado',
      detalhe:
        'Estas notas entraram antes de o sistema passar a guardar o arquivo do fornecedor. '
        + 'O XML delas não existe mais e não há como recuperá-lo — elas ficam de fora da pasta '
        + 'recebidas/, e o LEIA-ME do pacote diz isso. Notas importadas de agora em diante '
        + 'trazem o arquivo junto.',
      quantidade: contagens.recebidasSemArquivo,
    });
  }

  /*
    AS DUAS OUTRAS AUSÊNCIAS TÊM PENDÊNCIA PRÓPRIA — e não são defeito.

    Elas entram na lista porque a lista é o único canal que a tela lê por
    completo (título + detalhe inteiro), e porque um número sozinho não diz o
    que fazer. Nenhuma delas bloqueia o download, como nenhuma outra bloqueia:
    compra sem nota fiscal é operação legítima, e estorno é o sistema
    funcionando.
  */
  if (contagens.recebidasSemNota > 0) {
    pendencias.push({
      codigo: 'COMPRA_SEM_NOTA_FISCAL',
      titulo: 'Compra sem nota fiscal (entrada manual)',
      detalhe:
        'Estas compras foram digitadas na tela porque o fornecedor não emite nota — feira, '
        + 'autônomo, produtor rural. Elas NUNCA tiveram XML: não é arquivo perdido, é documento '
        + 'fiscal que não existiu. Entram no manifesto pelo número digitado, e o contador decide '
        + 'como escriturá-las.',
      quantidade: contagens.recebidasSemNota,
    });
  }

  if (contagens.recebidasEstornadas > 0) {
    pendencias.push({
      codigo: 'ENTRADA_ESTORNADA',
      titulo: 'Entrada do período que foi estornada',
      detalhe:
        'A entrada foi confirmada e depois DESFEITA: o estoque voltou e o título foi cancelado. '
        + 'O documento está morto e não deve ser escriturado como compra — por isso ele fica fora '
        + 'da pasta recebidas/. Quando o XML existe, ele sai em estornadas/, porque a nota existe '
        + 'na SEFAZ contra este CNPJ e o contador precisa saber que ela existe E que não entrou.',
      quantidade: contagens.recebidasEstornadas,
    });
  }

  if (naoConferidas > 0) {
    pendencias.push({
      codigo: 'RECEBIDA_NAO_CONFERIDA',
      titulo: 'Nota recebida ainda em conferência',
      detalhe:
        'A mercadoria não foi conferida, então o estoque e o contas a pagar desta nota ainda '
        + 'não existem. O XML dela entra no pacote assim mesmo — o contador escritura a compra '
        + 'pelo arquivo —, mas o resultado do mês ainda não a inclui.',
      quantidade: naoConferidas,
    });
  }

  const semAssinado = Number(emitidas.semAssinado ?? 0);
  if (semAssinado > 0) {
    pendencias.push({
      codigo: 'EMITIDA_SEM_XML_ASSINADO',
      titulo: 'Nota autorizada sem o XML assinado guardado',
      detalhe:
        'Sem o XML assinado não é possível montar o arquivo de arquivamento (nfeProc), porque '
        + 'ele precisa da nota COM a assinatura original. Estas notas aparecem no manifesto '
        + 'como ausentes, em vez de sair um arquivo incompleto com cara de correto.',
      quantidade: semAssinado,
    });
  }

  const volume = medirVolume(companyId, limites);
  if (volume.documentos > TETO_DE_DOCUMENTOS || volume.bytes > TETO_DE_BYTES) {
    pendencias.push({
      codigo: 'PACOTE_ACIMA_DO_TETO',
      titulo: 'Mês grande demais para um pacote só',
      detalhe: mensagemDoTeto(volume),
      quantidade: volume.documentos,
    });
  }

  return {
    period: limites.period,
    primeiroDia: limites.primeiroDia,
    ultimoDia: limites.ultimoDia,
    empresa,
    nomeArquivo: nomeDoPacote(empresa.slug, limites.period),
    contagens,
    pendencias,
    mesesComMateriaPrima: mesesComMateriaPrima(companyId),
  };
}

// ---------------------------------------------------------------------------
// A medição, antes de carregar qualquer coisa
// ---------------------------------------------------------------------------

interface VolumeDoPeriodo {
  documentos: number;
  bytes: number;
}

/**
 * Quantos arquivos e quantos bytes CRUS o pacote teria.
 *
 * Medir com `COUNT` e `SUM` antes de trazer os XMLs é o ponto: perguntar o
 * tamanho depois de carregar tudo para a memória é perguntar tarde demais —
 * o estouro já teria acontecido.
 *
 * `LENGTH(CAST(x AS BLOB))` conta BYTES; `LENGTH(x)` sozinho contaria
 * caracteres, e um XML com acento tem mais bytes que caracteres. O teto é de
 * memória, então quem manda é o byte.
 */
function medirVolume(companyId: string, limites: LimitesDoPeriodo): VolumeDoPeriodo {
  const db = getConnection();

  const emitidas = db
    .prepare(
      `SELECT COUNT(*) AS n,
              COALESCE(SUM(LENGTH(CAST(COALESCE(d.xml_signed, '') AS BLOB))
                         + LENGTH(CAST(COALESCE(d.xml_authorized, '') AS BLOB))), 0) AS bytes
         FROM core_fiscal_documents d
        WHERE d.company_id = ?
          AND d.status IN ('AUTHORIZED', 'CANCELLED')
          AND ${DATA_DA_EMISSAO} >= ? AND ${DATA_DA_EMISSAO} <= ?${SO_PRODUCAO}`,
    )
    .get(companyId, limites.inicio, limites.fim) as { n: number; bytes: number };

  const eventos = db
    .prepare(
      // O byte que conta é o do arquivo que VAI entrar: o procEventoNFe
      // quando existe, o retorno sanitizado quando não.
      `SELECT COUNT(*) AS n,
              COALESCE(SUM(LENGTH(CAST(COALESCE(e.xml_proc, e.xml) AS BLOB))), 0) AS bytes
         FROM core_fiscal_events e
         JOIN core_fiscal_documents d ON d.id = e.document_id
        WHERE e.company_id = ?
          AND e.event_type IN ('cancelled', 'cce_authorized')
          AND e.xml IS NOT NULL AND e.xml <> ''
          AND COALESCE(e.protocol, '') <> ''
          AND e.created_at >= ? AND e.created_at <= ?${SO_PRODUCAO}${SO_EVENTO_REAL}`,
    )
    .get(companyId, limites.inicio, limites.fim) as { n: number; bytes: number };

  const recebidas = db
    .prepare(
      `SELECT COUNT(*) AS n,
              COALESCE(SUM(LENGTH(CAST(n.xml_original AS BLOB))), 0) AS bytes
         FROM core_inbound_notes n
        WHERE n.company_id = ?
          AND COALESCE(n.xml_original, '') <> ''
          AND ${DATA_DA_ENTRADA} >= ? AND ${DATA_DA_ENTRADA} <= ?`,
    )
    .get(companyId, limites.inicio, limites.fim) as { n: number; bytes: number };

  /*
    A INUTILIZAÇÃO TAMBÉM PESA — desde que ela passou a entregar arquivo.

    Enquanto a faixa era só uma linha de CSV, ela não custava memória e não
    aparecia aqui. Agora cada faixa com procInutNFe (ou, no legado, com o
    retorno guardado) vira um arquivo carregado do SQLite antes do zip. Deixar
    esta consulta de fora faria o teto medir menos do que o pacote carrega —
    e um teto que subestima é um teto que não protege.

    O `COALESCE(xml_proc, xml)` é o mesmo do evento: o byte que conta é o do
    arquivo que VAI entrar.
  */
  const inutilizacoes = db
    .prepare(
      `SELECT COUNT(*) AS n,
              COALESCE(SUM(LENGTH(CAST(COALESCE(xml_proc, xml) AS BLOB))), 0) AS bytes
         FROM core_fiscal_events
        WHERE company_id = ? AND event_type = 'void_authorized'
          AND COALESCE(xml_proc, xml, '') <> ''
          AND created_at >= ? AND created_at <= ?${SO_EVENTO_REAL_SEM_APELIDO}`,
    )
    .get(companyId, limites.inicio, limites.fim) as { n: number; bytes: number };

  return {
    documentos:
      Number(emitidas.n) + Number(eventos.n) + Number(recebidas.n) + Number(inutilizacoes.n),
    bytes:
      Number(emitidas.bytes)
      + Number(eventos.bytes)
      + Number(recebidas.bytes)
      + Number(inutilizacoes.bytes),
  };
}

function mensagemDoTeto(volume: VolumeDoPeriodo): string {
  const mb = (volume.bytes / (1024 * 1024)).toFixed(1).replace('.', ',');
  return (
    `Este período tem ${volume.documentos} documento(s) e ${mb} MB de XML. `
    + `O pacote é montado inteiro na memória do servidor, e o teto é de `
    + `${TETO_DE_DOCUMENTOS} documentos ou ${TETO_DE_BYTES / (1024 * 1024)} MB. `
    + 'Peça os arquivos em duas metades do mês, ou fale com quem mantém o sistema.'
  );
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

// As quatro funções que moravam aqui — `campoCsv`, `linhaCsv`, `montarCsv` e
// `reais` — foram para `Csv.ts`, e são importadas no topo deste arquivo. O
// motivo completo está lá e no comentário do import: um gerador de CSV só,
// servindo o zip do contador e a Central de Relatórios (GAP-V37). Duplicá-las
// criaria o segundo formato de CSV do sistema no dia do primeiro conserto de
// escape feito de um lado só — e a forma de descobrir seria o contador abrindo
// dois arquivos da mesma casa, um com acento e outro sem.

// ---------------------------------------------------------------------------
// O pacote
// ---------------------------------------------------------------------------

export interface PacoteDoContador {
  nomeArquivo: string;
  bytes: Buffer;
  /**
   * SHA-256 (hex minúsculo) dos BYTES deste zip — o que o download entrega e o
   * que o e-mail anexa (GAP-PRD-176). Muda a cada montagem, porque o zip leva
   * a hora em que foi montado; por isso ele é registrado a cada entrega.
   */
  sha256: string;
  /**
   * SHA-256 do MANIFESTO.csv de dentro do zip. Este é DETERMINÍSTICO: o mesmo
   * mês com os mesmos documentos dá o mesmo número, e ele amarra o hash de
   * cada arquivo do pacote.
   */
  manifestoSha256: string;
}

/** Uma linha do manifesto: o arquivo e o que ele é. */
interface LinhaDoManifesto {
  caminho: string;
  tipo: string;
  referencia: string;
  data: string;
  observacao: string;
}

/**
 * Impede dois arquivos com o mesmo nome dentro do zip.
 *
 * Duas notas com a mesma chave de acesso não deveriam existir — o banco tem
 * chave única para isso —, mas o nome também é montado com dado de fora
 * (chave do fornecedor, sequência de evento). Um zip com nomes repetidos faz o
 * Expand-Archive sobrescrever em silêncio, e o contador recebe menos arquivos
 * do que o manifesto promete.
 */
function nomeadorUnico(): (nome: string) => string {
  const usados = new Set<string>();
  return (nome) => {
    if (!usados.has(nome)) {
      usados.add(nome);
      return nome;
    }
    const ponto = nome.lastIndexOf('.');
    const base = ponto > 0 ? nome.slice(0, ponto) : nome;
    const ext = ponto > 0 ? nome.slice(ponto) : '';
    let n = 2;
    let candidato = `${base}-${n}${ext}`;
    while (usados.has(candidato)) {
      n += 1;
      candidato = `${base}-${n}${ext}`;
    }
    usados.add(candidato);
    return candidato;
  };
}

/**
 * O dia de calendário DA LOJA que vai escrito no pacote (GAP-PRD-051).
 *
 * O recorte do mês já era o da loja (`limitesDoMes`/`diaDaLojaSql`), mas as
 * datas impressas no MANIFESTO e no CSV eram `slice(0, 10)` do instante UTC:
 * a nota das 21h30 de 31/07 entrava no pacote de julho datada 2026-08-01 — a
 * linha contradizia o próprio pacote e o dhEmi do XML. Vazio continua vazio,
 * data de calendário passa como veio, e valor que não é data volta cortado
 * como antes, em vez de derrubar o pacote inteiro.
 */
function diaDoPacote(valor: unknown): string {
  const texto = String(valor ?? '').trim();
  if (!texto) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(texto)) return texto;
  if (Number.isNaN(new Date(texto).getTime())) return texto.slice(0, 10);
  return diaDaLoja(texto);
}

/** SHA-256 em hex minúsculo — dos bytes EXATOS que o zip guarda (UTF-8). */
function sha256Hex(conteudo: string | Buffer): string {
  return createHash('sha256').update(conteudo).digest('hex');
}

const ROTULO_DO_EVENTO: Record<string, string> = {
  cancelled: 'cancelamento',
  cce_authorized: 'carta-de-correcao',
};

/**
 * Monta o zip do mês.
 *
 * A ordem aqui é: medir, recusar se estourar, buscar, compor, e só então
 * escrever o LEIA-ME — que é escrito POR ÚLTIMO de propósito, porque ele
 * descreve o que realmente entrou, não o que se pretendia colocar.
 */
export function montarPacote(companyId: string, period: string): PacoteDoContador {
  ensureCoreSchema();
  const limites = periodBounds(period);
  const empresa = empresaDe(companyId);
  const db = getConnection();

  const volume = medirVolume(companyId, limites);
  if (volume.documentos > TETO_DE_DOCUMENTOS || volume.bytes > TETO_DE_BYTES) {
    throw new ApiError('CORE_FISCAL_PACOTE_GRANDE_DEMAIS', mensagemDoTeto(volume), 413, {
      documentos: volume.documentos,
      bytes: volume.bytes,
      tetoDocumentos: TETO_DE_DOCUMENTOS,
      tetoBytes: TETO_DE_BYTES,
    });
  }

  const arquivos: ArquivoDoZip[] = [];
  const manifesto: LinhaDoManifesto[] = [];
  const nomear = nomeadorUnico();

  // ------------------------------------------------------------- emitidas
  const emitidas = db
    .prepare(
      `SELECT d.id, d.model, d.serie, d.number, d.access_key AS accessKey, d.status,
              d.xml_signed AS xmlSigned, d.xml_authorized AS xmlAuthorized,
              ${DATA_DA_EMISSAO} AS emissao
         FROM core_fiscal_documents d
        WHERE d.company_id = ?
          AND d.status IN ('AUTHORIZED', 'CANCELLED')
          AND ${DATA_DA_EMISSAO} >= ? AND ${DATA_DA_EMISSAO} <= ?${SO_PRODUCAO}
        ORDER BY d.model, d.serie, d.number`,
    )
    .all(companyId, limites.inicio, limites.fim) as unknown as (DocumentoEmitido & {
    emissao: string;
  })[];

  let emitidasSemProc = 0;
  for (const doc of emitidas) {
    const proc = montarProcNfe({ xmlAssinado: doc.xmlSigned, protocolo: doc.xmlAuthorized });
    if (!proc) {
      /*
        SEM AS DUAS METADES, NENHUM ARQUIVO — e a ausência vai escrita no
        manifesto. A alternativa seria gravar o `xml_signed` sozinho com nome
        de procNFe: um arquivo que abre, que parece o documento certo, e que
        não prova autorização nenhuma. O contador só descobriria na
        fiscalização.
      */
      emitidasSemProc += 1;
      manifesto.push({
        caminho: '(não gerado)',
        tipo: 'NF-e autorizada',
        referencia: doc.accessKey ?? doc.id,
        data: diaDoPacote(doc.emissao),
        observacao:
          'Faltou o XML assinado ou o protocolo da SEFAZ. Sem as duas metades não é possível '
          + 'montar o nfeProc sem inventar prova de autorização.',
      });
      continue;
    }
    const nome = nomear(`emitidas/${doc.accessKey ?? doc.id}-procNFe.xml`);
    arquivos.push({ nome, conteudo: proc });
    manifesto.push({
      caminho: nome,
      tipo: doc.status === 'CANCELLED' ? 'NF-e cancelada (nfeProc)' : 'NF-e autorizada (nfeProc)',
      referencia: doc.accessKey ?? doc.id,
      data: diaDoPacote(doc.emissao),
      observacao: `Modelo ${doc.model}, série ${doc.serie}, número ${doc.number}.`,
    });
  }

  // -------------------------------------------------------------- eventos
  const eventos = db
    .prepare(
      `SELECT e.id, e.event_type AS eventType, e.sequence, e.xml, e.xml_proc AS xmlProc,
              e.created_at AS createdAt, d.access_key AS accessKey
         FROM core_fiscal_events e
         JOIN core_fiscal_documents d ON d.id = e.document_id
        WHERE e.company_id = ?
          AND e.event_type IN ('cancelled', 'cce_authorized')
          AND e.xml IS NOT NULL AND e.xml <> ''
          AND COALESCE(e.protocol, '') <> ''
          AND e.created_at >= ? AND e.created_at <= ?${SO_PRODUCAO}${SO_EVENTO_REAL}
        ORDER BY e.created_at, e.rowid`,
    )
    .all(companyId, limites.inicio, limites.fim) as unknown as EventoDoPeriodo[];

  /*
    DOIS FORMATOS DE EVENTO CONVIVEM NO MESMO ZIP (GAP-V32), e o pacote diz
    qual é qual em vez de fingir que são o mesmo:

      - evento NOVO tem `xml_proc`: o procEventoNFe íntegro, guardado no
        instante do evento com a assinatura preservada — é o formato de
        arquivamento, validável fora do portal;
      - evento LEGADO só tem o retorno sanitizado: a assinatura foi apagada
        antes de gravar, é irreversível, e o LEIA-ME manda ao portal da SEFAZ.

    "Melhorar" o legado — recompor um procEventoNFe com a assinatura
    "[removido]" dentro — produziria o arquivo que abre e não prova nada, a
    mesma armadilha do procNFe montado da resposta.
  */
  let eventosLegado = 0;
  for (const ev of eventos) {
    const rotulo = ROTULO_DO_EVENTO[ev.eventType] ?? ev.eventType;
    const integro = Boolean(ev.xmlProc && ev.xmlProc.trim());
    if (!integro) eventosLegado += 1;
    const nome = nomear(
      `eventos/${ev.accessKey ?? ev.id}-${rotulo}-${String(ev.sequence).padStart(2, '0')}`
        + `${integro ? '-procEventoNFe' : ''}.xml`,
    );
    arquivos.push({ nome, conteudo: integro ? ev.xmlProc! : ev.xml });
    manifesto.push({
      caminho: nome,
      tipo: rotulo === 'cancelamento' ? 'Cancelamento de NF-e' : 'Carta de correção',
      referencia: ev.accessKey ?? ev.id,
      data: diaDoPacote(ev.createdAt),
      observacao: integro
        ? 'procEventoNFe completo (evento assinado + retorno da SEFAZ), formato de '
          + 'arquivamento. Recortado pela data DO EVENTO.'
        : 'RETORNO da SEFAZ com assinatura removida (evento anterior à guarda do íntegro). '
          + 'Recortado pela data DO EVENTO.',
    });
  }

  /*
    ------------------------------------------------------------- recebidas

    UMA consulta para as quatro situações, e não duas para "tem XML" e "não
    tem". Eram duas, e o corte entre elas era `xml_original` vazio — o que
    jogava a compra sem nota fiscal e a nota estornada no mesmo balde do XML
    perdido, com a explicação do XML perdido escrita em cima delas.

    Buscar tudo de uma vez e classificar com `baldeDaEntrada` é o que garante
    que a PRÉVIA e o PACOTE contem a mesma coisa: a mesma função decide nos
    dois lados. Duas consultas com dois critérios divergem no primeiro
    conserto feito de um lado só, e a divergência aparece como a tela
    prometendo um arquivo que o zip não traz.
  */
  const entradas = db
    .prepare(
      `SELECT n.id, n.access_key AS accessKey, n.number, n.xml_original AS xmlOriginal,
              n.status, COALESCE(n.doc_type, 'nfe') AS docType,
              ${DATA_DA_ENTRADA} AS entrada
         FROM core_inbound_notes n
        WHERE n.company_id = ?
          AND ${DATA_DA_ENTRADA} >= ? AND ${DATA_DA_ENTRADA} <= ?
        ORDER BY entrada, n.rowid`,
    )
    .all(companyId, limites.inicio, limites.fim) as unknown as NotaRecebida[];

  let recebidasComArquivo = 0;
  let recebidasSemNota = 0;
  let recebidasEstornadas = 0;
  let recebidasSemArquivo = 0;

  for (const nota of entradas) {
    const xml = nota.xmlOriginal ?? '';
    const data = diaDoPacote(nota.entrada);
    /*
      A REFERÊNCIA DA ENTRADA MANUAL NÃO É A CHAVE. Ela é sintética —
      "manual:<uuid>" — e não diz nada a quem procura o documento na mesa. O
      número digitado é o que a pessoa escreveu no papel do fornecedor, e é
      por ele que a compra se acha.
    */
    const referencia = nota.docType === 'manual' ? (nota.number ?? nota.id) : nota.accessKey;

    switch (baldeDaEntrada({ status: nota.status, docType: nota.docType, temXml: xml !== '' })) {
      case 'com_arquivo': {
        recebidasComArquivo += 1;
        const nome = nomear(`recebidas/${nota.accessKey}-nfe.xml`);
        arquivos.push({ nome, conteudo: xml });
        manifesto.push({
          caminho: nome,
          tipo: 'NF-e de entrada (compra)',
          referencia: nota.accessKey,
          data,
          observacao:
            'Arquivo do fornecedor, exatamente como chegou. Recortado pela data de ENTRADA da '
            + 'mercadoria, que é como a compra é escriturada.',
        });
        break;
      }

      case 'sem_nfe': {
        recebidasSemNota += 1;
        manifesto.push({
          caminho: '(sem NF-e)',
          tipo: 'Compra sem nota fiscal (entrada manual)',
          referencia,
          data,
          observacao:
            'Compra digitada na tela porque o fornecedor não emite nota (feira, autônomo, '
            + 'produtor rural). Ela nunca teve XML: não é arquivo perdido, é documento fiscal '
            + 'que não existiu.',
        });
        break;
      }

      case 'estornada': {
        recebidasEstornadas += 1;
        if (xml === '') {
          manifesto.push({
            caminho: '(estornada)',
            tipo: 'Entrada estornada (documento morto)',
            referencia,
            data,
            observacao:
              'Entrada confirmada e depois DESFEITA: o estoque voltou e o título foi cancelado. '
              + 'Não há XML guardado, e ela não deve ser escriturada como compra.',
          });
          break;
        }
        /*
          O ARQUIVO SAI, MAS FORA DE `recebidas/` — e a pasta é a interface.

          Quem recebe o zip arrasta `recebidas/` inteira para o importador do
          escritório; o manifesto é lido depois, quando é lido. Uma nota
          estornada ali dentro vira compra escriturada — só que o estoque já
          voltou, o contas a pagar já foi cancelado, e o resultado do mês
          ganharia uma despesa que o próprio sistema desfez.

          Omitir o arquivo seria pior no outro sentido: a NF-e existe na SEFAZ
          contra este CNPJ, e o cruzamento do fisco a cobra. O contador precisa
          saber que ela existe E que não entrou.
        */
        const nome = nomear(`estornadas/${nota.accessKey}-nfe.xml`);
        arquivos.push({ nome, conteudo: xml });
        manifesto.push({
          caminho: nome,
          tipo: 'Entrada estornada (documento morto)',
          referencia: nota.accessKey,
          data,
          observacao:
            'Entrada confirmada e depois DESFEITA: o estoque voltou e o título foi cancelado. O '
            + 'arquivo do fornecedor está aqui porque a nota existe na SEFAZ, mas ela NÃO deve '
            + 'ser escriturada como compra.',
        });
        break;
      }

      case 'xml_perdido':
      default: {
        recebidasSemArquivo += 1;
        manifesto.push({
          caminho: '(não guardado)',
          tipo: 'NF-e de entrada (compra)',
          referencia: nota.accessKey,
          data,
          observacao:
            'Esta nota entrou antes de o sistema guardar o arquivo do fornecedor. O XML não '
            + 'existe mais e não há como recuperá-lo.',
        });
        break;
      }
    }
  }

  // ------------------------------------------------------------ numeração
  const faixas = db
    .prepare(
      `SELECT model, serie, number_from AS numberFrom, number_to AS numberTo,
              protocol, justification, created_at AS createdAt,
              xml, xml_proc AS xmlProc
         FROM core_fiscal_events
        WHERE company_id = ? AND event_type = 'void_authorized'
          AND created_at >= ? AND created_at <= ?${SO_EVENTO_REAL_SEM_APELIDO}
        ORDER BY model, serie, number_from`,
    )
    .all(companyId, limites.inicio, limites.fim) as unknown as FaixaInutilizada[];

  /*
    ==========================================================================
    A FAIXA QUEIMADA ENTREGA O ARQUIVO, E NÃO SÓ A LINHA DA PLANILHA
    ==========================================================================

    Até aqui a inutilização saía do pacote como UMA LINHA de
    `numeracao/inutilizadas.csv`: modelo, série, faixa, protocolo, data,
    justificativa. Texto que este sistema digitou sobre si mesmo.

    Numa fiscalização sobre o buraco na numeração — que é exatamente o momento
    em que a inutilização importa, porque ela existe PARA justificar números
    que nunca viraram nota —, o que a empresa tinha para mostrar era essa
    planilha. Enquanto isso o `procInutNFe` íntegro (o inutNFe ASSINADO
    costurado com o retInutNFe da SEFAZ) estava guardado em `xml_proc`, desde
    a rodada que fechou o resíduo do GAP-V32, e não chegava a ninguém.

    A consulta de eventos não o alcançava por construção: ela filtra
    `event_type IN ('cancelled', 'cce_authorized')`, e a inutilização não é
    evento de documento — ela não TEM documento, é uma faixa de números.

    A DISTINÇÃO É A MESMA DO EVENTO, e por isso o sufixo é o mesmo gesto:
    arquivo com `-procInutNFe` é o documento de arquivamento, validável em
    mãos; sem o sufixo é o RETORNO da SEFAZ com a assinatura já apagada por
    `sanitizeResponse`, irreversível, e o LEIA-ME manda ao portal. Recompor um
    "procInutNFe" em cima do legado produziria o arquivo que abre e não prova
    nada — a mesma armadilha do procNFe montado da resposta.

    Os arquivos ficam em `numeracao/`, ao lado do CSV, porque é isso que eles
    são: prova da numeração queimada. Em `eventos/` ficariam sob a promessa de
    ter uma nota por trás, e inutilização não tem.
  */
  let inutilizacoesArquivo = 0;
  let inutilizacoesLegado = 0;
  for (const f of faixas) {
    const integro = Boolean(f.xmlProc && f.xmlProc.trim());
    const conteudo = integro ? f.xmlProc! : (f.xml ?? '');
    const faixaTexto = `${f.model ?? '?'}-${f.serie ?? '?'}-${f.numberFrom ?? '?'}-${f.numberTo ?? '?'}`;
    const referencia = `modelo ${f.model}, série ${f.serie}, ${f.numberFrom} a ${f.numberTo}`;
    const data = diaDoPacote(f.createdAt);

    if (!conteudo.trim()) {
      /*
        Faixa anterior até ao retorno guardado. O número está queimado — o fato
        existe e o CSV o lista —, e o pacote diz que arquivo não há, em vez de
        deixar a ausência passar por completude.
      */
      manifesto.push({
        caminho: '(não guardado)',
        tipo: 'Inutilização de numeração',
        referencia,
        data,
        observacao:
          'Faixa inutilizada antes de o sistema guardar o arquivo. Nem o procInutNFe nem o '
          + 'retorno da SEFAZ existem, e não há como recuperá-los. A faixa está no CSV.',
      });
      continue;
    }

    inutilizacoesArquivo += 1;
    if (!integro) inutilizacoesLegado += 1;
    const nome = nomear(
      `numeracao/inut-${faixaTexto}${integro ? '-procInutNFe' : ''}.xml`,
    );
    arquivos.push({ nome, conteudo });
    manifesto.push({
      caminho: nome,
      tipo: integro
        ? 'Inutilização de numeração (procInutNFe)'
        : 'Inutilização de numeração (retorno da SEFAZ)',
      referencia,
      data,
      observacao: integro
        ? 'procInutNFe completo (inutNFe assinado + retorno da SEFAZ), formato de arquivamento. '
          + 'Recortado pela data DA INUTILIZAÇÃO.'
        : 'RETORNO da SEFAZ com assinatura removida (faixa anterior à guarda do íntegro). '
          + 'Recortado pela data DA INUTILIZAÇÃO.',
    });
  }

  if (faixas.length > 0) {
    /*
      SÓ `void_authorized`, e é a diferença entre um relatório e uma
      confusão. A tabela de eventos é append-only: um pedido de inutilização
      deixa `void_requested`, e uma recusa deixa `void_rejected`. Faixa PEDIDA
      e faixa RECUSADA não estão inutilizadas — os números continuam válidos.
      Listá-las junto faria o contador declarar como queimada uma numeração
      que ainda pode virar nota.
    */
    const linhas = [
      linhaCsv(['modelo', 'serie', 'numero_inicial', 'numero_final', 'protocolo', 'data', 'justificativa']),
      ...faixas.map((f) =>
        linhaCsv([
          f.model,
          f.serie,
          f.numberFrom,
          f.numberTo,
          f.protocol,
          diaDoPacote(f.createdAt),
          f.justification,
        ]),
      ),
    ];
    const nome = nomear('numeracao/inutilizadas.csv');
    arquivos.push({ nome, conteudo: montarCsv(linhas) });
    manifesto.push({
      caminho: nome,
      tipo: 'Faixas de numeração inutilizadas',
      referencia: `${faixas.length} faixa(s)`,
      data: limites.ultimoDia,
      observacao: 'Apenas inutilizações AUTORIZADAS. Pedido e recusa não queimam numeração.',
    });
  }

  // ------------------------------------------------------------- resultado
  const dre = incomeStatement(companyId, limites.primeiroDia, limites.ultimoDia);
  const linhasDre = [
    linhaCsv(['lado', 'categoria', 'lancamentos', 'valor']),
    ...dre.revenue.lines.map((l) => linhaCsv(['Receita', l.categoryName, l.entryCount, reais(l.totalCents)])),
    linhaCsv(['Receita', 'TOTAL', dre.revenue.entryCount, reais(dre.revenue.totalCents)]),
    ...dre.expense.lines.map((l) => linhaCsv(['Despesa', l.categoryName, l.entryCount, reais(l.totalCents)])),
    linhaCsv(['Despesa', 'TOTAL', dre.expense.entryCount, reais(dre.expense.totalCents)]),
    linhaCsv(['Resultado', 'Receita - Despesa', '', reais(dre.resultCents)]),
  ];
  const nomeDre = nomear('resultado/dre.csv');
  arquivos.push({ nome: nomeDre, conteudo: montarCsv(linhasDre) });
  manifesto.push({
    caminho: nomeDre,
    tipo: 'Demonstrativo de resultado (competência)',
    referencia: `${limites.primeiroDia} a ${limites.ultimoDia}`,
    data: limites.ultimoDia,
    observacao:
      'Por competência, não por caixa, e SEM CMV. As ressalvas inteiras estão no LEIA-ME.',
  });

  /*
    O `resultado/` é a única pasta que entra SEMPRE. As outras somem quando não
    têm conteúdo, porque pasta vazia é lida como perda de dado — mas um DRE
    ausente seria lido como "o relatório não foi gerado", e um DRE de mês sem
    movimento (todos os totais em zero) é uma informação, não um vazio.
  */

  // -------------------------------------------------------- manifesto e leia-me
  /*
    O SHA-256 DE CADA ARQUIVO, NA ÚLTIMA COLUNA (GAP-PRD-176).

    Calculado sobre o MESMO conteúdo que `montarZip` grava — texto em UTF-8,
    byte a byte —, então quem extrai o zip e roda `certutil`/`sha256sum`
    chega ao mesmo número. Linha sem arquivo ("(não gerado)", "(não
    guardado)") fica com a coluna vazia: hash de arquivo que não existe seria
    prova inventada. A coluna vai por ÚLTIMO para não mexer na ordem que as
    planilhas do escritório já leem.
  */
  const hashPorArquivo = new Map(
    arquivos.map((a) => [a.nome, sha256Hex(a.conteudo)] as [string, string]),
  );
  const linhasManifesto = [
    linhaCsv(['arquivo', 'o_que_e', 'referencia', 'data', 'observacao', 'sha256']),
    ...manifesto.map((m) =>
      linhaCsv([
        m.caminho,
        m.tipo,
        m.referencia,
        m.data,
        m.observacao,
        hashPorArquivo.get(m.caminho) ?? '',
      ]),
    ),
  ];
  const conteudoDoManifesto = montarCsv(linhasManifesto);
  const manifestoSha256 = sha256Hex(conteudoDoManifesto);
  arquivos.unshift({ nome: 'MANIFESTO.csv', conteudo: conteudoDoManifesto });

  arquivos.unshift({
    nome: 'LEIA-ME.txt',
    conteudo: montarLeiaMe({
      companyId,
      empresa,
      limites,
      emitidas: arquivos.filter((a) => a.nome.startsWith('emitidas/')).length,
      emitidasSemProc,
      eventos: eventos.length,
      eventosLegado,
      recebidas: recebidasComArquivo,
      recebidasSemArquivo,
      recebidasSemNota,
      recebidasEstornadas,
      estornadasComArquivo: arquivos.filter((a) => a.nome.startsWith('estornadas/')).length,
      faixas: faixas.length,
      inutilizacoesArquivo,
      inutilizacoesLegado,
      dreCaveats: dre.caveats,
      manifestoSha256,
    }),
  });

  const bytes = montarZip(arquivos);
  return {
    nomeArquivo: nomeDoPacote(empresa.slug, limites.period),
    bytes,
    sha256: sha256Hex(bytes),
    manifestoSha256,
  };
}

// ---------------------------------------------------------------------------
// O LEIA-ME
// ---------------------------------------------------------------------------

interface DadosDoLeiaMe {
  companyId: string;
  empresa: { nome: string; slug: string };
  limites: LimitesDoPeriodo;
  emitidas: number;
  emitidasSemProc: number;
  eventos: number;
  /** Quantos eventos saíram SEM o procEventoNFe — os de antes da guarda. */
  eventosLegado: number;
  recebidas: number;
  /** SÓ o XML perdido — a nota pré-v58. Ver `baldeDaEntrada`. */
  recebidasSemArquivo: number;
  /** Compras SEM nota fiscal: a entrada manual, que nunca teve XML. */
  recebidasSemNota: number;
  /** Entradas DESFEITAS no período — documento morto. */
  recebidasEstornadas: number;
  /** Quantas dessas estornadas tinham XML e saíram em `estornadas/`. */
  estornadasComArquivo: number;
  faixas: number;
  /** Faixas que viraram ARQUIVO (íntegro ou legado); o resto é só CSV. */
  inutilizacoesArquivo: number;
  /** Dessas, quantas saíram só como retorno da SEFAZ, sem o procInutNFe. */
  inutilizacoesLegado: number;
  dreCaveats: string[];
  /** O SHA-256 do MANIFESTO.csv — escrito na seção de integridade. */
  manifestoSha256: string;
}

/**
 * O texto que abre o pacote.
 *
 * ## Por que ele diz o que NÃO tem, com nome e motivo
 *
 * Um pacote com a pasta `emitidas/` ausente pode significar duas coisas
 * opostas: "a empresa não vendeu nada" ou "a emissão nunca foi ligada". A
 * primeira é normal; a segunda é um sistema que não emite nota. Quem recebe o
 * arquivo não tem como distinguir, e a hipótese confortável é sempre a
 * primeira.
 *
 * ## E por que ele conta as DUAS pendências da emissão, não uma
 *
 * A leitura fácil é "falta instalar o certificado A1". É meia verdade, e meia
 * verdade aqui custa caro: `SEFAZ_ENDPOINTS` é um objeto VAZIO — os endereços
 * dos web services de cada UF também precisam ser preenchidos. Quem lesse só a
 * primeira metade compraria o certificado, instalaria, tentaria emitir e
 * receberia um erro que não fala de certificado nenhum.
 *
 * Tudo aqui é DERIVADO do estado real na hora em que o pacote é montado. Não
 * há frase fixa dizendo "zero notas": se um dia houver nota, o texto muda
 * sozinho.
 */
function montarLeiaMe(d: DadosDoLeiaMe): string {
  const certificado = getCertificateView(d.companyId);
  const ufsComEndereco = Object.keys(SEFAZ_ENDPOINTS);

  const linhas: string[] = [];
  const escrever = (texto = '') => linhas.push(texto);

  escrever(`PACOTE DO CONTADOR — ${d.empresa.nome}`);
  escrever(`Período: ${d.limites.primeiroDia} a ${d.limites.ultimoDia}`);
  // A hora da LOJA, com o fuso dito — a mesma régua de toda data do pacote
  // (GAP-PRD-051). Greenwich não é a hora de ninguém que vai ler isto.
  const agora = new Date();
  escrever(`Gerado em: ${diaDaLoja(agora)} ${horaDaLoja(agora)} (horário da loja, ${FUSO_DA_LOJA})`);
  escrever();
  escrever('Este arquivo descreve o que está dentro do pacote e — tão importante quanto —');
  escrever('o que NÃO está, com o motivo. Um pacote calado sobre as próprias lacunas faz');
  escrever('quem o recebe assumir que o mês está completo.');
  escrever();
  escrever('----------------------------------------------------------------------');
  escrever('O QUE TEM');
  escrever('----------------------------------------------------------------------');
  escrever();
  escrever('MANIFESTO.csv');
  escrever('  Uma linha por arquivo, dizendo o que ele é. As linhas com caminho');
  escrever('  "(não gerado)" ou "(não guardado)" são documentos que existem no sistema');
  escrever('  e cujo arquivo não pôde entrar — estão lá para não sumirem em silêncio.');
  escrever();

  if (d.emitidas > 0) {
    escrever(`emitidas/  — ${d.emitidas} arquivo(s)`);
    escrever('  Notas emitidas pela empresa, autorizadas e canceladas, no formato nfeProc');
    escrever('  (a nota assinada + o protocolo da SEFAZ no mesmo arquivo), que é o formato');
    escrever('  de arquivamento. Recorte pela data de EMISSÃO.');
  } else {
    escrever('emitidas/  — NÃO EXISTE neste pacote');
    escrever('  Nenhuma nota foi emitida por esta empresa neste período. Veja a seção');
    escrever('  "POR QUE NÃO HÁ NOTA EMITIDA" abaixo.');
  }
  escrever();

  if (d.emitidasSemProc > 0) {
    escrever(`  ATENÇÃO: ${d.emitidasSemProc} nota(s) do período ficaram FORA da pasta.`);
    escrever('  Faltou o XML assinado ou o protocolo, e montar o nfeProc sem uma das duas');
    escrever('  metades produziria um arquivo que parece autorizado sem provar nada.');
    escrever('  Elas estão no MANIFESTO.csv, com a chave de acesso.');
    escrever();
  }

  if (d.eventos > 0) {
    escrever(`eventos/  — ${d.eventos} arquivo(s)`);
    escrever('  Cancelamentos e cartas de correção OCORRIDOS neste período. O recorte é');
    escrever('  pela data do evento, não pela data da nota: um cancelamento deste mês');
    escrever('  sobre uma nota do mês passado pertence a este pacote.');
    /*
      A RESSALVA DO LEGADO, e só do legado (GAP-V32).

      Até esta rodada o arquivo de evento era a RESPOSTA da SEFAZ passada por
      `sanitizeResponse` — assinatura e certificado trocados por "[removido]".
      Consertar retroativamente é impossível (o que não foi guardado não
      existe), então esses eventos continuam saindo assim, e a ressalva abaixo
      diz por quê.

      O evento NOVO escapou da armadilha: o procEventoNFe íntegro é guardado
      no instante do evento, e o arquivo do zip leva o sufixo -procEventoNFe.
      A ressalva NÃO sai quando todo evento do mês é íntegro — um pacote que
      manda o contador ao portal para validar um arquivo perfeitamente
      validável em mãos gastaria a confiança que ele existe para construir.
    */
    if (d.eventos > d.eventosLegado) {
      escrever('  Os arquivos com sufixo -procEventoNFe são o documento de ARQUIVAMENTO');
      escrever('  completo: o evento assinado + o retorno da SEFAZ, no mesmo arquivo. A');
      escrever('  assinatura pode ser validada por qualquer leitor de NF-e.');
    }
    if (d.eventosLegado > 0) {
      escrever(`  ATENÇÃO: ${d.eventosLegado} arquivo(s) de evento são apenas o RETORNO da`);
      escrever('  SEFAZ, não o procEventoNFe. A assinatura e o certificado aparecem como');
      escrever('  "[removido]": eles são anteriores à guarda do documento íntegro e não há');
      escrever('  como recuperá-los. Para validar a assinatura desses eventos, use o portal');
      escrever('  da SEFAZ com a chave de acesso da nota.');
    }
  } else {
    escrever('eventos/  — NÃO EXISTE neste pacote');
    escrever('  Nenhum cancelamento nem carta de correção ocorreu neste período.');
  }
  escrever();

  if (d.recebidas > 0) {
    escrever(`recebidas/  — ${d.recebidas} arquivo(s)`);
    escrever('  XML das notas de COMPRA, exatamente como o fornecedor os enviou — nunca');
    escrever('  reescritos, porque reescrever invalidaria a assinatura do fornecedor.');
    escrever('  Recorte pela data de ENTRADA da mercadoria, que é como a compra é');
    escrever('  escriturada.');
  } else {
    escrever('recebidas/  — NÃO EXISTE neste pacote');
    escrever('  Nenhuma nota de compra com arquivo guardado entrou neste período.');
  }
  escrever();

  /*
    TRÊS AUSÊNCIAS, TRÊS PARÁGRAFOS — e antes eram três fatos num parágrafo só.

    O texto abaixo era escrito para toda nota de entrada com `xml_original`
    vazio, e dizia sempre a mesma coisa: "o arquivo foi lido e descartado antes
    da versão 58, não existe mais". Verdade para a nota do fornecedor de
    antigamente; mentira para as outras duas, que caíam no mesmo balde.

    A compra SEM nota fiscal nunca teve XML — mandar procurar um arquivo que
    jamais existiu queima o tempo de quem procura e, pior, esconde o fato que
    importa: houve compra sem documento fiscal. E a entrada ESTORNADA não é
    ausência nenhuma: é um documento morto, que às vezes tem o XML inteiro.
  */
  if (d.recebidasSemArquivo > 0) {
    escrever(`  ATENÇÃO: ${d.recebidasSemArquivo} nota(s) de compra entraram neste período`);
    escrever('  SEM arquivo. Até a versão 58 do sistema o XML da nota de entrada era lido e');
    escrever('  descartado — ele não existe mais em lugar nenhum e não há como recuperá-lo.');
    escrever('  Notas importadas a partir de agora trazem o arquivo junto. As afetadas estão');
    escrever('  no MANIFESTO.csv, com a chave de acesso.');
    escrever();
  }

  if (d.recebidasSemNota > 0) {
    escrever(`  ${d.recebidasSemNota} compra(s) sem nota fiscal entraram neste período.`);
    escrever('  São entradas DIGITADAS na tela, de fornecedor que não emite nota — feira,');
    escrever('  autônomo, produtor rural. Elas NUNCA tiveram XML: não é arquivo perdido, é');
    escrever('  documento fiscal que não existiu, e o sistema jamais fingiu o contrário. Estão');
    escrever('  no MANIFESTO.csv como "(sem NF-e)", pelo número que foi digitado.');
    escrever();
  }

  if (d.recebidasEstornadas > 0) {
    escrever(`  ${d.recebidasEstornadas} entrada(s) do período foram ESTORNADAS.`);
    escrever('  A entrada foi confirmada e depois desfeita: o estoque voltou e o título foi');
    escrever('  cancelado. O documento está morto e NÃO deve ser escriturado como compra —');
    escrever('  por isso ele não está em recebidas/.');
    if (d.estornadasComArquivo > 0) {
      escrever(`  ${d.estornadasComArquivo} dela(s) tem o XML guardado, e ele sai em`);
      escrever('  estornadas/. O arquivo vai junto porque a nota existe na SEFAZ contra este');
      escrever('  CNPJ e o cruzamento do fisco a cobra: o contador precisa saber que ela');
      escrever('  existe E que não entrou no resultado.');
    }
    escrever();
  }

  if (d.faixas > 0) {
    escrever(`numeracao/inutilizadas.csv  — ${d.faixas} faixa(s)`);
    escrever('  Faixas de numeração inutilizadas COM AUTORIZAÇÃO da SEFAZ. Pedidos sem');
    escrever('  resposta e pedidos recusados NÃO entram: aqueles números continuam válidos');
    escrever('  e ainda podem virar nota.');
    /*
      O CSV É O ÍNDICE; O ARQUIVO É A PROVA — e por rodadas a fio só o índice
      saía. A inutilização existe PARA justificar números que nunca viraram
      nota, e numa fiscalização sobre o buraco na numeração a empresa mostrava
      uma planilha que ela mesma tinha escrito.
    */
    if (d.inutilizacoesArquivo > 0) {
      escrever();
      escrever(`numeracao/inut-*.xml  — ${d.inutilizacoesArquivo} arquivo(s)`);
      escrever('  O documento de cada faixa, ao lado da linha do CSV. O CSV é o índice');
      escrever('  legível; o XML é a prova.');
      if (d.inutilizacoesArquivo > d.inutilizacoesLegado) {
        escrever('  Os arquivos com sufixo -procInutNFe são o documento de ARQUIVAMENTO');
        escrever('  completo: o inutNFe assinado + o retorno da SEFAZ, no mesmo arquivo. A');
        escrever('  assinatura pode ser validada por qualquer leitor de NF-e.');
      }
      if (d.inutilizacoesLegado > 0) {
        escrever(`  ATENÇÃO: ${d.inutilizacoesLegado} arquivo(s) de inutilização são apenas o RETORNO`);
        escrever('  da SEFAZ, não o procInutNFe. A assinatura e o certificado aparecem como');
        escrever('  "[removido]": eles são anteriores à guarda do documento íntegro e não há');
        escrever('  como recuperá-los. Para validar essas faixas, use o portal da SEFAZ com o');
        escrever('  protocolo que está no CSV.');
      }
    }
    if (d.faixas > d.inutilizacoesArquivo) {
      escrever(`  ${d.faixas - d.inutilizacoesArquivo} faixa(s) saíram SÓ no CSV: nem o`);
      escrever('  procInutNFe nem o retorno foram guardados, e não há como recuperá-los. Elas');
      escrever('  estão no MANIFESTO.csv como "(não guardado)".');
    }
  } else {
    escrever('numeracao/  — NÃO EXISTE neste pacote');
    escrever('  Nenhuma faixa de numeração foi inutilizada neste período.');
  }
  escrever();

  escrever('resultado/dre.csv');
  escrever('  Demonstrativo de resultado do período, por competência.');
  escrever();

  escrever('----------------------------------------------------------------------');
  escrever('O QUE NÃO TEM — E POR QUÊ');
  escrever('----------------------------------------------------------------------');
  escrever();
  /*
    A EXPLICAÇÃO DA AUSÊNCIA SÓ SAI QUANDO HÁ AUSÊNCIA.

    Este bloco era escrito sempre. Num pacote COM notas emitidas dentro, o
    contador leria "POR QUE NÃO HÁ NOTA EMITIDA" logo abaixo da pasta cheia —
    e a primeira reação de quem lê isso é desconfiar do que veio, não do
    texto. Um pacote que se contradiz gasta a confiança que ele existe para
    construir.

    A condição olha as DUAS contagens: nota que ficou de fora por faltar
    metade do procNFe também é nota emitida, e nesse caso a explicação certa é
    a que já está escrita lá em cima, não esta.
  */
  if (d.emitidas === 0 && d.emitidasSemProc === 0) {
    escrever('POR QUE NÃO HÁ NOTA EMITIDA');
    escrever();
    escrever('  Faltam DUAS coisas, e as duas são necessárias. Resolver só uma não destrava');
    escrever('  a emissão:');
    escrever();
    escrever(`  1. CERTIFICADO DIGITAL A1 — ${certificado.message}`);
    /*
      QUAL certificado, e não só o estado dele.

      A frase pronta diz "vence em N dias" e nada mais. Quem lê isso assume que
      é o certificado da empresa — e no banco real de hoje NÃO é: o que está
      instalado foi emitido por uma autoridade de TESTE, com um CNPJ de teste.
      Um pacote que anuncia "seu certificado vence em 13 dias" sobre um
      certificado de laboratório manda a pessoa correr atrás de uma renovação
      que ela não precisa fazer — e esconde a que ela precisa.

      Nomear titular, emissor e CNPJ resolve sem inventar regra nenhuma: quem
      lê reconhece o próprio certificado, ou não reconhece — e não reconhecer é
      exatamente a informação que importa.
    */
    const cert = certificado.certificate;
    if (cert) {
      const titular = String(cert.subject ?? '—');
      const emissor = String(cert.issuer ?? '—');
      const documento = String(cert.cnpj ?? '—');
      escrever(`     Titular: ${titular}`);
      escrever(`     Emissor: ${emissor}`);
      escrever(`     CNPJ do certificado: ${documento}`);
      escrever('     Confira se este é o certificado desta operação. Se o emissor ou o');
      escrever('     CNPJ não forem os seus, o que está instalado não serve para emitir.');
    }
    escrever();

    if (ufsComEndereco.length === 0) {
      escrever('  2. ENDEREÇOS DOS WEB SERVICES DA SEFAZ — nenhum está configurado.');
      escrever('     Não existe endereço nacional único: cada UF publica os seus, e alguns');
      escrever('     estados delegam a autorizadores diferentes. Enquanto a tabela estiver');
      escrever('     vazia, a transmissão é recusada antes mesmo de tentar — mesmo com o');
      escrever('     certificado instalado e válido.');
    } else {
      escrever(`  2. ENDEREÇOS DOS WEB SERVICES DA SEFAZ — configurados para: ${ufsComEndereco.join(', ')}.`);
      escrever('     Confira se a UF desta operação está nessa lista.');
    }
    escrever();
    escrever('  Enquanto os dois não estiverem resolvidos, o sistema NÃO emite NF-e nem');
    escrever('  NFC-e. Isso não afeta as notas de COMPRA, que são arquivos recebidos de');
    escrever('  terceiros e entram normalmente.');
    escrever();
  }

  escrever('O QUE O DRE NÃO INCLUI');
  escrever();
  for (const ressalva of d.dreCaveats) {
    escrever(`  - ${ressalva}`);
  }
  escrever();

  escrever('O QUE ESTE PACOTE NÃO É');
  escrever();
  escrever('  - Não é SPED e não é apuração de imposto. Ele entrega os documentos e o');
  escrever('    resultado; a apuração é do software do contador.');
  escrever('  - Não confere buracos de numeração entre uma nota e a seguinte.');
  escrever();

  /*
    A INTEGRIDADE (GAP-PRD-176) — por último, porque é a seção que se procura
    numa disputa, e não na primeira leitura.

    Um arquivo não pode trazer o próprio hash dentro de si. Por isso a cadeia:
    o MANIFESTO traz o SHA-256 de cada arquivo, este LEIA-ME traz o do
    MANIFESTO, e o do ZIP inteiro fica fora dele — no cabeçalho do download, na
    trilha de auditoria e no corpo do e-mail.
  */
  escrever('----------------------------------------------------------------------');
  escrever('INTEGRIDADE — COMO PROVAR QUE ESTE É O PACOTE QUE O SISTEMA GEROU');
  escrever('----------------------------------------------------------------------');
  escrever();
  escrever(`MANIFESTO.csv  SHA-256: ${d.manifestoSha256}`);
  escrever();
  escrever('  A última coluna do MANIFESTO.csv (sha256) traz o SHA-256 de cada arquivo');
  escrever('  deste pacote. O número acima amarra o MANIFESTO; o MANIFESTO amarra todos');
  escrever('  os outros. Se um arquivo for trocado, o hash dele deixa de bater; se o');
  escrever('  MANIFESTO for editado para esconder a troca, o número acima deixa de bater.');
  escrever();
  escrever('  O SHA-256 do .zip inteiro não cabe aqui dentro (um arquivo não contém o');
  escrever('  próprio hash): ele fica registrado no sistema, com quem baixou ou enviou e');
  escrever('  quando, e vai escrito no corpo do e-mail de envio.');
  escrever();
  escrever('  Para calcular no Windows:   certutil -hashfile MANIFESTO.csv SHA256');
  escrever('  No Linux ou no macOS:       sha256sum MANIFESTO.csv   (ou shasum -a 256)');
  escrever('  Para conferir o .zip contra o que o sistema entregou: tela "Fechamento do');
  escrever('  contador", quadro "Conferir um pacote recebido".');
  escrever();

  return linhas.join('\r\n');
}
