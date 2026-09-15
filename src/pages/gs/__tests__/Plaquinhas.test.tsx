/**
 * A TELA DAS PLAQUINHAS — o pool, os lotes e a cara do adesivo (rodada 53).
 *
 * ## O que só a tela prova
 *
 * O servidor desta rodada tem teste próprio (`server/tests/plaquinhas-pool.test.ts`):
 * lá se prova que o número é do grupo, que liberar exige o papel e que a regra
 * de ouro recusa quem não usa plaquinha. Nada disso alcança o que mora aqui:
 *
 *   - a tela pode mostrar "Liberar" para um lote que nunca foi ao papel, e a
 *     pessoa clica para levar 409 — botão que sempre falha ensina a
 *     desconfiar do sistema;
 *   - a tela pode imprimir a folha e não relistar, e o lote fica com cara de
 *     que nada aconteceu;
 *   - a tela pode mandar o layout inteiro para o preview e não mostrar o
 *     resultado, e o editor vira formulário às cegas;
 *   - a tela pode oferecer o pool a uma loja de roupa — a regra de ouro tem
 *     que aparecer como TEXTO, não como lista vazia.
 *
 * Desde o P0 das plaquinhas a sessão destes casos é a PJ MOTORS: a plaquinha é
 * exclusiva dela, e a Oficina (a sessão de antes) abre a rota e vê "não
 * disponível nesta empresa" sem chamada nenhuma — o que o último bloco prova.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import PlaquinhasPage from '../PlaquinhasPage';

interface Plaquinha {
  id: string;
  public_id: number;
  publicIdLabel: string;
  status: string;
  batch_id: string | null;
  equipment_id: string | null;
  equipment_label: string | null;
  printed_at: string | null;
  damaged_reason: string | null;
  created_at: string;
}

let pool: Plaquinha[];
let usaPlaquinha: boolean;
/** O que a folha responde sobre o papel — piso do módulo e endereço público. */
let folhaAvisa: { abaixoDoPiso: boolean; moduloMm: number; baseUrlConfigurada: boolean };
/** A leitura do pool falha: "não sei" não pode virar "não há". */
let poolResponde500: boolean;
/** O servidor recusa a empresa (403 da regra de ouro) — a PJ com a marca desligada. */
let poolRecusaAEmpresa: boolean;
/** O campo que o servidor ANTIGO mandava no pool (`temBancada`); ausente = servidor de hoje. */
let temBancadaNoPool: boolean | undefined;
let pedidos: { metodo: string; url: string; corpo: Record<string, unknown> }[];

function plaquinha(n: number, extra: Partial<Plaquinha> = {}): Plaquinha {
  return {
    id: `tag-${n}`,
    public_id: n,
    publicIdLabel: `#${String(n).padStart(4, '0')}`,
    status: 'gerada',
    batch_id: 'lote-1',
    equipment_id: null,
    equipment_label: null,
    printed_at: null,
    damaged_reason: null,
    created_at: '2026-08-25T10:00:00.000Z',
    ...extra,
  };
}

/** O servidor dublado MEXE no estado: imprimir marca o papel, liberar anda. */
function servidor() {
  return vi.fn(async (url: string | URL | Request, init?: { method?: string; body?: string }) => {
    const alvo = String(url);
    const metodo = (init?.method ?? 'GET').toUpperCase();
    const corpo = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    pedidos.push({ metodo, url: alvo, corpo });

    const responder = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });

    if (alvo.includes('/equipment-tags/batches') && metodo === 'POST') {
      const quantos = Number(corpo.quantidade);
      const base = pool.length;
      for (let i = 1; i <= quantos; i += 1) pool.push(plaquinha(base + i));
      return responder({ batchId: 'lote-1', criadas: quantos, primeira: base + 1, ultima: base + quantos }, 201);
    }
    if (alvo.includes('/equipment-tags/batches')) {
      const doLote = pool.filter((t) => t.batch_id === 'lote-1');
      if (doLote.length === 0) return responder({ items: [] });
      return responder({
        items: [
          {
            batchId: 'lote-1',
            criadoEm: '2026-08-25T10:00:00.000Z',
            total: doLote.length,
            geradas: doLote.filter((t) => t.status === 'gerada').length,
            disponiveis: doLote.filter((t) => t.status === 'disponivel').length,
            associadas: 0,
            danificadas: doLote.filter((t) => t.status === 'danificada').length,
            impressas: doLote.filter((t) => t.printed_at).length,
            primeira: doLote[0]!.publicIdLabel,
            ultima: doLote[doLote.length - 1]!.publicIdLabel,
          },
        ],
      });
    }
    if (alvo.includes('/equipment-tags/sheet')) {
      if (corpo.preview === true) {
        const cor = (corpo.layout as Record<string, unknown>)?.bgColor ?? '#ffffff';
        return responder({ html: `<html><body style="background:${cor}">previa</body></html>`, preview: true });
      }
      const ids = (corpo.tagIds as string[]) ?? [];
      const doLote = corpo.batchId ? pool.filter((t) => t.batch_id === corpo.batchId) : [];
      const alvo = doLote.length > 0 ? doLote : pool.filter((t) => ids.includes(t.id));
      for (const t of alvo) t.printed_at = '2026-08-25T11:00:00.000Z';
      return responder({
        html: '<html><body>folha</body></html>',
        folhas: 1,
        plaquinhas: alvo.length,
        naoAchados: [],
        baseUrl: 'https://grupossampaio.com.br',
        ...folhaAvisa,
      });
    }
    if (alvo.includes('/equipment-tags/release')) {
      const semPapel = pool.filter((t) => t.status === 'gerada' && !t.printed_at);
      if (semPapel.length > 0) {
        return responder(
          {
            error: {
              code: 'CORE_TAG_NOT_PRINTED',
              message: `${semPapel.length} plaquinha(s) ainda não foram para o papel.`,
            },
          },
          409,
        );
      }
      let n = 0;
      for (const t of pool) {
        if (t.status === 'gerada') {
          t.status = 'disponivel';
          n += 1;
        }
      }
      return responder({ liberadas: n });
    }
    const danificar = alvo.match(/\/equipment-tags\/([^/]+)\/damage$/);
    if (danificar) {
      const t = pool.find((p) => p.id === danificar[1])!;
      t.status = 'danificada';
      t.damaged_reason = String(corpo.motivo ?? '');
      return responder(t);
    }
    if (alvo.includes('/equipment-tags/layout')) {
      if (metodo === 'PUT') return responder({ layout: corpo });
      return responder({
        layout: {
          logoUrl: null,
          logoXmm: 8,
          logoYmm: 4,
          logoWmm: 28,
          logoHmm: 20,
          bgColor: '#ffffff',
          textColor: '#1a1a1a',
          rounded: true,
          widthMm: 100,
          heightMm: 40,
          marginMm: 4,
        },
        usaPlaquinha,
      });
    }
    if (alvo.includes('/labels/equipment/formats')) {
      return responder({
        items: [{ id: 'plaq_a4_63x33_3col', label: 'Folha A4 — 21 por folha', hint: '' }],
      });
    }
    if (alvo.includes('/equipment-tags')) {
      if (poolRecusaAEmpresa) {
        return responder(
          {
            error: {
              code: 'CORE_COMPANY_NO_TAGS',
              message: 'Plaquinha com QR e número é exclusiva da PJ Motors: esta empresa não gera plaquinha.',
            },
          },
          403,
        );
      }
      if (poolResponde500) {
        return responder({ error: { code: 'API_UNAVAILABLE', message: 'Erro interno.' } }, 500);
      }
      const params = new URLSearchParams(alvo.split('?')[1] ?? '');
      const status = params.get('status');
      const items = status ? pool.filter((t) => t.status === status) : pool;
      return responder({
        items,
        resumo: {
          total: pool.length,
          gerada: pool.filter((t) => t.status === 'gerada').length,
          disponivel: pool.filter((t) => t.status === 'disponivel').length,
          associada: pool.filter((t) => t.status === 'associada').length,
          danificada: pool.filter((t) => t.status === 'danificada').length,
        },
        usaPlaquinha,
        ...(temBancadaNoPool === undefined ? {} : { temBancada: temBancadaNoPool }),
      });
    }
    return responder({});
  });
}

/** A PJ Motors por padrão: é a única empresa com plaquinha (P0 das plaquinhas). */
function entrarComo(
  profileCode: string,
  empresa: { slug: string; tradeName: string; kind: string } = { slug: 'pj-motors', tradeName: 'PJ Motors', kind: 'retail' },
) {
  setSession(
    {
      accessToken: 'token-de-teste',
      refreshToken: 'r',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'user-1', login: 'carlos', displayName: 'Carlos Gerente', profileCode },
      company: { id: empresa.slug, ...empresa },
      companies: [{ id: empresa.slug, ...empresa, profileCode }],
    },
    'LOGIN',
    'client.login',
  );
}

beforeEach(() => {
  pedidos = [];
  pool = [];
  usaPlaquinha = true;
  folhaAvisa = { abaixoDoPiso: false, moduloMm: 0.87, baseUrlConfigurada: true };
  poolResponde500 = false;
  poolRecusaAEmpresa = false;
  temBancadaNoPool = undefined;
  localStorage.clear();
  vi.stubGlobal('fetch', servidor());
  // A folha abre numa janela nova; no teste ela é dublada.
  vi.stubGlobal('open', vi.fn(() => ({ document: { write: vi.fn(), close: vi.fn() } })));
  entrarComo('gerente_oficina');
});

afterEach(() => {
  cleanup();
  setSession(null, 'LOGOUT', 'client.logout');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

function montar() {
  render(
    <MemoryRouter>
      <PlaquinhasPage />
    </MemoryRouter>,
  );
}

describe('o ciclo do adesivo, na tela', () => {
  it('gera o lote e as plaquinhas aparecem à espera de papel', async () => {
    montar();
    await screen.findByText('Gerar lote');

    fireEvent.change(screen.getByLabelText('Quantas plaquinhas'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Gerar' }));

    await waitFor(() => expect(screen.getByText(/3 plaquinha\(s\) reservadas/)).toBeTruthy());
    // A lista foi RELIDA: o número saiu do servidor, não do que a tela mandou.
    expect(await screen.findByText('#0001')).toBeTruthy();
    expect(screen.getAllByText('Gerada')).toHaveLength(3);
  });

  /**
   * O CORAÇÃO DA RODADA: liberar exige o papel.
   *
   * O servidor recusa, e a tela não espera a recusa para avisar — mas também
   * não esconde o botão: quem tem o lote na mão precisa entender que falta
   * IMPRIMIR, e o título do botão diz isso.
   */
  it('sem folha impressa, liberar leva a recusa que ensina o caminho', async () => {
    pool = [plaquinha(1), plaquinha(2)];
    montar();
    await screen.findByText('Lotes');

    fireEvent.click(screen.getByRole('button', { name: /^Liberar o lote/ }));

    const aviso = await screen.findByRole('alert');
    expect(aviso.textContent).toContain('não foram para o papel');
    // E nada mudou de estado.
    expect(screen.getAllByText('Gerada').length).toBeGreaterThan(0);
  });

  it('imprimir a folha marca o papel, e aí a liberação passa', async () => {
    pool = [plaquinha(1), plaquinha(2)];
    montar();
    await screen.findByText('Lotes');

    fireEvent.click(screen.getByRole('button', { name: /^Imprimir a folha do lote/ }));
    await waitFor(() => expect(screen.getByText(/1 folha\(s\) com 2 plaquinha\(s\)/)).toBeTruthy());
    // A folha veio do SERVIDOR pronta — a tela não desenha adesivo — e vai
    // pelo LOTE, não por uma lista de ids que a janela da listagem pode cortar.
    const folha = pedidos.find((p) => p.url.includes('/sheet'))!;
    expect(folha.corpo.batchId).toBe('lote-1');

    fireEvent.click(screen.getByRole('button', { name: /^Liberar o lote/ }));
    await waitFor(() => expect(screen.getByText(/2 plaquinha\(s\) liberadas/)).toBeTruthy());
    expect(await screen.findAllByText('Livre')).toHaveLength(2);
  });

  it('o botão de liberar explica o que falta antes de a pessoa clicar', async () => {
    pool = [plaquinha(1)];
    montar();
    await screen.findByText('Lotes');

    const liberar = screen.getByRole('button', { name: /^Liberar o lote/ });
    expect(liberar.getAttribute('title')).toContain('Imprima a folha antes');
  });

  it('marcar danificada exige dizer o que aconteceu, e o motivo aparece', async () => {
    pool = [plaquinha(1)];
    montar();
    await screen.findByText('#0001');

    fireEvent.click(screen.getByRole('button', { name: /^Marcar #0001 como danificada/ }));
    fireEvent.change(await screen.findByLabelText('O que aconteceu'), {
      target: { value: 'Impressão borrada' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar' }));

    await waitFor(() => expect(screen.getByText('Danificada')).toBeTruthy());
    const gravou = pedidos.find((p) => p.url.includes('/damage'))!;
    expect(gravou.corpo.motivo).toBe('Impressão borrada');
    expect(screen.getByText('Impressão borrada')).toBeTruthy();
  });
});

describe('o editor de layout', () => {
  it('a prévia vem do servidor, do mesmo desenho que imprime', async () => {
    montar();
    await screen.findByRole('button', { name: 'Editar o layout' });
    fireEvent.click(screen.getByRole('button', { name: 'Editar o layout' }));

    fireEvent.change(await screen.findByLabelText('Cor de fundo'), {
      target: { value: '#101820' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Ver como fica' }));

    // O preview é uma requisição ao MESMO renderizador da folha — desenhar a
    // prévia em CSS aqui seria uma segunda verdade sobre o papel.
    await waitFor(() => expect(screen.getByTitle('Prévia da plaquinha')).toBeTruthy());
    const previa = pedidos.find((p) => p.corpo.preview === true)!;
    expect((previa.corpo.layout as Record<string, unknown>).bgColor).toBe('#101820');
    expect(previa.url).toContain('/equipment-tags/sheet');
  });

  it('salvar manda o layout inteiro, e ele é da operação', async () => {
    montar();
    fireEvent.click(await screen.findByRole('button', { name: 'Editar o layout' }));
    fireEvent.change(await screen.findByLabelText('Largura (mm)'), { target: { value: '90' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar layout' }));

    await waitFor(() => expect(screen.getByText(/Layout salvo/)).toBeTruthy());
    const salvou = pedidos.find((p) => p.metodo === 'PUT')!;
    expect(salvou.corpo.widthMm).toBe(90);
  });
});

/**
 * A REGRA DE OURO APARECE COMO TEXTO.
 *
 * Lista vazia é ambígua: quem chega numa loja de roupa e vê zero plaquinhas
 * pensa que precisa gerar. A tela diz que ali a identificação é outra, e
 * aponta onde ela mora.
 */
describe('a regra de ouro na tela', () => {
  /*
    A RECUSA DO SERVIDOR VIRA O ESTADO "NÃO DISPONÍVEL" (P0 das plaquinhas).

    Antes o servidor respondia 200 com `usaPlaquinha: false`, e este caso
    cobrava a frase "Esta operação não usa plaquinha — é da PJ Motors e da
    Oficina". Agora a leitura é 403 `CORE_COMPANY_NO_TAGS` (a PJ com a marca
    desligada chega aqui), e a tela repete a frase do servidor em vez do alarme
    de "não consegui ler".
  */
  it('a recusa da regra de ouro vira "não disponível", com a frase do servidor — não um pool vazio', async () => {
    poolRecusaAEmpresa = true;
    montar();

    expect(await screen.findByText('Plaquinhas não disponíveis nesta empresa')).toBeTruthy();
    expect(screen.getByText(/exclusiva da PJ Motors/)).toBeTruthy();
    expect(screen.queryByText('Não foi possível ler as plaquinhas')).toBeNull();
    // E não há como gerar lote nenhum daqui.
    expect(screen.queryByRole('button', { name: 'Gerar' })).toBeNull();
  });

  it('a resposta antiga (200 com usaPlaquinha: false) cai no mesmo estado', async () => {
    usaPlaquinha = false;
    montar();

    expect(await screen.findByText('Plaquinhas não disponíveis nesta empresa')).toBeTruthy();
    expect(screen.getByText(/etiqueta de produto/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Gerar' })).toBeNull();
  });

  it('quem não edita layout não recebe o botão do editor', async () => {
    entrarComo('mecanico');
    montar();
    // "Plaquinhas" aparece no título E no fio de navegação: o recorte é o
    // card do lote, que é o que o mecânico usa.
    await screen.findByText('Gerar lote');

    expect(screen.queryByRole('button', { name: 'Editar o layout' })).toBeNull();
    // Mas continua podendo gerar lote: é trabalho de bancada.
    expect(await screen.findByRole('button', { name: 'Gerar' })).toBeTruthy();
  });
});

/**
 * O QUE A REVISÃO ADVERSÁRIA DA RODADA ACHOU NESTA TELA.
 */
describe('o que a tela fazia errado', () => {
  /**
   * A PRÉVIA DESFAZIA O FORMULÁRIO.
   *
   * Ver a prévia relia a tela, e reler traz o layout GRAVADO do servidor por
   * cima do que estava sendo editado. Quem mexia nas cores, olhava a prévia e
   * clicava em "Salvar" gravava os valores VELHOS — com a tela dizendo
   * "Layout salvo" com todas as letras.
   */
  it('ver a prévia não devolve o formulário ao layout gravado', async () => {
    montar();
    fireEvent.click(await screen.findByRole('button', { name: 'Editar o layout' }));

    const cor = await screen.findByLabelText('Cor de fundo');
    fireEvent.change(cor, { target: { value: '#101820' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ver como fica' }));
    await waitFor(() => expect(screen.getByTitle('Prévia da plaquinha')).toBeTruthy());

    // O campo continua com o que a pessoa escolheu.
    expect((cor as HTMLInputElement).value).toBe('#101820');
    // E salvar grava isso, não o valor de antes.
    fireEvent.click(screen.getByRole('button', { name: 'Salvar layout' }));
    await waitFor(() => expect(pedidos.some((p) => p.metodo === 'PUT')).toBe(true));
    expect(pedidos.find((p) => p.metodo === 'PUT')!.corpo.bgColor).toBe('#101820');
  });

  /**
   * O LOTE VAI AO PAPEL PELO ID DO LOTE.
   *
   * Listar as plaquinhas antes e mandar os ids não funciona em lote grande: a
   * lista tem teto e ordena pelo número mais novo — num lote de mil, as que
   * sobram da janela nunca vão ao papel, e sem papel não há liberação.
   */
  it('imprimir manda o LOTE, não uma lista de ids que pode estar cortada', async () => {
    pool = [plaquinha(1), plaquinha(2)];
    montar();
    await screen.findByText('Lotes');

    fireEvent.click(screen.getByRole('button', { name: /^Imprimir a folha do lote/ }));
    await waitFor(() => expect(pedidos.some((p) => p.url.includes('/sheet'))).toBe(true));
    const folha = pedidos.find((p) => p.url.includes('/sheet'))!;
    expect(folha.corpo.batchId).toBe('lote-1');
    expect(folha.corpo.tagIds).toBeUndefined();
  });

  /**
   * OS AVISOS QUE DECIDEM SE VALE GASTAR ADESIVO.
   *
   * Módulo abaixo do piso a câmera de celular não lê; endereço público não
   * configurado faz o QR apontar para um domínio de reserva — e isso só se
   * descobre quando um cliente tenta escanear, com o adesivo já colado. A tela
   * de Etiquetas já dava os dois avisos; esta não dava nenhum.
   */
  it('avisa quando o QR fica pequeno demais ou o endereço não está configurado', async () => {
    pool = [plaquinha(1)];
    folhaAvisa = { abaixoDoPiso: true, moduloMm: 0.42, baseUrlConfigurada: false };
    montar();
    await screen.findByText('Lotes');

    fireEvent.click(screen.getByRole('button', { name: /^Imprimir a folha do lote/ }));

    const aviso = await screen.findByRole('status');
    expect(aviso.textContent).toContain('abaixo do');
    expect(aviso.textContent).toContain('0,42');
    expect(aviso.textContent).toContain('endereço público não está configurado');
  });

  it('pop-up bloqueado é dito, porque as plaquinhas já contam como impressas', async () => {
    pool = [plaquinha(1)];
    // O navegador recusa a janela: é o caso comum em quem tem bloqueador.
    vi.stubGlobal('open', vi.fn(() => null));
    montar();
    await screen.findByText('Lotes');

    fireEvent.click(screen.getByRole('button', { name: /^Imprimir a folha do lote/ }));

    const aviso = await screen.findByRole('status');
    expect(aviso.textContent).toContain('bloqueou a janela');
    expect(aviso.textContent).toContain('já contam como impressas');
  });

  /**
   * "NÃO CONSEGUI LER" NÃO É "NÃO HÁ PLAQUINHA".
   *
   * Com a lista zerada e o erro rolado para fora da tela, o pool aparecia
   * vazio com toda a confiança — e o caminho seguinte é gerar um lote que
   * talvez já exista, queimando numeração do grupo.
   */
  it('falha ao carregar não vira pool vazio', async () => {
    poolResponde500 = true;
    montar();

    expect(await screen.findByText('Não foi possível ler as plaquinhas')).toBeTruthy();
    expect(screen.getByText(/não porque o pool esteja vazio/)).toBeTruthy();
  });

  it('o mecânico não recebe o botão de liberar — a rota não o aceita', async () => {
    pool = [plaquinha(1, { printed_at: '2026-08-25T11:00:00.000Z' })];
    entrarComo('mecanico');
    montar();
    await screen.findByText('Lotes');

    expect(screen.getByRole('button', { name: /^Imprimir a folha do lote/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Liberar o lote/ })).toBeNull();
  });

  it('o seletor oferece o tamanho do editor, e ele vai na folha', async () => {
    pool = [plaquinha(1)];
    montar();
    await screen.findByText('Lotes');

    const seletor = screen.getByLabelText('Formato da folha');
    expect(within(seletor).getByRole('option', { name: /Personalizado — 100 × 40 mm/ })).toBeTruthy();

    fireEvent.change(seletor, { target: { value: 'plaq_personalizado' } });
    fireEvent.click(screen.getByRole('button', { name: /^Imprimir a folha do lote/ }));
    await waitFor(() => expect(pedidos.some((p) => p.url.includes('/sheet'))).toBe(true));
    expect(pedidos.find((p) => p.url.includes('/sheet'))!.corpo.formatId).toBe('plaq_personalizado');
  });
});

/**
 * A ROTA FORA DA PJ MOTORS (P0 das plaquinhas).
 *
 * Quem digita `/sistema/equipamentos/plaquinhas` na Oficina, na Preço Justo ou
 * numa loja de roupa vê "não disponível nesta empresa" — e a tela não faz
 * chamada de plaquinha nenhuma: nem lista, nem lote, nem layout, nem formato.
 * O que sai é só o da CASCA (`EstadoConexao`: a sonda `/health` e a fila de
 * vendas offline da própria empresa), que toda tela faz e que não é plaquinha.
 */
describe('fora da PJ Motors a rota não abre o pool', () => {
  for (const empresa of [
    { slug: 'oficina', tradeName: 'Oficina', kind: 'workshop' },
    { slug: 'preco-justo', tradeName: 'Preço Justo', kind: 'retail' },
    { slug: 'gringa', tradeName: 'Gringa', kind: 'retail' },
  ]) {
    it(`${empresa.tradeName}: "não disponível nesta empresa", e nenhum pedido ao servidor`, async () => {
      entrarComo('gerente_oficina', empresa);
      montar();

      expect(await screen.findByText('Plaquinhas não disponíveis nesta empresa')).toBeTruthy();
      expect(screen.getByText(/exclusiva da PJ Motors/)).toBeTruthy();
      expect(screen.queryByText('Gerar lote')).toBeNull();
      expect(screen.queryByText('Lotes')).toBeNull();
      expect(pedidos.filter((p) => /equipment-tags|labels\/equipment/.test(p.url))).toEqual([]);
      // Tudo o que saiu é da casca — nenhuma leitura da tela.
      const daCasca = /\/health(\?|$)|\/core\/offline-sales\?/;
      expect(pedidos.map((p) => p.url).filter((u) => !daCasca.test(u))).toEqual([]);
    });
  }
});

/**
 * A PJ MOTORS GERA SEM BANCADA (decisão do dono, depois do P0).
 *
 * A tela escondia "Gerar lote" quando o pool dizia `temBancada: false` e punha
 * no lugar o aviso "Esta operação não tem bancada: a plaquinha vem da oficina".
 * A PJ — a única empresa com plaquinha — não tem bancada: o gestor dela nunca
 * via o botão, e o grupo ficou sem ninguém que gerasse lote. O caso manda o
 * campo como o servidor ANTIGO mandava: a tela não pode mais obedecê-lo.
 */
describe('a PJ Motors sem bancada gera lote', () => {
  it('o gestor da PJ vê "Gerar lote", nenhum aviso de bancada, e o lote nasce', async () => {
    temBancadaNoPool = false;
    entrarComo('gerente_loja');
    montar();

    // Espera a leitura do pool TERMINAR: antes dela a tela antiga também
    // mostrava o cartão, e só o escondia quando chegava `temBancada: false`.
    await screen.findByText('Nenhuma plaquinha');
    expect(screen.getByText('Gerar lote')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Operação sem bancada' })).toBeNull();
    expect(screen.queryByText(/não tem bancada/)).toBeNull();

    fireEvent.change(screen.getByLabelText('Quantas plaquinhas'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Gerar' }));
    await waitFor(() => expect(screen.getByText(/2 plaquinha\(s\) reservadas/)).toBeTruthy());
    const pedido = pedidos.find((p) => p.metodo === 'POST' && p.url.includes('/equipment-tags/batches'))!;
    expect(pedido.corpo).toEqual({ quantidade: 2 });
    // O gestor da PJ também edita o layout e libera: é ele quem administra.
    expect(screen.getByRole('button', { name: 'Editar o layout' })).toBeTruthy();
    expect(await screen.findByRole('button', { name: /^Liberar o lote/ })).toBeTruthy();
  });

  it('o caixa do PDV da PJ não recebe gerar, layout nem liberar (PDV não administra)', async () => {
    pool = [plaquinha(1, { printed_at: '2026-08-25T11:00:00.000Z' })];
    entrarComo('operador_caixa_loja');
    montar();
    await screen.findByText('Lotes');

    expect(screen.queryByText('Gerar lote')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Editar o layout' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Liberar o lote/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /como danificada/ })).toBeNull();
  });
});

describe('a busca do balcão', () => {
  it('procura pelo número do jeito que a pessoa fala', async () => {
    pool = [plaquinha(7, { status: 'associada', equipment_label: 'Shineray PT2' })];
    montar();
    await screen.findByText('#0007');

    fireEvent.change(screen.getByPlaceholderText(/#0007 ou o nome da máquina/), {
      target: { value: '#0007' },
    });

    await waitFor(() =>
      expect(pedidos.some((p) => p.url.includes('busca=%230007'))).toBe(true),
    );
    const linha = screen.getByText('#0007').closest('tr') as HTMLElement;
    expect(within(linha).getByText('Shineray PT2')).toBeTruthy();
    expect(within(linha).getByText('Na máquina')).toBeTruthy();
  });
});
