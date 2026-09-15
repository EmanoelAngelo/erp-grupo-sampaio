process.env.TZ = 'UTC';
process.env.DEVORA_API_ENV = 'test';

/**
 * ============================================================================
 * O BOOTSTRAP DE PRODUÇÃO — só o estrutural e UM administrador inicial
 * ============================================================================
 *
 * O que existia: um único `db:seed` que criava as seis empresas E treze contas
 * de demonstração (ADMIN, CARLOSGERENTE, seis `<slug>.pdv`, quatro mecânicos e
 * JOAOCELULAR), com senhas de variável ou cravadas para desenvolvimento. Um
 * banco novo sem ele subia sem empresa e sem conta — ninguém entrava —, e com
 * ele a instalação da loja nascia com as treze contas de demonstração.
 *
 * O que estes casos cobram:
 *
 *   - banco novo + `DEVORA_BOOTSTRAP_ADMIN_PASSWORD` → exatamente UMA conta
 *     ('admin', Argon2id, troca obrigatória, administrador nas seis), as seis
 *     empresas, as duas bancadas, e nada de demonstração;
 *   - subir de novo não muda nada — nem o hash, nem o id, nem uma linha;
 *   - a variável NUNCA altera conta existente, com o valor que for;
 *   - 'ADMIN' existente ocupa 'admin' (o login não distingue maiúsculas);
 *   - sem a variável: nada de conta, um aviso no log e a conferência BLOQUEIA;
 *   - a senha não aparece em log, auditoria, marca, resposta de API;
 *   - `db:seed` é o mesmo bootstrap: não cria demonstração.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { getConnection } from '../src/db/sqlite.js';
import { resetDbForTests } from '../src/db/database.js';
import { resetEnvCacheForTests } from '../src/config/env.js';
import {
  BootstrapRecusado,
  EMPRESAS_DO_GRUPO,
  executarBootstrap,
  garantirEstruturaDoGrupo,
  relatorioDoBootstrap,
} from '../src/db/bootstrap.js';
import { situacaoDoAdministrador } from '../src/db/administradorInicial.js';
import { conferirImplantacao } from '../src/services/implantacao/conferenciaDaImplantacao.js';
import { listGroupAdminIds, upsertUser } from '../src/services/auth/IdentityService.js';
import { loginForTest } from './helpers/auth.js';

const app = createApp();
const AQUI = dirname(fileURLToPath(import.meta.url));
const SERVIDOR = resolve(AQUI, '..');

const SENHA = 'Primeira#Subida-2026';
const OUTRA = 'Segunda#Valor-2026';

const ENV_ORIGINAL = { ...process.env };

function restaurarAmbiente(): void {
  for (const chave of Object.keys(process.env)) {
    if (!(chave in ENV_ORIGINAL)) delete process.env[chave];
  }
  Object.assign(process.env, ENV_ORIGINAL);
  resetEnvCacheForTests();
}

function comAVariavel(valor: string | undefined): void {
  if (valor === undefined) delete process.env.DEVORA_BOOTSTRAP_ADMIN_PASSWORD;
  else process.env.DEVORA_BOOTSTRAP_ADMIN_PASSWORD = valor;
  resetEnvCacheForTests();
}

beforeEach(() => {
  restaurarAmbiente();
  delete process.env.DEVORA_BOOTSTRAP_ADMIN_PASSWORD;
  delete process.env.GRUPO_SAMPAIO_MANAGEMENT_PASSWORD;
  delete process.env.GRUPO_SAMPAIO_OPERATION_PASSWORD;
  resetEnvCacheForTests();
  resetDbForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  restaurarAmbiente();
});

const db = () => getConnection();
const contar = (tabela: string): number =>
  (db().prepare(`SELECT COUNT(*) AS n FROM ${tabela}`).get() as { n: number }).n;

function contas(): { id: string; login: string; display_name: string; password_hash: string; hash_algorithm: string; must_change_password: number; session_version: number; updated_at: string }[] {
  return db()
    .prepare('SELECT id, login, display_name, password_hash, hash_algorithm, must_change_password, session_version, updated_at FROM core_users ORDER BY login')
    .all() as never;
}

function vinculosDe(userId: string): { slug: string; profile_code: string; is_default: number }[] {
  return db()
    .prepare(
      `SELECT c.slug, uc.profile_code, uc.is_default FROM core_user_companies uc
         JOIN core_companies c ON c.id = uc.company_id WHERE uc.user_id = ? ORDER BY c.slug`,
    )
    .all(userId) as never;
}

function fotografia(): Record<string, number> {
  return Object.fromEntries(
    ['core_users', 'core_user_companies', 'core_companies', 'core_workshops', 'core_workshop_members', 'core_audit_log', 'core_meta'].map(
      (t) => [t, contar(t)],
    ),
  );
}

/** Tudo o que sai no console e nos fluxos padrão enquanto `fn` roda. */
async function capturarSaida(fn: () => Promise<unknown>): Promise<string> {
  const pedacos: string[] = [];
  const guardar = (...args: unknown[]) => {
    pedacos.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
  for (const metodo of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, metodo).mockImplementation(guardar);
  }
  const escrever = (chunk: unknown) => {
    pedacos.push(String(chunk));
    return true;
  };
  vi.spyOn(process.stdout, 'write').mockImplementation(escrever as never);
  vi.spyOn(process.stderr, 'write').mockImplementation(escrever as never);
  try {
    await fn();
  } finally {
    vi.restoreAllMocks();
  }
  return pedacos.join('\n');
}

async function entrar(login: string, password: string) {
  return request(app).post('/api/v1/auth/login').send({ login, password });
}

function empresasAtivasIds(): string[] {
  return (db().prepare('SELECT id FROM core_companies WHERE active = 1').all() as { id: string }[]).map((r) => r.id);
}

function vincularEmTodas(userId: string, perfil: string): void {
  const inserir = db().prepare(
    `INSERT INTO core_user_companies (id, user_id, company_id, profile_code, is_default, created_at)
     VALUES (?, ?, ?, ?, 0, ?) ON CONFLICT (user_id, company_id) DO NOTHING`,
  );
  for (const companyId of empresasAtivasIds()) inserir.run(randomUUID(), userId, companyId, perfil, new Date().toISOString());
}

function conferenciaDeProducao(env: Record<string, string | undefined> = {}) {
  return conferirImplantacao({
    env: {
      NODE_ENV: 'production',
      DEVORA_API_ENV: 'production',
      ...env,
    },
    raiz: 'C:/grupo-sampaio',
    existe: () => true,
    emContainer: false,
    processo: null,
    administradorInicial: () => situacaoDoAdministrador(getConnection()),
  });
}

/** A conferência (SQL próprio, roda sem a API) e o bootstrap (listGroupAdminIds) contam igual. */
function contamIgual(): void {
  expect(situacaoDoAdministrador(getConnection()).administradoresDoGrupo).toBe(listGroupAdminIds().length);
}

function itemDoAdministrador(r: ReturnType<typeof conferirImplantacao>) {
  const achado = r.itens.find((i) => i.id === 'administrador_inicial');
  if (!achado) throw new Error('a conferência não tem o item administrador_inicial');
  return achado;
}

// ============================================================================

describe('banco novo + DEVORA_BOOTSTRAP_ADMIN_PASSWORD', () => {
  it('exatamente UMA conta — admin, Argon2id, troca obrigatória, administrador nas seis — e nada de demonstração', async () => {
    comAVariavel(SENHA);
    const r = await executarBootstrap({ origem: 'subida' });

    expect(r.administrador.situacao).toBe('criado');
    expect(r.empresasCriadas.sort()).toEqual(EMPRESAS_DO_GRUPO.map((e) => e.slug).sort());

    const todas = contas();
    expect(todas.map((c) => c.login)).toEqual(['admin']);
    const [admin] = todas;
    expect(admin.display_name).toBe('Administrador');
    expect(admin.hash_algorithm).toBe('argon2id');
    expect(admin.password_hash.startsWith('$argon2id$')).toBe(true);
    expect(admin.must_change_password).toBe(1);

    // Administrador do grupo: admin_geral em TODAS as empresas ativas, padrão na Preço Justo.
    const vinculos = vinculosDe(admin.id);
    expect(vinculos.map((v) => v.slug)).toEqual(['conceito', 'gringa', 'me-mimei', 'oficina', 'pj-motors', 'preco-justo']);
    expect(new Set(vinculos.map((v) => v.profile_code))).toEqual(new Set(['admin_geral']));
    expect(vinculos.filter((v) => v.is_default === 1).map((v) => v.slug)).toEqual(['preco-justo']);
    expect(listGroupAdminIds()).toEqual([admin.id]);
    contamIgual();

    // As seis empresas, com os nomes e slugs de hoje; o estrutural que a subida garante.
    const empresas = db().prepare('SELECT slug, trade_name, kind, uses_equipment_tags, storefront_preset FROM core_companies ORDER BY slug').all() as {
      slug: string; trade_name: string; kind: string; uses_equipment_tags: number; storefront_preset: string | null;
    }[];
    expect(empresas.map((e) => [e.slug, e.trade_name])).toEqual([
      ['conceito', 'Conceito'],
      ['gringa', 'Gringa'],
      ['me-mimei', 'Me Mimei'],
      ['oficina', 'Oficina'],
      ['pj-motors', 'PJ Motors'],
      ['preco-justo', 'Preço Justo'],
    ]);
    // Plaquinha é EXCLUSIVA da PJ Motors (P0 das plaquinhas): antes a subida
    // marcava também a Oficina, e este teste cobrava as duas.
    expect(empresas.filter((e) => e.uses_equipment_tags === 1).map((e) => e.slug)).toEqual(['pj-motors']);
    expect(empresas.filter((e) => e.kind !== 'workshop').every((e) => e.storefront_preset !== null)).toBe(true);
    const bancadas = db().prepare('SELECT slug FROM core_workshops ORDER BY slug').all() as { slug: string }[];
    expect(bancadas.map((b) => b.slug)).toEqual(['oficina-celulares', 'oficina-mobilidade']);

    // Zero dado de negócio.
    for (const tabela of ['core_products', 'core_customers', 'core_sales', 'core_workshop_members']) {
      expect(contar(tabela), tabela).toBe(0);
    }

    // A auditoria diz quem (o sistema), o quê e sobre quem — sem senha.
    const trilha = db()
      .prepare("SELECT user_id, entity_type, entity_id, detail FROM core_audit_log WHERE action = 'bootstrap.admin_created'")
      .all() as { user_id: string | null; entity_type: string; entity_id: string; detail: string }[];
    expect(trilha).toHaveLength(1);
    expect(trilha[0].user_id).toBeNull();
    expect(trilha[0].entity_type).toBe('user');
    expect(trilha[0].entity_id).toBe(admin.id);
    expect(JSON.parse(trilha[0].detail)).toMatchObject({ login: 'admin', ator: 'sistema' });

    // E a marca em core_meta.
    const marca = db().prepare("SELECT value FROM core_meta WHERE key = 'bootstrap_admin_created_at'").get() as { value: string } | undefined;
    expect(marca?.value).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('login admin com a senha certa: 200 com troca obrigatória, e a API segura o resto; senha errada: 401', async () => {
    comAVariavel(SENHA);
    await executarBootstrap({ origem: 'comando' });

    const certo = await entrar('admin', SENHA);
    expect(certo.status, JSON.stringify(certo.body)).toBe(200);
    expect(certo.body.user.mustChangePassword).toBe(true);
    expect(certo.body.companies).toHaveLength(6);
    expect(JSON.stringify(certo.body)).not.toContain(SENHA);

    const produtos = await request(app)
      .get('/api/v1/core/products')
      .set({ Authorization: `Bearer ${certo.body.accessToken as string}` });
    expect(produtos.status).toBe(403);
    expect(produtos.body.error.code).toBe('API_PASSWORD_CHANGE_REQUIRED');

    expect((await entrar('admin', `${SENHA}x`)).status).toBe(401);
  });
});

describe('subir de novo não muda nada', () => {
  it('mesmo id, mesmo hash, nenhuma linha nova em tabela nenhuma', async () => {
    comAVariavel(SENHA);
    await executarBootstrap({ origem: 'subida' });
    const antes = { contas: contas(), linhas: fotografia() };

    const segunda = await executarBootstrap({ origem: 'subida' });
    expect(segunda.administrador.situacao).toBe('ja_existe');
    expect(segunda.empresasCriadas).toEqual([]);
    expect(contas()).toEqual(antes.contas);
    expect(fotografia()).toEqual(antes.linhas);
  });

  it('o dono trocou a senha e a variável continua lá (até com outro valor): a senha do dono fica', async () => {
    comAVariavel(SENHA);
    await executarBootstrap({ origem: 'subida' });
    const primeiro = await entrar('admin', SENHA);
    const troca = await request(app)
      .post('/api/v1/auth/password')
      .set({ Authorization: `Bearer ${primeiro.body.accessToken as string}` })
      .send({ currentPassword: SENHA, newPassword: 'SoDoDono#2026' });
    expect(troca.status, JSON.stringify(troca.body)).toBe(204);
    const depoisDaTroca = contas()[0];

    for (const valor of [SENHA, OUTRA]) {
      comAVariavel(valor);
      const r = await executarBootstrap({ origem: 'subida' });
      expect(r.administrador).toMatchObject({ situacao: 'ja_existe', variavelSobrando: true });
    }

    expect(contas()).toEqual([depoisDaTroca]);
    const dono = await entrar('admin', 'SoDoDono#2026');
    expect(dono.status).toBe(200);
    expect(dono.body.user.mustChangePassword).toBe(false);
    expect((await entrar('admin', SENHA)).status).toBe(401);
    expect((await entrar('admin', OUTRA)).status).toBe(401);
  });
});

describe('quem já administra, ou já ocupa o login, impede a criação', () => {
  it("'ADMIN' administrador do grupo: 'admin' não nasce ao lado dele, e a senha dele não muda", async () => {
    garantirEstruturaDoGrupo();
    const id = await upsertUser({ login: 'ADMIN', displayName: 'Administrador Grupo Sampaio', password: 'DoEmanuel#2026' });
    vincularEmTodas(id, 'admin_geral');

    comAVariavel(SENHA);
    const r = await executarBootstrap({ origem: 'subida' });

    expect(r.administrador).toMatchObject({ situacao: 'ja_existe', motivo: 'administrador_do_grupo' });
    expect(contas().map((c) => c.login)).toEqual(['ADMIN']);
    expect((db().prepare("SELECT COUNT(*) AS n FROM core_users WHERE login = 'admin' COLLATE NOCASE").get() as { n: number }).n).toBe(1);
    expect((await entrar('ADMIN', 'DoEmanuel#2026')).status).toBe(200);
    expect((await entrar('admin', SENHA)).status).toBe(401);
    expect(contar("core_audit_log WHERE action = 'bootstrap.admin_created'")).toBe(0);
    contamIgual();
  });

  it("'ADMIN' existe mas não administra o grupo: nada é criado nem alterado, e a conferência BLOQUEIA dizendo por quê", async () => {
    garantirEstruturaDoGrupo();
    await upsertUser({ login: 'ADMIN', displayName: 'Administrador Grupo Sampaio', password: 'DoEmanuel#2026' });

    comAVariavel(SENHA);
    const r = await executarBootstrap({ origem: 'subida' });
    expect(r.administrador).toMatchObject({ situacao: 'ja_existe', motivo: 'login_ocupado', login: 'ADMIN' });
    expect(contas().map((c) => c.login)).toEqual(['ADMIN']);
    expect(contar('core_user_companies')).toBe(0);
    contamIgual();

    const item = itemDoAdministrador(conferenciaDeProducao({ DEVORA_BOOTSTRAP_ADMIN_PASSWORD: SENHA }));
    expect(item.estado).toBe('BLOQUEIA');
    expect(item.detalhe).toContain('ADMIN');
    expect(JSON.stringify(item)).not.toContain(SENHA);
  });

  it('outro administrador do grupo (com outro login) basta: admin não nasce', async () => {
    garantirEstruturaDoGrupo();
    const id = await upsertUser({ login: 'EMANUEL', displayName: 'Emanuel', password: 'DoEmanuel#2026' });
    vincularEmTodas(id, 'admin_geral');

    comAVariavel(SENHA);
    const r = await executarBootstrap({ origem: 'subida' });
    expect(r.administrador).toMatchObject({ situacao: 'ja_existe', motivo: 'administrador_do_grupo' });
    expect(contas().map((c) => c.login)).toEqual(['EMANUEL']);
  });

  it('empresa que falta nasce com os administradores e gestores do grupo dentro — ninguém perde o título', async () => {
    garantirEstruturaDoGrupo();
    db().prepare("DELETE FROM core_workshops WHERE company_id = (SELECT id FROM core_companies WHERE slug = 'conceito')").run();
    db().prepare("DELETE FROM core_companies WHERE slug = 'conceito'").run();
    const admin = await upsertUser({ login: 'EMANUEL', displayName: 'Emanuel', password: 'DoEmanuel#2026' });
    const gestor = await upsertUser({ login: 'GERENTE', displayName: 'Gerente', password: 'DoGerente#2026' });
    vincularEmTodas(admin, 'admin_geral');
    vincularEmTodas(gestor, 'gestor');

    const r = await executarBootstrap({ origem: 'subida' });
    expect(r.empresasCriadas).toEqual(['conceito']);
    expect(vinculosDe(admin).find((v) => v.slug === 'conceito')?.profile_code).toBe('admin_geral');
    expect(vinculosDe(gestor).find((v) => v.slug === 'conceito')?.profile_code).toBe('gestor');
    expect(r.administrador).toMatchObject({ situacao: 'ja_existe', motivo: 'administrador_do_grupo' });
  });

  it('empresa que já existe não é tocada — nome, CNPJ, regime, tipo de loja', async () => {
    garantirEstruturaDoGrupo();
    db().prepare(
      "UPDATE core_companies SET trade_name = 'Gringa Store', cnpj = '11222333000181', tax_regime = 'presumido', storefront_preset = NULL, uses_equipment_tags = 0 WHERE slug = 'gringa'",
    ).run();
    await executarBootstrap({ origem: 'subida' });
    expect(db().prepare("SELECT trade_name, cnpj, tax_regime, storefront_preset FROM core_companies WHERE slug = 'gringa'").get()).toEqual({
      trade_name: 'Gringa Store',
      cnpj: '11222333000181',
      tax_regime: 'presumido',
      storefront_preset: null,
    });
  });
});

describe('sem a variável e sem administrador', () => {
  it('não cria conta, avisa no log (sem segredo), e a conferência BLOQUEIA com o que fazer', async () => {
    let r: Awaited<ReturnType<typeof executarBootstrap>> | undefined;
    const saida = await capturarSaida(async () => {
      r = await executarBootstrap({ origem: 'subida' });
    });

    expect(r?.administrador.situacao).toBe('sem_senha');
    expect(contar('core_users')).toBe(0);
    expect(contar('core_companies')).toBe(6);
    expect(saida).toContain('DEVORA_BOOTSTRAP_ADMIN_PASSWORD');

    const item = itemDoAdministrador(conferenciaDeProducao());
    expect(item.titulo).toBe('Administrador inicial');
    expect(item.estado).toBe('BLOQUEIA');
    expect(item.comoResolver).toContain('DEVORA_BOOTSTRAP_ADMIN_PASSWORD');
    expect(item.comoResolver).toMatch(/troque a senha/i);
    expect(item.comoResolver).toMatch(/apague a vari[aá]vel/i);
  });

  it('com a variável definida e o banco ainda sem administrador, a conferência não bloqueia: a subida cria', () => {
    const item = itemDoAdministrador(conferenciaDeProducao({ DEVORA_BOOTSTRAP_ADMIN_PASSWORD: SENHA }));
    expect(item.estado).not.toBe('BLOQUEIA');
    expect(JSON.stringify(item)).not.toContain(SENHA);
  });

  it('com administrador e a variável ainda no ambiente: atenção — apague a variável', async () => {
    comAVariavel(SENHA);
    await executarBootstrap({ origem: 'subida' });
    const item = itemDoAdministrador(conferenciaDeProducao({ DEVORA_BOOTSTRAP_ADMIN_PASSWORD: SENHA }));
    expect(item.estado).toBe('ATENCAO');
    expect(item.comoResolver).toMatch(/apague/i);
    expect(JSON.stringify(item)).not.toContain(SENHA);
    expect(itemDoAdministrador(conferenciaDeProducao()).estado).toBe('OK');
  });
});

describe('a senha nunca aparece', () => {
  it('nem no log, nem na saída, nem na auditoria, nem na marca, nem no relatório do comando', async () => {
    comAVariavel(SENHA);
    let linhas: string[] = [];
    const saida = await capturarSaida(async () => {
      const r = await executarBootstrap({ origem: 'comando' });
      linhas = relatorioDoBootstrap(r);
      for (const l of linhas) console.log(l);
      linhas = [...linhas, ...relatorioDoBootstrap(await executarBootstrap({ origem: 'comando' }))];
    });
    expect(saida.length).toBeGreaterThan(0);
    expect(saida).not.toContain(SENHA);
    expect(linhas.join('\n')).not.toContain(SENHA);
    expect(linhas.join('\n')).toMatch(/troca/i);

    const trilha = db().prepare('SELECT action, entity_id, detail FROM core_audit_log').all();
    expect(JSON.stringify(trilha)).not.toContain(SENHA);
    const meta = db().prepare('SELECT key, value FROM core_meta').all();
    expect(JSON.stringify(meta)).not.toContain(SENHA);
  });

  it('nem na conferência pela rota, com a variável definida', async () => {
    comAVariavel(SENHA);
    const dono = await loginForTest(app, { userId: 'dono-boot', companyId: 'loja-boot', profileCodes: ['admin_geral'] });
    const res = await request(app)
      .get('/api/v1/system/implantacao')
      .set({ Authorization: `Bearer ${dono.body.accessToken as string}`, 'X-Forwarded-Proto': 'https' });
    expect(res.status).toBe(200);
    expect(res.body.itens.map((i: { id: string }) => i.id)).toContain('administrador_inicial');
    expect(JSON.stringify(res.body)).not.toContain(SENHA);
  });
});

describe('senha recusada — antes de criar qualquer coisa', () => {
  it('curta demais', async () => {
    comAVariavel('curta');
    await expect(executarBootstrap({ origem: 'subida' })).rejects.toBeInstanceOf(BootstrapRecusado);
    await expect(executarBootstrap({ origem: 'subida' })).rejects.toThrow(/8 caracteres/);
    expect(contar('core_users')).toBe(0);
    expect(contar('core_companies')).toBe(0);
  });

  it.each([
    ['production', undefined],
    ['staging', undefined],
    ['test', 'production'],
  ])('a senha de desenvolvimento publicada, em DEVORA_API_ENV=%s / NODE_ENV=%s', async (apiEnv, nodeEnv) => {
    process.env.DEVORA_API_ENV = apiEnv;
    if (nodeEnv) process.env.NODE_ENV = nodeEnv;
    process.env.DEVORA_JWT_SECRET = 'segredo-de-teste-longo-o-bastante-para-producao-0123456789';
    process.env.DEVORA_ENCRYPTION_KEY = 'chave-de-cifra-de-teste-longa-o-bastante-0123456789';
    delete process.env.DEVORA_DEV_QUICK_LOGIN;
    for (const publicada of ['admin@123', 'Senha@123', 'Admin@123']) {
      comAVariavel(publicada);
      let erro: unknown;
      const saida = await capturarSaida(async () => {
        try {
          await executarBootstrap({ origem: 'subida' });
        } catch (e) {
          erro = e;
        }
      });
      expect(erro, publicada).toBeInstanceOf(BootstrapRecusado);
      expect((erro as Error).message).not.toContain(publicada);
      expect(saida).not.toContain(publicada);
    }
    expect(contar('core_users')).toBe(0);
  });
});

describe('onde o bootstrap roda', () => {
  it('a subida o chama depois de preparar o banco e antes de abrir a porta', () => {
    const boot = readFileSync(join(SERVIDOR, 'src/index.ts'), 'utf8');
    const corpo = boot.slice(boot.indexOf('export async function startServer'));
    const prepara = corpo.indexOf('prepararBanco()');
    const bootstrap = corpo.indexOf('executarBootstrap(');
    expect(prepara).toBeGreaterThan(-1);
    expect(bootstrap).toBeGreaterThan(prepara);
    expect(bootstrap).toBeLessThan(corpo.indexOf('createApp()'));
  });

  it('npm run db:seed é o MESMO comando do db:bootstrap — e o de demonstração tem nome próprio', () => {
    const scripts = (JSON.parse(readFileSync(join(SERVIDOR, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts;
    expect(scripts['db:bootstrap']).toBe('tsx src/db/bootstrap-cli.ts');
    expect(scripts['db:seed']).toBe(scripts['db:bootstrap']);
    expect(scripts['db:seed:dev']).toBe('tsx src/db/seedDeDesenvolvimento-cli.ts');
    // O caminho de produção não importa o de demonstração.
    for (const arquivo of ['src/db/bootstrap.ts', 'src/db/bootstrap-cli.ts', 'src/db/seed-cli.ts', 'src/index.ts']) {
      expect(readFileSync(join(SERVIDOR, arquivo), 'utf8'), arquivo).not.toMatch(/seedDeDesenvolvimento/);
    }
  });
});

describe('o comando, de verdade (npm run db:bootstrap / db:seed)', () => {
  const TSX = join(SERVIDOR, 'node_modules', 'tsx', 'dist', 'cli.mjs');

  function rodar(banco: string, extra: Record<string, string>): { codigo: number; saida: string } {
    try {
      const saida = execFileSync(process.execPath, [TSX, 'src/db/bootstrap-cli.ts'], {
        cwd: SERVIDOR,
        env: {
          PATH: process.env.PATH ?? '',
          SystemRoot: process.env.SystemRoot ?? '',
          DEVORA_IGNORE_DOTENV: 'true',
          DEVORA_API_ENV: 'test',
          DEVORA_DATABASE_PATH: banco,
          TEST_DATABASE_PATH: banco,
          DEVORA_BACKUP_DIR: join(dirname(banco), 'backups'),
          ...extra,
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { codigo: 0, saida };
    } catch (erro) {
      const e = erro as { status?: number; stdout?: string; stderr?: string };
      return { codigo: e.status ?? -1, saida: `${e.stdout ?? ''}\n${e.stderr ?? ''}` };
    }
  }

  it('banco vazio: cria as seis e o admin, sem imprimir a senha; de novo, sem a variável, não muda nada', () => {
    const pasta = mkdtempSync(join(tmpdir(), 'gs-bootstrap-cli-'));
    const banco = join(pasta, 'bootstrap.db');
    try {
      const primeira = rodar(banco, { DEVORA_BOOTSTRAP_ADMIN_PASSWORD: SENHA });
      expect(primeira.codigo, primeira.saida).toBe(0);
      expect(primeira.saida).not.toContain(SENHA);
      expect(primeira.saida).toMatch(/admin/);

      const ler = () => {
        const d = new DatabaseSync(banco, { readOnly: true });
        try {
          return {
            contas: d.prepare('SELECT id, login, password_hash, must_change_password FROM core_users').all(),
            empresas: (d.prepare('SELECT COUNT(*) AS n FROM core_companies').get() as { n: number }).n,
          };
        } finally {
          d.close();
        }
      };
      const antes = ler();
      expect(antes.empresas).toBe(6);
      expect(antes.contas).toHaveLength(1);
      expect(antes.contas[0]).toMatchObject({ login: 'admin', must_change_password: 1 });

      const segunda = rodar(banco, {});
      expect(segunda.codigo, segunda.saida).toBe(0);
      expect(ler()).toEqual(antes);
    } finally {
      rmSync(pasta, { recursive: true, force: true });
    }
    expect(existsSync(banco)).toBe(false);
  }, 180_000);
});
