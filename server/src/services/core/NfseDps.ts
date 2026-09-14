/**
 * A DPS DA NFS-e NACIONAL — GAP-PRD-024.
 *
 * A mão de obra da OS é serviço (ISS), e o documento dela é a NFS-e. Desde a
 * reforma do padrão nacional, o prestador não escreve a NFS-e: ele envia a
 * DPS (Declaração de Prestação de Serviço), assinada com o A1, à Sefin
 * Nacional, que devolve a NFS-e com a chave de acesso de 50 posições.
 *
 * Este módulo MONTA e VALIDA a DPS. Transportar é do adapter
 * (`NfseAdapter.ts`); orquestrar — número, assinatura, estado, auditoria — é
 * do serviço (`NfseService.ts`).
 *
 * ## O que é de quem
 *
 * - Código de tributação nacional (`cTribNac`), regime do Simples
 *   (`opSimpNac`/`regApTribSN`), regime especial, retenção e alíquota do ISS:
 *   do CONTADOR. O sistema não chuta nenhum — sem eles a prontidão diz o que
 *   falta e a DPS não é montada.
 * - CNPJ, inscrição municipal, município: do cadastro fiscal da operação.
 * - Série e número da DPS: da configuração da NFS-e, e o número só anda para
 *   frente (reenvio da mesma venda usa o MESMO número).
 *
 * ## O leiaute
 *
 * Escrito pelo leiaute da DPS versão 1.00 do Sistema Nacional NFS-e
 * (`infDPS` com `Id` = "DPS" + município (7) + tipo de inscrição (1) + CNPJ
 * (14) + série (5) + número (15)). O XSD oficial NÃO está embutido neste
 * repositório (não havia cópia verificável sem rede), por isso a primeira DPS
 * na produção restrita do Emissor Nacional é o juiz final do leiaute — está
 * dito na prontidão e no journal. As regras que o sistema consegue conferir
 * sozinho (formato de cada campo) ficam em `validarDadosDaDps`, antes do
 * número.
 */
import { ApiError } from '../../utils/errors.js';
import { momentoFiscal } from './MomentoFiscal.js';
import { digits, money, xmlEscape } from './FiscalXmlNfce.js';

export const NFSE_NAMESPACE = 'http://www.sped.fazenda.gov.br/nfse';
export const VERSAO_DA_DPS = '1.00';
export const VERSAO_DO_APLICATIVO = 'DEVORA-NFSE-1.0';

/** Os códigos que o contador informa — a mesma forma da tabela `core_nfse_configs`. */
export interface TributacaoDoServico {
  /** cTribNac: item (2) + subitem (2) + desdobramento (2) da lista nacional. */
  serviceCode: string | null;
  /** cTribMun: desdobramento municipal (3 dígitos), opcional. */
  municipalServiceCode: string | null;
  /** cNBS: Nomenclatura Brasileira de Serviços (9 dígitos), opcional. */
  nbsCode: string | null;
  /** pAliq: alíquota do ISS em %, com até duas casas ("2.50"), opcional. */
  issRate: string | null;
  /** opSimpNac: 1 não optante, 2 MEI, 3 ME/EPP. */
  simplesOption: string | null;
  /** regApTribSN (só com opSimpNac 3): 1, 2 ou 3. */
  simplesRegime: string | null;
  /** regEspTrib: 0 nenhum … 6 sociedade de profissionais. */
  specialRegime: string;
  /** tpRetISSQN: 1 não retido, 2 retido pelo tomador, 3 retido pelo intermediário. */
  issWithholding: string;
}

export interface DadosDaDps {
  ambiente: 'homologation' | 'production';
  emitente: { cnpj: string | null; im: string | null; cityIbge: string | null; uf: string | null };
  tributacao: TributacaoDoServico;
  tomador: { documento: string | null; nome: string | null } | null;
  servico: { descricao: string; valorCents: number };
  serie: string;
  numero: number;
  emitidaEm: Date;
}

/** O `Id` da `infDPS` — é por ele que a assinatura referencia a declaração. */
export function idDaDps(input: { cityIbge: string; cnpj: string; serie: string; numero: number }): string {
  return (
    'DPS'
    + digits(input.cityIbge).padStart(7, '0')
    // 2 = CNPJ (1 seria CPF). O prestador aqui é sempre a operação, com CNPJ.
    + '2'
    + digits(input.cnpj).padStart(14, '0')
    + digits(input.serie).padStart(5, '0')
    + String(input.numero).padStart(15, '0')
  );
}

/**
 * Tudo o que dá para conferir antes de numerar. Cada problema nomeia o campo
 * e quem o informa — o contador não descobre pela rejeição.
 */
export function validarDadosDaDps(d: Omit<DadosDaDps, 'numero' | 'emitidaEm'> & { numero?: number }): string[] {
  const p: string[] = [];
  const t = d.tributacao;
  if (digits(d.emitente.cnpj).length !== 14) p.push('CNPJ do prestador ausente ou inválido (cadastro fiscal).');
  if (digits(d.emitente.cityIbge).length !== 7) {
    p.push('Código IBGE do município do prestador ausente (cadastro fiscal).');
  }
  if (!d.emitente.uf) p.push('UF do prestador ausente (cadastro fiscal).');
  if (d.emitente.im && !/^[0-9A-Za-z]{1,15}$/.test(d.emitente.im.trim())) {
    p.push('Inscrição municipal fora do formato (até 15 letras e números).');
  }
  if (!/^\d{6}$/.test(String(t.serviceCode ?? ''))) {
    p.push('Código de tributação nacional do serviço (cTribNac, 6 dígitos) — informado pelo contador.');
  }
  if (t.municipalServiceCode && !/^\d{3}$/.test(t.municipalServiceCode)) {
    p.push('Código de tributação municipal fora do formato (3 dígitos).');
  }
  if (t.nbsCode && !/^\d{9}$/.test(t.nbsCode)) p.push('Código NBS fora do formato (9 dígitos).');
  if (t.issRate && !(/^\d{1,2}(\.\d{1,2})?$/.test(t.issRate) && Number(t.issRate) > 0 && Number(t.issRate) <= 5)) {
    p.push('Alíquota do ISS fora do formato (ex.: 2.00, entre 0 e 5%).');
  }
  if (!['1', '2', '3'].includes(String(t.simplesOption ?? ''))) {
    p.push('Situação no Simples Nacional (não optante, MEI ou ME/EPP) — informada pelo contador.');
  }
  if (t.simplesOption === '3' && !['1', '2', '3'].includes(String(t.simplesRegime ?? ''))) {
    p.push('Regime de apuração do Simples (ME/EPP) — informado pelo contador.');
  }
  if (!/^[0-6]$/.test(t.specialRegime ?? '')) p.push('Regime especial de tributação inválido (0 a 6).');
  if (!['1', '2', '3'].includes(t.issWithholding ?? '')) p.push('Retenção do ISS inválida (1, 2 ou 3).');
  if (!/^\d{1,5}$/.test(d.serie)) p.push('Série da DPS inválida (1 a 5 dígitos).');
  if (d.numero !== undefined && !(Number.isInteger(d.numero) && d.numero >= 1 && d.numero < 1e15)) {
    p.push('Número da DPS inválido.');
  }
  const descricao = d.servico.descricao.trim();
  if (!descricao || descricao.length > 2000) p.push('Descrição do serviço vazia ou maior que 2000 caracteres.');
  if (!(Number.isInteger(d.servico.valorCents) && d.servico.valorCents > 0)) {
    p.push('Valor do serviço precisa ser maior que zero.');
  }
  if (d.tomador?.documento) {
    const doc = digits(d.tomador.documento);
    if (doc.length !== 11 && doc.length !== 14) p.push('Documento do tomador precisa ter 11 (CPF) ou 14 (CNPJ) dígitos.');
    if (!d.tomador.nome?.trim()) p.push('Tomador identificado precisa de nome.');
  }
  return p;
}

/** Monta a DPS, ainda sem assinatura. Recusa com os problemas se houver. */
export function montarDps(d: DadosDaDps): { xml: string; id: string } {
  const problemas = validarDadosDaDps(d);
  if (problemas.length > 0) {
    throw new ApiError(
      'CORE_NFSE_DPS_INVALIDA',
      `A DPS não pode ser montada: ${problemas.join(' | ')}`,
      409,
      { problems: problemas },
    );
  }

  const t = d.tributacao;
  const cnpj = digits(d.emitente.cnpj);
  const municipio = digits(d.emitente.cityIbge);
  const id = idDaDps({ cityIbge: municipio, cnpj, serie: d.serie, numero: d.numero });
  // O instante no relógio do prestador — o mesmo motor da NF-e/NFC-e.
  const { dhEmi } = momentoFiscal(d.emitidaEm, String(d.emitente.uf));
  const competencia = dhEmi.slice(0, 10);

  const im = d.emitente.im?.trim() ? `\n      <IM>${xmlEscape(d.emitente.im.trim())}</IM>` : '';
  const regApTribSN = t.simplesOption === '3' ? `\n        <regApTribSN>${t.simplesRegime}</regApTribSN>` : '';

  let tomador = '';
  if (d.tomador?.documento) {
    const doc = digits(d.tomador.documento);
    const tag = doc.length === 14 ? 'CNPJ' : 'CPF';
    tomador = `
    <toma>
      <${tag}>${doc}</${tag}>
      <xNome>${xmlEscape(d.tomador.nome!.trim().slice(0, 300))}</xNome>
    </toma>`;
  }

  const cTribMun = t.municipalServiceCode ? `\n        <cTribMun>${t.municipalServiceCode}</cTribMun>` : '';
  const cNbs = t.nbsCode ? `\n        <cNBS>${t.nbsCode}</cNBS>` : '';
  const pAliq = t.issRate ? `\n          <pAliq>${Number(t.issRate).toFixed(2)}</pAliq>` : '';

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<DPS xmlns="${NFSE_NAMESPACE}" versao="${VERSAO_DA_DPS}">
  <infDPS Id="${id}">
    <tpAmb>${d.ambiente === 'production' ? '1' : '2'}</tpAmb>
    <dhEmi>${dhEmi}</dhEmi>
    <verAplic>${VERSAO_DO_APLICATIVO}</verAplic>
    <serie>${Number(d.serie)}</serie>
    <nDPS>${d.numero}</nDPS>
    <dCompet>${competencia}</dCompet>
    <tpEmit>1</tpEmit>
    <cLocEmi>${municipio}</cLocEmi>
    <prest>
      <CNPJ>${cnpj}</CNPJ>${im}
      <regTrib>
        <opSimpNac>${t.simplesOption}</opSimpNac>${regApTribSN}
        <regEspTrib>${t.specialRegime}</regEspTrib>
      </regTrib>
    </prest>${tomador}
    <serv>
      <locPrest>
        <cLocPrestacao>${municipio}</cLocPrestacao>
      </locPrest>
      <cServ>
        <cTribNac>${t.serviceCode}</cTribNac>${cTribMun}
        <xDescServ>${xmlEscape(d.servico.descricao.trim())}</xDescServ>${cNbs}
      </cServ>
    </serv>
    <valores>
      <vServPrest>
        <vServ>${money(d.servico.valorCents)}</vServ>
      </vServPrest>
      <trib>
        <tribMun>
          <tribISSQN>1</tribISSQN>${pAliq}
          <tpRetISSQN>${t.issWithholding}</tpRetISSQN>
        </tribMun>
        <totTrib>
          <indTotTrib>0</indTotTrib>
        </totTrib>
      </trib>
    </valores>
  </infDPS>
</DPS>`;
  return { xml, id };
}
