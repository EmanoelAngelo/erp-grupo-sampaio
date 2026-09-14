process.env.TZ = 'UTC';
process.env.DEVORA_API_ENV = 'test';

/**
 * ============================================================================
 * OS LOGINS PADRÃO DO GRUPO — nascem no bootstrap, e cada um só entra onde deve
 * ============================================================================
 *
 * Sem o acesso rápido, o dono precisa entrar em cada parte do sistema com uma
 * conta de verdade desde o primeiro dia. O bootstrap cria, além do `admin`, as
 * 14 contas padrão (`db/loginsPadrao.ts`), com a senha provisória de
 * `DEVORA_BOOTSTRAP_LOGINS_PASSWORD`. Aqui se prova, pela API:
 *
 *   - quem nasce, com o nome exato, a empresa e o modelo certos, provisória e
 *     em Argon2id — e sem a senha em lugar nenhum;
 *   - a busca amigável do login (maiúscula e espaço por fora não contam; o
 *     acento conta);
 *   - a matriz de acesso: PDV só no PDV da própria operação; o gestor só no
 *     painel da própria empresa; as bancadas da Oficina só no quadro delas; o
 *     `admin` em tudo — e 403 do SERVIDOR em todo o resto;
 *   - o segundo bootstrap: não duplica, não reseta senha trocada, não desfaz
 *     personalização; e sem a variável, nenhuma conta padrão nasce.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { getConnection } from '../src/db/sqlite.js';
import { resetDbForTests } from '../src/db/database.js';
import { resetEnvCacheForTests } from '../src/config/env.js';
import { BootstrapRecusado, executarBootstrap, relatorioDoBootstrap, type ResultadoDoBootstrap } from '../src/db/bootstrap.js';
import { LOGINS_PADRAO } from '../src/db/loginsPadrao.js';
import { personalizarVinculo } from '../src/services/auth/AcessoService.js';

const app = createApp();
const SENHA_ADMIN = 'Admin#Inicial-2026';
const SENHA_LOGINS = 'Logins#Padrao-2026';
/** A senha definitiva de cada conta nos testes (derivada do login, nunca a provisória). */
const definitiva = (login: string) => `Troca#${Buffer.from(login, 'utf8').toString('hex').slice(0, 16)}9a`;

const ENV_ORIGINAL = { ...process.env };
function restaurarAmbiente(): void {
  for (const chave of Object.keys(process.env)) if (!(chave in ENV_ORIGINAL)) delete process.env[chave];
  Object.assign(process.env, ENV_ORIGINAL);
  resetEnvCacheForTests();
}
function comAsVariaveis(admin: string | undefined, logins: string | undefined): void {
  if (admin === undefined) delete process.env.DEVORA_BOOTSTRAP_ADMIN_PASSWORD;
  else process.env.DEVORA_BOOTSTRAP_ADMIN_PASSWORD = admin;
  if (logins === undefined) delete process.env.DEVORA_BOOTSTRAP_LOGINS_PASSWORD;
  else process.env.DEVORA_BOOTSTRAP_LOGINS_PASSWORD = logins;
  resetEnvCacheForTests();
}

const portador = (token: string) => ({ Authorization: `Bearer ${token}` });
const LOGINS = ['admin', ...LOGINS_PADRAO.map((l) => l.login)];
const PDVS = LOGINS_PADRAO.filter((l) => l.papel === 'pdv');
const GESTORES = LOGINS_PADRAO.filter((l) => l.papel === 'gestor');

let primeira: ResultadoDoBootstrap;
let empresas: Record<string, string>;

function entrar(login: string, password: string, companyId?: string) {
  return request(app).post('/api/v1/auth/login').send({ login, password, ...(companyId ? { companyId } : {}) });
}

/** A troca obrigatória do primeiro acesso, pela API — como a pessoa faria. */
async function trocarAProvisoria(login: string): Promise<void> {
  const provisoria = login === 'admin' ? SENHA_ADMIN : SENHA_LOGINS;
  const r = await entrar(login, provisoria);
  expect(r.status, `${login}: ${JSON.stringify(r.body)}`).toBe(200);
  expect(r.body.user.mustChangePassword).toBe(true);
  const troca = await request(app)
    .post('/api/v1/auth/password')
    .set(portador(r.body.accessToken))
    .send({ currentPassword: provisoria, newPassword: definitiva(login) });
  expect(troca.status, `${login}: ${JSON.stringify(troca.body)}`).toBe(204);
}

async function sessao(login: string, empresa?: string) {
  const r = await entrar(login, definitiva(login), empresa ? empresas[empresa] : undefined);
  expect(r.status, `${login}@${empresa ?? 'padrão'}: ${JSON.stringify(r.body)}`).toBe(200);
  return r.body as { accessToken: string; company: { slug: string }; companies: { slug: string }[] };
}

async function statusDe(token: string, caminhos: string[]) {
  const saida: Record<string, number> = {};
  for (const c of caminhos) saida[c] = (await request(app).get(`/api/v1${c}`).set(portador(token))).status;
  return saida;
}

beforeAll(async () => {
  resetDbForTests();
  comAsVariaveis(SENHA_ADMIN, SENHA_LOGINS);
  primeira = await executarBootstrap();
  empresas = Object.fromEntries(
    (getConnection().prepare('SELECT slug, id FROM core_companies').all() as { slug: string; id: string }[]).map((e) => [e.slug, e.id]),
  );
  for (const login of LOGINS) await trocarAProvisoria(login);
}, 180_000);

afterAll(restaurarAmbiente);

describe('o bootstrap cria o admin e os 14 logins padrão', () => {
  it('cada conta com o nome exato, a empresa e o modelo dela — e só ela', () => {
    expect(primeira.administrador.situacao).toBe('criado');
    expect(primeira.loginsPadrao?.criados).toEqual(LOGINS_PADRAO.map((l) => l.login));
    expect(primeira.loginsPadrao?.pulados).toEqual([]);

    const db = getConnection();
    const contas = db.prepare('SELECT login, display_name, hash_algorithm, substr(password_hash, 1, 10) AS inicio FROM core_users ORDER BY login').all() as {
      login: string; display_name: string; hash_algorithm: string; inicio: string;
    }[];
    expect(contas.map((c) => c.login).sort()).toEqual([...LOGINS].sort());
    for (const c of contas) {
      expect(c.inicio).toBe('$argon2id$');
      if (c.login !== 'admin') expect(c.display_name).toBe(c.login);
    }

    const vinculos = db.prepare(
      `SELECT c.slug, uc.profile_code FROM core_user_companies uc
         JOIN core_companies c ON c.id = uc.company_id JOIN core_users u ON u.id = uc.user_id WHERE u.login = ?`,
    );
    for (const l of LOGINS_PADRAO) {
      expect({ login: l.login, vinculos: vinculos.all(l.login) }).toEqual({
        login: l.login,
        vinculos: [{ slug: l.empresa, profile_code: l.modelo }],
      });
    }
    expect((vinculos.all('admin') as { profile_code: string }[]).map((v) => v.profile_code)).toEqual(Array(6).fill('admin_geral'));

    const bancadas = db.prepare(
      `SELECT w.slug FROM core_workshop_members m JOIN core_workshops w ON w.id = m.workshop_id
         JOIN core_users u ON u.id = m.user_id WHERE u.login = ?`,
    );
    expect(bancadas.all('OFICINA-PJ MOTORS')).toEqual([{ slug: 'oficina-mobilidade' }]);
    expect(bancadas.all('OFICINA-PREÇO JUSTO')).toEqual([{ slug: 'oficina-celulares' }]);
  });

  it('a senha não está no banco, na auditoria nem no relatório', () => {
    const db = getConnection();
    const hashes = (db.prepare('SELECT password_hash FROM core_users').all() as { password_hash: string }[]).map((r) => r.password_hash);
    const trilha = (db.prepare("SELECT detail FROM core_audit_log WHERE action LIKE 'bootstrap.%'").all() as { detail: string }[]).map((r) => r.detail);
    const texto = [...hashes, ...trilha, ...relatorioDoBootstrap(primeira)].join('\n');
    for (const s of [SENHA_ADMIN, SENHA_LOGINS]) expect(texto.includes(s)).toBe(false);
    expect(trilha.length).toBe(15);
  });
});

describe('o login é amigável: maiúscula e espaço por fora não contam; o acento conta', () => {
  it.each([
    ['preço justo', 200],
    ['  PREÇO JUSTO  ', 200],
    ['Preço Justo', 200],
    ['admin-pj motors', 200],
    ['oficina-preço justo', 200],
    ['PRECO JUSTO', 401],
  ])('"%s" → %i', async (digitado, esperado) => {
    const alvo = LOGINS_PADRAO.find((l) => l.login.toLocaleLowerCase('pt-BR') === digitado.trim().toLocaleLowerCase('pt-BR'));
    const r = await entrar(digitado, definitiva(alvo?.login ?? 'PREÇO JUSTO'));
    expect(r.status, JSON.stringify(r.body)).toBe(esperado);
  });
});

describe('a matriz de acesso, pela API — o servidor decide', () => {
  it('cada PDV: o PDV da própria operação abre; painel, usuários e as outras operações dão 403', async () => {
    for (const l of PDVS) {
      const s = await sessao(l.login);
      expect({ login: l.login, empresa: s.company.slug, empresas: s.companies.map((c) => c.slug) }).toEqual({
        login: l.login, empresa: l.empresa, empresas: [l.empresa],
      });
      expect({ login: l.login, ...(await statusDe(s.accessToken, ['/core/cash/open', '/core/dashboard', '/core/team', '/acesso/catalogo'])) }).toEqual({
        login: l.login, '/core/cash/open': 200, '/core/dashboard': 403, '/core/team': 403, '/acesso/catalogo': 403,
      });
      for (const outra of Object.keys(empresas).filter((e) => e !== l.empresa)) {
        expect({ login: l.login, outra, status: (await entrar(l.login, definitiva(l.login), empresas[outra])).status })
          .toEqual({ login: l.login, outra, status: 403 });
      }
    }
  }, 120_000);

  it('cada ADMIN-<operação>: o painel e os usuários da própria empresa abrem; as outras empresas dão 403', async () => {
    for (const l of GESTORES) {
      const s = await sessao(l.login);
      expect({ login: l.login, empresas: s.companies.map((c) => c.slug) }).toEqual({ login: l.login, empresas: [l.empresa] });
      expect({ login: l.login, ...(await statusDe(s.accessToken, ['/core/dashboard', '/core/team', '/acesso/catalogo'])) }).toEqual({
        login: l.login, '/core/dashboard': 200, '/core/team': 200, '/acesso/catalogo': 200,
      });
      for (const outra of Object.keys(empresas).filter((e) => e !== l.empresa)) {
        expect({ login: l.login, outra, status: (await entrar(l.login, definitiva(l.login), empresas[outra])).status })
          .toEqual({ login: l.login, outra, status: 403 });
      }
    }
  }, 120_000);

  it('OFICINA-PJ MOTORS: o quadro da Oficina abre; administração, painel e a PJ Motors dão 403', async () => {
    const s = await sessao('OFICINA-PJ MOTORS');
    expect(s.companies.map((c) => c.slug)).toEqual(['oficina']);
    expect(await statusDe(s.accessToken, ['/core/workshop/orders', '/core/dashboard', '/core/team', '/acesso/catalogo'])).toEqual({
      '/core/workshop/orders': 200, '/core/dashboard': 403, '/core/team': 403, '/acesso/catalogo': 403,
    });
    expect((await entrar('OFICINA-PJ MOTORS', definitiva('OFICINA-PJ MOTORS'), empresas['pj-motors'])).status).toBe(403);
  });

  it('OFICINA-PREÇO JUSTO: o quadro da Oficina de Celulares abre; administração, painel e fiscal da Preço Justo dão 403', async () => {
    const s = await sessao('OFICINA-PREÇO JUSTO');
    expect(s.companies.map((c) => c.slug)).toEqual(['preco-justo']);
    expect(await statusDe(s.accessToken, ['/core/workshop/orders', '/core/dashboard', '/core/team', '/core/fiscal/config'])).toEqual({
      '/core/workshop/orders': 200, '/core/dashboard': 403, '/core/team': 403, '/core/fiscal/config': 403,
    });
    expect((await entrar('OFICINA-PREÇO JUSTO', definitiva('OFICINA-PREÇO JUSTO'), empresas.oficina)).status).toBe(403);
  });

  it('admin: entra nas seis empresas, e o painel, os usuários e o fiscal abrem em todas', async () => {
    for (const empresa of Object.keys(empresas)) {
      const s = await sessao('admin', empresa);
      expect({ empresa, ...(await statusDe(s.accessToken, ['/core/dashboard', '/core/team', '/core/fiscal/config', '/core/cash/open'])) }).toEqual({
        empresa, '/core/dashboard': 200, '/core/team': 200, '/core/fiscal/config': 200, '/core/cash/open': 200,
      });
    }
  }, 60_000);
});

describe('o segundo bootstrap', () => {
  it('não duplica, não reseta a senha trocada e não desfaz a personalização', async () => {
    const db = getConnection();
    const antes = db.prepare('SELECT login, password_hash, must_change_password FROM core_users ORDER BY login').all();
    const gringa = db.prepare("SELECT u.id FROM core_users u WHERE u.login = 'ADMIN-GRINGA'").get() as { id: string };
    personalizarVinculo({ atorId: null, userId: gringa.id, companyId: empresas.gringa!, revokes: ['fiscal.view'], origem: 'api' });

    comAsVariaveis('Outra#Senha-2026', 'Mais#Uma-Senha-2026');
    const segunda = await executarBootstrap();
    expect(segunda.administrador.situacao).toBe('ja_existe');
    expect(segunda.loginsPadrao).toMatchObject({ criados: [], pulados: [], semSenha: false, variavelSobrando: true });
    expect(segunda.loginsPadrao?.existentes.length).toBe(14);

    expect(db.prepare('SELECT login, password_hash, must_change_password FROM core_users ORDER BY login').all()).toEqual(antes);
    expect(db.prepare("SELECT effect FROM core_user_company_capabilities WHERE capability = 'fiscal.view'").all()).toEqual([{ effect: 'revoke' }]);
    expect((db.prepare("SELECT count(*) AS n FROM core_audit_log WHERE action = 'bootstrap.login_padrao_criado'").get() as { n: number }).n).toBe(14);
    // E a senha definitiva continua sendo a que vale.
    expect((await entrar('GRINGA', definitiva('GRINGA'))).status).toBe(200);
    comAsVariaveis(SENHA_ADMIN, SENHA_LOGINS);
  }, 60_000);
});

describe('sem a variável dos logins, e com senha fraca', () => {
  it('sem DEVORA_BOOTSTRAP_LOGINS_PASSWORD: nasce só o admin, e o relatório diz o que falta', async () => {
    resetDbForTests();
    comAsVariaveis(SENHA_ADMIN, undefined);
    const r = await executarBootstrap();
    expect(r.administrador.situacao).toBe('criado');
    expect(r.loginsPadrao).toMatchObject({ criados: [], semSenha: true });
    expect((getConnection().prepare('SELECT count(*) AS n FROM core_users').get() as { n: number }).n).toBe(1);
    expect(relatorioDoBootstrap(r).join('\n')).toContain('DEVORA_BOOTSTRAP_LOGINS_PASSWORD');
  }, 60_000);

  it('senha fraca para os logins: recusa antes de criar qualquer coisa', async () => {
    resetDbForTests();
    comAsVariaveis(SENHA_ADMIN, 'curta');
    await expect(executarBootstrap()).rejects.toBeInstanceOf(BootstrapRecusado);
    expect((getConnection().prepare('SELECT count(*) AS n FROM core_users').get() as { n: number }).n).toBe(0);
    comAsVariaveis(SENHA_ADMIN, SENHA_LOGINS);
  }, 60_000);
});
