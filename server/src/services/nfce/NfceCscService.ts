import { createHash, randomUUID } from 'node:crypto';
import { findOneRow, findRows, insertRow, updateRows } from '../../db/database.js';
import { encryptFiscalSecret, decryptFiscalSecret } from '../fiscal/FiscalSecretVault.js';
import { ApiError, sanitizeForLog } from '../../utils/errors.js';

/*
  ============================================================================
  UM CSC PARA CADA AMBIENTE — GAP-PRD-022
  ============================================================================

  A SEFAZ emite um CSC para homologação e OUTRO para produção. Aqui havia um
  slot só por unidade, sem conferência de ambiente: depois da virada, o QR do
  cupom saía assinado com o CSC de TESTE (hash que o portal não confere) e a
  prontidão dizia CONFIGURADO; gravar o de produção apagava o de homologação.

  E gravar o de produção exigia NFCE_PRODUCTION_ENABLED ligada no servidor —
  o dia da virada virava "mudar variável e reiniciar", isto é, chamar o
  desenvolvedor. A trava estava no lugar errado: GUARDAR o CSC de produção não
  emite nada. O que protege a produção é o ambiente da operação, que só vira
  com o desbloqueio auditado (`unlockProduction`) — e é pelo ambiente da
  operação que a montagem escolhe qual CSC usar. (O módulo legado que ainda
  lia a variável, `NfceService`, saiu no GAP-PRD-075; a porta deste serviço é
  `/core/fiscal/nfce/csc`.)

  Chave: (empresa, unidade, ambiente). Registro antigo sem `environment` vale
  como homologação — era o padrão com que ele foi gravado.
*/

export type AmbienteDoCsc = 'homologation' | 'production';

const AMBIENTES: readonly string[] = ['homologation', 'production'];

/**
 * O ambiente de uma configuração ou de um registro, com o MESMO fail-safe da
 * emissão: só 'production' é produção (o `tpAmb` faz igual). Qualquer outra
 * coisa é homologação — nunca o contrário.
 */
export function ambienteDoCsc(valor: unknown): AmbienteDoCsc {
  return valor === 'production' ? 'production' : 'homologation';
}

export function rotuloDoAmbiente(ambiente: AmbienteDoCsc): string {
  return ambiente === 'production' ? 'produção' : 'homologação';
}

function linhaDoCsc(
  companyId: string,
  operationalUnitId: string,
  ambiente: AmbienteDoCsc,
): Record<string, unknown> | null {
  return findOneRow<Record<string, unknown>>(
    'nfce_settings',
    (r) =>
      r.companyId === companyId
      && r.operationalUnitId === operationalUnitId
      && ambienteDoCsc(r.environment) === ambiente,
  );
}

export function upsertNfceCsc(input: {
  companyId: string;
  operationalUnitId: string;
  cscId: string;
  cscToken: string;
  environment?: AmbienteDoCsc;
}): Record<string, unknown> {
  /*
    Lista fechada: 'producao' ou 'PRODUCTION' virariam homologação pelo
    fail-safe, e quem digitou acharia que gravou o de produção.
  */
  const ambiente = input.environment ?? 'homologation';
  if (!AMBIENTES.includes(ambiente)) {
    throw new ApiError(
      'NFCE_CSC_ENVIRONMENT_INVALID',
      `Ambiente "${String(ambiente).slice(0, 40)}" não existe. O CSC é de "homologation" ou de "production".`,
      400,
    );
  }
  if (!input.cscId?.trim() || !input.cscToken?.trim()) {
    throw new ApiError('NFCE_CSC_REQUIRED', 'CSC ID e token são obrigatórios.', 400);
  }

  const encryptedCsc = encryptFiscalSecret(input.cscToken);
  const existing = linhaDoCsc(input.companyId, input.operationalUnitId, ambiente);

  const row = {
    companyId: input.companyId,
    operationalUnitId: input.operationalUnitId,
    cscId: input.cscId.trim(),
    cscReference: `vault:csc:${input.operationalUnitId}:${ambiente}`,
    encryptedCsc,
    hasCsc: true,
    environment: ambiente,
    updatedAt: new Date().toISOString(),
  };

  if (existing) {
    updateRows('nfce_settings', (r) => r.id === existing.id, (r) => ({ ...r, ...row }));
    // CSC substituído invalida readiness/homologação anterior (caller deve resetar state)
    return findOneRow('nfce_settings', (r) => r.id === existing.id) as Record<string, unknown>;
  }

  return insertRow('nfce_settings', {
    id: `nfce-csc-${randomUUID()}`,
    createdAt: new Date().toISOString(),
    ...row,
  });
}

/**
 * O CSC da operação NO AMBIENTE PEDIDO, se houver — sem levantar.
 *
 * `getNfceCscToken` recusa quando não há CSC, e essa recusa é a certa para
 * quem vai transmitir. Quem MONTA o XML precisa da outra pergunta: existe? A
 * resposta nula deixa o montador dizer, com o nome do que falta, em vez de
 * estourar no meio da construção do documento.
 *
 * O ambiente é OBRIGATÓRIO (GAP-PRD-022): sem ele, a pergunta "qual CSC?"
 * tinha uma resposta só, e em produção ela era o de teste.
 */
export function acharCscDaOperacao(
  companyId: string,
  operationalUnitId: string,
  ambiente: AmbienteDoCsc,
): { cscId: string; cscToken: string } | null {
  const setting = linhaDoCsc(companyId, operationalUnitId, ambiente);
  if (!setting?.encryptedCsc) return null;
  return {
    cscId: String(setting.cscId),
    cscToken: decryptFiscalSecret(String(setting.encryptedCsc)),
  };
}

export interface CscResumo {
  cscId: string;
  updatedAt: string | null;
}

/**
 * O que existe em cada ambiente — o ID e quando foi gravado, nunca o token.
 *
 * É a pergunta da prontidão e da recusa nomeada: "não tem CSC" e "tem o CSC
 * do OUTRO ambiente" pedem frases diferentes, e só esta leitura separa as
 * duas sem tocar no segredo.
 */
export function cscsDaOperacao(
  companyId: string,
  operationalUnitId = 'unit-default',
): Record<AmbienteDoCsc, CscResumo | null> {
  const resumo = (ambiente: AmbienteDoCsc): CscResumo | null => {
    const r = linhaDoCsc(companyId, operationalUnitId, ambiente);
    if (!r?.encryptedCsc || !r.cscId) return null;
    return { cscId: String(r.cscId), updatedAt: r.updatedAt ? String(r.updatedAt) : null };
  };
  return { homologation: resumo('homologation'), production: resumo('production') };
}

export function getNfceCscToken(
  companyId: string,
  operationalUnitId: string,
  ambiente: AmbienteDoCsc,
): { cscId: string; cscToken: string } {
  const csc = acharCscDaOperacao(companyId, operationalUnitId, ambiente);
  if (!csc) {
    throw new ApiError(
      'NFCE_CSC_REQUIRED',
      `CSC de ${rotuloDoAmbiente(ambiente)} não configurado no backend.`,
      404,
    );
  }
  return csc;
}

export function sanitizeNfceCscForResponse(row: Record<string, unknown>): Record<string, unknown> {
  return sanitizeForLog({
    id: row.id,
    companyId: row.companyId,
    operationalUnitId: row.operationalUnitId,
    cscId: row.cscId,
    hasCsc: Boolean(row.encryptedCsc),
    configured: Boolean(row.cscId && row.encryptedCsc),
    environment: ambienteDoCsc(row.environment),
    updatedAt: row.updatedAt ?? null,
    secretReference: row.cscReference,
  }) as Record<string, unknown>;
}

export function listNfceCscSettings(companyId: string): Record<string, unknown>[] {
  return findRows('nfce_settings', (r) => r.companyId === companyId).map(sanitizeNfceCscForResponse);
}

/*
  A UF É OBRIGATÓRIA — auditoria de entrega. O default era `uf = 'SP'`, e o
  chamador nunca preenchia: toda NFC-e deste módulo apontava o QR para o
  portal de São Paulo, em silêncio, para uma empresa de Pelotas. Endereço
  fiscal não se chuta — é a mesma regra do resolverEndpointReal, que devolve
  501 declarado em vez de adivinhar.
*/
export function buildNfceQRCodeUrl(
  accessKey: string,
  environment: 'homologation' | 'production',
  cscId: string,
  cscToken: string,
  uf: string,
): { url: string; payload: string; hash: string; urlChave: string } {
  if (!uf?.trim()) {
    throw new ApiError(
      'NFCE_UF_REQUIRED',
      'Informe a UF do emitente na configuração fiscal: o portal do QR Code depende do estado.',
      400,
    );
  }
  const tpAmb = environment === 'homologation' ? '2' : '1';

  /*
    QR CODE VERSÃO 2, EMISSÃO ONLINE.

    O payload é `chNFe|nVersao|tpAmb|cIdToken|cHashQRCode`, e o hash é o SHA-1
    das QUATRO primeiras partes concatenadas com o CSC — não do CSC com a
    chave. A ordem e a entrada do hash importam: o portal refaz a conta com o
    CSC que ele tem e compara. Errado, o cupom não confere, e quem descobre é
    o cliente com o celular na mão.

    O `cIdToken` vai SEM os zeros não significativos (GAP-PRD-097). Ia com
    seis dígitos ("000001"), e o XSD oficial do `qrCode` (PL_010b, padrão "QR
    CODE V2 ONLINE") só aceita `0|[1-9][0-9]{0,5}` nessa posição: todo cupom
    saía fora do leiaute, e só a validação XSD local mostrou. O hash usa o
    MESMO identificador que viaja no `p=` — o portal refaz a conta com o que
    lê ali.
  */
  const idToken = String(cscId ?? '').replace(/[^0-9]/g, '').replace(/^0+(?=\d)/, '');
  const prefixo = `${accessKey}|2|${tpAmb}|${idToken}`;
  const hash = createHash('sha1').update(`${prefixo}${cscToken}`).digest('hex').toUpperCase();
  const payload = `${prefixo}|${hash}`;
  const base =
    uf === 'RS'
      ? 'https://dfe-portal.svrs.rs.gov.br/nfce/consulta'
      : portalDesconhecido(uf);
  return { url: `${base}?p=${payload}`, payload, hash, urlChave: base };
}

/*
  UF sem portal mapeado LEVANTA, não cai em SP. Antes, produção era SEMPRE o
  portal paulista — inclusive para o RS, que tem o próprio (SVRS). Um QR
  apontando para o estado errado é cupom que o cliente não consegue conferir,
  e ninguém descobre no teste porque o teste não escaneia.
*/
function portalDesconhecido(uf: string): never {
  throw new ApiError(
    'NFCE_UF_NOT_MAPPED',
    `Sem portal de QR Code mapeado para a UF ${uf} — endereço fiscal não se chuta.`,
    501,
  );
}
