/**
 * ============================================================================
 * A CONFERÊNCIA DA IMPLANTAÇÃO (GAP-PRD-013, GAP-PRD-151, GAP-PRD-153)
 * ============================================================================
 *
 * A publicação estava "inteiramente delegada ao dono, sem exemplo", e a
 * única forma de saber se ela estava certa era ler `DEPLOY.md` e conferir de
 * cabeça. O que a auditoria achou nesta máquina mostra por que isso não basta:
 * `.env` com `DEVORA_DEV_QUICK_LOGIN=true` e sem `DEVORA_API_ENV` — 184
 * entradas sem senha no banco do dono —, e um compose "de produção" que
 * declarava `development`.
 *
 * A conferência responde, item por item, com OK / INFO / ATENÇÃO / BLOQUEIA:
 *
 *   - antes de subir, pelo comando `conferir-implantacao` (sai com 1 se algo
 *     bloqueia — o instalador do serviço o roda e para);
 *   - com a API no ar, pela tela Configurações › Implantação — que ainda sabe
 *     o que o comando não sabe: se a página chegou por HTTPS e se há um
 *     supervisor para levantar a API.
 *
 * Ela nunca mostra valor de segredo: diz QUAL variável está fraca, ausente ou
 * sem efeito — pelo nome.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';

import request from 'supertest';

const { conferirImplantacao } = await import('../src/services/implantacao/conferenciaDaImplantacao.js');
const { createApp } = await import('../src/app.js');
const { resetDbForTests } = await import('../src/db/database.js');
const { loginForTest } = await import('./helpers/auth.js');

type Contexto = Parameters<typeof conferirImplantacao>[0];

const JWT = 'Xk9#mQ2$vL7pR4tW8zB1nC6yH3jF5dS0';
const CHAVE = 'aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0hJ';

function producaoBemFeita(extra: Record<string, string | undefined> = {}): Contexto {
  return {
    env: {
      NODE_ENV: 'production',
      DEVORA_API_ENV: 'production',
      DEVORA_JWT_SECRET: JWT,
      DEVORA_ENCRYPTION_KEY: CHAVE,
      DEVORA_FRONTEND_ORIGIN: 'https://erp.gruposampaio.com.br',
      DEVORA_TRUST_PROXY: '1',
      DEVORA_DATABASE_PATH: 'D:/grupo-sampaio/dados/grupo-sampaio.db',
      DEVORA_BACKUP_DIR: 'E:/backups-grupo-sampaio',
      DEVORA_UPLOADS_DIR: 'D:/grupo-sampaio/dados/uploads',
      DEVORA_SERVIR_FRONTEND: 'true',
      LOG_LEVEL: 'info',
      ...extra,
    },
    raiz: 'C:/grupo-sampaio',
    existe: () => true,
    emContainer: false,
    processo: null,
  };
}

function item(r: ReturnType<typeof conferirImplantacao>, id: string) {
  const achado = r.itens.find((i) => i.id === id);
  if (!achado) throw new Error(`item ${id} não está na conferência`);
  return achado;
}

describe('a conferência, item por item', () => {
  it('uma produção bem configurada fica pronta — nada bloqueia', () => {
    const r = conferirImplantacao(producaoBemFeita());
    expect(r.itens.filter((i) => i.estado === 'BLOQUEIA')).toEqual([]);
    expect(r.pronto).toBe(true);
    expect(item(r, 'ambiente').estado).toBe('OK');
    expect(item(r, 'variavel_aposentada').estado).toBe('OK');
    expect(item(r, 'chaves').estado).toBe('OK');
    expect(item(r, 'frontend').estado).toBe('OK');
  });

  it('o .env desta máquina (sem DEVORA_API_ENV, com a variável do atalho ligada) BLOQUEIA duas vezes (GAP-PRD-151)', () => {
    const r = conferirImplantacao(
      producaoBemFeita({ NODE_ENV: undefined, DEVORA_API_ENV: undefined, DEVORA_DEV_QUICK_LOGIN: 'true' }),
    );
    expect(r.pronto).toBe(false);
    expect(item(r, 'ambiente').estado).toBe('BLOQUEIA');
    expect(item(r, 'ambiente').detalhe).toMatch(/development/);
    expect(item(r, 'variavel_aposentada').estado).toBe('BLOQUEIA');
    expect(item(r, 'variavel_aposentada').comoResolver).toMatch(/DEVORA_DEV_QUICK_LOGIN/);
  });

  it('variável aposentada do acesso sem senha: ligada BLOQUEIA, escrita false é ATENÇÃO, ausente é OK', () => {
    for (const nome of ['DEVORA_DEV_QUICK_LOGIN', 'VITE_DEV_QUICK_LOGIN', 'GRUPO_SAMPAIO_QUICK_LOGIN']) {
      const ligada = item(conferirImplantacao(producaoBemFeita({ [nome]: 'true' })), 'variavel_aposentada');
      expect(ligada.titulo).toBe('Variável aposentada presente');
      expect(ligada.estado, nome).toBe('BLOQUEIA');
      expect(ligada.detalhe, nome).toContain(nome);
      const escrita = item(conferirImplantacao(producaoBemFeita({ [nome]: 'false' })), 'variavel_aposentada');
      expect(escrita.estado, nome).toBe('ATENCAO');
      expect(escrita.detalhe, nome).toContain(nome);
    }
    expect(item(conferirImplantacao(producaoBemFeita()), 'variavel_aposentada').estado).toBe('OK');
  });

  it('ligada com comentário na mesma linha do .env continua BLOQUEIA — não vira ATENÇÃO', () => {
    // O leitor do .env não corta o comentário: o valor chega "true   # ...".
    const r = conferirImplantacao(producaoBemFeita({ DEVORA_DEV_QUICK_LOGIN: 'true   # para entrar rapido' }));
    expect(item(r, 'variavel_aposentada').estado).toBe('BLOQUEIA');
  });

  it('a variável aposentada tem item próprio: não sai duas vezes, e o item antigo não existe mais', () => {
    const r = conferirImplantacao(producaoBemFeita({ DEVORA_DEV_QUICK_LOGIN: 'false' }));
    expect(item(r, 'variaveis_sem_efeito').estado).toBe('OK');
    expect(r.itens.some((i) => i.id === 'acesso_rapido')).toBe(false);
  });

  it('homologação é ATENÇÃO, não bloqueio — é um ambiente legítimo', () => {
    expect(item(conferirImplantacao(producaoBemFeita({ DEVORA_API_ENV: 'staging' })), 'ambiente').estado).toBe(
      'ATENCAO',
    );
  });

  it('chave publicada no repositório bloqueia, pelo NOME — o valor nunca aparece', () => {
    const r = conferirImplantacao(producaoBemFeita({ DEVORA_ENCRYPTION_KEY: 'staging-docker-encryption-key' }));
    expect(item(r, 'chaves').estado).toBe('BLOQUEIA');
    expect(item(r, 'chaves').detalhe).toContain('DEVORA_ENCRYPTION_KEY');
    expect(item(r, 'chaves').detalhe).not.toContain('DEVORA_JWT_SECRET');
    const texto = JSON.stringify(r);
    expect(texto).not.toContain('staging-docker-encryption-key');
    expect(texto).not.toContain(JWT);
  });

  it('servir as telas sem o build bloqueia — a API recusaria subir', () => {
    const ctx = producaoBemFeita();
    ctx.existe = (caminho) => !caminho.endsWith('index.html');
    expect(item(conferirImplantacao(ctx), 'frontend').estado).toBe('BLOQUEIA');
  });

  it('sem servir as telas, diz quem precisa servir — o host da frente, com fallback de SPA', () => {
    const r = conferirImplantacao(producaoBemFeita({ DEVORA_SERVIR_FRONTEND: 'false' }));
    expect(item(r, 'frontend').estado).toBe('INFO');
    expect(item(r, 'frontend').detalhe).toMatch(/try_files|fallback/);
  });

  it('origem do frontend só de localhost, sem a API servir as telas, bloqueia em produção', () => {
    const r = conferirImplantacao(
      producaoBemFeita({ DEVORA_SERVIR_FRONTEND: 'false', DEVORA_FRONTEND_ORIGIN: 'http://localhost:3000' }),
    );
    expect(item(r, 'origem_do_frontend').estado).toBe('BLOQUEIA');
  });

  it('em container, fotos fora do volume BLOQUEIAM (GAP-PRD-062)', () => {
    const ctx = producaoBemFeita({
      DEVORA_DATABASE_PATH: '/app/server/data/grupo-sampaio.db',
      DEVORA_UPLOADS_DIR: undefined,
      DEVORA_BACKUP_DIR: '/app/backups',
    });
    ctx.raiz = '/app';
    ctx.emContainer = true;
    const r = conferirImplantacao(ctx);
    expect(item(r, 'fotos').estado).toBe('BLOQUEIA');
    expect(item(r, 'fotos').detalhe).toContain('/app/data/uploads');
    expect(item(r, 'banco').estado).not.toBe('BLOQUEIA');
  });

  it('e com as fotos no volume, passa', () => {
    const ctx = producaoBemFeita({
      DEVORA_DATABASE_PATH: '/app/server/data/grupo-sampaio.db',
      DEVORA_UPLOADS_DIR: '/app/server/data/uploads',
      DEVORA_BACKUP_DIR: '/app/backups',
    });
    ctx.raiz = '/app';
    ctx.emContainer = true;
    expect(item(conferirImplantacao(ctx), 'fotos').estado).not.toBe('BLOQUEIA');
  });

  it('variável que nada lê é apontada pelo nome, sem o valor (GAP-PRD-153)', () => {
    const r = conferirImplantacao(
      producaoBemFeita({
        DEVORA_PUBLIC_BASE_URL: 'https://api.exemplo.com',
        LOGISTICS_JADLOG_TOKEN: 'token-de-verdade-da-jadlog',
        NFCE_TEST_CSC_TOKEN: 'csc-de-teste',
      }),
    );
    const semEfeito = item(r, 'variaveis_sem_efeito');
    expect(semEfeito.estado).toBe('ATENCAO');
    expect(semEfeito.detalhe).toContain('DEVORA_PUBLIC_BASE_URL');
    expect(semEfeito.detalhe).toContain('LOGISTICS_JADLOG_TOKEN');
    expect(semEfeito.detalhe).toContain('NFCE_TEST_CSC_TOKEN');
    expect(semEfeito.comoResolver).toMatch(/Integrações/);
    expect(JSON.stringify(r)).not.toContain('token-de-verdade-da-jadlog');
  });

  it('LOG_LEVEL inválido bloqueia (a API não sobe); debug em produção é atenção', () => {
    expect(item(conferirImplantacao(producaoBemFeita({ LOG_LEVEL: 'verbose' })), 'registro').estado).toBe('BLOQUEIA');
    expect(item(conferirImplantacao(producaoBemFeita({ LOG_LEVEL: 'debug' })), 'registro').estado).toBe('ATENCAO');
  });

  it('backup sem destino próprio é atenção em produção', () => {
    expect(item(conferirImplantacao(producaoBemFeita({ DEVORA_BACKUP_DIR: '' })), 'backup').estado).toBe('ATENCAO');
  });

  it('destino preenchido no MESMO disco do banco não é OK (GAP-PRD-068)', () => {
    // O banco do cenário mora em D:/grupo-sampaio/dados.
    const mesmo = item(conferirImplantacao(producaoBemFeita({ DEVORA_BACKUP_DIR: 'd:/backups' })), 'backup');
    expect(mesmo.estado).toBe('ATENCAO');
    expect(mesmo.detalhe).toMatch(/mesmo disco \(D:\)/);
    expect(item(conferirImplantacao(producaoBemFeita({ DEVORA_BACKUP_DIR: 'E:/backups' })), 'backup').estado).toBe('OK');
  });

  it('no comando (sem processo), supervisor e HTTPS dizem o que dá para dizer', () => {
    const r = conferirImplantacao(producaoBemFeita());
    expect(item(r, 'supervisor').estado).toBe('INFO');
    expect(item(r, 'https').estado).toBe('OK');
    const http = conferirImplantacao(producaoBemFeita({ DEVORA_FRONTEND_ORIGIN: 'http://erp.gruposampaio.com.br' }));
    expect(item(http, 'https').estado).toBe('ATENCAO');
  });
});

describe('dentro da API, com a requisição na mão', () => {
  function comProcesso(
    processo: NonNullable<Contexto['processo']>,
    extra: Record<string, string | undefined> = {},
  ) {
    const ctx = producaoBemFeita(extra);
    ctx.processo = processo;
    return conferirImplantacao(ctx);
  }

  it('página que chegou por HTTPS é OK', () => {
    expect(item(comProcesso({ supervisionado: 'supervisor', protocolo: 'https' }), 'https').estado).toBe('OK');
  });

  it('proxy HTTPS na frente com DEVORA_TRUST_PROXY=0: a API não confia nele — atenção nos dois itens', () => {
    const r = comProcesso(
      { supervisionado: 'supervisor', protocolo: 'http', encaminhadoComo: 'https' },
      { DEVORA_TRUST_PROXY: '0' },
    );
    expect(item(r, 'https').estado).toBe('ATENCAO');
    expect(item(r, 'proxy').estado).toBe('ATENCAO');
    expect(item(r, 'proxy').comoResolver).toMatch(/DEVORA_TRUST_PROXY=1/);
  });

  it('página por HTTP puro é atenção, dizendo como terminar o HTTPS', () => {
    const r = comProcesso({ supervisionado: 'supervisor', protocolo: 'http' });
    expect(item(r, 'https').estado).toBe('ATENCAO');
    expect(item(r, 'https').comoResolver).toMatch(/deploy\/caddy/);
  });

  it.each([
    ['supervisor', 'OK'],
    ['systemd', 'OK'],
    ['container', 'OK'],
  ] as const)('sob %s, há quem levante a API', (quem, estado) => {
    expect(item(comProcesso({ supervisionado: quem, protocolo: 'https' }), 'supervisor').estado).toBe(estado);
  });

  it('à mão, sem supervisor: atenção — uma queda para as seis empresas', () => {
    const r = comProcesso({ supervisionado: null, protocolo: 'https' });
    expect(item(r, 'supervisor').estado).toBe('ATENCAO');
    expect(item(r, 'supervisor').comoResolver).toMatch(/instalar-servico\.ps1/);
  });
});

// ============================================================================

describe('a rota GET /api/v1/system/implantacao', () => {
  const app = createApp();
  beforeEach(() => {
    resetDbForTests();
  });

  it('sem sessão, 401', async () => {
    expect((await request(app).get('/api/v1/system/implantacao')).status).toBe(401);
  });

  it('com operador de caixa, 403 — é diagnóstico de quem responde pelo grupo', async () => {
    const caixa = await loginForTest(app, {
      userId: 'caixa-impl',
      companyId: 'loja-impl',
      profileCodes: ['operador_caixa_loja'],
    });
    const res = await request(app)
      .get('/api/v1/system/implantacao')
      .set({ Authorization: `Bearer ${caixa.body.accessToken}` });
    expect(res.status).toBe(403);
  });

  it('com o dono, responde os itens — e nenhum valor de segredo', async () => {
    const dono = await loginForTest(app, {
      userId: 'dono-impl',
      companyId: 'loja-impl',
      profileCodes: ['admin_geral'],
    });
    const res = await request(app)
      .get('/api/v1/system/implantacao')
      .set({ Authorization: `Bearer ${dono.body.accessToken}`, 'X-Forwarded-Proto': 'https' });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.itens)).toBe(true);
    const ids = res.body.itens.map((i: { id: string }) => i.id);
    for (const id of ['ambiente', 'variavel_aposentada', 'chaves', 'https', 'proxy', 'supervisor', 'frontend', 'fotos']) {
      expect(ids).toContain(id);
    }
    expect(typeof res.body.pronto).toBe('boolean');
    const texto = JSON.stringify(res.body);
    expect(texto).not.toContain(process.env.DEVORA_JWT_SECRET as string);
    expect(texto).not.toContain(process.env.DEVORA_ENCRYPTION_KEY as string);
    // A suíte roda em `test`: a conferência é honesta e diz que isto não é produção.
    expect(res.body.itens.find((i: { id: string }) => i.id === 'ambiente').estado).toBe('BLOQUEIA');
  });
});

// ============================================================================

describe('o comando conferir-implantacao', () => {
  const SERVIDOR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const TSX = join(SERVIDOR, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const SCRIPT = join(SERVIDOR, 'src', 'scripts', 'conferir-implantacao.ts');

  function rodar(env: Record<string, string>): { codigo: number; saida: string } {
    const pasta = mkdtempSync(join(tmpdir(), 'gs-conferir-'));
    try {
      const saida = execFileSync(process.execPath, [TSX, SCRIPT], {
        cwd: pasta,
        env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', DEVORA_IGNORE_DOTENV: 'true', ...env },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { codigo: 0, saida };
    } catch (erro) {
      const e = erro as { status?: number; stdout?: string };
      return { codigo: e.status ?? -1, saida: e.stdout ?? '' };
    } finally {
      rmSync(pasta, { recursive: true, force: true });
    }
  }

  it('com a variável aposentada do atalho ligada, sai com 1 e diz qual', () => {
    const r = rodar({ DEVORA_DEV_QUICK_LOGIN: 'true' });
    expect(r.codigo).toBe(1);
    expect(r.saida).toMatch(/BLOQUEIA/);
    expect(r.saida).toContain('DEVORA_DEV_QUICK_LOGIN');
  }, 60_000);

  it('com a produção bem feita, sai com 0', () => {
    const frontend = mkdtempSync(join(tmpdir(), 'gs-out-'));
    mkdirSync(join(frontend, 'assets'));
    writeFileSync(join(frontend, 'index.html'), '<div id="root"></div>');
    try {
      const r = rodar({
        NODE_ENV: 'production',
        DEVORA_API_ENV: 'production',
        DEVORA_JWT_SECRET: JWT,
        DEVORA_ENCRYPTION_KEY: CHAVE,
        DEVORA_FRONTEND_ORIGIN: 'https://erp.gruposampaio.com.br',
        DEVORA_TRUST_PROXY: '1',
        DEVORA_DATABASE_PATH: join(frontend, 'banco.db'),
        DEVORA_BACKUP_DIR: join(frontend, 'backups'),
        DEVORA_SERVIR_FRONTEND: 'true',
        DEVORA_FRONTEND_DIR: frontend,
        // Primeira instalação: o banco ainda não existe e ninguém administra.
        // Com a senha inicial declarada, a primeira subida cria o 'admin' —
        // sem ela, "Administrador inicial" BLOQUEIA (bootstrap-de-producao.test.ts).
        DEVORA_BOOTSTRAP_ADMIN_PASSWORD: 'Primeira#Instalacao-2026',
      });
      expect(r.saida).not.toContain(JWT);
      expect(r.saida).not.toContain('Primeira#Instalacao-2026');
      expect(r.codigo, r.saida).toBe(0);
      expect(r.saida).toMatch(/nada bloqueia/i);
    } finally {
      rmSync(frontend, { recursive: true, force: true });
    }
  }, 60_000);
});
