/**
 * O seletor do logo e da capa não oferece SVG (GAP-PRD-066).
 *
 * O servidor passou a recusar SVG — é documento e pode carregar script. Uma
 * tela que continuasse oferecendo o formato levaria o gerente a escolher o
 * arquivo e só então ler a recusa; o seletor já não o mostra.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import LojaAdminPage from '../LojaAdminPage';

const SETTINGS = {
  company_id: 'empresa-1',
  headline: null,
  description: null,
  whatsapp: null,
  banner_text: null,
  banner_active: 0,
  logo_url: null,
  cover_url: null,
  installments_max: null,
  updated_at: '2026-09-11T12:00:00.000Z',
};

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request) => {
      const alvo = String(url);
      const corpo = alvo.includes('/core/products/prontidao-online')
        ? { items: [] }
        : alvo.includes('/core/storefront')
          ? { settings: SETTINGS, products: [], preset: 'variedades' }
          : {};
      return new Response(JSON.stringify(corpo), {
        status: alvo.includes('/core/') ? 200 : 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('identidade da marca', () => {
  it('logo e capa aceitam PNG, JPEG e WebP — e não SVG', async () => {
    render(
      <MemoryRouter>
        <LojaAdminPage />
      </MemoryRouter>,
    );

    for (const rotulo of ['Enviar logo', 'Enviar capa']) {
      const campo = (await screen.findByLabelText(rotulo)) as HTMLInputElement;
      const aceitos = campo.accept.split(',').map((t) => t.trim());
      expect(aceitos).toEqual(['image/png', 'image/jpeg', 'image/webp']);
      expect(campo.accept).not.toMatch(/svg/i);
    }
  });
});
