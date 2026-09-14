/**
 * O SEGREDO DE UMA EMPRESA NÃO VAZA PARA OUTRA (GAP-PRD-147).
 *
 * Toda coleção de documentos é `(seq, id, data TEXT)`: a empresa dona da
 * linha mora DENTRO do JSON, e `findRows`/`updateRows`/`deleteRows` leem a
 * tabela inteira e filtram por uma função. O isolamento entre as seis
 * empresas — nas coleções que guardam chave de API, token, CSC, certificado e
 * credencial de maquininha — dependia de cada serviço lembrar de pôr
 * `companyId` no predicado. A auditoria registrou: nenhuma garantia
 * estrutural, e ninguém tinha provado serviço por serviço.
 *
 * Três camadas, cada uma cobrada aqui:
 *
 *   1. ESTRUTURA. Toda coleção ganha `company_id`, coluna gerada a partir do
 *      JSON (`json_extract(data, '$.companyId')`), e `findRowsDaEmpresa` filtra
 *      pela empresa NO SQL — a linha de outra empresa nem chega ao JavaScript.
 *   2. ESCRITA. Nas coleções que guardam segredo ou credencial, linha sem
 *      empresa é recusada, e atualização que MUDA a empresa de uma linha é
 *      recusada: segredo não troca de dono.
 *   3. PROVA POR SERVIÇO. Para cada serviço que lê e escreve essas coleções, a
 *      empresa A grava, e a empresa B não vê, não abre e não lista.
 *
 * `api_sessions` (sessões vencidas nunca podadas) é a outra metade da ficha e
 * é o GAP-PRD-069 da frente SEG, que tem exatamente essa correção.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  COLECOES_POR_EMPRESA,
  TABLE_NAMES,
  findRowsDaEmpresa,
  insertRow,
  resetDbForTests,
  updateRows,
} from '../src/db/database.js';
import { getConnection } from '../src/db/sqlite.js';
import {
  getIntegrationSecretPlaintext,
  listIntegrationSecrets,
  upsertIntegrationSecret,
} from '../src/services/integrations/IntegrationSecretVaultService.js';
import {
  getAsaasApiKey,
  getAsaasCredentialStatus,
  upsertAsaasApiKey,
} from '../src/services/integrations/AsaasCredentialService.js';
import {
  getAsaasIntegrationState,
  upsertAsaasIntegrationState,
} from '../src/services/integrations/AsaasIntegrationStateService.js';
import {
  getLogisticsCredentials,
  listLogisticsCredentialRefs,
  upsertLogisticsCredentials,
} from '../src/services/logistics/LogisticsCredentialService.js';
import {
  getPaymentTerminalCredentials,
  listPaymentTerminalCredentialRefs,
  upsertPaymentTerminalCredentials,
} from '../src/services/payment-terminal/PaymentTerminalCredentialService.js';
import { listNfceCscSettings, upsertNfceCsc } from '../src/services/nfce/NfceCscService.js';

process.env.DEVORA_API_ENV = 'test';

const A = 'empresa-a-segredo';
const B = 'empresa-b-vizinha';

beforeEach(() => {
  resetDbForTests();
});

describe('1. estrutura: a empresa da linha é coluna, e o filtro é SQL', () => {
  it('toda coleção tem company_id, gerada do JSON', () => {
    const db = getConnection();
    const semColuna = TABLE_NAMES.filter((t) => {
      const colunas = db.prepare(`PRAGMA table_xinfo("${t}")`).all() as { name: string }[];
      return !colunas.some((c) => c.name === 'company_id');
    });
    expect(semColuna).toEqual([]);

    insertRow('logistics_quotes', { id: 'aud-1', companyId: A, action: 'x' });
    const row = db.prepare('SELECT company_id FROM logistics_quotes WHERE id = ?').get('aud-1') as {
      company_id: string;
    };
    expect(row.company_id).toBe(A);
  });

  it('findRowsDaEmpresa só devolve linha da empresa pedida, e recusa empresa vazia', () => {
    insertRow('logistics_quotes', { id: 'a-1', companyId: A, action: 'um' });
    insertRow('logistics_quotes', { id: 'b-1', companyId: B, action: 'dois' });
    insertRow('logistics_quotes', { id: 'a-2', companyId: A, action: 'tres' });

    expect(findRowsDaEmpresa('logistics_quotes', A).map((r) => r.id).sort()).toEqual(['a-1', 'a-2']);
    expect(findRowsDaEmpresa('logistics_quotes', A, (r) => r.action === 'tres').map((r) => r.id)).toEqual(['a-2']);
    expect(findRowsDaEmpresa('logistics_quotes', B).map((r) => r.id)).toEqual(['b-1']);
    expect(() => findRowsDaEmpresa('logistics_quotes', '')).toThrow();
    expect(() => findRowsDaEmpresa('logistics_quotes', '   ')).toThrow();
  });

  it('a linha de outra empresa nem chega ao JavaScript: um JSON quebrado de B não derruba a leitura de A', () => {
    insertRow('logistics_quotes', { id: 'a-1', companyId: A });
    // Linha de B com uma vírgula sobrando: o SQLite (JSON5) lê o companyId
    // dela, e o JSON.parse recusa. `findRows` (filtro em JS) estouraria;
    // `findRowsDaEmpresa` (filtro em SQL) nem a vê.
    getConnection()
      .prepare('INSERT INTO logistics_quotes (id, data) VALUES (?, ?)')
      .run('b-quebrada', `{"companyId":"${B}","x":1,}`);
    expect(() => findRowsDaEmpresa('logistics_quotes', A)).not.toThrow();
    expect(findRowsDaEmpresa('logistics_quotes', A).map((r) => r.id)).toEqual(['a-1']);
  });

  it('e o banco passa a recusar documento que não é JSON já na escrita', () => {
    // A coluna gerada é calculada ao gravar: lixo em `data` não entra mais,
    // por nenhum caminho — nem por SQL cru, que é por onde `insertRow` nunca
    // o poria (ele grava `JSON.stringify`).
    const cru = getConnection().prepare('INSERT INTO logistics_quotes (id, data) VALUES (?, ?)');
    expect(() => cru.run('lixo', '{isto nao e json')).toThrow(/malformed JSON/i);
    expect(findRowsDaEmpresa('logistics_quotes', A)).toEqual([]);
  });
});

describe('2. escrita: segredo tem dono, e não troca de dono', () => {
  it('as coleções de segredo e credencial estão sob a guarda', () => {
    for (const t of [
      'integration_secrets',
      'integration_configurations',
      'fiscal_certificate_references',
      'nfce_settings',
      'logistics_carrier_credentials',
      'payment_terminal_configurations',
      'payment_terminal_local_agents',
    ]) {
      expect(COLECOES_POR_EMPRESA.has(t), t).toBe(true);
    }
  });

  it('linha sem empresa é recusada', () => {
    expect(() => insertRow('integration_secrets', { id: 'sem-dono', provider: 'asaas', encryptedValue: 'x' })).toThrow(
      /empresa/i,
    );
    expect(() => insertRow('nfce_settings', { id: 'sem-dono', companyId: '  ' })).toThrow(/empresa/i);
    // Coleção fora da guarda (log de requisição) aceita — ela não guarda segredo.
    expect(() => insertRow('api_request_logs', { id: 'log-1', path: '/x' })).not.toThrow();
  });

  it('atualização que muda a empresa da linha é recusada — e nada muda', () => {
    insertRow('integration_secrets', { id: 'seg-a', companyId: A, provider: 'asaas', encryptedValue: 'x' });
    expect(() =>
      updateRows('integration_secrets', (r) => r.id === 'seg-a', (r) => ({ ...r, companyId: B })),
    ).toThrow(/empresa/i);
    expect(findRowsDaEmpresa('integration_secrets', A).map((r) => r.id)).toEqual(['seg-a']);
    expect(findRowsDaEmpresa('integration_secrets', B)).toEqual([]);
    // Atualizar o resto, mantendo a empresa, continua normal.
    expect(updateRows('integration_secrets', (r) => r.id === 'seg-a', (r) => ({ ...r, maskedHint: '***9' }))).toBe(1);
  });
});

describe('3. prova por serviço: A grava, B não vê', () => {
  it('cofre de integrações (integration_secrets)', () => {
    upsertIntegrationSecret({ companyId: A, provider: 'melhor_envio', secretType: 'api_key', plaintext: 'token-da-a-123456' });
    expect(getIntegrationSecretPlaintext({ companyId: A, provider: 'melhor_envio', secretType: 'api_key' })).toBe('token-da-a-123456');
    expect(getIntegrationSecretPlaintext({ companyId: B, provider: 'melhor_envio', secretType: 'api_key' })).toBeNull();
    expect(listIntegrationSecrets(B)).toEqual([]);
  });

  it('chave do Asaas por empresa', () => {
    upsertAsaasApiKey({ companyId: A, environment: 'sandbox', apiKey: '$aact_hmlg_da_empresa_a_000000' });
    expect(getAsaasApiKey(A, 'sandbox')).toBe('$aact_hmlg_da_empresa_a_000000');
    expect(getAsaasApiKey(B, 'sandbox')).not.toBe('$aact_hmlg_da_empresa_a_000000');
    expect(getAsaasCredentialStatus(B).sandbox.source).not.toBe('vault');
  });

  it('estado da integração (integration_configurations)', () => {
    upsertAsaasIntegrationState({ companyId: A }, { status: 'CONNECTED' });
    expect(getAsaasIntegrationState({ companyId: A }).status).toBe('CONNECTED');
    expect(getAsaasIntegrationState({ companyId: B }).status).not.toBe('CONNECTED');
  });

  it('credencial de transportadora (logistics_carrier_credentials)', () => {
    upsertLogisticsCredentials({ companyId: A, carrier: 'melhor_envio', credentials: { token: 'frete-da-a' } });
    expect(getLogisticsCredentials(A, 'melhor_envio')?.token).toBe('frete-da-a');
    expect(getLogisticsCredentials(B, 'melhor_envio')).toBeNull();
    expect(listLogisticsCredentialRefs(B)).toEqual([]);
  });

  it('credencial de maquininha (payment_terminal_configurations)', () => {
    upsertPaymentTerminalCredentials({ companyId: A, provider: 'stone', credentials: { merchantKey: 'chave-da-a' } });
    expect(getPaymentTerminalCredentials(A, 'stone')?.merchantKey).toBe('chave-da-a');
    expect(getPaymentTerminalCredentials(B, 'stone')).toBeNull();
    expect(listPaymentTerminalCredentialRefs(B)).toEqual([]);
  });

  it('CSC da NFC-e (nfce_settings)', () => {
    upsertNfceCsc({ companyId: A, operationalUnitId: 'loja-a', cscId: '000001', cscToken: 'csc-da-a', environment: 'homologation' });
    expect(listNfceCscSettings(A)).toHaveLength(1);
    expect(listNfceCscSettings(B)).toEqual([]);
  });

  it('referência de certificado A1 (fiscal_certificate_references)', () => {
    // O leitor legado (`FiscalService.listFiscalCertificateReferences`) saiu
    // no GAP-PRD-075; o filtro por empresa é o da própria coleção.
    insertRow('fiscal_certificate_references', { id: 'cert-a', companyId: A, operationalUnitId: 'loja-a', type: 'A1', encryptedPfx: 'x' });
    expect(findRowsDaEmpresa('fiscal_certificate_references', A)).toHaveLength(1);
    expect(findRowsDaEmpresa('fiscal_certificate_references', B)).toEqual([]);
  });
});
