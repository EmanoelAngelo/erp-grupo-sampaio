/**
 * QR em SVG — o único gerador do sistema.
 *
 * ## Por que existe
 *
 * Havia TRÊS implementações da mesma coisa: uma em `PrintRenderer` (plaquinha),
 * uma em `DanfceRenderer` (cupom fiscal) e uma no navegador, em
 * `components/gs/Barcode.tsx`. Três cópias do mesmo desenho divergem no dia em
 * que uma delas mudar — e num QR a divergência não aparece como bug de layout,
 * aparece como código que o celular não lê.
 *
 * Vetor e não imagem: a plaquinha é pequena e sai em impressora térmica, onde
 * um PNG redimensionado perde os módulos.
 *
 * ## O `<path>` no lugar de milhares de `<rect>`
 *
 * Um módulo por retângulo é o desenho óbvio e custa caro em folha: o QR da
 * plaquinha tem ~690 módulos escuros, e uma folha de vinte vira megabytes de
 * HTML trafegando dentro de JSON. Uma corrida horizontal de módulos vizinhos
 * vira um subcaminho só, e o desenho impresso é idêntico.
 */
import qrcode from 'qrcode-generator';

/**
 * A margem branca ao redor, em MÓDULOS.
 *
 * Quatro é exigência da ISO/IEC 18004. Abaixo disso muitos leitores não
 * encontram o código — e a plaquinha é lida por celular de cliente, com a
 * câmera que ele tiver, na luz que houver.
 */
export const MODULOS_DE_SILENCIO = 4;

/**
 * Nível de correção de erro.
 *
 *   M  ~15% do símbolo recuperável. Suficiente para papel guardado e sujeira.
 *   Q  ~25%. É o que a plaquinha de pátio pede: moto pega sol, poeira e
 *      combustível, e um vinco no adesivo tira mais que sujeira tira.
 *   H  ~30%. Custa módulos — o código fica mais denso no mesmo espaço.
 *
 * Mais correção NÃO é sempre melhor: o símbolo cresce, e num espaço fixo cada
 * módulo fica menor. Abaixo de meio milímetro por módulo, leitor de celular
 * comum começa a falhar — e aí a correção não salva nada.
 */
export type NivelQr = 'L' | 'M' | 'Q' | 'H';

export interface QrDesenhado {
  svg: string;
  /** Módulos do símbolo, SEM a zona de silêncio. */
  modulos: number;
  /** Lado do viewBox: módulos + as duas margens. */
  lado: number;
}

/**
 * Desenha o QR e informa o tamanho do símbolo.
 *
 * A contagem de módulos volta junto porque quem monta a folha PRECISA dela:
 * o tamanho físico de cada módulo é o espaço disponível dividido pelo lado, e
 * assumir um número fixo dá errado em silêncio — a mesma URL com um domínio
 * mais longo sobe de versão e o módulo encolhe sem ninguém perceber.
 */
export function desenharQr(
  conteudo: string,
  opcoes: {
    nivel?: NivelQr;
    silencio?: number;
    /**
     * Lado em pixels, quando o SVG precisa de tamanho próprio.
     *
     * O DANFCE desenha num cupom de largura fixa e crava 140; a plaquinha usa
     * milímetro e deixa o CSS mandar. Sem isto, absorver o gerador do DANFCE
     * mudaria o tamanho do QR no cupom fiscal.
     */
    px?: number;
  } = {},
): QrDesenhado {
  const silencio = opcoes.silencio ?? MODULOS_DE_SILENCIO;
  const qr = qrcode(0, opcoes.nivel ?? 'M');
  qr.addData(conteudo);
  qr.make();

  const modulos = qr.getModuleCount();
  const lado = modulos + silencio * 2;

  /*
    Uma corrida horizontal por subcaminho.

    Percorre cada linha acumulando módulos escuros vizinhos e fecha o trecho
    quando encontra um claro. O `h{n}v1h-{n}z` desenha o retângulo da corrida
    inteira — mesmo pixel no papel, uma fração do texto.
  */
  const trechos: string[] = [];
  for (let linha = 0; linha < modulos; linha += 1) {
    let inicio = -1;
    for (let coluna = 0; coluna <= modulos; coluna += 1) {
      const escuro = coluna < modulos && qr.isDark(linha, coluna);
      if (escuro && inicio < 0) inicio = coluna;
      if (!escuro && inicio >= 0) {
        const largura = coluna - inicio;
        trechos.push(`M${inicio + silencio} ${linha + silencio}h${largura}v1h-${largura}z`);
        inicio = -1;
      }
    }
  }

  // `crispEdges` impede o navegador de suavizar a borda do módulo: meio pixel
  // de antialias num módulo de meio milímetro é o que o leitor lê como cinza.
  const tamanho = opcoes.px ? ` width="${opcoes.px}" height="${opcoes.px}"` : '';
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${lado} ${lado}"${tamanho} shape-rendering="crispEdges">`
    + `<rect width="${lado}" height="${lado}" fill="#fff"/>`
    + `<path fill="#000" d="${trechos.join('')}"/>`
    + '</svg>';

  return { svg, modulos, lado };
}

/** Só o desenho, para quem não precisa medir. */
export function qrSvg(
  conteudo: string,
  opcoes: { nivel?: NivelQr; px?: number } = {},
): string {
  return desenharQr(conteudo, opcoes).svg;
}
