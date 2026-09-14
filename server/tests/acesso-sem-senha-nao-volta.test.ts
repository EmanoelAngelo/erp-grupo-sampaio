/**
 * O ACESSO SEM SENHA NÃO VOLTA AO CÓDIGO DO PRODUTO — no molde de
 * `nome-aposentado-nao-volta.test.ts`.
 *
 * O atalho de desenvolvimento (lista de usuários de todas as empresas + sessão
 * emitida só com o id) saiu inteiro: rotas, cliente, painel da tela de login,
 * chave do esquema. O que impede que ele renasça por cópia de um commit
 * antigo, por um "só para testar" ou por um comentário que ensine o caminho é
 * esta varredura: nenhuma das quatro marcas dele aparece no servidor nem nas
 * telas — nem em comentário, porque comentário vira instrução para quem lê.
 *
 * A única exceção é o módulo que NOMEIA as variáveis aposentadas para que o
 * boot recuse subir em produção com qualquer uma ligada, avise fora dela, e a
 * conferência da implantação e o `secret:scan` as achem. Ele nunca lê o valor
 * para ligar nada.
 *
 * O que vai para o bundle é o que está em `src/` (e o `index.html`): sem as
 * marcas aqui, o endereço da porta antiga não chega ao navegador.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { VARIAVEIS_SEM_EFEITO } from '../src/services/implantacao/conferenciaDaImplantacao.js';

const RAIZ = resolve(__dirname, '..', '..');
// `public/` vai para o build como está (o `sw.js` inclusive): é bundle também.
const PASTAS = ['server/src', 'src', 'public'];
const AVULSOS = ['index.html'];

const VARIAVEIS = ['DEVORA_DEV_QUICK_LOGIN', 'VITE_DEV_QUICK_LOGIN', 'GRUPO_SAMPAIO_QUICK_LOGIN'];

const MARCAS: Array<[string, RegExp]> = [
  ['quick-login', /quick-login/],
  ['quickLogin', /quickLogin/],
  ['QUICK_LOGIN', /QUICK_LOGIN/],
  ['Acesso rápido ligado', /acesso r[áa]pido ligado/i],
];

/**
 * Onde as variáveis aposentadas aparecem DE PROPÓSITO — para recusar e avisar,
 * nunca para ligar. Arquivo novo aqui precisa de motivo.
 */
const QUEM_AVISA: Record<string, string> = {
  'server/src/config/acessoSemSenhaAposentado.ts':
    'a lista das variáveis aposentadas: o boot recusa em produção, avisa fora dela; a conferência e o secret:scan as acham',
};

function arquivos(pasta: string): string[] {
  const saida: string[] = [];
  for (const nome of readdirSync(join(RAIZ, pasta))) {
    if (nome === 'node_modules' || nome === '__tests__') continue;
    const caminho = join(RAIZ, pasta, nome);
    if (statSync(caminho).isDirectory()) saida.push(...arquivos(relative(RAIZ, caminho)));
    else if (/\.(ts|tsx|js|jsx|mjs|css|html|json)$/.test(nome) && !/\.test\.tsx?$/.test(nome)) saida.push(caminho);
  }
  return saida;
}

const rel = (arquivo: string) => relative(RAIZ, arquivo).replace(/\\/g, '/');

describe('o acesso sem senha não volta ao produto', () => {
  const fontes = [...PASTAS.flatMap(arquivos), ...AVULSOS.map((a) => join(RAIZ, a)).filter(existsSync)];

  it('a varredura enxerga o produto — senão ficaria verde lendo nada', () => {
    expect(fontes.length).toBeGreaterThan(500);
    expect(fontes.map(rel)).toContain('server/src/routes/v1/auth.ts');
    expect(fontes.map(rel)).toContain('src/pages/gs/LoginPage.tsx');
  });

  it('nenhuma das quatro marcas do atalho aparece — nem em comentário —, fora de quem avisa', () => {
    const achados: string[] = [];
    for (const arquivo of fontes) {
      const caminho = rel(arquivo);
      if (caminho in QUEM_AVISA) continue;
      const texto = readFileSync(arquivo, 'utf8');
      for (const [marca, re] of MARCAS) {
        if (re.test(texto)) achados.push(`${caminho}: ${marca}`);
      }
    }
    expect(achados).toEqual([]);
  });

  it('a exceção declarada existe, e é ela que nomeia as três variáveis', () => {
    for (const arquivo of Object.keys(QUEM_AVISA)) {
      expect(existsSync(join(RAIZ, arquivo)), arquivo).toBe(true);
      const texto = readFileSync(join(RAIZ, arquivo), 'utf8');
      for (const nome of VARIAVEIS) expect(texto, `${arquivo}: ${nome}`).toContain(nome);
    }
  });

  it('as três entram na lista das variáveis sem efeito (a da trava nome-aposentado-nao-volta)', () => {
    const nomes = VARIAVEIS_SEM_EFEITO.map(([nome]) => nome);
    for (const nome of VARIAVEIS) expect(nomes).toContain(nome);
  });

  it('a tela de login não carrega mais a justificativa do atalho no cabeçalho', () => {
    const tela = readFileSync(join(RAIZ, 'src/pages/gs/LoginPage.tsx'), 'utf8');
    expect(tela).not.toMatch(/acesso r[áa]pido/i);
    expect(tela).not.toMatch(/atalho de desenvolvimento/i);
    expect(tela).not.toMatch(/sem senha/i);
  });
});
