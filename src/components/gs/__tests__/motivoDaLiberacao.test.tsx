/**
 * O MOTIVO DA LIBERAÇÃO DE DESCONTO NO DIÁLOGO DO GESTOR (P0 da Preço Justo).
 *
 * O diálogo pedia usuário e senha e mais nada: o "motivo" que ficava na trilha
 * era a frase que a tela montava com os números, e o dono via QUANTO e QUEM,
 * nunca POR QUÊ. Agora a liberação de desconto passa `justificativa`, o campo
 * aparece, e onde a operação exige o botão só libera com o porquê escrito.
 *
 * Como falha: tirando o campo, o segundo e o terceiro caso não acham o que
 * digitar; tirando a trava do botão, o segundo caso autoriza com o campo vazio;
 * mandando o texto sem aparar, o terceiro recebe os espaços.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AutorizacaoGerenteDialog } from '../PagamentoDialog';

afterEach(() => cleanup());

function credenciais(container: HTMLElement) {
  fireEvent.change(screen.getByRole('textbox', { name: /Usuário do gestor/ }), {
    target: { value: 'gerente' },
  });
  const senha = container.querySelector('input[type="password"]') as HTMLInputElement;
  fireEvent.change(senha, { target: { value: 'senha-do-gerente' } });
}

describe('o diálogo do gestor pede o porquê da liberação de desconto', () => {
  it('sem `justificativa` (cancelar, sangria, reabrir) nada muda: não há campo de motivo', () => {
    const onConfirm = vi.fn();
    const { container } = render(
      <AutorizacaoGerenteDialog motivo="Cancelar a venda #12" onConfirm={onConfirm} onCancel={() => {}} />,
    );
    expect(screen.queryByRole('textbox', { name: /Motivo da liberação/ })).toBeNull();
    credenciais(container);
    fireEvent.click(screen.getByRole('button', { name: 'Autorizar' }));
    expect(onConfirm).toHaveBeenCalledWith('gerente', 'senha-do-gerente', '');
  });

  it('OBRIGATÓRIO: o botão só autoriza com o motivo escrito', () => {
    const onConfirm = vi.fn();
    const { container } = render(
      <AutorizacaoGerenteDialog
        motivo="Esta venda concede R$ 50,00 sobre R$ 100,00 (50%)"
        justificativa={{ obrigatorio: true }}
        onConfirm={onConfirm}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByText(/Motivo da liberação \(obrigatório\)/)).toBeTruthy();
    credenciais(container);
    const autorizar = screen.getByRole('button', { name: 'Autorizar' }) as HTMLButtonElement;
    expect(autorizar.disabled).toBe(true);

    fireEvent.change(screen.getByRole('textbox', { name: /Motivo da liberação/ }), { target: { value: 'ok' } });
    expect(autorizar.disabled).toBe(true);

    fireEvent.change(screen.getByRole('textbox', { name: /Motivo da liberação/ }), {
      target: { value: 'cliente fiel' },
    });
    expect(autorizar.disabled).toBe(false);
  });

  it('o motivo vai aparado para quem pede a liberação, e opcional não trava o botão', () => {
    const onConfirm = vi.fn();
    const { container } = render(
      <AutorizacaoGerenteDialog
        motivo="Desconto de R$ 30,00 na OS #7"
        justificativa={{ obrigatorio: false }}
        onConfirm={onConfirm}
        onCancel={() => {}}
      />,
    );
    expect(screen.queryByText(/\(obrigatório\)/)).toBeNull();
    credenciais(container);
    fireEvent.change(screen.getByRole('textbox', { name: /Motivo da liberação/ }), {
      target: { value: '   troca de peça com defeito  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Autorizar' }));
    expect(onConfirm).toHaveBeenCalledWith('gerente', 'senha-do-gerente', 'troca de peça com defeito');
  });
});
