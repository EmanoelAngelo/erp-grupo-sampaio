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
 */

/** Maior lado da imagem final. Suficiente para zoom de vitrine. */
const MAX_SIDE = 1600;

/** Qualidade do JPEG. 0.85 é o ponto onde o olho não vê perda. */
const QUALITY = 0.85;

export interface NormalizedImage {
  dataUrl: string;
  mimeType: string;
  width: number;
  height: number;
  bytes: number;
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
    };
  }

  ctx.drawImage(img, 0, 0, width, height);

  const mimeType = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
  const dataUrl = canvas.toDataURL(mimeType, QUALITY);

  return { dataUrl, mimeType, width, height, bytes: dataUrlBytes(dataUrl) };
}
