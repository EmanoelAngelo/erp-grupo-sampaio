/**
 * Desenho de código de barras EAN-13 e de QR Code, em SVG.
 *
 * SVG e não imagem: a etiqueta sai idêntica em qualquer máquina do balcão,
 * inclusive offline, e imprime sem serrilhado tanto no navegador quanto em
 * impressora térmica.
 */
import qrcode from 'qrcode-generator';

// ------------------------------------------------------------------ EAN-13

/** Padrões de codificação das metades esquerda e direita do EAN-13. */
const L = ['0001101','0011001','0010011','0111101','0100011','0110001','0101111','0111011','0110111','0001011'];
const G = ['0100111','0110011','0011011','0100001','0011101','0111001','0000101','0010001','0001001','0010111'];
const R = ['1110010','1100110','1101100','1000010','1011100','1001110','1010000','1000100','1001000','1110100'];
/** O primeiro dígito não é barrado: ele escolhe o padrão L/G dos 6 seguintes. */
const PARITY = ['LLLLLL','LLGLGG','LLGGLG','LLGGGL','LGLLGG','LGGLLG','LGGGLL','LGLGLG','LGLGGL','LGGLGL'];

function ean13Bits(code: string): string | null {
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

export function Ean13({
  code,
  height = 46,
  moduleWidth = 2,
}: {
  code: string;
  height?: number;
  moduleWidth?: number;
}) {
  const bits = ean13Bits(code);
  if (!bits) {
    return <span className="text-[length:var(--gs-text-xs)] text-[var(--gs-danger)]">código inválido</span>;
  }

  const width = bits.length * moduleWidth;
  // Agrupa módulos contíguos em barras únicas: menos elementos, e a
  // impressora não deixa fresta entre retângulos vizinhos.
  const bars: { x: number; w: number }[] = [];
  let run = 0;
  for (let i = 0; i < bits.length; i += 1) {
    if (bits[i] === '1') {
      run += 1;
    } else if (run > 0) {
      bars.push({ x: (i - run) * moduleWidth, w: run * moduleWidth });
      run = 0;
    }
  }
  if (run > 0) bars.push({ x: (bits.length - run) * moduleWidth, w: run * moduleWidth });

  const textY = height + 11;
  return (
    <svg
      width={width}
      height={textY + 2}
      viewBox={`0 0 ${width} ${textY + 2}`}
      role="img"
      aria-label={`Código de barras ${code}`}
      shapeRendering="crispEdges"
    >
      <rect width={width} height={textY + 2} fill="#fff" />
      {bars.map((bar) => (
        <rect key={bar.x} x={bar.x} y={0} width={bar.w} height={height} fill="#000" />
      ))}
      <text
        x={width / 2}
        y={textY}
        textAnchor="middle"
        fontSize={11}
        fontFamily="monospace"
        fill="#000"
      >
        {code}
      </text>
    </svg>
  );
}

// --------------------------------------------------------------------- QR

/**
 * QR Code da plaquinha do equipamento.
 *
 * Usa `qrcode-generator` em vez de codificador próprio. A plaquinha é
 * impressa e colada no equipamento: um QR com bits de formato ou máscara
 * errados simplesmente não lê no celular do mecânico — falha que só
 * apareceria no balcão, depois de tudo impresso. A biblioteca é madura e sem
 * dependências; o desenho continua sendo SVG nosso.
 */
export function QrCode({ value, size = 108 }: { value: string; size?: number }) {
  // Versão automática, correção de erro M — deixa margem para etiqueta
  // riscada ou suja, que é a realidade de uma oficina.
  const qr = qrcode(0, 'M');
  qr.addData(value);
  qr.make();

  const modules = qr.getModuleCount();
  const quiet = 2; // zona de silêncio, sem ela o leitor não acha o código
  const total = modules + quiet * 2;

  const cells: { r: number; c: number }[] = [];
  for (let r = 0; r < modules; r += 1) {
    for (let c = 0; c < modules; c += 1) {
      if (qr.isDark(r, c)) cells.push({ r, c });
    }
  }

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${total} ${total}`}
      role="img"
      aria-label="QR Code do equipamento"
      shapeRendering="crispEdges"
    >
      <rect width={total} height={total} fill="#fff" />
      {cells.map(({ r, c }) => (
        <rect key={`${r}-${c}`} x={c + quiet} y={r + quiet} width={1} height={1} fill="#000" />
      ))}
    </svg>
  );
}
