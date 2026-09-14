/**
 * ============================================================================
 * O CONTRATO DE VARIÁVEIS — toda chave documentada é lida, e toda chave lida
 * é documentada (GAP-PRD-153)
 * ============================================================================
 *
 * O que a auditoria cruzou à mão (schema × exemplos × leitores):
 *
 *   - `LOG_LEVEL` e `DEVORA_PUBLIC_BASE_URL` estavam no schema, validados e
 *     documentados — e ninguém os lia. O logger imprimia tudo;
 *   - `.env.example` não tinha `EMAIL_*`, `DEVORA_UPLOADS_DIR`,
 *     `DEVORA_SUPABASE_BUCKET` nem a retenção; `.env.staging.example` não
 *     tinha nem o SMTP nem a central;
 *   - `NFCE_TEST_CSC_*`, `LOGISTICS_*_TOKEN/USERNAME/PASSWORD` e
 *     `ASAAS_SANDBOX_TESTS` só são lidos pela SUÍTE, e apareciam no exemplo de
 *     PRODUÇÃO como se fossem configuração. Quem instala preenche a credencial
 *     da transportadora no `.env` achando que ligou alguma coisa — e ela entra
 *     pela Central de Integrações.
 *
 * Este arquivo refaz o cruzamento a cada rodada, por AST: um leitor novo sem
 * linha no exemplo, ou uma linha no exemplo sem leitor, fica vermelho aqui.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const SERVIDOR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RAIZ = resolve(SERVIDOR, '..');

function arquivos(pasta: string, filtro: RegExp): string[] {
  const achados: string[] = [];
  for (const nome of readdirSync(pasta)) {
    const caminho = join(pasta, nome);
    if (statSync(caminho).isDirectory()) {
      if (nome === '__tests__' || nome === 'node_modules') continue;
      achados.push(...arquivos(caminho, filtro));
    } else if (filtro.test(nome) && !/\.test\.tsx?$/.test(nome)) {
      achados.push(caminho);
    }
  }
  return achados;
}

/** As chaves que o schema do `loadEnv` declara. */
function chavesDoSchema(): Set<string> {
  const sf = ts.createSourceFile('env.ts', readFileSync(join(SERVIDOR, 'src/config/env.ts'), 'utf8'), ts.ScriptTarget.ES2022, true);
  const chaves = new Set<string>();
  const visitar = (n: ts.Node): void => {
    if (
      ts.isVariableDeclaration(n)
      && ts.isIdentifier(n.name)
      && n.name.text === 'envSchema'
      && n.initializer
      && ts.isCallExpression(n.initializer)
    ) {
      const objeto = n.initializer.arguments[0];
      if (objeto && ts.isObjectLiteralExpression(objeto)) {
        for (const p of objeto.properties) {
          if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) chaves.add(p.name.text);
        }
      }
    }
    ts.forEachChild(n, visitar);
  };
  visitar(sf);
  return chaves;
}

/**
 * Quem LÊ cada chave no servidor. Conta:
 *   - `process.env.X` e `process.env['X']`;
 *   - `algo.X` quando X é chave do schema (`loadEnv().X`, `env.X`, `parsed.X`);
 *   - `numeroDoAmbiente('X', …)`, o leitor da retenção do backup.
 *
 * NÃO conta a conferência da implantação: ela INSPECIONA a configuração para
 * dizer o que está errado — se contasse, qualquer chave morta que ela cita
 * pareceria viva.
 */
function lidasPeloServidor(schema: Set<string>): Map<string, Set<string>> {
  const leitores = new Map<string, Set<string>>();
  const anotar = (chave: string, arquivo: string) => {
    if (!leitores.has(chave)) leitores.set(chave, new Set());
    leitores.get(chave)!.add(relative(SERVIDOR, arquivo).split(sep).join('/'));
  };
  for (const arquivo of arquivos(join(SERVIDOR, 'src'), /\.ts$/)) {
    if (arquivo.endsWith(`implantacao${sep}conferenciaDaImplantacao.ts`)) continue;
    const sf = ts.createSourceFile(arquivo, readFileSync(arquivo, 'utf8'), ts.ScriptTarget.ES2022, true);
    const visitar = (n: ts.Node): void => {
      if (ts.isPropertyAccessExpression(n)) {
        const alvo = n.expression;
        const ehProcessEnv = ts.isPropertyAccessExpression(alvo) && alvo.getText(sf) === 'process.env';
        if (ehProcessEnv || schema.has(n.name.text)) anotar(n.name.text, arquivo);
      }
      if (
        ts.isElementAccessExpression(n)
        && n.expression.getText(sf) === 'process.env'
        && ts.isStringLiteral(n.argumentExpression)
      ) {
        anotar(n.argumentExpression.text, arquivo);
      }
      if (
        ts.isCallExpression(n)
        && ts.isIdentifier(n.expression)
        && n.expression.text === 'numeroDoAmbiente'
        && n.arguments[0]
        && ts.isStringLiteral(n.arguments[0])
      ) {
        anotar(n.arguments[0].text, arquivo);
      }
      ts.forEachChild(n, visitar);
    };
    visitar(sf);
  }
  return leitores;
}

/** O frontend lê só o que o Vite embute: `import.meta.env.VITE_*`. */
function lidasPeloFrontend(): Set<string> {
  const chaves = new Set<string>();
  for (const arquivo of arquivos(join(RAIZ, 'src'), /\.tsx?$/)) {
    for (const m of readFileSync(arquivo, 'utf8').matchAll(/import\.meta\.env\??\.(VITE_[A-Z0-9_]+)/g)) {
      chaves.add(m[1]);
    }
  }
  return chaves;
}

/**
 * Lidas, mas NÃO são configuração da instalação — e por isso não entram nos
 * exemplos. Cada uma com o porquê.
 */
const NAO_SAO_CONFIGURACAO: Record<string, string> = {
  DEVORA_IGNORE_DOTENV: 'a suíte liga para não ler o .env da máquina',
  TEST_DATABASE_PATH: 'a suíte anuncia o banco descartável',
  VITEST: 'o próprio Vitest define',
  DEVORA_SUPERVISIONADO: 'o supervisor define para a API que ele sobe',
  ROTACAO_CHAVE_ANTIGA: 'entrada do script de rotação, digitada na hora — nunca fica em arquivo',
  ROTACAO_CHAVE_NOVA: 'entrada do script de rotação, digitada na hora — nunca fica em arquivo',
  SUPABASE_ACCESS_TOKEN: 'token pessoal do script que aplica SQL na central — nunca fica em arquivo',
  GRUPO_SAMPAIO_MANAGEMENT_PASSWORD:
    'só o seed de DESENVOLVIMENTO lê (db:seed:dev, que recusa produção e homologação) — documentada só no .env.example',
  GRUPO_SAMPAIO_OPERATION_PASSWORD:
    'só o seed de DESENVOLVIMENTO lê (db:seed:dev, que recusa produção e homologação) — documentada só no .env.example',
};

/** As chaves de um exemplo: `CHAVE=` ativa ou `# CHAVE=` comentada. */
function documentadas(arquivo: string): Set<string> {
  const chaves = new Set<string>();
  for (const linha of readFileSync(join(RAIZ, arquivo), 'utf8').split(/\r?\n/)) {
    const m = linha.match(/^\s*#?\s*([A-Z][A-Z0-9_]+)=/);
    if (m) chaves.add(m[1]);
  }
  return chaves;
}

const EXEMPLOS = ['.env.example', '.env.staging.example', '.env.production.example'];

const schema = chavesDoSchema();
const doServidor = lidasPeloServidor(schema);
const doFrontend = lidasPeloFrontend();
const lidas = new Set([...doServidor.keys(), ...doFrontend]);
const configuracao = [...lidas].filter((k) => !(k in NAO_SAO_CONFIGURACAO)).sort();

describe('o cruzamento enxerga o que deve enxergar', () => {
  it('o schema e os leitores foram lidos — senão o resto fica verde lendo nada', () => {
    expect(schema.size).toBeGreaterThan(40);
    expect(doServidor.get('DEVORA_UPLOADS_DIR')?.size ?? 0).toBeGreaterThanOrEqual(3);
    expect(doServidor.has('DEVORA_BACKUP_RETENCAO_DIARIOS')).toBe(true);
    expect(doFrontend.has('VITE_API_BASE_URL')).toBe(true);
  });
});

describe('toda chave do schema tem leitor', () => {
  it('nenhuma chave declarada e validada fica sem quem a leia fora da declaração', () => {
    const semLeitor = [...schema].filter((k) => !doServidor.has(k));
    expect(
      semLeitor,
      'chave no schema sem leitor: quem instala a preenche achando que configurou algo — '
        + `dê um leitor ou tire do schema e dos exemplos: ${semLeitor.join(', ')}`,
    ).toEqual([]);
  });
});

for (const exemplo of EXEMPLOS) {
  describe(exemplo, () => {
    const doc = documentadas(exemplo);

    it('toda chave documentada é lida por alguém', () => {
      const mortas = [...doc].filter((k) => !lidas.has(k));
      expect(
        mortas,
        `chave no exemplo que nada lê (se é da suíte, documente em DEPLOY.md, não aqui): ${mortas.join(', ')}`,
      ).toEqual([]);
    });

    it('toda chave de configuração lida está documentada', () => {
      const faltam = configuracao.filter((k) => !doc.has(k));
      expect(faltam, `chaves lidas pelo sistema que ${exemplo} não documenta: ${faltam.join(', ')}`).toEqual([]);
    });
  });
}

describe('as chaves só da suíte não se passam por configuração', () => {
  it.each([
    'NFCE_TEST_CSC_ID',
    'NFCE_TEST_CSC_TOKEN',
    'LOGISTICS_MELHOR_ENVIO_TOKEN',
    'LOGISTICS_JADLOG_TOKEN',
    'LOGISTICS_CORREIOS_USERNAME',
    'LOGISTICS_CORREIOS_PASSWORD',
    'ASAAS_SANDBOX_TESTS',
    'DEVORA_PUBLIC_BASE_URL',
    'DEVORA_STORAGE_PATH',
    'DEVORA_METRICS_ENABLED',
    'DEVORA_SENTRY_DSN',
    // Aposentadas com o acesso sem senha: nada as lê, e escritas no exemplo
    // (mesmo `false`) ensinariam que existe uma porta para ligar.
    'DEVORA_DEV_QUICK_LOGIN',
    'VITE_DEV_QUICK_LOGIN',
    'GRUPO_SAMPAIO_QUICK_LOGIN',
  ])('%s não aparece em nenhum exemplo', (chave) => {
    for (const exemplo of EXEMPLOS) expect(documentadas(exemplo).has(chave), exemplo).toBe(false);
  });

  it('e a DEPLOY.md diz onde elas vivem', () => {
    const deploy = readFileSync(join(RAIZ, 'docs/DEPLOY.md'), 'utf8');
    for (const chave of ['NFCE_TEST_CSC_ID', 'LOGISTICS_JADLOG_TOKEN', 'ASAAS_SANDBOX_TESTS']) {
      expect(deploy, chave).toContain(chave);
    }
  });
});
