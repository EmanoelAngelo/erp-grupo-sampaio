/**
 * ============================================================================
 * O QUE O BOOT LIGA — e o serviço que existe e ninguém chama
 * ============================================================================
 *
 * Este projeto já teve o defeito exato duas vezes, e as duas custaram caro:
 *
 *   - `startSyncWorker` existia inteiro — envio em lote, upsert idempotente,
 *     baixa só do que a central confirmou — e NÃO TINHA UM ÚNICO CHAMADOR. A
 *     tela dizia "a fila sobe sozinha" e não subia nada;
 *   - `recoverStaleItems`, da fila fiscal, idem: item preso em `sending` ficava
 *     assim para sempre.
 *
 * Nos dois casos a suíte estava verde. Testar a FUNÇÃO não descobre que
 * ninguém a chama — e é justamente isso que este arquivo cobra, por AST: quem
 * o boot liga, e em que condição.
 *
 * ## Por que por LEITURA, e não subindo o servidor
 *
 * Subir o servidor de verdade abriria porta, tocaria o banco e faria os timers
 * baterem contra a rede — nenhum deles é o que interessa medir. O que
 * interessa é a DECLARAÇÃO: `startServer` chama `startX()`? Sob qual `if`? E
 * `shutdown` desliga o que ligou?
 *
 * ## A fila fiscal entrou (GAP-PRD-020)
 *
 * Por muito tempo a fila FISCAL não teve trabalhador de fundo, por decisão
 * declarada: transmitir exige o certificado A1, e o desenho queria alguém
 * presente em todo ato fiscal real. A decisão caiu com a senha selada no
 * cofre: a nota presa pela SEFAZ fora do ar precisava esperar a próxima venda
 * da MESMA empresa para andar. O `startFiscalQueueWorker` entrou na lista
 * abaixo com o `stop` dele — e o último caso deste arquivo continua segurando
 * qualquer outro trabalhador que apareça no boot sem passar por aqui.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const AQUI = dirname(fileURLToPath(import.meta.url));
const BOOT = resolve(AQUI, '../src/index.ts');

function arvore(caminho: string): ts.SourceFile {
  expect(existsSync(caminho), `arquivo não encontrado: ${caminho}`).toBe(true);
  return ts.createSourceFile(
    caminho,
    readFileSync(caminho, 'utf8'),
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  );
}

/** O corpo de uma função exportada, pelo nome. */
function corpoDe(sf: ts.SourceFile, nome: string): ts.Node {
  let achado: ts.Node | null = null;
  const visitar = (node: ts.Node): void => {
    if (
      ts.isFunctionDeclaration(node)
      && node.name?.text === nome
      && node.body
    ) {
      achado = node.body;
      return;
    }
    ts.forEachChild(node, visitar);
  };
  ts.forEachChild(sf, visitar);
  if (!achado) throw new Error(`função \`${nome}\` não encontrada em index.ts`);
  return achado;
}

/** Toda chamada `nome()` dentro de um nó. */
function chamadasEm(node: ts.Node): string[] {
  const nomes: string[] = [];
  const visitar = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) nomes.push(n.expression.text);
    ts.forEachChild(n, visitar);
  };
  ts.forEachChild(node, visitar);
  return nomes;
}

/** A chamada está dentro de um `if`? Devolve o texto da condição, ou null. */
function condicaoDe(sf: ts.SourceFile, nome: string): string | null {
  let condicao: string | null | undefined;
  const visitar = (n: ts.Node, dentroDe: ts.Expression | null): void => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === nome) {
      condicao = dentroDe ? dentroDe.getText(sf) : null;
      return;
    }
    if (ts.isIfStatement(n)) {
      ts.forEachChild(n.thenStatement, (c) => visitar(c, n.expression));
      if (n.elseStatement) ts.forEachChild(n.elseStatement, (c) => visitar(c, dentroDe));
      return;
    }
    ts.forEachChild(n, (c) => visitar(c, dentroDe));
  };
  ts.forEachChild(sf, (n) => visitar(n, null));
  return condicao ?? null;
}

const sf = arvore(BOOT);
const noBoot = chamadasEm(corpoDe(sf, 'startServer'));

/**
 * O CONTRATO DO BOOT.
 *
 * Cada linha é um trabalhador que a operação depende de estar de pé, com a
 * condição em que ele sobe. Acrescentar um trabalhador ao sistema e esquecer
 * de acrescentá-lo aqui deixa este arquivo vermelho — que é o ponto.
 */
const TRABALHADORES = [
  {
    nome: 'startMailScheduler',
    porque: 'lê as caixas de e-mail; sem ele a nota que chega por e-mail não entra',
    condicional: false,
  },
  {
    nome: 'startReservationExpiry',
    porque: 'devolve à vitrine a reserva do pedido não pago; sem ele o saldo fica preso',
    condicional: false,
  },
  {
    nome: 'startAsaasSync',
    porque:
      'pergunta ao Asaas pelas cobranças em aberto (GAP-PRD-016); sem ele o webhook '
      + 'perdido some da conciliação. Sai SEMPRE: sem credencial em nenhuma operação a '
      + 'batida custa uma consulta ao banco, e ASAAS_SYNC_INTERVAL_MINUTES=0 a desliga',
    condicional: false,
  },
  {
    nome: 'startRastreioAgendado',
    porque:
      'consulta sozinho o rastreio dos envios a caminho (GAP-PRD-119); sem ele o pedido '
      + 'só vira expedido ou entregue quando alguém abre a ficha. Sai SEMPRE: sem envio a '
      + 'caminho a batida é uma consulta vazia ao banco, e LOGISTICS_TRACKING_SYNC_MINUTES=0 a desliga',
    condicional: false,
  },
  {
    nome: 'startDailyBackup',
    porque: 'a cópia diária do banco — o único mecanismo automático de recuperação',
    condicional: false,
  },
  {
    nome: 'startEmailFlushWorker',
    porque:
      'entrega o código de verificação e a recuperação de senha; sai SEMPRE, e sem '
      + 'credencial apenas acumula',
    condicional: false,
  },
  {
    nome: 'startSyncWorker',
    porque:
      'sobe venda, estoque e fiscal para a central; sai SEMPRE, e sem credencial '
      + 'apenas acumula',
    condicional: false,
  },
  {
    nome: 'startFiscalQueueWorker',
    porque:
      'transmite a fila fiscal sozinho (GAP-PRD-020): a nota presa pela SEFAZ fora do ar sai '
      + 'quando o serviço volta, e não na próxima venda da mesma empresa. Sai SEMPRE: sem A1 '
      + 'no cofre a passada só anota a espera, sem gastar tentativa',
    condicional: false,
  },
  {
    nome: 'startContadorScheduler',
    porque:
      'a agenda mensal do pacote ao contador; sai SEMPRE, e sem destinatário ou '
      + 'sem SMTP apenas anota — o mês devido sai quando o cadastro existir',
    condicional: false,
  },
];

// ============================================================================

describe('todo trabalhador que a operação depende sobe no boot', () => {
  it('a leitura enxerga o boot — senão ficaria verde lendo nada', () => {
    expect(noBoot.length).toBeGreaterThan(5);
    expect(noBoot).toContain('createApp');
  });

  for (const t of TRABALHADORES) {
    it(`${t.nome} — ${t.porque}`, () => {
      expect(noBoot, `\`${t.nome}\` não é chamado em startServer`).toContain(t.nome);
    });
  }

  it('o que sobe SEM condição não ganhou um `if` sem ninguém decidir', () => {
    /*
      O carteiro já esteve sob `if (carteiroConfigurado())`, copiando o molde
      do trabalhador da central. Lá o `if` se justifica — sem credencial não há
      para onde enviar. Aqui não: a batida sem credencial é inofensiva, e o
      `if` só criava dependência de ORDEM — quem subisse o servidor antes de
      terminar o `.env` ficava com a fila parada, e nela ficam o código de
      verificação e a recuperação de senha.
    */
    for (const t of TRABALHADORES.filter((x) => !x.condicional)) {
      expect(condicaoDe(sf, t.nome), `\`${t.nome}\` passou a subir sob condição`).toBeNull();
    }
  });

  it('e NENHUM trabalhador sobe sob condição — a lista inteira é incondicional', () => {
    /*
      O último condicional era o da central, sob `if (supabaseConfig())`. Ele
      caiu pelo mesmo motivo que o do carteiro: `syncOnce` sem credencial
      devolve `READY_FOR_CREDENTIAL` e volta na hora, sem tocar a rede e sem
      mexer na fila. O `if` não protegia — criava dependência de ORDEM, e quem
      preenchesse a credencial com o servidor no ar não ligava nada.

      Este caso existe para que o próximo `if` no boot precise de uma decisão
      escrita, e não do hábito de copiar o vizinho.
    */
    const condicionais = TRABALHADORES.map((t) => t.nome).filter(
      (nome) => condicaoDe(sf, nome) !== null,
    );
    expect(
      condicionais,
      'trabalhador subindo sob condição: se for proposital, escreva o porquê aqui '
        + 'e mude `condicional` na lista',
    ).toEqual([]);
  });
});

// ============================================================================

describe('o que sobe também desce', () => {
  /*
    O desligamento mudou de forma no lote D1 (GAP-PRD-063): `index.ts` só diz
    QUAIS trabalhadores param (`pararTrabalhadores`) e entrega isso a
    `criarDesligamento`, que põe prazo, fecha as conexões presas e fecha o
    banco. Os sinais e a rede de segurança são ligados por
    `instalarRedeDeSeguranca` — provados em
    `o-processo-registra-o-erro-e-desliga-com-prazo.test.ts`.
  */
  const noShutdown = (() => {
    const texto = readFileSync(BOOT, 'utf8');
    const i = texto.indexOf('const pararTrabalhadores =');
    expect(i, 'não achei o `pararTrabalhadores` em index.ts').toBeGreaterThan(0);
    return texto.slice(i, texto.indexOf('};', i));
  })();

  for (const t of TRABALHADORES) {
    const parar = t.nome.replace(/^start/, 'stop');
    it(`${parar} está no desligamento`, () => {
      /*
        Trabalhador que sobe e não desce segura o processo no SIGTERM: o
        container fica "terminando" até o tempo estourar, e no meio disso o
        banco continua aberto. O `unref` de cada timer ajuda, mas o par
        explícito é o que torna o desligamento previsível.
      */
      expect(noShutdown, `\`${parar}\` não é chamado no shutdown`).toContain(parar);
    });
  }

  it('e o desligamento é montado com prazo e fecha o banco', () => {
    /*
      O `server.close()` antigo não tinha prazo: uma conexão keep-alive de um
      PDV segurava o processo "terminando" até o supervisor matá-lo, e o
      SQLite nunca era fechado — o `-wal` ficava para o próximo boot.
    */
    expect(noBoot).toContain('criarDesligamento');
    const texto = readFileSync(BOOT, 'utf8');
    const i = texto.indexOf('criarDesligamento(');
    const chamada = texto.slice(i, texto.indexOf('});', i));
    expect(chamada, 'o desligamento não fecha o banco').toContain('closeConnection');
    expect(chamada).toContain('pararTrabalhadores');
  });

  it('e a rede de segurança do processo é instalada no boot (sinais, rejeição, exceção)', () => {
    /*
      Sem ela, uma promessa rejeitada fora de try/catch derrubava a API das
      seis empresas (o Node 24 encerra o processo) sem uma linha de log, e
      nada respondia a SIGINT/SIGTERM além do `server.close()` sem prazo.
    */
    expect(noBoot).toContain('instalarRedeDeSeguranca');
    expect(readFileSync(BOOT, 'utf8')).toMatch(/instalarRedeDeSeguranca\(process,/);
  });
});

// ============================================================================

describe('nenhum trabalhador sobe no boot sem entrar no contrato', () => {
  it('todo `start*` do boot está na lista, com o motivo e o `stop`', () => {
    /*
      Foi este caso que segurou o trabalhador fiscal (GAP-PRD-020) até ele
      entrar na lista com o motivo e o `stop` dele. Continua valendo para o
      próximo: trabalhador novo no boot entra na lista deste arquivo, ou este
      caso fica vermelho.
    */
    const inesperados = noBoot.filter(
      (n) => /^start/.test(n) && !TRABALHADORES.some((t) => t.nome === n),
    );
    expect(
      inesperados,
      'trabalhador novo no boot: acrescente-o à lista com o motivo e o `stop`',
    ).toEqual([]);
  });
});
