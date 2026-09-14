/**
 * O MOTIVO E A CONFIRMAÇÃO NA TELA, NO LUGAR DO DIÁLOGO DO NAVEGADOR
 * (GAP-PRD-158).
 *
 * Cada teste cai quando o guarda sai de `PerguntaDaTela`:
 *   - sem o mínimo, o motivo em branco (ou de dois caracteres) passa e o
 *     segundo cai — era exatamente o que o `window.prompt` deixava passar;
 *   - sem o `trim`, o motivo volta com os espaços e o terceiro cai;
 *   - sem o `null` na desistência, a tela não distingue "desistiu" de "motivo
 *     vazio", e o quarto cai;
 *   - sem o foco começar em "Cancelar", o Enter por reflexo confirma, e o
 *     último cai.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useConfirmar, usePedirMotivo } from '../PerguntaDaTela';

afterEach(cleanup);

function PalcoMotivo({ aoResponder }: { aoResponder: (v: string | null) => void }) {
  const { pedirMotivo, dialogoDeMotivo } = usePedirMotivo();
  return (
    <>
      <button
        type="button"
        onClick={async () =>
          aoResponder(
            await pedirMotivo({
              titulo: 'Cancelar o inventário 7',
              minimo: 5,
              confirmar: 'Cancelar o inventário',
              perigoso: true,
            }),
          )
        }
      >
        Cancelar inventário
      </button>
      {dialogoDeMotivo}
    </>
  );
}

function PalcoConfirmar({ aoResponder }: { aoResponder: (v: boolean) => void }) {
  const { confirmar, dialogoDeConfirmacao } = useConfirmar();
  return (
    <>
      <button
        type="button"
        onClick={async () =>
          aoResponder(
            await confirmar({
              titulo: 'Desvincular a plaquinha?',
              mensagem: 'A plaquinha 0042 volta a ficar livre.',
              confirmar: 'Sim, desvincular',
              perigoso: true,
            }),
          )
        }
      >
        Desvincular
      </button>
      {dialogoDeConfirmacao}
    </>
  );
}

function abrirMotivo() {
  fireEvent.click(screen.getByRole('button', { name: 'Cancelar inventário' }));
  const dialogo = screen.getByRole('dialog', { name: 'Cancelar o inventário 7' });
  return { dialogo, campo: within(dialogo).getByRole('textbox', { name: /Motivo/ }) };
}

describe('usePedirMotivo', () => {
  it('abre com o título e o foco no campo do motivo', () => {
    render(<PalcoMotivo aoResponder={() => {}} />);
    const { campo } = abrirMotivo();
    expect(document.activeElement).toBe(campo);
  });

  it('motivo curto é recusado NA TELA, com a mensagem no campo, e a pergunta continua aberta', () => {
    const aoResponder = vi.fn();
    render(<PalcoMotivo aoResponder={aoResponder} />);
    const { dialogo, campo } = abrirMotivo();
    fireEvent.change(campo, { target: { value: '  ab  ' } });
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Cancelar o inventário' }));
    expect(within(dialogo).getByRole('alert').textContent).toBe(
      'Escreva o motivo com pelo menos 5 caracteres.',
    );
    expect(campo.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(aoResponder).not.toHaveBeenCalled();
  });

  it('o motivo válido volta aparado, e a pergunta fecha', async () => {
    const aoResponder = vi.fn();
    render(<PalcoMotivo aoResponder={aoResponder} />);
    const { dialogo, campo } = abrirMotivo();
    fireEvent.change(campo, { target: { value: '  contagem refeita  ' } });
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Cancelar o inventário' }));
    await waitFor(() => expect(aoResponder).toHaveBeenCalledWith('contagem refeita'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('desistir (Cancelar ou Esc) volta null, que é diferente de motivo vazio', async () => {
    const aoResponder = vi.fn();
    render(<PalcoMotivo aoResponder={aoResponder} />);
    const primeiro = abrirMotivo();
    fireEvent.click(within(primeiro.dialogo).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(aoResponder).toHaveBeenLastCalledWith(null));
    abrirMotivo();
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(aoResponder).toHaveBeenCalledTimes(2));
    expect(aoResponder).toHaveBeenLastCalledWith(null);
  });
});

describe('useConfirmar', () => {
  it('o foco começa em "Cancelar"; confirmar volta true, cancelar volta false', async () => {
    const aoResponder = vi.fn();
    render(<PalcoConfirmar aoResponder={aoResponder} />);
    fireEvent.click(screen.getByRole('button', { name: 'Desvincular' }));
    let dialogo = screen.getByRole('dialog', { name: 'Desvincular a plaquinha?' });
    expect(document.activeElement).toBe(within(dialogo).getByRole('button', { name: 'Cancelar' }));
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Sim, desvincular' }));
    await waitFor(() => expect(aoResponder).toHaveBeenLastCalledWith(true));
    fireEvent.click(screen.getByRole('button', { name: 'Desvincular' }));
    dialogo = screen.getByRole('dialog', { name: 'Desvincular a plaquinha?' });
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(aoResponder).toHaveBeenLastCalledWith(false));
  });
});
