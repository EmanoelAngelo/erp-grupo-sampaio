/**
 * FECHAR E COBRAR A OS PELA TELA — rodada 43.
 *
 * ## O buraco que este arquivo fecha
 *
 * A auditoria mediu cinco rotas prontas e ÓRFÃS: `labor`, `complete`,
 * `comments`, `pending-payment` e `checkout`. O mecânico via a OS e não
 * conseguia fechá-la pelo sistema; o caixa não tinha onde registrar o
 * recebimento. O defeito era inteiro de frontend — o servidor estava certo o
 * tempo todo — e é a forma de defeito que teste de servidor não alcança.
 *
 * ## O que cada teste derruba
 *
 *   - tire a chamada de `/labor` e o total do cabeçalho nunca muda;
 *   - tire o `hasCost`/`noCostReason` do corpo e a garantia vira cobrança;
 *   - mostre "Concluir serviço" ao gerente que não assumiu e o clique leva 403;
 *   - troque `amountCents` no checkout e o caixa cobra outro valor;
 *   - esconda o selo do orçamento e ninguém sabe que o cliente já respondeu.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { setSession } from '@/lib/api/client';
import OrdemServicoPage from '../OrdemServicoPage';

const OS_ID = 'os-43';
const BANCADA = 'wk-mob';
const MECANICO = 'user-mec';

interface ComentarioNaOS {
  id: string;
  author_kind: string;
  author_name: string | null;
  body: string;
  created_at: string;
}

let os: {
  id: string;
  number: number;
  status: string;
  workshop_id: string;
  mechanic_id: string | null;
  mechanic_name: string | null;
  workshop_name: string;
  customer_display: string;
  customer_phone: null;
  customer_id: null;
  equipment_display: string;
  equipment_public_id: null;
  equipment_serial: null;
  plate: null;
  complaint: string;
  diagnosis: string | null;
  labor_cents: number;
  parts_cents: number;
  total_cents: number;
  opened_by_customer: number;
  approval_requested_at: string | null;
  approved_at: string | null;
  created_at: string;
  parts: never[];
  comments: ComentarioNaOS[];
  events: never[];
};

/** Toda URL pedida com o corpo que foi junto — é a prova do contrato. */
/** A gaveta da oficina que a rota devolve — aberta ou nada. */
let caixaAberto: Record<string, unknown> | null = { id: 'caixa-oficina', status: 'aberto' };

let pedidos: { alvo: string; corpo: Record<string, unknown> }[];

/** O que a rota de avisos da OS devolve (GAP-PRD-036) — o servidor dublado mexe nela. */
let avisosDaOs: {
  emailDoCliente: string | null;
  envioLigado: boolean;
  avisos: Record<string, unknown>[];
};

function osViva() {
  return {
    id: OS_ID,
    number: 43,
    status: 'em_andamento',
    workshop_id: BANCADA,
    mechanic_id: MECANICO,
    mechanic_name: 'Zé Mecânico',
    workshop_name: 'Oficina de Mobilidade',
    customer_display: 'Dona Marta',
    customer_phone: null,
    customer_id: null,
    equipment_display: 'Shineray PT2',
    equipment_public_id: null,
    equipment_serial: null,
    plate: null,
    complaint: 'não liga',
    diagnosis: null,
    labor_cents: 0,
    parts_cents: 0,
    total_cents: 0,
    opened_by_customer: 0,
    approval_requested_at: null as string | null,
    approved_at: null as string | null,
    created_at: '2026-08-20T12:00:00.000Z',
    parts: [] as never[],
    comments: [] as ComentarioNaOS[],
    events: [] as never[],
  };
}

/**
 * O servidor dublado MEXE no estado, como o real: salvar mão de obra muda o
 * total, concluir muda o status, cobrar finaliza. Um dublê que só respondesse
 * 200 deixaria passar uma tela que dispara a chamada e nunca relê a ordem.
 */
function servidor() {
  return vi.fn(async (url: string | URL | Request, init?: { method?: string; body?: string }) => {
    const alvo = String(url);
    const metodo = (init?.method ?? 'GET').toUpperCase();
    const corpo = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    if (metodo === 'POST') pedidos.push({ alvo, corpo });

    const responder = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });

    if (alvo.includes('/core/cash/open') && metodo === 'GET') {
      // O caixa da oficina, aberto ou não: é ele que decide se o dinheiro
      // pode ser recebido em espécie.
      return responder({ session: caixaAberto, cashWithdrawalLimitCents: null });
    }
    if (metodo === 'POST' && alvo.endsWith('/labor')) {
      os.labor_cents = Number(corpo.laborCents);
      os.total_cents = os.labor_cents + os.parts_cents;
      return responder(os);
    }
    if (metodo === 'POST' && alvo.endsWith('/pedir-aprovacao')) {
      os.approval_requested_at = '2026-08-23T10:00:00.000Z';
      os.approved_at = null;
      // Como o real: com e-mail no cadastro, o aviso entra na fila.
      if (avisosDaOs.emailDoCliente) {
        avisosDaOs.avisos.unshift({
          id: 'aviso-1',
          template: 'os_orcamento_disponivel',
          templateLabel: 'Orçamento da OS para aprovar',
          toAddress: avisosDaOs.emailDoCliente,
          status: 'pending',
          lastError: null,
          createdAt: '2026-08-23T10:00:00.000Z',
          sentAt: null,
        });
      }
      return responder(os);
    }
    if (alvo.endsWith('/avisos') && metodo === 'GET') return responder(avisosDaOs);
    if (metodo === 'POST' && alvo.endsWith('/complete')) {
      os.diagnosis = String(corpo.diagnosis);
      os.status = corpo.hasCost ? 'aguardando_pagamento' : 'finalizada';
      return responder(os);
    }
    if (metodo === 'POST' && alvo.endsWith('/checkout')) {
      os.status = 'finalizada';
      return responder(
        { order: os, sale: { id: 'sale-1', number: 7, change_cents: 0 }, replay: false },
        201,
      );
    }
    if (metodo === 'POST' && alvo.endsWith('/comments')) {
      os.comments.push({
        id: `c-${os.comments.length + 1}`,
        author_kind: 'tecnico',
        author_name: 'Zé Mecânico',
        body: String(corpo.body),
        created_at: '2026-08-23T11:00:00.000Z',
      });
      return responder({ ok: true }, 201);
    }
    if (/\/core\/workshop\/orders\/[^/]+$/.test(alvo)) return responder(os);
    if (alvo.includes('/core/workshop/parts')) return responder({ items: [] });
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
  caixaAberto = { id: 'caixa-oficina', status: 'aberto' };
  os = osViva();
  avisosDaOs = { emailDoCliente: 'marta@exemplo.com', envioLigado: false, avisos: [] };
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

describe('mão de obra', () => {
  it('salva em CENTAVOS o que o mecânico digita em reais — e o cabeçalho relê o total', async () => {
    montar();
    /*
      Digitar e CONFERIR que pegou, na mesma tentativa.

      A tela troca a árvore inteira enquanto carrega (`Carregando…`) e sincroniza
      o campo com o valor gravado assim que a ordem chega. Guardar o nó devolvido
      pela primeira busca e digitar nele depois dá certo quase sempre — e, com a
      máquina ocupada, digita num nó já substituído: o clique seguinte manda o
      campo VAZIO e o teste acusa a conversão de reais por um defeito que é da
      própria espera. `waitFor` repete a busca e a digitação até o valor ficar.
    */
    await waitFor(() => {
      const campo = screen.getByLabelText('Mão de obra (R$)') as HTMLInputElement;
      fireEvent.change(campo, { target: { value: '150,00' } });
      expect(campo.value).toBe('150,00');
    });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar mão de obra' }));

    await waitFor(() => {
      const labor = pedidos.find((p) => p.alvo.endsWith('/labor'));
      expect(labor).toBeTruthy();
      // 150,00 em reais são 15000 centavos. Mandar 150 cobraria R$ 1,50.
      expect(labor!.corpo.laborCents).toBe(15000);
    });
    // A tela releu a ordem: o total do cabeçalho é o novo.
    await screen.findByText('R$ 150,00', { selector: 'p' });
  });
});

describe('orçamento com o cliente', () => {
  it('com valor na conta, pedir registra o pedido, o selo aparece — e a tela diz onde o aviso está', async () => {
    os.labor_cents = 15000;
    os.total_cents = 15000;
    montar();
    // O botão diz o que FAZ (GAP-PRD-036): pede. "Enviar" prometia um envio que não existia.
    expect(screen.queryByRole('button', { name: 'Enviar orçamento ao cliente' })).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'Pedir aprovação do cliente' }));
    await waitFor(() => {
      expect(pedidos.some((p) => p.alvo.endsWith('/pedir-aprovacao'))).toBe(true);
    });
    await screen.findByText('Orçamento aguardando o cliente');
    // Nada de "enviado em": o pedido foi feito; o e-mail está NA FILA, e a
    // tela diz por que ainda não saiu.
    expect(screen.queryByText(/enviado em/)).toBeNull();
    const avisos = await screen.findByLabelText('Avisos ao cliente');
    expect(avisos.textContent).toContain('Orçamento da OS para aprovar');
    expect(avisos.textContent).toContain('na fila para marta@exemplo.com');
    expect(avisos.textContent).toContain('quando o envio de e-mail da loja for ligado');
  });

  it('cliente sem e-mail: a tela manda avisar por telefone em vez de fingir que mandou', async () => {
    os.labor_cents = 15000;
    os.total_cents = 15000;
    avisosDaOs = { emailDoCliente: null, envioLigado: true, avisos: [] };
    montar();
    fireEvent.click(await screen.findByRole('button', { name: 'Pedir aprovação do cliente' }));
    await screen.findByText('Orçamento aguardando o cliente');
    await screen.findByText(/O cliente não tem e-mail cadastrado: nenhum aviso sai por e-mail/);
  });

  it('o aviso que já saiu aparece como enviado, com o endereço', async () => {
    os.approval_requested_at = '2026-08-22T09:00:00.000Z';
    avisosDaOs = {
      emailDoCliente: 'marta@exemplo.com',
      envioLigado: true,
      avisos: [
        {
          id: 'aviso-9',
          template: 'os_orcamento_disponivel',
          templateLabel: 'Orçamento da OS para aprovar',
          toAddress: 'marta@exemplo.com',
          status: 'sent',
          lastError: null,
          createdAt: '2026-08-22T09:00:00.000Z',
          sentAt: '2026-08-22T09:01:00.000Z',
        },
      ],
    };
    montar();
    const avisos = await screen.findByLabelText('Avisos ao cliente');
    expect(avisos.textContent).toContain('enviado para marta@exemplo.com em');
  });

  it('orçamento zerado não tem botão armado — o servidor recusaria com 409', async () => {
    montar();
    const botao = await screen.findByRole('button', { name: 'Pedir aprovação do cliente' });
    expect((botao as HTMLButtonElement).disabled).toBe(true);
  });

  it('a resposta do cliente aparece como selo, com a data', async () => {
    os.approval_requested_at = '2026-08-22T09:00:00.000Z';
    os.approved_at = '2026-08-22T15:30:00.000Z';
    montar();
    await screen.findByText('Orçamento aprovado pelo cliente');
  });
});

describe('conclusão técnica', () => {
  it('com cobrança: manda diagnóstico e hasCost, e a OS vai para o caixa', async () => {
    os.labor_cents = 15000;
    os.total_cents = 15000;
    montar();
    fireEvent.click(await screen.findByRole('button', { name: 'Concluir serviço' }));
    fireEvent.change(screen.getByLabelText('Diagnóstico / o que foi feito'), {
      target: { value: 'Troca do controlador' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar conclusão' }));

    await waitFor(() => {
      const done = pedidos.find((p) => p.alvo.endsWith('/complete'));
      expect(done).toBeTruthy();
      expect(done!.corpo.diagnosis).toBe('Troca do controlador');
      expect(done!.corpo.hasCost).toBe(true);
      expect(done!.corpo.noCostReason).toBeUndefined();
    });
    // A tela releu: o selo do caixa aparece (persona mecânico não cobra).
    await screen.findByText('Aguardando pagamento');
  });

  it('sem custo: o motivo VIAJA no corpo — sem ele qualquer serviço vira cortesia', async () => {
    montar();
    fireEvent.click(await screen.findByRole('button', { name: 'Concluir serviço' }));
    fireEvent.change(screen.getByLabelText('Diagnóstico / o que foi feito'), {
      target: { value: 'Aperto de conector, garantia da venda' },
    });
    fireEvent.click(screen.getByLabelText('Sem custo'));
    fireEvent.change(screen.getByLabelText('Motivo de não cobrar'), {
      target: { value: 'garantia' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar conclusão' }));

    await waitFor(() => {
      const done = pedidos.find((p) => p.alvo.endsWith('/complete'));
      expect(done).toBeTruthy();
      expect(done!.corpo.hasCost).toBe(false);
      expect(done!.corpo.noCostReason).toBe('garantia');
    });
  });

  it('gerente que NÃO assumiu não vê o botão — vê a régua, como o servidor cobraria', async () => {
    entrarComo('gerente_oficina', 'user-gerente');
    montar();
    // Nem o campo de mão de obra aparece: setLabor também recusa OS de outro
    // técnico, e oferecer o campo seria oferecer um 403.
    await screen.findByText('Serviço e conta');
    expect(screen.queryByLabelText('Mão de obra (R$)')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Concluir serviço' })).toBeNull();
    // getByText lança se a régua não estiver lá — é a asserção.
    screen.getByText(/Quem conclui é Zé Mecânico/);
  });
});

/**
 * O recebimento passou a ser o fechamento do PDV (GAP-PRD-104): "Registrar
 * recebimento" abre o resumo da OS, "Receber" abre o `PagamentoDialog`, e o
 * meio é escolhido lá — como no balcão da loja. Esta função faz o caminho.
 */
async function receberNoMeio(meio: RegExp) {
  fireEvent.click(await screen.findByRole('button', { name: 'Registrar recebimento' }));
  fireEvent.click(await screen.findByRole('button', { name: /^Receber R\$/ }));
  fireEvent.click(await screen.findByRole('button', { name: meio }));
  fireEvent.click(screen.getByRole('button', { name: /^Lançar$/ }));
  const finalizar = screen.getByRole('button', { name: /^Finalizar/ }) as HTMLButtonElement;
  await waitFor(() => expect(finalizar.disabled).toBe(false));
  fireEvent.click(finalizar);
}

describe('o caixa da oficina', () => {
  it('em aguardando_pagamento, o caixa cobra o TOTAL da OS no método escolhido', async () => {
    os.status = 'aguardando_pagamento';
    os.labor_cents = 15000;
    os.total_cents = 15000;
    entrarComo('operador_caixa_oficina', 'user-caixa');
    montar();

    await receberNoMeio(/^PIX/);

    await waitFor(() => {
      const cobranca = pedidos.find((p) => p.alvo.endsWith('/checkout'));
      expect(cobranca).toBeTruthy();
      const payments = cobranca!.corpo.payments as { method: string; amountCents: number }[];
      expect(payments).toEqual([{ method: 'pix', amountCents: 15000 }]);
    });
    // A tela releu: finalizada.
    await screen.findByText('Finalizada');
  });

  it('o mecânico NÃO vê o formulário de cobrança — cobrar é gesto do caixa', async () => {
    os.status = 'aguardando_pagamento';
    montar();
    await screen.findByText(/quem registra o recebimento é o caixa/);
    expect(screen.queryByRole('button', { name: 'Registrar recebimento' })).toBeNull();
  });
});

describe('comentários na linha do tempo', () => {
  it('registrar manda o corpo e a história recarrega com a fala', async () => {
    montar();
    fireEvent.change(await screen.findByLabelText('Novo comentário'), {
      target: { value: 'Peça encomendada no fornecedor.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Registrar' }));

    await waitFor(() => {
      const c = pedidos.find((p) => p.alvo.endsWith('/comments'));
      expect(c).toBeTruthy();
      expect(c!.corpo.body).toBe('Peça encomendada no fornecedor.');
    });
    await screen.findByText('Peça encomendada no fornecedor.');
  });

  it('a fala vinda do portal é rotulada como do CLIENTE, não como comentário da equipe', async () => {
    os.comments.push({
      id: 'c-cliente',
      author_kind: 'proprietario',
      author_name: 'Dona Marta',
      body: 'Orçamento de R$ 150,00 APROVADO pelo cliente.',
      created_at: '2026-08-23T09:00:00.000Z',
    });
    montar();
    await screen.findByText('Fala do cliente');
  });
});

// ============================================================================

describe('o dinheiro da oficina passa pela gaveta', () => {
  it('recebimento em espécie manda a sessão de caixa aberta', async () => {
    /*
      A rota do checkout aceita `cashSessionId` e `createSale` lança o movimento
      quando ele vem — mas a tela nunca mandava. A OS era paga em dinheiro no
      balcão da oficina, a venda nascia certa, e a gaveta não via nada: no fim
      do dia o caixa contava notas que o sistema não sabia explicar.
    */
    os.status = 'aguardando_pagamento';
    os.labor_cents = 15000;
    os.total_cents = 15000;
    entrarComo('operador_caixa_oficina', 'user-caixa');
    montar();

    await receberNoMeio(/^Dinheiro/);

    await waitFor(() => {
      const cobranca = pedidos.find((p) => p.alvo.endsWith('/checkout'));
      expect(cobranca?.corpo.cashSessionId).toBe('caixa-oficina');
    });
  });

  it('sem caixa aberto, o recebimento em dinheiro é recusado — e nada é enviado', async () => {
    caixaAberto = null;
    os.status = 'aguardando_pagamento';
    os.labor_cents = 15000;
    os.total_cents = 15000;
    entrarComo('operador_caixa_oficina', 'user-caixa');
    montar();

    await receberNoMeio(/^Dinheiro/);

    // A prova é a ausência do POST: registrar assim finalizaria a OS e deixaria
    // o dinheiro fora de qualquer gaveta.
    expect(await screen.findByText(/caixa aberto/i)).toBeTruthy();
    expect(pedidos.find((p) => p.alvo.endsWith('/checkout'))).toBeUndefined();
  });

  it('PIX não depende de gaveta: recebe com o caixa fechado', async () => {
    caixaAberto = null;
    os.status = 'aguardando_pagamento';
    os.labor_cents = 15000;
    os.total_cents = 15000;
    entrarComo('operador_caixa_oficina', 'user-caixa');
    montar();

    await receberNoMeio(/^PIX/);

    // PIX cai na conta, não na gaveta. Travar aqui seria inventar uma regra
    // onde o dinheiro nem passa pelo balcão.
    await waitFor(() => {
      const cobranca = pedidos.find((p) => p.alvo.endsWith('/checkout'));
      expect(cobranca).toBeTruthy();
      expect(cobranca!.corpo.cashSessionId ?? null).toBeNull();
    });
  });
});
