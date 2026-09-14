/**
 * Distribuição DF-e e Manifestação do Destinatário — rodada 44.
 *
 * ## O que isto é
 *
 * A fonte OFICIAL das notas do fornecedor: a SEFAZ entrega, por CNPJ
 * destinatário, tudo o que foi emitido contra o grupo — antes de o caminhão
 * chegar e sem depender de o fornecedor mandar e-mail. Até esta rodada os
 * únicos canais eram upload manual e caixa de e-mail.
 *
 * ## As decisões de desenho
 *
 * - **NSU é o cursor — POR AMBIENTE.** Cada documento devolvido tem um número
 *   sequencial único DENTRO do ambiente: homologação e produção são duas
 *   sequências, cada uma a partir do 1 (DFE-AMBIENTE, GAP-PRD-168). UNIQUE
 *   (company_id, environment, nsu) torna a reconsulta idempotente. O ponto de
 *   partida é o ultNSU que a SEFAZ DEVOLVEU (`core_dfe_cursors`, R3-DFE),
 *   nunca menos que o MAX(nsu) gravado, e a espera que ela impõe fica junto.
 *   A lista, a manifestação e a importação só enxergam o ambiente atual; o
 *   documento do outro é recusado com o porquê.
 *
 * - **O adapter é injetado**, como em todo o fiscal. Hoje só o simulador
 *   implementa `distributionDFe`/`manifest`; o SOAP real (NFeDistribuicaoDFe
 *   e RecepcaoEvento4, serviços do Ambiente Nacional) é a rodada 46. Método
 *   ausente responde 501 — o mesmo contrato que a carta de correção usou
 *   enquanto não existia.
 *
 * - **Manifestação só muda estado com PROTOCOLO.** O pedido é gravado em
 *   `core_fiscal_events` ANTES da chamada e o desfecho depois — append-only,
 *   como cancelamento e CC-e. Rejeição não toca no documento.
 *
 * - **Ciência libera o download.** É o comportamento real da SEFAZ: o resumo
 *   (resNFe) vem sem itens; manifestada a ciência, a nota completa (procNFe)
 *   fica disponível — e o serviço já a baixa na mesma conversa, melhor
 *   esforço. Só a nota completa entra no funil de conferência: resumo não tem
 *   item, e nota sem item não se confere.
 *
 * - **Confirmação, desconhecimento e não-realizada são DEFINITIVAS.** A
 *   ciência pode evoluir para qualquer uma; voltar atrás de uma definitiva é
 *   conversa com contador, não botão.
 */
import { randomUUID } from 'node:crypto';
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { recordAudit } from '../audit/AuditService.js';
import { loadEnv } from '../../config/env.js';
import { getFiscalConfig } from './FiscalConfigService.js';
import { horaDaLoja } from './CalendarioOperacional.js';
import { importNfe, type ImportResult } from './NfeImportService.js';
import type { SefazAdapter, SefazResponse } from './SefazAdapter.js';
import { CHAVES_DFE_DO_SIMULADOR } from './SefazTestAdapter.js';
import type { FiscalEnvironment } from './FiscalKeyService.js';

/** Os quatro eventos da manifestação, pelo nome que a tela fala. */
export const TIPOS_MANIFESTACAO = {
  ciencia: '210210',
  confirmacao: '210200',
  desconhecimento: '210220',
  nao_realizada: '210240',
} as const;

export type TipoManifestacao = keyof typeof TIPOS_MANIFESTACAO;

/** O que o adapter PRECISA saber fazer para este serviço — métodos opcionais. */
interface DfeCapableAdapter extends SefazAdapter {
  distributionDFe?: (input: {
    cnpj: string;
    lastNsu: number;
    accessKey?: string;
    environment?: string;
    uf?: string;
  }) => Promise<{
    cStat: string;
    xMotivo: string;
    ultNsu: number;
    /** O maior NSU da SEFAZ para o CNPJ; ausente no simulador (R3-DFE). */
    maxNsu?: number;
    docs: { nsu: string; schema: string; xml: string }[];
  }>;
  manifest?: (input: {
    accessKey: string;
    eventType: string;
    justification?: string;
    environment?: string;
  }) => Promise<SefazResponse>;
}

export interface DfeDocumento {
  nsu: string;
  /** O ambiente da consulta que trouxe o documento — a lista só traz o atual. */
  ambiente: FiscalEnvironment;
  schemaType: string;
  accessKey: string | null;
  supplierCnpj: string | null;
  supplierName: string | null;
  totalCents: number | null;
  issuedAt: string | null;
  manifestStatus: string | null;
  manifestProtocol: string | null;
  manifestedAt: string | null;
  importedNoteId: string | null;
  noteStatus: string | null;
  temXmlCompleto: boolean;
  receivedAt: string;
}

function soDigitos(texto: string | null | undefined): string {
  return String(texto ?? '').replace(/\D/g, '');
}

function cnpjDaEmpresa(companyId: string): string {
  const cnpj = soDigitos(getFiscalConfig(companyId).cnpj);
  if (cnpj.length !== 14) {
    throw new ApiError(
      'CORE_DFE_CNPJ_REQUIRED',
      'Configure o CNPJ fiscal da empresa antes de consultar a SEFAZ — é por ele que as notas destinadas são localizadas.',
      409,
    );
  }
  return cnpj;
}

/** Extrai um elemento simples de XML por regex — os resumos são planos. */
function campo(xml: string, tag: string): string | null {
  const m = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return m ? m[1] : null;
}

function centsDe(texto: string | null): number | null {
  if (!texto) return null;
  const numero = Number(texto);
  return Number.isFinite(numero) ? Math.round(numero * 100) : null;
}

/**
 * ============================================================================
 * O SIMULADOR NUNCA RESPONDE POR PRODUÇÃO (GAP-PRD-168)
 * ============================================================================
 *
 * O slot antigo da rota (`adapterRealOuSimulador`) devolvia o simulador sem a
 * senha do certificado sempre que `DEVORA_API_ENV` não era 'production' — e o
 * padrão dessa variável é 'development'. Um processo subido como todo Node
 * sobe (`NODE_ENV=production node dist/index.js`) e sem declarar a variável do
 * projeto consultaria a Distribuição DF-e no SIMULADOR: documentos inventados
 * entrariam em `core_dfe_documents` da empresa real, e — pior — a manifestação
 * gravaria "confirmação da operação" com protocolo de ensaio. Manifestação do
 * destinatário é ato com efeito jurídico.
 *
 * Hoje a rota decide pela política dos atos (`adapterDoAtoFiscal`: cofre ou
 * senha digitada, simulador só por pedido explícito fora de produção). A trava
 * continua AQUI, na porta dos dois atos, para quem chamar o serviço com
 * qualquer adapter, e olha as TRÊS coisas que dizem "isto é de verdade":
 * `DEVORA_API_ENV=production`, `NODE_ENV=production` (a mesma régua dos dois
 * nomes que `config/env.ts` usa para o cofre) e o ambiente fiscal da própria empresa
 * em produção. Adapter real passa sempre; o simulador só responde por
 * homologação em processo que não é de produção.
 */
export function exigirAdapterDeVerdade(
  adapter: SefazAdapter,
  companyId: string,
  ambiente: { apiEnv?: string; nodeEnv?: string } = {
    apiEnv: loadEnv().DEVORA_API_ENV,
    nodeEnv: process.env.NODE_ENV,
  },
): void {
  if (adapter.isReal) return;
  const processoDeProducao = ambiente.apiEnv === 'production' || ambiente.nodeEnv === 'production';
  const empresaEmProducao = getFiscalConfig(companyId).environment === 'production';
  if (processoDeProducao || empresaEmProducao) {
    throw new ApiError(
      'CORE_DFE_SIMULADOR_EM_PRODUCAO',
      'A consulta e a manifestação de NF-e destinadas precisam da SEFAZ de verdade: informe a senha '
        + 'do certificado A1 da operação. O simulador não responde por produção — documento e '
        + 'protocolo inventados não podem entrar na empresa real.',
      409,
      { processoDeProducao, empresaEmProducao },
    );
  }
}

/**
 * O adapter chega pronto ou como FÁBRICA. A rota manda a fábrica: abrir o A1
 * (ou pedir a senha dele) só depois das validações do domínio — a
 * justificativa curta, a chave desconhecida e o clique repetido respondem o
 * que são, e não "digite a senha" (GAP-PRD-168, a mesma ordem dos atos).
 */
export type AdapterOuFabrica = SefazAdapter | (() => SefazAdapter);

function resolverAdapter(adapter: AdapterOuFabrica): SefazAdapter {
  return typeof adapter === 'function' ? adapter() : adapter;
}

/*
  O ENSAIO DO SIMULADOR NÃO SEGURA A SEFAZ DE VERDADE (GAP-PRD-168).

  Até este conserto, "Buscar agora" em homologação falava com o simulador mesmo
  com o A1 no cofre: a instalação que clicou guarda os dois resumos que ele
  inventa (NSU 1 e 2, "Fornecedor Simulado"). Na mesma tabela da SEFAZ de
  verdade, eles seguravam o cursor (MAX(nsu) = 2), o UNIQUE (company_id, nsu)
  engolia calado as notas reais de NSU 1 e 2, e a lista oferecia manifestar e
  importar notas que ninguém emitiu.

  As chaves do simulador são fixas e têm DV inválido — nenhuma NF-e real tem
  uma delas —, então é por elas que o ensaio é reconhecido. Com o adapter REAL,
  a consulta não parte do cursor do ensaio e o tira da lista quando a SEFAZ
  responde, a manifestação não sai para chave inventada e, em produção, a nota
  inventada não entra no funil de conferência.
*/
function ehEnsaioDoSimulador(accessKey: string | null | undefined): boolean {
  return typeof accessKey === 'string' && CHAVES_DFE_DO_SIMULADOR.includes(accessKey);
}

const MARCAS_DO_ENSAIO = CHAVES_DFE_DO_SIMULADOR.map(() => '?').join(', ');

function recusarEnsaioDoSimulador(): never {
  throw new ApiError(
    'CORE_DFE_DOCUMENTO_DO_SIMULADOR',
    'Esta nota foi inventada pelo simulador num ensaio de homologação e não existe na SEFAZ: não há '
      + 'o que manifestar nem importar. "Buscar agora" traz as notas de verdade e tira o ensaio da lista.',
    409,
  );
}

/** A régua de `exigirAdapterDeVerdade`: processo OU empresa em produção. */
function emProducao(companyId: string): boolean {
  return (
    loadEnv().DEVORA_API_ENV === 'production'
    || process.env.NODE_ENV === 'production'
    || getFiscalConfig(companyId).environment === 'production'
  );
}

/*
  O NSU É POR AMBIENTE (DFE-AMBIENTE, GAP-PRD-168).

  O Ambiente Nacional numera homologação e produção em sequências separadas,
  cada uma a partir do 1. O roteiro de go-live manda homologar a Distribuição
  com notas reais de homologação (NSU 1..N) e depois virar para produção: com o
  cursor MAX(nsu) da EMPRESA, a primeira consulta de produção partia de N — as
  notas de produção de NSU ≤ N nunca eram pedidas, e as que viessem com NSU
  repetido eram engolidas pelo INSERT OR IGNORE. Nota de fornecedor perdida,
  sem aviso.

  O ambiente é o da configuração fiscal da empresa (o mesmo que viaja para o
  adapter). Cada documento guarda o ambiente da consulta que o trouxe; o
  cursor, a lista, a manifestação e a importação olham (empresa, ambiente).
*/
export function ambienteDaDistribuicao(companyId: string): FiscalEnvironment {
  return getFiscalConfig(companyId).environment === 'production' ? 'production' : 'homologation';
}

const NOME_DO_AMBIENTE: Record<FiscalEnvironment, string> = {
  homologation: 'homologação',
  production: 'produção',
};

function outroAmbiente(ambiente: FiscalEnvironment): FiscalEnvironment {
  return ambiente === 'production' ? 'homologation' : 'production';
}

/**
 * Documento de OUTRO ambiente não se manifesta nem se importa: a SEFAZ o
 * entregou por outra numeração, e agir sobre ele agora usaria o ambiente
 * errado — evento de produção para nota de homologação (que não existe lá), ou
 * nota sem valor fiscal no funil de conferência da produção.
 */
function recusarOutroAmbiente(
  doDocumento: FiscalEnvironment,
  atual: FiscalEnvironment,
  ato: 'manifestar' | 'importar',
): never {
  const porque = doDocumento === 'homologation'
    ? 'nota de homologação não tem valor fiscal e não se manifesta nem se importa na produção. '
      + 'As notas de produção chegam pelo "Buscar agora", pela numeração da produção.'
    : `para ${ato === 'manifestar' ? 'manifestá-la' : 'importá-la'}, volte o ambiente fiscal da empresa para produção.`;
  throw new ApiError(
    'CORE_DFE_OUTRO_AMBIENTE',
    `Este documento veio da Distribuição DF-e de ${NOME_DO_AMBIENTE[doDocumento]}, e a empresa está em `
      + `${NOME_DO_AMBIENTE[atual]}. A SEFAZ numera e entrega cada ambiente à parte: ${porque}`,
    409,
    { ambienteDoDocumento: doDocumento, ambienteAtual: atual },
  );
}

function exigirDfe(adapter: SefazAdapter): DfeCapableAdapter & Required<Pick<DfeCapableAdapter, 'distributionDFe'>> {
  const capaz = adapter as DfeCapableAdapter;
  if (!capaz.distributionDFe) {
    throw new ApiError(
      'CORE_SEFAZ_DFE_NOT_SUPPORTED',
      'Este ambiente ainda não fala com a Distribuição DF-e real — o cliente SOAP do Ambiente Nacional é a próxima etapa do fiscal.',
      501,
    );
  }
  return capaz as DfeCapableAdapter & Required<Pick<DfeCapableAdapter, 'distributionDFe'>>;
}

/** O rastro append-only, no mesmo formato dos demais eventos fiscais. */
function gravarEventoDfe(input: {
  companyId: string;
  eventType: string;
  accessKey: string;
  justification?: string | null;
  protocol?: string | null;
  cStat?: string | null;
  xMotivo?: string | null;
  userId?: string | null;
}): void {
  getConnection()
    .prepare(
      `INSERT INTO core_fiscal_events
         (id, company_id, document_id, event_type, sequence, justification, protocol,
          c_stat, x_motivo, xml, model, serie, number_from, number_to, user_id, created_at)
       VALUES (?, ?, NULL, ?, 1, ?, ?, ?, ?, ?, '55', NULL, NULL, NULL, ?, ?)`,
    )
    .run(
      randomUUID(),
      input.companyId,
      input.eventType,
      input.justification ?? null,
      input.protocol ?? null,
      input.cStat ?? null,
      input.xMotivo ?? null,
      /*
        A REVISÃO MORDEU AQUI: o rastro dizia QUE tentamos, mas não O QUÊ —
        pedido e rejeição ficavam órfãos de nota. A chave vai no campo do
        XML do evento como fragmento; o cliente SOAP real (rodada 46) o
        substituirá pelo envelope completo, que também carrega a chNFe.
      */
      `<chNFe>${input.accessKey}</chNFe>`,
      input.userId ?? null,
      new Date().toISOString(),
    );
}

/*
  ============================================================================
  O CURSOR É O QUE A SEFAZ DEVOLVE — E A ESPERA DELA É RESPEITADA (R3-DFE)
  ============================================================================

  O cursor era o MAX(nsu) GRAVADO. Depois de um cStat 137 ("nenhum documento
  localizado") ou de um lote só com o que não se grava, ele não andava: a
  consulta seguinte repetia o mesmo ultNSU, e a regra do Ambiente Nacional
  (NT 2014.002) trata consulta repetida sem documento novo como consumo
  indevido — o cStat 656 bloqueia o CNPJ por uma hora. E, com ultNSU < maxNSU,
  a SEFAZ manda continuar consultando até alcançar o maxNSU; o clique parava no
  primeiro lote.

  Por (empresa, ambiente), `core_dfe_cursors` guarda o ultNSU e o maxNSU da
  última resposta, o instante dela e a hora a partir da qual a próxima pode
  sair:

   - a consulta parte do ultNSU guardado, nunca de menos que o MAX(nsu)
     gravado (banco que já tinha notas, ou gravação que andou por fora);
   - com ultNSU < maxNSU, o mesmo clique continua — até LOTES_POR_CONSULTA;
     parando no teto, o próximo clique continua de onde parou, sem espera;
   - em dia (137, ou ultNSU = maxNSU): a próxima só depois de uma hora, e o
     clique cedo demais é recusado dizendo a hora — ANTES de abrir o A1;
   - 656: o bloqueio fica gravado e é respeitado, inclusive pelo download
     que a ciência dispara;
   - outra recusa da SEFAZ (ex.: 593) não anda o cursor nem impõe espera.

  Só a SEFAZ de verdade escreve o cursor: o simulador não segura a espera nem
  o ponto de partida (a mesma lição do ensaio que segurava o MAX(nsu)).
*/

/** Quantos lotes um clique pede, no máximo, enquanto ultNSU < maxNSU. */
export const LOTES_POR_CONSULTA = 20;

/** A espera do Ambiente Nacional: depois de estar em dia, e o bloqueio do 656. */
const ESPERA_DA_SEFAZ_MS = 60 * 60 * 1000;

type MotivoDaEspera = 'em_dia' | 'consumo_indevido';

interface LinhaDoCursor {
  ult_nsu: number;
  max_nsu: number | null;
  last_c_stat: string | null;
  last_response_at: string | null;
  next_query_at: string | null;
  wait_reason: MotivoDaEspera | null;
}

/** O que a última resposta da SEFAZ disse — a tela mostra a espera no botão. */
export interface EstadoDaDistribuicao {
  ultimoNsu: number;
  maxNsu: number | null;
  ultimoCStat: string | null;
  ultimaRespostaEm: string | null;
  /** Nula quando a consulta pode sair agora. */
  proximaConsultaEm: string | null;
  motivoDaEspera: MotivoDaEspera | null;
}

export interface ResultadoDaConsulta {
  novos: number;
  total: number;
  ultimoNsu: number;
  maxNsu: number | null;
  ambiente: FiscalEnvironment;
  /** Quantas vezes este clique foi à SEFAZ. */
  lotes: number;
  /** O teto do clique parou antes do maxNSU: o próximo continua, sem espera. */
  restamDocumentos: boolean;
  /** Em dia: a partir de quando a próxima consulta pode sair. */
  proximaConsultaEm: string | null;
}

function lerCursor(companyId: string, ambiente: FiscalEnvironment): LinhaDoCursor | undefined {
  return getConnection()
    .prepare('SELECT * FROM core_dfe_cursors WHERE company_id = ? AND environment = ?')
    .get(companyId, ambiente) as LinhaDoCursor | undefined;
}

/** A hora guardada, se ela ainda não chegou. */
function esperaQueVale(c: LinhaDoCursor | undefined): string | null {
  const quando = c?.next_query_at ?? null;
  return quando && Date.parse(quando) > Date.now() ? quando : null;
}

export function estadoDaDistribuicao(companyId: string): EstadoDaDistribuicao {
  ensureCoreSchema();
  const c = lerCursor(companyId, ambienteDaDistribuicao(companyId));
  const proxima = esperaQueVale(c);
  return {
    ultimoNsu: Number(c?.ult_nsu ?? 0),
    maxNsu: c?.max_nsu === null || c?.max_nsu === undefined ? null : Number(c.max_nsu),
    ultimoCStat: c?.last_c_stat ?? null,
    ultimaRespostaEm: c?.last_response_at ?? null,
    proximaConsultaEm: proxima,
    motivoDaEspera: proxima ? (c?.wait_reason ?? 'em_dia') : null,
  };
}

/** Grava a resposta. O ultNSU nunca recua; maxNsu nulo mantém o guardado. */
function gravarCursor(input: {
  companyId: string;
  ambiente: FiscalEnvironment;
  ultNsu: number;
  maxNsu: number | null;
  cStat: string;
  xMotivo: string;
  respostaEm: string;
  proximaConsultaEm: string | null;
  motivo: MotivoDaEspera | null;
}): void {
  getConnection()
    .prepare(
      `INSERT INTO core_dfe_cursors
         (company_id, environment, ult_nsu, max_nsu, last_c_stat, last_x_motivo,
          last_response_at, next_query_at, wait_reason, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (company_id, environment) DO UPDATE SET
         ult_nsu = MAX(core_dfe_cursors.ult_nsu, excluded.ult_nsu),
         max_nsu = COALESCE(excluded.max_nsu, core_dfe_cursors.max_nsu),
         last_c_stat = excluded.last_c_stat,
         last_x_motivo = excluded.last_x_motivo,
         last_response_at = excluded.last_response_at,
         next_query_at = excluded.next_query_at,
         wait_reason = excluded.wait_reason,
         updated_at = excluded.updated_at`,
    )
    .run(
      input.companyId,
      input.ambiente,
      input.ultNsu,
      input.maxNsu,
      input.cStat,
      input.xMotivo || null,
      input.respostaEm,
      input.proximaConsultaEm,
      input.motivo,
      new Date().toISOString(),
    );
}

/** A recusa da SEFAZ fica registrada, sem andar o cursor nem mexer na espera. */
function registrarRecusaDaSefaz(companyId: string, ambiente: FiscalEnvironment, cStat: string, xMotivo: string): void {
  const agora = new Date().toISOString();
  getConnection()
    .prepare(
      `INSERT INTO core_dfe_cursors
         (company_id, environment, ult_nsu, max_nsu, last_c_stat, last_x_motivo,
          last_response_at, next_query_at, wait_reason, updated_at)
       VALUES (?, ?, 0, NULL, ?, ?, ?, NULL, NULL, ?)
       ON CONFLICT (company_id, environment) DO UPDATE SET
         last_c_stat = excluded.last_c_stat,
         last_x_motivo = excluded.last_x_motivo,
         last_response_at = excluded.last_response_at,
         updated_at = excluded.updated_at`,
    )
    .run(companyId, ambiente, cStat, xMotivo || null, agora, agora);
}

/** O clique cedo demais: a hora em que pode, e nada enviado. */
function recusarAntesDaHora(c: LinhaDoCursor, quando: string, ambiente: FiscalEnvironment): never {
  const hora = horaDaLoja(quando);
  const bloqueio = c.wait_reason === 'consumo_indevido';
  throw new ApiError(
    'CORE_DFE_AGUARDE_A_SEFAZ',
    bloqueio
      ? `A SEFAZ bloqueou as consultas deste CNPJ por consumo indevido (cStat 656) na ${NOME_DO_AMBIENTE[ambiente]}. `
        + `A próxima consulta só pode sair a partir das ${hora} — consultar durante o bloqueio o renova, `
        + 'por isso nada foi enviado.'
      : `A SEFAZ já entregou tudo o que havia na ${NOME_DO_AMBIENTE[ambiente]} (até o NSU ${Number(c.ult_nsu)}). `
        + `Pela regra do Ambiente Nacional, a próxima consulta só pode sair a partir das ${hora}: consultar `
        + 'antes é consumo indevido e bloqueia o CNPJ por uma hora (cStat 656). Nada foi enviado.',
    409,
    {
      proximaConsultaEm: quando,
      motivoDaEspera: c.wait_reason ?? 'em_dia',
      ultimoNsu: Number(c.ult_nsu),
      maxNsu: c.max_nsu === null ? null : Number(c.max_nsu),
      ambiente,
    },
  );
}

/**
 * As consultas da Distribuição em andamento, por (empresa, ambiente). A API é
 * um processo só (a instância única do GAP da manutenção), então um conjunto em
 * memória basta — e ele se esvazia sozinho quando o processo reinicia.
 */
const CONSULTAS_EM_ANDAMENTO = new Set<string>();

/**
 * Consulta os documentos destinados no AMBIENTE ATUAL, a partir do ultNSU que
 * a SEFAZ devolveu por último, até alcançar o maxNSU (com teto por clique).
 * Reconsultar é seguro: o que já veio é ignorado pelo UNIQUE (company_id,
 * environment, nsu).
 */
export async function consultarDistribuicao(input: {
  companyId: string;
  userId: string;
  adapter: AdapterOuFabrica;
}): Promise<ResultadoDaConsulta> {
  ensureCoreSchema();
  const cnpj = cnpjDaEmpresa(input.companyId);
  const ambiente = ambienteDaDistribuicao(input.companyId);

  // A ESPERA vem antes do certificado (a mesma ordem dos atos): o clique cedo
  // demais responde a hora em que pode, e não "digite a senha" (R3-DFE).
  const guardado = lerCursor(input.companyId, ambiente);
  const espera = esperaQueVale(guardado);
  if (guardado && espera) recusarAntesDaHora(guardado, espera, ambiente);

  /*
    UMA CONSULTA POR VEZ, por (empresa, ambiente) — verificação do R3-DFE.

    Dois cliques juntos (dois gerentes, duas abas) liam o MESMO cursor e
    mandavam à SEFAZ o MESMO ultNSU, lote a lote: a consulta repetida que o
    Ambiente Nacional chama de consumo indevido (NT 2014.002), e o 656 bloqueia
    o CNPJ por uma hora. A trava é tomada antes do primeiro `await` — no mesmo
    tique em que o cursor foi lido —, e o `finally` a solta em qualquer saída.
  */
  const trava = `${input.companyId}|${ambiente}`;
  if (CONSULTAS_EM_ANDAMENTO.has(trava)) {
    throw new ApiError(
      'CORE_DFE_CONSULTA_EM_ANDAMENTO',
      `Já há uma consulta à SEFAZ em andamento para esta empresa na ${NOME_DO_AMBIENTE[ambiente]}. `
        + 'Pedir o mesmo NSU duas vezes é consumo indevido e bloqueia o CNPJ por uma hora (cStat 656), '
        + 'por isso nada foi enviado: aguarde a outra terminar e atualize a lista.',
      409,
      { ambiente },
    );
  }
  CONSULTAS_EM_ANDAMENTO.add(trava);
  try {
    return await consultarLotes(input, cnpj, ambiente, guardado);
  } finally {
    CONSULTAS_EM_ANDAMENTO.delete(trava);
  }
}

/** Os lotes de um clique — só com a trava da consulta na mão. */
async function consultarLotes(
  input: { companyId: string; userId: string; adapter: AdapterOuFabrica },
  cnpj: string,
  ambiente: FiscalEnvironment,
  guardado: LinhaDoCursor | undefined,
): Promise<ResultadoDaConsulta> {
  const adapter = resolverAdapter(input.adapter);
  exigirAdapterDeVerdade(adapter, input.companyId);
  const capaz = exigirDfe(adapter);

  const db = getConnection();
  // O cursor é o do AMBIENTE: a produção não parte do maior NSU da homologação
  // (DFE-AMBIENTE). E, com o adapter REAL, o ensaio do simulador não conta: a
  // SEFAZ de verdade parte do que ELA entregou (GAP-PRD-168).
  const real = adapter.isReal;
  const gravado = db
    .prepare(
      'SELECT COALESCE(MAX(CAST(nsu AS INTEGER)), 0) AS ultimo FROM core_dfe_documents WHERE company_id = ? AND environment = ?'
        + (real ? ` AND (access_key IS NULL OR access_key NOT IN (${MARCAS_DO_ENSAIO}))` : ''),
    )
    .get(input.companyId, ambiente, ...(real ? CHAVES_DFE_DO_SIMULADOR : [])) as { ultimo: number };
  // O ponto de partida: o ultNSU que a SEFAZ devolveu, nunca menos que o gravado.
  let pedido = Math.max(Number(gravado.ultimo) || 0, real ? Number(guardado?.ult_nsu ?? 0) : 0);
  const uf = getFiscalConfig(input.companyId).uf ?? undefined;

  let novos = 0;
  let total = 0;
  let lotes = 0;
  let ensaioDescartado = 0;
  let ultNsu = pedido;
  let maxNsu: number | null = null;
  let cStat = '';
  let proximaConsultaEm: string | null = null;

  const auditar = (extra: Record<string, unknown> = {}): void => {
    recordAudit({
      companyId: input.companyId,
      userId: input.userId,
      action: 'dfe.consulta',
      entityType: 'dfe',
      entityId: cnpj,
      detail: {
        novos,
        total,
        ultimoNsu: ultNsu,
        maxNsu,
        cStat,
        lotes,
        ambiente,
        ...(ensaioDescartado > 0 ? { ensaioDoSimuladorDescartado: ensaioDescartado } : {}),
        ...extra,
      },
    });
  };

  while (lotes < LOTES_POR_CONSULTA) {
    // O AMBIENTE viaja junto (rodada 46): o adapter real fala com hom1 ou www1.
    const lote = await capaz.distributionDFe({ cnpj, lastNsu: pedido, environment: ambiente, uf });
    lotes += 1;
    const respostaEm = new Date();
    cStat = String(lote.cStat ?? '');
    const xMotivo = String(lote.xMotivo ?? '');

    if (cStat === '656') {
      const ate = new Date(respostaEm.getTime() + ESPERA_DA_SEFAZ_MS).toISOString();
      if (real) {
        gravarCursor({
          companyId: input.companyId,
          ambiente,
          ultNsu: Number.isFinite(lote.ultNsu) ? Number(lote.ultNsu) : pedido,
          maxNsu: null,
          cStat,
          xMotivo,
          respostaEm: respostaEm.toISOString(),
          proximaConsultaEm: ate,
          motivo: 'consumo_indevido',
        });
      }
      auditar({ bloqueioAte: ate });
      throw new ApiError(
        'CORE_DFE_CONSUMO_INDEVIDO',
        `A SEFAZ bloqueou as consultas deste CNPJ por consumo indevido (cStat 656${xMotivo ? `: ${xMotivo}` : ''}). `
          + `O bloqueio ficou registrado: a próxima consulta só sai a partir das ${horaDaLoja(ate)}.`,
        409,
        { proximaConsultaEm: ate, motivoDaEspera: 'consumo_indevido', cStat, ambiente },
      );
    }
    if (cStat !== '137' && cStat !== '138') {
      if (real) registrarRecusaDaSefaz(input.companyId, ambiente, cStat, xMotivo);
      auditar({ recusada: true, xMotivo });
      throw new ApiError(
        'CORE_DFE_SEFAZ_RECUSOU',
        `A SEFAZ recusou a consulta da Distribuição DF-e (cStat ${cStat || 'ausente'}${xMotivo ? `: ${xMotivo}` : ''}). `
          + `Nenhum documento desta resposta foi gravado, e o ponto de partida continua no NSU ${pedido}.`,
        409,
        { cStat, xMotivo, ambiente, ultimoNsu: pedido },
      );
    }

    // Nunca recua: nem abaixo do que se pediu, nem do que chegou no lote.
    const maiorDoLote = lote.docs.reduce((m, d) => Math.max(m, Number(d.nsu) || 0), 0);
    ultNsu = Math.max(pedido, Number.isFinite(lote.ultNsu) ? Number(lote.ultNsu) : 0, maiorDoLote);
    maxNsu = typeof lote.maxNsu === 'number' && Number.isFinite(lote.maxNsu) ? lote.maxNsu : null;
    const emDia = cStat === '137' || (maxNsu !== null && ultNsu >= maxNsu);
    proximaConsultaEm = real && emDia ? new Date(respostaEm.getTime() + ESPERA_DA_SEFAZ_MS).toISOString() : null;
    const primeiroLote = lotes === 1;
    const docs = lote.docs;
    const cursorDoLote = {
      companyId: input.companyId,
      ambiente,
      ultNsu,
      maxNsu,
      cStat,
      xMotivo,
      respostaEm: respostaEm.toISOString(),
      proximaConsultaEm,
      motivo: proximaConsultaEm ? ('em_dia' as const) : null,
    };
    // Os documentos e o cursor na MESMA transação: se o lote se desfaz, o ponto
    // de partida também fica onde estava.
    const doLote = withTransaction(() => {
      const descartados = real && primeiroLote ? descartarEnsaioDoSimulador(input.companyId) : 0;
      const gravados = gravarDocumentosDoLote(input.companyId, ambiente, docs);
      if (real) gravarCursor(cursorDoLote);
      return { descartados, gravados };
    });
    ensaioDescartado += doLote.descartados;
    novos += doLote.gravados;
    total += docs.length;

    // Em dia, sem maxNSU a perseguir, ou a SEFAZ não andou: este clique acabou.
    if (emDia || maxNsu === null || ultNsu <= pedido) break;
    pedido = ultNsu;
  }

  const restamDocumentos = maxNsu !== null && ultNsu < maxNsu;
  auditar(restamDocumentos ? { restamDocumentos } : {});
  return { novos, total, ultimoNsu: ultNsu, maxNsu, ambiente, lotes, restamDocumentos, proximaConsultaEm };
}

/**
 * A SEFAZ de verdade respondeu: o ensaio do simulador sai da lista e devolve
 * os NSU que ocupava — senão o UNIQUE engoliria as notas reais de homologação.
 */
function descartarEnsaioDoSimulador(companyId: string): number {
  return Number(
    getConnection()
      .prepare(`DELETE FROM core_dfe_documents WHERE company_id = ? AND access_key IN (${MARCAS_DO_ENSAIO})`)
      .run(companyId, ...CHAVES_DFE_DO_SIMULADOR).changes,
  );
}

/** Os documentos de um lote, VERBATIM; devolve quantos eram novos. */
function gravarDocumentosDoLote(
  companyId: string,
  ambiente: FiscalEnvironment,
  docs: { nsu: string; schema: string; xml: string }[],
): number {
  const db = getConnection();
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO core_dfe_documents
       (id, company_id, environment, nsu, schema_type, access_key, supplier_cnpj, supplier_name,
        total_cents, issued_at, xml, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const jaTem = db.prepare(
    'SELECT 1 FROM core_dfe_documents WHERE company_id = ? AND environment = ? AND nsu = ? LIMIT 1',
  );
  let gravados = 0;
  for (const doc of docs) {
    const info = stmt.run(
      randomUUID(),
      companyId,
      ambiente,
      doc.nsu,
      doc.schema,
      campo(doc.xml, 'chNFe'),
      campo(doc.xml, 'CNPJ'),
      campo(doc.xml, 'xNome'),
      centsDe(campo(doc.xml, 'vNF')),
      campo(doc.xml, 'dhEmi'),
      // VERBATIM, como o xml_original da nota: a assinatura cobre os bytes.
      doc.xml,
      new Date().toISOString(),
    );
    /*
      Ignorado sem estar no ambiente = engolido por uma unicidade que não é a
      desta build (a tabela ainda na UNIQUE (company_id, nsu) porque a
      reconstrução foi adiada). Perder nota calado é o defeito inteiro: a
      consulta desfaz o lote e diz o que fazer, e o cursor não anda.
    */
    if (Number(info.changes) === 0 && !jaTem.get(companyId, ambiente, doc.nsu)) {
      throw new ApiError(
        'CORE_DFE_ESQUEMA_PENDENTE',
        'A tabela da Distribuição DF-e ainda não separa homologação de produção, e a nota de NSU '
          + `${doc.nsu} seria perdida. Nada foi gravado deste lote. Com a API parada, rode `
          + 'npm run db:conferir-esquema -- --reparar (Configurações › Sistema mostra a pendência) e consulte de novo.',
        409,
        { nsu: doc.nsu, ambiente },
      );
    }
    gravados += Number(info.changes);
  }
  return gravados;
}

/**
 * Os documentos do AMBIENTE ATUAL. Os do outro não se misturam, nem marcados:
 * na produção, a homologação não tem ação possível (a manifestação e a
 * importação a recusam), e os NSU dos dois ambientes se repetem — a mesma
 * linha "NSU 1" apareceria duas vezes. Quantos ficaram fora, a tela diz
 * (`documentosDeOutroAmbiente`).
 */
export function listarDfe(companyId: string): DfeDocumento[] {
  ensureCoreSchema();
  const rows = getConnection()
    .prepare(
      `SELECT d.*, n.id AS note_id, n.status AS note_status
         FROM core_dfe_documents d
         LEFT JOIN core_inbound_notes n
           ON n.company_id = d.company_id AND n.access_key = d.access_key
        WHERE d.company_id = ? AND d.environment = ?
        ORDER BY CAST(d.nsu AS INTEGER) DESC`,
    )
    .all(companyId, ambienteDaDistribuicao(companyId)) as unknown as Record<string, unknown>[];
  return rows.map((r) => ({
    nsu: String(r.nsu),
    ambiente: r.environment === 'production' ? 'production' : 'homologation',
    schemaType: String(r.schema_type),
    accessKey: (r.access_key as string) ?? null,
    supplierCnpj: (r.supplier_cnpj as string) ?? null,
    supplierName: (r.supplier_name as string) ?? null,
    totalCents: r.total_cents === null || r.total_cents === undefined ? null : Number(r.total_cents),
    issuedAt: (r.issued_at as string) ?? null,
    manifestStatus: (r.manifest_status as string) ?? null,
    manifestProtocol: (r.manifest_protocol as string) ?? null,
    manifestedAt: (r.manifested_at as string) ?? null,
    // O funil manda: se a chave já virou nota (por QUALQUER canal), é ela.
    importedNoteId: (r.note_id as string) ?? (r.imported_note_id as string) ?? null,
    noteStatus: (r.note_status as string) ?? null,
    temXmlCompleto: r.schema_type === 'procNFe' && r.xml !== null && r.xml !== undefined,
    receivedAt: String(r.received_at),
  }));
}

/** Quantos documentos do OUTRO ambiente ficaram fora da lista — a tela o diz. */
export function documentosDeOutroAmbiente(companyId: string): { ambiente: FiscalEnvironment; total: number } {
  ensureCoreSchema();
  const ambiente = outroAmbiente(ambienteDaDistribuicao(companyId));
  const r = getConnection()
    .prepare('SELECT COUNT(*) AS n FROM core_dfe_documents WHERE company_id = ? AND environment = ?')
    .get(companyId, ambiente) as { n: number };
  return { ambiente, total: Number(r.n) };
}

/**
 * O documento da chave, preferindo o do ambiente atual (uma chave de acesso
 * não carrega o ambiente, e a mesma poderia ter vindo pelos dois).
 */
function documentoDaChave<T>(companyId: string, accessKey: string, colunas: string, ambiente: FiscalEnvironment): T | undefined {
  return getConnection()
    .prepare(
      `SELECT ${colunas}, environment FROM core_dfe_documents
        WHERE company_id = ? AND access_key = ?
        ORDER BY (environment = ?) DESC LIMIT 1`,
    )
    .get(companyId, accessKey, ambiente) as T | undefined;
}

/** Estados que não voltam atrás pelo botão. */
const DEFINITIVAS = new Set<string>(['confirmacao', 'desconhecimento', 'nao_realizada']);

export async function manifestarDfe(input: {
  companyId: string;
  userId: string;
  accessKey: string;
  tipo: TipoManifestacao;
  justification?: string;
  adapter: AdapterOuFabrica;
}): Promise<{ accessKey: string; manifestStatus: string; protocol: string | null }> {
  ensureCoreSchema();
  /*
    A REVISÃO MORDEU AQUI: `TIPOS_MANIFESTACAO[input.tipo]` aceitava 'toString'
    e afins — objeto literal herda de Object.prototype, e a função herdada é
    truthy. O tipo vindo da rede só vale se for chave PRÓPRIA do mapa.
  */
  if (!Object.prototype.hasOwnProperty.call(TIPOS_MANIFESTACAO, input.tipo)) {
    throw new ApiError('CORE_DFE_INVALID_TYPE', 'Tipo de manifestação desconhecido.', 400);
  }
  const codigo = TIPOS_MANIFESTACAO[input.tipo];
  // A SEFAZ exige justificativa de 15 a 255 caracteres para operação não
  // realizada — sem ela o evento seria rejeitado lá; recusar aqui é honesto.
  const justificativa = (input.justification ?? '').trim();
  if (input.tipo === 'nao_realizada' && justificativa.length < 15) {
    throw new ApiError(
      'CORE_DFE_JUSTIFICATION_REQUIRED',
      'Operação não realizada exige justificativa com pelo menos 15 caracteres.',
      400,
    );
  }

  const db = getConnection();
  const ambiente = ambienteDaDistribuicao(input.companyId);
  const doc = documentoDaChave<{
    id: string;
    manifest_status: string | null;
    manifest_protocol: string | null;
    environment: FiscalEnvironment;
  }>(input.companyId, input.accessKey, 'id, manifest_status, manifest_protocol', ambiente);
  if (!doc) {
    throw new ApiError(
      'CORE_DFE_DOC_NOT_FOUND',
      'Documento não encontrado — não se manifesta o que a SEFAZ não entregou.',
      404,
    );
  }
  // Documento de outro ambiente: nem o clique repetido finge sucesso, e o
  // certificado nem é aberto (DFE-AMBIENTE).
  if (doc.environment !== ambiente) recusarOutroAmbiente(doc.environment, ambiente, 'manifestar');

  // Clique repetido não é erro nem evento novo.
  if (doc.manifest_status === input.tipo) {
    return { accessKey: input.accessKey, manifestStatus: input.tipo, protocol: doc.manifest_protocol };
  }
  if (doc.manifest_status && DEFINITIVAS.has(doc.manifest_status)) {
    throw new ApiError(
      'CORE_DFE_ALREADY_MANIFESTED',
      `A nota já foi manifestada como "${doc.manifest_status}" — essa decisão é definitiva perante a SEFAZ.`,
      409,
    );
  }

  // O certificado só é aberto (ou pedido) agora, depois de tudo o que o
  // domínio recusa sozinho. E o ato com efeito jurídico nunca sai pelo
  // simulador em produção (GAP-PRD-168).
  const adapter = resolverAdapter(input.adapter);
  exigirAdapterDeVerdade(adapter, input.companyId);
  // Evento de verdade não sai para chave que o simulador inventou (GAP-PRD-168).
  if (adapter.isReal && ehEnsaioDoSimulador(input.accessKey)) recusarEnsaioDoSimulador();
  const capaz = adapter as DfeCapableAdapter;
  if (!capaz.manifest) {
    throw new ApiError(
      'CORE_SEFAZ_MANIFEST_NOT_SUPPORTED',
      'Este ambiente ainda não transmite manifestação real — o cliente SOAP é a próxima etapa do fiscal.',
      501,
    );
  }

  // O PEDIDO fica registrado antes da chamada — se a SEFAZ cair no meio, o
  // rastro mostra que tentamos, e o quê.
  gravarEventoDfe({
    companyId: input.companyId,
    accessKey: input.accessKey,
    eventType: `dfe_manifest_${input.tipo}_requested`,
    justification: justificativa || null,
    userId: input.userId,
  });

  const resposta = await capaz.manifest({
    accessKey: input.accessKey,
    eventType: codigo,
    justification: justificativa || undefined,
    environment: ambiente,
  });

  const aceito = Boolean(resposta.protocol) && ['135', '136'].includes(resposta.cStat ?? '');
  if (!aceito) {
    gravarEventoDfe({
      companyId: input.companyId,
      accessKey: input.accessKey,
      eventType: `dfe_manifest_${input.tipo}_rejected`,
      cStat: resposta.cStat ?? null,
      xMotivo: resposta.xMotivo ?? null,
      userId: input.userId,
    });
    throw new ApiError(
      'CORE_DFE_MANIFEST_REJECTED',
      resposta.xMotivo ?? 'A SEFAZ rejeitou a manifestação.',
      409,
    );
  }

  const agora = new Date().toISOString();
  db.prepare(
    `UPDATE core_dfe_documents
        SET manifest_status = ?, manifest_protocol = ?, manifested_at = ?
      WHERE id = ?`,
  ).run(input.tipo, resposta.protocol, agora, doc.id);

  gravarEventoDfe({
    companyId: input.companyId,
    accessKey: input.accessKey,
    eventType: `dfe_manifest_${input.tipo}_authorized`,
    protocol: resposta.protocol ?? null,
    cStat: resposta.cStat ?? null,
    xMotivo: resposta.xMotivo ?? null,
    userId: input.userId,
  });

  recordAudit({
    companyId: input.companyId,
    userId: input.userId,
    action: 'dfe.manifest',
    entityType: 'dfe',
    entityId: input.accessKey,
    detail: { tipo: input.tipo, protocol: resposta.protocol, cStat: resposta.cStat },
  });

  /*
    Ciência (e confirmação) liberam o download da nota completa na SEFAZ.
    Baixar aqui é MELHOR ESFORÇO: se falhar, o resumo fica e o botão de
    importar continua explicando o caminho — a manifestação aceita não se
    desfaz por causa do download.
  */
  if (input.tipo === 'ciencia' || input.tipo === 'confirmacao') {
    try {
      // Chamado NO adapter — desamarrar o método da instância perde o this.
      // Com o CNPJ bloqueado pelo 656, nem pede: pedir durante o bloqueio o
      // renova. O resumo fica, e o importar explica o caminho (R3-DFE).
      const cursor = lerCursor(input.companyId, ambiente);
      const bloqueado = cursor?.wait_reason === 'consumo_indevido' && esperaQueVale(cursor) !== null;
      if (capaz.distributionDFe && !bloqueado) {
        const cnpj = cnpjDaEmpresa(input.companyId);
        const lote = await capaz.distributionDFe({
          cnpj,
          lastNsu: 0,
          accessKey: input.accessKey,
          environment: ambiente,
          uf: getFiscalConfig(input.companyId).uf ?? undefined,
        });
        // O download também pode tomar o 656: o bloqueio fica gravado para a busca respeitar.
        if (lote.cStat === '656' && adapter.isReal) {
          const agora = new Date();
          gravarCursor({
            companyId: input.companyId,
            ambiente,
            ultNsu: 0,
            maxNsu: null,
            cStat: '656',
            xMotivo: String(lote.xMotivo ?? ''),
            respostaEm: agora.toISOString(),
            proximaConsultaEm: new Date(agora.getTime() + ESPERA_DA_SEFAZ_MS).toISOString(),
            motivo: 'consumo_indevido',
          });
        }
        const completo = lote.docs.find((d) => d.schema === 'procNFe');
        if (completo) {
          db.prepare(
            "UPDATE core_dfe_documents SET schema_type = 'procNFe', xml = ? WHERE id = ?",
          ).run(completo.xml, doc.id);
        }
      }
    } catch {
      // Fica o resumo; o próximo "importar" explica o que falta.
    }
  }

  return { accessKey: input.accessKey, manifestStatus: input.tipo, protocol: resposta.protocol ?? null };
}

/**
 * Leva a nota completa para o funil de conferência — o MESMO funil do upload
 * e do e-mail, com a mesma idempotência por chave.
 */
export function importarDfe(input: {
  companyId: string;
  userId: string;
  accessKey: string;
}): ImportResult {
  ensureCoreSchema();
  const db = getConnection();
  const ambiente = ambienteDaDistribuicao(input.companyId);
  const doc = documentoDaChave<{ id: string; schema_type: string; xml: string | null; environment: FiscalEnvironment }>(
    input.companyId,
    input.accessKey,
    'id, schema_type, xml',
    ambiente,
  );
  if (!doc) {
    throw new ApiError('CORE_DFE_DOC_NOT_FOUND', 'Documento não encontrado.', 404);
  }
  // Em produção, nota inventada pelo simulador não entra no funil (GAP-PRD-168).
  if (ehEnsaioDoSimulador(input.accessKey) && emProducao(input.companyId)) recusarEnsaioDoSimulador();
  // Nem a nota de outro ambiente: a numeração e o valor fiscal são outros (DFE-AMBIENTE).
  if (doc.environment !== ambiente) recusarOutroAmbiente(doc.environment, ambiente, 'importar');
  if (doc.schema_type !== 'procNFe' || !doc.xml) {
    throw new ApiError(
      'CORE_DFE_XML_INCOMPLETO',
      'A SEFAZ só entregou o resumo desta nota. Manifeste a ciência da operação — é ela que libera a nota completa para importar.',
      409,
    );
  }

  const resultado = importNfe({ companyId: input.companyId, userId: input.userId, xml: doc.xml });
  db.prepare('UPDATE core_dfe_documents SET imported_note_id = ? WHERE id = ?').run(
    resultado.noteId,
    doc.id,
  );
  return resultado;
}
