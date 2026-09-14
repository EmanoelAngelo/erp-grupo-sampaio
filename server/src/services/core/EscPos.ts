/**
 * ============================================================================
 * ESC/POS — O CUPOM E A GAVETA NA LÍNGUA DA IMPRESSORA TÉRMICA (GAP-V55)
 * ============================================================================
 *
 * ## O que este arquivo NÃO promete
 *
 * Ele NÃO faz o navegador imprimir em silêncio, e NÃO faz o navegador abrir a
 * gaveta. Nenhum navegador expõe porta serial/USB/raw de impressora para uma
 * página, e o caminho de impressão dele passa pelo DRIVER, que rasteriza a
 * página: bytes de comando embutidos num HTML saem impressos como texto, não
 * executados como comando. Escrever "abrir gaveta" num cupom HTML e mandar
 * imprimir não abriria gaveta nenhuma — imprimiria a palavra.
 *
 * Isso não é limitação deste sistema; é o que o ambiente permite. E prometer o
 * contrário na tela seria o pior desfecho possível: o operador confiaria, a
 * gaveta ficaria fechada com o cliente esperando o troco, e a culpa cairia num
 * botão que nunca poderia funcionar.
 *
 * ## O que ele FAZ, e por que isso vale
 *
 * Produz o documento REAL que uma térmica entende — texto em coluna de 32/48
 * caracteres com os comandos de alinhamento, corte e PULSO DE GAVETA — pronto
 * para quem tem acesso à porta da impressora:
 *
 *   - o AGENTE LOCAL (o transporte que `core_printers.transport = 'agent'` já
 *     modela) lê o job e escreve estes bytes na porta;
 *   - uma impressora ligada em rede aceita o mesmo fluxo por socket 9100;
 *   - o driver Windows configurado como "genérico / somente texto" também.
 *
 * Sem isto, o dia em que o agente existir ele teria de reimplementar o layout
 * do cupom — uma segunda verdade sobre o mesmo papel, para divergir da
 * primeira no primeiro ajuste de preço.
 *
 * ## O PULSO DA GAVETA, byte a byte
 *
 * `ESC p m t1 t2` (0x1B 0x70). `m` é o conector (0 ou 1 — quase todo mundo usa
 * o 0), `t1` e `t2` são a duração do pulso em unidades de 2 ms. Os valores
 * abaixo (25 e 250 → 50 ms ligado, 500 ms de intervalo) são os que a maioria
 * das gavetas do mercado aceita; gaveta que não abre com eles não abre com
 * nenhum outro sem manual do fabricante.
 *
 * ## Centavos, sempre
 *
 * O dinheiro chega aqui em CENTAVOS INTEIROS e só vira texto na última linha.
 * Nenhuma conta acontece neste arquivo: ele formata o que o `PrintRenderer` já
 * apurou.
 */
import { getConnection } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';
import { impressoraDoDocumento, oQueFaltaNaImpressoraDeAgente, ondeMoraOAgente, type Printer } from './PrintEngine.js';
import { larguraDaBobina, type LarguraDaBobina } from './PapelDaLoja.js';
import { dadosDoCupom, empresaDoPapel, quantidadeLegivel } from './PrintRenderer.js';

/** Comandos ESC/POS usados aqui, nomeados — byte solto no meio do código mente. */
const ESC = 0x1b;
const GS = 0x1d;

/** `ESC @` — reinicia a impressora e limpa formatação pendente. */
const INICIALIZAR = Uint8Array.from([ESC, 0x40]);
/** `ESC a n` — alinhamento: 0 esquerda, 1 centro. */
const CENTRALIZAR = Uint8Array.from([ESC, 0x61, 1]);
const ALINHAR_ESQUERDA = Uint8Array.from([ESC, 0x61, 0]);
/** `ESC E n` — negrito liga/desliga. */
const NEGRITO_ON = Uint8Array.from([ESC, 0x45, 1]);
const NEGRITO_OFF = Uint8Array.from([ESC, 0x45, 0]);
/** `GS V m` — corte parcial do papel. */
const CORTAR = Uint8Array.from([GS, 0x56, 0x42, 0x00]);

/**
 * `ESC p m t1 t2` — o pulso que abre a gaveta.
 *
 * Exportado sozinho porque ele TAMBÉM é o comando avulso: abrir a gaveta sem
 * imprimir nada (sangria, troca de turno) é o mesmo pulso, sem cupom em volta.
 */
export function pulsoDaGaveta(conector: 0 | 1 = 0): Uint8Array {
  return Uint8Array.from([ESC, 0x70, conector, 25, 250]);
}

/**
 * Texto para a página de código da térmica.
 *
 * A maioria das impressoras de cupom sai de fábrica em CP850/CP437, e nenhuma
 * delas fala UTF-8: mandar "Ação" em UTF-8 imprime dois caracteres estranhos no
 * lugar do "ç". Transliterar o acento é FEIO e LEGÍVEL; o inverso é ilegível.
 * Quem tem impressora configurada em UTF-8 não perde nada — o texto continua
 * correto, só sem acento.
 */
function paraTermica(texto: string): string {
  return texto
    // Travessão e ponto médio (os rótulos e o endereço do cupom os usam) viram
    // hífen: sem isto sairiam como espaço, e "PIX — aguardando" virava "PIX   aguardando".
    .replace(/[–—·]/g, '-')
    .normalize('NFD')
    // Os acentos separados pelo NFD (U+0300–U+036F) saem; o que sobra fora do
    // ASCII imprimível vira espaço, porque byte alto sem página de código
    // combinada imprime lixo.
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\x20-\x7e\n]/g, ' ');
}

function bytes(texto: string): Uint8Array {
  const t = paraTermica(texto);
  const saida = new Uint8Array(t.length);
  for (let i = 0; i < t.length; i += 1) saida[i] = t.charCodeAt(i) & 0xff;
  return saida;
}

function juntar(partes: Uint8Array[]): Uint8Array {
  const total = partes.reduce((acc, p) => acc + p.length, 0);
  const saida = new Uint8Array(total);
  let pos = 0;
  for (const parte of partes) {
    saida.set(parte, pos);
    pos += parte.length;
  }
  return saida;
}

function brl(cents: number): string {
  return (cents / 100).toFixed(2).replace('.', ',');
}

/*
  NENHUMA LINHA PASSA DA BOBINA (auditoria do cupom, F-17).

  O nome longo ia inteiro e a própria impressora o quebrava no meio da
  palavra; "Venda #12345  14/09/2026, 10:30:00" tem 34 caracteres e não cabe
  em 32; e o "rótulo…valor" que não coubesse ganhava UM espaço e seguia
  adiante, empurrando o valor para o começo da linha de baixo, desalinhado.
  Agora o texto é quebrado por palavra na largura da bobina, e o valor que
  não cabe ao lado do rótulo desce para uma linha própria, alinhado à direita.
*/
function quebrar(texto: string, largura: number): string[] {
  const linhas: string[] = [];
  for (const paragrafo of paraTermica(texto).split('\n')) {
    // O que já cabe sai como veio — inclusive o recuo do começo.
    if (paragrafo.length <= largura) {
      if (paragrafo.trim()) linhas.push(paragrafo);
      continue;
    }
    let atual = '';
    for (const palavra of paragrafo.trim().split(/\s+/)) {
      let resto = palavra;
      // Palavra maior que a linha inteira (código, e-mail) é partida.
      while (resto.length > largura) {
        if (atual) linhas.push(atual);
        atual = '';
        linhas.push(resto.slice(0, largura));
        resto = resto.slice(largura);
      }
      if (!resto) continue;
      if (!atual) atual = resto;
      else if (atual.length + 1 + resto.length <= largura) atual = `${atual} ${resto}`;
      else {
        linhas.push(atual);
        atual = resto;
      }
    }
    if (atual) linhas.push(atual);
  }
  return linhas;
}

/** Texto corrido, quebrado na largura da bobina. */
function paragrafo(texto: string, largura: number): string {
  const linhas = quebrar(texto, largura);
  return linhas.length > 0 ? `${linhas.join('\n')}\n` : '';
}

/** Rótulo à esquerda, valor à direita, na largura da bobina. */
function linhaDupla(esquerda: string, direita: string, largura: number): string {
  const d = paraTermica(direita);
  const linhas = quebrar(esquerda, largura);
  if (linhas.length === 0) linhas.push('');
  const ultima = linhas[linhas.length - 1];
  if (ultima.length + 1 + d.length <= largura) {
    linhas[linhas.length - 1] = `${ultima}${' '.repeat(largura - ultima.length - d.length)}${d}`;
  } else {
    linhas.push(`${' '.repeat(Math.max(0, largura - d.length))}${d}`);
  }
  return `${linhas.join('\n')}\n`;
}

export interface CupomTermico {
  loja: string;
  cnpj: string | null;
  /** Endereço e telefone da loja — o cliente precisa saber para onde voltar. */
  endereco?: string | null;
  telefone?: string | null;
  numero: number;
  quando: string;
  /** A tarja da venda cancelada ("VENDA CANCELADA em ..."), quando for o caso. */
  cancelada?: string | null;
  itens: {
    descricao: string;
    /** Número, ou já no formato do papel ("0,5"). */
    quantidade: number | string;
    /** Total LÍQUIDO da linha, depois do desconto do item. */
    totalCents: number;
    /** Com o unitário, a linha sai "qtd x unitário ... bruto", como no HTML. */
    unitarioCents?: number;
    descontoCents?: number;
    /** "KG", "M"... Ausente para a unidade comum. */
    unidade?: string | null;
    /** Chassi, motor, IMEI da unidade vendida. */
    identidades?: string[];
  }[];
  subtotalCents?: number;
  descontoCents?: number;
  acrescimoCents?: number;
  totalCents: number;
  /** O rótulo JÁ legível ("Cartão de crédito"), e não o código do banco. */
  pagamentos: { metodo: string; valorCents: number; destaque?: boolean }[];
  /** Quanto dos pagamentos ainda não foi confirmado (PIX pendente). */
  aReceberCents?: number;
  trocoCents?: number;
  /** Largura da bobina em caracteres: 32 (58 mm) ou 48 (80 mm). */
  colunas?: 32 | 48;
  /** Abre a gaveta ao fim da impressão. Só faz sentido quando houve espécie. */
  abrirGaveta?: boolean;
}

/**
 * O cupom da venda em ESC/POS.
 *
 * Mesmo conteúdo do cupom HTML, porque é o MESMO papel visto por outro
 * transporte. Divergir aqui faria a via impressa pelo agente contradizer a via
 * impressa pelo navegador, e não haveria como saber qual das duas o cliente
 * levou.
 *
 * E divergia (auditoria do cupom, F-06): a térmica imprimia só "2 un" e o
 * total líquido da linha, o TOTAL e o código cru do meio — sem unitário,
 * desconto, acréscimo, subtotal, troco, vale ou "A PRAZO". Venda de R$ 100 com
 * R$ 10 de desconto, paga com R$ 100 em dinheiro, saía "TOTAL 90,00 / dinheiro
 * 100,00" sem a linha do desconto e sem o TROCO: o cliente não fechava a conta
 * e o caixa não tinha o troco no papel. Os campos agora são os de
 * `dadosDoCupom`, a mesma leitura do HTML.
 */
export function cupomEscPos(cupom: CupomTermico): Uint8Array {
  const largura = cupom.colunas ?? 48;
  const traco = `${'-'.repeat(largura)}\n`;
  const partes: Uint8Array[] = [INICIALIZAR, CENTRALIZAR, NEGRITO_ON];

  // Cancelada vem ANTES de tudo, como no HTML: quem pega o papel vê primeiro.
  if (cupom.cancelada) {
    partes.push(bytes(paragrafo(`*** ${cupom.cancelada} ***`, largura)));
    partes.push(bytes(paragrafo('NAO VALE COMO COMPROVANTE DE COMPRA', largura)));
  }
  partes.push(bytes(paragrafo(cupom.loja, largura)));
  partes.push(NEGRITO_OFF);
  if (cupom.cnpj) partes.push(bytes(paragrafo(`CNPJ ${cupom.cnpj}`, largura)));
  if (cupom.endereco) partes.push(bytes(paragrafo(cupom.endereco, largura)));
  if (cupom.telefone) partes.push(bytes(paragrafo(`Fone ${cupom.telefone}`, largura)));
  partes.push(bytes('GRUPO SAMPAIO\n'));
  // O mesmo aviso do cupom HTML, no topo: quem lê o papel sabe na hora que
  // não é NFC-e (a nota, quando há, sai no DANFCE).
  partes.push(NEGRITO_ON);
  partes.push(bytes('COMPROVANTE NAO FISCAL\n'));
  partes.push(NEGRITO_OFF);
  partes.push(ALINHAR_ESQUERDA);
  partes.push(bytes(traco));
  partes.push(bytes(linhaDupla(`Venda #${cupom.numero}`, cupom.quando, largura)));
  partes.push(bytes(traco));

  for (const item of cupom.itens) {
    const quantidade =
      typeof item.quantidade === 'number' ? quantidadeLegivel(item.quantidade) : item.quantidade;
    const desconto = Number(item.descontoCents ?? 0);
    partes.push(bytes(paragrafo(item.descricao, largura)));
    for (const identidade of item.identidades ?? []) {
      partes.push(bytes(paragrafo(identidade, largura)));
    }
    if (item.unitarioCents !== undefined) {
      // "qtd x unitário ... bruto": quem confere multiplica, e o número ao lado
      // tem que ser o produto. O desconto do item vem numa linha própria.
      const unidade = item.unidade ? ` ${item.unidade}` : '';
      partes.push(
        bytes(
          linhaDupla(`  ${quantidade}${unidade} x ${brl(item.unitarioCents)}`, brl(item.totalCents + desconto), largura),
        ),
      );
      if (desconto > 0) {
        partes.push(bytes(linhaDupla('  Desconto do item', `-${brl(desconto)}`, largura)));
      }
    } else {
      partes.push(bytes(linhaDupla(`  ${quantidade} un`, brl(item.totalCents), largura)));
    }
  }

  partes.push(bytes(traco));
  if (cupom.subtotalCents !== undefined) {
    partes.push(bytes(linhaDupla('Subtotal', brl(cupom.subtotalCents), largura)));
  }
  if (Number(cupom.descontoCents ?? 0) > 0) {
    partes.push(bytes(linhaDupla('Desconto', `-${brl(Number(cupom.descontoCents))}`, largura)));
  }
  if (Number(cupom.acrescimoCents ?? 0) > 0) {
    partes.push(bytes(linhaDupla('Acrescimo', `+${brl(Number(cupom.acrescimoCents))}`, largura)));
  }
  partes.push(NEGRITO_ON);
  partes.push(bytes(linhaDupla('TOTAL', brl(cupom.totalCents), largura)));
  partes.push(NEGRITO_OFF);
  partes.push(bytes(traco));

  for (const pagamento of cupom.pagamentos) {
    if (pagamento.destaque) partes.push(NEGRITO_ON);
    partes.push(bytes(linhaDupla(pagamento.metodo, brl(pagamento.valorCents), largura)));
    if (pagamento.destaque) partes.push(NEGRITO_OFF);
  }
  if (Number(cupom.trocoCents ?? 0) > 0) {
    partes.push(NEGRITO_ON);
    partes.push(bytes(linhaDupla('TROCO', brl(Number(cupom.trocoCents)), largura)));
    partes.push(NEGRITO_OFF);
  }
  if (Number(cupom.aReceberCents ?? 0) > 0) {
    partes.push(NEGRITO_ON);
    partes.push(
      bytes(
        paragrafo(
          `A RECEBER ${brl(Number(cupom.aReceberCents))}: pagamento ainda nao confirmado. `
            + 'Este papel nao comprova o pagamento dessa parte.',
          largura,
        ),
      ),
    );
    partes.push(NEGRITO_OFF);
  }

  partes.push(bytes('\n'));
  partes.push(CENTRALIZAR);
  partes.push(bytes('Documento nao fiscal\n\n\n'));

  /*
    O PULSO VEM ANTES DO CORTE, e a ordem importa: depois do corte a
    impressora pode já ter descarregado o buffer, e o pulso se perde. É o
    detalhe que faz "às vezes a gaveta não abre" — o pior tipo de defeito de
    balcão, porque parece intermitente e é determinístico.
  */
  if (cupom.abrirGaveta) partes.push(pulsoDaGaveta());
  partes.push(CORTAR);

  return juntar(partes);
}

/**
 * A PÁGINA DE TESTE da impressora de agente (GAP-PRD-082).
 *
 * É a prova que a tela de Impressoras pede antes de dizer "impressão direta":
 * o agente retira este job, escreve na impressora e confirma. Ela diz onde
 * saiu e quando, e testa a coluna inteira — uma bobina de 58 mm configurada
 * como 80 mm corta a linha de hífens no meio, e o erro aparece aqui, não no
 * primeiro cupom de cliente.
 */
export function paginaDeTesteEscPos(input: {
  loja: string;
  impressora: string;
  quando: string;
  colunas?: 32 | 48;
}): Uint8Array {
  const largura = input.colunas ?? 48;
  return juntar([
    INICIALIZAR,
    CENTRALIZAR,
    NEGRITO_ON,
    bytes('PAGINA DE TESTE\n'),
    NEGRITO_OFF,
    bytes(`${input.loja}\n`),
    ALINHAR_ESQUERDA,
    bytes(`${'-'.repeat(largura)}\n`),
    bytes(`Impressora: ${input.impressora}\n`),
    bytes(`Quando: ${input.quando}\n`),
    bytes(`Colunas: ${largura}\n`),
    bytes(`${'-'.repeat(largura)}\n`),
    bytes(linhaDupla('Acentos', 'sem acento', largura)),
    bytes(linhaDupla('Total de teste', brl(12345), largura)),
    CENTRALIZAR,
    bytes('Se voce le isto, o agente imprime aqui.\n\n\n'),
    CORTAR,
  ]);
}

/**
 * O cupom ESC/POS de uma venda que já existe.
 *
 * Lê pela MESMA função do cupom HTML (`dadosDoCupom`) — e por isso não há
 * segunda aritmética nem segunda leitura: os totais saem gravados da venda, o
 * meio sai pelo nome que o cliente lê, o CNPJ formatado, a hora no relógio da
 * loja (antes: `toLocaleString` sem fuso, o relógio do servidor), o vale, o
 * PIX pendente e a tarja de cancelada.
 */
export function cupomEscPosDaVenda(
  companyId: string,
  saleId: string,
  opcoes: { abrirGaveta?: boolean; colunas?: 32 | 48 } = {},
): Uint8Array {
  const d = dadosDoCupom(companyId, saleId);

  return cupomEscPos({
    loja: d.empresa.trade_name || 'Loja',
    cnpj: d.empresa.cnpj,
    endereco: d.empresa.endereco,
    telefone: d.empresa.phone,
    numero: d.numero,
    quando: d.quando,
    cancelada: d.cancelada ? `VENDA CANCELADA${d.canceladaEm ? ` em ${d.canceladaEm}` : ''}` : null,
    itens: d.itens.map((i) => ({
      descricao: i.descricao,
      quantidade: i.quantidade,
      unidade: i.unidade,
      unitarioCents: i.unitarioCents,
      descontoCents: i.descontoCents,
      totalCents: i.totalCents,
      identidades: i.identidades,
    })),
    subtotalCents: d.subtotalCents,
    descontoCents: d.descontoCents,
    acrescimoCents: d.acrescimoCents,
    totalCents: d.totalCents,
    pagamentos: d.meios.map((m) => ({ metodo: m.rotulo, valorCents: m.valorCents, destaque: m.destaque })),
    aReceberCents: d.aReceberCents,
    trocoCents: d.trocoCents,
    ...opcoes,
  });
}

export interface ProntidaoDaGaveta {
  /**
   * A gaveta abre POR COMANDO neste caixa, AGORA?
   *
   * Só quando a impressora de cupom de AGENTE LOCAL deste caixa (ou a da
   * operação) tem endereço E o agente dela está no ar (GAP-PRD-082). Antes
   * bastava a impressora estar cadastrada como "agente" — e nenhum programa
   * consumia o comando: era a promessa que o navegador não cumpre, com outro
   * nome.
   */
  byCommand: boolean;
  /** Quantas impressoras de agente estão registradas e ativas. */
  agentPrinters: number;
  /** A impressora de cupom de agente que atende este caixa, se houver. */
  printerId: string | null;
  /** O agente daquela impressora está falando (sinal nos últimos 90 s)? */
  agentOnline: boolean;
  /** O que a pessoa no balcão precisa saber, em uma frase. */
  message: string;
  /**
   * O pulso, em base64, para quem TEM a porta.
   *
   * Viaja sempre, inclusive sem agente: é o dado que o instalador do agente (ou
   * quem configura uma impressora de rede na porta 9100) precisa ter em mãos.
   * Devolver o comando não é o mesmo que prometer que ele será executado — e a
   * frase acima diz exatamente qual dos dois é o caso.
   */
  command: string;
  /**
   * A largura da bobina do CUPOM deste caixa (58 ou 80 mm), em qualquer
   * transporte — é a mesma que o papel do servidor usaria (PED-pdv-01#largura).
   *
   * O PDV guarda este número para o comprovante que ele monta SOZINHO quando o
   * servidor não responde (venda offline). Sem impressora de cupom, ou com ela
   * sem medida cadastrada, vale 80 — o mesmo padrão do papel do servidor.
   */
  paperWidthMm: LarguraDaBobina;
  /**
   * A loja como o cabeçalho do cupom a diz — nome, CNPJ, endereço e telefone
   * (F-cupom-fiscal-20#reauditoria).
   *
   * Viaja pelo mesmo motivo da largura: o PDV guarda para o comprovante que
   * monta SOZINHO na venda offline, quando o servidor não responde e não há a
   * quem perguntar. Sem cadastro fiscal ainda, endereço e telefone vêm nulos —
   * como no cupom, que também sai sem essas linhas.
   */
  loja: LojaDoPapel;
}

/** A identidade da loja no papel, na forma que o navegador guarda. */
export interface LojaDoPapel {
  nome: string;
  /** Já formatado ("12.345.678/0001-90"), pela mesma régua do cupom. */
  cnpj: string | null;
  endereco: string | null;
  telefone: string | null;
}

/**
 * A verdade sobre a gaveta, nesta operação, agora.
 *
 * Uma tela de balcão não pode ter um botão "Abrir gaveta" que às vezes é
 * decorativo. Esta função é o que decide se o botão existe — e, quando não
 * existe, o que a tela diz no lugar dele.
 */
export function prontidaoDaGaveta(companyId: string, pdvTerminalId: string | null = null): ProntidaoDaGaveta {
  ensureCoreSchema();
  const db = getConnection();
  const agentes = db
    .prepare(
      `SELECT COUNT(*) AS n FROM core_printers
        WHERE company_id = ? AND active = 1 AND transport = 'agent'`,
    )
    .get(companyId) as { n: number };

  const command = Buffer.from(pulsoDaGaveta()).toString('base64');

  /*
    A LARGURA DA BOBINA DESTE CAIXA (PED-pdv-01#largura).

    O DEFEITO: esta resposta só olhava a impressora de AGENTE e não dizia a
    largura da bobina. O PDV lê `paperWidthMm` daqui para o comprovante que
    monta sozinho na venda offline — sem o número, ficava sempre em 80 mm, e o
    caixa com térmica de 58 mm pelo navegador (o caso comum: nenhum agente)
    imprimia o comprovante cortado justamente no dia em que é o único papel
    que o cliente leva.

    A impressora é a MESMA que a fila escolheria para o cupom deste caixa
    (`impressoraDoDocumento`: a de cupom do caixa antes da da operação, a padrão
    primeiro), em QUALQUER transporte; a medida passa pela mesma régua do papel
    do servidor (`larguraDaBobina`: abaixo de 70 mm é 58; sem medida, 80). Duas
    regras aqui fariam o comprovante offline e o cupom do servidor saírem em
    larguras diferentes na mesma térmica.
  */
  const paperWidthMm = larguraDaBobina(impressoraDoDocumento(companyId, 'PDV_RECEIPT', pdvTerminalId)?.paper_width_mm);

  /*
    A LOJA DO COMPROVANTE OFFLINE (F-cupom-fiscal-20#reauditoria).

    O DEFEITO: o PDV montava o comprovante da venda offline só com o nome
    fantasia da sessão — a sessão não conhece CNPJ nem endereço, e nenhuma
    resposta os entregava. Vai aqui, ao lado da largura, porque esta é a
    pergunta que o PDV já faz (e guarda) enquanto o servidor responde; e vem
    de `empresaDoPapel`, a mesma leitura do cabeçalho do cupom.
  */
  const empresa = empresaDoPapel(companyId);
  const loja: LojaDoPapel = {
    nome: empresa.trade_name,
    cnpj: empresa.cnpj,
    endereco: empresa.endereco,
    telefone: empresa.phone,
  };

  if (agentes.n === 0) {
    return {
      byCommand: false,
      agentPrinters: 0,
      printerId: null,
      agentOnline: false,
      message:
        'O navegador não abre a gaveta por comando, e nenhum agente local está registrado '
        + 'nesta operação. Hoje a gaveta abre pela chave ou pela opção "abrir gaveta ao '
        + 'imprimir" no driver da impressora térmica — o cupom sai pela caixa de diálogo do '
        + 'navegador.',
      command,
      paperWidthMm,
      loja,
    };
  }

  // A térmica de cupom deste caixa; sem ela, a da operação (agente sem caixa).
  const impressora = db
    .prepare(
      `SELECT * FROM core_printers
        WHERE company_id = ? AND active = 1 AND transport = 'agent' AND kind = 'cupom'
          AND (pdv_terminal_id IS NULL OR pdv_terminal_id = ?)
        ORDER BY (pdv_terminal_id IS NOT NULL) DESC, is_default DESC, created_at LIMIT 1`,
    )
    .get(companyId, pdvTerminalId) as Printer | undefined;

  if (!impressora) {
    return {
      byCommand: false,
      agentPrinters: agentes.n,
      printerId: null,
      agentOnline: false,
      message:
        'Nenhuma impressora de cupom de agente local atende este caixa. A gaveta abre pela chave ou pela '
        + 'opção "abrir gaveta ao imprimir" do driver — o cupom sai pela caixa de diálogo do navegador.',
      command,
      paperWidthMm,
      loja,
    };
  }

  const falta = oQueFaltaNaImpressoraDeAgente(companyId, impressora);
  if (falta) {
    return {
      byCommand: false,
      agentPrinters: agentes.n,
      printerId: impressora.id,
      agentOnline: false,
      message:
        `${falta} Até lá, a gaveta abre pela chave ou pelo driver, e o cupom sai pela caixa de diálogo do navegador.`,
      command,
      paperWidthMm,
      loja,
    };
  }

  return {
    byCommand: true,
    agentPrinters: agentes.n,
    printerId: impressora.id,
    agentOnline: true,
    message:
      `Cupom direto na térmica "${impressora.name}" e gaveta por comando, pelo agente local `
      + `${ondeMoraOAgente(companyId, impressora)}.`,
    command,
    paperWidthMm,
    loja,
  };
}
