/**
 * A CONFERÊNCIA DE ENTRADA E AS FOTOS — na tela da OS (rodada 52).
 *
 * ## O que só a tela prova
 *
 * O servidor desta rodada tem teste próprio (`server/tests/equipamento-completo.test.ts`):
 * lá se prova que o checklist nasce com o molde da bancada, que responder grava
 * quem respondeu, que a conclusão trava com item pendente e que a foto chega em
 * arquivo no disco. Nada disso alcança o defeito que mora aqui:
 *
 *   - a tela pode montar o card e nunca chamar o PATCH — o item fica marcado só
 *     no olho de quem clicou, e a próxima leitura desmarca;
 *   - a tela pode oferecer "Concluir" habilitado com pendência e deixar o
 *     servidor recusar — botão que sempre falha ensina a desconfiar do sistema;
 *   - a tela pode oferecer "Concluir assim mesmo" sem mandar `forcarChecklist`,
 *     e o caminho de escape vira um botão que não faz nada;
 *   - a tela pode mandar a foto ORIGINAL da câmera (4 MB) e levar 413 do
 *     servidor, com a redução escrita e nunca chamada.
 *
 * ## O realce que apontava para o lugar errado
 *
 * O primeiro desenho pintava de primário o botão da resposta ATUAL — e como
 * item novo nasce `pendente`, quem destacava era o "Limpar". A tela gritava a
 * ação de desfazer e sussurrava as duas respostas, em cinza sem contorno. Item
 * sem resposta não tem o que limpar: as duas escolhas é que precisam parecer
 * clicáveis, e "Limpar" só existe depois que há resposta para desfazer.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import OrdemServicoPage from '../OrdemServicoPage';

const OS_ID = 'os-52';
const BANCADA = 'wk-mobilidade';
const MECANICO = 'user-mec';

interface ItemDeConferencia {
  id: string;
  item: string;
  answer: string;
  note: string | null;
  position: number;
  answered_by_name?: string | null;
  answered_at?: string | null;
}

interface FotoDaOs {
  id: string;
  url: string;
  kind: string;
  caption: string | null;
  file_name: string | null;
  created_at: string;
}

let os: Record<string, unknown>;
let conferencia: ItemDeConferencia[];
let fotos: FotoDaOs[];
/** Cada requisição, com corpo: é por ela que se prova o que a tela MANDOU. */
let pedidos: { metodo: string; url: string; corpo: Record<string, unknown> }[];
/** O que a próxima ESCRITA responde. Nulo = sucesso. */
let recusaDoServidor: { status: number; code: string; message: string } | null;

function osEmAndamento() {
  return {
    id: OS_ID,
    number: 52,
    status: 'em_andamento',
    workshop_id: BANCADA,
    workshop_name: 'Oficina de Mobilidade Elétrica',
    mechanic_id: MECANICO,
    mechanic_name: 'Zé Mecânico',
    customer_display: 'Dona Marta',
    customer_phone: null,
    customer_id: null,
    equipment_display: 'Scooter Elétrica 1000W',
    equipment_public_id: null,
    equipment_serial: null,
    plate: null,
    complaint: 'não carrega',
    diagnosis: null,
    priority: 'media',
    due_date: null,
    labor_cents: 15000,
    parts_cents: 0,
    total_cents: 15000,
    opened_by_customer: 0,
    created_at: '2026-08-20T12:00:00.000Z',
    parts: [],
    comments: [],
    events: [],
  };
}

function conferenciaDeTres(): ItemDeConferencia[] {
  return [
    { id: 'ck-1', item: 'Chave / controle remoto', answer: 'pendente', note: null, position: 0 },
    { id: 'ck-2', item: 'Carregador', answer: 'pendente', note: null, position: 1 },
    { id: 'ck-3', item: 'Bateria (e trava)', answer: 'pendente', note: null, position: 2 },
  ];
}

/**
 * O servidor dublado MEXE no estado.
 *
 * Responder 200 sem gravar deixaria passar exatamente o defeito que este
 * arquivo persegue: a tela que marca no olho e não relê. Aqui o PATCH muda o
 * item, e o contador do card só anda porque a leitura seguinte traz a mudança.
 */
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

    if (recusaDoServidor && metodo !== 'GET') {
      const r = recusaDoServidor;
      return responder({ error: { code: r.code, message: r.message } }, r.status);
    }

    if (alvo.includes('/impressao')) {
      /*
        A impressão é uma LEITURA, e a recusa dela também tem que chegar: o
        guarda de `recusaDoServidor` acima só vale para escrita, e uma OS de
        outra bancada responde 404 num GET.
      */
      if (recusaDoServidor) {
        const r = recusaDoServidor;
        return responder({ error: { code: r.code, message: r.message } }, r.status);
      }
      // O servidor devolve o documento PRONTO — a tela não desenha papel.
      return responder({
        html: '<html><body><h1>Ordem de serviço</h1></body></html>',
        numero: 52,
        marca: 'PJ Motors',
      });
    }

    const respostaDoItem = alvo.match(/\/workshop\/orders\/[^/]+\/checklist\/([^/?]+)$/);
    if (metodo === 'PATCH' && respostaDoItem) {
      const item = conferencia.find((i) => i.id === respostaDoItem[1]);
      if (!item) return responder({ error: { code: 'NOT_FOUND', message: 'não existe' } }, 404);
      item.answer = String(corpo.answer);
      item.answered_by_name = item.answer === 'pendente' ? null : 'Zé Mecânico';
      return responder(item);
    }

    if (alvo.includes('/checklist')) return responder({ items: conferencia });

    const apagarFoto = alvo.match(/\/workshop\/orders\/[^/]+\/photos\/([^/?]+)$/);
    if (metodo === 'DELETE' && apagarFoto) {
      fotos = fotos.filter((f) => f.id !== apagarFoto[1]);
      return responder({ ok: true });
    }

    if (metodo === 'POST' && /\/workshop\/orders\/[^/]+\/photos$/.test(alvo)) {
      fotos.push({
        id: `foto-${fotos.length + 1}`,
        url: `/uploads/os/foto-${fotos.length + 1}.jpg`,
        kind: String(corpo.kind ?? 'servico'),
        caption: null,
        file_name: String(corpo.fileName ?? ''),
        created_at: '2026-08-24T12:00:00.000Z',
      });
      return responder({ id: `foto-${fotos.length}` }, 201);
    }

    if (alvo.includes('/photos')) return responder({ items: fotos });

    if (metodo === 'POST' && alvo.includes('/complete')) {
      os.status = 'aguardando_pagamento';
      return responder({ ok: true });
    }

    if (/\/core\/workshop\/orders\/[^/]+$/.test(alvo)) return responder(os);

    return responder({});
  });
}

function entrarComo(profileCode: string, userId = MECANICO) {
  setSession(
    {
      accessToken: 'token-de-teste',
      refreshToken: 'r',
      expiresAt: Date.now() + 3_600_000,
      user: { id: userId, login: 'ze', displayName: 'Zé Mecânico', profileCode },
      company: { id: 'oficina', slug: 'oficina', tradeName: 'Oficina', kind: 'workshop' },
      companies: [
        { id: 'oficina', slug: 'oficina', tradeName: 'Oficina', kind: 'workshop', profileCode },
      ],
    },
    'LOGIN',
    'client.login',
  );
}

beforeEach(() => {
  pedidos = [];
  recusaDoServidor = null;
  os = osEmAndamento();
  conferencia = conferenciaDeTres();
  fotos = [];
  localStorage.clear();
  vi.stubGlobal('fetch', servidor());
  entrarComo('mecanico');
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
    <MemoryRouter initialEntries={[`/sistema/oficina/os/${OS_ID}`]}>
      <Routes>
        <Route path="/sistema/oficina/os/:id" element={<OrdemServicoPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** A linha de um item da conferência — o recorte que separa um item do vizinho. */
function linhaDe(nome: string): HTMLElement {
  return screen.getByText(nome).closest('li') as HTMLElement;
}

async function abrirATela() {
  await screen.findByText('Chave / controle remoto');
}

describe('a conferência de entrada na tela da OS', () => {
  it('lista os itens da bancada e o contador anda quando a resposta é GRAVADA', async () => {
    montar();
    await abrirATela();

    // O título conta quantos já foram respondidos: é o que quem passa na
    // bancada olha antes de abrir o aparelho.
    expect(screen.getByText('Conferência de entrada (0/3)')).toBeTruthy();

    fireEvent.click(within(linhaDe('Carregador')).getByRole('button', { name: 'Veio' }));

    await waitFor(() => expect(screen.getByText('Conferência de entrada (1/3)')).toBeTruthy());
    // A resposta foi ao servidor com o valor certo — não ficou só no estado da
    // tela, que a releitura seguinte apagaria.
    const gravou = pedidos.find((p) => p.metodo === 'PATCH' && p.url.includes('/checklist/ck-2'));
    expect(gravou).toBeTruthy();
    expect(gravou!.corpo.answer).toBe('sim');
  });

  it('"Não veio" grava a ausência, que é a resposta que segura discussão depois', async () => {
    montar();
    await abrirATela();

    fireEvent.click(within(linhaDe('Chave / controle remoto')).getByRole('button', { name: 'Não veio' }));

    await waitFor(() => expect(screen.getByText('Conferência de entrada (1/3)')).toBeTruthy());
    const gravou = pedidos.find((p) => p.metodo === 'PATCH' && p.url.includes('/checklist/ck-1'));
    expect(gravou!.corpo.answer).toBe('nao');
  });

  /**
   * O REALCE APONTA PARA A ESCOLHA, NÃO PARA O DESFAZER.
   *
   * Item pendente não tem o que limpar. Se "Limpar" aparecer ali — e pior, em
   * destaque, porque `pendente` é a "resposta atual" — a tela oferece três
   * caminhos onde existem dois e chama de estado o que é ação.
   */
  it('item sem resposta oferece as duas escolhas e nenhum "Limpar"', async () => {
    montar();
    await abrirATela();

    const linha = linhaDe('Bateria (e trava)');
    expect(within(linha).getByRole('button', { name: 'Veio' })).toBeTruthy();
    expect(within(linha).getByRole('button', { name: 'Não veio' })).toBeTruthy();
    expect(within(linha).queryByRole('button', { name: 'Limpar' })).toBeNull();
  });

  it('respondido, aparece o "Limpar" — e ele devolve o item ao pendente', async () => {
    montar();
    await abrirATela();

    fireEvent.click(within(linhaDe('Bateria (e trava)')).getByRole('button', { name: 'Veio' }));
    await waitFor(() => expect(screen.getByText('Conferência de entrada (1/3)')).toBeTruthy());

    const limpar = within(linhaDe('Bateria (e trava)')).getByRole('button', { name: 'Limpar' });
    fireEvent.click(limpar);

    await waitFor(() => expect(screen.getByText('Conferência de entrada (0/3)')).toBeTruthy());
    const desfez = pedidos.filter((p) => p.metodo === 'PATCH').at(-1);
    expect(desfez!.corpo.answer).toBe('pendente');
  });

  /**
   * A RECUSA MORA ONDE O CLIQUE ACONTECEU — e não derruba a OS.
   *
   * `erro` é o canal FATAL desta tela: preenchido, a página inteira vira o
   * vazio "Ordem de serviço não encontrada", com a recusa de aparência. Some
   * tudo: peças, mão de obra, conferência, histórico.
   */
  it('conferência recusada explica no próprio card, sem derrubar a OS', async () => {
    recusaDoServidor = {
      status: 409,
      code: 'CORE_ORDER_CLOSED',
      message: 'OS finalizada: a conferência não muda mais.',
    };
    montar();
    await abrirATela();

    fireEvent.click(within(linhaDe('Carregador')).getByRole('button', { name: 'Veio' }));

    const aviso = await screen.findByRole('alert');
    expect(aviso.textContent).toContain('não muda mais');
    expect(screen.queryByText('Ordem de serviço não encontrada')).toBeNull();
    expect(screen.getByText('Peças aplicadas')).toBeTruthy();
    const cardDaConferencia = screen
      .getByText(/^Conferência de entrada/)
      .closest('section') as HTMLElement;
    expect(within(cardDaConferencia).getByRole('alert')).toBeTruthy();
  });

  it('OS antiga, sem conferência nenhuma, não ganha card vazio', async () => {
    conferencia = [];
    montar();
    await screen.findByText('Peças aplicadas');

    expect(screen.queryByText(/Conferência de entrada/)).toBeNull();
  });
});

/**
 * A CONCLUSÃO OLHA A CONFERÊNCIA.
 *
 * O servidor recusa com `CORE_CHECKLIST_PENDING`; a tela não espera a recusa
 * para avisar. E o escape existe de propósito: cliente esperando no balcão não
 * pode ficar preso porque falta responder se o retrovisor veio.
 */
describe('concluir com a conferência pela metade', () => {
  async function abrirAConclusao() {
    montar();
    await abrirATela();
    fireEvent.click(screen.getByRole('button', { name: 'Concluir serviço' }));
    await screen.findByRole('button', { name: 'Confirmar conclusão' });
    // O diagnóstico é exigência anterior a esta rodada e vale para os dois
    // caminhos: sem ele a tela nem chega a falar com o servidor, e o teste
    // mediria a recusa errada.
    fireEvent.change(screen.getByLabelText('Diagnóstico / o que foi feito'), {
      target: { value: 'Bateria substituída' },
    });
  }

  it('trava a conclusão, diz quantos faltam e oferece o caminho de forçar', async () => {
    await abrirAConclusao();

    const confirmar = screen.getByRole('button', { name: 'Confirmar conclusão' });
    expect((confirmar as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/tem 3 item\(ns\) sem resposta/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Concluir assim mesmo' })).toBeTruthy();
  });

  it('"Concluir assim mesmo" manda o forçar — sem ele o botão não faria nada', async () => {
    await abrirAConclusao();

    fireEvent.click(screen.getByRole('button', { name: 'Concluir assim mesmo' }));

    await waitFor(() =>
      expect(pedidos.some((p) => p.url.includes('/complete'))).toBe(true),
    );
    const concluiu = pedidos.find((p) => p.url.includes('/complete'))!;
    expect(concluiu.corpo.forcarChecklist).toBe(true);
  });

  it('com tudo respondido, conclui sem forçar nada', async () => {
    conferencia = conferenciaDeTres().map((i) => ({ ...i, answer: 'sim' }));
    await abrirAConclusao();

    expect(screen.queryByRole('button', { name: 'Concluir assim mesmo' })).toBeNull();
    const confirmar = screen.getByRole('button', { name: 'Confirmar conclusão' });
    expect((confirmar as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(confirmar);

    await waitFor(() => expect(pedidos.some((p) => p.url.includes('/complete'))).toBe(true));
    const concluiu = pedidos.find((p) => p.url.includes('/complete'))!;
    // Forçar é exceção registrada: mandar `true` sempre esvaziaria o sentido do
    // registro, e o relatório de quem forçou não distinguiria mais nada.
    expect(concluiu.corpo.forcarChecklist).toBe(false);
  });
});

/**
 * A FOTO SAI REDUZIDA DAQUI.
 *
 * A câmera do celular entrega 4 MB; o corpo desta rota aceita 8 MB de JSON e
 * cada arquivo vale no máximo 3 MB depois do base64 — que INCHA o tamanho em um
 * terço. Sem a redução no navegador, a foto tirada no balcão levaria 413 e a
 * prova do estado de entrada do aparelho simplesmente não existiria.
 */
/**
 * A OS EM PAPEL — o botão que não existia (rodada 54).
 *
 * O documento estava pronto no servidor desde a fila de impressão, com tipo
 * declarado no catálogo e teste de fumaça — e NENHUMA tela o chamava. Quem
 * precisava entregar um papel ao cliente não tinha por onde: o defeito era
 * inteiro de frontend, e um teste de servidor nunca o alcançaria.
 */
describe('a OS em papel', () => {
  it('o botão pede o documento ao servidor e abre a janela de impressão', async () => {
    const janela = { document: { write: vi.fn(), close: vi.fn() } };
    vi.stubGlobal('open', vi.fn(() => janela));
    montar();
    await abrirATela();

    fireEvent.click(screen.getByRole('button', { name: 'Imprimir OS' }));

    await waitFor(() => expect(pedidos.some((p) => p.url.includes('/impressao'))).toBe(true));
    // A tela NÃO desenha documento: ela abre o que o servidor mandou pronto.
    await waitFor(() => expect(janela.document.write).toHaveBeenCalled());
    expect(String(janela.document.write.mock.calls[0]![0])).toContain('Ordem de serviço');
  });

  it('pop-up bloqueado baixa o arquivo, e o aviso diz onde ele foi parar', async () => {
    vi.stubGlobal('open', vi.fn(() => null));
    // O jsdom não tem `createObjectURL`: sem o dublê, o download falharia de
    // verdade e mediríamos o outro caminho, não este.
    const criar = vi.fn(() => 'blob:os');
    const soltar = vi.fn();
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: criar, revokeObjectURL: soltar }));
    montar();
    await abrirATela();

    fireEvent.click(screen.getByRole('button', { name: 'Imprimir OS' }));

    const aviso = await screen.findByRole('alert');
    expect(aviso.textContent).toContain('bloqueou a janela');
    expect(aviso.textContent).toContain('Salvar como PDF');
    expect(criar).toHaveBeenCalled();
    // E a OS continua de pé: a recusa não é o canal fatal.
    expect(screen.queryByText('Ordem de serviço não encontrada')).toBeNull();
  });

  /**
   * SEM JANELA E SEM ARQUIVO, A TELA NÃO PODE DIZER QUE BAIXOU.
   *
   * A primeira versão afirmava "a OS foi baixada como arquivo" mesmo quando o
   * download tinha falhado — mandando a pessoa procurar, na pasta de
   * downloads, um arquivo que nunca existiu.
   */
  it('se o download também falhar, o aviso manda liberar o pop-up', async () => {
    vi.stubGlobal('open', vi.fn(() => null));
    vi.stubGlobal(
      'URL',
      Object.assign(URL, {
        createObjectURL: vi.fn(() => {
          throw new Error('sem createObjectURL');
        }),
      }),
    );
    montar();
    await abrirATela();

    fireEvent.click(screen.getByRole('button', { name: 'Imprimir OS' }));

    const aviso = await screen.findByRole('alert');
    expect(aviso.textContent).toContain('E o download');
    expect(aviso.textContent).toContain('Libere pop-ups');
    expect(aviso.textContent).not.toContain('foi baixada');
  });

  it('a recusa do servidor chega com as palavras dele', async () => {
    recusaDoServidor = {
      status: 404,
      code: 'CORE_ORDER_NOT_FOUND',
      message: 'Ordem de serviço não encontrada.',
    };
    montar();
    await abrirATela();

    fireEvent.click(screen.getByRole('button', { name: 'Imprimir OS' }));

    const aviso = await screen.findByRole('alert');
    expect(aviso.textContent).toContain('Ordem de serviço não encontrada');
  });
});

describe('as fotos da OS', () => {
  /**
   * O `canvas` do jsdom não desenha, e `createImageBitmap` não existe: os dois
   * são dublados para que o teste meça o CAMINHO (escolheu arquivo → reduziu →
   * mandou → releu), que é o que a tela decide. O desenho em si é do navegador.
   */
  function dublarOCanvas() {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({
      width: 4000,
      height: 3000,
      close: () => {},
    })));
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(
      'data:image/jpeg;base64,Lw==',
    );
  }

  function escolherArquivo() {
    const entrada = document.querySelector('input[type="file"]') as HTMLInputElement;
    const arquivo = new File(['x'.repeat(64)], 'bancada.jpg', { type: 'image/jpeg' });
    Object.defineProperty(entrada, 'files', { value: [arquivo], configurable: true });
    fireEvent.change(entrada);
  }

  it('reduz antes de mandar, com o tipo escolhido, e a lista relê', async () => {
    dublarOCanvas();
    montar();
    await abrirATela();
    expect(screen.getByText('Nenhuma foto')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Tipo da foto'), { target: { value: 'entrada' } });
    escolherArquivo();

    await waitFor(() => expect(screen.getByText('Fotos (1)')).toBeTruthy());
    const enviou = pedidos.find((p) => p.metodo === 'POST' && p.url.endsWith('/photos'))!;
    // O que subiu é o resultado do canvas — não o arquivo original.
    expect(String(enviou.corpo.dataUrl)).toBe('data:image/jpeg;base64,Lw==');
    expect(enviou.corpo.kind).toBe('entrada');
    expect(enviou.corpo.fileName).toBe('bancada.jpg');
    // O estado vazio some porque a lista foi RELIDA do servidor.
    expect(screen.queryByText('Nenhuma foto')).toBeNull();
  });

  /**
   * O ENDEREÇO DA FOTO É O DA API, não o da tela.
   *
   * O banco guarda `/uploads/os/<uuid>.jpg` — caminho relativo à API, que é
   * quem serve `/uploads/**`. Escrito cru no `src`, o navegador o resolve
   * contra a origem da SPA (porta do Vite), que não serve aquilo: TODAS as
   * fotos da OS quebram, e o recurso inteiro — "a prova do que chegou" — fica
   * invisível. A galeria de produto já sabia disso e usa `coreApi.imageUrl`;
   * a rodada 52 esqueceu, e a suíte não viu porque nenhum teste lia o `src`.
   */
  it('a miniatura e a foto ampliada apontam para a origem da API', async () => {
    fotos = [
      {
        id: 'foto-1',
        url: '/uploads/os/abc.jpg',
        kind: 'entrada',
        caption: null,
        file_name: 'abc.jpg',
        created_at: '2026-08-21T12:00:00.000Z',
      },
    ];
    montar();
    await abrirATela();

    const miniatura = screen.getByRole('img', { name: /Entrada da OS 52/ }) as HTMLImageElement;
    // O caminho relativo sozinho não serve: tem de vir com a origem da API.
    expect(miniatura.getAttribute('src')).toContain('/uploads/os/abc.jpg');
    expect(miniatura.getAttribute('src')).toMatch(/^https?:\/\//);
    expect(miniatura.getAttribute('src')).not.toBe('/uploads/os/abc.jpg');

    fireEvent.click(miniatura);
    const ampliada = (await screen.findByRole('dialog')).querySelector('img')!;
    expect(ampliada.getAttribute('src')).toBe(miniatura.getAttribute('src'));
    // E a ampliada diz O QUE é, como a miniatura: "Foto ampliada" não informa
    // nada a quem usa leitor de tela.
    expect(ampliada.getAttribute('alt')).toMatch(/Entrada da OS 52/);
  });

  it('a foto ampliada fecha pelo teclado e tem botão de fechar', async () => {
    fotos = [
      {
        id: 'foto-1',
        url: '/uploads/os/abc.jpg',
        kind: 'saida',
        caption: null,
        file_name: 'abc.jpg',
        created_at: '2026-08-21T12:00:00.000Z',
      },
    ];
    montar();
    await abrirATela();
    fireEvent.click(screen.getByRole('img', { name: /Saída da OS 52/ }));

    const dialogo = await screen.findByRole('dialog');
    expect(within(dialogo).getByRole('button', { name: 'Fechar' })).toBeTruthy();
    // Quem abre a foto por teclado precisa sair por teclado: com
    // `aria-modal`, o resto da página acabou de ser declarado inexistente.
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  /**
   * A RECUSA DA FOTO NÃO APAGA A OS DA TELA.
   *
   * `erro` é o canal FATAL desta tela: com ele preenchido, a página inteira
   * vira o vazio "Ordem de serviço não encontrada" — com a mensagem da recusa
   * como descrição. Quem subisse a 21ª foto lia "Ordem de serviço não
   * encontrada / Esta OS já tem 20 fotos", e sumiam peças, mão de obra,
   * conferência e histórico. A recusa mora ao lado do que foi clicado, como já
   * acontece em peças e na conclusão.
   */
  it('foto recusada mostra o motivo no card, com a OS inteira de pé', async () => {
    dublarOCanvas();
    recusaDoServidor = {
      status: 409,
      code: 'CORE_PHOTOS_LIMIT',
      message: 'Esta OS já tem 20 fotos — apague alguma antes de subir outra.',
    };
    montar();
    await abrirATela();

    escolherArquivo();

    const aviso = await screen.findByRole('alert');
    expect(aviso.textContent).toContain('já tem 20 fotos');
    // A OS continua na tela: o vazio fatal NÃO tomou o lugar dela.
    expect(screen.queryByText('Ordem de serviço não encontrada')).toBeNull();
    expect(screen.getByText('Peças aplicadas')).toBeTruthy();
    expect(screen.getByText('Chave / controle remoto')).toBeTruthy();
    // E a recusa fica DENTRO do card das fotos, onde o clique aconteceu.
    const cardDeFotos = screen.getByText(/^Fotos \(/).closest('section') as HTMLElement;
    expect(within(cardDeFotos).getByRole('alert')).toBeTruthy();
  });

  it('apagar tira a foto da OS pelo servidor, e não só da tela', async () => {
    fotos = [
      {
        id: 'foto-antiga',
        url: '/uploads/os/foto-antiga.jpg',
        kind: 'defeito',
        caption: null,
        file_name: 'antiga.jpg',
        created_at: '2026-08-21T12:00:00.000Z',
      },
    ];
    montar();
    await abrirATela();
    expect(screen.getByText('Fotos (1)')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Apagar' }));

    await waitFor(() => expect(screen.getByText('Fotos (0)')).toBeTruthy());
    expect(
      pedidos.some((p) => p.metodo === 'DELETE' && p.url.includes('/photos/foto-antiga')),
    ).toBe(true);
  });

  it('OS finalizada não recebe nem apaga foto — a conta já fechou', async () => {
    os.status = 'finalizada';
    fotos = [
      {
        id: 'foto-antiga',
        url: '/uploads/os/foto-antiga.jpg',
        kind: 'saida',
        caption: null,
        file_name: 'antiga.jpg',
        created_at: '2026-08-21T12:00:00.000Z',
      },
    ];
    montar();
    await screen.findByText('Fotos (1)');

    expect(screen.queryByLabelText('Tipo da foto')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Apagar' })).toBeNull();
  });
});
