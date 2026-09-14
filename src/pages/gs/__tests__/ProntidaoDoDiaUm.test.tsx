/**
 * Prontidão do dia 1 — a tela (GAP-PRD-034).
 *
 * O que ela precisa fazer: mostrar, por operação, cada item com o estado lido
 * do servidor, o que falta em palavras de gente, QUEM resolve (a loja pela
 * tela, ou o servidor pelo `.env`) e o link da tela onde se resolve — e dizer
 * a falha quando o servidor não responde, em vez de uma lista vazia que
 * pareceria "nada pendente".
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ProntidaoDoDiaUmPage from '../ProntidaoDoDiaUmPage';
import { diaUmApi, type ProntidaoDaOperacao } from '@/lib/api/envios';
import { ApiRequestError } from '@/lib/api/client';

function operacao(over: Partial<ProntidaoDaOperacao> = {}): ProntidaoDaOperacao {
  return {
    companyId: 'gringa',
    companyName: 'Gringa',
    pendentes: 2,
    pronta: false,
    itens: [
      {
        chave: 'entrega',
        titulo: 'Entrega pelo site',
        estado: 'escolha',
        detalhe: 'A loja oferece só RETIRADA (o padrão seguro).',
        quem: 'loja',
        onde: '/sistema/loja/entrega',
      },
      {
        chave: 'cep_origem',
        titulo: 'CEP de onde a mercadoria sai',
        estado: 'pendente',
        detalhe: 'Sem o CEP da operação não há cotação de transportadora.',
        quem: 'loja',
        onde: '/sistema/fiscal/configuracao',
      },
      {
        chave: 'email',
        titulo: 'E-mail para o cliente (SMTP)',
        estado: 'pendente',
        detalhe: 'O servidor ainda não tem SMTP: falta EMAIL_SMTP_HOST.',
        quem: 'servidor',
        onde: '/sistema/loja/emails',
      },
      {
        chave: 'produtos_publicados',
        titulo: 'Produtos na loja online',
        estado: 'ok',
        detalhe: '3 produto(s) publicado(s).',
        quem: 'loja',
        onde: '/sistema/produtos/prontidao-online',
      },
    ],
    ...over,
  };
}

function montar() {
  render(
    <MemoryRouter>
      <ProntidaoDoDiaUmPage />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('prontidão do dia 1', () => {
  it('cada operação com os itens, quem resolve e onde', async () => {
    vi.spyOn(diaUmApi, 'ler').mockResolvedValue({
      operacoes: [operacao(), operacao({ companyId: 'me-mimei', companyName: 'Me Mimei', pendentes: 0, pronta: true, itens: [] })],
    });
    montar();

    const gringa = await screen.findByTestId('dia-um-gringa');
    expect(screen.getByText('2 pendência(s) para operar completo.')).toBeTruthy();
    expect(screen.getByText('Nada pendente.')).toBeTruthy();

    const cep = within(gringa).getByText('CEP de onde a mercadoria sai').closest('li') as HTMLElement;
    expect(within(cep).getByText('Falta')).toBeTruthy();
    expect(within(cep).getByText(/Resolve: a loja/)).toBeTruthy();
    expect(within(cep).getByRole('link', { name: 'Abrir a tela' }).getAttribute('href')).toBe('/sistema/fiscal/configuracao');

    const smtp = within(gringa).getByText('E-mail para o cliente (SMTP)').closest('li') as HTMLElement;
    expect(within(smtp).getByText(/quem administra o servidor/)).toBeTruthy();

    // Escolha não é falta: aparece com rótulo próprio.
    const entrega = within(gringa).getByText('Entrega pelo site').closest('li') as HTMLElement;
    expect(within(entrega).getByText('Escolha da loja')).toBeTruthy();

    // Item pronto não manda ninguém a lugar nenhum.
    const produtos = within(gringa).getByText('Produtos na loja online').closest('li') as HTMLElement;
    expect(within(produtos).queryByRole('link')).toBeNull();
  });

  it('o servidor recusou: a tela diz, e não mostra lista vazia como se estivesse tudo pronto', async () => {
    vi.spyOn(diaUmApi, 'ler').mockRejectedValue(new ApiRequestError('CORE_FORBIDDEN', 'Perfil sem acesso.', 403));
    montar();
    expect((await screen.findByRole('alert')).textContent).toMatch(/Perfil sem acesso/);
    expect(screen.queryByText('Nada pendente.')).toBeNull();
  });
});
