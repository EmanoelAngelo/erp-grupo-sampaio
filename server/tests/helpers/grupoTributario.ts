/**
 * A implantação fiscal mínima de uma operação, para os testes.
 *
 * Duas coisas passaram a ser exigidas na emissão, e as duas são o conserto —
 * não efeito colateral:
 *
 *  - a TRIBUTAÇÃO vem de `core_tax_groups`, e não mais cravada no XML. Emitir
 *    sem grupo cadastrado é recusado, com a recusa nomeando o produto;
 *  - a NFC-e exige CSC, porque sem ele não há QR Code, e modelo 65 sem QR é
 *    recusado pela SEFAZ e não é conferível pelo consumidor.
 *
 * Os valores tributários são os que o contador da Preço Justo confirmou:
 * Simples, CSOSN 102 (sem crédito, portanto sem `pCredSN`), PIS e COFINS no
 * CST 49 com alíquota zero, CFOP 5102 dentro do estado e 6102 para fora.
 *
 * O CSC daqui é de TESTE e existe só para o XML poder ser montado. O CSC real
 * vem do portal da SEFAZ e é dependência externa — nenhum teste o inventa.
 */
import { upsertTaxGroup } from '../../src/services/core/CatalogAuxService.js';
import { upsertNfceCsc } from '../../src/services/nfce/NfceCscService.js';

export function grupoTributarioPadrao(companyId: string): void {
  upsertTaxGroup(companyId, {
    code: 'SIMPLES-102',
    name: 'Simples Nacional — CSOSN 102',
    regime: 'simples',
    csosn: '102',
    cstPis: '49',
    cstCofins: '49',
    cfopInternal: '5102',
    cfopExternal: '6102',
  });

  upsertNfceCsc({
    companyId,
    operationalUnitId: 'unit-default',
    cscId: '000001',
    cscToken: 'CSC-DE-TESTE-NAO-E-O-REAL',
  });
}
