/**
 * A TELA FISCAL MOSTRA O QUE O XML DESCOBRIU — E CONFIRMA EM LOTE.
 *
 * ## Por que este teste existe
 *
 * O servidor pode estar impecável e a rodada inteira não valer nada: se a tela
 * não mostrar a sugestão nem oferecer o clique, o contador continua digitando
 * NCM produto a produto, exatamente como antes. Esta base já documentou esse
 * defeito com nome próprio — rota pronta, testada e auditada, sem um único
 * chamador na interface (GAP-V09, GAP-V26, GAP-V49).
 *
 * O que se crava aqui é o CAMINHO COMPLETO da tela:
 *
 *   1. o assistente mostra o estado, a procedência e QUEM RESOLVE cada item —
 *      sem o dono, a lista mandava o gestor procurar por horas um botão para
 *      resolver o que só a SEFAZ resolve;
 *   2. a contagem aparece com o total ("1 de 2, 50%"), e não como um susto sem
 *      tamanho;
 *   3. o botão de confirmar em lote existe, diz QUANTAS sugestões vai aplicar,
 *      e chama a rota certa;
 *   4. a frase que separa mercadoria de tributação está NA TELA, e não só no
 *      código: o XML do fornecedor não decide a nossa saída.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import FiscalPage from '../FiscalPage';

/** A resposta do checklist, já no formato do assistente. */
const READINESS = {
  items: [
    {
      companyId: 'c1',
      model: '65',
      readiness: 'READY_FOR_CERTIFICATE',
      canEmit: false,
      blockingReasons: [],
      certificateAlert: null,
      items: [
        {
          key: 'emitter',
          label: 'Razão social',
          status: 'PASS',
          detail: null,
          state: 'CONFIRMADO',
          source: 'cadastro',
          owner: 'gestor',
          known: 'Preço Justo Comércio Ltda',
          counts: null,
        },
        {
          key: 'product_ncm',
          label: 'NCM dos produtos',
          status: 'FAIL',
          detail: '1 de 2 produto(s) ativo(s) sem NCM.',
          state: 'AUTO_DETECTADO',
          source: 'xml_fornecedor',
          owner: 'contador',
          known: null,
          counts: { done: 1, total: 2, percent: 50 },
        },
        {
          key: 'sefaz',
          label: 'Autorização real na SEFAZ',
          status: 'PENDING',
          detail: 'Nenhum documento autorizado ainda.',
          state: 'BLOQUEADO_EXTERNAMENTE',
          source: null,
          owner: 'sefaz',
          known: null,
          counts: null,
        },
      ],
    },
  ],
  productionUnlock: null,
  classification: {
    totalProducts: 2,
    withNcm: 1,
    withOrigin: 0,
    confirmed: 0,
    pendingSuggestions: 1,
    divergences: 0,
  },
};

const CLASSIFICACAO = {
  items: [
    {
      productId: 'p1',
      name: 'Pastilha de Freio',
      sku: 'PF-01',
      internalCode: null,
      confirmedAt: null,
      confirmedBy: null,
      fields: [
        {
          field: 'ncm',
          current: null,
          state: 'AUTO_DETECTADO',
          source: null,
          best: {
            value: '87141000',
            occurrences: 2,
            suppliers: ['Distribuidora A', 'Distribuidora B'],
            lastSeenAt: null,
            lastNoteId: null,
          },
          evidence: [
            {
              value: '87141000',
              occurrences: 2,
              suppliers: ['Distribuidora A', 'Distribuidora B'],
              lastSeenAt: null,
              lastNoteId: null,
            },
          ],
        },
      ],
      applicable: [{ field: 'ncm', value: '87141000' }],
    },
  ],
  summary: READINESS.classification,
};

let confirmacoes: unknown[] = [];

function servidor() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: { body?: unknown }) => {
      const caminho = String(typeof url === 'string' ? url : (url as Request).url ?? url);
      const corpo = (dados: unknown) =>
        new Response(JSON.stringify(dados), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });

      if (caminho.includes('/fiscal/readiness')) return corpo(READINESS);
      if (caminho.includes('/fiscal/classification/confirm')) {
        confirmacoes.push(init?.body ? JSON.parse(String(init.body)) : null);
        return corpo({ confirmed: 1, products: 1, applied: [] });
      }
      if (caminho.includes('/fiscal/classification')) return corpo(CLASSIFICACAO);
      if (caminho.includes('/fiscal/config')) {
        return corpo({
          companyId: 'c1',
          legalName: 'Preço Justo Comércio Ltda',
          environment: 'homologation',
          productionUnlocked: false,
        });
      }
      // Séries, CSC, pendências: a tela pede, e o vazio é resposta legítima.
      return corpo({ items: [] });
    }),
  );
}

beforeEach(() => {
  confirmacoes = [];
  servidor();
  // A casca do ERP escreve no console ao montar sem sessão; o barulho não é o
  // assunto deste teste.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function abrir() {
  return render(
    <MemoryRouter>
      <FiscalPage />
    </MemoryRouter>,
  );
}

describe('o assistente responde item a item', () => {
  it('mostra o que já sabemos, de onde veio e quem resolve', async () => {
    abrir();

    // O QUE JÁ SABEMOS: "Razão social ✓" não diz QUAL razão social.
    await waitFor(() => {
      expect(screen.getAllByText('Preço Justo Comércio Ltda').length).toBeGreaterThan(0);
    });

    // DE ONDE VEIO + QUEM RESOLVE, na mesma linha.
    expect(screen.getAllByText(/do cadastro · resolve: a gerência/).length).toBeGreaterThan(0);

    /*
      O ITEM QUE NINGUÉM DAQUI RESOLVE precisa dizer isso com todas as letras.
      Sem esta frase, ele se parece com um campo a preencher — e o gestor
      procura um botão que não existe.
    */
    expect(
      screen.getAllByText(/resolve: a SEFAZ — não há o que fazer aqui/).length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText('BLOQUEADO FORA DAQUI').length).toBeGreaterThan(0);
  });

  it('a contagem do catálogo vem com o total e o percentual', async () => {
    abrir();
    // "1 sem NCM" é um susto sem tamanho; "1 de 2 (50%)" é uma decisão.
    await waitFor(() => {
      expect(screen.getAllByText('1 de 2 (50%)').length).toBeGreaterThan(0);
    });
    expect(screen.getAllByText('AUTO-DETECTADO').length).toBeGreaterThan(0);
  });
});

describe('o lote existe na tela, e não só na rota', () => {
  it('o botão diz quantas sugestões vai aplicar e chama a rota', async () => {
    abrir();

    const botao = await screen.findByRole('button', { name: /Confirmar 1 sugestão/ });
    fireEvent.click(botao);

    await waitFor(() => expect(confirmacoes.length).toBe(1));
    // Corpo vazio significa "tudo que é inequívoco" — o caso comum.
    expect(confirmacoes[0]).toEqual({});
  });

  it('a evidência aparece com a contagem e os fornecedores que a sustentam', async () => {
    abrir();
    await waitFor(() => {
      expect(
        screen.getAllByText(/2 nota\(s\) · Distribuidora A, Distribuidora B/).length,
      ).toBeGreaterThan(0);
    });
  });

  it('a fronteira entre mercadoria e tributação está escrita NA TELA', async () => {
    abrir();
    await waitFor(() => {
      expect(
        screen.getAllByText(/CSOSN, CFOP e pCredSN continuam sendo decisão do contador/).length,
      ).toBeGreaterThan(0);
    });
  });
});
