/**
 * ============================================================================
 * UM SEGREDO ESQUECIDO NUMA ROTAÇÃO É UM SEGREDO PERDIDO
 * ============================================================================
 *
 * A rotação da chave reescreve o que está na lista de `LUGARES`. O que não
 * está nela não é reescrito — e, depois de a chave velha ser descartada, não
 * abre nunca mais. Não há segunda cópia do `.pfx`, da chave do Asaas nem da
 * senha da caixa de e-mail.
 *
 * O risco não é hipotético: o cofre tem SEIS serviços consumidores hoje, cada
 * um guardando num lugar diferente, e foi essa dispersão que fez a rotação
 * precisar de uma lista escrita à mão. Um sétimo consumidor entra no sistema
 * pela porta mais natural do mundo — alguém precisa guardar uma credencial
 * nova — e não há nada, fora este arquivo, que ligue esse gesto à lista.
 *
 * ## Como este guarda funciona
 *
 * Ele lê quem CHAMA `encryptFiscalSecret` no código-fonte e compara com os
 * serviços que a lista declara. Sobrou consumidor? Vermelho, com o nome do
 * arquivo. É a mesma forma dos outros guardas por leitura deste projeto: a
 * declaração e a realidade têm de dizer a mesma coisa.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(AQUI, '../src');

const { LUGARES } = await import('../src/db/secretsInventory.js');

/** Todo arquivo `.ts` sob `src`, menos o próprio cofre. */
function arquivos(dir: string): string[] {
  const achados: string[] = [];
  for (const nome of readdirSync(dir)) {
    const caminho = join(dir, nome);
    if (statSync(caminho).isDirectory()) {
      achados.push(...arquivos(caminho));
      continue;
    }
    if (nome.endsWith('.ts')) achados.push(caminho);
  }
  return achados;
}

/**
 * Quem SELA um segredo — não quem apenas abre.
 *
 * Quem só decifra não cria conteúdo novo, e por isso não pode criar um lugar
 * que a rotação desconheça. O que importa é quem escreve.
 */
function seladores(): string[] {
  const nomes: string[] = [];
  for (const caminho of arquivos(SRC)) {
    if (caminho.includes('FiscalSecretVault')) continue;
    // A ferramenta de rotação e o inventário selam por ofício.
    if (caminho.includes('secretsInventory') || caminho.includes('rotateEncryptionKey')) continue;
    const texto = readFileSync(caminho, 'utf8');
    if (!/\bencryptFiscalSecret\s*\(|\bencryptWithKey\s*\(/.test(texto)) continue;
    const arquivo = caminho.split(/[\\/]/).pop() as string;
    nomes.push(arquivo.replace(/\.ts$/, ''));
  }
  return [...new Set(nomes)].sort();
}

// ============================================================================

describe('todo quem sela está na lista da rotação', () => {
  it('a leitura enxerga o código — senão ficaria verde varrendo nada', () => {
    expect(arquivos(SRC).length).toBeGreaterThan(100);
    expect(seladores().length).toBeGreaterThan(3);
  });

  it('nenhum serviço sela num lugar que a rotação desconhece', () => {
    const declarados = new Set(LUGARES.map((l) => l.servico));
    const esquecidos = seladores().filter((s) => !declarados.has(s));

    expect(
      esquecidos,
      'serviço novo selando segredo: acrescente o lugar dele em `LUGARES`, '
        + 'senão a próxima rotação de chave o deixa ilegível para sempre',
    ).toEqual([]);
  });

  it('e a lista não declara lugar de serviço que não existe mais', () => {
    /*
      O contrário também importa: um lugar órfão faria a rotação varrer uma
      coleção morta e o relatório contar segredos que ninguém usa — ruído que
      esconde o que interessa.
    */
    const vivos = new Set(seladores());
    const orfaos = [...new Set(LUGARES.map((l) => l.servico))].filter((s) => !vivos.has(s));
    expect(orfaos, 'lugar declarado para serviço que não sela mais nada').toEqual([]);
  });

  it('cada lugar diz COMO se chega ao texto cifrado', () => {
    for (const l of LUGARES) {
      if (l.forma === 'json') {
        expect(l.campo, `${l.tipo}: coleção JSON sem campo declarado`).toBeTruthy();
      } else {
        expect(l.coluna, `${l.tipo}: tabela sem coluna declarada`).toBeTruthy();
      }
    }
  });

  it('não há dois lugares com o mesmo tipo no mesmo store', () => {
    // Duplicata faria a rotação reescrever o mesmo segredo duas vezes e o
    // relatório contá-lo duas vezes.
    const chaves = LUGARES.map((l) => `${l.store}:${l.tipo}`);
    expect(new Set(chaves).size).toBe(chaves.length);
  });
});
