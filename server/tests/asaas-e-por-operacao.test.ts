/**
 * A CONTA QUE RECEBE É A DA OPERAÇÃO — nunca a da vizinha.
 *
 * ============================================================================
 * O QUE ESTÁ CERTO, E POR QUE MESMO ASSIM FALTAVA UM GUARDA
 * ============================================================================
 *
 * `getAsaasApiKey(companyId, environment)` procura a chave no cofre, por
 * empresa e por unidade. O desenho está certo e o comentário de
 * `getAsaasCredentials` explica o motivo com todas as letras: cada operação tem
 * CNPJ próprio, e o Pix do cliente da Gringa não pode cair na conta do Preço
 * Justo.
 *
 * O buraco está no FALLBACK. Sem chave no cofre, a função cai para a chave do
 * ambiente — e a chave do ambiente é de UMA empresa: a que o dono configurou
 * primeiro. A guarda existente é `DEVORA_API_ENV === 'production'`, que fala do
 * modo do PROCESSO, e não do ambiente da COBRANÇA.
 *
 * As duas coisas se separam justamente na configuração que este projeto tem
 * agora: processo fora de 'production' (é uma instalação local que ainda vai
 * ser publicada) com `ASAAS_PRODUCTION_ENABLED=true` e a chave de PRODUÇÃO do
 * Preço Justo no `.env`. Nessa combinação, uma cobrança da Gringa sem
 * credencial própria sai na conta do Preço Justo — dinheiro real, de cliente
 * real, na conta errada, sem nenhum erro na tela.
 *
 * ============================================================================
 * A REGRA
 * ============================================================================
 *
 * Chave de ambiente serve para DESENVOLVER, e desenvolvimento é sandbox. Para
 * cobrança de PRODUÇÃO, ou a operação tem credencial própria no cofre, ou ela
 * não cobra — e diz por quê.
 */
process.env.TZ = 'UTC';

/*
  A chave do ambiente entra ANTES de qualquer import: `loadEnv` memoriza o
  ambiente na primeira leitura, e definir isto dentro do `beforeEach` não
  chegaria a tempo — o teste passaria por não haver chave nenhuma, que é o
  verde pelo motivo errado.
*/
const CHAVE_DO_ENV = '$aact_chave_de_ambiente_que_e_de_uma_empresa_so';
process.env.ASAAS_API_KEY = CHAVE_DO_ENV;
process.env.ASAAS_SANDBOX_API_KEY = CHAVE_DO_ENV;
process.env.ASAAS_PRODUCTION_API_KEY = CHAVE_DO_ENV;
process.env.ASAAS_ENABLED = 'true';
process.env.ASAAS_PRODUCTION_ENABLED = 'true';

import { beforeEach, describe, expect, it } from 'vitest';

import { resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import {
  getAsaasApiKey,
  upsertAsaasApiKey,
} from '../src/services/integrations/AsaasCredentialService.js';

let precoJusto: string;
let gringa: string;

beforeEach(() => {
  resetDbForTests();
  ensureCoreSchema();
  precoJusto = upsertCompany({
    slug: 'preco-justo',
    legalName: 'Preço Justo Ltda',
    tradeName: 'Preço Justo',
  });
  gringa = upsertCompany({ slug: 'gringa', legalName: 'Gringa Ltda', tradeName: 'Gringa' });
});

// ============================================================================

describe('cada operação cobra na própria conta', () => {
  it('a chave do cofre é a da empresa, e não a da vizinha', () => {
    upsertAsaasApiKey({
      companyId: precoJusto,
      environment: 'production',
      apiKey: '$aact_chave_do_preco_justo',
    });
    upsertAsaasApiKey({
      companyId: gringa,
      environment: 'production',
      apiKey: '$aact_chave_da_gringa',
    });

    expect(getAsaasApiKey(precoJusto, 'production')).toBe('$aact_chave_do_preco_justo');
    expect(getAsaasApiKey(gringa, 'production')).toBe('$aact_chave_da_gringa');
  });

  it('sandbox e produção são credenciais diferentes, e não se misturam', () => {
    upsertAsaasApiKey({
      companyId: precoJusto,
      environment: 'sandbox',
      apiKey: '$aact_sandbox_do_preco_justo',
    });
    upsertAsaasApiKey({
      companyId: precoJusto,
      environment: 'production',
      apiKey: '$aact_producao_do_preco_justo',
    });

    expect(getAsaasApiKey(precoJusto, 'sandbox')).toBe('$aact_sandbox_do_preco_justo');
    expect(getAsaasApiKey(precoJusto, 'production')).toBe('$aact_producao_do_preco_justo');
  });
});

// ============================================================================

describe('a chave do ambiente não vira conta de produção de ninguém', () => {
  it('sem credencial própria, a operação NÃO cobra em produção', () => {
    /*
      Este é o defeito, no estado exato em que o projeto está: a chave de
      produção do Preço Justo no `.env`, o processo ainda fora de
      'production', e a Gringa sem credencial no cofre. A cobrança da Gringa
      saía na conta do Preço Justo.
    */
    expect(getAsaasApiKey(gringa, 'production')).toBeNull();
  });

  it('nem a empresa dona da chave do ambiente — o cofre é a única fonte de produção', () => {
    /*
      Sem exceção para "a primeira empresa": não há como o código saber de quem
      é a chave do `.env`. Tratar a empresa ativa como dona seria adivinhar, e o
      erro dessa adivinhação é dinheiro na conta errada.
    */
    expect(getAsaasApiKey(precoJusto, 'production')).toBeNull();
  });

  it('com credencial própria no cofre, cobra normalmente', () => {
    upsertAsaasApiKey({
      companyId: gringa,
      environment: 'production',
      apiKey: '$aact_chave_da_gringa',
    });
    expect(getAsaasApiKey(gringa, 'production')).toBe('$aact_chave_da_gringa');
  });

  it('em SANDBOX o fallback continua valendo — é ali que se desenvolve', () => {
    expect(getAsaasApiKey(gringa, 'sandbox')).toBe(CHAVE_DO_ENV);
  });

  it('e a credencial de sandbox no cofre ganha do ambiente', () => {
    upsertAsaasApiKey({
      companyId: gringa,
      environment: 'sandbox',
      apiKey: '$aact_sandbox_da_gringa',
    });
    expect(getAsaasApiKey(gringa, 'sandbox')).toBe('$aact_sandbox_da_gringa');
  });
});
