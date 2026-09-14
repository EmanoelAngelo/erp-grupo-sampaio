/**
 * Estado do sistema (GAP-PRD-064 e GAP-PRD-057) — o cliente das rotas que a
 * tela Configurações › Sistema consome:
 *
 *   GET /system/release              versão, esquema do NÚCLEO e o processo no ar
 *   GET /system/readiness            prontidão do núcleo e chaves de produção
 *   GET /core/system/secrets-readiness  o estado de cada segredo, nunca o valor
 */
import { apiRequest, exigirCampos } from './client';

export type SituacaoDoEsquema = 'EM_DIA' | 'ATRASADO' | 'ADIANTADO' | 'NUNCA_MIGRADO' | 'SEM_BANCO';

export interface EsquemaDoBanco {
  situacao: SituacaoDoEsquema;
  nucleo: { versao: number | null; alvo: number; passosPendentes: number[] };
  documentos: { versao: number | null; alvo: number };
}

/**
 * O dono do banco (GAP-PRD-137): uma instância por arquivo. `null` quando
 * ninguém assumiu — o processo subiu por fora do boot oficial.
 */
export interface InstanciaDoBanco {
  tipo: string;
  pid: number;
  host: string;
  iniciadoEm: string;
  batidaEm: string;
  /** O dono é este processo que respondeu. */
  estaInstancia: boolean;
}

export interface VersaoDoSistema {
  appVersion: string;
  release: string;
  environment: string;
  databaseVersion: number | null;
  databaseTargetVersion: number;
  databaseSituation: SituacaoDoEsquema;
  documentsVersion: number | null;
  processo: { node: string; plataforma: string; noArDesde: string; supervisionado: boolean };
  instancia?: InstanciaDoBanco | null;
  /** O corte do dia no SQL ainda bate com o fuso oficial? (GAP-PRD-145) */
  calendario?: CalendarioDaLoja;
}

export type EstadoDoFuso = 'FIXO_VALE' | 'VAI_DIVERGIR' | 'DIVERGE_AGORA';

/**
 * O SQL corta o dia da loja com um deslocamento fixo; o JavaScript, pelo fuso
 * oficial. A API confere, ao subir e a cada leitura, se os dois concordam
 * agora e pelos próximos ~13 meses.
 */
export interface CalendarioDaLoja {
  estado: EstadoDoFuso;
  fuso: string;
  deslocamentoSqlHoras: number;
  conferidoEm: string;
  conferidoAte: string;
  primeiraDivergencia: string | null;
  comoResolver: string | null;
}

/** O banco contra um banco novo desta build (GAP-PRD-140). */
export type SituacaoDaDeriva = 'IDENTICO' | 'DIVERGE' | 'NAO_SE_APLICA' | 'NAO_CONFERIDO';

export interface DivergenciaDoEsquema {
  tipo: string;
  tabela: string;
  objeto: string;
  descricao: string;
  reparo: string;
}

export interface DerivaDoEsquema {
  situacao: SituacaoDaDeriva;
  motivo: string | null;
  totalDeDivergencias: number;
  divergencias: DivergenciaDoEsquema[];
  objetosAMais: number;
  tabelasConferidas: number;
  indicesConferidos: number;
  conferidoEm: string;
  ultimoReparo: {
    em: string;
    modo: string;
    reparados: string[];
    pendentes: { objeto: string; motivo: string }[];
  } | null;
  comoResolver: string | null;
}

export interface ProntidaoDoNucleo {
  coreStatus: 'READY' | 'NOT_READY';
  overallStatus: string;
  criticalBlockers: string[];
  externalBlockers: string[];
  schema: EsquemaDoBanco;
  environment: string;
  /** Opcional: um servidor anterior ao GAP-PRD-140 não manda. */
  schemaDrift?: DerivaDoEsquema;
}

export type EstadoDaChave = 'PRODUCTION_SAFE' | 'DEVELOPMENT_DEFAULT' | 'MISSING';
export type EstadoDoSegredo = 'SEALED_CURRENT_KEY' | 'LEGACY_KEY' | 'ABSENT';
export interface EstadoDeCredencial {
  selo: EstadoDoSegredo;
  trocaNoProvedor: 'REQUIRED' | 'NOT_REQUIRED';
}

export interface ProntidaoDosSegredos {
  encryptionKey: EstadoDaChave;
  jwtSecret: EstadoDaChave;
  a1Pfx: EstadoDoSegredo;
  a1Password: EstadoDoSegredo;
  asaasSandbox: EstadoDeCredencial;
  asaasProduction: EstadoDeCredencial;
  asaasWebhook: EstadoDeCredencial;
  email: EstadoDeCredencial;
  legadoPendente: number;
  cofreRotacionadoEm: string | null;
  checkedAt: string;
}

export async function versaoDoSistema(): Promise<VersaoDoSistema> {
  const corpo = await apiRequest<VersaoDoSistema>('/system/release');
  return exigirCampos(corpo, 'appVersion', 'databaseTargetVersion', 'processo');
}

export async function prontidaoDoNucleo(): Promise<ProntidaoDoNucleo> {
  const corpo = await apiRequest<ProntidaoDoNucleo>('/system/readiness');
  return exigirCampos(corpo, 'coreStatus', 'schema', 'criticalBlockers', 'externalBlockers');
}

export async function prontidaoDosSegredos(): Promise<ProntidaoDosSegredos> {
  const corpo = await apiRequest<ProntidaoDosSegredos>('/core/system/secrets-readiness');
  return exigirCampos(corpo, 'encryptionKey', 'jwtSecret', 'a1Pfx', 'a1Password');
}
