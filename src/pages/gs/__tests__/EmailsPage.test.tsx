/**
 * A fila de e-mail, na tela do gestor.
 *
 * O que ela não pode errar:
 *
 * 1. Dizer que enviou quando não enviou. Sem credencial, o botão responde
 *    `READY_FOR_CREDENTIAL` — e a tela precisa repetir isso em português, com
 *    o que falta. Um "enviado!" falso faz o suporte procurar na caixa do
 *    cliente uma mensagem que nunca chegou.
 *
 * 2. Esconder o conteúdo. "Pronto para a credencial" só é conferível se der
 *    para LER o corpo exato que sairia antes de ligar o envio.
 *
 * 3. Esconder o MOTIVO da falha (GAP-PRD-038). A API já entregava `lastError`
 *    e a tela só dizia "failed": o gestor não sabia por quê nem conseguia
 *    reenviar sem SQL. Agora motivo, tentativas, próxima hora e "Reenviar".
 *
 * 4. Mandar preencher o .env sem dizer o que acontece depois (GAP-PRD-065).
 *
 * 5. Mostrar o segredo do cliente (GAP-PRD-007): o corpo chega do servidor
 *    com o marcador, e a tela explica que o link é só do cliente.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import EmailsPage from '../EmailsPage';
import { respostaDaBarraDoShell } from './barraDoShell';

const STATUS_SEM_CREDENCIAL = {
  readiness: 'READY_FOR_CREDENTIAL',
  enabled: false,
  missing: ['EMAIL_ENABLED=true', 'EMAIL_SMTP_HOST'],
  pending: 2,
  sent: 0,
  failed: 0,
};

const MENSAGEM = {
  id: 'e-1',
  template: 'pedido_recebido',
  toAddress: 'ana@exemplo.com',
  subject: 'Gringa · pedido #42 recebido',
  bodyText: 'Olá, Ana.\n\nRecebemos seu pedido #42 no valor de R$ 246,75.',
  status: 'pending',
  attempts: 0,
  lastError: null,
  sentAt: null,
  createdAt: new Date().toISOString(),
};

/** A identidade do remetente como o servidor devolve no padrão (GAP-PRD-198). */
const IDENTIDADE_PADRAO = {
  identidade: {
    modo: 'grupo',
    nomeRemetente: null,
    enderecoRemetente: null,
    responderPara: null,
    assinatura: null,
    updatedAt: null,
  },
  previa: {
    de: 'grupo@sampaio.com.br',
    responderPara: null,
    assinatura: 'Gringa — Grupo Sampaio',
    aviso: null,
  },
};

/** O que falta, como o servidor devolve para a empresa sem nada configurado (GAP-PRD-130). */
const PRONTIDAO = {
  companyId: 'gringa',
  pronto: false,
  faltam: 2,
  itens: [
    {
      chave: 'carteiro',
      rotulo: 'Envio de e-mail (SMTP)',
      situacao: 'falta',
      detalhe: 'Nada sai enquanto faltar no .env do servidor: EMAIL_SMTP_HOST.',
      oQueFazer: 'Preencher as variáveis EMAIL_* no .env do servidor — não precisa reiniciar.',
      quem: 'dono',
      onde: { rotulo: '.env do servidor', caminho: null },
    },
    {
      chave: 'contador_destinatario',
      rotulo: 'Para quem vai o pacote do contador',
      situacao: 'falta',
      detalhe: 'Nenhum destinatário cadastrado.',
      oQueFazer: 'Cadastrar o e-mail do escritório de contabilidade.',
      quem: 'contador',
      onde: { rotulo: 'Fiscal › Fechamento do contador', caminho: '/sistema/fiscal/fechamento' },
    },
    {
      chave: 'remetente',
      rotulo: 'Quem assina os e-mails',
      situacao: 'ok',
      detalhe: 'Assina como o grupo — o padrão, que já funciona.',
      oQueFazer: null,
      quem: null,
      onde: null,
    },
  ],
};

function servidor(envio: unknown = { readiness: 'READY_FOR_CREDENTIAL', sent: 0, missing: ['EMAIL_SMTP_HOST'] }) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: { method?: string }) => {
      const daBarra = respostaDaBarraDoShell(url);
      if (daBarra) return daBarra;
      const corpo = String(url).includes('/core/comunicacoes/prontidao')
        ? PRONTIDAO
        : String(url).includes('/core/emails/identidade')
        ? IDENTIDADE_PADRAO
        : (init?.method ?? 'GET').toUpperCase() === 'POST'
          ? envio
          : { status: STATUS_SEM_CREDENCIAL, items: [MENSAGEM] };
      return new Response(JSON.stringify(corpo), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
}

function montar() {
  render(
    <MemoryRouter>
      <EmailsPage />
    </MemoryRouter>,
  );
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('prontidão', () => {
  it('mostra o estado e o que falta, item a item', async () => {
    servidor();
    montar();

    await screen.findByText('Aguardando credencial');
    expect(screen.getByText('READY_FOR_CREDENTIAL')).toBeTruthy();
    // A lista precisa ser acionável: cada item é uma variável do .env.
    expect(screen.getByText('EMAIL_SMTP_HOST')).toBeTruthy();
    expect(screen.getByText(/2 na fila/)).toBeTruthy();
  });
});

describe('processar a fila', () => {
  it('sem credencial, diz que NADA saiu e por quê', async () => {
    servidor();
    montar();

    fireEvent.click(await screen.findByRole('button', { name: 'Processar fila' }));

    const aviso = await screen.findByRole('status');
    // "Enviado!" aqui seria mentira sobre dinheiro e sobre confiança.
    expect(aviso.textContent).toMatch(/Nada foi enviado/);
    expect(aviso.textContent).toMatch(/EMAIL_SMTP_HOST/);
  });

  it('com credencial, informa quantas saíram', async () => {
    servidor({ readiness: 'READY', sent: 3, missing: [] });
    montar();

    fireEvent.click(await screen.findByRole('button', { name: 'Processar fila' }));

    const aviso = await screen.findByRole('status');
    expect(aviso.textContent).toMatch(/3 mensagem\(ns\) enviada\(s\)/);
  });
});

describe('o conteúdo é conferível', () => {
  it('dá para ler o assunto e o corpo exatos que sairiam', async () => {
    servidor();
    montar();

    fireEvent.click(await screen.findByRole('button', { name: 'Ver a mensagem' }));

    await screen.findByText(/Gringa · pedido #42 recebido/);
    // Sem poder ler o corpo, "pronto para a credencial" seria só uma promessa.
    expect(screen.getByText(/Recebemos seu pedido #42 no valor de R\$ 246,75/)).toBeTruthy();
  });
});

// ============================================================================
// GAP-PRD-038 / 065 / 007 — motivo, reenvio, filtro, recado do .env, segredo
// ============================================================================

const FALHOU = {
  ...MENSAGEM,
  id: 'e-2',
  template: 'pagamento_confirmado',
  status: 'failed',
  attempts: 6,
  lastError: '535-5.7.8 Username and Password not accepted',
  nextAttemptAt: null,
  podeReenviar: true,
  motivoSemReenvio: null,
};

const FALHOU_SEM_VOLTA = {
  ...MENSAGEM,
  id: 'e-3',
  template: 'recuperacao_senha',
  subject: 'Grupo Sampaio · recuperação de senha',
  bodyText:
    'Abra este link para escolher uma nova senha (vale por 1 hora):\n[protegido: só o cliente recebe]',
  status: 'failed',
  attempts: 0,
  lastError: 'O link de recuperação venceu (vale 1 hora) antes de sair.',
  podeReenviar: false,
  motivoSemReenvio: 'O cliente precisa pedir outro em "Esqueci minha senha".',
};

const ESPERANDO = {
  ...MENSAGEM,
  id: 'e-4',
  attempts: 2,
  lastError: 'connect ETIMEDOUT',
  nextAttemptAt: '2026-09-11T15:30:00.000Z',
};

function servidorCompleto(itens: unknown[]) {
  const chamadas: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: { method?: string }) => {
      const daBarra = respostaDaBarraDoShell(url);
      if (daBarra) return daBarra;
      const alvo = String(url);
      const metodo = (init?.method ?? 'GET').toUpperCase();
      chamadas.push(`${metodo} ${alvo}`);
      const corpo = alvo.includes('/core/comunicacoes/prontidao')
        ? PRONTIDAO
        : alvo.includes('/core/emails/identidade')
        ? IDENTIDADE_PADRAO
        : alvo.includes('/reenviar')
          ? { item: { ...FALHOU, status: 'pending', attempts: 0 }, status: STATUS_SEM_CREDENCIAL }
          : { status: STATUS_SEM_CREDENCIAL, items: itens };
      return new Response(JSON.stringify(corpo), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
  return chamadas;
}

describe('a falha tem motivo e volta pela tela', () => {
  it('mostra o motivo, as tentativas e a situação sem precisar abrir a mensagem', async () => {
    servidorCompleto([FALHOU]);
    montar();
    expect(await screen.findByText(/535-5\.7\.8 Username and Password not accepted/)).toBeTruthy();
    expect(screen.getByText(/6 tentativa\(s\)/)).toBeTruthy();
    expect(screen.getByText('Falhou')).toBeTruthy();
  });

  it('a pendente que falhou diz quando sai a próxima tentativa', async () => {
    servidorCompleto([ESPERANDO]);
    montar();
    expect(await screen.findByText(/2 tentativa\(s\) · próxima tentativa em/)).toBeTruthy();
    expect(screen.getByText(/connect ETIMEDOUT/)).toBeTruthy();
  });

  it('"Reenviar" chama a rota DA mensagem e relê a fila', async () => {
    const chamadas = servidorCompleto([FALHOU]);
    montar();
    fireEvent.click(await screen.findByRole('button', { name: 'Reenviar' }));
    const aviso = await screen.findByRole('status');
    expect(aviso.textContent).toMatch(/de volta à fila/);
    expect(chamadas.some((c) => c.startsWith('POST') && c.endsWith('/core/emails/e-2/reenviar'))).toBe(
      true,
    );
    // Releu depois de reenviar.
    expect(chamadas.filter((c) => c.startsWith('GET')).length).toBeGreaterThanOrEqual(2);
  });

  it('quando não dá para reenviar, não oferece o botão e diz o que fazer', async () => {
    servidorCompleto([FALHOU_SEM_VOLTA]);
    montar();
    expect(await screen.findByText(/Não dá para reenviar: .*Esqueci minha senha/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Reenviar' })).toBeNull();
  });

  it('o filtro "Com falha" pede só as que falharam ao servidor', async () => {
    const chamadas = servidorCompleto([FALHOU]);
    montar();
    await screen.findByText('Falhou');
    fireEvent.click(screen.getByRole('button', { name: 'Com falha' }));
    await vi.waitFor(() => {
      expect(chamadas.some((c) => c.startsWith('GET') && c.endsWith('/core/emails?status=failed'))).toBe(true);
    });
    expect(screen.getByRole('button', { name: 'Com falha' }).getAttribute('aria-pressed')).toBe('true');
  });
});

describe('o recado do .env (GAP-PRD-065)', () => {
  it('junto do que falta, diz que o servidor relê o .env e NÃO precisa reiniciar', async () => {
    servidorCompleto([]);
    montar();
    await screen.findByText('EMAIL_SMTP_HOST');
    expect(screen.getByText(/não precisa reiniciar a API/)).toBeTruthy();
    // E a exceção honesta: variável do ambiente do sistema pede reinício.
    expect(screen.getByText(/ambiente do sistema/)).toBeTruthy();
  });
});

describe('o segredo do cliente não aparece (GAP-PRD-007)', () => {
  it('o corpo mostra o marcador e a tela explica que o link é só do cliente', async () => {
    servidorCompleto([FALHOU_SEM_VOLTA]);
    montar();
    fireEvent.click(await screen.findByRole('button', { name: 'Ver a mensagem' }));
    expect(await screen.findByText(/só o cliente recebe — por\s+isso ele não aparece aqui/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/token=/);
  });
});

describe('cada mensagem com o seu nome (GAP-PRD-199)', () => {
  it('o rótulo vem do servidor: "Recuperação de senha", nunca o código cru', async () => {
    servidorCompleto([{ ...FALHOU_SEM_VOLTA, templateLabel: 'Recuperação de senha' }]);
    montar();
    expect(await screen.findByText('Recuperação de senha')).toBeTruthy();
    expect(screen.queryByText('recuperacao_senha')).toBeNull();
  });
});

describe('a fila desta empresa e o remetente dela (GAP-PRD-198)', () => {
  it('diz que "Processar fila" entrega só as mensagens desta empresa', async () => {
    servidor();
    montar();
    expect(await screen.findByText(/Entrega as mensagens desta empresa/)).toBeTruthy();
  });

  it('o padrão é o remetente do grupo, com a prévia do servidor; os campos só valem no modo da empresa', async () => {
    servidor();
    montar();
    const cartao = await screen.findByRole('region', { name: 'Remetente desta empresa' });
    await vi.waitFor(() => expect(cartao.textContent).toContain('grupo@sampaio.com.br'));
    expect(cartao.textContent).toContain('Gringa — Grupo Sampaio');
    expect((screen.getByRole('radio', { name: /Remetente do grupo/ }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Nome no "De:"') as HTMLInputElement).disabled).toBe(true);
  });

  it('escolher o remetente da empresa grava pelo PUT e mostra a prévia nova', async () => {
    const pedidos: { metodo: string; alvo: string; corpo: unknown }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request, init?: { method?: string; body?: string }) => {
        const daBarra = respostaDaBarraDoShell(url);
        if (daBarra) return daBarra;
        const alvo = String(url);
        const metodo = (init?.method ?? 'GET').toUpperCase();
        pedidos.push({ metodo, alvo, corpo: init?.body ? JSON.parse(init.body) : null });
        let corpo: unknown = { status: STATUS_SEM_CREDENCIAL, items: [] };
        if (alvo.includes('/core/emails/identidade')) {
          corpo =
            metodo === 'PUT'
              ? {
                  identidade: {
                    ...IDENTIDADE_PADRAO.identidade,
                    modo: 'empresa',
                    nomeRemetente: 'Gringa',
                    responderPara: 'contato@gringa.com.br',
                  },
                  previa: {
                    de: '"Gringa" <grupo@sampaio.com.br>',
                    responderPara: 'contato@gringa.com.br',
                    assinatura: 'Gringa — Grupo Sampaio',
                    aviso: null,
                  },
                }
              : IDENTIDADE_PADRAO;
        }
        return new Response(JSON.stringify(corpo), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );
    montar();
    await screen.findByRole('region', { name: 'Remetente desta empresa' });
    fireEvent.click(screen.getByRole('radio', { name: 'Remetente desta empresa' }));
    fireEvent.change(screen.getByLabelText('Nome no "De:"'), { target: { value: 'Gringa' } });
    fireEvent.change(screen.getByLabelText('Responder para'), {
      target: { value: 'contato@gringa.com.br' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar remetente' }));

    expect(await screen.findByText(/Remetente salvo/)).toBeTruthy();
    const put = pedidos.find((p) => p.metodo === 'PUT');
    expect(put?.alvo).toContain('/core/emails/identidade');
    expect(put?.corpo).toMatchObject({
      modo: 'empresa',
      nomeRemetente: 'Gringa',
      responderPara: 'contato@gringa.com.br',
    });
    // Nada de companyId no corpo: a empresa é a do token.
    expect(put?.corpo).not.toHaveProperty('companyId');
    const cartao = screen.getByRole('region', { name: 'Remetente desta empresa' });
    expect(cartao.textContent).toContain('"Gringa" <grupo@sampaio.com.br>');
  });
});

describe('o que falta para os e-mails desta empresa saírem (GAP-PRD-130)', () => {
  it('lista cada peça com a situação, o que fazer, quem fornece e onde', async () => {
    servidor();
    montar();
    const cartao = await screen.findByRole('region', {
      name: 'O que falta para os e-mails desta empresa saírem',
    });
    await vi.waitFor(() => expect(cartao.textContent).toContain('2 item(ns) por configurar'));
    expect(cartao.textContent).toContain('Envio de e-mail (SMTP)');
    expect(cartao.textContent).toContain('EMAIL_SMTP_HOST');
    expect(cartao.textContent).toContain('quem fornece: o dono');
    expect(cartao.textContent).toContain('.env do servidor');
    expect(cartao.textContent).toContain('quem fornece: o escritório de contabilidade');
    // O que tem tela vira link para ela.
    const link = screen.getByRole('link', { name: 'Fiscal › Fechamento do contador' });
    expect(link.getAttribute('href')).toBe('/sistema/fiscal/fechamento');
    // O que já funciona aparece como pronto, sem "o que fazer".
    expect(cartao.textContent).toContain('Pronto');
    expect(cartao.textContent).toContain('Quem assina os e-mails');
  });

  it('quando tudo está configurado, diz isso', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request) => {
        const daBarra = respostaDaBarraDoShell(url);
        if (daBarra) return daBarra;
        const alvo = String(url);
        const corpo = alvo.includes('/core/comunicacoes/prontidao')
          ? { ...PRONTIDAO, pronto: true, faltam: 0, itens: [PRONTIDAO.itens[2]] }
          : alvo.includes('/core/emails/identidade')
            ? IDENTIDADE_PADRAO
            : { status: STATUS_SEM_CREDENCIAL, items: [] };
        return new Response(JSON.stringify(corpo), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );
    montar();
    const cartao = await screen.findByRole('region', {
      name: 'O que falta para os e-mails desta empresa saírem',
    });
    await vi.waitFor(() =>
      expect(cartao.textContent).toContain('Tudo pronto: as comunicações desta empresa estão configuradas.'),
    );
  });
});
