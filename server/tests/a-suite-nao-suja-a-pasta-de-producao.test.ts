/**
 * ============================================================================
 * TESTE QUE ESCREVE NA PASTA DE PRODUÇÃO É BANCO TEMPORÁRIO VAZADO, DO OUTRO LADO
 * ============================================================================
 *
 * O banco desta suíte é descartável: cada worker tem o seu, em pasta
 * temporária, apagada no fim. Os ARQUIVOS não seguiam a mesma regra.
 *
 * `WorkshopPhotoService` já tinha percebido e consertado — o comentário lá
 * conta que cada rodada deixava 21 imagens de 1x1 órfãs em
 * `server/data/uploads/os`, órfãs porque o banco que as conhecia era jogado
 * fora no fim do teste. A saída foi `DEVORA_UPLOADS_DIR`.
 *
 * Só que o conserto ficou pela metade em dois sentidos: as outras duas pastas
 * de upload não olham a variável, e o `setup.ts` global não a define — apenas
 * um arquivo de teste a definia, para si.
 *
 * ## O que isso produziu, medido em 27/08/2026
 *
 *     data/uploads/lojas   458 arquivos
 *                          TODOS com exatamente 70 bytes — o PNG 1x1 do teste
 *                          ZERO referências no banco inteiro
 *
 * Por dia de criação: 17 no dia 23, 81 no 24, 105 no 25, 186 no 26, 69 no 27.
 * A curva é a das rodadas da suíte, não a de alguém trocando o logo da loja.
 *
 * Não é só sujeira. Era o que a primeira cópia remota dos uploads levaria para
 * o bucket, e ficaria lá para sempre — 458 arquivos de teste travestidos de
 * dado de negócio, num armazenamento pago, aumentando toda semana.
 *
 * ## O que este arquivo trava
 *
 * Que as TRÊS pastas de upload obedeçam ao redirecionamento, e que a suíte o
 * defina para todo mundo. Um serviço novo que escreva arquivo sem olhar a
 * variável fica vermelho aqui — e não seis meses depois, contando arquivos.
 */
process.env.TZ = 'UTC';
process.env.DEVORA_API_ENV = 'test';

import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';

const { uploadsDir } = await import('../src/services/core/ProductImageService.js');
const { storeUploadsDir } = await import('../src/services/core/StorefrontSettingsService.js');
const { photosDir } = await import('../src/services/core/WorkshopPhotoService.js');

/** Todo lugar onde o servidor grava arquivo enviado por gente. */
const PASTAS = [
  { nome: 'fotos de produto', dir: uploadsDir, folha: 'produtos' },
  { nome: 'logo e capa da loja', dir: storeUploadsDir, folha: 'lojas' },
  { nome: 'fotos da OS', dir: photosDir, folha: 'os' },
];

// ============================================================================

describe('nenhuma pasta de upload aponta para a de produção durante o teste', () => {
  for (const { nome, dir, folha } of PASTAS) {
    it(`${nome} obedece a DEVORA_UPLOADS_DIR`, () => {
      /*
        `setup.ts` já aponta a variável para a pasta temporária deste worker.
        Se este caso falhar, arquivos deste teste estão indo para a pasta real.
      */
      const redirecionada = process.env.DEVORA_UPLOADS_DIR;
      expect(
        redirecionada,
        'o setup da suíte precisa redirecionar os uploads, como já faz com o banco',
      ).toBeTruthy();

      expect(
        dir(),
        `${nome}: está gravando fora da pasta temporária do worker`,
      ).toBe(resolve(redirecionada as string, folha));
    });
  }

  it('e a pasta temporária não é a do repositório', () => {
    // O caso que impede a variável de ser apontada para o lugar errado e o
    // teste acima passar sem proteger nada.
    const redirecionada = resolve(process.env.DEVORA_UPLOADS_DIR as string);
    expect(redirecionada).not.toContain('Grupo Sampaio\\data');
    expect(redirecionada).not.toContain('Grupo Sampaio/data');
    expect(redirecionada).not.toContain('Grupo Sampaio\\server\\data');
    expect(redirecionada).not.toContain('Grupo Sampaio/server/data');
  });

  it('as três pastas são distintas entre si', () => {
    // Uma folha repetida faria foto de produto e logo de loja se sobrescreverem.
    const caminhos = PASTAS.map((p) => p.dir());
    expect(new Set(caminhos).size).toBe(caminhos.length);
  });
});

// ============================================================================

describe('sem a variável, cada pasta volta ao seu lugar de sempre', () => {
  /*
    O redirecionamento não pode MUDAR o destino de produção. Os arquivos que já
    estão no disco moram nos caminhos históricos, e uma mudança de padrão faria
    todos eles darem 404 de uma vez.
  */
  it('cada padrão continua sendo o histórico', () => {
    const anterior = process.env.DEVORA_UPLOADS_DIR;
    delete process.env.DEVORA_UPLOADS_DIR;
    try {
      // `produtos` e `os` sob `server/data`; `lojas` na raiz do repositório —
      // a diferença é acidente histórico, e mexer nela agora quebraria os links
      // já gravados no banco.
      expect(uploadsDir().replace(/\\/g, '/')).toMatch(/server\/data\/uploads\/produtos$/);
      expect(photosDir().replace(/\\/g, '/')).toMatch(/server\/data\/uploads\/os$/);
      expect(storeUploadsDir().replace(/\\/g, '/')).toMatch(/\/data\/uploads\/lojas$/);
      expect(storeUploadsDir().replace(/\\/g, '/')).not.toMatch(/server\/data\/uploads\/lojas$/);
    } finally {
      if (anterior === undefined) delete process.env.DEVORA_UPLOADS_DIR;
      else process.env.DEVORA_UPLOADS_DIR = anterior;
    }
  });
});
