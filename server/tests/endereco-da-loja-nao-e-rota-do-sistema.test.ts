/**
 * O ENDEREÇO DA LOJA NÃO É ROTA DO SISTEMA.
 *
 * O slug da empresa vira o endereço da loja (`/:storeSlug` no roteador das
 * telas), e o roteador ranqueia caminho fixo acima do dinâmico. Uma empresa
 * nova chamada "PDV" ou "Loja" nasceria com /pdv ou /loja e a página dela nunca
 * abriria. `SLUGS_RESERVADOS` (IdentityService) tira esses nomes do gerador de
 * slug; este teste confere a lista contra o roteador, para rota nova de um
 * segmento não nascer sem reserva.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SLUGS_RESERVADOS } from '../src/services/auth/IdentityService.js';

const ROTEADOR = resolve(__dirname, '..', '..', 'src', 'router', 'gsRoutes.tsx');

/** Os caminhos FIXOS de um segmento só (/pdv, /login...), lidos do roteador. */
function rotasDeUmSegmento(): string[] {
  const fonte = readFileSync(ROTEADOR, 'utf8');
  const achadas = [...fonte.matchAll(/(?:path:\s*|protectedRoute\(\s*)'\/([a-z0-9-]+)'/g)].map((m) => m[1]!);
  return [...new Set(achadas)].sort();
}

describe('o endereço da loja não é rota do sistema', () => {
  it('a leitura do roteador acha as rotas — senão ficaria verde lendo nada', () => {
    const rotas = rotasDeUmSegmento();
    expect(rotas).toEqual(expect.arrayContaining(['login', 'pdv', 'sistema', 'loja']));
  });

  it('toda rota fixa de um segmento é um slug reservado', () => {
    const semReserva = rotasDeUmSegmento().filter((r) => !SLUGS_RESERVADOS.has(r));
    expect(semReserva).toEqual([]);
  });

  it('e os prefixos da API e do pacote também (mesma origem quando a API serve as telas)', () => {
    for (const prefixo of ['api', 'uploads', 'assets']) expect(SLUGS_RESERVADOS.has(prefixo), prefixo).toBe(true);
  });
});
