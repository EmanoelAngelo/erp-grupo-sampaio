/**
 * O EDITOR DE MODELOS guarda a SAÍDA, a CALIBRAÇÃO e os ajustes da térmica
 * (P0 das etiquetas).
 *
 * Sem estes campos, a térmica que puxa o papel 1 mm torto imprimia todas as
 * etiquetas tortas, e a saída em ZPL/EPL/TSPL não tinha de onde tirar a
 * densidade, o corte e o sensor da mídia.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { setSession } from '@/lib/api/client';
import type { PerfilDeImpressao } from '@/lib/api/core';
import { ModelosDeEtiqueta } from '../ModelosDeEtiqueta';

let enviado: Record<string, unknown> | null;

const PERFIS: PerfilDeImpressao[] = [
  { id: 'navegador', rotulo: 'Navegador (diálogo de impressão)', dica: '', saida: 'html', mime: 'text/html', extensao: 'html', aceitaFolha: true, levaAjustesDaTermica: false },
  { id: 'pdf', rotulo: 'PDF (arquivo)', dica: '', saida: 'pdf', mime: 'application/pdf', extensao: 'pdf', aceitaFolha: true, levaAjustesDaTermica: false },
  { id: 'zpl', rotulo: 'ZPL (Zebra e compatíveis)', dica: '', saida: 'zpl', mime: 'text/plain', extensao: 'zpl', aceitaFolha: false, levaAjustesDaTermica: true },
];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
  enviado = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: { method?: string; body?: string }) => {
      const alvo = String(url);
      const metodo = (init?.method ?? 'GET').toUpperCase();
      if (alvo.includes('/core/labels/templates/preview')) return json({ html: '<html></html>', etiquetas: 1, folhas: 1 });
      if (alvo.includes('/core/labels/templates') && (metodo === 'POST' || metodo === 'PATCH')) {
        enviado = JSON.parse(init?.body ?? '{}');
        return json({ id: 'novo', ...enviado, printerName: null, avisos: [] }, 201);
      }
      if (alvo.includes('/core/labels/templates')) return json({ items: [], campos: [{ id: 'nome', rotulo: 'Nome do produto' }] });
      return json({ items: [] });
    }),
  );
  setSession(
    {
      accessToken: 'tok', refreshToken: 'r', expiresAt: Date.now() + 3_600_000,
      user: { id: 'u1', login: 'gestor', displayName: 'Gestor', profileCode: 'gerente_loja' },
      company: { id: 'c1', slug: 'preco-justo', tradeName: 'Preço Justo', kind: 'retail' },
      companies: [],
    } as never,
    'LOGIN',
    'teste da impressora do modelo',
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setSession(null, 'LOGOUT', 'fim do teste da impressora do modelo');
});

describe('a saída, a calibração e a mídia no editor do modelo', () => {
  it('o modelo novo nasce no padrão (navegador, sem deslocamento, sem corte, sensor de vão)', async () => {
    render(<ModelosDeEtiqueta podeEditar formatosProntos={[]} perfis={PERFIS} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Novo modelo' }));
    expect((screen.getByLabelText('Saída padrão') as HTMLSelectElement).value).toBe('');
    expect((screen.getByLabelText('Deslocamento horizontal (mm)') as HTMLInputElement).value).toBe('0');
    expect((screen.getByLabelText('Corte') as HTMLSelectElement).value).toBe('nenhum');
    expect((screen.getByLabelText('Sensor da mídia') as HTMLSelectElement).value).toBe('vao');
  });

  it('escolher ZPL, calibrar −0,5 mm, corte no fim do lote e marca preta vai ao servidor', async () => {
    render(<ModelosDeEtiqueta podeEditar formatosProntos={[]} perfis={PERFIS} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Novo modelo' }));
    fireEvent.change(screen.getByLabelText('Nome do modelo'), { target: { value: 'Balcão ZPL' } });
    fireEvent.change(screen.getByLabelText('Saída padrão'), { target: { value: 'zpl' } });
    fireEvent.change(screen.getByLabelText('Deslocamento horizontal (mm)'), { target: { value: '-0.5' } });
    fireEvent.change(screen.getByLabelText('Densidade (0 a 30)'), { target: { value: '18' } });
    fireEvent.change(screen.getByLabelText('Corte'), { target: { value: 'fim_do_lote' } });
    fireEvent.change(screen.getByLabelText('Sensor da mídia'), { target: { value: 'marca' } });
    fireEvent.change(screen.getByLabelText('Vão entre etiquetas (mm)'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar modelo' }));
    await waitFor(() => expect(enviado).not.toBeNull());
    expect(enviado).toMatchObject({
      name: 'Balcão ZPL', outputProfile: 'zpl', offsetXmm: -0.5, darkness: 18, cutMode: 'fim_do_lote', mediaType: 'marca', mediaGapMm: 3,
    });
  });

  it('na FOLHA, a saída de térmica fica indisponível e diz por quê; papel contínuo desliga o vão', async () => {
    render(<ModelosDeEtiqueta podeEditar formatosProntos={[]} perfis={PERFIS} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Novo modelo' }));
    fireEvent.click(screen.getByLabelText(/Folha \(A4 adesiva ou outra\)/));
    const zpl = screen.getByRole('option', { name: /ZPL \(Zebra e compatíveis\) — só rolo/ }) as HTMLOptionElement;
    expect(zpl.disabled).toBe(true);
    expect((screen.getByRole('option', { name: 'PDF (arquivo)' }) as HTMLOptionElement).disabled).toBe(false);
    fireEvent.change(screen.getByLabelText('Sensor da mídia'), { target: { value: 'continua' } });
    expect((screen.getByLabelText('Vão entre etiquetas (mm)') as HTMLInputElement).disabled).toBe(true);
  });
});
