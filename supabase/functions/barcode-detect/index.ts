import { MultiFormatReader, BinaryBitmap, HybridBinarizer, RGBLuminanceSource, BarcodeFormat, DecodeHintType, Result } from "https://esm.sh/@zxing/library@0.20.0";
import jpeg from "https://esm.sh/jpeg-js@0.4.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const ALL_FORMATS = [
  BarcodeFormat.QR_CODE,
  BarcodeFormat.DATA_MATRIX,
  BarcodeFormat.AZTEC,
  BarcodeFormat.PDF_417,
  BarcodeFormat.CODE_128,
  BarcodeFormat.CODE_39,
  BarcodeFormat.CODE_93,
  BarcodeFormat.CODABAR,
  BarcodeFormat.EAN_13,
  BarcodeFormat.EAN_8,
  BarcodeFormat.UPC_A,
  BarcodeFormat.UPC_E,
  BarcodeFormat.ITF,
  BarcodeFormat.RSS_14,
  BarcodeFormat.RSS_EXPANDED,
  BarcodeFormat.UPC_EAN_EXTENSION,
];

const FAST_FORMATS = [BarcodeFormat.EAN_13, BarcodeFormat.CODE_128, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A, BarcodeFormat.UPC_E];

function decodeBase64ToUint8Clamped(base64: string): Uint8ClampedArray {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8ClampedArray(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

function decodeJpegToRGBA(jpegBase64: string): { pixels: Uint8ClampedArray; width: number; height: number } {
  const binaryString = atob(jpegBase64);
  const len = binaryString.length;
  const raw = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    raw[i] = binaryString.charCodeAt(i);
  }
  const decoded = jpeg.decode(raw, { useTArray: true });
  const data = decoded.data instanceof Uint8ClampedArray
    ? decoded.data
    : new Uint8ClampedArray(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength);
  return { pixels: data, width: decoded.width, height: decoded.height };
}

function createBitmap(pixels: Uint8ClampedArray, width: number, height: number): BinaryBitmap {
  const luminance = new RGBLuminanceSource(width, height, pixels);
  const binarizer = new HybridBinarizer(luminance);
  return new BinaryBitmap(binarizer);
}

function attemptDecode(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  formats: BarcodeFormat[],
  strategy: string,
): { result: Result; strategy: string } | null {
  try {
    const hints = new Map();
    hints.set(DecodeHintType.POSSIBLE_FORMATS, formats);
    hints.set(DecodeHintType.TRY_HARDER, true);
    const reader = new MultiFormatReader();
    reader.setHints(hints);
    const bitmap = createBitmap(pixels, width, height);
    const result = reader.decode(bitmap);
    return { result, strategy };
  } catch {
    return null;
  }
}

function tryFastPath(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
): { result: Result; strategy: string } | null {
  const fast = attemptDecode(pixels, width, height, FAST_FORMATS, "fast-original");
  if (fast) return fast;
  const stretched = histogramStretch(pixels);
  const fastStretched = attemptDecode(stretched, width, height, FAST_FORMATS, "fast-stretched");
  if (fastStretched) return fastStretched;
  const inverted = invertColors(pixels);
  const fastInverted = attemptDecode(inverted, width, height, FAST_FORMATS, "fast-inverted");
  if (fastInverted) return fastInverted;
  return null;
}

function rotate90(pixels: Uint8ClampedArray, width: number, height: number): { pixels: Uint8ClampedArray; width: number; height: number } {
  const newW = height;
  const newH = width;
  const out = new Uint8ClampedArray(newW * newH * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const srcIdx = (y * width + x) * 4;
      const dstIdx = ((x * newW) + (newW - 1 - y)) * 4;
      out[dstIdx] = pixels[srcIdx];
      out[dstIdx + 1] = pixels[srcIdx + 1];
      out[dstIdx + 2] = pixels[srcIdx + 2];
      out[dstIdx + 3] = pixels[srcIdx + 3];
    }
  }
  return { pixels: out, width: newW, height: newH };
}

function rotate180(pixels: Uint8ClampedArray, width: number, height: number): Uint8ClampedArray {
  const total = width * height;
  const out = new Uint8ClampedArray(total * 4);
  for (let i = 0; i < total; i++) {
    const srcIdx = i * 4;
    const dstIdx = ((total - 1 - i)) * 4;
    out[dstIdx] = pixels[srcIdx];
    out[dstIdx + 1] = pixels[srcIdx + 1];
    out[dstIdx + 2] = pixels[srcIdx + 2];
    out[dstIdx + 3] = pixels[srcIdx + 3];
  }
  return out;
}

function rotate270(pixels: Uint8ClampedArray, width: number, height: number): { pixels: Uint8ClampedArray; width: number; height: number } {
  const newW = height;
  const newH = width;
  const out = new Uint8ClampedArray(newW * newH * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const srcIdx = (y * width + x) * 4;
      const dstIdx = (((newH - 1 - x) * newW) + y) * 4;
      out[dstIdx] = pixels[srcIdx];
      out[dstIdx + 1] = pixels[srcIdx + 1];
      out[dstIdx + 2] = pixels[srcIdx + 2];
      out[dstIdx + 3] = pixels[srcIdx + 3];
    }
  }
  return { pixels: out, width: newW, height: newH };
}

function invertColors(pixels: Uint8ClampedArray): Uint8ClampedArray {
  const out = new Uint8ClampedArray(pixels.length);
  for (let i = 0; i < pixels.length; i += 4) {
    out[i] = 255 - pixels[i];
    out[i + 1] = 255 - pixels[i + 1];
    out[i + 2] = 255 - pixels[i + 2];
    out[i + 3] = pixels[i + 3];
  }
  return out;
}

function histogramStretch(pixels: Uint8ClampedArray): Uint8ClampedArray {
  let minL = 255;
  let maxL = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    const lum = Math.floor((pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3);
    if (lum < minL) minL = lum;
    if (lum > maxL) maxL = lum;
  }
  if (maxL === minL) return pixels;
  const range = maxL - minL;
  const out = new Uint8ClampedArray(pixels.length);
  for (let i = 0; i < pixels.length; i += 4) {
    const r = pixels[i];
    const g = pixels[i + 1];
    const b = pixels[i + 2];
    out[i] = Math.min(255, Math.max(0, ((r - minL) / range) * 255));
    out[i + 1] = Math.min(255, Math.max(0, ((g - minL) / range) * 255));
    out[i + 2] = Math.min(255, Math.max(0, ((b - minL) / range) * 255));
    out[i + 3] = pixels[i + 3];
  }
  return out;
}

function generateCrops(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
): Array<{ pixels: Uint8ClampedArray; x: number; y: number; w: number; h: number }> {
  const crops: Array<{ pixels: Uint8ClampedArray; x: number; y: number; w: number; h: number }> = [];
  const cols = 3;
  const rows = 3;
  const overlap = 0.15;
  const cellW = width / cols;
  const cellH = height / rows;
  const padW = Math.floor(cellW * overlap);
  const padH = Math.floor(cellH * overlap);
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const x = Math.max(0, Math.floor(col * cellW) - padW);
      const y = Math.max(0, Math.floor(row * cellH) - padH);
      const x2 = Math.min(width, Math.floor((col + 1) * cellW) + padW);
      const y2 = Math.min(height, Math.floor((row + 1) * cellH) + padH);
      const w = x2 - x;
      const h = y2 - y;
      const cropPixels = new Uint8ClampedArray(w * h * 4);
      for (let cy = 0; cy < h; cy++) {
        for (let cx = 0; cx < w; cx++) {
          const srcIdx = ((y + cy) * width + (x + cx)) * 4;
          const dstIdx = (cy * w + cx) * 4;
          cropPixels[dstIdx] = pixels[srcIdx];
          cropPixels[dstIdx + 1] = pixels[srcIdx + 1];
          cropPixels[dstIdx + 2] = pixels[srcIdx + 2];
          cropPixels[dstIdx + 3] = pixels[srcIdx + 3];
        }
      }
      crops.push({ pixels: cropPixels, x, y, w, h });
    }
  }
  return crops;
}

function scaleHalf(pixels: Uint8ClampedArray, width: number, height: number): { pixels: Uint8ClampedArray; width: number; height: number } {
  const newW = Math.floor(width / 2);
  const newH = Math.floor(height / 2);
  if (newW < 50 || newH < 50) return { pixels, width, height };
  const out = new Uint8ClampedArray(newW * newH * 4);
  for (let y = 0; y < newH; y++) {
    for (let x = 0; x < newW; x++) {
      const srcIdx = ((y * 2) * width + (x * 2)) * 4;
      const dstIdx = (y * newW + x) * 4;
      out[dstIdx] = pixels[srcIdx];
      out[dstIdx + 1] = pixels[srcIdx + 1];
      out[dstIdx + 2] = pixels[srcIdx + 2];
      out[dstIdx + 3] = pixels[srcIdx + 3];
    }
  }
  return { pixels: out, width: newW, height: newH };
}

function getBoundingBox(result: Result, imageWidth: number, imageHeight: number) {
  const points = result.getResultPoints();
  if (!points || points.length === 0) {
    return { x: 0, y: 0, width: imageWidth, height: imageHeight, rotation: 0 };
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    const px = Math.round(p.getX());
    const py = Math.round(p.getY());
    if (px < minX) minX = px;
    if (py < minY) minY = py;
    if (px > maxX) maxX = px;
    if (py > maxY) maxY = py;
  }
  const padding = 10;
  const x = Math.max(0, minX - padding);
  const y = Math.max(0, minY - padding);
  const w = Math.min(imageWidth - x, maxX - minX + padding * 2);
  const h = Math.min(imageHeight - y, maxY - minY + padding * 2);
  let rotation = 0;
  if (points.length >= 2) {
    const dx = points[points.length - 1].getX() - points[0].getX();
    const dy = points[points.length - 1].getY() - points[0].getY();
    rotation = Math.round((Math.atan2(dy, dx) * 180) / Math.PI);
  }
  return { x, y, width: w, height: h, rotation };
}

function calculateConfidence(result: Result, strategy: string): number {
  const format = result.getBarcodeFormat();
  const text = result.getText();
  const checksumFormats = [
    BarcodeFormat.EAN_13, BarcodeFormat.EAN_8,
    BarcodeFormat.UPC_A, BarcodeFormat.UPC_E,
    BarcodeFormat.UPC_EAN_EXTENSION,
  ];
  let baseConfidence = 0.85;
  if (checksumFormats.includes(format)) {
    baseConfidence = 0.95;
  } else if (format === BarcodeFormat.QR_CODE || format === BarcodeFormat.DATA_MATRIX) {
    baseConfidence = 0.92;
  } else if (format === BarcodeFormat.CODE_128) {
    baseConfidence = 0.88;
  }
  const strategyPenalty: Record<string, number> = {
    "fast-original": 0,
    "fast-stretched": -0.01,
    "fast-inverted": -0.02,
    original: 0,
    rotated_90: -0.03,
    rotated_180: -0.03,
    rotated_270: -0.03,
    inverted: -0.05,
    stretched: -0.04,
    crop: -0.06,
    scaled: -0.05,
  };
  const penalty = strategyPenalty[strategy] ?? -0.08;
  const lenBonus = text.length > 3 ? 0.02 : -0.05;
  return Math.max(0.5, Math.min(0.99, baseConfidence + penalty + lenBonus));
}

async function processBarcode(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
): Promise<{
  success: boolean;
  code?: string;
  format?: string;
  confidence?: number;
  boundingBox?: { x: number; y: number; width: number; height: number; rotation: number };
  strategy?: string;
  engine?: string;
  processingTimeMs?: number;
  attempts?: number;
  error?: string;
}> {
  const startTime = performance.now();
  let attempts = 0;

  // FAST-PATH
  const fastResult = tryFastPath(pixels, width, height);
  attempts += fastResult ? 1 : 3;
  if (fastResult) {
    const result = fastResult.result;
    const bb = getBoundingBox(result, width, height);
    return {
      success: true,
      code: result.getText(),
      format: BarcodeFormat[result.getBarcodeFormat()],
      confidence: calculateConfidence(result, fastResult.strategy),
      boundingBox: bb,
      strategy: fastResult.strategy,
      engine: "zxing-fast",
      processingTimeMs: Math.round(performance.now() - startTime),
      attempts,
    };
  }

  // FALLBACK: pipeline completo
  const strategies: Array<{
    name: string;
    getPixels: () => { pixels: Uint8ClampedArray; w: number; h: number };
  }> = [
    { name: "original", getPixels: () => ({ pixels, w: width, h: height }) },
    { name: "stretched", getPixels: () => ({ pixels: histogramStretch(pixels), w: width, h: height }) },
    { name: "inverted", getPixels: () => ({ pixels: invertColors(pixels), w: width, h: height }) },
    { name: "stretched_inverted", getPixels: () => ({ pixels: invertColors(histogramStretch(pixels)), w: width, h: height }) },
  ];

  const r90 = rotate90(pixels, width, height);
  strategies.push({ name: "rotated_90", getPixels: () => ({ pixels: r90.pixels, w: r90.width, h: r90.height }) });
  strategies.push({ name: "rotated_90_stretched", getPixels: () => ({ pixels: histogramStretch(r90.pixels), w: r90.width, h: r90.height }) });

  const r180 = rotate180(pixels, width, height);
  strategies.push({ name: "rotated_180", getPixels: () => ({ pixels: r180, w: width, h: height }) });

  const r270 = rotate270(pixels, width, height);
  strategies.push({ name: "rotated_270", getPixels: () => ({ pixels: r270.pixels, w: r270.width, h: r270.height }) });

  for (const strat of strategies) {
    const { pixels: p, w, h } = strat.getPixels();
    const attempt = attemptDecode(p, w, h, ALL_FORMATS, strat.name);
    attempts++;
    if (attempt) {
      const result = attempt.result;
      const bb = getBoundingBox(result, w, h);
      if (strat.name.includes("rotated_90")) {
        const origX = bb.y;
        const origY = width - bb.x - bb.width;
        bb.x = origX;
        bb.y = origY;
        bb.width = bb.height;
        bb.height = w - origX - origY;
      } else if (strat.name.includes("rotated_180")) {
        bb.x = width - bb.x - bb.width;
        bb.y = height - bb.y - bb.height;
      } else if (strat.name.includes("rotated_270")) {
        const origX = height - bb.y - bb.height;
        const origY = bb.x;
        bb.x = origX;
        bb.y = origY;
        bb.width = bb.height;
        bb.height = h - origX - origY;
      }
      return {
        success: true,
        code: result.getText(),
        format: BarcodeFormat[result.getBarcodeFormat()],
        confidence: calculateConfidence(result, strat.name),
        boundingBox: bb,
        strategy: strat.name,
        engine: "zxing",
        processingTimeMs: Math.round(performance.now() - startTime),
        attempts,
      };
    }
  }

  const crops = generateCrops(pixels, width, height);
  for (const crop of crops) {
    const attempt = attemptDecode(crop.pixels, crop.w, crop.h, ALL_FORMATS, "crop");
    attempts++;
    if (attempt) {
      const result = attempt.result;
      const localBB = getBoundingBox(result, crop.w, crop.h);
      const globalBB = {
        x: crop.x + localBB.x,
        y: crop.y + localBB.y,
        width: localBB.width,
        height: localBB.height,
        rotation: localBB.rotation,
      };
      return {
        success: true,
        code: result.getText(),
        format: BarcodeFormat[result.getBarcodeFormat()],
        confidence: calculateConfidence(result, "crop"),
        boundingBox: globalBB,
        strategy: "crop_" + crop.x + "_" + crop.y,
        engine: "zxing",
        processingTimeMs: Math.round(performance.now() - startTime),
        attempts,
      };
    }
  }

  const scaled = scaleHalf(pixels, width, height);
  if (scaled.width !== width) {
    const attempt = attemptDecode(scaled.pixels, scaled.width, scaled.height, ALL_FORMATS, "scaled");
    attempts++;
    if (attempt) {
      const result = attempt.result;
      const bb = getBoundingBox(result, scaled.width, scaled.height);
      bb.x *= 2;
      bb.y *= 2;
      bb.width *= 2;
      bb.height *= 2;
      return {
        success: true,
        code: result.getText(),
        format: BarcodeFormat[result.getBarcodeFormat()],
        confidence: calculateConfidence(result, "scaled"),
        boundingBox: bb,
        strategy: "scaled",
        engine: "zxing",
        processingTimeMs: Math.round(performance.now() - startTime),
        attempts,
      };
    }
  }

  return {
    success: false,
    error: "Nenhum código de barras detectado após todas as estratégias de visão computacional.",
    processingTimeMs: Math.round(performance.now() - startTime),
    attempts,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Método não permitido. Use POST." }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 405,
    });
  }

  try {
    const body = await req.json();

    // ── Warm ping: mantém a função aquecida ──
    if (body.ping === true) {
      return new Response(JSON.stringify({ pong: true, warm: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      });
    }

    const { imageJpeg, imageBase64, width, height } = body;

    // ── Modo JPEG (preferido — 35x menor que RGBA) ──
    if (imageJpeg && typeof imageJpeg === "string") {
      if (!width || !height || width <= 0 || height <= 0) {
        return new Response(JSON.stringify({ error: "width e height são obrigatórios e devem ser > 0." }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 400,
        });
      }
      if (width > 2048 || height > 2048) {
        return new Response(JSON.stringify({ error: "Imagem muito grande. Máximo: 2048×2048 pixels." }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 400,
        });
      }
      const { pixels } = decodeJpegToRGBA(imageJpeg);
      const result = await processBarcode(pixels, width, height);
      return new Response(JSON.stringify(result), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: result.success ? 200 : 422,
      });
    }

    // ── Modo legado: base64 RGBA (fallback compat) ──
    if (imageBase64 && typeof imageBase64 === "string") {
      if (!width || !height || width <= 0 || height <= 0) {
        return new Response(JSON.stringify({ error: "width e height são obrigatórios e devem ser > 0." }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 400,
        });
      }
      if (width > 2048 || height > 2048) {
        return new Response(JSON.stringify({ error: "Imagem muito grande. Máximo: 2048×2048 pixels." }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 400,
        });
      }
      const pixels = decodeBase64ToUint8Clamped(imageBase64);
      const expectedLength = width * height * 4;
      if (pixels.length !== expectedLength) {
        return new Response(
          JSON.stringify({
            error: "Tamanho dos pixels não bate. Esperado: " + expectedLength + ", recebido: " + pixels.length + ".",
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 400 },
        );
      }
      const result = await processBarcode(pixels, width, height);
      return new Response(JSON.stringify(result), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: result.success ? 200 : 422,
      });
    }

    return new Response(JSON.stringify({ error: "Envie imageJpeg (base64 JPEG) ou imageBase64 (base64 RGBA legado)." }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 400,
    });
  } catch (err) {
    return new Response(
      JSON.stringify({
        success: false,
        error: "Erro interno: " + (err as Error).message,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 },
    );
  }
});
