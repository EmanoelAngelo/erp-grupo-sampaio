/**
 * A GAVETA DA BANCADA, PELA TELA — rodada 55.
 *
 * ## O buraco que este arquivo fecha
 *
 * A tela de peças tinha 193 linhas e nenhum POST: listava e procurava, e era
 * só. Um teste de servidor não alcança esse tipo de defeito — o servidor
 * passou a ter as rotas e ficaria verde com a tela nunca as chamando, que é
 * exatamente a forma do defeito original.
 *
 * Aqui a rede é dublada e a tela é real. Cada caso falha quando o caminho sai
 * do componente:
 *
 *   - tire a chamada de `scanPeca` e o bipe não resolve nada;
 *   - troque a mensagem do servidor por um texto genérico no `catch` e a recusa
 *     de código repetido vira "algo deu errado";
 *   - deixe a tela imprimir `cost_cents` e o mecânico passa a ver o custo;
 *   - use `Number(x.replace(',', '.'))` no custo e R$ 1.500,00 vira zero.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import PecasPage from '../PecasPage';

const BANCADA = 'wk-mob';

interface PecaNaGaveta {
  id: string;
  internal_code: string;
  barcode: string | null;
  name: string;
  unit: string;
  price_cents: number;
  cost_cents?: number;
  min_stock: number;
  workshop_id: string;
  workshop_name: string;
  stock_quantity: number;
  reserved: number;
  available: number;
  below_minimum: boolean;
  storage_location: string | null;
}

let gaveta: PecaNaGaveta[];
let pedidos: string[];
/** O corpo do último POST — é por ele que se prova o que a tela mandou. */
let ultimoCorpo: Record<string, unknown> | null;
/** As chaves de idempotência que saíram em cada escrita, na ordem. */
let chaves: (string | null)[] = [];
let recusa: { status: number; code: string; message: string } | null;

function controlador(over: Partial<PecaNaGaveta> = {}): PecaNaGaveta {
  return {
    id: 'p-1',
    internal_code: 'CTRL-48V1K',
    barcode: '7891234567890',
    name: 'Controlador 48V 1000W',
    unit: 'UN',
    price_cents: 44800,
    cost_cents: 32000,
    min_stock: 2,
    workshop_id: BANCADA,
    workshop_name: 'Bancada de Mobilidade',
    stock_quantity: 8,
    reserved: 0,
    available: 8,
    below_minimum: false,
    storage_location: 'Prateleira A3 - Caixa 2',
    ...over,
  };
}

/**
 * O servidor dublado — e ele MEXE no estado, não só responde.
 *
 * Um dublê que respondesse 201 sem mexer em nada deixaria passar uma tela que
 * cadastra a peça e não relê a gaveta.
 */
function servidor() {
  return vi.fn(
    async (
      url: string | URL | Request,
      init?: { method?: string; body?: string; headers?: Record<string, string> },
    ) => {
    const alvo = String(url);
    const metodo = (init?.method ?? 'GET').toUpperCase();
    const corpo = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    pedidos.push(`${metodo} ${alvo}`);
    if (metodo !== 'GET') chaves.push(init?.headers?.['Idempotency-Key'] ?? null);

    const responder = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });

    if (recusa && metodo !== 'GET') {
      return responder({ error: { code: recusa.code, message: recusa.message } }, recusa.status);
    }

    if (alvo.includes('/core/workshop/parts/scan')) {
      const codigo = new URLSearchParams(alvo.split('?')[1] ?? '').get('codigo') ?? '';
      const achada = gaveta.find((p) => p.barcode === codigo || p.internal_code === codigo);
      return responder({ encontrada: achada ?? null, codigo, foraDoAlcance: false });
    }

    if (metodo === 'POST' && /\/core\/workshop\/parts$/.test(alvo)) {
      ultimoCorpo = corpo;
      const preco = Math.round(
        Number(corpo.costCents) * (1 + Number(corpo.markupPercent ?? 0) / 100),
      );
      gaveta.push(
        controlador({
          id: `p-${gaveta.length + 1}`,
          name: String(corpo.name),
          barcode: (corpo.barcode as string) ?? null,
          price_cents: preco,
          cost_cents: Number(corpo.costCents),
          stock_quantity: Number(corpo.quantity),
          available: Number(corpo.quantity),
          min_stock: Number(corpo.minStock ?? 0),
          storage_location: (corpo.storageLocation as string) ?? null,
        }),
      );
      return responder({ productId: 'p-novo', priceCents: preco, quantity: corpo.quantity }, 201);
    }

    if (metodo === 'PATCH' && /\/core\/workshop\/parts\/[^/]+$/.test(alvo)) {
      ultimoCorpo = corpo;
      const id = alvo.split('/').pop()!;
      const peca = gaveta.find((p) => p.id === id)!;
      if (corpo.minStock != null) peca.min_stock = Number(corpo.minStock);
      if (corpo.storageLocation !== undefined) {
        peca.storage_location = (corpo.storageLocation as string) || null;
      }
      return responder(peca);
    }

    const reposicao = alvo.match(/\/core\/workshop\/parts\/([^/]+)\/reposicao$/);
    if (metodo === 'POST' && reposicao) {
      ultimoCorpo = corpo;
      const peca = gaveta.find((p) => p.id === reposicao[1])!;
      peca.stock_quantity += Number(corpo.quantity);
      peca.available += Number(corpo.quantity);
      return responder({
        quantity: corpo.quantity,
        costCents: corpo.costCents ?? peca.cost_cents,
        priceCents: peca.price_cents,
        reprecificada: false,
      });
    }

    if (alvo.includes('/core/workshops')) {
      return responder({
        items: [
          {
            id: BANCADA,
            name: 'Bancada de Mobilidade',
            slug: 'mob',
            kind: 'mobility',
            active: true,
            capabilities: { kanban: true, parts: true, equipmentTags: true },
          },
        ],
      });
    }

    if (alvo.includes('/core/workshop/parts')) {
      const busca = (new URLSearchParams(alvo.split('?')[1] ?? '').get('search') ?? '').toLowerCase();
      const itens = gaveta.filter(
        (p) =>
          !busca
          || p.name.toLowerCase().includes(busca)
          || (p.storage_location ?? '').toLowerCase().includes(busca),
      );
      return responder({ items: itens });
    }

    return responder({});
    },
  );
}

/**
 * A sessão de quem está olhando.
 *
 * É a persona da tela: `useHasProfile('gerente_loja','gerente_oficina','estoquista')`
 * é o que decide se o cartão de bipar existe. Sem sessão de verdade, o teste
 * mediria uma tela que ninguém vê.
 */
function entrar(profileCode: string) {
  setSession(
    {
      accessToken: 'token-de-teste',
      refreshToken: 'r',
      expiresAt: Date.now() + 3_600_000,
      user: { id: 'u-1', login: 'quem', displayName: 'Quem', profileCode },
      company: { id: 'oficina', slug: 'oficina', tradeName: 'Oficina', kind: 'workshop' },
      companies: [
        { id: 'oficina', slug: 'oficina', tradeName: 'Oficina', kind: 'workshop', profileCode },
      ],
    },
    'LOGIN',
    'client.login',
  );
}

function montar() {
  return render(
    <MemoryRouter>
      <PecasPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  gaveta = [controlador()];
  pedidos = [];
  ultimoCorpo = null;
  chaves = [];
  recusa = null;
  vi.stubGlobal('fetch', servidor());
});

afterEach(() => {
  cleanup();
  setSession(null, 'LOGOUT', 'client.logout');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

// ============================================================================

describe('a gaveta na tela', () => {
  it('mostra onde a peça fica, e o mínimo', async () => {
    entrar('gerente_oficina');
    montar();

    expect(await screen.findByText('Controlador 48V 1000W')).toBeTruthy();
    // "Onde eu pego" é a pergunta de quem está com a moto aberta, e a tela não
    // tinha onde responder.
    expect(screen.getByText('Prateleira A3 - Caixa 2')).toBeTruthy();
  });

  it('a peça prometida a uma OS aparece como prometida, não como sumida', async () => {
    gaveta = [controlador({ reserved: 2, available: 6 })];
    entrar('gerente_oficina');
    montar();

    await screen.findByText('Controlador 48V 1000W');
    // O saldo físico continua 8: a peça está na prateleira, com dono. Dizer
    // que sobraram 6 na gaveta faria a contagem de inventário parecer errada.
    expect(screen.getByText('8')).toBeTruthy();
    expect(screen.getByText(/2 prometidas/)).toBeTruthy();
  });

  it('o mecânico não vê custo, e nem o cartão de bipar', async () => {
    gaveta = [controlador({ cost_cents: undefined })];
    entrar('mecanico');
    montar();

    await screen.findByText('Controlador 48V 1000W');
    expect(screen.queryByText('R$ 320,00')).toBeNull();
    expect(screen.getByText(/custo da peça não aparece neste perfil/i)).toBeTruthy();
    // Cadastrar e repor são de quem cuida do estoque: oferecer o gesto a quem
    // levaria 403 é pior que não oferecer.
    expect(screen.queryByText('Bipar peça')).toBeNull();
  });

  it('o aviso de "está acabando" não some quando se procura outra coisa', async () => {
    gaveta = [
      controlador({ id: 'p-1', name: 'Parafuso M6', barcode: '111', min_stock: 5, stock_quantity: 1, available: 1, below_minimum: true, storage_location: null }),
      controlador({ id: 'p-2', name: 'Bateria 72V', barcode: '222' }),
    ];
    entrar('gerente_oficina');
    montar();
    // O nome aparece duas vezes: no aviso e na tabela. É o aviso que interessa.
    expect(await screen.findByText(/1 peça\(s\) abaixo do mínimo/)).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText(/prateleira/i), {
      target: { value: 'Bateria' },
    });

    await waitFor(() => {
      expect(pedidos.some((p) => p.includes('search=Bateria'))).toBe(true);
    });
    // O alerta responde "o que está acabando NA GAVETA", e essa resposta não
    // pode depender do que a pessoa digitou na busca: derivá-lo da lista
    // filtrada fazia procurar "bateria" esconder que o parafuso acabou.
    await waitFor(() => {
      expect(screen.getByText(/1 peça\(s\) abaixo do mínimo/)).toBeTruthy();
    });
  });

  it('falha ao carregar não deixa a tela girando para sempre', async () => {
    entrar('gerente_oficina');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 500 })),
    );
    montar();

    // O erro no topo E a tabela fora do ar. Antes o card ficava em
    // "Carregando…" ao lado da mensagem de erro, para sempre.
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText('Carregando…')).toBeNull();
    expect(screen.getByText('Não deu para ler a gaveta')).toBeTruthy();
  });

  it('procura pela prateleira — "o que tem na F1?"', async () => {
    entrar('gerente_oficina');
    montar();
    await screen.findByText('Controlador 48V 1000W');

    fireEvent.change(screen.getByPlaceholderText(/prateleira/i), { target: { value: 'A3' } });
    await waitFor(() => {
      expect(pedidos.some((p) => p.includes('search=A3'))).toBe(true);
    });
  });
});

describe('bipar resolve', () => {
  it('código que existe abre a REPOSIÇÃO, com o que já tem na gaveta', async () => {
    entrar('gerente_oficina');
    montar();
    await screen.findByText('Controlador 48V 1000W');

    fireEvent.change(screen.getByPlaceholderText('Bipe ou digite'), {
      target: { value: '7891234567890' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Procurar' }));

    expect(await screen.findByRole('button', { name: 'Repor' })).toBeTruthy();
    expect(screen.getByText(/8 disponível\(is\) de 8 na gaveta/)).toBeTruthy();
    // Cadastrar de novo o que já existe racha o saldo entre dois cadastros: a
    // tela não pode nem oferecer.
    expect(screen.queryByRole('button', { name: 'Cadastrar e dar entrada' })).toBeNull();
  });

  it('o leitor USB termina com Enter, e a tela obedece', async () => {
    entrar('gerente_oficina');
    montar();
    await screen.findByText('Controlador 48V 1000W');

    const campo = screen.getByPlaceholderText('Bipe ou digite');
    fireEvent.change(campo, { target: { value: '7891234567890' } });
    fireEvent.keyDown(campo, { key: 'Enter' });

    // Sem isto o leitor preencheria o campo e esperaria um clique que ninguém
    // dá com a peça numa das mãos.
    expect(await screen.findByRole('button', { name: 'Repor' })).toBeTruthy();
  });

  it('código que não existe abre o CADASTRO com o código preenchido', async () => {
    entrar('gerente_oficina');
    montar();
    await screen.findByText('Controlador 48V 1000W');

    fireEvent.change(screen.getByPlaceholderText('Bipe ou digite'), {
      target: { value: '7899999999999' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Procurar' }));

    expect(await screen.findByRole('button', { name: 'Cadastrar e dar entrada' })).toBeTruthy();
    expect(screen.getByText('7899999999999')).toBeTruthy();
  });
});

/**
 * O QUE UM BIPE DEIXA PARA O SEGUINTE.
 *
 * O formulário é UM só para as duas portas, e o que ele carrega de um gesto
 * para o outro é onde mora o defeito silencioso: dinheiro digitado num
 * cadastro abandonado reaparecendo numa reposição de outra peça, e um
 * percentual sugerido virando repreço que ninguém pediu.
 */
describe('o formulário não vaza de um bipe para o outro', () => {
  it('a REPOSIÇÃO nasce sem percentual — repor não é reprecificar', async () => {
    entrar('gerente_oficina');
    montar();
    await screen.findByText('Controlador 48V 1000W');

    fireEvent.change(screen.getByPlaceholderText('Bipe ou digite'), {
      target: { value: '7891234567890' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Procurar' }));
    await screen.findByRole('button', { name: 'Repor' });

    // Um 40 de fábrica aqui faria TODA reposição mexer no preço de venda sem
    // ninguém pedir — e o número apareceria na conta do cliente sem a loja
    // saber que aumentou.
    expect((screen.getByLabelText('% sobre o custo') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('Custo unitário (R$)') as HTMLInputElement).value).toBe('');

    fireEvent.change(screen.getByLabelText('Quantas chegaram'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('Documento (nota, cupom ou recibo)'), {
      target: { value: 'NF 7' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Repor' }));

    await waitFor(() => expect(ultimoCorpo).not.toBeNull());
    expect(ultimoCorpo!.markupPercent).toBeNull();
    expect(ultimoCorpo!.costCents).toBeNull();
  });

  it('o custo de um cadastro abandonado não cai na reposição da outra peça', async () => {
    entrar('gerente_oficina');
    montar();
    await screen.findByText('Controlador 48V 1000W');

    // Começa um cadastro, digita dinheiro, e desiste.
    fireEvent.change(screen.getByPlaceholderText('Bipe ou digite'), {
      target: { value: '7899999999999' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Procurar' }));
    await screen.findByRole('button', { name: 'Cadastrar e dar entrada' });
    fireEvent.change(screen.getByLabelText('Custo unitário (R$)'), { target: { value: '999,00' } });

    // Bipa OUTRA peça, que existe.
    fireEvent.change(screen.getByPlaceholderText('Bipe ou digite'), {
      target: { value: '7891234567890' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Procurar' }));
    await screen.findByRole('button', { name: 'Repor' });

    // R$ 999,00 aqui reescreveria o custo do controlador — e, com percentual
    // junto, o preço de venda dele.
    expect((screen.getByLabelText('Custo unitário (R$)') as HTMLInputElement).value).toBe('');
  });

  it('o campo do leitor esvazia depois de ler — o segundo bipe não concatena', async () => {
    entrar('gerente_oficina');
    montar();
    await screen.findByText('Controlador 48V 1000W');

    const campo = screen.getByPlaceholderText('Bipe ou digite') as HTMLInputElement;
    fireEvent.change(campo, { target: { value: '7891234567890' } });
    fireEvent.keyDown(campo, { key: 'Enter' });
    await screen.findByRole('button', { name: 'Repor' });

    // O leitor USB digita no FIM do que já está no campo: sem isto o segundo
    // bipe procuraria um código de 26 dígitos que não existe em lugar nenhum,
    // e a tela ofereceria cadastrar a peça que acabou de encontrar.
    expect(campo.value).toBe('');
  });
});

describe('o preço sai do custo, e o custo é lido como dinheiro daqui', () => {
  it('mostra o preço que vai valer ANTES de gravar', async () => {
    entrar('gerente_oficina');
    montar();
    await screen.findByText('Controlador 48V 1000W');

    fireEvent.change(screen.getByPlaceholderText('Bipe ou digite'), {
      target: { value: '7899999999999' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Procurar' }));
    await screen.findByRole('button', { name: 'Cadastrar e dar entrada' });

    fireEvent.change(screen.getByLabelText('Custo unitário (R$)'), { target: { value: '320,00' } });

    // 320 x 1,40 — a mesma conta do sistema anterior, mostrada antes de gravar
    // em vez de aplicada em silêncio.
    expect(await screen.findByText('R$ 448,00')).toBeTruthy();
  });

  it('R$ 1.500,00 com separador de milhar NÃO vira zero', async () => {
    entrar('gerente_oficina');
    montar();
    await screen.findByText('Controlador 48V 1000W');

    fireEvent.change(screen.getByPlaceholderText('Bipe ou digite'), {
      target: { value: '7899999999999' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Procurar' }));
    await screen.findByRole('button', { name: 'Cadastrar e dar entrada' });

    fireEvent.change(screen.getByLabelText('Nome da peça'), { target: { value: 'Bateria 72V' } });
    fireEvent.change(screen.getByLabelText('Custo unitário (R$)'), {
      target: { value: '1.500,00' },
    });
    fireEvent.change(screen.getByLabelText('Documento (nota, cupom ou recibo)'), {
      target: { value: 'NF 99' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Cadastrar e dar entrada' }));

    await waitFor(() => expect(ultimoCorpo).not.toBeNull());
    // É a forma que um brasileiro digita. Lida com `replace(',', '.')` ela
    // vira NaN, que vira zero — e custo zero estraga margem, markup e o preço
    // derivado desta rodada.
    expect(ultimoCorpo!.costCents).toBe(150000);
  });
});

/**
 * A ROTA DE AJUSTE PRECISA DE UMA TELA.
 *
 * Servidor com rota que nenhuma tela chama é o defeito que este repositório
 * mais encontra — e a rodada quase o cometeu de novo: `PATCH
 * /workshop/parts/:id` nasceu sem chamador. Sem ele o mínimo continuaria só no
 * cadastro de produto, fechado para quem está na bancada, e o aviso de "está
 * acabando" seguiria mudo para a peça nascida de nota.
 */
describe('mínimo e endereço se ajustam de onde se olha a gaveta', () => {
  it('abre com os valores atuais e manda os dois', async () => {
    entrar('gerente_oficina');
    montar();
    await screen.findByText('Controlador 48V 1000W');

    fireEvent.click(
      screen.getByRole('button', { name: /Ajustar mínimo e endereço de Controlador/ }),
    );

    // Abrir em branco faria "salvar sem mexer" apagar o que já estava lá.
    expect((await screen.findByLabelText('Mínimo (alerta)') as HTMLInputElement).value).toBe('2');
    expect((screen.getByLabelText('Onde fica') as HTMLInputElement).value).toBe(
      'Prateleira A3 - Caixa 2',
    );

    fireEvent.change(screen.getByLabelText('Mínimo (alerta)'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('Onde fica'), { target: { value: 'Prateleira F1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));

    await waitFor(() => expect(ultimoCorpo).not.toBeNull());
    expect(ultimoCorpo!.minStock).toBe(5);
    expect(ultimoCorpo!.storageLocation).toBe('Prateleira F1');
  });

  it('o mecânico não ajusta', async () => {
    gaveta = [controlador({ cost_cents: undefined })];
    entrar('mecanico');
    montar();
    await screen.findByText('Controlador 48V 1000W');
    expect(screen.queryByRole('button', { name: /Ajustar mínimo/ })).toBeNull();
  });
});

describe('as recusas do servidor chegam com a frase do servidor', () => {
  it('código repetido diz QUAL peça é, e o que fazer', async () => {
    entrar('gerente_oficina');
    montar();
    await screen.findByText('Controlador 48V 1000W');

    fireEvent.change(screen.getByPlaceholderText('Bipe ou digite'), {
      target: { value: '7899999999999' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Procurar' }));
    await screen.findByRole('button', { name: 'Cadastrar e dar entrada' });

    recusa = {
      status: 409,
      code: 'CORE_PART_CODE_TAKEN',
      message:
        'O código 7899999999999 já é da peça "Bateria 72V". Use a reposição em vez de '
        + 'cadastrar de novo — dois cadastros do mesmo item rachariam o saldo.',
    };
    fireEvent.change(screen.getByLabelText('Nome da peça'), { target: { value: 'Outra' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cadastrar e dar entrada' }));

    // Um "algo deu errado" genérico faria a pessoa mudar o código e cadastrar
    // assim mesmo — que é o defeito que a recusa existe para impedir.
    const alerta = await screen.findByRole('alert');
    expect(alerta.textContent).toContain('Bateria 72V');
    expect(alerta.textContent).toContain('reposição');
  });

  it('documento faltando é recusa do servidor, e a tela repete a frase', async () => {
    entrar('gerente_oficina');
    montar();
    await screen.findByText('Controlador 48V 1000W');

    fireEvent.change(screen.getByPlaceholderText('Bipe ou digite'), {
      target: { value: '7891234567890' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Procurar' }));
    await screen.findByRole('button', { name: 'Repor' });

    recusa = {
      status: 400,
      code: 'CORE_ENTRY_DOCUMENT_REQUIRED',
      message: 'Informe o documento de entrada (nota, cupom ou recibo).',
    };
    fireEvent.click(screen.getByRole('button', { name: 'Repor' }));

    expect((await screen.findByRole('alert')).textContent).toContain('documento de entrada');
  });
});

describe('a reposição', () => {
  it('manda quantidade e documento, e a gaveta é relida', async () => {
    entrar('gerente_oficina');
    montar();
    await screen.findByText('Controlador 48V 1000W');

    fireEvent.change(screen.getByPlaceholderText('Bipe ou digite'), {
      target: { value: '7891234567890' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Procurar' }));
    await screen.findByRole('button', { name: 'Repor' });

    fireEvent.change(screen.getByLabelText('Quantas chegaram'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('Documento (nota, cupom ou recibo)'), {
      target: { value: 'NF 12345' },
    });
    fireEvent.change(screen.getByLabelText('Fornecedor'), { target: { value: 'Voltz' } });
    fireEvent.click(screen.getByRole('button', { name: 'Repor' }));

    await waitFor(() => expect(ultimoCorpo).not.toBeNull());
    expect(ultimoCorpo!.quantity).toBe(5);
    expect(ultimoCorpo!.documento).toEqual({
      numero: 'NF 12345',
      fornecedor: 'Voltz',
      valorTotalCents: null,
    });

    // Sem a releitura a tela mostraria 8 depois de repor 5. São DUAS células
    // com 13 — em estoque e disponível —, porque nada está prometido.
    await waitFor(() => {
      const linha = screen.getByText('Controlador 48V 1000W').closest('tr')!;
      expect(within(linha).getAllByText('13')).toHaveLength(2);
    });
  });
});

// ============================================================================

/**
 * O CLIQUE DUPLO.
 *
 * O servidor recusa entrada sem `Idempotency-Key`, então uma tela que ESQUEÇA
 * a chave falha alto, na cara de quem está usando. O que falha em silêncio é
 * a tela que manda uma chave NOVA a cada clique: aí o servidor considera dois
 * fatos distintos e a carga entra duas vezes — que é o defeito original,
 * voltando pela porta de cima. É isto que este bloco tranca.
 */
describe('a chave de entrada é do gesto, não do clique', () => {
  async function biparControlador() {
    entrar('gerente_oficina');
    montar();
    await screen.findByText('Controlador 48V 1000W');
    fireEvent.change(screen.getByPlaceholderText('Bipe ou digite'), {
      target: { value: '7891234567890' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Procurar' }));
    await screen.findByRole('button', { name: 'Repor' });
    fireEvent.change(screen.getByLabelText('Quantas chegaram'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('Documento (nota, cupom ou recibo)'), {
      target: { value: 'NF 12345' },
    });
  }

  /*
    O CASO QUE ACONTECE DE VERDADE: a tentativa que falhou e a que repete.

    Dois cliques seguidos no botão não provam nada — o `loading` do botão já
    engole o segundo. O que morde é a rede: o POST sai, o servidor RECEBE e
    grava, e a resposta se perde no caminho. A tela mostra erro, o formulário
    continua aberto, e quem está na bancada clica de novo. Se a chave for do
    CLIQUE, essa segunda tentativa é um fato novo para o servidor e a carga
    entra duas vezes — exatamente o defeito que estamos consertando.
  */
  it('a tentativa que repete depois da falha manda a MESMA chave', async () => {
    await biparControlador();

    // A primeira chega ao servidor e volta erro (ou não volta).
    recusa = { status: 503, code: 'CORE_UNAVAILABLE', message: 'Servidor indisponível.' };
    fireEvent.click(screen.getByRole('button', { name: 'Repor' }));
    await waitFor(() => expect(chaves.length).toBe(1));
    await screen.findByRole('alert');

    // A pessoa clica de novo, com o formulário do mesmo jeito.
    recusa = null;
    fireEvent.click(screen.getByRole('button', { name: 'Repor' }));
    await waitFor(() => expect(chaves.length).toBe(2));

    expect(chaves[1]).toBe(chaves[0]);
  });

  it('e a chave sai preenchida — sem ela o servidor recusa', async () => {
    await biparControlador();
    fireEvent.click(screen.getByRole('button', { name: 'Repor' }));

    await waitFor(() => expect(chaves.length).toBeGreaterThanOrEqual(1));
    expect(chaves[0]).toBeTruthy();
    expect(String(chaves[0])).toMatch(/^bancada-/);
  });

  it('o BIPE seguinte ganha chave nova — a segunda viagem do fornecedor entra', async () => {
    await biparControlador();
    fireEvent.click(screen.getByRole('button', { name: 'Repor' }));
    await waitFor(() => expect(chaves.length).toBe(1));

    // Mesma nota, mesma peça, mesmo tudo — outro gesto.
    fireEvent.change(screen.getByPlaceholderText('Bipe ou digite'), {
      target: { value: '7891234567890' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Procurar' }));
    await screen.findByRole('button', { name: 'Repor' });
    fireEvent.change(screen.getByLabelText('Quantas chegaram'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('Documento (nota, cupom ou recibo)'), {
      target: { value: 'NF 12345' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Repor' }));

    await waitFor(() => expect(chaves.length).toBe(2));
    expect(chaves[1]).not.toBe(chaves[0]);
  });
});

/**
 * A TENTATIVA QUE JÁ REGISTROU OUTRA ENTRADA (R2-IDEM, item 6).
 *
 * A chave é do gesto (o bipe) e só troca no bipe seguinte. Resposta perdida (o
 * servidor gravou) e a pessoa corrigiu a quantidade: o servidor recusa a MESMA
 * chave com outra carga (422 CORE_IDEMPOTENCY_KEY_REUSED), e a tela repetia o
 * texto do servidor a cada clique, presa na mesma chave.
 */
describe('a tentativa que já registrou outra entrada (422)', () => {
  async function reporERecusar() {
    entrar('gerente_oficina');
    montar();
    await screen.findByText('Controlador 48V 1000W');
    fireEvent.change(screen.getByPlaceholderText('Bipe ou digite'), { target: { value: '7891234567890' } });
    fireEvent.click(screen.getByRole('button', { name: 'Procurar' }));
    await screen.findByRole('button', { name: 'Repor' });
    fireEvent.change(screen.getByLabelText('Quantas chegaram'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('Documento (nota, cupom ou recibo)'), { target: { value: 'NF 12345' } });
    recusa = {
      status: 422,
      code: 'CORE_IDEMPOTENCY_KEY_REUSED',
      message:
        'Esta chave de idempotência já registrou outra entrada de peça, com outro conteúdo — nada foi registrado '
        + 'agora. Um pedido novo precisa de chave nova.',
    };
    fireEvent.click(screen.getByRole('button', { name: 'Repor' }));
    return screen.findByRole('dialog', { name: /já registrou uma entrada/i });
  }

  it('diz o que houve na língua da bancada — e nada é reenviado sem a escolha', async () => {
    const dialogo = await reporERecusar();
    expect(dialogo.textContent).toMatch(/nada foi lançado agora/i);
    expect(screen.queryByText(/idempot/i)).toBeNull();
    await new Promise((r) => setTimeout(r, 80));
    expect(chaves).toHaveLength(1);
  });

  it('"Registrar como entrada nova" repõe com OUTRA chave', async () => {
    const dialogo = await reporERecusar();
    recusa = null;
    fireEvent.click(within(dialogo).getByRole('button', { name: /Registrar como entrada nova/i }));

    await waitFor(() => expect(chaves).toHaveLength(2));
    expect(chaves[1]).toMatch(/^bancada-/);
    expect(chaves[1]).not.toBe(chaves[0]);
    expect(ultimoCorpo!.quantity).toBe(5);
    expect(await screen.findByText('Reposta na gaveta.')).toBeTruthy();
  });

  it('"Voltar ao formulário" não reenvia nada', async () => {
    const dialogo = await reporERecusar();
    fireEvent.click(within(dialogo).getByRole('button', { name: /Voltar ao formulário/i }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /já registrou uma entrada/i })).toBeNull());
    expect(chaves).toHaveLength(1);
    expect((screen.getByLabelText('Quantas chegaram') as HTMLInputElement).value).toBe('5');
  });
});
