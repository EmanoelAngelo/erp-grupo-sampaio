/**
 * NUMERAÇÃO E CSC NA TELA FISCAL.
 *
 * Até a rodada 33 estes dois itens do checklist só existiam por rota: o
 * `readiness` cobrava `serie:FAIL` e `csc:FAIL`, e não havia nenhum lugar no
 * sistema onde alguém pudesse resolvê-los. O dono via a pendência e não tinha
 * botão. Estes casos existem para que a tela não desapareça de novo.
 *
 * O que cada caso quebra sem o conserto:
 *
 *   - sem o cartão de numeração, quem lê "Nenhuma série configurada" não tem
 *     onde configurar — o primeiro caso falha na ausência do campo;
 *   - se a série viajar como TEXTO, o servidor recebe "1" onde espera 1, e a
 *     validação de faixa passa a comparar string com número — o caso do corpo
 *     da requisição falha;
 *   - se o token do CSC voltar para a tela (ou ficar no campo depois de
 *     gravado), o segredo passa a morar no navegador — o caso do token falha;
 *   - o ambiente do CSC COMEÇA no da operação: o caminho normal não pede
 *     escolha, e é assim que o de teste não vira "de produção" por descuido;
 *     o caso do ambiente falha se o padrão não acompanhar a operação. Gravar o
 *     de produção ANTES da virada é escolha explícita e tem o seu próprio
 *     arquivo (fiscalCscPorAmbiente.test.tsx, GAP-PRD-022);
 *   - o selo do CSC só afirma o que LEU: se voltar a dizer NÃO CONFIGURADO
 *     antes de a lista do cofre chegar — ou depois de a leitura ser recusada —,
 *     os dois casos de "o selo só afirma o que leu" ficam vermelhos.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import FiscalPage from '../FiscalPage';

const CONFIG = {
  companyId: 'loja',
  legalName: 'Preço Justo Ltda',
  tradeName: 'Preço Justo',
  cnpj: '11222333000181',
  ie: '123456789',
  im: null,
  crt: '1',
  zip: '68900000',
  street: 'Av. Central',
  number: '100',
  complement: null,
  district: 'Centro',
  cityName: 'Macapá',
  cityIbge: '1600303',
  uf: 'AP',
  phone: null,
  environment: 'homologation',
  productionUnlocked: false,
  updatedAt: '2026-08-23T12:00:00.000Z',
};

const SERIES = [
  { model: '65', series: [{ serie: 1, nextNumber: 41 }] },
  { model: '55', series: [] },
];

const CSC_DE_HOMOLOGACAO = {
  operationalUnitId: 'unit-default',
  cscId: '000001',
  configured: true,
  environment: 'homologation',
};

/** Tudo o que a tela mandou para o servidor, na ordem. */
let enviados: { url: string; method: string; body: unknown; headers: Record<string, string> }[] = [];
let cscAtual: unknown[];
/** Quando não-nula, a leitura da lista do CSC só responde depois dela. */
let seguraOCsc: Promise<void> | null = null;
/** Quando não-nula, a leitura da lista do CSC responde com esta recusa. */
let recusaDoCsc: { status: number; code: string; message: string } | null = null;
/** As esperas do atraso ainda no relógio — nenhuma pode sobreviver ao caso. */
const esperasEmCurso = new Set<Promise<void>>();

/*
  A CONFIGURAÇÃO E O CSC CHEGAM DEPOIS DA NUMERAÇÃO — de propósito, e para
  sempre.

  O caso do CSC falhou uma vez na validação final, com a máquina carregada:
  "Unable to find a label with the text of: CSC ID". A corrida era do TESTE, e
  não da tela: `abrir()` esperava "Numeração das notas", título que o
  `NumeracaoCard` desenha no PRIMEIRO render, sem depender de resposta
  nenhuma; o cartão do CSC só nasce depois que `getFiscalConfig()` responde
  (`{config && <CscCard …/>}`), e a lista dele é uma segunda ida ao servidor.
  Entre o `findByText` e o `getByLabelText` síncrono sobrava UMA volta de
  `setTimeout(0)` (a drenagem do `asyncWrapper` da Testing Library), e o
  re-render com a configuração sai por `setImmediate` (o Scheduler do React,
  fora do `act`). Com folga na máquina o re-render cabia nessa volta; com a
  CPU disputada, o relógio vencia e o cartão ainda não existia.

  Este atraso reproduz, em qualquer máquina, a ordem que só a carga produzia:
  a numeração responde na hora, e a configuração e o CSC só depois dela e de
  um intervalo que nenhuma drenagem de microtarefa cobre. Com ele, esperar o
  elemento errado falha SEMPRE — e é por isso que ele fica.
*/
const ATRASO_DAS_LEITURAS_LENTAS_MS = 100;

function servidor() {
  let numeracaoServida: () => void = () => undefined;
  const numeracao = new Promise<void>((resolve) => {
    numeracaoServida = resolve;
  });
  const depoisDaNumeracao = async () => {
    await numeracao;
    const espera = new Promise<void>((resolve) => {
      setTimeout(resolve, ATRASO_DAS_LEITURAS_LENTAS_MS);
    });
    esperasEmCurso.add(espera);
    try {
      await espera;
    } finally {
      esperasEmCurso.delete(espera);
    }
  };

  return vi.fn(async (
    url: string,
    init?: { method?: string; body?: string; headers?: Record<string, string> },
  ) => {
    const alvo = String(url);
    const method = init?.method ?? 'GET';
    const headers = init?.headers ?? {};
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (method !== 'GET') enviados.push({ url: alvo, method, body, headers });

    const json = (payload: unknown, status = 200) =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });

    if (alvo.includes('/core/fiscal/config')) {
      await depoisDaNumeracao();
      return json(CONFIG);
    }
    if (alvo.includes('/core/fiscal/readiness')) return json({ items: [] });
    if (alvo.includes('/core/fiscal/product-pendencies')) return json({ items: [] });
    if (alvo.includes('/core/fiscal/series')) {
      numeracaoServida();
      return json({ items: SERIES });
    }
    if (alvo.includes('/core/fiscal/nfce/csc')) {
      if (method === 'POST') {
        cscAtual = [
          {
            operationalUnitId: 'unit-default',
            cscId: String(body?.cscId ?? ''),
            configured: true,
            environment: body?.environment,
          },
        ];
        return json(cscAtual[0], 201);
      }
      // A foto do cofre é a da hora do pedido; a resposta é que demora.
      const itens = [...cscAtual];
      await depoisDaNumeracao();
      if (seguraOCsc) await seguraOCsc;
      if (recusaDoCsc) {
        return json(
          { error: { code: recusaDoCsc.code, message: recusaDoCsc.message } },
          recusaDoCsc.status,
        );
      }
      return json({ items: itens });
    }
    return json({ items: [] });
  });
}

function entrarComoGestor() {
  setSession(
    {
      accessToken: 'sem-escopo',
      refreshToken: 'r-1',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'u-dono', login: 'dono', displayName: 'Dono', profileCode: 'gestor' },
      company: { id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail' },
      companies: [
        { id: 'loja', slug: 'loja', tradeName: 'Loja', kind: 'retail', profileCode: 'gestor' },
      ],
    } as never,
    'LOGIN',
    'teste da numeração e do CSC',
  );
}

/**
 * Nenhuma resposta atrasada sobrevive ao caso.
 *
 * O atraso deixa leituras no relógio depois do último `expect` — a releitura
 * que a tela faz depois de gravar, por exemplo. Vencida depois do fim do
 * arquivo, ela roda o cliente HTTP sem o jsdom, e o Vitest acusa "window is
 * not defined" (visto na reprodução). A volta de `setTimeout(0)` deixa entrar
 * no relógio a leitura que ainda esperava a porta da numeração.
 */
async function esvaziarAsEsperas() {
  do {
    await Promise.all([...esperasEmCurso]);
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  } while (esperasEmCurso.size > 0);
}

beforeEach(() => {
  enviados = [];
  cscAtual = [];
  seguraOCsc = null;
  recusaDoCsc = null;
  localStorage.clear();
  vi.stubGlobal('fetch', servidor());
  entrarComoGestor();
});

afterEach(async () => {
  cleanup();
  await esvaziarAsEsperas();
  setSession(null, 'LOGOUT', 'fim do teste');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

function montar() {
  render(
    <MemoryRouter>
      <FiscalPage />
    </MemoryRouter>,
  );
}

/**
 * Abre a tela e espera o cartão do CSC LIDO — e não um vizinho dele.
 *
 * Esperava "Numeração das notas", que existe desde o primeiro render e não diz
 * nada sobre o CSC (ver o atraso acima). O que os casos consultam logo depois
 * é o campo "CSC ID", que só nasce com a configuração, e os dois selos, que só
 * afirmam depois que a lista do cofre chega. É exatamente isso que se espera:
 * o cofre destes casos começa vazio, então lido quer dizer dois NÃO
 * CONFIGURADO — enquanto a lista não chega, o selo diz CONSULTANDO….
 */
async function abrir() {
  montar();
  await screen.findByLabelText('CSC ID');
  const lista = screen.getByLabelText('CSC por ambiente');
  await waitFor(() => {
    expect(within(lista).getAllByText('NÃO CONFIGURADO')).toHaveLength(2);
  });
}

describe('numeração das séries', () => {
  it('mostra a série existente e diz quando não há nenhuma', async () => {
    await abrir();

    // O modelo 65 tem série 1 na próxima nota 41.
    expect(await screen.findByText(/Série 1 — próxima nota número 41/)).toBeTruthy();
    // O modelo 55 não tem — e a tela diz o efeito, não só "vazio".
    expect(
      screen.getByText(/Nenhuma série configurada — a emissão deste modelo fica bloqueada/),
    ).toBeTruthy();
  });

  it('envia série e número como NÚMERO, não como texto', async () => {
    await abrir();

    fireEvent.change(screen.getByLabelText('Série'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('Próximo número'), { target: { value: '100' } });
    fireEvent.click(screen.getByText('Salvar numeração'));

    await waitFor(() => {
      expect(enviados.some((e) => e.url.includes('/core/fiscal/series'))).toBe(true);
    });
    const envio = enviados.find((e) => e.url.includes('/core/fiscal/series'))!;
    // Tipo, e não só valor: "2" e 2 são coisas diferentes para a validação de
    // faixa do servidor, que usa Number.isInteger.
    expect(envio.body).toEqual({ model: '65', serie: 2, nextNumber: 100 });
    expect(typeof (envio.body as { serie: unknown }).serie).toBe('number');
  });
});

describe('CSC', () => {
  it('começa como NÃO CONFIGURADO e só libera o botão com os dois campos', async () => {
    await abrir();

    // Um lugar para cada ambiente (GAP-PRD-022): os dois começam vazios.
    expect(screen.getAllByText('NÃO CONFIGURADO')).toHaveLength(2);

    const botao = screen.getByText('Gravar CSC').closest('button')!;
    expect(botao.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('CSC ID'), { target: { value: '000001' } });
    expect(botao.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('Token do CSC'), { target: { value: 'SEGREDO-XYZ' } });
    expect(botao.disabled).toBe(false);
  });

  it('grava com chave de idempotência, no ambiente da operação, e some com o token', async () => {
    await abrir();

    fireEvent.change(screen.getByLabelText('CSC ID'), { target: { value: '000001' } });
    fireEvent.change(screen.getByLabelText('Token do CSC'), { target: { value: 'SEGREDO-XYZ' } });
    fireEvent.click(screen.getByText('Gravar CSC'));

    await waitFor(() => {
      expect(enviados.some((e) => e.url.includes('/core/fiscal/nfce/csc'))).toBe(true);
    });
    const envio = enviados.find((e) => e.url.includes('/core/fiscal/nfce/csc'))!;

    // A rota EXIGE a chave: sem ela o servidor responde 400 e o botão parece
    // quebrado. Dois cliques com a mesma chave devolvem a mesma gravação.
    expect(envio.headers['Idempotency-Key']).toBeTruthy();
    // O ambiente acompanha a operação — não é escolha de quem digita.
    expect((envio.body as { environment: string }).environment).toBe('homologation');

    // Gravado: o selo muda e o campo do token fica vazio. O segredo não
    // continua pendurado na tela depois de subir.
    await screen.findByText('CONFIGURADO');
    const campoToken = screen.getByLabelText('Token do CSC') as HTMLInputElement;
    expect(campoToken.value).toBe('');
    expect(campoToken.type).toBe('password');

    // E o token não aparece em lugar nenhum da tela.
    expect(document.body.textContent).not.toContain('SEGREDO-XYZ');
  });
});

/*
  O SELO SÓ AFIRMA O QUE LEU.

  Sem a lista do cofre, `atual` ficava `null` e os dois selos diziam NÃO
  CONFIGURADO — enquanto a leitura não chegava e, se ela fosse recusada, para
  sempre. É o que via o `gerente_oficina`: a configuração fiscal o admite, o
  GET do CSC não, e a tela afirmava "não configurado" com o código gravado no
  cofre. Os dois casos abaixo têm o CSC de homologação GRAVADO de propósito.
*/
describe('o selo do CSC só afirma o que leu', () => {
  it('enquanto a lista do cofre não chega, o selo diz que está consultando — não NÃO CONFIGURADO', async () => {
    cscAtual = [CSC_DE_HOMOLOGACAO];
    let soltar: () => void = () => undefined;
    seguraOCsc = new Promise<void>((resolve) => {
      soltar = resolve;
    });
    montar();

    // O cartão nasceu (a configuração chegou), e a lista está presa.
    await screen.findByLabelText('CSC ID');
    const lista = screen.getByLabelText('CSC por ambiente');
    expect(within(lista).getAllByText('CONSULTANDO…')).toHaveLength(2);
    expect(within(lista).queryByText('NÃO CONFIGURADO')).toBeNull();

    soltar();

    // Lida: o de homologação aparece gravado, e só o de produção — lido e
    // vazio — passa a ser NÃO CONFIGURADO.
    expect(await within(lista).findByText('CONFIGURADO')).toBeTruthy();
    expect(within(lista).getByText('CSC ID 000001')).toBeTruthy();
    expect(within(lista).getAllByText('NÃO CONFIGURADO')).toHaveLength(1);
    expect(within(lista).queryByText('CONSULTANDO…')).toBeNull();
  });

  it('leitura recusada: o selo diz que não sabe, e a recusa aparece na tela', async () => {
    cscAtual = [CSC_DE_HOMOLOGACAO];
    recusaDoCsc = {
      status: 403,
      code: 'API_PERMISSION_DENIED',
      message: 'Ler o CSC é gesto da gerência da loja.',
    };
    montar();

    /*
      Em DOIS tempos, cada um com o seu estado real: o cartão nasce com a
      configuração, e só depois a leitura do cofre volta recusada. Um `findBy`
      só para a cadeia inteira (dois atrasos e três renders) estourou o prazo
      de 1 s da Testing Library uma vez com a CPU saturada.
    */
    await screen.findByLabelText('CSC ID');
    expect(await screen.findByText('Ler o CSC é gesto da gerência da loja.')).toBeTruthy();
    const lista = screen.getByLabelText('CSC por ambiente');
    expect(within(lista).getAllByText('SITUAÇÃO DESCONHECIDA')).toHaveLength(2);
    expect(within(lista).queryByText('NÃO CONFIGURADO')).toBeNull();
    expect(within(lista).queryByText('CONSULTANDO…')).toBeNull();
  });
});
