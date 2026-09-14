/**
 * ============================================================================
 * A TELA DAS EMPRESAS DO GRUPO
 * ============================================================================
 *
 * ## O que não pode errar aqui, e por quê
 *
 * 1. A TELA DIZ O QUE VAI FAZER, ANTES DE FAZER. Criar uma operação não grava
 *    um cadastro: cria empresa, cria um LOGIN novo com senha provisória e,
 *    quando é oficina, cria a primeira bancada. Quem clica sai com uma
 *    credencial na mão para entregar a alguém. Descobrir isso DEPOIS é
 *    descobrir tarde: a senha já existe, e a pessoa que ia recebê-la não foi
 *    avisada.
 *
 *    E o aviso tem de ser VERDADEIRO PARA A ESCOLHA ATUAL. Prometer bancada
 *    numa criação de loja é pior que não prometer nada — vira uma bancada que
 *    alguém vai procurar e não achar.
 *
 * 2. A SENHA APARECE UMA VEZ E A TELA DIZ QUE NÃO VOLTA. O servidor guarda só
 *    o Argon2id; o texto existe apenas na tela de quem digitou. Uma tela que
 *    mostra a senha sem avisar que é a última vez produz o pior desfecho
 *    possível: a operação nasce, ninguém consegue entrar nela, e a correção
 *    exige resetar a senha de um usuário que a pessoa nem sabe que criou.
 *
 * 3. A LISTA É DO GRUPO, não da empresa da sessão — e 403 se identifica como
 *    permissão, não como "falha ao carregar". Esta rota é a única que
 *    atravessa empresas; uma mensagem genérica mandaria o gestor abrir chamado
 *    por um sistema que está funcionando exatamente como projetado.
 *
 * ## COMO CADA CASO FALHA (conferido, não afirmado)
 *
 *  - tire o bloco `OQueVaiAcontecer` do formulário → caem os três primeiros;
 *  - troque o texto condicional por "e a bancada, se for oficina" → cai o de
 *    número quatro, que é justamente o que cobra a promessa exata;
 *  - deixe de limpar `senha` depois de criar, ou guarde a credencial fora do
 *    estado do componente → cai "a senha some e não volta";
 *  - apague a frase do `mustChangePassword` → cai o caso da troca obrigatória;
 *  - trate o 403 como erro genérico → cai o último.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import EmpresasPage from '../EmpresasPage';

const EMPRESAS = [
  {
    id: 'c1',
    slug: 'sampaio-centro',
    legalName: 'Sampaio Comércio de Motos Ltda',
    tradeName: 'Sampaio Centro',
    cnpj: '11222333000181',
    kind: 'retail',
    active: true,
  },
  {
    id: 'c2',
    slug: 'oficina-mobilidade',
    legalName: 'Sampaio Serviços de Mobilidade Ltda',
    tradeName: 'Oficina Mobilidade',
    cnpj: null,
    kind: 'workshop',
    active: true,
  },
];

/** A resposta de `POST /core/companies` — sem a senha, que nunca volta. */
const CRIADA = {
  company: {
    id: 'c7',
    slug: 'sampaio-litoral',
    legalName: 'Sampaio Litoral Comércio Ltda',
    tradeName: 'Sampaio Litoral',
    cnpj: null,
    kind: 'workshop',
    active: true,
  },
  workshop: { id: 'w7', slug: 'oficina-sampaio-litoral', name: 'Oficina Sampaio Litoral' },
  manager: {
    id: 'u7',
    login: 'maria.litoral',
    displayName: 'Maria Sampaio',
    email: null,
    profileCode: 'gerente_oficina',
    active: true,
    mustChangePassword: true,
    lastLoginAt: null,
    createdAt: '2026-08-18T10:00:00.000Z',
    workshops: [],
  },
  linkedGroupAdmins: ['u1', 'u2'],
};

let enviados: unknown[] = [];
let posts = 0;

function servidor(opcoes: {
  lista?: { status?: number; body: unknown };
  criacao?: { status?: number; body: unknown };
} = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: { method?: string; body?: string }) => {
      const metodo = (init?.method ?? 'GET').toUpperCase();
      if (metodo === 'POST') {
        posts += 1;
        enviados.push(init?.body ? JSON.parse(init.body) : null);
        const r = opcoes.criacao ?? { body: CRIADA };
        return new Response(JSON.stringify(r.body), {
          status: r.status ?? 201,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const r = opcoes.lista ?? { body: { items: EMPRESAS } };
      return new Response(JSON.stringify(r.body), {
        status: r.status ?? 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
}

function montar() {
  render(
    <MemoryRouter>
      <EmpresasPage />
    </MemoryRouter>,
  );
}

/**
 * O texto do aviso, inteiro e normalizado.
 *
 * `getByText` compara só os nós de texto DIRETOS de cada elemento, e este
 * aviso é uma frase costurada com `<strong>` no meio — "Cria o **primeiro
 * gerente**, com o login **x**". Procurar a frase com `getByText` acharia os
 * pedaços e nunca a frase, e um teste que confere pedaços passa com a frase
 * remontada errada. Aqui se lê o bloco como quem está na frente da tela lê.
 *
 * Continua ESCOPADO ao aviso: a frase tem de estar antes do botão, e não
 * perdida em qualquer canto da página.
 */
function avisoDoBotao(): string {
  const titulo = screen.getByText('O que este botão faz');
  return (titulo.parentElement?.textContent ?? '').replace(/\s+/g, ' ');
}

const campo = (rotulo: RegExp) => screen.getByLabelText(rotulo) as HTMLInputElement;
const seletorDeTipo = () => screen.getByLabelText(/Tipo de operação/) as HTMLSelectElement;
const botaoCriar = () => screen.getByRole('button', { name: /Criar empresa e primeiro gerente/ });

/** Preenche o mínimo que a tela exige para deixar o botão clicável. */
function preencher(tipo: 'retail' | 'workshop' = 'workshop') {
  fireEvent.change(campo(/Razão social/), {
    target: { value: 'Sampaio Litoral Comércio Ltda' },
  });
  fireEvent.change(campo(/Nome fantasia/), { target: { value: 'Sampaio Litoral' } });
  fireEvent.change(seletorDeTipo(), { target: { value: tipo } });
  fireEvent.change(campo(/Nome de quem vai gerenciar/), { target: { value: 'Maria Sampaio' } });
  fireEvent.change(campo(/^Login/), { target: { value: 'maria.litoral' } });
  fireEvent.change(campo(/Senha provisória/), { target: { value: 'trocaEm5minutos' } });
}

beforeEach(() => {
  enviados = [];
  posts = 0;
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

// ---------------------------------------------------------------------------
// 1. A TELA DIZ O QUE A CRIAÇÃO FAZ, ANTES DE FAZER
// ---------------------------------------------------------------------------

describe('a tela avisa o que vai acontecer antes de qualquer clique', () => {
  it('as três consequências estão na tela sem nada ter sido criado', async () => {
    servidor();
    montar();

    await waitFor(() => expect(screen.getByText('O que este botão faz')).toBeTruthy());

    // A EMPRESA.
    expect(avisoDoBotao()).toContain('Cria a empresa');
    // O LOGIN — a consequência que ninguém espera, e a razão do aviso existir.
    expect(avisoDoBotao()).toContain('Cria o primeiro gerente');
    expect(avisoDoBotao()).toContain(
      'Você sai desta tela com um login novo para entregar a alguém',
    );
    // E a promessa de que nada acontece pela metade.
    expect(screen.getByText(/se qualquer passo falhar, nada é criado/)).toBeTruthy();

    // Nada foi criado só por abrir a tela — o aviso é ANTES, não um relatório.
    expect(posts).toBe(0);
  });

  it('a bancada só é prometida quando o tipo escolhido é oficina', async () => {
    servidor();
    montar();
    await waitFor(() => expect(seletorDeTipo()).toBeTruthy());

    // Loja é o padrão: a tela diz explicitamente que NÃO haverá bancada, em vez
    // de simplesmente omitir — omissão deixa a dúvida de pé.
    expect(avisoDoBotao()).toContain('Não cria bancada: loja não tem oficina');
    expect(avisoDoBotao()).not.toContain('Cria a primeira bancada');

    fireEvent.change(seletorDeTipo(), { target: { value: 'workshop' } });

    // Agora sim, e com o motivo: gerente de oficina sem bancada entra e não vê
    // ordem de serviço nenhuma.
    expect(avisoDoBotao()).toContain('Cria a primeira bancada');
    expect(avisoDoBotao()).toContain('não vê ordem de serviço nenhuma');
    expect(avisoDoBotao()).not.toContain('loja não tem oficina');
  });

  it('o aviso nomeia a operação e o login que estão sendo digitados', async () => {
    servidor();
    montar();
    await waitFor(() => expect(screen.getByText('O que este botão faz')).toBeTruthy());

    fireEvent.change(campo(/Nome fantasia/), { target: { value: 'Sampaio Litoral' } });
    fireEvent.change(campo(/^Login/), { target: { value: 'maria.litoral' } });

    // Um aviso genérico é lido como boilerplate. Com o nome e o login dentro,
    // ele vira a conferência final de quem está prestes a clicar.
    expect(avisoDoBotao()).toContain('Cria a empresa Sampaio Litoral');
    expect(avisoDoBotao()).toContain('com o login maria.litoral');
  });
});

// ---------------------------------------------------------------------------
// 2. A SENHA APARECE UMA VEZ, E A TELA DIZ QUE NÃO VOLTA
// ---------------------------------------------------------------------------

describe('a senha provisória aparece uma única vez', () => {
  it('depois de criar, a tela mostra login e senha e avisa que ela não volta', async () => {
    servidor();
    montar();
    await waitFor(() => expect(botaoCriar()).toBeTruthy());

    preencher();
    fireEvent.click(botaoCriar());

    await waitFor(() => expect(posts).toBe(1));

    // A senha digitada, ao lado do login: é este par que vai ser entregue.
    await waitFor(() => expect(screen.getByText('trocaEm5minutos')).toBeTruthy());
    expect(screen.getByText('maria.litoral')).toBeTruthy();

    // E a frase que impede o desfecho ruim: sem ela, quem fechar a aba perde a
    // única cópia sem saber que era a única.
    expect(screen.getByText(/aparece uma única vez e não volta/)).toBeTruthy();
    expect(screen.getByText(/O servidor guarda só o embaralhado dela/)).toBeTruthy();
  });

  /**
   * O caso mudou de lado, e a mudança é a lição.
   *
   * Ele cobrava a frase "o sistema vai exigir a troca no primeiro acesso" — e a
   * frase era falsa. `must_change_password = 1` é gravado, atravessa até a
   * tela, e NENHUM passo do login o consulta: entrar com a senha provisória
   * devolve token completo e dá para vender no mesmo minuto. Foi medido
   * fazendo exatamente isso.
   *
   * O teste ligava a frase ao campo que o servidor devolve — o que é um bom
   * princípio — e concluía dali que a exigência existia. Ligar-se ao dado certo
   * não torna verdadeira a frase construída sobre ele.
   *
   * Agora ele cobra o contrário: que a tela diga que o sistema NÃO força, e
   * peça a troca a quem administra.
   */
  it('a tela avisa que o sistema NÃO força a troca — porque não força mesmo', async () => {
    servidor();
    montar();
    await waitFor(() => expect(botaoCriar()).toBeTruthy());

    preencher();
    fireEvent.click(botaoCriar());

    // O "não" está dentro de um <strong>, então o texto chega quebrado em
    // fragmentos — o matcher pega o pedaço contíguo depois dele.
    await waitFor(() =>
      expect(screen.getByText(/força a troca no primeiro acesso/i)).toBeTruthy(),
    );
    // E não sobrou a promessa antiga em lugar nenhum do quadro.
    expect(screen.queryByText(/o sistema vai exigir/i)).toBeNull();
  });

  it('o servidor que NÃO exige troca não faz a tela prometer troca', async () => {
    servidor({
      criacao: { body: { ...CRIADA, manager: { ...CRIADA.manager, mustChangePassword: false } } },
    });
    montar();
    await waitFor(() => expect(botaoCriar()).toBeTruthy());

    preencher();
    fireEvent.click(botaoCriar());

    await waitFor(() => expect(screen.getByText('trocaEm5minutos')).toBeTruthy());
    expect(screen.queryByText(/vai exigir que Maria Sampaio troque/i)).toBeNull();
  });

  it('dispensada, a senha some da tela e não há caminho de volta', async () => {
    servidor();
    montar();
    await waitFor(() => expect(botaoCriar()).toBeTruthy());

    preencher();
    fireEvent.click(botaoCriar());
    await waitFor(() => expect(screen.getByText('trocaEm5minutos')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /Já anotei, esconder a senha/ }));

    // Sumiu do quadro...
    expect(screen.queryByText('trocaEm5minutos')).toBeNull();
    // ...e do formulário, que foi esvaziado na criação. Se o campo tivesse
    // ficado preenchido, "aparece uma vez" seria falso — e o segundo clique
    // criaria uma segunda empresa quase idêntica.
    expect(campo(/Senha provisória/).value).toBe('');
    expect(campo(/^Login/).value).toBe('');
    expect(campo(/Razão social/).value).toBe('');
  });

  it('a senha não é mandada de volta pelo servidor nem guardada no navegador', async () => {
    servidor();
    montar();
    await waitFor(() => expect(botaoCriar()).toBeTruthy());

    preencher();
    fireEvent.click(botaoCriar());
    await waitFor(() => expect(posts).toBe(1));

    // A resposta dublada não traz senha alguma — a tela mostra a que ela mesma
    // tem em memória. E nada disso encosta no armazenamento do navegador: uma
    // senha provisória sobrevivendo ao fechamento da aba é uma senha esquecida
    // num computador compartilhado.
    expect(JSON.stringify(CRIADA)).not.toContain('trocaEm5minutos');
    expect(JSON.stringify(localStorage)).not.toContain('trocaEm5minutos');
  });

  it('o corpo enviado não escolhe empresa nem usuário', async () => {
    servidor();
    montar();
    await waitFor(() => expect(botaoCriar()).toBeTruthy());

    preencher();
    fireEvent.click(botaoCriar());
    await waitFor(() => expect(enviados).toHaveLength(1));

    const corpo = enviados[0] as Record<string, unknown>;
    // O escopo vem da sessão, no servidor. Mandar `companyId` daqui sugeriria
    // que a tela escolhe o tenant — foi por um campo desses que a rota
    // fantasma de `organizations` vazava.
    expect(corpo.companyId).toBeUndefined();
    expect(corpo.userId).toBeUndefined();
    expect((corpo.manager as Record<string, unknown>).password).toBe('trocaEm5minutos');
  });
});

// ---------------------------------------------------------------------------
// 3. A LISTA DO GRUPO
// ---------------------------------------------------------------------------

describe('a lista mostra as operações do grupo', () => {
  it('cada empresa aparece com nome, endereço, CNPJ e tipo', async () => {
    servidor();
    montar();

    await waitFor(() => expect(screen.getByText('Sampaio Centro')).toBeTruthy());
    expect(screen.getByText('Oficina Mobilidade')).toBeTruthy();
    // O endereço da vitrine: o servidor deriva do nome e pode acrescentar
    // sufixo, então quem abriu precisa ver qual saiu.
    expect(screen.getByText('/sampaio-centro')).toBeTruthy();
    // CNPJ legível, e não catorze dígitos colados.
    expect(screen.getByText('11.222.333/0001-81')).toBeTruthy();
    // Sem CNPJ é um travessão, não uma célula vazia que parece defeito.
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
    // 'Loja' e 'Oficina' também são as opções do seletor logo abaixo — o que se
    // cobra aqui é o selo da LINHA, dentro da tabela.
    const tabela = screen.getByRole('table');
    expect(within(tabela).getByText('Loja')).toBeTruthy();
    expect(within(tabela).getByText('Oficina')).toBeTruthy();
  });

  it('a criação recarrega a lista em vez de mentir sobre o que existe', async () => {
    servidor();
    montar();
    await waitFor(() => expect(botaoCriar()).toBeTruthy());

    preencher();
    fireEvent.click(botaoCriar());

    // Duas leituras DA LISTA: a de abertura e a de depois da criação. Emendar a
    // empresa nova na lista local mostraria o que a TELA acha que aconteceu, e
    // não o que o servidor gravou. (A tela também lê a situação da implantação
    // de cada empresa — GAP-PRD-067 —, que não é a lista e não conta aqui.)
    await waitFor(() => {
      const chamadas = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
      const leituras = chamadas.filter(
        (c) =>
          ((c[1] as { method?: string })?.method ?? 'GET').toUpperCase() === 'GET'
          && String(c[0]).endsWith('/core/companies'),
      );
      expect(leituras.length).toBe(2);
    });
  });

  it('403 se identifica como permissão, não como falha de carregamento', async () => {
    servidor({
      lista: {
        status: 403,
        body: { error: { code: 'API_PERMISSION_DENIED', message: 'Permissão negada.' } },
      },
    });
    montar();

    await waitFor(() =>
      expect(screen.getByText(/Só quem responde pelo grupo/)).toBeTruthy(),
    );
    // "Falha ao carregar" faria o gestor abrir chamado por um sistema que está
    // funcionando exatamente como projetado.
    expect(screen.getByText(/Lista não carregada/)).toBeTruthy();
  });

  it('o erro da criação diz que nada foi criado', async () => {
    servidor({
      criacao: {
        status: 409,
        body: { error: { code: 'CORE_LOGIN_TAKEN', message: 'Já existe um usuário com este login.' } },
      },
    });
    montar();
    await waitFor(() => expect(botaoCriar()).toBeTruthy());

    preencher();
    fireEvent.click(botaoCriar());

    await waitFor(() =>
      expect(screen.getByText('Já existe um usuário com este login.')).toBeTruthy(),
    );
    // E o quadro da credencial NÃO aparece: nenhuma senha foi criada, e mostrar
    // uma faria alguém sair daqui com um login que não existe.
    expect(screen.queryByText('trocaEm5minutos')).toBeNull();
    // O formulário continua preenchido — quem errou o login corrige o login, e
    // não redigita a empresa inteira.
    expect(campo(/Razão social/).value).toBe('Sampaio Litoral Comércio Ltda');
  });
});
