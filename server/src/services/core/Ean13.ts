/**
 * Código de barras EAN-13 desenhado em SVG.
 *
 * POR QUE ISTO EXISTE DUAS VEZES
 *
 * `src/components/gs/Barcode.tsx` faz o mesmo desenho no navegador. O servidor
 * não consegue importar de lá: são dois pacotes, o `server/tsconfig.json` tem
 * `rootDir: src` e nenhum caminho para fora. Unificar exigiria um terceiro
 * pacote compartilhado e mexer no build dos dois — trabalho maior do que o
 * problema.
 *
 * O risco de duplicar é divergir em silêncio, e um código de barras divergente
 * não avisa: ele imprime bonito e o leitor do balcão recusa. Por isso as
 * tabelas ficam aqui, isoladas e sem nenhuma dependência, e há teste cruzando
 * este arquivo com o do navegador dígito a dígito.
 *
 * Módulo puro de propósito: nada de banco, nada de HTTP. É o que permite o
 * teste do frontend importá-lo sem arrastar `better-sqlite3` junto.
 */

/** Padrões de codificação das metades esquerda e direita. */
const L = ['0001101','0011001','0010011','0111101','0100011','0110001','0101111','0111011','0110111','0001011'];
const G = ['0100111','0110011','0011011','0100001','0011101','0111001','0000101','0010001','0001001','0010111'];
const R = ['1110010','1100110','1101100','1000010','1011100','1001110','1010000','1000100','1001000','1110100'];

/** O primeiro dígito não vira barra: ele escolhe o padrão L/G dos 6 seguintes. */
const PARITY = ['LLLLLL','LLGLGG','LLGGLG','LLGGGL','LGLLGG','LGGLLG','LGGGLL','LGLGLG','LGLGGL','LGGLGL'];

/**
 * Zona de silêncio exigida pela norma: 11 módulos à esquerda e 7 à direita.
 * Sem ela o leitor não acha o começo do código — é a causa mais comum de
 * etiqueta que "não passa" mesmo com as barras certas.
 */
const QUIET_LEFT = 11;
const QUIET_RIGHT = 7;

/** Sequência de módulos (1 = barra) de um EAN-13 completo, ou `null` se inválido. */
export function ean13Bits(code: string): string | null {
  if (!/^\d{13}$/.test(code)) return null;
  const digits = code.split('').map(Number);
  const parity = PARITY[digits[0]];
  let bits = '101'; // guarda inicial
  for (let i = 1; i <= 6; i += 1) {
    bits += parity[i - 1] === 'L' ? L[digits[i]] : G[digits[i]];
  }
  bits += '01010'; // guarda central
  for (let i = 7; i <= 12; i += 1) bits += R[digits[i]];
  return `${bits}101`; // guarda final
}

/**
 * O dígito verificador dos GTIN (8, 12, 13 e 14): pesos 3 e 1 alternados a
 * partir do dígito imediatamente à esquerda do verificador. É a mesma conta de
 * `Gtin.ts` — repetida aqui porque este módulo não pode importar nada (o teste
 * do frontend o lê cru).
 */
function verificadorGtin(semVerificador: string): number {
  let soma = 0;
  const n = semVerificador.length;
  for (let i = 0; i < n; i += 1) soma += Number(semVerificador[i]) * ((n - i) % 2 === 1 ? 3 : 1);
  return (10 - (soma % 10)) % 10;
}

/** GTIN só de dígitos com o verificador certo. */
export function gtinComVerificadorCerto(code: string): boolean {
  if (!/^\d{8}$|^\d{12,14}$/.test(code)) return false;
  return verificadorGtin(code.slice(0, -1)) === Number(code[code.length - 1]);
}

/** Módulos contíguos viram UMA barra (sem fresta na térmica), deslocados pela zona de silêncio. */
function retangulos(bits: string, recuo: number, alturaModulos: number): string {
  const barras: string[] = [];
  let run = 0;
  const empurra = (fim: number) => {
    if (run > 0) {
      barras.push(`<rect x="${recuo + fim - run}" y="0" width="${run}" height="${alturaModulos}"/>`);
      run = 0;
    }
  };
  for (let i = 0; i < bits.length; i += 1) {
    if (bits[i] === '1') run += 1;
    else empurra(i);
  }
  empurra(bits.length);
  return barras.join('');
}

/**
 * SVG das barras, em unidades de módulo.
 *
 * Sem largura fixa: o `viewBox` deixa a etiqueta esticar o código até a
 * largura do papel, e todos os módulos crescem juntos — que é o que preserva a
 * proporção que o leitor espera. Módulos contíguos viram UMA barra: menos
 * elementos, e a impressora térmica não deixa fresta entre retângulos vizinhos.
 *
 * DEFEITO QUE ISTO CORRIGE: o desenho conferia só "13 dígitos" — um EAN com o
 * último dígito errado (7891234567890 no lugar de …5) saía com barras
 * perfeitas que o leitor do balcão RECUSA pelo verificador, e nada no papel
 * denunciava. Agora código com verificador errado não vira barra: quem chama
 * recebe `null` e escreve o aviso no lugar.
 */
export function ean13Svg(code: string, alturaModulos = 28): string | null {
  const bits = ean13Bits(code);
  if (!bits || !gtinComVerificadorCerto(code)) return null;

  const largura = QUIET_LEFT + bits.length + QUIET_RIGHT;
  // `preserveAspectRatio="none"`: a etiqueta é mais larga que alta, e esticar
  // só na horizontal mantém as barras legíveis.
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${largura} ${alturaModulos}"
     preserveAspectRatio="none" shape-rendering="crispEdges" width="100%" height="100%">
    <rect width="${largura}" height="${alturaModulos}" fill="#fff"/>
    <g fill="#000">${retangulos(bits, QUIET_LEFT, alturaModulos)}</g>
  </svg>`;
}

// ---------------------------------------------------------------- EAN-8

/**
 * EAN-8 (cosmético, embalagem pequena): guarda, 4 dígitos no padrão L, guarda
 * central, 4 no padrão R, guarda — 67 módulos. Não há paridade: todos os oito
 * dígitos viram barra, inclusive o verificador.
 */
export function ean8Bits(code: string): string | null {
  if (!/^\d{8}$/.test(code)) return null;
  const d = code.split('').map(Number);
  let bits = '101';
  for (let i = 0; i < 4; i += 1) bits += L[d[i]];
  bits += '01010';
  for (let i = 4; i < 8; i += 1) bits += R[d[i]];
  return `${bits}101`;
}

// ---------------------------------------------------------------- Code 128

/**
 * A tabela do Code 128: as larguras (barra, espaço, barra, espaço, barra,
 * espaço) de cada um dos 107 símbolos, em módulos. Cada símbolo soma 11
 * módulos; o STOP (106) tem sete elementos e soma 13. A soma das BARRAS de
 * cada símbolo é par — é a paridade que o leitor confere, e o teste também.
 */
const CODE128 = [
  '212222','222122','222221','121223','121322','131222','122213','122312','132212','221213',
  '221312','231212','112232','122132','122231','113222','123122','123221','223211','221132',
  '221231','213212','223112','312131','311222','321122','321221','312212','322112','322211',
  '212123','212321','232121','111323','131123','131321','112313','132113','132311','211313',
  '231113','231311','112133','112331','132131','113123','113321','133121','313121','211331',
  '231131','213113','213311','213131','311123','311321','331121','312113','312311','332111',
  '314111','221411','431111','111224','111422','121124','121421','141122','141221','112214',
  '112412','122114','122411','142112','142211','241211','221114','413111','241112','134111',
  '111242','121142','121241','114212','124112','124211','411212','421112','421211','212141',
  '214121','412121','111143','111341','131141','114113','114311','411113','411311','113141',
  '114131','311141','411131','211412','211214','211232','2331112',
];
export const CODE128_TABELA: readonly string[] = CODE128;

const START_B = 104;
const START_C = 105;
const CODE_B = 100; // dentro do conjunto C: "o próximo é do conjunto B"
const STOP = 106;

/**
 * Os valores (símbolos) de um texto em Code 128, com início, verificador e fim.
 *
 * Só dígitos em quantidade par: conjunto C, dois dígitos por símbolo — o
 * código fica com metade da largura. Só dígitos em quantidade ímpar: C para
 * todos menos o último, que vai pelo B. O resto (letras, hífen, ponto…): B,
 * que cobre o ASCII imprimível (32 a 126). Fora disso não há como desenhar.
 */
export function code128Valores(texto: string): number[] | null {
  if (!texto) return null;
  let valores: number[];
  if (/^\d{2,}$/.test(texto)) {
    const par = texto.length % 2 === 0 ? texto : texto.slice(0, -1);
    valores = [START_C];
    for (let i = 0; i < par.length; i += 2) valores.push(Number(par.slice(i, i + 2)));
    if (par.length !== texto.length) valores.push(CODE_B, texto.charCodeAt(texto.length - 1) - 32);
  } else {
    valores = [START_B];
    for (const c of texto) {
      const cod = c.charCodeAt(0);
      if (c.length !== 1 || cod < 32 || cod > 126) return null;
      valores.push(cod - 32);
    }
  }
  let soma = valores[0];
  for (let i = 1; i < valores.length; i += 1) soma += valores[i] * i;
  valores.push(soma % 103, STOP);
  return valores;
}

export function code128Bits(texto: string): string | null {
  const valores = code128Valores(texto);
  if (!valores) return null;
  let bits = '';
  for (const v of valores) {
    const larguras = CODE128[v];
    for (let i = 0; i < larguras.length; i += 1) bits += (i % 2 === 0 ? '1' : '0').repeat(Number(larguras[i]));
  }
  return bits;
}

// ------------------------------------------------------ o desenho da etiqueta

export type Simbologia = 'EAN-13' | 'EAN-8' | 'UPC-A' | 'Code128';

export type DesenhoDoCodigo =
  | { ok: true; simbologia: Simbologia; bits: string; silencioEsquerda: number; silencioDireita: number; modulos: number }
  | { ok: false; motivo: string };

/**
 * Escolhe a simbologia pelo FORMATO do código cadastrado.
 *
 * DEFEITO QUE ISTO CORRIGE: a etiqueta só conhecia EAN-13. O cadastro aceita
 * EAN-8 e UPC-A válidos e código próprio da loja (alfanumérico, "PJ-ABC-001",
 * ou numérico de outro tamanho, vindo do sistema antigo) — e todos esses
 * saíam "SEM CÓDIGO DE BARRAS", sem nem o número, com a fila da tela sem
 * avisar nada. O caixa digitava o código de cada peça.
 *
 * - 13 dígitos: EAN-13; 12: UPC-A (é o EAN-13 com o zero na frente); 8: EAN-8.
 *   Nos três o verificador é conferido: com ele errado, NÃO há desenho — as
 *   barras sairiam perfeitas e o leitor as recusaria.
 * - 14 dígitos (GTIN-14 de caixa): Code 128, com o verificador conferido.
 * - Qualquer outro texto imprimível: Code 128 — o leitor devolve exatamente
 *   os caracteres, que é o que a busca do PDV compara.
 */
export function desenhoDoCodigo(code: string): DesenhoDoCodigo {
  const c = String(code ?? '');
  if (!c.trim()) return { ok: false, motivo: 'sem código' };
  const invalido = (): DesenhoDoCodigo => ({
    ok: false,
    motivo: `dígito verificador errado (o último deveria ser ${verificadorGtin(c.slice(0, -1))})`,
  });
  const pronto = (simbologia: Simbologia, bits: string, esq: number, dir: number): DesenhoDoCodigo => ({
    ok: true, simbologia, bits, silencioEsquerda: esq, silencioDireita: dir, modulos: esq + bits.length + dir,
  });
  if (/^\d{13}$/.test(c)) return gtinComVerificadorCerto(c) ? pronto('EAN-13', ean13Bits(c)!, QUIET_LEFT, QUIET_RIGHT) : invalido();
  if (/^\d{12}$/.test(c)) return gtinComVerificadorCerto(c) ? pronto('UPC-A', ean13Bits(`0${c}`)!, 9, 9) : invalido();
  if (/^\d{8}$/.test(c)) return gtinComVerificadorCerto(c) ? pronto('EAN-8', ean8Bits(c)!, 7, 7) : invalido();
  if (/^\d{14}$/.test(c) && !gtinComVerificadorCerto(c)) return invalido();
  const bits = code128Bits(c);
  // Zona de silêncio do Code 128: dez módulos de cada lado.
  if (bits) return pronto('Code128', bits, 10, 10);
  return { ok: false, motivo: 'tem caractere que o código de barras não representa (use letras sem acento, números e - . /)' };
}

/**
 * O SVG de um desenho já escolhido, com a LARGURA pedida em milímetro.
 *
 * A largura vem de fora porque é ela que decide o tamanho do módulo, e o
 * módulo é o que o leitor mede (ver `LabelSheet`, que o arredonda ao ponto da
 * impressora). Esticar a 100 % deixava cada barra com uma fração qualquer de
 * ponto de impressão.
 */
export function svgDoDesenho(
  d: Extract<DesenhoDoCodigo, { ok: true }>,
  larguraMm: number,
  alturaModulos = 28,
): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${d.modulos} ${alturaModulos}"
     preserveAspectRatio="none" shape-rendering="crispEdges" style="width:${larguraMm.toFixed(3)}mm;height:100%"
     data-simbologia="${d.simbologia}">
    <rect width="${d.modulos}" height="${alturaModulos}" fill="#fff"/>
    <g fill="#000">${retangulos(d.bits, d.silencioEsquerda, alturaModulos)}</g>
  </svg>`;
}
