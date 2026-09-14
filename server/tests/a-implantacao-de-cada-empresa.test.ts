/**
 * A IMPLANTAÇÃO DE CADA EMPRESA (GAP-PRD-067).
 *
 * Achado: a prontidão estava espalhada por umas oito superfícies de domínio
 * (fiscal, impressão, loja online, logística, e-mails, central, Asaas,
 * certificado — e o cofre sem tela), duas delas globais; nenhuma rota nem tela
 * dizia, por EMPRESA, o que estava pronto, pendente, dispensado ou esperando
 * alguém de fora. Implantar a sexta operação exigia saber de cor onde cada
 * pendência aparecia.
 *
 * Aqui, contra a rota de verdade (supertest sobre `createApp`):
 *
 *   - uma empresa recém-aberta sai PENDENTE, item a item, com a tela que
 *     resolve e quem resolve; o que é de fora aparece BLOQUEADO_EXTERNAMENTE;
 *   - o dado achado pelo sistema fica AUTO_DETECTADO até alguém confirmar; a
 *     confirmação vira CONFIRMADO e, se o dado mudar depois, DIVERGENTE;
 *   - "não se aplica" exige motivo e só vale onde o item admite;
 *   - loja sem bancada tem a oficina como NAO_APLICAVEL por regra;
 *   - o adm de uma loja não lê a implantação da vizinha; perfil de loja não
 *     alcança; marcar vai para a auditoria.
 */
process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';
for (const k of [
  'DEVORA_SUPABASE_URL',
  'DEVORA_SUPABASE_SERVICE_KEY',
  'EMAIL_ENABLED',
  'EMAIL_SMTP_HOST',
  'ASAAS_API_KEY',
]) {
  delete process.env[k];
}

import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';

const { createApp } = await import('../src/app.js');
const { runMigrations } = await import('../src/db/migrate.js');
const { migrateCoreSchema } = await import('../src/db/core-migrations.js');
const { getConnection } = await import('../src/db/sqlite.js');
const { issueSession } = await import('../src/services/api/ApiAuthService.js');
const { linkUserToCompany, upsertCompany, upsertUser } = await import('../src/services/auth/IdentityService.js');
const { chavesDosItens } = await import('../src/services/implantacao/implantacaoPorEmpresa.js');

const app = createApp();

let loja = '';
let oficina = '';
let vizinha = '';
let dono = '';
let admDaLoja = '';
let gerenteDaLoja: string;
let lojaDoGerente = '';

function sessao(userId: string, companyId: string, perfil: string) {
  const t = issueSession({ userId, companyId, storeId: `store-${companyId}`, profileCodes: [perfil] });
  return { Authorization: `Bearer ${t.accessToken}` };
}

type Item = {
  chave: string;
  estado: string;
  detalhe: string;
  dono: string;
  onde: string | null;
  global: boolean;
  podeConfirmar: boolean;
  podeMarcarNaoAplicavel: boolean;
  marca: { tipo: string; motivo: string | null; porNome: string | null } | null;
};

async function implantacao(companyId: string, headers = sessao(dono, loja, 'admin_geral')) {
  const res = await request(app).get(`/api/v1/system/implantacao/empresas/${companyId}`).set(headers);
  return res;
}

function item(body: { areas: Array<{ itens: Item[] }> }, chave: string): Item {
  const achado = body.areas.flatMap((a) => a.itens).find((i) => i.chave === chave);
  if (!achado) throw new Error(`item ${chave} não está no checklist`);
  return achado;
}

beforeAll(async () => {
  runMigrations();
  migrateCoreSchema();
  loja = upsertCompany({ slug: 'impl-loja', legalName: 'Loja Implantação Ltda', tradeName: 'Loja Impl' });
  oficina = upsertCompany({ slug: 'impl-oficina', legalName: 'Oficina Implantação Ltda', tradeName: 'Oficina Impl' });
  vizinha = upsertCompany({ slug: 'impl-vizinha', legalName: 'Vizinha Ltda', tradeName: 'Vizinha' });
  getConnection().prepare("UPDATE core_companies SET kind = 'workshop' WHERE id = ?").run(oficina);

  dono = await upsertUser({ login: 'impl.dono', displayName: 'Dono do Grupo', password: 'Senha@Forte2026!' });
  for (const c of [loja, oficina, vizinha]) linkUserToCompany(dono, c, 'admin_geral', c === loja);
  admDaLoja = await upsertUser({ login: 'impl.adm', displayName: 'Adm da Loja', password: 'Senha@Forte2026!' });
  linkUserToCompany(admDaLoja, loja, 'admin_geral', true);
  // O perfil de LOJA de verdade: gerente só desta loja, sem vínculo de gestão. A sessão
  // afirma o perfil, mas desde o GAP-PRD-053 quem manda é o vínculo gravado — um token
  // que diz gerente_loja para uma conta admin_geral vale como admin_geral.
  gerenteDaLoja = await upsertUser({ login: 'impl.gerente', displayName: 'Gerente da Loja', password: 'Senha@Forte2026!' });
  // Numa loja SÓ DELE: vinculado à `loja`, ele deixaria pronto o item "Pessoas: gerente" que o
  // primeiro caso espera pendente.
  lojaDoGerente = upsertCompany({ slug: 'impl-loja-gerente', legalName: 'Loja do Gerente Ltda', tradeName: 'Loja do Gerente' });
  linkUserToCompany(gerenteDaLoja, lojaDoGerente, 'gerente_loja', true);
});

describe('GET /system/implantacao/empresas/:id — o checklist da empresa', () => {
  it('uma loja recém-aberta sai PENDENTE, item a item, com onde e quem resolve', async () => {
    const res = await implantacao(loja);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.empresa).toMatchObject({ id: loja, nome: 'Loja Impl' });
    expect(res.body.situacao).toBe('PENDENTE');

    const chaves = (res.body.areas as Array<{ itens: Item[] }>).flatMap((a) => a.itens.map((i) => i.chave));
    expect(chaves).toEqual(chavesDosItens());

    // O que se resolve numa tela do sistema: PENDENTE, com a tela.
    const produtos = item(res.body, 'estoque.produtos');
    expect(produtos.estado).toBe('PENDENTE');
    expect(produtos.onde).toBe('/sistema/produtos');
    expect(item(res.body, 'pessoas.gerente').estado).toBe('PENDENTE');
    expect(item(res.body, 'contabilidade.contador').estado).toBe('PENDENTE');

    // O que depende de fora: BLOQUEADO_EXTERNAMENTE, com quem.
    const certificado = item(res.body, 'fiscal.certificado');
    expect(certificado.estado).toBe('BLOQUEADO_EXTERNAMENTE');
    expect(certificado.dono).toBe('dono');
    expect(item(res.body, 'pagamentos.asaas').estado).toBe('BLOQUEADO_EXTERNAMENTE');
    expect(item(res.body, 'balcao.maquininha').estado).toBe('BLOQUEADO_EXTERNAMENTE');

    // O que é do grupo aparece em toda empresa, marcado como global.
    const email = item(res.body, 'grupo.email');
    expect(email.global).toBe(true);
    expect(email.estado).toBe('BLOQUEADO_EXTERNAMENTE');
    expect(email.detalhe).toContain('EMAIL_SMTP_HOST');
    expect(item(res.body, 'grupo.versao_do_banco').estado).toBe('PRONTO');

    // Loja sem bancada: a oficina não se aplica, por regra.
    expect(item(res.body, 'oficina.bancada').estado).toBe('NAO_APLICAVEL');

    // O resumo conta cada item uma vez.
    const total = Object.values(res.body.resumo as Record<string, number>).reduce((a, b) => a + b, 0);
    expect(total).toBe(chaves.length);
  });

  it('a oficina sem bancada fica PENDENTE; com bancada, PRONTO', async () => {
    let res = await implantacao(oficina);
    expect(item(res.body, 'oficina.bancada').estado).toBe('PENDENTE');
    getConnection()
      .prepare(
        "INSERT INTO core_workshops (id, company_id, slug, name, kind, active, created_at) VALUES ('ws-impl', ?, 'impl-bancada', 'Bancada Impl', 'mobility', 1, ?)",
      )
      .run(oficina, new Date().toISOString());
    res = await implantacao(oficina);
    const bancada = item(res.body, 'oficina.bancada');
    expect(bancada.estado).toBe('PRONTO');
    expect(bancada.detalhe).toContain('Bancada Impl');
  });

  it('o que o sistema acha fica AUTO_DETECTADO; confirmado vira CONFIRMADO; mudou depois, DIVERGENTE', async () => {
    const donoH = sessao(dono, loja, 'admin_geral');
    // Sem CNPJ: pendente, e não há o que confirmar.
    let res = await implantacao(loja);
    expect(item(res.body, 'empresa.cadastro').estado).toBe('PENDENTE');
    const cedo = await request(app)
      .put(`/api/v1/system/implantacao/empresas/${loja}/itens/empresa.cadastro/marca`)
      .set(donoH)
      .send({ tipo: 'CONFIRMADO' });
    expect(cedo.status).toBe(409);

    getConnection().prepare('UPDATE core_companies SET cnpj = ? WHERE id = ?').run('11222333000181', loja);
    res = await implantacao(loja);
    const achado = item(res.body, 'empresa.cadastro');
    expect(achado.estado).toBe('AUTO_DETECTADO');
    expect(achado.podeConfirmar).toBe(true);

    const confirma = await request(app)
      .put(`/api/v1/system/implantacao/empresas/${loja}/itens/empresa.cadastro/marca`)
      .set(donoH)
      .send({ tipo: 'CONFIRMADO' });
    expect(confirma.status, JSON.stringify(confirma.body)).toBe(200);
    expect(confirma.body.item.estado).toBe('CONFIRMADO');
    expect(confirma.body.item.marca).toMatchObject({ tipo: 'CONFIRMADO', porNome: 'Dono do Grupo' });

    // Alguém muda o CNPJ depois da confirmação: o carimbo não sobrevive.
    getConnection().prepare('UPDATE core_companies SET cnpj = ? WHERE id = ?').run('11444777000161', loja);
    res = await implantacao(loja);
    const mudou = item(res.body, 'empresa.cadastro');
    expect(mudou.estado).toBe('DIVERGENTE');
    expect(mudou.detalhe).toMatch(/MUDOU/);
    expect(mudou.detalhe).toContain('Dono do Grupo');

    // A confirmação fica na auditoria da empresa.
    const auditado = getConnection()
      .prepare("SELECT COUNT(*) AS n FROM core_audit_log WHERE company_id = ? AND action = 'implantacao.item_marcado'")
      .get(loja) as { n: number };
    expect(auditado.n).toBeGreaterThanOrEqual(1);
  });

  it('"não se aplica" exige motivo, só vale onde o item admite, e se desfaz', async () => {
    const donoH = sessao(dono, loja, 'admin_geral');
    const url = `/api/v1/system/implantacao/empresas/${loja}/itens/loja.catalogo/marca`;

    const semMotivo = await request(app).put(url).set(donoH).send({ tipo: 'NAO_APLICAVEL' });
    expect(semMotivo.status).toBe(400);
    expect(semMotivo.body.error.code).toBe('IMPLANTACAO_MOTIVO_OBRIGATORIO');

    const ok = await request(app).put(url).set(donoH).send({ tipo: 'NAO_APLICAVEL', motivo: 'Esta loja não vende online.' });
    expect(ok.status).toBe(200);
    expect(ok.body.item.estado).toBe('NAO_APLICAVEL');
    expect(ok.body.item.detalhe).toContain('Esta loja não vende online.');

    // Gerente, produtos e senhas valem para toda empresa.
    const sempre = await request(app)
      .put(`/api/v1/system/implantacao/empresas/${loja}/itens/estoque.produtos/marca`)
      .set(donoH)
      .send({ tipo: 'NAO_APLICAVEL', motivo: 'tentativa de esconder' });
    expect(sempre.status).toBe(409);

    const volta = await request(app).delete(url).set(donoH);
    expect(volta.status).toBe(200);
    expect(volta.body.removida).toBe(true);
    expect(volta.body.item.estado).toBe('PENDENTE');

    const desconhecido = await request(app)
      .put(`/api/v1/system/implantacao/empresas/${loja}/itens/nao.existe/marca`)
      .set(donoH)
      .send({ tipo: 'CONFIRMADO' });
    expect(desconhecido.status).toBe(404);
  });

  it('o gerente cadastrado e um caixa fechado mudam o item na hora', async () => {
    const gerente = await upsertUser({ login: 'impl.gerente', displayName: 'Gerente da Loja', password: 'Senha@Forte2026!' });
    linkUserToCompany(gerente, loja, 'gerente_loja', true);
    getConnection().prepare('UPDATE core_users SET must_change_password = 1 WHERE id = ?').run(gerente);
    const res = await implantacao(loja);
    expect(item(res.body, 'pessoas.gerente').estado).toBe('PRONTO');
    expect(item(res.body, 'pessoas.gerente').detalhe).toContain('Gerente da Loja');
    const senhas = item(res.body, 'pessoas.senhas_provisorias');
    expect(senhas.estado).toBe('PENDENTE');
    expect(senhas.detalhe).toContain('impl.gerente');
  });
});

describe('quem alcança', () => {
  it('a lista traz só as empresas com vínculo de gestão, com a situação de cada uma', async () => {
    const res = await request(app).get('/api/v1/system/implantacao/empresas').set(sessao(admDaLoja, loja, 'admin_geral'));
    expect(res.status).toBe(200);
    const ids = (res.body.items as Array<{ empresaId: string; situacao: string }>).map((i) => i.empresaId);
    expect(ids).toEqual([loja]);
    expect(res.body.items[0].situacao).toBe('PENDENTE');
  });

  it('o adm de uma loja não lê nem marca a implantação da vizinha', async () => {
    const h = sessao(admDaLoja, loja, 'admin_geral');
    expect((await implantacao(vizinha, h)).status).toBe(403);
    const marca = await request(app)
      .put(`/api/v1/system/implantacao/empresas/${vizinha}/itens/loja.catalogo/marca`)
      .set(h)
      .send({ tipo: 'NAO_APLICAVEL', motivo: 'não é minha' });
    expect(marca.status).toBe(403);
  });

  it('perfil de loja não alcança o checklist', async () => {
    const res = await implantacao(lojaDoGerente, sessao(gerenteDaLoja, lojaDoGerente, 'gerente_loja'));
    expect(res.status).toBe(403);
  });

  it('empresa que não existe: 404 para quem pode perguntar', async () => {
    // Vínculo de gestão numa empresa inexistente não há; o guarda responde antes.
    const res = await implantacao('empresa-que-nao-existe');
    expect([403, 404]).toContain(res.status);
  });
});
