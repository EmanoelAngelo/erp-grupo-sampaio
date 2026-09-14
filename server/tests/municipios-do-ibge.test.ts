/**
 * ============================================================================
 * O CÓDIGO IBGE SAI DO NOME DA CIDADE (IBGE-MUNICIPIOS, resíduo do GAP-PRD-028)
 * ============================================================================
 *
 * Depois do GAP-PRD-028 a compra com conta e ENTREGA exige o código IBGE do
 * município no endereço salvo (422 CHECKOUT_ENDERECO_INCOMPLETO). O cliente o
 * digitava à mão, com a instrução de "buscar no site do IBGE" — cliente de
 * loja online não sabe o que é isso, e a compra não fecha. Não havia tabela de
 * municípios no sistema.
 *
 * O que este arquivo cobra, pelo servidor:
 *
 *   - o COMANDO do operador carrega a lista oficial de um arquivo (JSON da API
 *     de localidades do IBGE, ou CSV codigo;nome;uf) ou com --baixar (aqui
 *     com fetch de mentira — nenhuma chamada externa), recusa lista inválida
 *     sem gravar nada e é idempotente;
 *   - a ROTA PÚBLICA de busca acha a cidade sem acento e sem caixa, por UF, no
 *     máximo 20, sob o limite de taxa das rotas públicas, e diz quando a
 *     tabela não está carregada;
 *   - com a tabela carregada, o endereço (e o fechamento com entrega) só
 *     aceita código que EXISTE e é da UF do endereço — 422 com o nome da
 *     cidade; sem a tabela, a regra de hoje (formato e prefixo da UF);
 *   - a conferência da implantação diz se a tabela está PRONTA (com a
 *     contagem) ou PENDENTE (com o comando que resolve).
 *
 * FIXTURE: as listas abaixo são AMOSTRAS DE TESTE, declaradas como tal — onze
 * municípios reais no formato da API do IBGE e 25 municípios SINTÉTICOS
 * ("Município Sintético NN", códigos 43990NN) só para medir o teto de 20
 * resultados. Nenhuma delas é a lista oficial, e nenhuma vai para o banco da
 * loja: o banco nasce com a tabela vazia, e só o comando do dono a enche.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.DEVORA_API_ENV = 'test';
process.env.DEVORA_JWT_SECRET = 'test-jwt-secret-suficientemente-longo';
process.env.DEVORA_ENCRYPTION_KEY = 'test-encryption-key-suficientemente-longa';

import request from 'supertest';

const { createApp } = await import('../src/app.js');
const { resetDbForTests } = await import('../src/db/database.js');
const { getConnection } = await import('../src/db/sqlite.js');
const { upsertCompany } = await import('../src/services/auth/IdentityService.js');
const { confirmarEmail } = await import('../src/services/core/CustomerPortalService.js');
const { saveShippingSettings } = await import('../src/services/core/CheckoutShippingService.js');
const { textoDeEntrega } = await import('../src/services/notifications/EmailService.js');
const { conferirImplantacao } = await import('../src/services/implantacao/conferenciaDaImplantacao.js');
const { loginForTest } = await import('./helpers/auth.js');
const esquema = (await import('../src/db/schema.js')) as Record<string, unknown>;
const comando = (await import('../src/scripts/carregar-municipios-ibge.js').catch(() => ({}))) as {
  carregarMunicipiosPelaLinhaDeComando?: (
    args: string[],
    deps?: Record<string, unknown>,
  ) => Promise<number>;
};

// ---------------------------------------------------------------- fixtures

/** Um município no formato de GET /api/v1/localidades/municipios do IBGE. */
function daApi(id: number, nome: string, uf: string, ufId: number): Record<string, unknown> {
  const UF = { id: ufId, sigla: uf, nome: `UF ${uf}`, regiao: { id: 9, sigla: 'X', nome: 'Região' } };
  return {
    id,
    nome,
    microrregiao: { id: 1, nome: 'Micro', mesorregiao: { id: 1, nome: 'Meso', UF } },
    'regiao-imediata': { id: 1, nome: 'Imediata', 'regiao-intermediaria': { id: 1, nome: 'Intermediária', UF } },
  };
}

/** Município criado depois da última divisão em microrregiões: microrregiao nula. */
function semMicrorregiao(id: number, nome: string, uf: string, ufId: number): Record<string, unknown> {
  const m = daApi(id, nome, uf, ufId);
  return { ...m, microrregiao: null };
}

/** FIXTURE DE TESTE — amostra de onze municípios, NÃO a lista oficial. */
const AMOSTRA = [
  daApi(4314407, 'Pelotas', 'RS', 43),
  daApi(4314902, 'Porto Alegre', 'RS', 43),
  daApi(4317103, "Sant'Ana do Livramento", 'RS', 43),
  daApi(4305108, 'Caxias do Sul', 'RS', 43),
  daApi(3550308, 'São Paulo', 'SP', 35),
  daApi(3304557, 'Rio de Janeiro', 'RJ', 33),
  daApi(5300108, 'Brasília', 'DF', 53),
  daApi(2927408, 'Salvador', 'BA', 29),
  daApi(4106902, 'Curitiba', 'PR', 41),
  daApi(3106200, 'Belo Horizonte', 'MG', 31),
  semMicrorregiao(5101837, 'Boa Esperança do Norte', 'MT', 51),
];

/** A faixa de verdade (~5.570) recusa a amostra; os casos de sucesso a abrem, declarando. */
const FAIXA_DA_AMOSTRA = [1, 100] as const;

const PASTA = mkdtempSync(join(tmpdir(), 'gs-ibge-'));
afterAll(() => rmSync(PASTA, { recursive: true, force: true }));

function arquivo(nome: string, conteudo: string): string {
  const caminho = join(PASTA, nome);
  writeFileSync(caminho, conteudo, 'utf8');
  return caminho;
}

interface Saida {
  codigo: number;
  linhas: string[];
  texto: string;
  urls: string[];
}

async function carregar(args: string[], deps: Record<string, unknown> = {}): Promise<Saida> {
  expect(comando.carregarMunicipiosPelaLinhaDeComando, 'o comando carregar-municipios-ibge não existe').toBeTypeOf(
    'function',
  );
  const linhas: string[] = [];
  const urls: string[] = [];
  const fetchDeMentira = deps.fetch
    ? async (url: string | URL | Request) => {
        urls.push(String(url));
        return (deps.fetch as (u: string) => Promise<Response>)(String(url));
      }
    : async () => {
        throw new Error('fetch não devia ser chamado neste caso');
      };
  const codigo = await comando.carregarMunicipiosPelaLinhaDeComando!(args, {
    faixaPlausivel: FAIXA_DA_AMOSTRA,
    ...deps,
    fetch: fetchDeMentira,
    log: (l: string) => linhas.push(l),
    erro: (l: string) => linhas.push(l),
  });
  return { codigo, linhas, texto: linhas.join('\n'), urls };
}

function naTabela(): Array<{ codigo: string; nome: string; uf: string }> {
  return getConnection()
    .prepare('SELECT codigo, nome, uf FROM core_ibge_municipios ORDER BY codigo')
    .all() as Array<{ codigo: string; nome: string; uf: string }>;
}

async function carregarAmostra(): Promise<void> {
  const r = await carregar(['--arquivo', arquivo('amostra.json', JSON.stringify(AMOSTRA))]);
  expect(r.codigo, r.texto).toBe(0);
}

beforeEach(() => {
  resetDbForTests();
});

// ============================================================================

describe('a tabela nasce vazia — nada de dado inventado', () => {
  it('a DDL canônica tem core_ibge_municipios, e o banco novo não tem linha nenhuma', () => {
    expect(String(esquema.DDL_DOS_MUNICIPIOS_IBGE ?? '')).toMatch(/CREATE TABLE IF NOT EXISTS core_ibge_municipios/);
    expect(naTabela()).toEqual([]);
  });
});

describe('o comando carrega a lista oficial', () => {
  it('de um arquivo JSON da API de localidades — a UF vem da microrregião, ou da região imediata quando ela é nula', async () => {
    const r = await carregar(['--arquivo', arquivo('municipios.json', JSON.stringify(AMOSTRA))]);
    expect(r.codigo, r.texto).toBe(0);
    expect(r.texto).toMatch(/11 novos/);
    const linhas = naTabela();
    expect(linhas).toHaveLength(11);
    expect(linhas).toContainEqual({ codigo: '4314407', nome: 'Pelotas', uf: 'RS' });
    expect(linhas).toContainEqual({ codigo: '5101837', nome: 'Boa Esperança do Norte', uf: 'MT' });
  });

  it('de um CSV codigo;nome;uf, com cabeçalho e BOM', async () => {
    const csv = '\uFEFFcodigo;nome;uf\n4314407;Pelotas;RS\n3550308;São Paulo;SP\n5300108;Brasília;DF\n';
    const r = await carregar(['--arquivo', arquivo('municipios.csv', csv)]);
    expect(r.codigo, r.texto).toBe(0);
    expect(naTabela().map((m) => m.codigo)).toEqual(['3550308', '4314407', '5300108']);
  });

  it('de um JSON salvo com BOM (o Bloco de Notas do Windows põe um no começo)', async () => {
    const comBom = String.fromCharCode(0xfeff) + JSON.stringify(AMOSTRA);
    const r = await carregar(['--arquivo', arquivo('com-bom.json', comBom)]);
    expect(r.codigo, r.texto).toBe(0);
    expect(naTabela()).toHaveLength(11);
  });

  it('com --baixar, busca a URL oficial pelo fetch dado (aqui, de mentira)', async () => {
    const r = await carregar(['--baixar'], {
      fetch: async () =>
        new Response(JSON.stringify(AMOSTRA), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    });
    expect(r.codigo, r.texto).toBe(0);
    expect(r.urls).toEqual(['https://servicodados.ibge.gov.br/api/v1/localidades/municipios']);
    expect(naTabela()).toHaveLength(11);
  });

  it('com --baixar e o IBGE fora do ar, sai com 1 e não grava', async () => {
    const r = await carregar(['--baixar'], { fetch: async () => new Response('erro', { status: 503 }) });
    expect(r.codigo).toBe(1);
    expect(r.texto).toMatch(/503/);
    expect(naTabela()).toEqual([]);
  });

  it('é idempotente: a segunda carga não muda nada e diz que está tudo igual', async () => {
    const caminho = arquivo('duas-vezes.json', JSON.stringify(AMOSTRA));
    expect((await carregar(['--arquivo', caminho])).codigo).toBe(0);
    const antes = naTabela();
    const r = await carregar(['--arquivo', caminho]);
    expect(r.codigo, r.texto).toBe(0);
    expect(r.texto).toMatch(/0 novos/);
    expect(r.texto).toMatch(/11 iguais/);
    expect(naTabela()).toEqual(antes);
  });

  it('a lista nova é a verdade: nome corrigido é atualizado, código que saiu é removido', async () => {
    await carregarAmostra();
    const nova = AMOSTRA.filter((m) => m.id !== 2927408).map((m) =>
      m.id === 4305108 ? { ...m, nome: 'Caxias do Sul (novo nome)' } : m,
    );
    const r = await carregar(['--arquivo', arquivo('nova.json', JSON.stringify(nova))]);
    expect(r.codigo, r.texto).toBe(0);
    expect(r.texto).toMatch(/1 alterado/);
    expect(r.texto).toMatch(/1 removido/);
    const linhas = naTabela();
    expect(linhas.find((m) => m.codigo === '2927408')).toBeUndefined();
    expect(linhas.find((m) => m.codigo === '4305108')?.nome).toBe('Caxias do Sul (novo nome)');
  });

  describe('recusa lista inválida — e não grava nada', () => {
    const casos: Array<[string, string]> = [
      ['código com 6 dígitos', '431440;Pelotas;RS'],
      ['código de outra UF (35 é SP)', '3514407;Pelotas;RS'],
      ['UF que não existe', '4314407;Pelotas;XX'],
      ['nome vazio', '4314407;;RS'],
      ['código repetido', '4314407;Pelotas;RS\n4314407;Pelotas de novo;RS'],
    ];
    for (const [caso, corpo] of casos) {
      it(caso, async () => {
        await carregarAmostra();
        const antes = naTabela();
        const r = await carregar(['--arquivo', arquivo(`invalida-${caso.length}.csv`, `codigo;nome;uf\n${corpo}\n`)]);
        expect(r.codigo).toBe(1);
        expect(r.texto).toMatch(/Nada foi gravado/);
        expect(naTabela()).toEqual(antes);
      });
    }

    it('JSON que não é a lista do IBGE', async () => {
      const r = await carregar(['--arquivo', arquivo('outra-coisa.json', JSON.stringify({ municipios: [] }))]);
      expect(r.codigo).toBe(1);
      expect(naTabela()).toEqual([]);
    });

    it('com a faixa de verdade (~5.570), a amostra de onze é recusada — de arquivo e de --baixar', async () => {
      const deArquivo = await carregar(['--arquivo', arquivo('curta.json', JSON.stringify(AMOSTRA))], {
        faixaPlausivel: undefined,
      });
      expect(deArquivo.codigo).toBe(1);
      expect(deArquivo.texto).toMatch(/5\.570/);
      const baixada = await carregar(['--baixar'], {
        faixaPlausivel: undefined,
        fetch: async () => new Response(JSON.stringify(AMOSTRA), { status: 200 }),
      });
      expect(baixada.codigo).toBe(1);
      expect(naTabela()).toEqual([]);
    });

    it('sem --arquivo nem --baixar, diz como se usa e sai com 1', async () => {
      const r = await carregar([]);
      expect(r.codigo).toBe(1);
      expect(r.texto).toMatch(/--baixar/);
      expect(r.texto).toMatch(/--arquivo/);
    });
  });
});

// ============================================================================

describe('a rota pública de busca', () => {
  const app = createApp();

  it('com a tabela vazia, diz que não está carregada', async () => {
    const res = await request(app).get('/api/v1/loja/municipios').query({ uf: 'RS', q: 'pel' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ carregada: false, total: 0, itens: [] });
  });

  it('acha sem acento e sem caixa, e filtra pela UF', async () => {
    await carregarAmostra();
    const sp = await request(app).get('/api/v1/loja/municipios').query({ uf: 'SP', q: 'SAO' });
    expect(sp.status).toBe(200);
    expect(sp.body.carregada).toBe(true);
    expect(sp.body.total).toBe(11);
    expect(sp.body.itens).toEqual([{ codigo: '3550308', nome: 'São Paulo', uf: 'SP' }]);

    const df = await request(app).get('/api/v1/loja/municipios').query({ uf: 'DF', q: 'brasilia' });
    expect(df.body.itens).toEqual([{ codigo: '5300108', nome: 'Brasília', uf: 'DF' }]);

    // "Sant'Ana" se acha digitando "santana" ou "sant ana".
    for (const q of ['santana', 'sant ana', 'livramento']) {
      const rs = await request(app).get('/api/v1/loja/municipios').query({ uf: 'RS', q });
      expect(rs.body.itens.map((m: { codigo: string }) => m.codigo), q).toEqual(['4317103']);
    }

    // Pela UF: "pel" em SP não traz Pelotas.
    const outra = await request(app).get('/api/v1/loja/municipios').query({ uf: 'SP', q: 'pel' });
    expect(outra.body.itens).toEqual([]);
  });

  it('o começo do nome vem primeiro', async () => {
    await carregarAmostra();
    const rs = await request(app).get('/api/v1/loja/municipios').query({ uf: 'RS', q: 'po' });
    expect(rs.body.itens[0]).toEqual({ codigo: '4314902', nome: 'Porto Alegre', uf: 'RS' });
  });

  it('no máximo 20 resultados', async () => {
    const sinteticos = Array.from({ length: 25 }, (_, i) => ({
      codigo: `43990${String(i + 10).padStart(2, '0')}`,
      nome: `Município Sintético ${i + 10}`,
      uf: 'RS',
    }));
    const r = await carregar(['--arquivo', arquivo('sinteticos.json', JSON.stringify(sinteticos))]);
    expect(r.codigo, r.texto).toBe(0);
    const res = await request(app).get('/api/v1/loja/municipios').query({ uf: 'RS', q: 'sintetico' });
    expect(res.body.itens).toHaveLength(20);
  });

  it('UF inválida é 400; busca curta demais não lista nada', async () => {
    await carregarAmostra();
    const ruim = await request(app).get('/api/v1/loja/municipios').query({ uf: 'ZZ', q: 'pel' });
    expect(ruim.status).toBe(400);
    const curta = await request(app).get('/api/v1/loja/municipios').query({ uf: 'RS', q: 'p' });
    expect(curta.status).toBe(200);
    expect(curta.body.itens).toEqual([]);
    expect(curta.body.carregada).toBe(true);
  });

  it('é pública e está sob o limite de taxa das rotas públicas', async () => {
    const res = await request(app).get('/api/v1/loja/municipios').query({ uf: 'RS', q: 'pel' });
    expect(res.status).toBe(200);
    expect(res.headers['ratelimit-limit']).toBeDefined();
  });
});

// ============================================================================

describe('o endereço e o fechamento conferem o código na tabela', () => {
  const app = createApp();
  const SENHA = 'senha-do-cliente-2026';
  const CASA = {
    label: 'Casa',
    zip: '96010-000',
    street: 'Rua XV de Novembro',
    number: '500',
    district: 'Centro',
    city: 'Pelotas',
    state: 'RS',
    cityIbge: '4314407',
  };
  let gringa: string;

  beforeEach(async () => {
    // A verificação do e-mail sai em nome de uma operação: sem nenhuma, não há fila.
    gringa = await upsertCompany({ slug: 'gringa-ibge', tradeName: 'Gringa', legalName: 'Gringa Ltda' });
  });

  async function contaNova(email = 'ana@exemplo.com'): Promise<string> {
    const res = await request(app)
      .post('/api/v1/loja/portal/registrar')
      .send({ termsAccepted: true, email, password: SENHA });
    expect(res.status).toBe(201);
    const accountId = res.body.account.id as string;
    const linha = getConnection()
      .prepare(
        `SELECT id FROM core_email_queue
          WHERE template = 'verificacao_email' AND to_address = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(email) as { id: string };
    confirmarEmail({ accountId, codigo: textoDeEntrega(linha.id)!.match(/é: (\d{6})/)![1] });
    return res.body.token as string;
  }

  function salvar(token: string, corpo: Record<string, unknown>) {
    return request(app).post('/api/v1/loja/portal/enderecos').set('x-portal-token', token).send(corpo);
  }

  it('sem a tabela, vale a regra de hoje: o formato (7 dígitos, prefixo da UF) basta', async () => {
    const token = await contaNova();
    // 4399999 tem o prefixo do RS e não é município nenhum — sem tabela não há como saber.
    const ok = await salvar(token, { ...CASA, cityIbge: '4399999' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const outraUf = await salvar(token, { ...CASA, cityIbge: '3550308' });
    expect(outraUf.status).toBe(400);
  });

  it('com a tabela, código de OUTRA UF é 422 e diz de que cidade ele é', async () => {
    await carregarAmostra();
    const token = await contaNova();
    const res = await salvar(token, { ...CASA, cityIbge: '3550308' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('PORTAL_IBGE_NAO_CONFERE');
    expect(res.body.error.message).toContain('São Paulo (SP)');
    expect(res.body.error.message).toContain('RS');
  });

  it('com a tabela, código que não é município nenhum é 422', async () => {
    await carregarAmostra();
    const token = await contaNova();
    const res = await salvar(token, { ...CASA, cityIbge: '4399999' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('PORTAL_IBGE_NAO_CONFERE');
    expect(res.body.error.message).toContain('4399999');
  });

  it('com a tabela, o código certo passa', async () => {
    await carregarAmostra();
    const token = await contaNova();
    const res = await salvar(token, CASA);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.cityIbge).toBe('4314407');
  });

  it('com a tabela, o fechamento recusa o endereço antigo cujo código não é município da UF', async () => {
    const agora = new Date().toISOString();
    const db = getConnection();
    db.prepare(
      `INSERT INTO core_products (id, company_id, internal_code, name, unit, cost_cents,
                                  price_cents, active, publish_online, created_at, updated_at)
       VALUES ('prod-ibge', ?, 'IBGE-1', 'Item', 'UN', 4000, 10000, 1, 1, ?, ?)`,
    ).run(gringa, agora, agora);
    db.prepare(
      "INSERT INTO core_stock (company_id, product_id, quantity, reserved, updated_at) VALUES (?, 'prod-ibge', 5, 0, ?)",
    ).run(gringa, agora);
    saveShippingSettings({
      companyId: gringa,
      pickupEnabled: true,
      deliveryEnabled: true,
      flatRateCents: 2500,
      estimatedDays: 4,
    });
    const token = await contaNova('bia@exemplo.com');
    // Salvo ANTES da tabela: o formato passou.
    const salvo = await salvar(token, { ...CASA, cityIbge: '4399999' });
    expect(salvo.status).toBe(201);
    await carregarAmostra();

    const res = await request(app)
      .post('/api/v1/loja/checkout')
      .set('Idempotency-Key', 'ibge-checkout-1')
      .set('x-portal-token', token)
      .send({
        paymentMethod: 'pix',
        customerName: 'Bia Nova',
        customerDocument: '111.444.777-35',
        customerPhone: '(53) 99999-0000',
        items: [{ productId: 'prod-ibge', quantity: 1 }],
        shippingAddressId: salvo.body.id,
        shippingMethods: { [gringa]: 'tabela_da_loja' },
      });
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error.code).toBe('CHECKOUT_ENDERECO_INCOMPLETO');
    expect(res.body.error.details.faltando).toEqual(['ibge']);
    expect(res.body.error.message).toContain('4399999');
    expect((db.prepare('SELECT COUNT(*) c FROM core_orders').get() as { c: number }).c).toBe(0);
  });
});

// ============================================================================

describe('a conferência da implantação diz se a tabela está carregada', () => {
  type Contexto = Parameters<typeof conferirImplantacao>[0];
  function ctx(municipios?: () => number | null): Contexto {
    return {
      env: { NODE_ENV: 'production', DEVORA_API_ENV: 'production' },
      raiz: 'C:/grupo-sampaio',
      existe: () => true,
      emContainer: false,
      processo: null,
      ...(municipios ? { municipiosDoIbge: municipios } : {}),
    } as Contexto;
  }
  function item(r: ReturnType<typeof conferirImplantacao>) {
    return r.itens.find((i) => i.id === 'municipios_ibge');
  }

  it('PRONTA com a contagem', () => {
    const r = conferirImplantacao(ctx(() => 5571));
    expect(item(r)).toMatchObject({ titulo: 'Tabela de municípios do IBGE', estado: 'OK' });
    expect(item(r)!.detalhe).toContain('5.571');
  });

  it('PENDENTE com o comando que resolve — e não bloqueia: o cliente digita como hoje', () => {
    const r = conferirImplantacao(ctx(() => 0));
    expect(item(r)).toMatchObject({ estado: 'ATENCAO' });
    expect(item(r)!.detalhe).toMatch(/Pendente/);
    expect(item(r)!.comoResolver).toContain('node server/dist/scripts/carregar-municipios-ibge.js --baixar');
    expect(item(r)!.comoResolver).toContain('--arquivo');
  });

  it('sem banco para contar, diz que não dá para saber daqui e o comando', () => {
    const r = conferirImplantacao(ctx(() => null));
    expect(item(r)).toMatchObject({ estado: 'INFO' });
    expect(item(r)!.comoResolver).toContain('carregar-municipios-ibge');
  });

  it('pela rota, com a API no ar: PENDENTE vazia, PRONTA depois do comando', async () => {
    const app = createApp();
    const dono = await loginForTest(app, {
      userId: 'dono-ibge',
      companyId: 'loja-ibge',
      profileCodes: ['admin_geral'],
    });
    const ler = () =>
      request(app)
        .get('/api/v1/system/implantacao')
        .set({ Authorization: `Bearer ${dono.body.accessToken}` });
    const antes = (await ler()).body.itens.find((i: { id: string }) => i.id === 'municipios_ibge');
    expect(antes?.estado).toBe('ATENCAO');
    await carregarAmostra();
    const depois = (await ler()).body.itens.find((i: { id: string }) => i.id === 'municipios_ibge');
    expect(depois?.estado).toBe('OK');
    expect(depois?.detalhe).toContain('11 municípios');
  });

  it('pelo comando conferir-implantacao, antes de subir: lê o banco sem escrever nele', () => {
    const SERVIDOR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const TSX = join(SERVIDOR, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const SCRIPT = join(SERVIDOR, 'src', 'scripts', 'conferir-implantacao.ts');
    const pasta = mkdtempSync(join(tmpdir(), 'gs-conferir-ibge-'));
    const banco = join(pasta, 'banco.db');
    const db = new DatabaseSync(banco);
    db.exec(String(esquema.DDL_DOS_MUNICIPIOS_IBGE));
    const inserir = db.prepare(
      "INSERT INTO core_ibge_municipios (codigo, nome, uf, nome_busca, atualizado_em) VALUES (?, ?, ?, ?, '2026-09-13')",
    );
    inserir.run('4314407', 'Pelotas', 'RS', 'pelotas');
    inserir.run('3550308', 'São Paulo', 'SP', 'sao paulo');
    inserir.run('5300108', 'Brasília', 'DF', 'brasilia');
    db.close();
    const rodar = (caminho: string) => {
      try {
        return execFileSync(process.execPath, [TSX, SCRIPT], {
          cwd: pasta,
          env: {
            PATH: process.env.PATH ?? '',
            SystemRoot: process.env.SystemRoot ?? '',
            DEVORA_IGNORE_DOTENV: 'true',
            DEVORA_DATABASE_PATH: caminho,
          },
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (erro) {
        return (erro as { stdout?: string }).stdout ?? '';
      }
    };
    try {
      expect(rodar(banco)).toMatch(/OK\s+Tabela de municípios do IBGE: Pronta: 3 municípios/);
      const semBanco = rodar(join(pasta, 'nao-existe.db'));
      expect(semBanco).toMatch(/Tabela de municípios do IBGE/);
      expect(semBanco).toContain('carregar-municipios-ibge');
    } finally {
      rmSync(pasta, { recursive: true, force: true });
    }
  }, 60_000);
});
