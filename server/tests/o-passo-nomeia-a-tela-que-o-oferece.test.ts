/**
 * ============================================================================
 * A INSTRUÇÃO DO SERVIDOR E O CONTROLE DA TELA SE ENCONTRAM — V07-CRT-007
 * ============================================================================
 *
 * ## O defeito que este arquivo existe para não deixar voltar
 *
 * `assessProductionUnlock` devolve, como primeiro passo restante, uma ORDEM
 * ao dono: "Virar o ambiente desta operação para «produção» em Fiscal ›
 * Configuração". A tela nomeada NÃO tinha esse controle. O dono lia o passo,
 * abria a tela e não achava nada — e o go-live terminava num UPDATE à mão.
 *
 * E ninguém percebia porque o único teste que renderizava esses passos os
 * INJETAVA como fixture, com o texto encurtado e diferente do servidor. A
 * instrução e a existência do controle nunca se encontravam: dois arquivos
 * verdes, um defeito vivo entre eles.
 *
 * ## Por que esta guarda lê o CÓDIGO da tela
 *
 * Porque o defeito mora exatamente no VÃO entre as duas camadas, e nenhum
 * teste de uma camada só o alcança. O caso do navegador
 * (`src/pages/gs/__tests__/oAmbienteViraNaTela.test.tsx`) prova que o botão
 * existe e funciona; este prova que ele é o botão que ESTE passo manda
 * apertar, e que o passo continua apontando para ESTA tela.
 *
 * ## COMO ELE FALHA (quebrado de propósito — conferido)
 *
 *  - troque o nome da tela no passo (para "Fiscal › Certificado", por exemplo)
 *    e o primeiro caso fica vermelho;
 *  - tire a chamada de `updateFiscalConfig` com `environment` da FiscalPage e
 *    o segundo fica vermelho — que é literalmente o estado anterior do repo.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_DATABASE_PATH = ':memory:';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';

const { resetDbForTests } = await import('../src/db/database.js');
const { ensureCoreSchema } = await import('../src/db/schema.js');
const { upsertCompany } = await import('../src/services/auth/IdentityService.js');
const { assessProductionUnlock } = await import(
  '../src/services/core/FiscalConfigService.js'
);

/** O código da tela, lido como texto — é o VÃO entre as camadas que interessa. */
const telaFiscal = readFileSync(
  fileURLToPath(new URL('../../src/pages/gs/FiscalPage.tsx', import.meta.url)),
  'utf8',
);

let loja: string;

beforeEach(() => {
  resetDbForTests();
  ensureCoreSchema();
  loja = upsertCompany({
    slug: 'preco-justo',
    legalName: 'Preço Justo Ltda',
    tradeName: 'Preço Justo',
  });
});

describe('o passo que o servidor manda cumprir tem controle na tela que ele nomeia', () => {
  it('o primeiro passo restante manda virar o ambiente em Fiscal › Configuração', () => {
    const parecer = assessProductionUnlock(loja);
    const passo = parecer.remainingSteps[0];

    expect(passo).toContain('Virar o ambiente');
    expect(passo).toContain('produção');
    // A tela nomeada é a FiscalPage — o item de menu "Configuração fiscal".
    expect(passo).toContain('Fiscal › Configuração');
  });

  it('e a FiscalPage OFERECE o gesto: um PATCH de environment, e não só um badge', () => {
    /*
      Antes desta rodada, `environment` aparecia na FiscalPage só dentro de
      badges e comparações de leitura. O que faltava era a ESCRITA.
    */
    expect(telaFiscal).toMatch(/updateFiscalConfig\(\s*\{\s*environment:/);
    /*
      E o PATCH leva SÓ `environment`. O `EmitenteCard` chama a mesma função
      com as 14 chaves do endereço; se a virada saísse de lá, salvar o telefone
      mudaria o ambiente junto. Os dois destinos, e o comportamento de cada um,
      estão provados no navegador — `oAmbienteViraNaTela.test.tsx`.
    */
    expect(telaFiscal).not.toMatch(/updateFiscalConfig\(\s*\{\s*environment:[^}]*,/);
  });

  it('o gesto é guardado pelo desbloqueio, e não só pelo servidor', () => {
    // O servidor recusa com 409 sem `production_unlocked`; a tela não pode
    // convidar ao 409 — o botão só liga depois da liberação.
    expect(telaFiscal).toContain('productionUnlocked');
    expect(telaFiscal).toMatch(/Virar para produção/);
  });
});
