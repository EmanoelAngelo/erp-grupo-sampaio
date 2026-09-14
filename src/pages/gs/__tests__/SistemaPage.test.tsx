/**
 * Tela Sistema (GAP-PRD-064, GAP-PRD-057).
 *
 * O que não pode falhar:
 *
 * 1. Lê as três rotas de verdade e mostra o número do NÚCLEO contra o alvo,
 *    a situação do esquema, o processo no ar e o estado do cofre (sem valor).
 * 2. Uma recusa não apaga as outras seções: cada uma diz o seu erro.
 * 3. O erro do servidor fica listado com o código que o log conhece.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import SistemaPage from '../SistemaPage';
import { limparErrosDaApiParaTestes } from '@/lib/api/client';

const RELEASE = {
  appVersion: '1.0.0',
  release: 'Grupo Sampaio ERP 1.0.0',
  environment: 'production',
  databaseVersion: 84,
  databaseTargetVersion: 84,
  databaseSituation: 'EM_DIA',
  documentsVersion: 19,
  processo: { node: 'v24.1.0', plataforma: 'win32/x64', noArDesde: '2026-09-11T10:00:00.000Z', supervisionado: true },
  instancia: {
    tipo: 'api',
    pid: 4242,
    host: 'LOJA-PC',
    iniciadoEm: '2026-09-11T10:00:01.000Z',
    batidaEm: '2026-09-11T13:00:00.000Z',
    estaInstancia: true,
  },
  calendario: {
    estado: 'FIXO_VALE',
    fuso: 'America/Sao_Paulo',
    deslocamentoSqlHoras: -3,
    conferidoEm: '2026-09-11T13:00:00.000Z',
    conferidoAte: '2027-10-16T13:00:00.000Z',
    primeiraDivergencia: null,
    comoResolver: null,
  },
};

const PRONTIDAO = {
  coreStatus: 'READY',
  overallStatus: 'ready_for_core_production',
  criticalBlockers: [],
  externalBlockers: ['NF-e — produção desligada neste servidor (NFE_PRODUCTION_ENABLED=false).'],
  schema: { situacao: 'EM_DIA', nucleo: { versao: 84, alvo: 84, passosPendentes: [] }, documentos: { versao: 19, alvo: 19 } },
  environment: 'production',
};

const SEGREDOS = {
  encryptionKey: 'PRODUCTION_SAFE',
  jwtSecret: 'DEVELOPMENT_DEFAULT',
  a1Pfx: 'SEALED_CURRENT_KEY',
  a1Password: 'LEGACY_KEY',
  asaasSandbox: { selo: 'ABSENT', trocaNoProvedor: 'NOT_REQUIRED' },
  asaasProduction: { selo: 'SEALED_CURRENT_KEY', trocaNoProvedor: 'REQUIRED' },
  asaasWebhook: { selo: 'ABSENT', trocaNoProvedor: 'NOT_REQUIRED' },
  email: { selo: 'ABSENT', trocaNoProvedor: 'NOT_REQUIRED' },
  legadoPendente: 1,
  cofreRotacionadoEm: null,
  checkedAt: '2026-09-11T13:00:00.000Z',
};

function servidor(respostas: Record<string, { status: number; corpo: unknown }>) {
  const chamadas: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request) => {
      const alvo = String(url);
      chamadas.push(alvo);
      const chave = Object.keys(respostas).find((k) => alvo.endsWith(k));
      const r = chave ? respostas[chave] : { status: 404, corpo: { error: { code: 'API_NOT_FOUND', message: 'Rota não encontrada.' } } };
      return new Response(JSON.stringify(r.corpo), { status: r.status, headers: { 'Content-Type': 'application/json' } });
    }),
  );
  return chamadas;
}

function montar() {
  render(
    <MemoryRouter>
      <SistemaPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
  limparErrosDaApiParaTestes();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('SistemaPage', () => {
  it('mostra o núcleo contra o alvo, o processo e o cofre sem valor', async () => {
    const chamadas = servidor({
      '/system/release': { status: 200, corpo: RELEASE },
      '/system/readiness': { status: 200, corpo: PRONTIDAO },
      '/core/system/secrets-readiness': { status: 200, corpo: SEGREDOS },
    });
    montar();
    const versao = await screen.findByTestId('versao');
    expect(within(versao).getByText('EM DIA')).toBeTruthy();
    expect(versao.textContent).toMatch(/versão 84 de 84/);
    expect(versao.textContent).toMatch(/Node v24\.1\.0/);
    expect(versao.textContent).toMatch(/com supervisor/);
    // GAP-PRD-137: o dono do banco, e que é este processo.
    expect(within(versao).getByText('ÚNICA NESTE BANCO')).toBeTruthy();
    expect(versao.textContent).toMatch(/pid 4242 em LOJA-PC/);
    // GAP-PRD-145: o corte do dia no SQL confere com o fuso oficial.
    expect(within(versao).getByText('O DIA DA LOJA CONFERE')).toBeTruthy();
    expect(versao.textContent).toContain('America/Sao_Paulo');

    const prontidao = await screen.findByTestId('prontidao');
    expect(within(prontidao).getByText('NÚCLEO PRONTO')).toBeTruthy();
    expect(prontidao.textContent).toContain('NFE_PRODUCTION_ENABLED');

    const cofre = await screen.findByTestId('segredos');
    expect(within(cofre).getByText('padrão de desenvolvimento')).toBeTruthy();
    expect(within(cofre).getByText('guardado com chave antiga — não abre')).toBeTruthy();
    expect(within(cofre).getByText('trocar no provedor')).toBeTruthy();

    for (const rota of ['/api/v1/system/release', '/api/v1/system/readiness', '/api/v1/core/system/secrets-readiness']) {
      expect(chamadas.some((c) => c.endsWith(rota))).toBe(true);
    }
  });

  it('o banco de outro processo e o processo sem trava aparecem em vermelho e em alerta (GAP-PRD-137)', async () => {
    servidor({
      '/system/release': {
        status: 200,
        corpo: { ...RELEASE, instancia: { ...RELEASE.instancia, pid: 999, estaInstancia: false } },
      },
      '/system/readiness': { status: 200, corpo: PRONTIDAO },
      '/core/system/secrets-readiness': { status: 200, corpo: SEGREDOS },
    });
    montar();
    const versao = await screen.findByTestId('versao');
    expect(within(versao).getByText('O BANCO É DE OUTRO PROCESSO')).toBeTruthy();
    expect(versao.textContent).toMatch(/pid 999/);
    cleanup();

    servidor({
      '/system/release': { status: 200, corpo: { ...RELEASE, instancia: null } },
      '/system/readiness': { status: 200, corpo: PRONTIDAO },
      '/core/system/secrets-readiness': { status: 200, corpo: SEGREDOS },
    });
    montar();
    const semTrava = await screen.findByTestId('versao');
    expect(within(semTrava).getByText(/SEM TRAVA/)).toBeTruthy();
  });

  it('uma recusa não apaga as outras seções, e o erro do servidor aparece com o código do log', async () => {
    servidor({
      '/system/release': { status: 200, corpo: RELEASE },
      '/system/readiness': { status: 200, corpo: PRONTIDAO },
      '/core/system/secrets-readiness': {
        status: 500,
        corpo: {
          error: { code: 'API_UNAVAILABLE', message: 'Erro interno.' },
          requestId: '3f2a9c1e-0000-4000-8000-000000000001',
        },
      },
    });
    montar();
    expect(await screen.findByTestId('versao')).toBeTruthy();
    const alerta = await screen.findByRole('alert');
    // A frase do 5xx leva o começo do código; a lista, o código inteiro.
    expect(alerta.textContent).toMatch(/Erro interno\. Código para o suporte: 3f2a9c1e\./);
    const lista = await screen.findByTestId('ultimos-erros');
    expect(lista.textContent).toContain('3f2a9c1e-0000-4000-8000-000000000001');
    expect(lista.textContent).toContain('/core/system/secrets-readiness');
  });
});

describe('o relógio da loja (GAP-PRD-145)', () => {
  it('a regra de fuso que vai mudar aparece com a data e o que fazer', async () => {
    servidor({
      '/system/release': {
        status: 200,
        corpo: {
          ...RELEASE,
          calendario: {
            ...RELEASE.calendario,
            estado: 'VAI_DIVERGIR',
            primeiraDivergencia: '2026-11-01T03:00:00.000Z',
            comoResolver: 'A regra de fuso de America/Sao_Paulo deixou de ser -3h fixas (a partir de 2026-11-01).',
          },
        },
      },
      '/system/readiness': { status: 200, corpo: PRONTIDAO },
      '/core/system/secrets-readiness': { status: 200, corpo: SEGREDOS },
    });
    montar();
    const versao = await screen.findByTestId('versao');
    expect(within(versao).getByText('VAI DIVERGIR')).toBeTruthy();
    expect((await screen.findByTestId('fuso-como-resolver')).textContent).toContain('2026-11-01');
  });
});

describe('o esquema contra um banco novo (GAP-PRD-140)', () => {
  const deriva = (extra: Record<string, unknown>) => ({
    situacao: 'IDENTICO',
    motivo: null,
    totalDeDivergencias: 0,
    divergencias: [],
    objetosAMais: 0,
    tabelasConferidas: 195,
    indicesConferidos: 189,
    conferidoEm: '2026-09-11T13:00:00.000Z',
    ultimoReparo: null,
    comoResolver: null,
    ...extra,
  });

  function comDeriva(schemaDrift: unknown) {
    servidor({
      '/system/release': { status: 200, corpo: RELEASE },
      '/system/readiness': { status: 200, corpo: { ...PRONTIDAO, schemaDrift } },
      '/core/system/secrets-readiness': { status: 200, corpo: SEGREDOS },
    });
    montar();
  }

  it('idêntico: diz quantas tabelas e índices conferiu, e não manda fazer nada', async () => {
    comDeriva(deriva({}));
    const bloco = await screen.findByTestId('deriva-do-esquema');
    expect(within(bloco).getByText('IDÊNTICO AO BANCO NOVO')).toBeTruthy();
    expect(bloco.textContent).toMatch(/195 tabelas e 189 índices conferidos/);
    expect(screen.queryByTestId('deriva-como-resolver')).toBeNull();
  });

  it('diverge: cada divergência pelo nome, o que ficou sem reparo e o comando', async () => {
    comDeriva(
      deriva({
        situacao: 'DIVERGE',
        totalDeDivergencias: 1,
        divergencias: [
          {
            tipo: 'coluna_diferente',
            tabela: 'core_service_orders',
            objeto: 'status',
            descricao: "core_service_orders.status: DEFAULT 'recebido' aqui, 'em_aberto' no banco novo.",
            reparo: 'reconstruir_tabela',
          },
        ],
        objetosAMais: 1,
        ultimoReparo: {
          em: '2026-09-11T10:00:00.000Z',
          modo: 'boot',
          reparados: ['Índice ix_fiscal_docs_order (core_fiscal_documents) falta neste banco.'],
          pendentes: [
            {
              objeto: 'core_service_orders',
              motivo: 'Reconstrução não feita: a tabela tem coluna(s) que o banco novo não tem (coluna_de_terceiro).',
            },
          ],
        },
        comoResolver: 'Com a API parada: npm run db:conferir-esquema -- --reparar.',
      }),
    );
    const bloco = await screen.findByTestId('deriva-do-esquema');
    expect(within(bloco).getByText('DIVERGE DO BANCO NOVO')).toBeTruthy();
    expect(bloco.textContent).toContain("DEFAULT 'recebido' aqui, 'em_aberto' no banco novo");
    expect(bloco.textContent).toMatch(/1 objeto\(s\) só neste banco, mantidos/);
    expect(bloco.textContent).toMatch(/na subida da API/);
    expect((await screen.findByTestId('deriva-pendentes')).textContent).toContain('coluna_de_terceiro');
    expect((await screen.findByTestId('deriva-como-resolver')).textContent).toContain('--reparar');
  });

  it('servidor anterior, sem a deriva: a tela não quebra e não inventa situação', async () => {
    comDeriva(undefined);
    expect(await screen.findByTestId('prontidao')).toBeTruthy();
    expect(screen.queryByTestId('deriva-do-esquema')).toBeNull();
  });
});
