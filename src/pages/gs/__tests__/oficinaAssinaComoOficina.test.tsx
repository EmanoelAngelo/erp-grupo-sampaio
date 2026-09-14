/**
 * A TELA MOSTRA — E DEIXA TROCAR — O NOME QUE SAI NO PAPEL.
 *
 * ============================================================================
 * POR QUE ESTA TELA PRECISAVA EXISTIR
 * ============================================================================
 *
 * A Ordem de Serviço da Oficina saía impressa com o nome PJ MOTORS. O vínculo
 * é legítimo — quem vendeu a moto responde pela garantia dela —, mas ele morava
 * numa MIGRAÇÃO: cravado em código e reimposto a cada subida do servidor. Não
 * havia onde mudar, e mudar direto no banco durava até o próximo deploy.
 *
 * O conserto tem três partes, e esta é a terceira: o servidor parou de
 * reimpor, o dado foi desfeito uma vez, e a escolha passou a ter tela. Sem a
 * terceira, o dono voltaria a depender de alguém mexer no banco por ele.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import OficinasPage from '../OficinasPage';

const BANCADA = {
  id: 'w-mobilidade',
  slug: 'oficina-mobilidade',
  name: 'Oficina de Mobilidade Elétrica',
  kind: 'mobility',
  capabilities: { kanban: true, parts: true, equipmentTags: true },
};

let marca: { brandCompanyId: string | null; brandName: string | null };
let trocasPedidas: { workshopId: string; brandCompanyId: string | null }[];

vi.mock('@/components/gs/AppShell', () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/lib/api/core', () => ({
  coreApi: {
    listWorkshops: () => Promise.resolve([BANCADA]),
    listTeam: () => Promise.resolve([]),
    listWorkshopMembers: () => Promise.resolve([]),
    listWorkshopBrands: () =>
      Promise.resolve([
        {
          workshopId: BANCADA.id,
          workshopName: BANCADA.name,
          brandCompanyId: marca.brandCompanyId,
          brandName: marca.brandName,
        },
      ]),
    listCompanies: () =>
      Promise.resolve([
        { id: 'c-oficina', slug: 'oficina', tradeName: 'Oficina', legalName: 'Oficina Ltda' },
        { id: 'c-pj', slug: 'pj-motors', tradeName: 'PJ Motors', legalName: 'PJ Motors Ltda' },
      ]),
    setWorkshopBrand: (workshopId: string, brandCompanyId: string | null) => {
      trocasPedidas.push({ workshopId, brandCompanyId });
      marca = brandCompanyId
        ? { brandCompanyId, brandName: 'PJ Motors' }
        : { brandCompanyId: null, brandName: null };
      return Promise.resolve({ workshopId, workshopName: BANCADA.name, ...marca });
    },
  },
}));

function abrir() {
  return render(
    <MemoryRouter>
      <OficinasPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  // A limpeza NÃO é automática nesta suíte (o setup não registra os globais do
  // testing-library). Sem ela, a tela do teste anterior fica no documento e a
  // busca por papel acha dois seletores.
  cleanup();
  marca = { brandCompanyId: 'c-pj', brandName: 'PJ Motors' };
  trocasPedidas = [];
});

// ============================================================================

describe('a identidade impressa aparece na tela', () => {
  it('o seletor mostra em nome de quem a bancada assina hoje', async () => {
    abrir();

    const seletor = (await screen.findByRole('combobox', { name: /Identidade impressa da bancada/ })) as HTMLSelectElement;

    expect(seletor.value).toBe('c-pj');
  });

  it('a tela diz o que aquele nome significa — é o que o cliente lê no papel', async () => {
    abrir();
    expect(
      await screen.findByText(/sai impresso na Ordem de Serviço que o cliente leva/i),
    ).toBeTruthy();
  });

  it('"em nome próprio" é uma opção, e é o padrão da Oficina', async () => {
    abrir();
    await screen.findByRole('combobox', { name: /Identidade impressa da bancada/ });
    expect(screen.getByRole('option', { name: 'Em nome próprio' })).toBeTruthy();
  });
});

// ============================================================================

describe('trocar a identidade chega ao servidor', () => {
  it('escolher "em nome próprio" manda nulo — e não uma string vazia', async () => {
    abrir();
    const seletor = await screen.findByRole('combobox', { name: /Identidade impressa da bancada/ });

    fireEvent.change(seletor, { target: { value: '' } });

    await waitFor(() => expect(trocasPedidas).toHaveLength(1));
    expect(trocasPedidas[0]).toEqual({ workshopId: 'w-mobilidade', brandCompanyId: null });
  });

  it('e a tela recarrega mostrando a escolha nova', async () => {
    abrir();
    const seletor = (await screen.findByRole('combobox', { name: /Identidade impressa da bancada/ })) as HTMLSelectElement;

    fireEvent.change(seletor, { target: { value: '' } });

    await waitFor(() => expect(seletor.value).toBe(''));
    expect(await screen.findByText(/Identidade do documento atualizada/i)).toBeTruthy();
  });

  it('escolher outra operação manda o id dela', async () => {
    marca = { brandCompanyId: null, brandName: null };
    abrir();
    const seletor = await screen.findByRole('combobox', { name: /Identidade impressa da bancada/ });

    fireEvent.change(seletor, { target: { value: 'c-pj' } });

    await waitFor(() => expect(trocasPedidas).toHaveLength(1));
    expect(trocasPedidas[0].brandCompanyId).toBe('c-pj');
  });
});
