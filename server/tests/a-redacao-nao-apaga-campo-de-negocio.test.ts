/**
 * A REDAÇÃO DO PAYLOAD TIRA SEGREDO, E SÓ SEGREDO (GAP-PRD-138).
 *
 * `redigirPayload` comparava o NOME do campo por SUBSTRING contra a lista de
 * proibidos. `pan` (o número do cartão) está dentro de `company`, `expansion`,
 * `panel` e `span`; `token` está dentro de `tokens_total`; `secret` está
 * dentro de `secretaria`. Resultado medido pela auditoria: `company_id`,
 * `company_name`, `expansion`, `panel`, `span_days` e `tokens_total` sumiam do
 * evento a caminho da central, sem erro nenhum — e qualquer campo de negócio
 * novo com esses pedaços no nome nunca chegaria ao consolidado.
 *
 * A regra passa a ser por PALAVRA do nome (snake_case, camelCase, kebab),
 * não por pedaço de palavra: `card_pan`, `webhook_token` e `apiKey` continuam
 * saindo; `company_name` e `panel` continuam indo.
 */
import { describe, expect, it } from 'vitest';
import { campoProibido, redigirPayload } from '../src/services/sync/OutboxService.js';

describe('o que é de negócio chega à central', () => {
  const DE_NEGOCIO = [
    'company_id',
    'companyId',
    'company_name',
    'companyName',
    'expansion',
    'panel',
    'span_days',
    'spanDays',
    'tokens_total',
    'secretaria_id',
    'hashtag',
    'descricao',
    'xmlns_versao',
    'panorama',
    'tokenizer_version',
  ];

  for (const campo of DE_NEGOCIO) {
    it(`"${campo}" não é segredo`, () => {
      expect(campoProibido(campo)).toBe(false);
      const limpo = redigirPayload({ [campo]: 'valor', aninhado: [{ [campo]: 1 }] }) as Record<string, unknown>;
      expect(limpo[campo]).toBe('valor');
      expect((limpo.aninhado as Record<string, unknown>[])[0][campo]).toBe(1);
    });
  }

  it('o payload de uma venda chega inteiro — empresa, nome da empresa e prazo', () => {
    const venda = {
      id: 'v-1',
      company_id: 'gringa',
      company_name: 'Gringa Motos',
      span_days: 30,
      panel: 'balcao',
      total_cents: 189_900,
    };
    expect(redigirPayload(venda)).toEqual(venda);
  });
});

describe('o que é segredo continua não saindo', () => {
  const SEGREDOS = [
    'password',
    'password_hash',
    'passwordHash',
    'senha',
    'senhaHash',
    'pin_hash',
    'hash',
    'secret',
    'clientSecret',
    'client_secrets',
    'token',
    'accessToken',
    'refresh_token',
    'refreshTokens',
    'webhook_token',
    'api_key',
    'apiKey',
    'API_KEY',
    'api_key_encrypted',
    'apikey',
    'private_key',
    'privateKey',
    'certificate',
    'certificate_pem',
    'pfx',
    'pfx_base64',
    'pfxBase64',
    'encryptedPfx',
    'csc',
    'csc_token',
    'cscToken',
    'xml',
    'xml_assinado',
    'XMLAssinado',
    'card_number',
    'cardNumber',
    'pan',
    'PAN',
    'card_pan',
    'cardPan',
    'cvv',
    'encryptedPassword',
    'encrypted_value',
  ];

  for (const campo of SEGREDOS) {
    it(`"${campo}" é removido`, () => {
      expect(campoProibido(campo)).toBe(true);
      const limpo = redigirPayload({ ok: 1, [campo]: 'SEGREDO-QUE-NAO-SAI', lista: [{ [campo]: 'x' }] });
      expect(JSON.stringify(limpo)).not.toContain('SEGREDO-QUE-NAO-SAI');
      expect((limpo as { lista: Record<string, unknown>[] }).lista[0]).toEqual({});
    });
  }
});
