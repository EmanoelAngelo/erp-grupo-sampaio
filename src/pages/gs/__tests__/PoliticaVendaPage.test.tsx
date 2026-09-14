/**
 * A TELA DA POLÍTICA DO BALCÃO.
 *
 * ## O que não pode errar, e por quê
 *
 * 1. CAMPO VAZIO NÃO É ZERO. Vazio é "o padrão do sistema"; zero, no limite de
 *    desconto, é "nenhuma concessão sem gestor" — a decisão OPOSTA. Se a tela
 *    mandasse zero no lugar de nulo, o dono que apagasse um campo travaria o
 *    balcão inteiro sem ter pedido nada.
 *
 * 2. O CAMPO NÃO CONFIGURADO APARECE EM BRANCO. Preenchê-lo com o padrão
 *    apagaria a distinção entre "eu escolhi 10" e "ninguém configurou". É o
 *    `definidos` do servidor que permite mostrar a diferença — e um `definidos`
 *    que nenhuma tela lê é campo sem leitor.
 *
 * 3. A RECUSA DE PERMISSÃO SE IDENTIFICA. 403 mostrado como "falha ao
 *    carregar" faz a pessoa chamar o suporte por um sistema que está
 *    funcionando exatamente como deveria.
 *
 * 4. O ERRO DE DIGITAÇÃO CHEGA AO SERVIDOR COMO ERRO. Este é o que quase
 *    passou: a tela mandava `Number.NaN` para o que não era número, contando
 *    que o servidor recusasse — e `JSON.stringify({a: NaN})` produz
 *    `{"a":null}`. Nulo, do outro lado, é a decisão OPOSTA: "volta ao padrão do
 *    sistema". Quem digitasse "dez" no lugar de 10 tinha a gravação ACEITA e o
 *    limite de volta aos 10% do sistema. A trava falhava aberta.
 *
 *    Por isso os testes deste bloco olham o CORPO DA REQUISIÇÃO, e não a tela.
 *    Um teste que dubla o 400 e confere a mensagem — como o daqui debaixo
 *    fazia sozinho — fica verde com o fio quebrado, porque o servidor dublado
 *    responde o que se mandou ele responder. O que prova é o que sai no fio.
 *
 * Cada teste falha quando o guarda sai: troque `''` por `0` no envio e o
 * primeiro cai; preencha o campo com o valor efetivo e o segundo cai; trate o
 * 403 como erro genérico e o terceiro cai; volte a converter em
 * `paraOServidor` (qualquer conversão: `Number.NaN`, `?? 0`, `|| null`) e os
 * quatro do bloco do fio caem.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import PoliticaVendaPage from '../PoliticaVendaPage';

/**
 * Ninguém configurou nada: os três números são o padrão do sistema, e a
 * sangria não tem teto.
 *
 * O quarto campo é `null` e NÃO tem padrão para herdar — por isso ele não
 * entra na contagem de "padrão do sistema" logo abaixo. Ver o bloco próprio
 * dele no fim do arquivo.
 */
const NADA_CONFIGURADO = {
  discountLimitPercent: 10,
  creditSaleDueDays: 0,
  reservationValidDays: 7,
  cashWithdrawalLimitCents: null,
  definidos: {
    discountLimitPercent: false,
    creditSaleDueDays: false,
    reservationValidDays: false,
    cashWithdrawalLimitCents: false,
  },
};

/** O dono escolheu 5% e 30 dias de fiado; a validade continua no padrão. */
const ESCOLHIDO = {
  discountLimitPercent: 5,
  creditSaleDueDays: 30,
  reservationValidDays: 7,
  cashWithdrawalLimitCents: null,
  definidos: {
    discountLimitPercent: true,
    creditSaleDueDays: true,
    reservationValidDays: false,
    cashWithdrawalLimitCents: false,
  },
};

/** A operação que travou a gaveta em R$ 500,00 por sangria. */
const COM_TETO_DE_SANGRIA = {
  ...ESCOLHIDO,
  cashWithdrawalLimitCents: 50000,
  definidos: { ...ESCOLHIDO.definidos, cashWithdrawalLimitCents: true },
};

let enviados: unknown[] = [];

function servidor(opcoes: {
  get?: { status?: number; body: unknown };
  put?: (corpo: unknown) => { status?: number; body: unknown };
}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: { method?: string; body?: string }) => {
      const metodo = (init?.method ?? 'GET').toUpperCase();
      if (metodo === 'GET') {
        const r = opcoes.get ?? { body: NADA_CONFIGURADO };
        return new Response(JSON.stringify(r.body), {
          status: r.status ?? 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const corpo = init?.body ? JSON.parse(init.body) : null;
      enviados.push(corpo);
      const r = opcoes.put ? opcoes.put(corpo) : { body: NADA_CONFIGURADO };
      return new Response(JSON.stringify(r.body), {
        status: r.status ?? 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
}

beforeEach(() => {
  enviados = [];
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function montar() {
  render(
    <MemoryRouter>
      <PoliticaVendaPage />
    </MemoryRouter>,
  );
}

const campoLimite = () =>
  screen.getByLabelText(/Desconto que o caixa dá sem chamar gestor/) as HTMLInputElement;

const campoTeto = () =>
  screen.getByLabelText(/Sangria que o caixa faz sem chamar gestor/) as HTMLInputElement;

describe('vazio é o padrão do sistema, e a tela mostra a diferença', () => {
  it('sem nada configurado o campo fica EM BRANCO e o rótulo diz de onde vem o número', async () => {
    servidor({ get: { body: NADA_CONFIGURADO } });
    montar();

    await waitFor(() => expect(campoLimite()).toBeTruthy());
    // O campo vazio é o que distingue omissão de escolha. Preenchido com "10",
    // o dono não saberia se configurou ou herdou.
    expect(campoLimite().value).toBe('');
    // E o valor que VALE aparece assim mesmo, com a etiqueta da origem.
    expect(screen.getAllByText('padrão do sistema').length).toBe(3);
  });

  it('o que o dono escolheu aparece preenchido e etiquetado como escolha dele', async () => {
    servidor({ get: { body: ESCOLHIDO } });
    montar();

    await waitFor(() => expect(campoLimite().value).toBe('5'));
    expect(screen.getAllByText('definido por você').length).toBe(2);
    // A validade continua herdada: as etiquetas não são todas iguais, e é isso
    // que faz a tela útil.
    expect(screen.getAllByText('padrão do sistema').length).toBe(1);
  });
});

/**
 * O que o servidor RECEBE, que é o único lugar onde este defeito aparece.
 *
 * `JSON.parse(JSON.stringify(...))` já aconteceu quando o corpo chega aqui: é
 * exatamente por isso que os casos abaixo se olham no corpo, e não na tela.
 */
function limiteEnviado(): unknown {
  return (enviados[0] as { discountLimitPercent: unknown }).discountLimitPercent;
}

describe('o campo chega ao servidor DISTINGUÍVEL — vazio, zero e lixo são três coisas', () => {
  it('campo esvaziado vai como texto vazio: "volta ao padrão", nunca zero', async () => {
    servidor({ get: { body: ESCOLHIDO }, put: () => ({ body: NADA_CONFIGURADO }) });
    montar();

    await waitFor(() => expect(campoLimite().value).toBe('5'));
    fireEvent.change(campoLimite(), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /Salvar política/ }));

    await waitFor(() => expect(enviados).toHaveLength(1));
    // ZERO aqui significaria "nenhuma concessão sem gestor" e travaria o
    // balcão. Vazio significa "volta aos 10% do sistema" — e o servidor lê
    // string vazia e nulo como a mesma coisa, de propósito.
    expect(limiteEnviado()).toBe('');
  });

  it('ZERO digitado continua sendo zero — é decisão legítima, e oposta', async () => {
    servidor({ get: { body: NADA_CONFIGURADO }, put: () => ({ body: NADA_CONFIGURADO }) });
    montar();

    await waitFor(() => expect(campoLimite()).toBeTruthy());
    fireEvent.change(campoLimite(), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: /Salvar política/ }));

    await waitFor(() => expect(enviados).toHaveLength(1));
    // '0' e '' são dois caracteres diferentes no fio, e é essa diferença que
    // separa "trava tudo" de "usa o padrão".
    expect(limiteEnviado()).toBe('0');
    expect(limiteEnviado()).not.toBe('');
  });

  it('"dez" chega COMO "dez", e não como o nulo que abriria o balcão', async () => {
    servidor({
      get: { body: NADA_CONFIGURADO },
      put: () => ({
        status: 400,
        body: {
          error: {
            code: 'CORE_SALE_POLICY_INVALID',
            message: 'Limite de desconto: informe um número.',
          },
        },
      }),
    });
    montar();

    await waitFor(() => expect(campoLimite()).toBeTruthy());
    fireEvent.change(campoLimite(), { target: { value: 'dez' } });
    fireEvent.click(screen.getByRole('button', { name: /Salvar política/ }));

    await waitFor(() => expect(enviados).toHaveLength(1));
    /*
      O CORAÇÃO DESTA RODADA, em uma asserção.

      Com `Number.NaN` no lugar do texto, isto chegava `null` — e nulo é
      "volta ao padrão do sistema". O dono errava a digitação e o limite
      SUBIA de volta para 10% com a gravação aceita. Nulo aqui é falha aberta,
      não é campo em branco.
    */
    expect(limiteEnviado()).toBe('dez');
    expect(limiteEnviado()).not.toBeNull();
    // E a pessoa lê a recusa do servidor, com o texto dele.
    await screen.findByText(/informe um número/);
  });

  it('"5,5" chega inteiro — quem decide se decimal vale é o servidor', async () => {
    servidor({ get: { body: NADA_CONFIGURADO }, put: () => ({ body: ESCOLHIDO }) });
    montar();

    await waitFor(() => expect(campoLimite()).toBeTruthy());
    fireEvent.change(campoLimite(), { target: { value: '5,5' } });
    fireEvent.click(screen.getByRole('button', { name: /Salvar política/ }));

    await waitFor(() => expect(enviados).toHaveLength(1));
    // A vírgula do teclado brasileiro atravessa: é `numeroOuPadrao`, no
    // servidor, que a troca por ponto — e é lá que mora a régua de "percentual
    // aceita decimal, dia não". Normalizar aqui criaria a segunda régua.
    expect(limiteEnviado()).toBe('5,5');
  });

  it('"-3" chega negativo, para o servidor recusar por faixa', async () => {
    servidor({
      get: { body: NADA_CONFIGURADO },
      put: () => ({
        status: 400,
        body: {
          error: {
            code: 'CORE_SALE_POLICY_INVALID',
            message: 'Limite de desconto: o valor precisa estar entre 0 e 100.',
          },
        },
      }),
    });
    montar();

    await waitFor(() => expect(campoLimite()).toBeTruthy());
    fireEvent.change(campoLimite(), { target: { value: '-3' } });
    fireEvent.click(screen.getByRole('button', { name: /Salvar política/ }));

    await waitFor(() => expect(enviados).toHaveLength(1));
    // Um `Math.max(0, ...)` na tela transformaria isto em zero — que é a
    // decisão mais dura que existe aqui ("nenhuma concessão sem gestor"),
    // tomada por engano em cima de um sinal de menos.
    expect(limiteEnviado()).toBe('-3');
    await screen.findByText(/precisa estar entre 0 e 100/);
  });
});

describe('o que ficou valendo volta para a tela', () => {
  it('o aviso repete o que FICOU VALENDO, lido da resposta', async () => {
    servidor({ get: { body: NADA_CONFIGURADO }, put: () => ({ body: ESCOLHIDO }) });
    montar();

    await waitFor(() => expect(campoLimite()).toBeTruthy());
    fireEvent.change(campoLimite(), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: /Salvar política/ }));

    // Se um dia a gravação divergir do que foi digitado, é a tela que denuncia.
    await screen.findByText(/concede até 5% sem gestor/);
  });
});

describe('a recusa do servidor se identifica', () => {
  it('403 diz que a decisão não é do balcão, e não "falha ao carregar"', async () => {
    servidor({
      get: {
        status: 403,
        body: { error: { code: 'API_PERMISSION_DENIED', message: 'Permissão negada.' } },
      },
    });
    montar();

    await screen.findByText(/Seu perfil não edita a política comercial/);
    // E o formulário some: oferecer campos que o servidor vai recusar é
    // convidar a pessoa a digitar para nada.
    expect(screen.queryByLabelText(/Desconto que o caixa dá/)).toBeNull();
  });

  it('a mensagem do servidor aparece quando a recusa é do VALOR', async () => {
    servidor({
      get: { body: NADA_CONFIGURADO },
      put: () => ({
        status: 400,
        body: {
          error: {
            code: 'CORE_SALE_POLICY_INVALID',
            message: 'Limite de desconto: informe um número, ou deixe em branco para usar o padrão do sistema.',
          },
        },
      }),
    });
    montar();

    await waitFor(() => expect(campoLimite()).toBeTruthy());
    fireEvent.change(campoLimite(), { target: { value: 'dez' } });
    fireEvent.click(screen.getByRole('button', { name: /Salvar política/ }));

    // `Number('dez')` é NaN, e NaN > limite é FALSE: converter para zero na
    // tela abriria o balcão em cima de um erro de digitação. Quem recusa é o
    // servidor, e é o texto dele que a pessoa lê.
    await screen.findByText(/informe um número/);
  });
});

/**
 * O TETO DA SANGRIA — o quarto campo, e o único sem padrão de sistema.
 *
 * ## Por que ele merece um bloco só, e não mais um caso no de cima
 *
 * Nos outros três, vazio HERDA um número: 10%, 0 dias, 7 dias. Aqui vazio é
 * AUSÊNCIA DE TRAVA — o operador tira da gaveta o que quiser, até zerar, e a
 * única testemunha é o movimento que ele mesmo lançou.
 *
 * A tela mostra os quatro campos no mesmo molde, um embaixo do outro, e é esse
 * molde que produz a leitura errada: o dono vê três campos em branco
 * funcionando como "o sistema decide por mim" e conclui, por analogia, que a
 * gaveta também tem um limite decidido por alguém. Não tem. Um campo em branco
 * calado, ao lado de três campos em branco que significam outra coisa, é a
 * tela mentindo por omissão.
 *
 * Por isso o que se cobra aqui é TEXTO NA TELA, e não só o valor do input: a
 * palavra "sem teto" É o recurso desta rodada. Tire a frase e o campo continua
 * vazio, o formulário continua salvando, a suíte continua verde — e o dono
 * continua achando que existe um limite que ele não vê.
 *
 * Cada teste falha quando o guarda sai: troque "Sem teto" pelo `ValorVigente`
 * genérico e o primeiro cai; converta o campo para número na tela e o quarto
 * cai; deixe de comparar o que foi pedido com o que voltou e o penúltimo cai.
 */
describe('o teto da sangria: vazio é SEM TETO, e não um padrão escondido', () => {
  it('sem teto configurado a tela DIZ "sem teto" — o campo vazio não se explica sozinho', async () => {
    servidor({ get: { body: NADA_CONFIGURADO } });
    montar();

    await waitFor(() => expect(campoTeto()).toBeTruthy());
    expect(campoTeto().value).toBe('');

    /*
      O CORAÇÃO DESTE BLOCO.

      Vazio aqui não é "o sistema usa um padrão", é "não há trava nenhuma". A
      frase e a etiqueta de aviso são o que separa as duas leituras — e é a
      diferença entre o dono saber que a decisão está em aberto e ele supor uma
      proteção que nunca existiu.
    */
    expect(screen.getByText('Sem teto')).toBeTruthy();
    expect(screen.getByText('a gaveta não tem limite')).toBeTruthy();

    // E ele NÃO entra na contagem de "padrão do sistema": não há padrão para
    // herdar. Continuam sendo três, como antes deste campo existir.
    expect(screen.getAllByText('padrão do sistema').length).toBe(3);
  });

  it('a dica ao lado do campo diz, em palavras, que vazio não é zero nem padrão', async () => {
    servidor({ get: { body: NADA_CONFIGURADO } });
    montar();

    await waitFor(() => expect(campoTeto()).toBeTruthy());
    // Zero é a decisão OPOSTA — toda sangria chama o gestor. As duas pontas da
    // régua estão separadas por um caractere, e a tela precisa dizer isso.
    await screen.findByText(/é SEM TETO/);
    await screen.findByText(/Zero é o oposto: toda sangria chama o gestor/);
  });

  it('o teto configurado aparece em REAIS, e não nos centavos que o banco guarda', async () => {
    servidor({ get: { body: COM_TETO_DE_SANGRIA } });
    montar();

    // 50000 centavos viram "500,00" no campo. Mostrar 50000 aqui seria o erro
    // de cem vezes na cara do dono — o mesmo que o servidor evitou pondo a
    // unidade no nome do parâmetro.
    await waitFor(() => expect(campoTeto().value).toBe('500,00'));
    // E a ausência de teto some da tela quando existe um.
    expect(screen.queryByText('Sem teto')).toBeNull();
    expect(screen.queryByText('a gaveta não tem limite')).toBeNull();
  });

  it('campo esvaziado vai como texto vazio — "tira a trava", nunca "0"', async () => {
    servidor({ get: { body: COM_TETO_DE_SANGRIA }, put: () => ({ body: NADA_CONFIGURADO }) });
    montar();

    await waitFor(() => expect(campoTeto().value).toBe('500,00'));
    fireEvent.change(campoTeto(), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /Salvar política/ }));

    await waitFor(() => expect(enviados).toHaveLength(1));
    const corpo = enviados[0] as { cashWithdrawalLimitReais: unknown };
    /*
      Vazio é "tira a trava"; ZERO seria "toda sangria chama o gestor" — a
      decisão mais dura que este campo permite. Colapsar um no outro no meio do
      caminho é o defeito que o limite de desconto já pagou caro: uma trava que
      muda sozinha porque o fio não sabia distinguir três estados.
    */
    expect(corpo.cashWithdrawalLimitReais).toBe('');
    expect(corpo.cashWithdrawalLimitReais).not.toBe('0');
    expect(corpo.cashWithdrawalLimitReais).not.toBeNull();
  });

  it('"500,00" atravessa com a vírgula — quem tem a régua é o servidor', async () => {
    servidor({ get: { body: NADA_CONFIGURADO }, put: () => ({ body: COM_TETO_DE_SANGRIA }) });
    montar();

    await waitFor(() => expect(campoTeto()).toBeTruthy());
    fireEvent.change(campoTeto(), { target: { value: '500,00' } });
    fireEvent.click(screen.getByRole('button', { name: /Salvar política/ }));

    await waitFor(() => expect(enviados).toHaveLength(1));
    // Converter aqui — para centavos, ou para número — criaria a segunda régua
    // sobre o mesmo valor, e é onde o erro de cem vezes nasce.
    expect(
      (enviados[0] as { cashWithdrawalLimitReais: unknown }).cashWithdrawalLimitReais,
    ).toBe('500,00');
    // E o que FICOU VALENDO volta para a tela, lido da resposta.
    await screen.findByText(/a sangria vai até/);
  });

  it('"quinhentos" chega COMO "quinhentos", e o servidor é quem recusa', async () => {
    servidor({
      get: { body: NADA_CONFIGURADO },
      put: () => ({
        status: 400,
        body: {
          error: {
            code: 'CORE_SALE_POLICY_INVALID',
            message: 'Teto da sangria: informe um número, ou deixe em branco para usar o padrão do sistema.',
          },
        },
      }),
    });
    montar();

    await waitFor(() => expect(campoTeto()).toBeTruthy());
    fireEvent.change(campoTeto(), { target: { value: 'quinhentos' } });
    fireEvent.click(screen.getByRole('button', { name: /Salvar política/ }));

    await waitFor(() => expect(enviados).toHaveLength(1));
    /*
      Nulo aqui significaria "sem teto" — a trava REMOVIDA por um erro de
      digitação, em silêncio. É o mesmo modo de falha do limite de desconto, e
      neste campo ele é ainda mais direto: o dono tenta apertar a gaveta e
      acaba abrindo-a.
    */
    expect(
      (enviados[0] as { cashWithdrawalLimitReais: unknown }).cashWithdrawalLimitReais,
    ).toBe('quinhentos');
    await screen.findByText(/Teto da sangria: informe um número/);
  });

  it('teto pedido que volta VAZIO é denunciado — a decisão não some calada', async () => {
    /*
      O DEFEITO REAL QUE ESTE TESTE COBRE, e ele está no servidor.

      `PUT /core/sale-policies` monta a chamada a `salvarPolitica` nomeando três
      campos um a um e NÃO repassa `cashWithdrawalLimitReais`. O serviço aceita
      o parâmetro; a rota não o entrega. O valor viaja no fio, é ignorado, e a
      coluna é gravada como nula — que é exatamente o corpo dublado aqui.

      Sem esta denúncia o dono digita 500, salva, vê "Pronto" em verde e o campo
      VAZIO logo abaixo. Ele conclui que errou a digitação, tenta de novo, e o
      resultado é o mesmo. A gaveta segue sem trava enquanto ele acredita
      tê-la fechado — é assim que uma configuração vira uma crença.

      Quando a rota passar a repassar o campo, este teste continua valendo: ele
      cobra a CONFERÊNCIA (pedi teto, voltou sem teto), e não o defeito.
    */
    servidor({ get: { body: NADA_CONFIGURADO }, put: () => ({ body: NADA_CONFIGURADO }) });
    montar();

    await waitFor(() => expect(campoTeto()).toBeTruthy());
    fireEvent.change(campoTeto(), { target: { value: '500,00' } });
    fireEvent.click(screen.getByRole('button', { name: /Salvar política/ }));

    await screen.findByText(/O teto da sangria NÃO foi gravado/);
    // E a tela manda não confiar no limite — o oposto de um "Pronto" verde
    // sozinho, que é o que ela mostraria sem a conferência.
    await screen.findByText(/não confie neste limite ainda/);
  });

  it('quem NÃO pediu teto não recebe denúncia — o aviso é sobre divergência, não sobre nulo', async () => {
    servidor({ get: { body: NADA_CONFIGURADO }, put: () => ({ body: NADA_CONFIGURADO }) });
    montar();

    await waitFor(() => expect(campoLimite()).toBeTruthy());
    fireEvent.change(campoLimite(), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: /Salvar política/ }));

    await screen.findByText(/a sangria não tem teto/);
    // Sem esta linha o aviso dispararia em toda gravação de quem nunca quis
    // teto — e um alerta que aparece sempre é um alerta que ninguém lê.
    expect(screen.queryByText(/NÃO foi gravado/)).toBeNull();
  });
});

// ============================================================================

describe('faturar OS a prazo (GAP-PRD-104)', () => {
  const caixa = () => screen.getByRole('checkbox', { name: 'Faturar OS a prazo' }) as HTMLInputElement;

  it('nasce desmarcado — o padrão seguro — e marcar manda o booleano de verdade', async () => {
    servidor({
      get: { body: NADA_CONFIGURADO },
      put: () => ({
        body: {
          ...NADA_CONFIGURADO,
          workshopCreditEnabled: true,
          definidos: { ...NADA_CONFIGURADO.definidos, workshopCreditEnabled: true },
        },
      }),
    });
    montar();

    await waitFor(() => expect(caixa().checked).toBe(false));
    fireEvent.click(caixa());
    fireEvent.click(screen.getByRole('button', { name: /Salvar política/ }));

    await waitFor(() => expect(enviados).toHaveLength(1));
    // Booleano, e não texto: o servidor recusa "sim" em texto.
    expect((enviados[0] as { workshopCreditEnabled: unknown }).workshopCreditEnabled).toBe(true);
    await screen.findByText(/A OS da oficina pode ser faturada a prazo/);
    expect(caixa().checked).toBe(true);
  });

  it('a política que já fatura aparece marcada, e a tela diz onde o prazo vale', async () => {
    servidor({ get: { body: { ...ESCOLHIDO, workshopCreditEnabled: true } } });
    montar();
    await waitFor(() => expect(caixa().checked).toBe(true));
    expect(screen.getByText(/O PDV da loja continua fechando só com o total coberto/)).toBeTruthy();
  });
});
