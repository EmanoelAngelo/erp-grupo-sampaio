/**
 * Normalização de imagem antes do envio.
 *
 * A foto vinda da câmera do celular chega com 4000×3000 e vários megabytes —
 * tamanho que não serve para vitrine nenhuma e que só faz o upload demorar e
 * o disco encher. Redimensionar e recomprimir aqui, no navegador, resolve isso
 * sem exigir biblioteca de imagem no servidor.
 *
 * O que NÃO se faz aqui: aumentar imagem pequena. Esticar uma foto de 200px
 * para 1600px não cria detalhe, só peso.
 *
 * ## A miniatura do balcão (P0 da Preço Justo)
 *
 * O PDV precisa de foto na lista da busca, e o único arquivo que existia era o
 * original (até 1600 px). O servidor não tem biblioteca de imagem — e não
 * ganha uma: quem já decodifica a foto é ESTE arquivo, no canvas. Então a
 * mesma leitura desenha uma segunda vez, em 160 px, e a miniatura sobe junto
 * com o original (`thumbDataUrl`). O servidor confere o cabeçalho, o lado e o
 * peso (ver `ProductImageService.ts`) — os tetos daqui e de lá são os mesmos.
 */

/** Maior lado da imagem final. Suficiente para zoom de vitrine. */
const MAX_SIDE = 1600;

/** Qualidade do JPEG. 0.85 é o ponto onde o olho não vê perda. */
const QUALITY = 0.85;

/**
 * Os tetos da miniatura — os MESMOS de `MAX_THUMB_SIDE`/`MAX_THUMB_BYTES` do
 * servidor. Mudar um sem o outro faz o navegador gerar o que o servidor recusa.
 */
export const MINIATURA_LADO_MAX = 160;
export const MINIATURA_BYTES_MAX = 40 * 1024;

export interface Miniatura {
  dataUrl: string;
  mimeType: 'image/webp' | 'image/jpeg';
  width: number;
  height: number;
  bytes: number;
}

export interface NormalizedImage {
  dataUrl: string;
  mimeType: string;
  width: number;
  height: number;
  bytes: number;
  /** A miniatura do balcão; nula quando o navegador não conseguiu desenhá-la. */
  miniatura: Miniatura | null;
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('Não foi possível ler o arquivo.'));
    reader.readAsDataURL(file);
  });
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Arquivo não é uma imagem válida.'));
    img.src = dataUrl;
  });
}

/** Bytes reais de um data URL base64, sem contar o cabeçalho. */
export function dataUrlBytes(dataUrl: string): number {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  return Math.floor((base64.length * 3) / 4);
}

/**
 * Desenha a miniatura do balcão: maior lado de até 160 px, WebP (ou JPEG no
 * navegador que não codifica WebP), e no máximo 40 KB.
 *
 * A qualidade desce em degraus até caber; se nem assim couber, o lado desce
 * para 120 px. Nulo quando não há canvas ou nada coube — a foto sobe sem
 * miniatura e o balcão mostra o espaço neutro, que é melhor do que mandar ao
 * servidor uma miniatura que ele recusaria junto com a foto.
 *
 * O fundo é pintado de branco antes: PNG recortado com transparência viraria
 * JPEG com o fundo preto.
 */
export function gerarMiniatura(fonte: HTMLImageElement | HTMLCanvasElement): Miniatura | null {
  const maior = Math.max(Number(fonte.width) || 0, Number(fonte.height) || 0);
  if (maior <= 0) return null;
  for (const lado of [MINIATURA_LADO_MAX, 120]) {
    const escala = Math.min(1, lado / maior);
    const width = Math.max(1, Math.round(fonte.width * escala));
    const height = Math.max(1, Math.round(fonte.height * escala));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(fonte, 0, 0, width, height);
    for (const qualidade of [0.72, 0.55, 0.4]) {
      let mimeType: Miniatura['mimeType'] = 'image/webp';
      let dataUrl = canvas.toDataURL(mimeType, qualidade);
      // O navegador sem codificador de WebP devolve PNG em silêncio.
      if (!dataUrl.startsWith('data:image/webp')) {
        mimeType = 'image/jpeg';
        dataUrl = canvas.toDataURL(mimeType, qualidade);
      }
      if (!dataUrl.startsWith(`data:${mimeType}`)) return null;
      const bytes = dataUrlBytes(dataUrl);
      if (bytes <= MINIATURA_BYTES_MAX) return { dataUrl, mimeType, width, height, bytes };
    }
  }
  return null;
}

/**
 * A miniatura de uma foto JÁ GRAVADA — o preenchimento das fotos antigas.
 *
 * Baixa o original UMA vez (na retaguarda, nunca no PDV), por `fetch` e não
 * por `<img src>`: a imagem vinda de outra origem "suja" o canvas e o
 * `toDataURL` é recusado; o `blob:` é da origem da tela. Nulo em qualquer
 * falha — quem chama conta e segue para a próxima.
 */
export async function miniaturaDaUrl(url: string): Promise<Miniatura | null> {
  let objeto: string | null = null;
  try {
    const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
    if (!res.ok) return null;
    objeto = URL.createObjectURL(await res.blob());
    const img = await loadImage(objeto);
    return gerarMiniatura(img);
  } catch {
    return null;
  } finally {
    if (objeto) URL.revokeObjectURL(objeto);
  }
}

/**
 * Redimensiona e recomprime, preservando a proporção.
 *
 * PNG com transparência é mantido como PNG — converter para JPEG pintaria o
 * fundo de preto, e produto recortado ficaria com uma moldura escura.
 */
export async function normalizeImage(file: File): Promise<NormalizedImage> {
  const original = await readAsDataUrl(file);
  const img = await loadImage(original);

  const maior = Math.max(img.width, img.height);
  const escala = maior > MAX_SIDE ? MAX_SIDE / maior : 1;
  const width = Math.round(img.width * escala);
  const height = Math.round(img.height * escala);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    // Sem canvas não há como normalizar; enviar o original é melhor que falhar.
    return {
      dataUrl: original,
      mimeType: file.type,
      width: img.width,
      height: img.height,
      bytes: dataUrlBytes(original),
      miniatura: null,
    };
  }

  ctx.drawImage(img, 0, 0, width, height);

  const mimeType = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
  const dataUrl = canvas.toDataURL(mimeType, QUALITY);

  return {
    dataUrl,
    mimeType,
    width,
    height,
    bytes: dataUrlBytes(dataUrl),
    miniatura: gerarMiniatura(img),
  };
}
