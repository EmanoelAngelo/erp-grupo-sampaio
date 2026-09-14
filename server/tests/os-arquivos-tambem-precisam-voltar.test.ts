/**
 * ============================================================================
 * O BACKUP COPIAVA O BANCO E SÓ ELE
 * ============================================================================
 *
 * O `.db` sobe todo dia para o bucket, é conferido e restaura. As imagens
 * enviadas pelo usuário — logo e capa de cada loja, foto de produto, foto de
 * OS — não entram em cópia nenhuma, local ou remota. E não estão no git,
 * corretamente: são dado, não código.
 *
 * Quer dizer que hoje, se o disco morrer, o banco volta do bucket com todos os
 * links de imagem apontando para arquivos que não existem mais em lugar
 * nenhum. O sistema volta parecendo inteiro e com a vitrine sem foto.
 *
 * ## O desenho
 *
 * Um PACOTE por vez, com MANIFESTO separado.
 *
 * O manifesto sobe como objeto próprio para poder ser lido sem baixar o pacote
 * inteiro: é ele que responde "o que tem lá dentro e quanto pesa" quando
 * alguém está decidindo se restaura.
 *
 * Cada arquivo carrega caminho relativo, tamanho, data e sha256. O sha256 é o
 * que transforma "baixou" em "voltou igual" — sem ele, um pacote truncado
 * restaura em silêncio e o defeito aparece na tela do cliente.
 *
 * ## O que este arquivo trava
 *
 *  - o manifesto descreve o que existe, com hash;
 *  - o pacote fecha e abre devolvendo byte por byte;
 *  - o caminho relativo é preservado, com a pasta de origem;
 *  - nada de segredo entra no nome nem no manifesto;
 *  - sobrescrever objeto que já existe é ERRO, não silêncio;
 *  - a restauração recusa pacote adulterado.
 */
process.env.TZ = 'UTC';
process.env.DEVORA_API_ENV = 'test';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const {
  coletarUploads,
  montarManifesto,
  montarPacote,
  abrirPacote,
  restaurarUploadsEm,
  LIMITE_DO_PACOTE_BYTES,
} = await import('../src/db/backupUploads.js');

let raiz: string;
let anterior: string | undefined;

/** Bytes reconhecíveis, para o teste poder comparar sem adivinhar. */
function bytesDe(semente: string, tamanho: number): Buffer {
  const b = Buffer.alloc(tamanho);
  for (let i = 0; i < tamanho; i += 1) b[i] = (semente.charCodeAt(i % semente.length) + i) % 256;
  return b;
}

beforeEach(() => {
  anterior = process.env.DEVORA_UPLOADS_DIR;
  raiz = mkdtempSync(join(tmpdir(), 'gs-uploads-'));
  process.env.DEVORA_UPLOADS_DIR = raiz;
  for (const folha of ['lojas', 'produtos', 'os']) {
    mkdirSync(join(raiz, folha), { recursive: true });
  }
});

afterEach(() => {
  if (anterior === undefined) delete process.env.DEVORA_UPLOADS_DIR;
  else process.env.DEVORA_UPLOADS_DIR = anterior;
  rmSync(raiz, { recursive: true, force: true });
});

function semear(): void {
  writeFileSync(join(raiz, 'lojas', 'logo-gringa.png'), bytesDe('logo', 1200));
  writeFileSync(join(raiz, 'lojas', 'capa-conceito.webp'), bytesDe('capa', 800));
  writeFileSync(join(raiz, 'produtos', 'camisa.png'), bytesDe('camisa', 2400));
  writeFileSync(join(raiz, 'os', 'antes.jpg'), bytesDe('antes', 640));
}

// ============================================================================

describe('o manifesto descreve o que existe', () => {
  it('acha os arquivos das três pastas, com o caminho relativo', () => {
    semear();
    const m = montarManifesto();

    expect(m.totalArquivos).toBe(4);
    expect(m.arquivos.map((a) => a.caminho).sort()).toEqual([
      'lojas/capa-conceito.webp',
      'lojas/logo-gringa.png',
      'os/antes.jpg',
      'produtos/camisa.png',
    ]);
  });

  it('cada arquivo carrega tamanho, data e sha256', () => {
    semear();
    const m = montarManifesto();
    const logo = m.arquivos.find((a) => a.caminho === 'lojas/logo-gringa.png');

    expect(logo?.bytes).toBe(1200);
    expect(logo?.sha256).toBe(createHash('sha256').update(bytesDe('logo', 1200)).digest('hex'));
    expect(logo?.modificadoEm).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('o total de bytes é a soma, e não uma estimativa', () => {
    semear();
    const m = montarManifesto();
    expect(m.totalBytes).toBe(1200 + 800 + 2400 + 640);
  });

  it('pasta vazia dá manifesto vazio — e isso não é erro', () => {
    const m = montarManifesto();
    expect(m.totalArquivos).toBe(0);
    expect(m.arquivos).toEqual([]);
  });

  it('o manifesto NÃO carrega o conteúdo dos arquivos', () => {
    // Ele é lido para decidir se vale baixar o pacote. Se trouxesse o conteúdo,
    // não haveria o que decidir.
    semear();
    const texto = JSON.stringify(montarManifesto());
    expect(texto).not.toContain(bytesDe('logo', 1200).toString('base64').slice(0, 40));
  });

  it('subpasta é percorrida, e o caminho relativo a preserva', () => {
    semear();
    mkdirSync(join(raiz, 'lojas', 'arquivadas'), { recursive: true });
    writeFileSync(join(raiz, 'lojas', 'arquivadas', 'antiga.png'), bytesDe('antiga', 100));

    const m = montarManifesto();
    expect(m.arquivos.map((a) => a.caminho)).toContain('lojas/arquivadas/antiga.png');
  });
});

// ============================================================================

describe('o pacote fecha e abre', () => {
  it('devolve byte por byte o que entrou', () => {
    semear();
    const m = montarManifesto();
    const { conteudo } = abrirPacote(montarPacote(m));

    expect(Object.keys(conteudo).sort()).toEqual(m.arquivos.map((a) => a.caminho).sort());
    expect(Buffer.from(conteudo['produtos/camisa.png'], 'base64')).toEqual(bytesDe('camisa', 2400));
  });

  it('o manifesto vem junto, e bate com o que foi empacotado', () => {
    semear();
    const aberto = abrirPacote(montarPacote(montarManifesto()));
    expect(aberto.manifesto.totalArquivos).toBe(4);
  });

  it('pacote adulterado é RECUSADO, não restaurado pela metade', () => {
    /*
      É o caso que dá sentido ao sha256. Sem ele, um pacote truncado no
      caminho restaura em silêncio e o defeito aparece na tela do cliente,
      semanas depois, como "a foto sumiu".
    */
    semear();
    const pacote = montarPacote(montarManifesto());
    const estragado = Buffer.from(pacote);
    // Mexe num byte do meio da parte comprimida.
    estragado[Math.floor(estragado.length / 2)] ^= 0xff;

    expect(() => abrirPacote(estragado)).toThrow();
  });

  it('conteúdo que não bate com o hash do manifesto é recusado na restauração', () => {
    semear();
    const m = montarManifesto();
    const aberto = abrirPacote(montarPacote(m));
    // Troca o conteúdo de um arquivo mantendo o manifesto.
    aberto.conteudo['produtos/camisa.png'] = Buffer.from('outra coisa').toString('base64');

    const destino = mkdtempSync(join(tmpdir(), 'gs-restore-uploads-'));
    try {
      expect(() => restaurarUploadsEm(destino, aberto)).toThrow(/camisa/);
    } finally {
      rmSync(destino, { recursive: true, force: true });
    }
  });

  it('acima do limite, o empacotamento RECUSA em vez de estourar a memória', () => {
    // O pacote inteiro passa pela memória. Um limite dito é melhor que um
    // processo morto sem explicação no meio da janela de manutenção.
    expect(LIMITE_DO_PACOTE_BYTES).toBeGreaterThan(0);
    const gigante = {
      versao: 1 as const,
      criadoEm: new Date().toISOString(),
      totalArquivos: 1,
      totalBytes: LIMITE_DO_PACOTE_BYTES + 1,
      arquivos: [{ caminho: 'lojas/x.png', bytes: LIMITE_DO_PACOTE_BYTES + 1, sha256: 'x', modificadoEm: '' }],
    };
    expect(() => montarPacote(gigante)).toThrow(/limite/i);
  });
});

// ============================================================================

describe('a restauração devolve a estrutura', () => {
  it('recria as pastas e os arquivos, com o caminho preservado', () => {
    semear();
    const aberto = abrirPacote(montarPacote(montarManifesto()));
    const destino = mkdtempSync(join(tmpdir(), 'gs-restore-uploads-'));
    try {
      const r = restaurarUploadsEm(destino, aberto);

      expect(r.arquivos).toBe(4);
      expect(readdirSync(destino).sort()).toEqual(['lojas', 'os', 'produtos']);
      expect(readFileSync(join(destino, 'lojas', 'logo-gringa.png'))).toEqual(bytesDe('logo', 1200));
      expect(readFileSync(join(destino, 'os', 'antes.jpg'))).toEqual(bytesDe('antes', 640));
    } finally {
      rmSync(destino, { recursive: true, force: true });
    }
  });

  it('NUNCA escreve fora do destino, mesmo com caminho malicioso no pacote', () => {
    /*
      O pacote pode vir de um bucket. Um caminho com `..` escreveria fora do
      destino — e num restore rodado como serviço, isso é escrita em qualquer
      lugar do disco.
    */
    const destino = mkdtempSync(join(tmpdir(), 'gs-restore-uploads-'));
    try {
      const forjado = {
        manifesto: {
          versao: 1 as const,
          criadoEm: new Date().toISOString(),
          totalArquivos: 1,
          totalBytes: 3,
          arquivos: [
            {
              caminho: '../fora.png',
              bytes: 3,
              sha256: createHash('sha256').update(Buffer.from('mal')).digest('hex'),
              modificadoEm: new Date().toISOString(),
            },
          ],
        },
        conteudo: { '../fora.png': Buffer.from('mal').toString('base64') },
      };
      expect(() => restaurarUploadsEm(destino, forjado)).toThrow(/caminho/i);
    } finally {
      rmSync(destino, { recursive: true, force: true });
    }
  });
});

// ============================================================================

/*
  O ENVIO mudou de forma (GAP-PRD-058): o diário não monta mais pacote — manda
  as fotos uma a uma, endereçadas pelo sha256, com manifesto versão 2. As
  garantias que moravam aqui (nunca pedir x-upsert, prefixo uploads/ separado
  do banco, nenhum segredo no nome nem no manifesto, sem configuração não finge
  que enviou, sem arquivo não sobe nada) passaram a ser cobradas sobre o envio
  novo em o-diario-nao-para-o-balcao.test.ts. Este arquivo continua cobrando o
  FORMATO do pacote versão 1, que a restauração ainda lê.
*/

// ============================================================================

describe('o que NÃO entra no pacote', () => {
  it('cache, build e temporários não são varridos', () => {
    /*
      A varredura é por PASTA DECLARADA, não por vasculhar o disco. Este caso
      trava a declaração: um `node_modules` dentro da raiz de uploads não pode
      virar backup.
    */
    semear();
    mkdirSync(join(raiz, 'node_modules', 'coisa'), { recursive: true });
    writeFileSync(join(raiz, 'node_modules', 'coisa', 'index.js'), 'nao-e-dado');
    mkdirSync(join(raiz, '.cache'), { recursive: true });
    writeFileSync(join(raiz, '.cache', 'x.tmp'), 'nao-e-dado');

    const caminhos = coletarUploads().map((a) => a.caminho);
    expect(caminhos.some((c) => c.includes('node_modules'))).toBe(false);
    expect(caminhos.some((c) => c.includes('.cache'))).toBe(false);
    expect(caminhos).toHaveLength(4);
  });
});
