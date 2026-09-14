/**
 * ============================================================================
 * A PROVA DE QUE A REGRA MORDE
 * ============================================================================
 *
 * ## Por que não é `RuleTester`
 *
 * O caminho óbvio para testar uma regra de eslint é o `RuleTester` que o
 * próprio eslint publica. Um crítico escreveu esse arquivo e rodou: ele
 * derruba o portão de testes do servidor. Duas razões independentes, e as duas
 * continuam valendo hoje:
 *
 *   1. `eslint` NÃO é dependência declarada de `server/package.json`. Ele está
 *      em `node_modules` como par (peer) de `typescript-eslint`. Importar
 *      `eslint` de dentro de `tests/` seria a suíte passando a depender de um
 *      pacote que ninguém pediu — e quebrando no dia em que a árvore de
 *      dependências mudar de forma, com um erro que não fala de rotas nem de
 *      permissões.
 *
 *   2. O `RuleTester` traz o próprio arranjo de testes e o próprio parser, e
 *      dentro do vitest isso disputa com o arranjo do vitest.
 *
 * ## O caminho escolhido, e por que ele é MELHOR e não só diferente
 *
 * Rodar o eslint COMO PROCESSO, do jeito que o portão o roda, sobre arquivos
 * de exemplo — e ler a saída em JSON.
 *
 * A lição que este projeto pagou caro na rodada 22 foi: TESTE O QUE ATRAVESSA
 * A CORRENTE. Lá, uma configuração ficou inerte em produção com 2348 testes
 * verdes, porque todos chamavam o serviço direto e nenhum passava pela rota.
 * O `RuleTester` tem exatamente esse formato: ele instancia a função da regra
 * e a alimenta à mão. Passaria mesmo que a regra NÃO estivesse ligada em
 * `eslint.config.js` — ou seja, provaria que a regra funciona e não que ela
 * protege alguma coisa.
 *
 * Rodar o binário atravessa a corrente inteira: a config de verdade, o parser
 * de verdade, o mesmo processo que `npm run lint` dispara. Por isso o terceiro
 * teste aqui é o mais importante dos três: ele pergunta ao eslint qual
 * configuração ele resolve PARA `core.ts`, e exige a regra ligada em 'error'.
 * Se alguém apagar o bloco da config, os dois primeiros testes continuariam
 * verdes e este fica vermelho.
 *
 * ## Como saber que esta prova ainda vale
 *
 * Ela é escrita para QUEBRAR quando a regra for afrouxada. O segundo teste não
 * conta erros: ele casa rota por rota com o TIPO de erro esperado. Se alguém
 * trocar a busca posicional por "procurar em qualquer profundidade" — que foi
 * a primeira especificação, derrubada por um crítico —, as duas rotas de
 * guarda condicional somem da lista e este arquivo fica vermelho na hora.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = dirname(fileURLToPath(import.meta.url));
const SERVIDOR = resolve(AQUI, '..');

/**
 * O binário do eslint, chamado por caminho e não por `require('eslint')`.
 *
 * Se ele sumir, este teste FALHA — não é pulado. Teste que se pula sozinho
 * quando a ferramenta some é um teste que um dia para de existir sem ninguém
 * notar, e a regra ficaria sem prova nenhuma. Vale lembrar que `npm run lint`
 * já depende deste mesmo arquivo: se ele não estiver aqui, o portão de lint
 * também não roda.
 */
const ESLINT = resolve(SERVIDOR, 'node_modules/eslint/bin/eslint.js');

const CONFIG_EXEMPLOS = resolve(SERVIDOR, 'eslint-rules/eslint.fixtures.config.js');
const EXEMPLO_DECLARADA = resolve(SERVIDOR, 'eslint-rules/__fixtures__/rota-declarada.ts');
const EXEMPLO_CALADA = resolve(SERVIDOR, 'eslint-rules/__fixtures__/rota-calada.ts');
const CORE = resolve(SERVIDOR, 'src/routes/v1/core.ts');

const NOME_DA_REGRA = 'local-rotas/rota-declara-alcance';

interface MensagemEslint {
  ruleId: string | null;
  messageId?: string;
  message: string;
  line: number;
}

/** Roda o eslint como processo e devolve as mensagens do arquivo pedido. */
function rodarEslint(argumentos: string[]): MensagemEslint[] {
  const r = spawnSync(process.execPath, [ESLINT, ...argumentos, '-f', 'json'], {
    cwd: SERVIDOR,
    encoding: 'utf8',
    // O eslint sai com 1 quando encontra erro — que é o caso esperado em
    // metade dos testes. Quem decide se passou é a asserção, não o código de
    // saída. Mas se ele estourar (config quebrada, parser ausente), a saída
    // não é JSON e o `JSON.parse` abaixo levanta com o stderr junto.
  });
  const saida = (r.stdout ?? '').trim();
  if (!saida.startsWith('[')) {
    throw new Error(
      `eslint não devolveu JSON (código ${r.status}).\nstdout: ${r.stdout}\nstderr: ${r.stderr}`,
    );
  }
  const resultados = JSON.parse(saida) as Array<{ messages: MensagemEslint[] }>;
  return resultados.flatMap((a) => a.messages);
}

// Prazo de PROCESSO EXTERNO: estes casos abrem outro programa (eslint, PowerShell) e,
// com a suíte inteira dividindo a máquina, passam dos 30 s padrão sem estar errados.
describe('a regra que impede a rota 298 de nascer calada', { timeout: 120_000 }, () => {
  it('a ferramenta existe — sem ela não há portão de lint nem prova', () => {
    expect(existsSync(ESLINT), `eslint não encontrado em ${ESLINT}`).toBe(true);
  });

  it('fica CALADA diante dos oito formatos de rota que declaram de verdade', () => {
    const mensagens = rodarEslint([
      '--no-config-lookup',
      '-c',
      CONFIG_EXEMPLOS,
      EXEMPLO_DECLARADA,
    ]);
    /*
      Este é o lado que evita o desastre mais provável: uma regra que dá falso
      positivo em código correto é desligada, e aí não protege nada. O exemplo
      cobre o `try` de primeiro nível, a IIFE com `void`, a IIFE com `.catch`,
      o handler depois de middleware e o corpo sem `try` — os cinco formatos
      de `core.ts` — e, desde a rodada 31, os três do SEGUNDO idioma: a guarda
      como middleware (`requirePermission('x')` antes do handler), a mesma
      guarda com handler por referência (vale, porque a guarda roda antes do
      corpo esteja ele onde estiver) e a rota aberta de propósito declarada
      com `rotaPublica('motivo')`.
    */
    expect(mensagens.map((m) => `${m.line}: ${m.message}`)).toEqual([]);
  });

  it('APONTA cada defeito com o conselho certo, e sabe distinguir os três', () => {
    const mensagens = rodarEslint(['--no-config-lookup', '-c', CONFIG_EXEMPLOS, EXEMPLO_CALADA]);

    // Toda mensagem é desta regra — nenhuma vem de outro lugar por acidente.
    expect(mensagens.every((m) => m.ruleId === NOME_DA_REGRA)).toBe(true);

    /*
      Rota por rota, e não uma contagem. Contagem é frágil no sentido errado:
      passa quando os erros trocam de lugar. O que se quer provar é que a regra
      classifica CADA caso — e é essa classificação que morre se alguém
      afrouxar o critério posicional.
    */
    const porRota = mensagens.map((m) => ({
      rota: /`[A-Z]+ ([^`]+)`/.exec(m.message)?.[1],
      tipo: m.messageId,
    }));

    expect(porRota).toEqual([
      { rota: '/exemplo/calada', tipo: 'calada' },
      // As duas seguintes CHAMAM `requireProfile`. Uma regra que procurasse a
      // chamada em qualquer profundidade — a primeira especificação desta
      // rodada, derrubada por um crítico — as daria por boas.
      { rota: '/exemplo/condicional', tipo: 'escondida' },
      { rota: '/exemplo/adiado', tipo: 'escondida' },
      { rota: '/exemplo/referencia', tipo: 'handlerNaoInline' },
      // `authMiddleware` sozinho NÃO declara alcance: autenticar diz quem você
      // é, não o que pode. Se um dia ele passar a contar como declaração, o
      // buraco de carrinho/pedido da rodada 29 volta a ficar verde — e esta
      // linha fica vermelha primeiro.
      { rota: '/exemplo/auth-sem-permissao', tipo: 'calada' },
      // `rotaPublica` sem motivo legível ALI é recusada — string vazia e
      // motivo guardado em variável são o mesmo silêncio com outra roupa.
      { rota: '/exemplo/publica-sem-motivo', tipo: 'publicaSemMotivo' },
      { rota: '/exemplo/publica-motivo-longe', tipo: 'publicaSemMotivo' },
      // Guarda DEPOIS do handler nunca roda — o Express respondeu antes de
      // chegar nela. Contar isso como declarada era rota aberta com portao
      // verde, medido por um atacante da rodada 31.
      { rota: '/exemplo/guarda-depois-do-handler', tipo: 'calada' },
      // rotaPublica numa rota guardada: uma das duas afirmacoes mente.
      { rota: '/exemplo/contraditoria', tipo: 'contraditoria' },
      // RBAC granular (T12): a guarda nova só vale com capability do catálogo,
      // em literal — erro de digitação e variável são recusados ali.
      { rota: '/exemplo/capability-desconhecida', tipo: 'capabilityDesconhecida' },
      { rota: '/exemplo/capability-em-variavel', tipo: 'capabilityDesconhecida' },
      { rota: '/exemplo/middleware-capability-desconhecida', tipo: 'capabilityDesconhecida' },
      // A guarda nova segue o critério posicional: dentro de `if` não é guarda.
      { rota: '/exemplo/capability-condicional', tipo: 'escondida' },
      { rota: '/exemplo/autenticada-sem-motivo', tipo: 'autenticadaSemMotivo' },
      { rota: '/exemplo/autenticada-contraditoria', tipo: 'contraditoria' },
    ]);

    // A mensagem tem de DIZER O QUE FAZER. Sem isso, quem lê copia o guarda da
    // rota vizinha — que foi como o guarda das etiquetas quase ficou mais
    // estreito que a tela. Para a rota calada/escondida, as opções dos DOIS
    // idiomas e a ordem de escrever o motivo; para a rotaPublica vazia, o
    // conselho é outro: escreva o motivo, ali mesmo.
    for (const m of mensagens) {
      if (m.messageId === 'contraditoria') {
        expect(m.message).toContain('não podem ser verdade juntas');
        continue;
      }
      if (m.messageId === 'publicaSemMotivo' || m.messageId === 'autenticadaSemMotivo') {
        expect(m.message).toContain('sem motivo');
        expect(m.message).toContain('literal de string não vazio');
        continue;
      }
      if (m.messageId === 'capabilityDesconhecida') {
        expect(m.message).toContain('catálogo');
        expect(m.message).toContain('src/services/auth/Capabilities.ts');
        expect(m.message).toContain('literal');
        continue;
      }
      // A primeira opção agora é a guarda por capability; as legadas seguem
      // citadas enquanto a F2 não termina de traduzi-las.
      expect(m.message).toContain("requireCapability(req, 'area.recurso.acao')");
      expect(m.message).toContain('abertaAo(req');
      expect(m.message).toContain('requireProfile(req');
      expect(m.message).toContain("requirePermission('modulo.recurso.acao')");
      expect(m.message).toContain("rotaPublica('motivo')");
      expect(m.message).toContain('comentário dizendo POR QUE');
    }
  });

  it('está LIGADA em core.ts na config de produção, e core.ts passa', () => {
    /*
      O teste que a rodada 22 ensinou a escrever. Os dois de cima provariam a
      regra funcionando mesmo que ela não estivesse ligada em lugar nenhum —
      configuração inerte com testes verdes é exatamente o defeito daquela
      rodada.

      `--print-config` pergunta ao eslint o que ele resolve PARA este arquivo,
      usando `server/eslint.config.js` de verdade. É a única resposta que
      corresponde ao que `npm run lint` vai fazer.
    */
    const r = spawnSync(process.execPath, [ESLINT, '--print-config', CORE], {
      cwd: SERVIDOR,
      encoding: 'utf8',
    });
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    const config = JSON.parse(r.stdout) as { rules: Record<string, unknown> };
    const ligada = config.rules[NOME_DA_REGRA];
    expect(ligada, 'a regra não está ligada para core.ts em eslint.config.js').toBeDefined();
    // `--print-config` normaliza a severidade para número, e 2 é 'error'.
    // Exigir 2 e não "ligada de qualquer jeito" é de propósito: em 'warn' a
    // rota calada vira mais um aviso na pilha, e aviso que ninguém lê é a
    // mesma coisa que silêncio — o defeito que esta rodada existe para matar.
    const severidade = Array.isArray(ligada) ? ligada[0] : ligada;
    expect(severidade).toBe(2);
    // E as opções chegaram: é `coreRouter` que ela vigia.
    expect(JSON.stringify(ligada)).toContain('coreRouter');

    // E o estado de hoje: 297 de 297 declaram. Zero violações.
    const mensagens = rodarEslint([CORE]).filter((m) => m.ruleId === NOME_DA_REGRA);
    expect(mensagens.map((m) => `${m.line}: ${m.message}`)).toEqual([]);
  });

  it('o catálogo que a regra conhece é o de Capabilities.ts — uma fonte só', async () => {
    /*
      A regra não pode importar TypeScript, e uma lista de códigos copiada para
      dentro dela divergiria do catálogo na primeira capability nova. Ela LÊ
      `src/services/auth/Capabilities.ts`. Se a leitura quebrar (o gerador
      mudar o formato), a regra passaria a recusar toda guarda — ou pior, a
      aceitar qualquer string; este caso pega as duas.
    */
    const regra = (await import('../eslint-rules/rota-declara-alcance.js')) as { codigosDoCatalogo: () => Set<string> };
    const { CAPABILITIES } = await import('../src/services/auth/Capabilities.js');
    expect([...regra.codigosDoCatalogo()].sort()).toEqual([...CAPABILITIES].sort());
  });

  it('cobre TODOS os roteadores de src/routes/v1 — e a lista da config não envelhece', () => {
    /*
      A regra casa pelo NOME do identificador do roteador. Um roteador novo que
      não estiver na lista da config fica INVISÍVEL para ela — as rotas dele
      nasceriam caladas com o portão verde, que é exatamente o defeito que a
      regra existe para matar. Então a lista é conferida contra o código: todo
      `export const <nome>Router` de `src/routes/v1` tem de estar nas opções
      que o eslint resolve para esses arquivos. Roteador novo sem entrada na
      config derruba esta linha, não passa em silêncio.
    */
    const dirRotas = resolve(SERVIDOR, 'src/routes/v1');
    const exportados = readdirSync(dirRotas)
      .filter((f) => f.endsWith('.ts'))
      .flatMap((f) => {
        const texto = readFileSync(resolve(dirRotas, f), 'utf8');
        return [...texto.matchAll(/export const (\w+Router) = Router\(\)/g)].map((m) => m[1]);
      })
      .sort();
    // A varredura tem de ter encontrado o mundo conhecido — se o regex quebrar
    // e devolver pouca coisa, a comparação abaixo passaria por acidente.
    expect(exportados).toContain('coreRouter');
    // A sentinela era `storefrontsRouter` (PLURAL) até a rodada 36 apagar a
    // loja fantasma. Passou a ser `storefrontRouter` (SINGULAR), a loja real —
    // que continua montada em `/loja` e não vai a lugar nenhum.
    expect(exportados).toContain('storefrontRouter');
    // Eram dezenove. A rodada 36 apagou cinco roteadores sem chamador (loja
    // fantasma, promoções mortas, OMS, workshop legado, rentals): catorze. O
    // GAP-PRD-075 apagou mais três (/crm, /automations, /bi): onze.
    // A frente FIS apagou `/fiscal` e `/fiscal/nfe` (GAP-PRD-096) e trouxe o
    // `nfseRouter` (GAP-PRD-024, montado dentro do núcleo): dez.
    // A junção do GAP-PRD-075 apagou `integrationsRouter` (sem tela) e o
    // `nfceRouter` (o CSC foi para o núcleo): oito.
    // O piso é guarda contra regex quebrado, não contagem congelada.
    expect(exportados.length).toBeGreaterThanOrEqual(8);

    const r = spawnSync(
      process.execPath,
      [ESLINT, '--print-config', resolve(dirRotas, 'storefront.ts')],
      { cwd: SERVIDOR, encoding: 'utf8' },
    );
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
    const config = JSON.parse(r.stdout) as { rules: Record<string, unknown> };
    const ligada = config.rules[NOME_DA_REGRA] as [number, { roteadores: string[] }] | undefined;
    expect(ligada, 'a regra não está ligada para storefront.ts').toBeDefined();
    expect(Array.isArray(ligada) ? ligada[0] : ligada).toBe(2);
    expect([...(ligada![1].roteadores ?? [])].sort()).toEqual(exportados);

    // E o estado de hoje: os dezessete arquivos passam — toda rota ou declara
    // guarda (num dos dois idiomas) ou declara `rotaPublica` com motivo.
    const mensagens = rodarEslint(['src/routes/v1']).filter((m) => m.ruleId === NOME_DA_REGRA);
    expect(mensagens.map((m) => `${m.line}: ${m.message}`)).toEqual([]);
  });
});
