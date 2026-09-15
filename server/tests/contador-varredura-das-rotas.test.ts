/**
 * ============================================================================
 * A VARREDURA: O CONTADOR BATE EM TODAS AS ROTAS DO NÚCLEO
 * ============================================================================
 *
 * ## POR QUE O TÍTULO NÃO TRAZ O NÚMERO
 *
 * Trazia — e o número envelheceu. O cabeçalho dizia 312, o título do primeiro
 * caso dizia 359, e a asserção, que é a única que o computador lê, dizia 413.
 * Três cópias do mesmo fato, duas delas mentindo para quem abre o arquivo
 * justamente para investigar a contagem. O número mora num lugar só agora: o
 * `toHaveLength` da varredura. Prosa que repete número vira prosa errada.
 *
 * ## O que este arquivo mede, e por que ele é o coração da rodada
 *
 * A rodada 29 deu login a uma pessoa de FORA da empresa. O que a protege não é
 * o que foi aberto — são três rotas, e três rotas cabem na cabeça. O que a
 * protege é o que NÃO foi aberto: todas as outras. E "não foi aberto" é
 * exatamente o tipo de afirmação que ninguém verifica, porque não há o que
 * olhar: uma rota que o contador não alcança tem a mesma cara de uma rota que
 * ele alcança por engano.
 *
 * Então aqui ele bate em TODAS, autenticado, e cada resposta é conferida.
 *
 * ## Por que a lista vem do AST de `core.ts`, e nunca escrita à mão
 *
 * Uma lista escrita à mão envelhece no dia em que alguém acrescenta rota — e
 * envelhece EM SILÊNCIO, verde, com a rota nova fora da varredura. Este
 * projeto já pagou por varredura de texto: a primeira contagem de rotas
 * caladas usou regex e contou 55 onde havia 52, porque o formatador quebra
 * chamadas em duas linhas; a seguinte contou 63, porque não sabia descer nas
 * IIFEs. Regex conta texto; a pergunta é sobre ESTRUTURA.
 *
 * A lista sai da árvore que o próprio compilador enxerga. Rota nova nasce
 * dentro da varredura no mesmo commit em que nasce no roteador, e se ela vier
 * aberta ao contador por engano — por descuido, por cópia da vizinha, por um
 * `abertaAo` largo demais —, este arquivo fica VERMELHO antes de o código
 * chegar em produção.
 *
 * ## Os detalhes que tornam a varredura honesta
 *
 * 1. MÉTODO CERTO POR ROTA. Bater de GET numa rota POST devolve 404 do Express
 *    sem chegar em guarda nenhum, e 404 não é 403: seria uma varredura que
 *    passa sem medir nada. O método vem do AST junto com o caminho.
 *
 * 2. 401 NÃO SERVE. O token é de um `contador` de verdade — usuário, empresa,
 *    vínculo e senha Argon2id, pelo mesmo `loginForTest` do resto da suíte. Um
 *    403 sem sessão não prova nada sobre o perfil; prova sobre a ausência de
 *    token, que já tem teste próprio.
 *
 * 3. O PARÂMETRO DE CAMINHO É QUALQUER COISA, e é de propósito. O que se mede
 *    é o GUARDA, e o guarda roda ANTES de qualquer busca no banco — é a
 *    primeira instrução do `try` de toda rota. Por isso um `:id` inexistente
 *    tem de devolver 403 e não 404. Se alguma rota devolver 404 antes do
 *    guarda, é porque alguém moveu a checagem para depois da consulta, e a
 *    varredura RELATA a rota pelo nome em vez de contornar o caso.
 *
 * 4. NENHUM `expect` ACEITA DOIS STATUS. Cada rota tem um número esperado e um
 *    só: 403 para as fechadas, e um status nomeado para cada uma das três abertas.
 *    A rodada 28 consertou um teste de segurança que aceitava "200 ou 403" e
 *    por isso não media nada; o remédio não é repetir o erro em escala.
 *
 * ## Por que a app é refeita a cada lote
 *
 * `createApp()` monta um `express-rate-limit` de 300 requisições por minuto,
 * com armazenamento próprio por instância. A varredura faz mais que isso — ou seja, ela
 * bateria no próprio limitador e as últimas dezenas voltariam 429, que é um
 * verde falso disfarçado de vermelho (ou pior: um vermelho que alguém
 * "conserta" afrouxando a asserção). Uma instância nova por lote zera o
 * contador do limitador sem tocar no limitador, que continua valendo em
 * produção. O token é JWT: vale em qualquer instância, porque o segredo e o
 * banco são os mesmos.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { resetDbForTests } from '../src/db/database.js';
import { loginForTest } from './helpers/auth.js';

const AQUI = dirname(fileURLToPath(import.meta.url));
/*
  OS ROTEADORES DO NÚCLEO. `core.ts` é o grosso; `nfse.ts` (frente FIS,
  GAP-PRD-024) é montado DENTRO dele (`coreRouter.use(nfseRouter)`), no mesmo
  `/api/v1/core` — as rotas da NFS-e são rotas do núcleo para quem as chama,
  e o contador tem de ser recusado nelas como em qualquer outra. O caso
  "todo roteador montado dentro do núcleo é varrido" segura o próximo.
*/
const ROTEADORES_DO_NUCLEO = [
  { arquivo: 'core.ts', roteador: 'coreRouter' },
  { arquivo: 'nfse.ts', roteador: 'nfseRouter' },
] as const;
const CORE = resolve(AQUI, '../src/routes/v1/core.ts');
const caminhoDoRoteador = (arquivo: string) => resolve(AQUI, '../src/routes/v1', arquivo);
const MONTAGEM = '/api/v1/core';

const EMPRESA = 'escritorio-contabil';

// ---------------------------------------------------------------------------
// A leitura do roteador
// ---------------------------------------------------------------------------

type Metodo = 'get' | 'post' | 'put' | 'patch' | 'delete';
const METODOS = new Set<string>(['get', 'post', 'put', 'patch', 'delete']);

interface Rota {
  metodo: Metodo;
  caminho: string;
  arquivo: string;
  linha: number;
}

/**
 * Toda `coreRouter.<método>('<caminho>', ...)` do arquivo, pela árvore.
 *
 * Duas coisas aqui são recusa deliberada de "dar um jeito":
 *
 *   - caminho que não seja literal de string levanta. Hoje todas são
 *     literais; no dia em que uma for montada por variável, a varredura não
 *     tem como visitá-la, e uma varredura que pula o que não entende é uma
 *     porta. Melhor parar e obrigar alguém a decidir.
 *
 *   - forma no roteador que não seja um dos cinco métodos nem `use` também
 *     levanta. `.route('/x').get(h)` e `.all('/x', h)` são API de primeira
 *     classe do Express e passariam por aqui sem um arranhão — é o mesmo
 *     cuidado que a regra de lint `rota-declara-alcance` já toma.
 */
function rotasDeCore(): Rota[] {
  const encontradas: Rota[] = [];
  for (const { arquivo: nomeDoArquivo, roteador } of ROTEADORES_DO_NUCLEO) {
    const caminho = caminhoDoRoteador(nomeDoArquivo);
    const texto = readFileSync(caminho, 'utf8');
    const arquivo = ts.createSourceFile(caminho, texto, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);

    const visitar = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const alvo = node.expression.expression;
        if (ts.isIdentifier(alvo) && alvo.text === roteador) {
          const nome = node.expression.name.text;
          const linha = arquivo.getLineAndCharacterOfPosition(node.getStart(arquivo)).line + 1;
          if (METODOS.has(nome)) {
            const primeiro = node.arguments[0];
            if (!primeiro || !ts.isStringLiteralLike(primeiro)) {
              throw new Error(
                `${nomeDoArquivo}:${linha} — rota com caminho não literal. A varredura não consegue `
                  + 'visitá-la, e pulá-la seria abrir uma exceção silenciosa.',
              );
            }
            encontradas.push({ metodo: nome as Metodo, caminho: primeiro.text, arquivo: nomeDoArquivo, linha });
          } else if (nome !== 'use') {
            throw new Error(
              `${nomeDoArquivo}:${linha} — \`${roteador}.${nome}(...)\` é forma de rota que esta varredura `
                + 'não conhece. Ensine-a a lê-la; não a deixe em silêncio.',
            );
          }
        }
      }
      ts.forEachChild(node, visitar);
    };

    visitar(arquivo);
  }
  return encontradas;
}

/** Os roteadores que `core.ts` monta dentro de si (`coreRouter.use(xRouter)`). */
function roteadoresMontadosNoNucleo(): string[] {
  const texto = readFileSync(CORE, 'utf8');
  const arquivo = ts.createSourceFile(CORE, texto, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const montados: string[] = [];
  const visitar = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression)
      && node.expression.expression.text === 'coreRouter'
      && node.expression.name.text === 'use'
    ) {
      for (const arg of node.arguments) {
        if (ts.isIdentifier(arg) && /Router$/.test(arg.text)) montados.push(arg.text);
      }
    }
    ts.forEachChild(node, visitar);
  };
  visitar(arquivo);
  return montados;
}

/**
 * Valores para os parâmetros de caminho.
 *
 * O padrão é um texto que não existe em lugar nenhum, porque o que se mede é o
 * guarda e ele roda antes da busca. As exceções existem para as TRÊS rotas
 * abertas: nelas a requisição atravessa o guarda e chega no corpo, e aí o
 * status deixa de ser 403 e passa a depender do valor. `:period` recebe um mês
 * válido para que a prévia e o pacote respondam 200 de verdade, com o mês
 * vazio — que é o caso mais fácil de montar e o mais fácil de conferir.
 */
const VALOR_DO_PARAMETRO: Record<string, string> = {
  period: '2026-07',
};
const VALOR_PADRAO = 'varredura-do-contador';

function urlDe(rota: Rota): string {
  return (
    MONTAGEM
    + rota.caminho.replace(/:([A-Za-z0-9_]+)/g, (_, nome: string) =>
      VALOR_DO_PARAMETRO[nome] ?? VALOR_PADRAO)
  );
}

/**
 * As portas do contador (três até o GAP-PRD-176, que abriu a conferência do
 * SHA-256 do pacote), e o status que cada uma devolve NESTA varredura.
 *
 * O número não é "qualquer coisa menos 403": é o desfecho exato de atravessar
 * o guarda e chegar no corpo da rota com os valores acima.
 *
 *   - a prévia de um mês sem movimento responde 200 com zeros;
 *   - o pacote desse mesmo mês responde 200 — o zip sai com LEIA-ME, MANIFESTO
 *     e DRE mesmo sem documento nenhum, que é o desenho do serviço;
 *   - o XML de uma nota que não existe responde 404, e é justamente esse 404
 *     que prova que o guarda o DEIXOU PASSAR: quem é recusado nem chega na
 *     consulta. Os casos com nota de verdade estão em `contador-acesso`.
 */
const ABERTAS: Record<string, number> = {
  'GET /fiscal/closings/:period/previa': 200,
  'GET /fiscal/closings/:period/pacote': 200,
  // GAP-PRD-176: conferir o SHA-256 de um pacote recebido é a outra metade de
  // baixá-lo. A varredura não manda hash, e a rota — depois de o guarda deixar
  // o contador passar — recusa o vazio com 400 CORE_FISCAL_SHA256_INVALIDO.
  'GET /fiscal/closings/conferir': 400,
  'GET /purchases/notes/:id/xml': 404,
};

function chaveDe(rota: Rota): string {
  return `${rota.metodo.toUpperCase()} ${rota.caminho}`;
}

/**
 * Bate na rota com o método dela.
 *
 * Sem corpo: as rotas de escrita são todas 403 para o contador, e o guarda é a
 * primeira instrução — mandar corpo válido para 200 rotas seria fabricar 200
 * fixtures para medir o que já se mede sem nenhuma.
 */
function bater(app: Express, rota: Rota, token: string) {
  return request(app)[rota.metodo](urlDe(rota)).set('Authorization', `Bearer ${token}`);
}

// ---------------------------------------------------------------------------
// A varredura
// ---------------------------------------------------------------------------

/** Requisições por instância de app, com folga sobre o teto de 300/min. */
const TAMANHO_DO_LOTE = 200;

interface Medida {
  chave: string;
  arquivo: string;
  linha: number;
  status: number;
  codigo: string | undefined;
}

let rotas: Rota[] = [];
const medidas: Medida[] = [];

beforeAll(async () => {
  resetDbForTests();
  rotas = rotasDeCore();

  const primeiraApp = createApp();
  const login = await loginForTest(primeiraApp, {
    userId: 'contador-da-varredura',
    companyId: EMPRESA,
    profileCodes: ['contador'],
  });
  // Se o login falhar, todo `403` abaixo viraria `401` e o arquivo inteiro
  // mudaria de assunto sem avisar. Ele para aqui.
  expect(login.status, JSON.stringify(login.body)).toBe(200);
  // E entrou COMO contador: se o vínculo tivesse nascido com outro perfil, os
  // 403 abaixo seriam de outra pessoa e o arquivo estaria medindo outra coisa.
  expect(login.body.user.profileCode).toBe('contador');
  const token = login.body.accessToken as string;

  let app = primeiraApp;
  let noLote = 1; // o próprio login já gastou uma.

  for (const rota of rotas) {
    if (noLote >= TAMANHO_DO_LOTE) {
      app = createApp();
      noLote = 0;
    }
    noLote += 1;
    const res = await bater(app, rota, token);
    medidas.push({
      chave: chaveDe(rota),
      arquivo: rota.arquivo,
      linha: rota.linha,
      status: res.status,
      codigo: (res.body as { error?: { code?: string } })?.error?.code,
    });
  }
}, 180_000);

describe('a varredura enxerga o roteador inteiro', () => {
  it('lê o roteador inteiro — o número exato mora na asserção, e envelhece com ela', () => {
    /*
      Um número exato, e não `> 300`. O papel deste caso é outro: ele é o que
      impede a varredura de ficar verde varrendo o vazio. Se um refactor mudar
      a forma da declaração e a leitura por AST passar a achar 4 rotas, os
      outros casos deste arquivo continuariam verdes — 4 rotas negadas é um
      "todas negadas" perfeitamente válido.

      Quando alguém acrescentar mais uma rota, este caso fica vermelho e a
      correção é uma linha: trocar o número DA ASSERÇÃO, DEPOIS de conferir que
      o vermelho da varredura não veio junto. O título não repete o número de
      propósito — foi assim que ele passou três rodadas dizendo 359 enquanto a
      asserção dizia 413.
    */
    // 314 desde a rodada 40: logo e capa da loja (POST + DELETE /storefront/imagem).
    // 315 desde a rodada 42: POST /orders/:id/devolver (devolucao com estorno).
    // 316 desde a rodada 43: POST /workshop/orders/:id/pedir-aprovacao (o
    // primeiro tempo do orçamento; a decisão do cliente mora no storefront).
    // 322 desde a rodada 44: Distribuição DF-e (listar, consultar, manifestar,
    // importar) e CT-e (listar, importar).
    // 323 desde a rodada 45: POST /products/fotos-em-lote/resolver (o
    // casamento arquivo→produto; a identificação legal é pública e mora no
    // storefront, fora desta varredura).
    // 327 desde a rodada 51: o quadro da oficina ganhou largar
    // (POST /workshop/orders/:id/release), replanejar (PATCH .../plan) e a
    // régua do SLA (GET + PUT /workshop/sla).
    // 334 desde a rodada 52: a ficha da máquina (GET + PATCH /equipment/:id),
    // as fotos da OS (GET, POST, DELETE) e a conferência de entrada
    // (GET + PATCH do item).
    // 343 desde a rodada 53: o pool de plaquinhas — gerar lote, listar,
    // lotes, folha, liberar, danificar, substituir e o layout (ler e gravar).
    // 344 desde a rodada 54: a OS em papel
    // (GET /workshop/orders/:id/impressao).
    // 348 desde a rodada 55: a gaveta da bancada ganhou entrada — bipar
    // (GET /workshop/parts/scan), cadastrar com documento (POST
    // /workshop/parts), repor (POST /workshop/parts/:id/reposicao) e ajustar
    // mínimo/endereço (PATCH /workshop/parts/:id).
    // 349 desde a rodada 58: o teste de comunicação com a SEFAZ
    // (POST /fiscal/sefaz/status). `statusServico` existia nos adapters desde
    // sempre e ninguém o chamava — a tela do certificado cobrava um teste
    // real contra o fisco e não oferecia nenhum.
    // 350 desde a rodada 62: a homologação do Asaas ganhou porta
    // (POST /integrations/asaas/homologar). O motor existia e a rota antiga
    // exigia uma permissão que nenhum perfil tem.
    // 351 desde a rodada 67: a porta do balcão para a lista de vendedores
    // (GET /sellers). `GET /team` exige gerente e devolve o cadastro inteiro —
    // login, e-mail, último acesso. O PDV a chamava para preencher o seletor
    // "Vendedor", tomava 403 num catch silencioso, e TODA venda saía em nome
    // de quem estava no caixa, comissão inclusive.
    // 355 desde a auditoria integral: a ficha do cliente ganhou GET e PUT,
    // e o aceite de orçamento por telefone ganhou porta no balcão
    // (POST /fiscal/documents/:id/reenfileirar). `requeueFromContingency`
    // estava escrito, testado e sem rota — a nota entrava em contingência e
    // não havia como devolvê-la à fila por tela nenhuma.
    // 353 na rodada de implantação: o diagnóstico do cofre
    // (GET /system/secrets-readiness). Ele responde o ESTADO de cada segredo
    // — nunca o valor — e é `requireProfile(req)` sem perfil extra: saber que
    // a senha do certificado está ausente é de quem responde pelo sistema, e
    // o contador é gente de fora que RECEBE o pacote do mês.
    // 359 na rodada dos vídeos: o valor do estoque
    // (GET /stock/valuation) — saldo × custo do cadastro, somado no servidor.
    // Fechada ao contador como o resto do estoque: ele recebe o pacote do
    // mês, não a posição da prateleira.
    // 366 na rodada do envio ao contador (GAP-V30/V31): destinatários (GET,
    // POST, PATCH), agenda (GET, PUT), envio do pacote por e-mail (POST
    // /fiscal/closings/:period/enviar) e o histórico (GET .../envios). As
    // SETE são fechadas ao contador: ele é quem RECEBE o mês — decidir para
    // onde a contabilidade vai e mandá-la é de quem responde pela operação.
    // 368 na rodada de compras (GAP-V17/V20): a entrada manual sem nota
    // fiscal (POST /purchases/manual — a compra da feira vira documento,
    // dívida e razão) e o estorno da entrada confirmada
    // (POST /purchases/notes/:id/estornar — o espelho do confirmar). As duas
    // fechadas ao contador: lançar compra e desfazer entrada são operação de
    // estoque, e ele é gente de fora que recebe o pacote pronto.
    // 369 na rodada da liberação pontual (GAP-V64): a reabertura do turno de
    // caixa (POST /cash/:sessionId/reopen — só o último turno fechado, só no
    // mesmo dia da loja, e a conferência desfeita vai para a trilha em vez de
    // sumir). Fechada ao contador como o resto da gaveta: ele recebe o mês
    // fechado, não a chave do caixa.
    // +2 na rodada do certificado (GAP-V41/V42): a visão consolidada dos A1
    // do grupo (GET /fiscal/certificates/group — empresa por empresa, pelo
    // VÍNCULO, sem expor segredo) e a chave da produção
    // (POST /fiscal/production-unlock — o ato administrativo que faltava para
    // o portão que sempre existiu). As duas são `requireProfile(req)` sem
    // perfil extra e portanto fechadas ao contador: o A1 assina nota em nome
    // da empresa, e liberar emissão com valor jurídico é ato de dono.
    // +2 na rodada do crédito de loja (GAP-V10/V47): o extrato do vale do
    // cliente (GET /customers/:id/credits — saldo e movimento, com a devolução
    // que concedeu e a venda que gastou) e o passivo somado da operação
    // (GET /customer-credits/liability). A primeira é `abertaAo('balcao',
    // 'escritorio')` porque o PDV precisa saber que há vale antes de cobrar o
    // valor cheio; a segunda é de gerência. As duas fechadas ao contador: ele
    // recebe o pacote do mês, não a conta corrente de cada pessoa.
    // +4 na rodada da cobrança online (GAP-V70/V73/V75/V76): cobrar o título
    // do contas a receber pelo provedor (POST /finance/entries/:id/charge —
    // PIX, boleto ou link, com parcelamento refletido no carnê), as cobranças
    // DAQUELE título (GET /finance/entries/:id/charges), o painel de status
    // com erro e tentativas (GET /payment-intents) e a segunda tentativa da
    // cobrança que falhou (POST /payment-intents/:id/retry). As quatro
    // fechadas ao contador: cobrar cliente e olhar a fila de cobrança são
    // operação da empresa, e ele é gente de fora que recebe o mês fechado.
    // +9 na rodada da validade (GAP-V35): os lotes ganharam módulo inteiro —
    // a lista (GET /stock/batches), o alerta com as faixas e as pendências
    // (GET /stock/batches/alertas), o saldo lote a lote de um produto
    // (GET /stock/batches/saldos/:productId), a ficha (GET /stock/batches/:id),
    // o cadastro (POST /stock/batches), a correção da validade
    // (PATCH /stock/batches/:id), a conferência da doca
    // (POST /stock/batches/:id/conferir), a alocação do saldo que entrou sem
    // lote (POST /stock/batches/:id/alocar) e o interruptor por produto
    // (PATCH /stock/batch-control/:productId). AS NOVE fechadas ao contador,
    // como o resto do estoque: ele recebe o pacote do mês, não a validade da
    // prateleira. As quatro de leitura são `abertaAo('escritorio')` — o mesmo
    // alcance de GET /stock, que já entrega a posição — e as cinco de escrita
    // nomeiam gerentes e estoquista, como POST /stock/locations.
    // +10 na rodada do catálogo (GAP-V01/V04/V05/V07): o seletor de grupo
    // tributário (GET /catalog/tax-groups — a lista sozinha, porque o cadastro
    // abre muito mais que a tela de Auxiliares), a definição de campo próprio
    // (GET, POST, DELETE /catalog/custom-fields), a faixa de preço por
    // quantidade (GET, PUT, DELETE /products/:id/price-tiers), o valor do
    // campo próprio no produto (GET, PUT /products/:id/custom-fields) e o
    // histórico do cadastro (GET /products/:id/history — o que mudou, de
    // quanto para quanto, por quem). AS DEZ fechadas ao contador: catálogo,
    // preço e trilha do produto são operação da empresa, e ele é gente de fora
    // que recebe o pacote do mês. As de leitura são `abertaAo('escritorio')`
    // — exceto GET /price-tiers, que também abre ao balcão, porque o operador
    // precisa poder dizer "levando três sai por R$ 10" antes de o cliente
    // levar três.
    // +3 na rodada dos relatórios (GAP-V37/V44): a Central de Relatórios
    // (GET /reports — o catálogo — e GET /reports/:id, que devolve os dados e,
    // com `formato=csv`, o arquivo) e o recorte de vendas por marca
    // (GET /insights/brands). AS TRÊS fechadas ao contador, com o guarda mais
    // estreito entre os ingredientes que a Central junta — `requireProfile(req,
    // 'gerente_loja', 'gerente_oficina')`, o mesmo dos insights e das
    // comissões: ela consolida custo de estoque, comissão por vendedor e
    // margem numa tela só, e o contador é gente de fora que recebe o pacote do
    // mês pronto, não o razão da prateleira nem a folha de comissão.
    // +2 na rodada do assistente fiscal (GAP-V32-resíduo e a sugestão pelo
    // XML): o painel de classificação sugerida pelo XML do fornecedor
    // (GET /fiscal/classification — o que cada produto tem hoje, o que a nota
    // declarou, por quantas notas, e onde as fontes discordam) e a confirmação
    // em lote (POST /fiscal/classification/confirm — o clique que aplica o que
    // é inequívoco e nunca reescreve decisão humana). AS DUAS fechadas ao
    // contador, com o mesmo guarda de `/fiscal/product-pendencies`
    // (`gerente_loja`, `gerente_oficina`, `estoquista`): a classificação é do
    // CATÁLOGO desta operação, e quem responde pelo cadastro é quem opera —
    // o contador recebe o pacote do mês, não a chave do catálogo.
    // +8 na rodada do documento e do condicional (GAP-V65/V66): a EDIÇÃO do
    // documento aberto (PATCH /quotes/:id) e a RENOVAÇÃO da validade
    // (POST /quotes/:id/renew) — que era um beco anunciado: o servidor mandava
    // "renove a validade antes de converter" e não existia rota que
    // renovasse —, mais as SEIS da consignação: a lista (GET /consignments),
    // a ficha (GET /consignments/:id), a remessa (POST /consignments — a
    // mercadoria SAI do estoque), o retorno parcial
    // (POST /consignments/:id/retorno), o faturamento do que o cliente ficou
    // (POST /consignments/:id/faturar — é aqui que nasce a receita) e o
    // fechamento (POST /consignments/:id/fechar). AS OITO fechadas ao
    // contador: escrever documento comercial, mandar mercadoria para a rua e
    // faturá-la é operação da empresa, e ele é gente de fora que recebe o mês
    // pronto. As duas de leitura da consignação são
    // `abertaAo('balcao', 'escritorio')` — o mesmo alcance de GET /quotes,
    // porque quem está no balcão precisa saber o que a cliente levou antes de
    // conferir o que ela trouxe de volta.
    // MAIS UMA: POST /finance/entries/:id/charges/cancel — cancelar no
    // provedor a cobrança de um título que perdeu a razão de ser. Existia o
    // equivalente para o PEDIDO (`cancelOrderCharges`, três chamadores) e nada
    // para o título; o PIX/boleto ficava vivo lá fora e o cliente podia pagá-lo.
    // FECHADA ao contador, com o mesmo alcance de `/charge`
    // (requireProfile gerente_loja, gerente_oficina e os caixas): mexer na
    // cobrança de uma operação é da operação, e ele recebe o mês pronto.
    // MAIS UMA: GET /loja/prontidao-do-dia-1 (GAP-PRD-034) — o que falta
    // configurar em cada operação. FECHADA ao contador: `requireProfile`
    // gerente_loja e gerente_oficina, o alcance das telas que resolvem os itens.
    // MAIS UMA: POST /emails/:id/reenviar (GAP-PRD-038) — devolver à fila o
    // e-mail que desistiu. FECHADA ao contador (requireProfile gerente_loja,
    // gerente_oficina), como as duas irmãs da fila de e-mail.
    // MAIS TRÊS (GAP-PRD-198, GAP-PRD-036): GET e PUT /emails/identidade — quem
    // assina o e-mail da empresa, FECHADAS ao contador (requireProfile
    // gerente_loja, gerente_oficina, como a fila) — e GET
    // /workshop/orders/:id/avisos — o que a oficina mandou ao cliente, com o
    // mesmo alcance do detalhe da OS (balcão, bancada, escritório), fechada ao
    // contador.
    // MAIS DUAS (GAP-PRD-128, GAP-PRD-130): POST /mail/inbox/test — testar a
    // senha de aplicativo da caixa de NF-e sem ler nota nenhuma, FECHADA ao
    // contador (requireProfile gerente_loja, gerente_oficina, como salvar a
    // caixa) — e GET /comunicacoes/prontidao — o que falta para os e-mails
    // desta empresa saírem, FECHADA ao contador, com o alcance da fila.
    // MAIS DUAS (GAP-PRD-087): a conferência de reservas
    // (GET /stock/reconciliation, escritório) e o gesto de soltar a reserva sem
    // origem (POST /stock/reservations/:productId/liberar-sem-origem, gerência).
    // As duas fechadas ao contador: reserva é operação da prateleira.
    // MAIS DUAS (GAP-PRD-090): o pedido de compra em papel
    // (GET /purchase-orders/:id/impressao) e por e-mail ao fornecedor
    // (POST /purchase-orders/:id/email). Fechadas ao contador: comprar é
    // operação da empresa.
    // MAIS CINCO (GAP-PRD-089): a devolução ao fornecedor — o que a nota ainda
    // pode devolver (GET /purchases/notes/:id/devolviveis), a lista e a ficha
    // (GET /purchases/supplier-returns[/:id]), o registro
    // (POST /purchases/supplier-returns) e o gancho fiscal
    // (POST /purchases/supplier-returns/:id/fiscal). Fechadas ao contador: ele
    // recebe o mês pronto, não devolve mercadoria.
    // MAIS DUAS (GAP-PRD-088): a lista das notas recebidas sem conta a pagar
    // (GET /purchases/notas-sem-conta) e a decisão do dono sobre cada uma
    // (POST /purchases/notes/:id/conta-a-pagar). Fechadas ao contador: lançar
    // ou dispensar dívida é decisão da operação; ele lê o resultado no mês.
    // MAIS DUAS (GAP-PRD-165/166): a política de gestão — ler
    // (GET /management-policy, escritório) e decidir (PUT, só os donos).
    // Fechadas ao contador: quem vê dinheiro dentro da loja e qual régua vale é
    // decisão do dono; o contador CONFIRMA a régua, e o nome dele fica gravado.
    // MAIS NOVE (remediação FIN, lote N2), TODAS FECHADAS ao contador: o
    // estorno da cobrança do título (GAP-PRD-092, gerência); a consulta ao
    // provedor da conciliação e a leitura da última passada (GAP-PRD-016,
    // gerência); e as seis do PIX do balcão (GAP-PRD-077) — status, gerar,
    // consultar e cancelar o QR (balcão), a fila dos pendentes e a
    // confirmação da linha pendente (gerência). Dinheiro da operação.
    // MAIS DUAS (remediação FIN, lote N3), FECHADAS ao contador: o histórico
    // de fechamentos de comissão, lista e por id (GAP-PRD-174, gerência) —
    // é folha de pagamento da operação. E o fluxo de caixa projetado
    // (GAP-PRD-094, gerência): o saldo das contas da operação. E as duas das
    // quitações antigas sem baixa, lista e criação da baixa-espelho
    // (GAP-PRD-171, gerência): decisão sobre o caixa da operação. E a
    // conferência do aviso externo da homologação do Asaas (GAP-PRD-169,
    // gerente da loja): configuração de cobrança da operação. E a prontidão
    // do Asaas do grupo (GAP-PRD-017, só os donos do grupo).
    // MAIS UMA (GAP-PRD-105): POST /workshop/orders/:id/estorno — estornar o
    // recebimento de uma OS paga. FECHADA ao contador: é o caixa da oficina
    // desfazendo uma venda, `requireProfile` com o caixa e o gerente dela.
    // MAIS UMA (GAP-PRD-099): GET /workshop/entrada — as bancadas onde quem
    // pergunta pode abrir OS e cadastrar equipamento. FECHADA ao contador:
    // `requireProfile` com a oficina (gerente, caixa, atendente, mecânico).
    // MAIS UMA (GAP-PRD-188): POST /workshop/orders/:id/regularizar — a gestão
    // da oficina devolve ao quadro (ou encerra como lançamento indevido) a OS
    // antiga fora das regras. FECHADA ao contador: `requireProfile` com o
    // gerente da oficina.
    // MAIS DUAS (GAP-PRD-185 e GAP-PRD-190): PATCH /companies/:id/equipment-tags
    // — quem responde pelo grupo liga ou desliga a plaquinha com QR de uma
    // operação, `requireProfile(req)` sem perfil extra (admin_geral/gestor) —
    // e POST /units/:id/equipment/sheet — a loja reimprime a plaquinha da moto
    // pela unidade, `requireProfile` com gerente de loja, de oficina e
    // estoquista. As duas FECHADAS ao contador.
    // MAIS QUATRO (GAP-PRD-106): PATCH /equipment/:id/identidade — a bancada
    // corrige a identidade da máquina com motivo (`requireProfile` mecânico e
    // gerente da oficina) — e GET, POST e DELETE /equipment/:id/photos — as
    // fotos da máquina (leitura `abertaAo` balcão/bancada/escritório, escrita
    // `requireProfile` da oficina). As quatro FECHADAS ao contador.
    // MAIS UMA (GAP-PRD-111): PUT /quotes/:id/unidades — a pré-venda segura o
    // chassi do cliente do sinal. FECHADA ao contador: `requireProfile` com o
    // balcão e a gerência, os mesmos perfis que escrevem o documento.
    // MAIS UMA (GAP-PRD-189): POST /equipment/:id/owner/desfazer — a gestão da
    // oficina desfaz, com motivo, a venda à mão da plaquinha interna. FECHADA ao
    // contador: `requireProfile` com o gerente da oficina.
    // MAIS DUAS (GAP-PRD-152): POST /team/:id/remove-from-company e
    // POST /team/link — o vínculo de UMA operação ganhou alavanca própria, ao
    // lado do Desativar que desliga a conta inteira. FECHADAS ao contador: o
    // mesmo requireProfile gerente_loja/gerente_oficina do resto da equipe.
    // MAIS TRÊS (GAP-PRD-073): GET /customers/:id/dados-do-titular, POST
    // /customers/:id/anonimizar e GET /lgpd/retencao — os direitos do titular.
    // FECHADAS ao contador: requireProfile gerente_loja/gerente_oficina.
    // +3 na remediação PAG/P1 (GAP-PRD-001): as maquininhas da operação para o
    // gestor — a lista (GET /pdv/terminal/configurations) e o desligar/religar
    // (POST /pdv/terminal/configurations/:id/deactivate e /activate). AS TRÊS
    // fechadas ao contador, com o guarda da conferência de maquininha
    // (`gerente_loja`, `gerente_oficina`): desligar a maquininha desliga a
    // exigência de cobrança aprovada no cartão, e isso é decisão da operação.
    // +6 na remediação PAG/P2 (GAP-PRD-039/146/131): o cadastro de caixas —
    // GET/POST /terminals, PATCH /terminals/:id, POST /terminals/:id/deactivate
    // e /activate — e GET /cash/drawers (as gavetas abertas, para apontar a
    // esquecida). AS SEIS fechadas ao contador: ler é do balcão e do
    // escritório (`abertaAo`), escrever é da gerência (`requireProfile`).
    // +5 na remediação PAG/P5 (GAP-PRD-078/080): a fila das cobranças sem
    // venda e dos estornos a fazer (GET /pdv/terminal/pendencias) e as saídas
    // dela — POST /pdv/terminal/:id/desistir (o balcão desiste da cobrança que
    // fez), /tratativa, /vincular-venda e /estorno-manual (gerência). AS CINCO
    // fechadas ao contador: é o dinheiro da operadora, decisão da operação.
    // +4 na remediação PAG/P6 (GAP-PRD-045/046): as vendas guardadas offline
    // que o servidor recusou — GET /offline-sales (a lista), POST /offline-sales
    // (o PDV entrega a recusa), POST /offline-sales/:id/relaunch e /discard.
    // AS QUATRO fechadas ao contador: ler é do balcão e do escritório, entregar
    // e relançar são do balcão (é vender), descartar é da gerência.
    // +3 na remediação PAG/P6 (GAP-PRD-082): o cupom e a gaveta pelo agente
    // local — GET /print/jobs/:id (o PDV acompanha o cupom até o agente
    // confirmar), POST /print/printers/:id/test (a página de teste, gerência)
    // e POST /print/drawer/open (a gaveta sem venda, balcão, com motivo). AS
    // TRÊS fechadas ao contador: é o papel e a gaveta da operação.
    // +2 no lote E1 da remediação (GAP-PRD-028): GET + PUT
    // /storefront/checkout-policy — se a loja online exige conta para comprar
    // ou aceita visitante. Decisão do dono, com o mesmo guarda de
    // /storefront/settings (gerente_loja, gerente_oficina): FECHADAS ao
    // contador, que recebe o mês pronto e não abre a loja para ninguém.
    // +2 no lote E2 (GAP-PRD-027): GET + PUT /portal/login-google — a
    // configuração do "Entrar com Google" da loja, da INSTALAÇÃO:
    // requireProfile(req) sem perfil extra (admin_geral e gestor). FECHADAS
    // ao contador, que não configura a porta de entrada dos clientes.
    // +1 no lote E4 (GAP-PRD-121): POST /orders/:id/fulfillment/voltar —
    // desfazer uma etapa do pedido, com motivo; requireProfile gerente_loja.
    // FECHADA ao contador, que não mexe na expedição.
    // +1 no lote E4 (GAP-PRD-122): POST /orders/:id/devolucao/receber — o
    // recebimento conferido da mercadoria devolvida; gerente_loja e
    // estoquista. FECHADA ao contador, que não recebe mercadoria.
    // +1 no lote E4 (GAP-PRD-125): POST
    // /orders/:id/devolucao/solicitacoes/:requestId/decidir — a loja aprova ou
    // recusa o pedido de devolução do portal; gerente_loja e atendente.
    // FECHADA ao contador, que não atende cliente.
    // +4 no lote E5 (GAP-PRD-194 e GAP-PRD-123): PATCH /promotions/:id — a
    // edição da promoção ativa, gerente_loja — e os cupons da loja online:
    // GET /coupons (abertaAo escritório, como GET /promotions), POST /coupons e
    // DELETE /coupons/:id (gerente_loja). AS QUATRO fechadas ao contador, que
    // não mexe em preço nem em campanha.
    // --- frente FIS (juntada na integração) ---
    // +2 nos atos com a SEFAZ (GAP-PRD-005): o plano do ato (GET
    // /fiscal/acts/plan — para onde vai o cancelamento/CC-e/inutilização e se
    // a senha do A1 é pedida) e a política do dono (PUT /fiscal/acts/policy —
    // cofre ou senha digitada). AS DUAS fechadas ao contador: a primeira é de
    // gerência, a segunda só dos donos do grupo, o alcance do certificado.
    // +3 na fila fiscal (GAP-PRD-020): o painel da fila (GET /fiscal/queue),
    // transmitir a fila da operação (POST /fiscal/queue/drain) e transmitir
    // agora uma nota (POST /fiscal/documents/:id/transmitir). As TRÊS fechadas
    // ao contador: são de gerência (gerente_loja, gerente_oficina).
    // +4 na contingência off-line da NFC-e (GAP-PRD-098): o painel (GET
    // /fiscal/contingency), a decisão do contador gravada pelos donos (PUT
    // /fiscal/contingency/policy) e abrir/fechar o período (POST
    // /fiscal/contingency/enter e /exit, gerência). As QUATRO fechadas ao
    // contador: ele DECIDE a modalidade, mas quem grava é o dono.
    // 424 com GET /fiscal/closings/conferir (GAP-PRD-176): conferir o SHA-256
    // de um pacote recebido — ABERTA ao contador, como o download.
    // 425 com POST /fiscal/classification/reler-notas (GAP-PRD-181): reler o
    // XML guardado das notas já recebidas — FECHADA ao contador (gerência).
    // 427 com GET e PUT /fiscal/emission-policy (GAP-PRD-163): a NFC-e no
    // Finalizar — FECHADAS ao contador, que não decide o balcão.
    // +8 da NFS-e (GAP-PRD-024), em `nfse.ts`, montado dentro do núcleo — que
    // a varredura passou a ler na junção: a configuração (GET e PATCH
    // /fiscal/nfse/config), a prontidão (GET /fiscal/nfse/readiness) e a lista
    // (GET /fiscal/nfse/documents), de gerência; a NFS-e da venda (GET e POST
    // /fiscal/sales/:saleId/nfse) e o registro da emitida no portal (POST
    // /fiscal/sales/:saleId/nfse/manual), de caixa e gerência; e o registro do
    // cancelamento (POST /fiscal/nfse/:id/cancel-record), de gerência. AS OITO
    // fechadas ao contador: ele recebe a NFS-e no pacote, não a emite.
    // Na integração: 490 do núcleo + 13 da FIS em core.ts + 8 de nfse.ts + 11 da ECO.
    // 524 com GET e POST /fiscal/nfce/csc (GAP-PRD-075): o CSC saiu do
    // `nfceRouter` legado e entrou no núcleo — FECHADAS ao contador, que não
    // configura a emissão (alcance: admin_geral, gestor, gerente_loja).
    // 525 com POST /offline-sales/:id/relaunch-as-new (RES-IDEM-TELA): a venda
    // guardada cuja chave já registrou OUTRA venda vira venda nova — FECHADA ao
    // contador, com o alcance do relançamento (é vender).
    // 526 com POST /orders/:id/nfe/municipio (R3-IBGE, GAP-PRD-028): a gerência
    // corrige o município do endereço da nota que a tabela do IBGE desmente —
    // FECHADA ao contador, com o alcance da emissão da nota do pedido.
    // 527 com DELETE /products/:id (frente PRODUTO): a exclusão controlada do
    // produto sem histórico — FECHADA ao contador (gerente_loja e
    // gerente_oficina, o par que responde pelo catálogo).
    // 534 com as 7 do balcão da Preço Justo: os modelos de etiqueta (GET, POST,
    // PATCH, DELETE /labels/templates e POST /labels/templates/preview), o
    // próximo código interno (POST /products/codes/next) e o código de barras
    // interno (POST /products/:id/barcode/internal) — TODAS fechadas ao contador.
    // 538 com as 4 da auditoria da Preço Justo: POST /sales/abandoned (rastro do
    // F6), POST /print/jobs/:id/desistir (desistência atômica do cupom) e GET/PUT
    // /catalog/scale-label (etiqueta da balança) — TODAS fechadas ao contador.
    // 539 com POST /sale-returns/:id/refunds (o reembolso da devolução em duas
    // etapas da Preço Justo) — FECHADA ao contador.
    // 541 com as 2 das miniaturas do PDV (auditoria P0): GET
    // /products/fotos-sem-miniatura e PUT /products/:id/images/:imageId/thumbnail
    // — as duas sob products.manage, FECHADAS ao contador.
    // 544 com as 3 do P0 das etiquetas: o histórico (GET /labels/prints), a
    // reimpressão (POST /labels/prints/:id/reprint) e a etiqueta de teste
    // (POST /labels/test) — TODAS fechadas ao contador: ele não imprime etiqueta.
    expect(rotas).toHaveLength(544);
  });

  it('as portas do contador existem no roteador com esse nome exato', () => {
    // A tabela `ABERTAS` casa por texto. Se alguém renomear `/pacote`, a
    // varredura passaria a esperar 403 nela — e a rota, aberta, responderia
    // 200: vermelho certo, mas com a mensagem errada. Este caso dá a mensagem
    // certa.
    const existentes = new Set(rotas.map(chaveDe));
    for (const chave of Object.keys(ABERTAS)) {
      expect(existentes.has(chave), `${chave} não existe mais no núcleo (core.ts, nfse.ts)`).toBe(true);
    }
  });

  it('todo roteador montado dentro do núcleo é varrido — sub-roteador não vira porta', () => {
    /*
      O `nfseRouter` (GAP-PRD-024) entrou por `coreRouter.use(...)` e ficou
      fora desta varredura até a junção da frente FIS: oito rotas do núcleo
      sem a prova de que o contador é recusado nelas. O próximo sub-roteador
      montado no núcleo precisa entrar em `ROTEADORES_DO_NUCLEO`.
    */
    const montados = roteadoresMontadosNoNucleo();
    expect(montados).toContain('nfseRouter');
    const varridos = new Set<string>(ROTEADORES_DO_NUCLEO.map((r) => r.roteador));
    expect(montados.filter((r) => !varridos.has(r))).toEqual([]);
  });

  it('nenhuma rota aparece duas vezes — duplicata esconderia a segunda', () => {
    const vistas = new Map<string, number>();
    for (const r of rotas) vistas.set(chaveDe(r), (vistas.get(chaveDe(r)) ?? 0) + 1);
    expect([...vistas].filter(([, n]) => n > 1)).toEqual([]);
  });
});

describe('o contador é recusado em TODAS as rotas do núcleo, menos nas abertas', () => {
  it('as fechadas respondem 403 — nem 401, nem 404, nem 200', () => {
    const fechadas = medidas.filter((m) => !(m.chave in ABERTAS));
    // 520: as 518 de antes + GET e POST /fiscal/nfce/csc (GAP-PRD-075), as duas
    // do CSC que entraram no núcleo e são de gerência.
    // 521 com POST /offline-sales/:id/relaunch-as-new (RES-IDEM-TELA), do balcão.
    // 522 com POST /orders/:id/nfe/municipio (R3-IBGE), da gerência.
    // 523 com DELETE /products/:id (frente PRODUTO), da gerência do catálogo.
    // 530 com as 7 do balcão da Preço Justo (modelos de etiqueta, próximo código
    // interno, código de barras interno): o contador não imprime nem cadastra.
    // 534 com as 4 da auditoria da Preço Justo (abandono do carrinho, desistência do
    // cupom, leitura e declaração da etiqueta da balança): o contador não opera balcão
    // nem cadastro.
    // 535 com o reembolso da devolução em duas etapas: o contador não devolve dinheiro.
    // 537 com as 2 das miniaturas do PDV (auditoria P0): o contador não mexe em foto.
    // 540 com as 3 do P0 das etiquetas (histórico, reimpressão e etiqueta de
    // teste): o contador não imprime etiqueta.
    expect(fechadas).toHaveLength(540);

    /*
      O relatório é a lista de quem DIVERGIU, com o status medido e a linha do
      arquivo. Um `expect` por rota daria centenas de casos e um vermelho ilegível;
      esta forma dá um vermelho que se lê e se conserta.
    */
    const divergentes = fechadas
      .filter((m) => m.status !== 403)
      .map((m) => `${m.arquivo}:${m.linha} ${m.chave} → ${m.status}`);
    expect(divergentes).toEqual([]);
  });

  it('e o 403 vem do RBAC, não de outro erro que por acaso é 403', () => {
    // Sem isto, uma rota que passasse a devolver 403 por qualquer outro motivo
    // — assinatura, idempotência, limite — passaria por "guarda funcionando".
    const fechadas = medidas.filter((m) => !(m.chave in ABERTAS));
    const outroMotivo = fechadas
      .filter((m) => m.codigo !== 'API_PERMISSION_DENIED')
      .map((m) => `${m.arquivo}:${m.linha} ${m.chave} → ${m.codigo ?? '(sem código)'}`);
    expect(outroMotivo).toEqual([]);
  });

  it('nenhuma rota devolve 404 ANTES do guarda — se devolver, é achado e é relatado', () => {
    /*
      O 404 antes do guarda é um defeito de verdade e não um detalhe de teste:
      significa que a rota BUSCOU no banco antes de perguntar quem estava
      pedindo. Além de contar o que não devia contar — "este id existe" é
      informação —, é o começo do caminho em que a busca faz efeito colateral.

      Este caso separa esse achado do vermelho genérico do caso acima, porque a
      correção é diferente: lá se acrescenta perfil ao guarda; aqui se MOVE o
      guarda para a primeira linha do `try`.
    */
    const cedoDemais = medidas
      .filter((m) => !(m.chave in ABERTAS) && m.status === 404)
      .map((m) => `${m.arquivo}:${m.linha} ${m.chave} — buscou antes de guardar`);
    expect(cedoDemais).toEqual([]);
  });

  it('as abertas respondem o que cada uma tem de responder, uma por uma', () => {
    for (const [chave, esperado] of Object.entries(ABERTAS)) {
      const medida = medidas.find((m) => m.chave === chave);
      expect(medida, `${chave} não foi varrida`).toBeDefined();
      expect(medida!.status, `${chave}`).toBe(esperado);
    }
  });

  it('a nota inexistente devolve 404 do CATÁLOGO, e não 404 de rota que não existe', () => {
    // A diferença importa: `404` do Express (rota inexistente) e `404` da
    // consulta (nota inexistente) têm o mesmo número e significados opostos. O
    // segundo é o que prova que o contador atravessou o guarda.
    const xml = medidas.find((m) => m.chave === 'GET /purchases/notes/:id/xml');
    expect(xml!.codigo).toBe('CORE_INBOUND_NOTE_NOT_FOUND');
  });
});

describe('a varredura mede o guarda, e não a sorte', () => {
  it('o mesmo perfil sem token nenhum recebe 401, e não 403', async () => {
    // Prova que os 403 acima não vieram de "requisição malformada": sem token
    // o número é outro, e é o número certo.
    const res = await request(createApp()).get(`${MONTAGEM}/dashboard`);
    expect(res.status).toBe(401);
  });

  it('um gerente de loja recebe 200 numa amostra das rotas que negam o contador', async () => {
    /*
      O caso que impede o desastre oposto. Um `requireProfile` que negasse
      TODO MUNDO deixaria todos os 403 verdes e o produto morto — e é exatamente o
      formato de erro que uma rodada de fechamento produz.

      Três rotas sem parâmetro, de três assuntos que o contador não alcança:
      o dinheiro, a equipe e o produto.
    */
    const app = createApp();
    const login = await loginForTest(app, {
      userId: 'gerente-da-varredura',
      companyId: EMPRESA,
      profileCodes: ['gerente_loja'],
    });
    expect(login.status).toBe(200);
    const token = login.body.accessToken as string;

    for (const rota of ['/finance/entries', '/team', '/products']) {
      const res = await request(app).get(MONTAGEM + rota).set('Authorization', `Bearer ${token}`);
      expect(res.status, `gerente_loja em ${rota}`).toBe(200);
    }
  });
});
