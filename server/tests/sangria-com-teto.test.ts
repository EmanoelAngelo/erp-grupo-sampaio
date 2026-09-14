/**
 * A gaveta ganha teto — e o teto não vira armadilha.
 *
 * ## O que estava errado
 *
 * `addMovement` recusava exatamente duas coisas na sangria: valor menor ou igual
 * a zero, e saldo insuficiente. Não havia teto. Qualquer operador com caixa
 * aberto retirava até zerar, e a única testemunha era o movimento que ele mesmo
 * lançou.
 *
 * Pior que a ausência: `sangria_especial` estava DECLARADA em
 * `RESTRICTED_ACTIONS` desde o começo e não era exigida em lugar nenhum. Quem
 * conferisse a lista para saber se o balcão estava protegido leria que havia
 * uma tranca ali.
 *
 * ## Por que metade destes casos é sobre a trava NÃO pegar
 *
 * Trava que recusa tudo não é trava, é parede. E há um caso em que a parede
 * seria pior que o furo: em loja pequena o gerente É quem fica no caixa, e a
 * sangria existe para tirar dinheiro da gaveta por SEGURANÇA. Se ele não puder
 * sangrar — porque precisaria autorizar a si mesmo, e ninguém autoriza a
 * própria ação —, a trava mantém o dinheiro exposto justamente quando alguém
 * decidiu protegê-lo.
 *
 * É o mesmo motivo por que `cancelar_venda` foi RETIRADA da lista de ações
 * restritas nesta rodada: a rota já exige gerente, e exigir liberação faria o
 * gerente chamar um segundo gerente.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { resetDbForTests } from '../src/db/database.js';
import { ensureCoreSchema } from '../src/db/schema.js';
import { getConnection } from '../src/db/sqlite.js';
import { upsertCompany } from '../src/services/auth/IdentityService.js';
import { addMovement, openSession } from '../src/services/core/CashService.js';
import { RESTRICTED_ACTIONS } from '../src/services/core/AuthorizationService.js';
import { salvarPolitica } from '../src/services/core/SalePolicyService.js';

const ABERTURA = 300_000;

let empresa: string;
let sessao: string;

/** Quem opera o caixa: nenhuma alçada para liberar nada. */
const CAIXA = ['operador_caixa_loja'];
/** Quem tem alçada — e por isso não pede liberação para si. */
const GERENTE = ['gerente_loja'];

/**
 * Uma liberação já dada, como a rota grava.
 *
 * Escrita direto porque o assunto aqui é o CONSUMO dela na sangria, e não o
 * fluxo de digitar a senha do gestor — esse já tem teste próprio.
 */
function liberacao(input: {
  requestedBy: string;
  tetoCents?: number | null;
  acao?: string;
}): string {
  const id = randomUUID();
  getConnection()
    .prepare(
      `INSERT INTO core_authorizations
         (id, company_id, action, requested_by, authorized_by, reason,
          granted_concession_cents, created_at)
       VALUES (?, ?, ?, ?, 'u-gerente', 'teste', ?, ?)`,
    )
    .run(
      id,
      empresa,
      input.acao ?? 'sangria_especial',
      input.requestedBy,
      input.tetoCents ?? null,
      new Date().toISOString(),
    );
  return id;
}

function sangrar(input: {
  amountCents: number;
  perfis: string[];
  userId?: string;
  authorizationId?: string | null;
}) {
  return addMovement({
    companyId: empresa,
    sessionId: sessao,
    userId: input.userId ?? 'u-caixa',
    movementType: 'withdrawal',
    amountCents: input.amountCents,
    // A sangria passou a exigir motivo (H-caixa-seguranca-08); o assunto
    // deste arquivo é o teto, então todo pedido leva um.
    note: 'Depósito no banco',
    alcada: { profileCodes: input.perfis, authorizationId: input.authorizationId ?? null },
  });
}

beforeEach(() => {
  resetDbForTests();
  ensureCoreSchema();
  empresa = upsertCompany({
    slug: 'loja-teto',
    legalName: 'Loja do Teto Ltda',
    tradeName: 'Loja do Teto',
    kind: 'store',
  });
  sessao = openSession({ companyId: empresa, userId: 'u-caixa', openingCents: ABERTURA }).id;
});

describe('a lista de ações restritas só promete o que alguém cobra', () => {
  /**
   * O caso é ESTRUTURAL de propósito. A lista tinha cinco nomes e quatro deles
   * não eram exigidos em lugar nenhum — o defeito não era um valor errado, era
   * uma promessa. Pregar os nomes aqui faz a próxima pessoa que acrescentar um
   * sexto ter de justificar quem o cobra.
   *
   * SÃO CINCO AGORA, e as três que voltaram voltaram COM cobrador:
   *
   *   cancelar_venda  POST /core/sales/:id/cancel, por `comLiberacaoPontual`
   *   devolver_venda  POST /core/sale-returns, pelo mesmo portão
   *   reabrir_caixa   CashService.reopenSession
   *
   * As três estavam declaradas e órfãs na rodada da alçada, e foram RETIRADAS
   * justamente por isso. Voltar sem cobrador seria repetir o defeito; quem
   * prova que cada uma é cobrada de verdade é `liberacao-pontual.test.ts`, que
   * executa a rota e confere o que ficou no banco.
   */
  it('são exatamente cinco, e as cinco têm quem exija', () => {
    expect([...RESTRICTED_ACTIONS].sort()).toEqual([
      'cancelar_venda',
      'desconto_acima_limite',
      'devolver_venda',
      'reabrir_caixa',
      'sangria_especial',
    ]);
  });

  it('`alterar_preco` continua FORA — a única que nunca ganhou cobrador', () => {
    /*
      A que sobrou da limpeza, e ela não volta: preço abaixo do vigente já é
      concessão medida no servidor e já é cobrada por `desconto_acima_limite`,
      com teto por operação. Declará-la faria acreditar numa segunda trava que
      não existe — que é exatamente o defeito que esta lista existe para não
      cometer de novo.
    */
    expect(RESTRICTED_ACTIONS.has('alterar_preco')).toBe(false);
  });
});

describe('sem teto configurado, nada muda', () => {
  it('o operador sangra o que quiser — é o comportamento de sempre', () => {
    const r = sangrar({ amountCents: 90_000, perfis: CAIXA });
    expect(r.balance).toBe(ABERTURA - 90_000);
  });

  it('e o saldo insuficiente continua sendo a recusa que já existia', () => {
    expect(() => sangrar({ amountCents: ABERTURA + 1, perfis: CAIXA })).toThrow(
      /insuficiente/i,
    );
  });
});

describe('com teto, o operador é barrado e o gerente não', () => {
  beforeEach(() => {
    salvarPolitica({ companyId: empresa, userId: 'u-dono', cashWithdrawalLimitReais: '500' });
  });

  it('o teto do dono é gravado em CENTAVOS, e ele digitou REAIS', () => {
    // O erro de cem vezes é o que a unidade no nome do campo existe para
    // impedir: quem manda 500 pensando em reais não pode gravar R$ 5,00.
    const p = salvarPolitica({
      companyId: empresa,
      userId: 'u-dono',
      cashWithdrawalLimitReais: '500',
    });
    expect(p.cashWithdrawalLimitCents).toBe(50_000);
    expect(p.definidos.cashWithdrawalLimitCents).toBe(true);
  });

  it('sangria acima do teto por operador é RECUSADA, e a mensagem traz os dois números', () => {
    try {
      sangrar({ amountCents: 60_000, perfis: CAIXA });
      throw new Error('a sangria deveria ter sido recusada');
    } catch (err) {
      const e = err as { code?: string; message?: string; details?: Record<string, unknown> };
      expect(e.code).toBe('CORE_WITHDRAWAL_NEEDS_AUTHORIZATION');
      // Sem o teto E o pedido na frase, o operador não sabe quanto reduzir.
      expect(e.message).toContain('600,00');
      expect(e.message).toContain('500,00');
      expect(e.details).toMatchObject({ tetoCents: 50_000, pedidoCents: 60_000 });
    }
  });

  it('no teto exato passa: o limite é o que se pode, não o que não se pode', () => {
    expect(sangrar({ amountCents: 50_000, perfis: CAIXA }).balance).toBe(ABERTURA - 50_000);
  });

  /**
   * O CASO QUE IMPEDE A ARMADILHA.
   *
   * Loja de um gerente só, ele no caixa, teto baixo. Se este caso ficar
   * vermelho, a rodada criou exatamente o problema que usou para retirar
   * `cancelar_venda` da lista — e criou onde dói mais, porque o efeito é o
   * dinheiro ficar na gaveta.
   */
  it('o GERENTE sangra acima do teto sem liberação nenhuma', () => {
    expect(sangrar({ amountCents: 90_000, perfis: GERENTE }).balance).toBe(ABERTURA - 90_000);
  });

  it('teto ZERO é decisão oposta e legítima: toda sangria chama o gestor', () => {
    salvarPolitica({ companyId: empresa, userId: 'u-dono', cashWithdrawalLimitReais: '0' });
    expect(() => sangrar({ amountCents: 100, perfis: CAIXA })).toThrow(
      /liberação de um gestor/i,
    );
    // E continua não sendo parede para quem tem alçada.
    expect(sangrar({ amountCents: 100, perfis: GERENTE }).balance).toBe(ABERTURA - 100);
  });

  it('campo apagado volta a "sem teto", e não a zero', () => {
    const p = salvarPolitica({
      companyId: empresa,
      userId: 'u-dono',
      cashWithdrawalLimitReais: '',
    });
    expect(p.cashWithdrawalLimitCents).toBeNull();
    expect(sangrar({ amountCents: 90_000, perfis: CAIXA }).balance).toBe(ABERTURA - 90_000);
  });

  it('texto que não é número é RECUSADO — é o caso que abriria a gaveta', () => {
    // `Number('quinhentos')` é NaN, e comparar qualquer coisa com NaN devolve
    // false: sem esta recusa a trava passaria a liberar tudo, em silêncio.
    expect(() =>
      salvarPolitica({
        companyId: empresa,
        userId: 'u-dono',
        cashWithdrawalLimitReais: 'quinhentos',
      }),
    ).toThrow(/Teto da sangria/);
  });
});

describe('a liberação do gestor vale uma vez, para quem pediu e para aquele valor', () => {
  beforeEach(() => {
    salvarPolitica({ companyId: empresa, userId: 'u-dono', cashWithdrawalLimitReais: '500' });
  });

  it('com liberação a sangria passa, e a liberação é CONSUMIDA', () => {
    const id = liberacao({ requestedBy: 'u-caixa' });
    expect(sangrar({ amountCents: 60_000, perfis: CAIXA, authorizationId: id }).balance).toBe(
      ABERTURA - 60_000,
    );
    // A segunda tentativa com o mesmo papel é recusada: era o contorno de
    // repetir o id que a rodada 21 fechou para o desconto.
    //
    // O valor precisa passar do teto DE NOVO, senão a sangria nem chega a
    // consultar a liberação e o caso passaria por não exercer nada — foi o que
    // aconteceu na primeira escrita deste teste, com R$ 200,00.
    expect(() =>
      sangrar({ amountCents: 60_000, perfis: CAIXA, authorizationId: id }),
    ).toThrow(/já foi usada/i);
  });

  it('liberação de OUTRO operador não serve', () => {
    const id = liberacao({ requestedBy: 'u-outro' });
    expect(() =>
      sangrar({ amountCents: 60_000, perfis: CAIXA, authorizationId: id }),
    ).toThrow(/outro operador/i);
  });

  it('liberação com teto MENOR que a sangria não paga a diferença', () => {
    const id = liberacao({ requestedBy: 'u-caixa', tetoCents: 55_000 });
    expect(() =>
      sangrar({ amountCents: 80_000, perfis: CAIXA, authorizationId: id }),
    ).toThrow(/liberou/i);
  });

  /**
   * A ação faz parte da consulta, e este é o caso que prova por quê: um "sim"
   * para tirar dinheiro da gaveta não pode autorizar desconto numa venda, nem o
   * contrário. São duas decisões diferentes do gestor.
   */
  it('liberação de DESCONTO não paga sangria', () => {
    const id = liberacao({ requestedBy: 'u-caixa', acao: 'desconto_acima_limite' });
    expect(() =>
      sangrar({ amountCents: 60_000, perfis: CAIXA, authorizationId: id }),
    ).toThrow(/liberação de um gestor/i);
  });
});

describe('o que entra na gaveta não tem teto', () => {
  beforeEach(() => {
    salvarPolitica({ companyId: empresa, userId: 'u-dono', cashWithdrawalLimitReais: '500' });
  });

  it('suprimento passa livre — dinheiro entrando não é risco', () => {
    const r = addMovement({
      companyId: empresa,
      sessionId: sessao,
      userId: 'u-caixa',
      movementType: 'supply',
      amountCents: 900_000,
      alcada: { profileCodes: CAIXA },
    });
    expect(r.balance).toBe(ABERTURA + 900_000);
  });
});
