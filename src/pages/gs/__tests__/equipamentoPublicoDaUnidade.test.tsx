/**
 * A PÁGINA QUE O QR ABRE — agora também para a moto do estoque da PJ Motors
 * (P0 das plaquinhas).
 *
 * O adesivo que a PJ gera e cola na moto do pátio passou a abrir a página pela
 * UNIDADE (`origem: 'unidade'`), sem máquina e sem ficha de dono no portal. O
 * que só a tela prova:
 *
 *   - o 404 continua um só (token inventado e adesivo ainda não vinculado são
 *     iguais para o servidor), e a frase cobre os dois casos — quem acabou de
 *     colar sabe que falta vincular;
 *   - na moto da PJ o botão "Entrar na minha conta" some: ele levaria a uma
 *     lista vazia, porque não há máquina com dono;
 *   - na máquina da Oficina (origem ausente, servidor antigo, ou
 *     `equipamento`) o botão continua.
 *
 * Mordida: volte o bloco do dono a aparecer sempre e o caso da unidade fica
 * vermelho; volte a frase do 404 e o primeiro caso fica vermelho.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import EquipamentoPublicoPage from '../EquipamentoPublicoPage';

let resposta: { status: number; body: unknown };

function montar() {
  render(
    <MemoryRouter initialEntries={['/equipamento/tok-da-moto']}>
      <Routes>
        <Route path="/equipamento/:token" element={<EquipamentoPublicoPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

function vista(extra: Record<string, unknown> = {}) {
  return {
    publicIdLabel: '#0042',
    brand: 'Honda',
    model: 'CG 160',
    color: null,
    category: 'Moto',
    workshopName: null,
    companyName: 'PJ Motors',
    inService: false,
    status: 'Disponível na loja',
    timeline: [],
    ...extra,
  };
}

beforeEach(() => {
  resposta = { status: 200, body: vista() };
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(JSON.stringify(resposta.body), {
        status: resposta.status,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('a página do QR da moto do estoque', () => {
  it('404: "Não encontramos esta plaquinha", e a frase cobre o adesivo ainda não vinculado', async () => {
    resposta = {
      status: 404,
      body: { error: { code: 'LOJA_EQUIPAMENTO_NAO_ENCONTRADO', message: 'Equipamento não encontrado.' } },
    };
    montar();
    expect(await screen.findByText('Não encontramos esta plaquinha.')).toBeTruthy();
    expect(screen.getByText(/ainda não ter sido vinculado a uma moto/)).toBeTruthy();
    expect(screen.queryByText('Entrar na minha conta')).toBeNull();
  });

  it('origem "unidade": a moto da PJ, sem o botão da conta — fale com a loja', async () => {
    resposta = { status: 200, body: vista({ origem: 'unidade' }) };
    montar();
    expect(await screen.findByText('#0042')).toBeTruthy();
    expect(screen.getByText('Honda · CG 160')).toBeTruthy();
    expect(screen.getByText('Disponível na loja')).toBeTruthy();
    expect(screen.getByText(/Moto da PJ Motors\. Dúvidas sobre ela\? Fale com a loja\./)).toBeTruthy();
    expect(screen.queryByText('Entrar na minha conta')).toBeNull();
    expect(screen.queryByText(/É o dono deste equipamento/)).toBeNull();
  });

  it('a máquina da Oficina (origem ausente ou "equipamento") continua com o botão da conta', async () => {
    resposta = { status: 200, body: vista({ workshopName: 'Oficina de Mobilidade', status: null }) };
    montar();
    expect(await screen.findByText('Entrar na minha conta')).toBeTruthy();
    cleanup();

    resposta = { status: 200, body: vista({ workshopName: 'Oficina de Mobilidade', status: null, origem: 'equipamento' }) };
    montar();
    expect(await screen.findByText('Entrar na minha conta')).toBeTruthy();
    expect(screen.queryByText(/Fale com a loja\./)).toBeNull();
  });
});
