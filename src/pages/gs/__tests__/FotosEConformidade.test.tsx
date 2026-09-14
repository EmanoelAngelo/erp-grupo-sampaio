/**
 * FOTOS EM LOTE E CONFORMIDADE NA TELA — rodada 45.
 *
 * O que este arquivo trava:
 *
 *   - o lote NÃO sobe às cegas: os nomes são resolvidos no servidor e o
 *     arquivo sem produto não viaja;
 *   - as páginas legais existem, com o "Quem somos" vindo do endpoint de
 *     identificação (fonte única com o rodapé);
 *   - o rodapé carrega a identificação legal — e na página de uma marca
 *     mostra a empresa DAQUELA loja, não a lista inteira.
 *
 * ## Como cada caso fica vermelho
 *
 *   - suba o arquivo sem produto e o caso do envio cai;
 *   - deixe o rodapé listar todas as empresas na página da marca e o caso
 *     do recorte cai;
 *   - tire o CNPJ do "Quem somos" e o caso da política cai.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import { limparCacheIdentificacao } from '@/hooks/useIdentificacaoLoja';
import { CascaDaLoja } from '@/components/gs/CascaDaLoja';
import { PoliticaDePrivacidadePage, TrocasEDevolucoesPage } from '../PaginasLegais';
import FotosEmLotePage from '../FotosEmLotePage';

vi.mock('@/lib/image', () => ({
  normalizeImage: async (file: File) => ({
    dataUrl: 'data:image/jpeg;base64,Zm9v',
    mimeType: 'image/jpeg',
    width: 1,
    height: 1,
    bytes: 3,
    fileName: file.name,
  }),
}));

const IDENTIFICACAO = {
  stores: [
    {
      slug: 'gringa',
      tradeName: 'Gringa',
      legalName: 'Gringa Moda Ltda',
      cnpj: '11.222.333/0001-81',
      address: 'Rua das Andradas, 1000 — Centro — Pelotas/RS',
      phone: null,
    },
    {
      slug: 'preco-justo',
      tradeName: 'Preço Justo',
      legalName: 'Preço Justo Comércio Ltda',
      cnpj: '99.888.777/0001-55',
      address: null,
      phone: null,
    },
  ],
};

let posts: { url: string; corpo: Record<string, unknown> }[];
let resolvidos: Record<string, unknown>[];
let prontidaoQuebrada: boolean;

function servidor() {
  return vi.fn(async (url: string | URL | Request, init?: { method?: string; body?: string }) => {
    const alvo = String(url);
    const metodo = (init?.method ?? 'GET').toUpperCase();
    const corpo = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    if (metodo === 'POST') posts.push({ url: alvo, corpo });

    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });

    if (alvo.includes('/loja/identificacao')) return json(IDENTIFICACAO);
    if (alvo.includes('/fotos-em-lote/resolver')) return json({ items: resolvidos });
    if (/\/products\/[^/]+\/images$/.test(alvo)) return json({ id: 'img-x' }, 201);
    if (alvo.includes('/prontidao-online')) {
      if (prontidaoQuebrada) return json({ error: { code: 'X', message: 'quebrou' } }, 500);
      return json({
        items: [
          { id: 'p-nu', name: 'Produto pelado', internalCode: 'NU-1', publishOnline: true, blockers: ['sem_foto'] },
          { id: 'p-ok', name: 'Produto vestido', internalCode: 'OK-1', publishOnline: true, blockers: [] },
        ],
      });
    }
    return json({ items: [] });
  });
}

function entrar() {
  setSession(
    {
      accessToken: 'token-de-teste',
      refreshToken: 'r',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'u-1', login: 'ger', displayName: 'Gerente', profileCode: 'gerente_loja' },
      company: { id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail' },
      companies: [
        { id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail', profileCode: 'gerente_loja' },
      ],
    } as never,
    'LOGIN',
    'teste da rodada 45',
  );
}

beforeEach(() => {
  posts = [];
  prontidaoQuebrada = false;
  resolvidos = [
    {
      name: '7890000000031.jpg',
      code: '7890000000031',
      productId: 'p-1',
      productName: 'Bateria 60V',
      internalCode: 'PB-1',
      temFoto: false,
    },
    {
      name: 'sem-dono.jpg',
      code: 'sem-dono',
      productId: null,
      productName: null,
      internalCode: null,
      temFoto: false,
    },
  ];
  localStorage.clear();
  limparCacheIdentificacao();
  vi.stubGlobal('fetch', servidor());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setSession(null, 'LOGOUT', 'teste da rodada 45');
  localStorage.clear();
});

describe('fotos em lote', () => {
  function arquivo(nome: string): File {
    return new File(['x'], nome, { type: 'image/jpeg' });
  }

  async function montarComArquivos() {
    entrar();
    render(
      <MemoryRouter>
        <FotosEmLotePage />
      </MemoryRouter>,
    );
    const input = screen.getByLabelText('Arquivos de foto');
    fireEvent.change(input, {
      target: { files: [arquivo('7890000000031.jpg'), arquivo('sem-dono.jpg')] },
    });
    await screen.findByText('Conferência do lote');
  }

  it('resolve os nomes no servidor e mostra o casamento ANTES de subir', async () => {
    await montarComArquivos();
    const resolver = posts.find((p) => p.url.includes('/fotos-em-lote/resolver'));
    expect(resolver).toBeTruthy();
    expect(resolver!.corpo.names).toEqual(['7890000000031.jpg', 'sem-dono.jpg']);

    await screen.findByText('Bateria 60V');
    screen.getByText('sem produto com o código "sem-dono"');
    // O botão conta SÓ os casados.
    screen.getByRole('button', { name: 'Enviar 1 foto(s)' });
  });

  it('o envio sobe a foto casada e NÃO sobe a sem produto', async () => {
    await montarComArquivos();
    fireEvent.click(screen.getByRole('button', { name: 'Enviar 1 foto(s)' }));
    await screen.findByText('Enviada');

    const uploads = posts.filter((p) => /\/products\/[^/]+\/images$/.test(p.url));
    expect(uploads).toHaveLength(1);
    expect(uploads[0].url).toContain('/products/p-1/images');
    expect(String(uploads[0].corpo.dataUrl)).toContain('base64');
    await screen.findByText(/1 foto\(s\) enviada\(s\), 1 sem produto/);
  });

  it('clicar Enviar de novo NÃO reenvia a já enviada — a revisão mordeu aqui', async () => {
    await montarComArquivos();
    fireEvent.click(screen.getByRole('button', { name: 'Enviar 1 foto(s)' }));
    await screen.findByText('Enviada');
    // Zero pendentes: o botão desarma com a contagem zerada.
    const botao = screen.getByRole('button', { name: 'Enviar 0 foto(s)' });
    expect((botao as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(botao);
    const uploads = posts.filter((p) => /\/products\/[^/]+\/images$/.test(p.url));
    expect(uploads).toHaveLength(1);
  });

  it('erro ao medir a prontidão NÃO vira "tudo fotografado" — a revisão mordeu aqui', async () => {
    entrar();
    prontidaoQuebrada = true;
    render(
      <MemoryRouter>
        <FotosEmLotePage />
      </MemoryRouter>,
    );
    await screen.findByText('Não foi possível medir');
    expect(screen.queryByText('Tudo fotografado')).toBeNull();
  });

  it('mostra o que ainda falta fotografar — só os publicados sem foto', async () => {
    entrar();
    render(
      <MemoryRouter>
        <FotosEmLotePage />
      </MemoryRouter>,
    );
    await screen.findByText('Produto pelado');
    expect(screen.queryByText('Produto vestido')).toBeNull();
  });
});

describe('as páginas legais', () => {
  it('a política de privacidade traz o "Quem somos" com CNPJ — a identificação da lei', async () => {
    render(
      <MemoryRouter>
        <PoliticaDePrivacidadePage />
      </MemoryRouter>,
    );
    await screen.findByRole('heading', { name: 'Política de Privacidade' });
    // A razão social aparece DUAS vezes de propósito: no Quem somos e no
    // rodapé — fonte única, mesma verdade nos dois lugares.
    const ocorrencias = await screen.findAllByText(/Gringa Moda Ltda/);
    expect(ocorrencias.length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText(/11\.222\.333\/0001-81/).length).toBeGreaterThanOrEqual(1);
  });

  it('trocas e devoluções fala dos 7 dias do arrependimento — o direito central do CDC', async () => {
    render(
      <MemoryRouter>
        <TrocasEDevolucoesPage />
      </MemoryRouter>,
    );
    await screen.findByRole('heading', { name: 'Trocas e Devoluções' });
    screen.getByText(/7 dias corridos/);
    screen.getByText(/art\. 49/);
  });
});

describe('a identificação viaja UMA vez', () => {
  it('a página legal (Quem somos + rodapé) dispara uma única busca — a revisão mordeu aqui', async () => {
    render(
      <MemoryRouter>
        <PoliticaDePrivacidadePage />
      </MemoryRouter>,
    );
    await screen.findAllByText(/Gringa Moda Ltda/);
    const buscas = (fetch as ReturnType<typeof vi.fn>).mock.calls.filter((c) =>
      String(c[0]).includes('/loja/identificacao'),
    );
    expect(buscas).toHaveLength(1);
  });
});

describe('o rodapé legal', () => {
  it('tem os links das três políticas e a identificação das lojas', async () => {
    render(
      <MemoryRouter>
        <CascaDaLoja>
          <p>conteúdo</p>
        </CascaDaLoja>
      </MemoryRouter>,
    );
    const rodape = document.querySelector('footer') as HTMLElement;
    within(rodape).getByRole('link', { name: 'Privacidade' });
    within(rodape).getByRole('link', { name: 'Termos de Uso' });
    within(rodape).getByRole('link', { name: 'Trocas e Devoluções' });
    // A identificação chega — as DUAS empresas na página comum.
    await within(rodape).findByText(/Gringa Moda Ltda/);
    within(rodape).getByText(/Preço Justo Comércio Ltda/);
  });

  it('na página de uma MARCA, o rodapé identifica a empresa daquela loja — não a lista inteira', async () => {
    render(
      <MemoryRouter>
        <CascaDaLoja marca={{ slug: 'gringa', nome: 'Gringa' }}>
          <p>conteúdo</p>
        </CascaDaLoja>
      </MemoryRouter>,
    );
    const rodape = document.querySelector('footer') as HTMLElement;
    await within(rodape).findByText(/Gringa Moda Ltda — CNPJ 11\.222\.333\/0001-81/);
    expect(within(rodape).queryByText(/Preço Justo Comércio Ltda/)).toBeNull();
  });
});
