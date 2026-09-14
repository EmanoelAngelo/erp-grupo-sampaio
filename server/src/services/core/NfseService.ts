/**
 * A NFS-e DA MÃO DE OBRA — GAP-PRD-024.
 *
 * A venda da OS separa a peça (nota de mercadoria, `FiscalVendaDaOficina`) da
 * mão de obra. Este serviço é o caminho da mão de obra: configuração por
 * empresa, prontidão com o dono de cada pendência, emissão pela Sefin Nacional
 * (DPS assinada com o A1 do cofre) e o registro da NFS-e emitida no portal.
 *
 * ## A decisão do dono, com padrão seguro
 *
 * `core_nfse_configs.mode`:
 *   - DESLIGADA (padrão) — o sistema não emite; a OS e a tela fiscal dizem o
 *     que falta. Nada sai por engano.
 *   - EMISSOR_NACIONAL — a DPS vai à Sefin Nacional pelo adapter real.
 *   - REGISTRO_MANUAL — a NFS-e é emitida no portal (Emissor Nacional ou o da
 *     prefeitura) e o número é registrado aqui, ligado à venda.
 *
 * ## Ambiente
 *
 * Próprio da NFS-e, e começa em homologação (a "produção restrita" do Sistema
 * Nacional). Produção só depois de uma NFS-e AUTORIZADA pela Sefin na
 * homologação, desta empresa — a mesma régua que a NF-e usa para destravar
 * produção. Nota do simulador não conta.
 *
 * ## Número da DPS
 *
 * Reservado na primeira tentativa e guardado no documento; reenvio (recusa,
 * queda de rede) usa o MESMO número. Uma venda, uma DPS, uma NFS-e.
 */
import { randomUUID } from 'node:crypto';
import { getConnection, withTransaction } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { ApiError } from '../../utils/errors.js';
import { recordAudit } from '../audit/AuditService.js';
import { getFiscalConfig } from './FiscalConfigService.js';
import { digits, loadSaleForNfce } from './FiscalXmlNfce.js';
import { municipioDoEmitenteQueNaoConfere } from './MunicipiosIbge.js';
import { certificadoDoCofre } from './FiscalPipelineService.js';
import { signXmlElement } from './FiscalSigner.js';
import { osDaVenda } from './VendaDaOficina.js';
import { montarDps, validarDadosDaDps, type DadosDaDps, type TributacaoDoServico } from './NfseDps.js';
import {
  NfseNacionalAdapter,
  NfseTesteAdapter,
  assertAdapterDaNfsePodeTransmitir,
  type AmbienteDaNfse,
  type NfseAdapter,
} from './NfseAdapter.js';
import { TransportFailure } from './SefazTestAdapter.js';
import { servidorEmProducao } from './SefazAdapter.js';
import type { ServicoDaVenda } from './FiscalVendaDaOficina.js';

export type ModoDaNfse = 'DESLIGADA' | 'EMISSOR_NACIONAL' | 'REGISTRO_MANUAL';
export const MODOS_DA_NFSE: ModoDaNfse[] = ['DESLIGADA', 'EMISSOR_NACIONAL', 'REGISTRO_MANUAL'];

export type SituacaoDaNfse =
  | 'ENVIANDO'
  | 'AUTORIZADA'
  | 'REJEITADA'
  | 'SEM_RESPOSTA'
  | 'REGISTRADA'
  | 'CANCELADA';

export interface ConfiguracaoDaNfse extends TributacaoDoServico {
  companyId: string;
  mode: ModoDaNfse;
  environment: AmbienteDaNfse;
  serviceDescription: string | null;
  dpsSeries: string;
  nextDpsNumber: number;
  municipalityConfirmedAt: string | null;
  municipalityConfirmedBy: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface DocumentoDaNfse {
  id: string;
  saleId: string;
  serviceOrderId: string | null;
  origin: 'EMISSOR_NACIONAL' | 'REGISTRO_MANUAL';
  environment: AmbienteDaNfse;
  status: SituacaoDaNfse;
  serviceCents: number;
  description: string;
  takerDocument: string | null;
  takerName: string | null;
  dpsSeries: string | null;
  dpsNumber: number | null;
  dpsId: string | null;
  accessKey: string | null;
  nfseNumber: string | null;
  verificationCode: string | null;
  reason: string | null;
  issuedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  simulated: boolean;
  createdAt: string;
  updatedAt: string;
}

const agora = () => new Date().toISOString();

function limpo(v: unknown): string | null {
  const t = String(v ?? '').trim();
  return t ? t : null;
}

// ------------------------------------------------------------ configuração

export function getNfseConfig(companyId: string): ConfiguracaoDaNfse {
  ensureCoreSchema();
  const r = getConnection()
    .prepare('SELECT * FROM core_nfse_configs WHERE company_id = ?')
    .get(companyId) as Record<string, unknown> | undefined;
  return {
    companyId,
    mode: (r?.mode as ModoDaNfse) ?? 'DESLIGADA',
    environment: (r?.environment as AmbienteDaNfse) ?? 'homologation',
    serviceCode: (r?.service_code as string | null) ?? null,
    municipalServiceCode: (r?.municipal_service_code as string | null) ?? null,
    nbsCode: (r?.nbs_code as string | null) ?? null,
    serviceDescription: (r?.service_description as string | null) ?? null,
    issRate: (r?.iss_rate as string | null) ?? null,
    simplesOption: (r?.simples_option as string | null) ?? null,
    simplesRegime: (r?.simples_regime as string | null) ?? null,
    specialRegime: (r?.special_regime as string | null) ?? '0',
    issWithholding: (r?.iss_withholding as string | null) ?? '1',
    dpsSeries: (r?.dps_series as string | null) ?? '1',
    nextDpsNumber: Number(r?.next_dps_number ?? 1),
    municipalityConfirmedAt: (r?.municipality_confirmed_at as string | null) ?? null,
    municipalityConfirmedBy: (r?.municipality_confirmed_by as string | null) ?? null,
    updatedAt: (r?.updated_at as string | null) ?? null,
    updatedBy: (r?.updated_by as string | null) ?? null,
  };
}

/** Houve NFS-e de verdade (não simulada) autorizada pela Sefin na homologação? */
function temAutorizacaoRealNaHomologacao(companyId: string): boolean {
  const r = getConnection()
    .prepare(
      `SELECT 1 FROM core_nfse_documents
        WHERE company_id = ? AND environment = 'homologation' AND status IN ('AUTORIZADA', 'CANCELADA')
          AND origin = 'EMISSOR_NACIONAL' AND COALESCE(access_key, '') NOT LIKE 'TESTE%'
        LIMIT 1`,
    )
    .get(companyId);
  return Boolean(r);
}

export interface PatchDaNfse {
  mode?: string;
  environment?: string;
  serviceCode?: string | null;
  municipalServiceCode?: string | null;
  nbsCode?: string | null;
  serviceDescription?: string | null;
  issRate?: string | null;
  simplesOption?: string | null;
  simplesRegime?: string | null;
  specialRegime?: string;
  issWithholding?: string;
  dpsSeries?: string;
  nextDpsNumber?: number;
  /** `true` registra quem confirmou que o município usa o Emissor Nacional; `false` limpa. */
  municipalityConfirmed?: boolean;
}

function recusa(mensagem: string): never {
  throw new ApiError('CORE_NFSE_CONFIG_INVALID', mensagem, 400);
}

export function updateNfseConfig(input: {
  companyId: string;
  userId: string;
  patch: PatchDaNfse;
}): ConfiguracaoDaNfse {
  ensureCoreSchema();
  const atual = getNfseConfig(input.companyId);
  const p = input.patch ?? {};
  const novo = { ...atual };

  if (p.mode !== undefined) {
    if (!MODOS_DA_NFSE.includes(p.mode as ModoDaNfse)) {
      recusa('Modo da NFS-e inválido: DESLIGADA, EMISSOR_NACIONAL ou REGISTRO_MANUAL.');
    }
    novo.mode = p.mode as ModoDaNfse;
  }
  if (p.environment !== undefined) {
    if (p.environment !== 'homologation' && p.environment !== 'production') {
      recusa('Ambiente da NFS-e inválido: homologation ou production.');
    }
    if (
      p.environment === 'production'
      && atual.environment !== 'production'
      && !temAutorizacaoRealNaHomologacao(input.companyId)
    ) {
      throw new ApiError(
        'CORE_NFSE_PRODUCTION_LOCKED',
        'A NFS-e só vai para produção depois de uma DPS autorizada pela Sefin Nacional na '
          + 'homologação (produção restrita), desta empresa. Emita uma de teste primeiro.',
        409,
      );
    }
    novo.environment = p.environment;
  }
  const opcional = (v: string | null | undefined, re: RegExp, nome: string): string | null => {
    const t = limpo(v);
    if (t && !re.test(t)) recusa(`${nome} fora do formato.`);
    return t;
  };
  if (p.serviceCode !== undefined) novo.serviceCode = opcional(p.serviceCode, /^\d{6}$/, 'Código de tributação nacional (6 dígitos)');
  if (p.municipalServiceCode !== undefined) {
    novo.municipalServiceCode = opcional(p.municipalServiceCode, /^\d{3}$/, 'Código de tributação municipal (3 dígitos)');
  }
  if (p.nbsCode !== undefined) novo.nbsCode = opcional(p.nbsCode, /^\d{9}$/, 'Código NBS (9 dígitos)');
  if (p.serviceDescription !== undefined) {
    const d = limpo(p.serviceDescription);
    if (d && d.length > 500) recusa('Descrição padrão do serviço com mais de 500 caracteres.');
    novo.serviceDescription = d;
  }
  if (p.issRate !== undefined) {
    const t = limpo(p.issRate)?.replace(',', '.') ?? null;
    if (t && !(/^\d{1,2}(\.\d{1,2})?$/.test(t) && Number(t) > 0 && Number(t) <= 5)) {
      recusa('Alíquota do ISS fora do formato (ex.: 2,00 — entre 0 e 5%).');
    }
    novo.issRate = t;
  }
  if (p.simplesOption !== undefined) novo.simplesOption = opcional(p.simplesOption, /^[123]$/, 'Situação no Simples (1, 2 ou 3)');
  if (p.simplesRegime !== undefined) novo.simplesRegime = opcional(p.simplesRegime, /^[123]$/, 'Regime de apuração do Simples (1, 2 ou 3)');
  if (p.specialRegime !== undefined) {
    if (!/^[0-6]$/.test(String(p.specialRegime))) recusa('Regime especial de tributação inválido (0 a 6).');
    novo.specialRegime = String(p.specialRegime);
  }
  if (p.issWithholding !== undefined) {
    if (!/^[123]$/.test(String(p.issWithholding))) recusa('Retenção do ISS inválida (1, 2 ou 3).');
    novo.issWithholding = String(p.issWithholding);
  }
  if (p.dpsSeries !== undefined) {
    if (!/^\d{1,5}$/.test(String(p.dpsSeries))) recusa('Série da DPS inválida (1 a 5 dígitos).');
    novo.dpsSeries = String(Number(p.dpsSeries));
  }
  if (p.nextDpsNumber !== undefined) {
    const n = Number(p.nextDpsNumber);
    if (!Number.isInteger(n) || n < 1) recusa('Próximo número da DPS inválido.');
    // A numeração só anda para frente: voltar reusaria um número que a Sefin já viu.
    if (n < atual.nextDpsNumber) {
      throw new ApiError(
        'CORE_NFSE_NUMBER_BACKWARDS',
        `A numeração da DPS só anda para frente (a próxima é ${atual.nextDpsNumber}).`,
        409,
      );
    }
    novo.nextDpsNumber = n;
  }
  let confirmadoEm = atual.municipalityConfirmedAt;
  let confirmadoPor = atual.municipalityConfirmedBy;
  if (p.municipalityConfirmed !== undefined) {
    confirmadoEm = p.municipalityConfirmed ? agora() : null;
    confirmadoPor = p.municipalityConfirmed ? input.userId : null;
  }

  const ts = agora();
  getConnection()
    .prepare(
      `INSERT INTO core_nfse_configs
         (company_id, mode, environment, service_code, municipal_service_code, nbs_code,
          service_description, iss_rate, simples_option, simples_regime, special_regime,
          iss_withholding, dps_series, next_dps_number, municipality_confirmed_at,
          municipality_confirmed_by, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(company_id) DO UPDATE SET
         mode = excluded.mode, environment = excluded.environment,
         service_code = excluded.service_code, municipal_service_code = excluded.municipal_service_code,
         nbs_code = excluded.nbs_code, service_description = excluded.service_description,
         iss_rate = excluded.iss_rate, simples_option = excluded.simples_option,
         simples_regime = excluded.simples_regime, special_regime = excluded.special_regime,
         iss_withholding = excluded.iss_withholding, dps_series = excluded.dps_series,
         next_dps_number = excluded.next_dps_number,
         municipality_confirmed_at = excluded.municipality_confirmed_at,
         municipality_confirmed_by = excluded.municipality_confirmed_by,
         updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    )
    .run(
      input.companyId,
      novo.mode,
      novo.environment,
      novo.serviceCode,
      novo.municipalServiceCode,
      novo.nbsCode,
      novo.serviceDescription,
      novo.issRate,
      novo.simplesOption,
      novo.simplesRegime,
      novo.specialRegime,
      novo.issWithholding,
      novo.dpsSeries,
      novo.nextDpsNumber,
      confirmadoEm,
      confirmadoPor,
      input.userId,
      ts,
    );

  recordAudit({
    companyId: input.companyId,
    userId: input.userId,
    action: 'fiscal.nfse.config_updated',
    entityType: 'nfse_config',
    entityId: input.companyId,
    detail: {
      antes: { mode: atual.mode, environment: atual.environment },
      depois: { mode: novo.mode, environment: novo.environment },
      campos: Object.keys(p),
    },
  });
  return getNfseConfig(input.companyId);
}

// ---------------------------------------------------------------- prontidão

export type DonoDaPendencia = 'dono' | 'gerente' | 'contador' | 'prefeitura';

export interface ItemDaProntidaoNfse {
  key: string;
  label: string;
  status: 'OK' | 'FAIL' | 'INFO';
  detail: string;
  owner: DonoDaPendencia;
}

export interface ProntidaoDaNfse {
  mode: ModoDaNfse;
  environment: AmbienteDaNfse;
  canEmit: boolean;
  items: ItemDaProntidaoNfse[];
}

/** Há A1 utilizável no cofre? A resposta não carrega nada do certificado. */
function situacaoDoA1(companyId: string): { ok: boolean; detalhe: string } {
  try {
    const cert = certificadoDoCofre(companyId);
    if (!cert) return { ok: false, detalhe: 'Nenhum certificado A1 no cofre desta empresa.' };
    return { ok: true, detalhe: 'Certificado A1 no cofre, com a senha selada.' };
  } catch (err) {
    return {
      ok: false,
      detalhe: err instanceof ApiError ? err.message : 'O certificado do cofre não pôde ser aberto.',
    };
  }
}

export function prontidaoDaNfse(companyId: string): ProntidaoDaNfse {
  ensureCoreSchema();
  const c = getNfseConfig(companyId);
  const f = getFiscalConfig(companyId);
  const itens: ItemDaProntidaoNfse[] = [];
  const item = (i: ItemDaProntidaoNfse) => itens.push(i);

  if (c.mode === 'DESLIGADA') {
    item({
      key: 'nfse_mode',
      label: 'Modo da NFS-e',
      status: 'FAIL',
      detail:
        'A NFS-e está desligada: a mão de obra da OS fica sem documento. Escolha "Emissor '
        + 'Nacional" (o sistema envia) ou "Registro manual" (emitida no portal e registrada aqui).',
      owner: 'dono',
    });
    return { mode: c.mode, environment: c.environment, canEmit: false, items: itens };
  }

  if (c.mode === 'REGISTRO_MANUAL') {
    item({
      key: 'nfse_mode',
      label: 'Modo da NFS-e',
      status: 'OK',
      detail:
        'Registro manual: a NFS-e é emitida no portal (Emissor Nacional ou prefeitura) e o número '
        + 'é registrado na venda da OS.',
      owner: 'dono',
    });
    return { mode: c.mode, environment: c.environment, canEmit: false, items: itens };
  }

  item({
    key: 'nfse_mode',
    label: 'Modo da NFS-e',
    status: 'OK',
    detail: 'Emissor Nacional: a DPS é assinada com o A1 e enviada à Sefin Nacional.',
    owner: 'dono',
  });
  /*
    O MUNICÍPIO DO PRESTADOR NA TABELA OFICIAL (R3-IBGE). A DPS leva o código
    do município no corpo e no próprio Id; com a tabela carregada, o código que
    ela desmente (não existe, é de outra UF, é de outra cidade) trava aqui —
    antes de reservar o número da DPS —, e não na Sefin, depois.
  */
  const municipioErrado =
    digits(f.cityIbge).length === 7
      ? municipioDoEmitenteQueNaoConfere({ codigo: f.cityIbge, uf: f.uf, cidade: f.cityName })
      : null;
  const emitenteOk =
    digits(f.cnpj).length === 14 && digits(f.cityIbge).length === 7 && Boolean(f.uf) && !municipioErrado;
  item({
    key: 'nfse_emitente',
    label: 'Prestador (CNPJ, município, UF)',
    status: emitenteOk ? 'OK' : 'FAIL',
    detail: emitenteOk
      ? `CNPJ e município ${digits(f.cityIbge)} do cadastro fiscal.`
      : municipioErrado
        ? `O município do prestador não confere com a tabela oficial do IBGE: ${municipioErrado}. `
          + 'Escolha a UF e o município na lista em Fiscal › Emitente (o código vem junto).'
        : 'Complete CNPJ, código IBGE do município e UF em Fiscal › Emitente.',
    owner: 'gerente',
  });
  item({
    key: 'nfse_municipio',
    label: 'Município no Emissor Nacional',
    status: c.municipalityConfirmedAt ? 'OK' : 'FAIL',
    detail: c.municipalityConfirmedAt
      ? 'Confirmado que o município recebe a NFS-e pelo Sistema Nacional.'
      : 'Confirme com a prefeitura (ou o contador) que o município do prestador está no Sistema '
        + 'Nacional NFS-e e que a empresa está habilitada lá.',
    owner: 'prefeitura',
  });
  item({
    key: 'nfse_codigo',
    label: 'Código do serviço (cTribNac)',
    status: /^\d{6}$/.test(String(c.serviceCode ?? '')) ? 'OK' : 'FAIL',
    detail: c.serviceCode
      ? `Código ${c.serviceCode}.`
      : 'O contador informa o código de tributação nacional da mão de obra (6 dígitos).',
    owner: 'contador',
  });
  const regimeOk =
    ['1', '2', '3'].includes(String(c.simplesOption ?? ''))
    && (c.simplesOption !== '3' || ['1', '2', '3'].includes(String(c.simplesRegime ?? '')));
  item({
    key: 'nfse_regime',
    label: 'Regime tributário do prestador',
    status: regimeOk ? 'OK' : 'FAIL',
    detail: regimeOk
      ? 'Situação no Simples e regime de apuração informados.'
      : 'O contador informa a situação no Simples Nacional e, para ME/EPP, o regime de apuração.',
    owner: 'contador',
  });
  const a1 = situacaoDoA1(companyId);
  item({
    key: 'nfse_certificado',
    label: 'Certificado A1',
    status: a1.ok ? 'OK' : 'FAIL',
    detail: a1.detalhe,
    owner: 'dono',
  });
  item({
    key: 'nfse_leiaute',
    label: 'Leiaute da DPS',
    status: 'INFO',
    detail:
      'Leiaute DPS 1.00 do Sistema Nacional, montado sem o XSD oficial embutido: a primeira DPS '
      + 'na homologação (produção restrita) confirma o leiaute antes da produção.',
    owner: 'gerente',
  });
  return {
    mode: c.mode,
    environment: c.environment,
    canEmit: itens.every((i) => i.status !== 'FAIL'),
    items: itens,
  };
}

// ------------------------------------------------------------ a venda e o serviço

interface ServicoParaNfse {
  servicos: ServicoDaVenda[];
  totalCents: number;
  descricao: string;
  tomador: { documento: string | null; nome: string | null } | null;
  serviceOrderId: string | null;
  recusa: string | null;
}

function servicoDaVenda(companyId: string, saleId: string, config: ConfiguracaoDaNfse): ServicoParaNfse {
  const venda = loadSaleForNfce(companyId, saleId);
  const servicos = venda.servicos ?? [];
  const totalCents = servicos.reduce((s, i) => s + i.totalCents, 0);
  const os = osDaVenda(companyId, saleId);
  const partes = servicos.map((s) => s.description);
  const descricao = [config.serviceDescription, ...partes].filter(Boolean).join(' — ');
  const doc = digits(venda.customerDocument);
  return {
    servicos,
    totalCents,
    descricao,
    tomador:
      doc.length === 11 || doc.length === 14 ? { documento: doc, nome: venda.customerName } : null,
    serviceOrderId: os?.id ?? null,
    recusa: venda.recusaDaSeparacao ?? null,
  };
}

function paraDocumento(r: Record<string, unknown>): DocumentoDaNfse {
  return {
    id: String(r.id),
    saleId: String(r.sale_id),
    serviceOrderId: (r.service_order_id as string | null) ?? null,
    origin: r.origin as DocumentoDaNfse['origin'],
    environment: r.environment as AmbienteDaNfse,
    status: r.status as SituacaoDaNfse,
    serviceCents: Number(r.service_cents),
    description: String(r.description),
    takerDocument: (r.taker_document as string | null) ?? null,
    takerName: (r.taker_name as string | null) ?? null,
    dpsSeries: (r.dps_series as string | null) ?? null,
    dpsNumber: r.dps_number === null || r.dps_number === undefined ? null : Number(r.dps_number),
    dpsId: (r.dps_id as string | null) ?? null,
    accessKey: (r.access_key as string | null) ?? null,
    nfseNumber: (r.nfse_number as string | null) ?? null,
    verificationCode: (r.verification_code as string | null) ?? null,
    reason: (r.reason as string | null) ?? null,
    issuedAt: (r.issued_at as string | null) ?? null,
    cancelledAt: (r.cancelled_at as string | null) ?? null,
    cancelReason: (r.cancel_reason as string | null) ?? null,
    simulated: String(r.access_key ?? '').startsWith('TESTE'),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

export function getNfseDaVenda(companyId: string, saleId: string): DocumentoDaNfse | null {
  ensureCoreSchema();
  const r = getConnection()
    .prepare('SELECT * FROM core_nfse_documents WHERE company_id = ? AND sale_id = ?')
    .get(companyId, saleId) as Record<string, unknown> | undefined;
  return r ? paraDocumento(r) : null;
}

export function listNfse(companyId: string, limit = 200): DocumentoDaNfse[] {
  ensureCoreSchema();
  return (
    getConnection()
      .prepare('SELECT * FROM core_nfse_documents WHERE company_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(companyId, Math.min(Math.max(1, limit), 1000)) as unknown as Record<string, unknown>[]
  ).map(paraDocumento);
}

export type AcaoDaNfse = 'EMITIR' | 'REGISTRAR' | 'NENHUMA';

export interface ProntidaoDaNfseDaVenda {
  mode: ModoDaNfse;
  environment: AmbienteDaNfse;
  /** O gesto que a tela oferece: emitir pela Sefin, registrar a do portal, ou nada. */
  action: AcaoDaNfse;
  canEmit: boolean;
  serviceCents: number;
  description: string;
  reasons: string[];
  document: DocumentoDaNfse | null;
}

const FINAIS: SituacaoDaNfse[] = ['AUTORIZADA', 'REGISTRADA', 'CANCELADA'];

export function nfseReadinessForSale(companyId: string, saleId: string): ProntidaoDaNfseDaVenda {
  ensureCoreSchema();
  const config = getNfseConfig(companyId);
  const documento = getNfseDaVenda(companyId, saleId);
  const base = {
    mode: config.mode,
    environment: config.environment,
    document: documento,
  };

  let servico: ServicoParaNfse;
  try {
    servico = servicoDaVenda(companyId, saleId, config);
  } catch (err) {
    return {
      ...base,
      action: 'NENHUMA',
      canEmit: false,
      serviceCents: 0,
      description: '',
      reasons: [err instanceof ApiError ? err.message : 'Não foi possível ler esta venda.'],
    };
  }
  const comum = { ...base, serviceCents: servico.totalCents, description: servico.descricao };

  if (documento && FINAIS.includes(documento.status)) {
    return {
      ...comum,
      action: 'NENHUMA',
      canEmit: false,
      reasons: [
        documento.status === 'CANCELADA'
          ? 'A NFS-e desta venda foi cancelada.'
          : 'Esta venda já tem NFS-e.',
      ],
    };
  }
  if (servico.totalCents <= 0) {
    return { ...comum, action: 'NENHUMA', canEmit: false, reasons: ['Esta venda não tem serviço — não há NFS-e a emitir.'] };
  }
  if (servico.recusa) {
    return { ...comum, action: 'NENHUMA', canEmit: false, reasons: [servico.recusa] };
  }

  const prontidao = prontidaoDaNfse(companyId);
  if (config.mode === 'DESLIGADA') {
    return {
      ...comum,
      action: 'NENHUMA',
      canEmit: false,
      reasons: prontidao.items.filter((i) => i.status === 'FAIL').map((i) => i.detail),
    };
  }
  if (config.mode === 'REGISTRO_MANUAL') {
    return { ...comum, action: 'REGISTRAR', canEmit: false, reasons: [] };
  }

  const motivos = prontidao.items.filter((i) => i.status === 'FAIL').map((i) => `${i.label}: ${i.detail}`);
  const f = getFiscalConfig(companyId);
  for (const p of validarDadosDaDps({
    ambiente: config.environment,
    emitente: { cnpj: f.cnpj, im: f.im, cityIbge: f.cityIbge, uf: f.uf },
    tributacao: config,
    tomador: servico.tomador,
    servico: { descricao: servico.descricao, valorCents: servico.totalCents },
    serie: config.dpsSeries,
  })) {
    if (!motivos.some((m) => m.includes(p))) motivos.push(p);
  }
  return { ...comum, action: 'EMITIR', canEmit: motivos.length === 0, reasons: [...new Set(motivos)] };
}

// ------------------------------------------------------------------ emissão

/** Reserva o próximo número da DPS — dentro de transação, só anda para frente. */
function reservarNumeroDaDps(companyId: string): { serie: string; numero: number } {
  const r = getConnection()
    .prepare(
      `UPDATE core_nfse_configs SET next_dps_number = next_dps_number + 1, updated_at = ?
        WHERE company_id = ?
        RETURNING dps_series AS serie, next_dps_number - 1 AS numero`,
    )
    .get(agora(), companyId) as { serie: string; numero: number } | undefined;
  if (!r) throw new ApiError('CORE_NFSE_NOT_CONFIGURED', 'A NFS-e não está configurada nesta operação.', 409);
  return { serie: String(r.serie), numero: Number(r.numero) };
}

export interface OpcoesDaEmissaoNfse {
  companyId: string;
  saleId: string;
  userId: string;
  /** Injetado pelos testes; sem ele, o adapter real com o A1 do cofre. */
  adapter?: NfseAdapter;
  /** Simulador sem valor fiscal — recusado em produção (operação ou processo). */
  developmentMode?: boolean;
}

/**
 * Emite a NFS-e da mão de obra desta venda pela Sefin Nacional.
 *
 * Idempotente: venda com NFS-e autorizada devolve a mesma. Recusa e queda de
 * rede deixam o documento com o número da DPS, e a próxima tentativa reenvia
 * o MESMO número.
 */
export async function emitirNfseDaVenda(opcoes: OpcoesDaEmissaoNfse): Promise<DocumentoDaNfse> {
  ensureCoreSchema();
  const { companyId, saleId, userId } = opcoes;
  const config = getNfseConfig(companyId);
  const existente = getNfseDaVenda(companyId, saleId);
  if (existente && FINAIS.includes(existente.status)) return existente;

  if (config.mode !== 'EMISSOR_NACIONAL') {
    throw new ApiError(
      'CORE_NFSE_MODE_NOT_API',
      config.mode === 'REGISTRO_MANUAL'
        ? 'Nesta operação a NFS-e é emitida no portal e registrada aqui — use "Registrar NFS-e".'
        : 'A NFS-e está desligada nesta operação (Fiscal › NFS-e).',
      409,
    );
  }

  const dev = opcoes.developmentMode === true;
  if (dev && (config.environment === 'production' || servidorEmProducao())) {
    throw new ApiError(
      'CORE_NFSE_TEST_PROVIDER_IN_PRODUCTION',
      'O simulador da NFS-e não pode emitir em produção.',
      409,
    );
  }

  const prontidao = nfseReadinessForSale(companyId, saleId);
  // Em modo de desenvolvimento o certificado não é exigido: o simulador não
  // confere assinatura, e a nota dele não tem valor.
  const motivos = prontidao.reasons.filter((m) => !(dev && m.startsWith('Certificado A1')));
  if (motivos.length > 0) {
    throw new ApiError(
      'CORE_NFSE_NOT_READY',
      `A NFS-e desta venda não pode ser emitida: ${motivos.join(' | ')}`,
      409,
      { reasons: motivos },
    );
  }

  const cert = dev ? null : certificadoDoCofre(companyId);
  if (!dev && !cert) {
    throw new ApiError('FISCAL_CERTIFICATE_NOT_FOUND', 'Nenhum certificado A1 no cofre desta empresa.', 409);
  }
  const adapter = opcoes.adapter ?? (dev ? new NfseTesteAdapter() : new NfseNacionalAdapter({ cert: cert! }));
  assertAdapterDaNfsePodeTransmitir({ adapter, ambiente: config.environment });

  const f = getFiscalConfig(companyId);
  const servico = servicoDaVenda(companyId, saleId, config);

  // Número: o que o documento já tem (reenvio), ou um novo.
  const { documentoId, serie, numero } = withTransaction(() => {
    const db = getConnection();
    const ts = agora();
    if (existente && existente.dpsNumber !== null) {
      db.prepare(
        "UPDATE core_nfse_documents SET status = 'ENVIANDO', reason = NULL, updated_at = ? WHERE id = ?",
      ).run(ts, existente.id);
      return { documentoId: existente.id, serie: existente.dpsSeries ?? config.dpsSeries, numero: existente.dpsNumber };
    }
    const reservado = reservarNumeroDaDps(companyId);
    const id = randomUUID();
    db.prepare(
      `INSERT INTO core_nfse_documents
         (id, company_id, sale_id, service_order_id, origin, environment, status, service_cents,
          description, taker_document, taker_name, dps_series, dps_number, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'EMISSOR_NACIONAL', ?, 'ENVIANDO', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      companyId,
      saleId,
      servico.serviceOrderId,
      config.environment,
      servico.totalCents,
      servico.descricao,
      servico.tomador?.documento ?? null,
      servico.tomador?.nome ?? null,
      reservado.serie,
      reservado.numero,
      userId,
      ts,
      ts,
    );
    return { documentoId: id, serie: reservado.serie, numero: reservado.numero };
  });

  const dados: DadosDaDps = {
    ambiente: config.environment,
    emitente: { cnpj: f.cnpj, im: f.im, cityIbge: f.cityIbge, uf: f.uf },
    tributacao: config,
    tomador: servico.tomador,
    servico: { descricao: servico.descricao, valorCents: servico.totalCents },
    serie,
    numero,
    emitidaEm: new Date(),
  };
  const dps = montarDps(dados);
  const assinada = cert ? signXmlElement(dps.xml, { tagName: 'infDPS', closeParentTag: '</DPS>' }, cert).xml : dps.xml;

  const salvar = (campos: Record<string, unknown>) => {
    const chaves = Object.keys(campos);
    getConnection()
      .prepare(
        `UPDATE core_nfse_documents SET ${chaves.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
      )
      .run(...(chaves.map((k) => campos[k]) as never[]), agora(), documentoId);
  };
  salvar({ dps_id: dps.id, xml_dps: assinada, environment: config.environment });

  let acao = 'fiscal.nfse.emitted';
  try {
    const r = await adapter.enviarDps({ dpsAssinada: assinada, ambiente: config.environment });
    if (r.situacao === 'AUTORIZADA') {
      salvar({
        status: 'AUTORIZADA',
        access_key: r.chaveAcesso,
        nfse_number: r.numeroNfse,
        xml_nfse: r.xmlNfse,
        issued_at: agora(),
        reason: r.alertas.length ? r.alertas.map((a) => `${a.codigo} ${a.descricao}`).join(' | ') : null,
      });
    } else {
      acao = 'fiscal.nfse.rejected';
      salvar({
        status: 'REJEITADA',
        reason: r.motivos.map((m) => `${m.codigo} ${m.descricao}`.trim()).join(' | ') || 'Recusada sem motivo.',
      });
    }
  } catch (err) {
    if (!(err instanceof TransportFailure)) {
      salvar({ status: 'SEM_RESPOSTA', reason: err instanceof Error ? err.message : 'Falha ao enviar.' });
      throw err;
    }
    acao = 'fiscal.nfse.no_response';
    salvar({
      status: 'SEM_RESPOSTA',
      reason:
        `${err.message} A Sefin pode ter recebido a DPS: tente de novo — o reenvio usa o mesmo `
        + `número (${serie}/${numero}), e a Sefin não gera duas NFS-e da mesma DPS.`,
    });
  }

  const final = getNfseDaVenda(companyId, saleId)!;
  recordAudit({
    companyId,
    userId,
    action: acao,
    entityType: 'nfse_document',
    entityId: final.id,
    detail: {
      saleId,
      status: final.status,
      environment: final.environment,
      dps: `${serie}/${numero}`,
      adapter: adapter.nome,
    },
  });
  return final;
}

// -------------------------------------------------- registro e cancelamento

/**
 * Registra a NFS-e emitida no portal (modo REGISTRO_MANUAL): número, código de
 * verificação ou chave, e a data. Liga a nota à venda e à OS — é o que o
 * contador recebe no pacote do mês.
 */
export function registrarNfseManual(input: {
  companyId: string;
  saleId: string;
  userId: string;
  numero: string;
  codigoVerificacao?: string | null;
  chaveAcesso?: string | null;
  emitidaEm: string;
}): DocumentoDaNfse {
  ensureCoreSchema();
  const config = getNfseConfig(input.companyId);
  if (config.mode !== 'REGISTRO_MANUAL') {
    throw new ApiError(
      'CORE_NFSE_MODE_NOT_MANUAL',
      'Registrar NFS-e do portal só vale com o modo "Registro manual" (Fiscal › NFS-e).',
      409,
    );
  }
  const numero = limpo(input.numero);
  if (!numero || !/^[0-9A-Za-z./-]{1,20}$/.test(numero)) {
    throw new ApiError('CORE_NFSE_NUMBER_INVALID', 'Informe o número da NFS-e como o portal mostra.', 400);
  }
  const codigo = limpo(input.codigoVerificacao);
  const chave = limpo(input.chaveAcesso);
  if (!codigo && !chave) {
    throw new ApiError(
      'CORE_NFSE_VERIFICATION_REQUIRED',
      'Informe o código de verificação ou a chave de acesso — é por ele que a nota é conferida.',
      400,
    );
  }
  if (chave && !/^\d{50}$/.test(digits(chave))) {
    throw new ApiError('CORE_NFSE_KEY_INVALID', 'A chave de acesso da NFS-e nacional tem 50 dígitos.', 400);
  }
  const emitida = new Date(input.emitidaEm);
  if (Number.isNaN(emitida.getTime()) || emitida.getTime() > Date.now() + 5 * 60_000) {
    throw new ApiError('CORE_NFSE_DATE_INVALID', 'Data de emissão inválida ou no futuro.', 400);
  }

  const prontidao = nfseReadinessForSale(input.companyId, input.saleId);
  if (prontidao.action !== 'REGISTRAR') {
    throw new ApiError('CORE_NFSE_NOT_READY', prontidao.reasons.join(' | ') || 'Não há o que registrar.', 409, {
      reasons: prontidao.reasons,
    });
  }
  const servico = servicoDaVenda(input.companyId, input.saleId, config);
  const ts = agora();
  const id = randomUUID();
  getConnection()
    .prepare(
      `INSERT INTO core_nfse_documents
         (id, company_id, sale_id, service_order_id, origin, environment, status, service_cents,
          description, taker_document, taker_name, access_key, nfse_number, verification_code,
          issued_at, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'REGISTRO_MANUAL', 'production', 'REGISTRADA', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(company_id, sale_id) DO UPDATE SET
         origin = 'REGISTRO_MANUAL', environment = 'production', status = 'REGISTRADA',
         access_key = excluded.access_key, nfse_number = excluded.nfse_number,
         verification_code = excluded.verification_code, issued_at = excluded.issued_at,
         reason = NULL, updated_at = excluded.updated_at`,
    )
    .run(
      id,
      input.companyId,
      input.saleId,
      servico.serviceOrderId,
      servico.totalCents,
      servico.descricao,
      servico.tomador?.documento ?? null,
      servico.tomador?.nome ?? null,
      chave ? digits(chave) : null,
      numero,
      codigo,
      emitida.toISOString(),
      input.userId,
      ts,
      ts,
    );
  const doc = getNfseDaVenda(input.companyId, input.saleId)!;
  recordAudit({
    companyId: input.companyId,
    userId: input.userId,
    action: 'fiscal.nfse.registered_manual',
    entityType: 'nfse_document',
    entityId: doc.id,
    detail: { saleId: input.saleId, numero, serviceCents: servico.totalCents },
  });
  return doc;
}

/**
 * Registra o CANCELAMENTO feito no portal (Emissor Nacional ou prefeitura).
 * O documento fica com o motivo e quem registrou; a nota não some.
 */
export function registrarCancelamentoDaNfse(input: {
  companyId: string;
  documentId: string;
  userId: string;
  motivo: string;
}): DocumentoDaNfse {
  ensureCoreSchema();
  const r = getConnection()
    .prepare('SELECT * FROM core_nfse_documents WHERE id = ? AND company_id = ?')
    .get(input.documentId, input.companyId) as Record<string, unknown> | undefined;
  if (!r) throw new ApiError('CORE_NFSE_NOT_FOUND', 'NFS-e não encontrada.', 404);
  const doc = paraDocumento(r);
  if (doc.status !== 'AUTORIZADA' && doc.status !== 'REGISTRADA') {
    throw new ApiError('CORE_NFSE_NOT_CANCELLABLE', `NFS-e ${doc.status.toLowerCase()} não se cancela.`, 409);
  }
  const motivo = limpo(input.motivo);
  if (!motivo || motivo.length < 15) {
    throw new ApiError('CORE_NFSE_CANCEL_REASON', 'O motivo do cancelamento precisa de pelo menos 15 caracteres.', 400);
  }
  const ts = agora();
  getConnection()
    .prepare(
      "UPDATE core_nfse_documents SET status = 'CANCELADA', cancelled_at = ?, cancel_reason = ?, updated_at = ? WHERE id = ?",
    )
    .run(ts, motivo, ts, doc.id);
  recordAudit({
    companyId: input.companyId,
    userId: input.userId,
    action: 'fiscal.nfse.cancel_recorded',
    entityType: 'nfse_document',
    entityId: doc.id,
    detail: { saleId: doc.saleId, motivo },
  });
  return getNfseDaVenda(input.companyId, doc.saleId)!;
}
