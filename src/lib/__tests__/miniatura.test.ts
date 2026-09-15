/**
 * A MINIATURA DO BALCÃO, GERADA NO NAVEGADOR (P0 da Preço Justo).
 *
 * O servidor não tem biblioteca de imagem: quem desenha a miniatura é o canvas
 * de quem sobe a foto. Este arquivo trava o que ela precisa ser para o
 * servidor aceitar — lado de até 160 px, proporção mantida, WebP (JPEG no
 * navegador sem WebP), até 40 KB — e a memória das miniaturas que não
 * carregaram, que o balcão usa para não pedir o mesmo arquivo a cada tecla.
 *
 * O jsdom não desenha: o canvas é trocado por um que anota o que pediram.
 *
 * ## Como cada caso fica vermelho
 *
 *   - tire o degrau de qualidade e o caso dos 40 KB passa do teto;
 *   - aceite o PNG que o navegador sem WebP devolve e o caso do JPEG cai;
 *   - esqueça as falhas só por tempo (e não pelo `online`) e o caso da rede
 *     de volta fica vermelho.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MINIATURA_BYTES_MAX, MINIATURA_LADO_MAX, gerarMiniatura } from '../image';
import {
  anotarFalhaDeMiniatura,
  assinarFalhasDeMiniatura,
  esquecerFalhasDeMiniatura,
  miniaturaFalhou,
} from '../miniaturas';

/** Um data URL com `bytes` bytes de conteúdo (o base64 tem 4/3 disso). */
function comBytes(mime: string, bytes: number): string {
  return `data:${mime};base64,${'A'.repeat(Math.ceil((bytes * 4) / 3))}`;
}

let pedidos: Array<{ type: string; quality: number; width: number; height: number }>;
let respostaDoCanvas: (type: string, quality: number) => string;

beforeEach(() => {
  pedidos = [];
  respostaDoCanvas = (type) => comBytes(type, 8 * 1024);
  const ctx = { fillStyle: '', fillRect: vi.fn(), drawImage: vi.fn() };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as never);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(function (
    this: HTMLCanvasElement,
    type?: string,
    quality?: unknown,
  ) {
    const t = String(type);
    const q = Number(quality);
    pedidos.push({ type: t, quality: q, width: this.width, height: this.height });
    return respostaDoCanvas(t, q);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  esquecerFalhasDeMiniatura();
});

const foto = (width: number, height: number) => ({ width, height }) as unknown as HTMLImageElement;

describe('gerarMiniatura', () => {
  it('reduz a foto grande a 160 px no maior lado, mantendo a proporção, em WebP', () => {
    const mini = gerarMiniatura(foto(1600, 1200));
    expect(mini).not.toBeNull();
    expect(mini!.width).toBe(MINIATURA_LADO_MAX);
    expect(mini!.height).toBe(120);
    expect(mini!.mimeType).toBe('image/webp');
    expect(mini!.dataUrl.startsWith('data:image/webp')).toBe(true);
    expect(mini!.bytes).toBeLessThanOrEqual(MINIATURA_BYTES_MAX);
  });

  it('foto pequena não é esticada', () => {
    const mini = gerarMiniatura(foto(100, 50));
    expect(mini!.width).toBe(100);
    expect(mini!.height).toBe(50);
  });

  it('navegador sem WebP (devolve PNG em silêncio): cai para JPEG — nunca manda PNG', () => {
    respostaDoCanvas = (type) => (type === 'image/webp' ? comBytes('image/png', 9000) : comBytes(type, 9000));
    const mini = gerarMiniatura(foto(800, 800));
    expect(mini!.mimeType).toBe('image/jpeg');
    expect(mini!.dataUrl.startsWith('data:image/jpeg')).toBe(true);
  });

  it('acima de 40 KB, a qualidade desce até caber', () => {
    respostaDoCanvas = (type, q) => comBytes(type, q > 0.6 ? 60 * 1024 : 20 * 1024);
    const mini = gerarMiniatura(foto(1600, 1600));
    expect(mini!.bytes).toBeLessThanOrEqual(MINIATURA_BYTES_MAX);
    expect(pedidos.map((p) => p.quality)).toEqual([0.72, 0.55]);
  });

  it('se nem a menor qualidade cabe em 160 px, tenta 120 px', () => {
    respostaDoCanvas = (type) => comBytes(type, 20 * 1024);
    let chamadas = 0;
    respostaDoCanvas = (type) => {
      chamadas += 1;
      return comBytes(type, chamadas <= 3 ? 50 * 1024 : 10 * 1024);
    };
    const mini = gerarMiniatura(foto(1600, 1600));
    expect(mini!.width).toBe(120);
    expect(mini!.bytes).toBeLessThanOrEqual(MINIATURA_BYTES_MAX);
  });

  it('sem canvas, não há miniatura (a foto sobe sem ela e entra na fila do preenchimento)', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    expect(gerarMiniatura(foto(800, 600))).toBeNull();
  });

  it('imagem sem tamanho não vira miniatura', () => {
    expect(gerarMiniatura(foto(0, 0))).toBeNull();
  });
});

describe('a memória das miniaturas que falharam', () => {
  it('a falha fica anotada até o navegador dizer que a rede voltou', () => {
    const desassinar = assinarFalhasDeMiniatura(() => {});
    anotarFalhaDeMiniatura('http://api/uploads/produtos/a-mini-1.webp');
    expect(miniaturaFalhou('http://api/uploads/produtos/a-mini-1.webp')).toBe(true);
    window.dispatchEvent(new Event('online'));
    expect(miniaturaFalhou('http://api/uploads/produtos/a-mini-1.webp')).toBe(false);
    desassinar();
  });

  it('avisa quem assinou quando uma falha é anotada', () => {
    const ouvinte = vi.fn();
    const desassinar = assinarFalhasDeMiniatura(ouvinte);
    anotarFalhaDeMiniatura('http://api/x-mini.webp');
    anotarFalhaDeMiniatura('http://api/x-mini.webp'); // a mesma de novo: nada muda
    expect(ouvinte).toHaveBeenCalledTimes(1);
    desassinar();
  });
});
