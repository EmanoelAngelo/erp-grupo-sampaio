/**
 * ============================================================================
 * T2 — A VARREDURA DINÂMICA: cada modelo de sistema × cada rota guardada, PELO HTTP
 * ============================================================================
 *
 * T0/T1 provam, lendo o código, que o guarda de cada rota alcança os perfis da
 * linha de base. Não provam que o SERVIDOR EM EXECUÇÃO faz o que o código diz:
 * a F1 do RBAC granular mexe exatamente no caminho que toda requisição
 * atravessa — a conferência da sessão passa a carregar o acesso efetivo, a
 * empresa desativada derruba a sessão, a senha provisória é relida do banco,
 * e `requirePermission` vira tradutor para capability. Um erro ali muda o
 * acesso de centenas de rotas de uma vez, e só uma varredura pelo HTTP pega.
 *
 * O desenho é o de `contador-varredura-das-rotas.test.ts`, estendido aos onze
 * modelos e aos oito roteadores:
 *
 *   - login Argon2id de verdade (`loginForTest`), um arquivo por modelo, para
 *     o paralelismo do vitest;
 *   - a lista de rotas é a linha de base (que o T0 amarra ao código por AST):
 *     rota nova sem linha de base derruba o T0, não passa por aqui calada;
 *   - método certo por rota, sem corpo, parâmetro de caminho inventado (o
 *     guarda roda antes da busca); `:companyId` recebe a própria empresa, para
 *     que a recusa medida seja a do guarda e não a do tenant;
 *   - NEGADO é 403 com `API_PERMISSION_DENIED` — o código dos guardas. Qualquer
 *     outro status (200, 400, 404, 409, 422, 5xx) é "o guarda deixou passar";
 *   - a app é refeita a cada lote, abaixo do teto de 300/min do limitador;
 *   - a rede é desligada (`fetch` recusa): a rota que atravessa o guarda com
 *     o corpo vazio não chama provedor nenhum de verdade.
 *
 * A única tolerância é a D1 (o legado `operador_caixa` nas duas rotas de
 * impressão), que a F2 vira: os dois resultados são aceitos ali.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../../src/app.js';
import { resetDbForTests } from '../../../src/db/database.js';
import { loginForTest } from '../../helpers/auth.js';

const AQUI = dirname(fileURLToPath(import.meta.url));

interface RotaDaBase {
  perfis: string[] | 'PUBLICA';
  capability: string;
  mudanca: string | null;
}
const linhaDeBase = JSON.parse(readFileSync(join(AQUI, '..', 'linha-de-base.json'), 'utf8')) as {
  rotas: Record<string, RotaDaBase>;
};

const TAMANHO_DO_LOTE = 200;
const EMPRESA = 'varredura-rbac';
const VALOR_PADRAO = 'varredura-rbac-x';

type Metodo = 'get' | 'post' | 'put' | 'patch' | 'delete';

interface Medida {
  chave: string;
  status: number;
  codigo: string | undefined;
}

/** As rotas que esta varredura bate: as guardadas por alcance (sem as públicas e as "só autenticada"). */
function rotasVarridas(): { chave: string; metodo: Metodo; url: string; base: RotaDaBase }[] {
  return Object.entries(linhaDeBase.rotas)
    .filter(([, r]) => r.perfis !== 'PUBLICA' && r.capability !== 'SO_AUTENTICADO')
    .map(([chave, base]) => {
      const [metodo, caminho] = chave.split(' ') as [string, string];
      const url = '/api/v1' + caminho.replace(/:([A-Za-z0-9_]+)/g, (_, nome: string) => (nome === 'companyId' ? EMPRESA : VALOR_PADRAO));
      return { chave, metodo: metodo.toLowerCase() as Metodo, url, base };
    });
}

export function varrerComo(modelo: string): void {
  describe(`T2 — ${modelo} × as rotas guardadas, pelo HTTP`, () => {
    const medidas: Medida[] = [];
    const sessoesPerdidas: string[] = [];
    const rotas = rotasVarridas();

    beforeAll(async () => {
      vi.stubGlobal('fetch', vi.fn(async () => {
        throw new Error('varredura do RBAC: a rede está desligada');
      }));
      resetDbForTests();
      let app: Express = createApp();
      const entrar = async () => {
        const login = await loginForTest(app, { userId: `varredura-${modelo}`, companyId: EMPRESA, profileCodes: [modelo] });
        // Se o login falhar, todo 403 viraria 401 e o arquivo mudaria de assunto sem avisar.
        expect(login.status, JSON.stringify(login.body)).toBe(200);
        expect(login.body.user.profileCode).toBe(modelo);
        return login.body.accessToken as string;
      };
      let token = await entrar();
      let noLote = 1;
      for (const rota of rotas) {
        if (noLote >= TAMANHO_DO_LOTE) {
          app = createApp();
          noLote = 0;
        }
        noLote += 1;
        const res = await request(app)[rota.metodo](rota.url).set('Authorization', `Bearer ${token}`);
        const codigo = (res.body as { error?: { code?: string } })?.error?.code;
        medidas.push({ chave: rota.chave, status: res.status, codigo });
        if (res.status === 401) {
          // Uma rota sem corpo não pode derrubar a sessão de quem só passou por ela.
          sessoesPerdidas.push(`${rota.chave}: ${codigo}`);
          token = await entrar();
          noLote += 1;
        }
      }
    }, 900_000);

    afterAll(() => {
      vi.unstubAllGlobals();
    });

    it('bate em todas as rotas guardadas da linha de base', () => {
      expect(medidas.length).toBe(rotas.length);
      expect(rotas.length).toBeGreaterThan(590);
    });

    it('nenhuma rota derrubou a sessão', () => {
      expect(sessoesPerdidas).toEqual([]);
    });

    it('quem passa HOJE passa, e quem não passa recebe 403 do guarda — rota a rota', () => {
      const porChave = new Map(medidas.map((m) => [m.chave, m]));
      const divergentes: string[] = [];
      for (const rota of rotas) {
        const m = porChave.get(rota.chave)!;
        const negado = m.status === 403 && m.codigo === 'API_PERMISSION_DENIED';
        const passaHoje = (rota.base.perfis as string[]).includes(modelo);
        // D1: o legado operador_caixa ganha as duas rotas de impressão quando a F2 as traduzir.
        if (rota.base.mudanca === 'D1' && modelo === 'operador_caixa') continue;
        if (passaHoje === negado) {
          divergentes.push(`${rota.chave}: esperado ${passaHoje ? 'passar' : 'negar'}, veio ${m.status} ${m.codigo ?? ''}`);
        }
      }
      expect(divergentes.join('\n')).toBe('');
    });
  });
}
