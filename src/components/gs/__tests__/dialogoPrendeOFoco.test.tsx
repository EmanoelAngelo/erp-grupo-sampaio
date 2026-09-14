/**
 * O DIÁLOGO PRENDE O FOCO E O DEVOLVE (GAP-PRD-159).
 *
 * Cada teste cai quando o guarda correspondente sai de `DialogoBase`:
 *   - sem `aria-labelledby`, o diálogo não tem nome e o primeiro cai;
 *   - sem o foco inicial, o segundo cai (o foco fica no botão que abriu);
 *   - sem o giro do Tab, o terceiro cai;
 *   - sem o `focusin`, o foco que escapa para a venda fica lá, e o quarto cai;
 *   - sem devolver o foco, ele termina no `body` e o quinto cai;
 *   - sem a pilha, o diálogo de baixo rouba o foco do de cima e fecha junto no
 *     Esc, e o último cai.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { DialogoBase } from '../DialogoBase';
import { prenderFoco } from '../armadilhaDeFoco';
import { EstornoOsDialog } from '../EstornoOsDialog';

afterEach(cleanup);

function Palco({ aninhado = false }: { aninhado?: boolean }) {
  const [aberto, setAberto] = useState(false);
  const [segundo, setSegundo] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setAberto(true)}>
        Cancelar pedido
      </button>
      <button type="button">Botão da venda</button>
      {aberto && (
        <DialogoBase
          titulo="Cancelar o pedido 41"
          onFechar={() => setAberto(false)}
          focoInicial="[data-foco-inicial]"
        >
          <input aria-label="Motivo" data-foco-inicial />
          <button type="button" onClick={() => setSegundo(true)}>
            {aninhado ? 'Abrir o segundo' : 'Confirmar'}
          </button>
          {segundo && (
            <DialogoBase titulo="Tem certeza?" onFechar={() => setSegundo(false)}>
              <button type="button">Sim</button>
            </DialogoBase>
          )}
        </DialogoBase>
      )}
    </>
  );
}

function abrir() {
  const gatilho = screen.getByRole('button', { name: 'Cancelar pedido' });
  gatilho.focus();
  fireEvent.click(gatilho);
  return gatilho;
}

describe('DialogoBase', () => {
  it('o título nomeia o diálogo (aria-labelledby), e ele é modal', () => {
    render(<Palco />);
    abrir();
    const dialogo = screen.getByRole('dialog', { name: 'Cancelar o pedido 41' });
    expect(dialogo.getAttribute('aria-modal')).toBe('true');
  });

  it('ao abrir, o foco entra no campo marcado', () => {
    render(<Palco />);
    abrir();
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Motivo' }));
  });

  it('Tab no último volta ao primeiro, e Shift+Tab no primeiro vai ao último', () => {
    render(<Palco />);
    abrir();
    const dialogo = screen.getByRole('dialog');
    const fechar = within(dialogo).getByRole('button', { name: 'Fechar' });
    const confirmar = within(dialogo).getByRole('button', { name: 'Confirmar' });
    act(() => confirmar.focus());
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
    expect(document.activeElement).toBe(fechar);
    fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(confirmar);
  });

  it('o foco que escapa para a tela de trás volta para dentro do diálogo', () => {
    render(<Palco />);
    abrir();
    act(() => screen.getByRole('button', { name: 'Botão da venda' }).focus());
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
  });

  it('ao fechar (Esc), o foco volta ao botão que abriu', () => {
    render(<Palco />);
    const gatilho = abrir();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(gatilho);
  });

  it('diálogo dentro de diálogo: só o de cima prende o foco e fecha no Esc', () => {
    render(<Palco aninhado />);
    abrir();
    const abrirSegundo = screen.getByRole('button', { name: 'Abrir o segundo' });
    act(() => abrirSegundo.focus());
    fireEvent.click(abrirSegundo);
    const deCima = screen.getByRole('dialog', { name: 'Tem certeza?' });
    // O de cima recebeu o foco — e Tab gira dentro dele, não no de baixo.
    expect(deCima.contains(document.activeElement)).toBe(true);
    act(() => within(deCima).getByRole('button', { name: 'Sim' }).focus());
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
    expect(deCima.contains(document.activeElement)).toBe(true);
    // Esc fecha só o de cima; o de baixo continua aberto e o foco volta a quem abriu.
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Tem certeza?' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Cancelar o pedido 41' })).toBeTruthy();
    expect(document.activeElement).toBe(abrirSegundo);
  });
});

describe('prenderFoco — a mesma armadilha nas molduras próprias (callback ref)', () => {
  function Moldura() {
    const [aberto, setAberto] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setAberto(true)}>
          Abrir a moldura
        </button>
        {aberto && (
          <div role="dialog" aria-modal="true" aria-label="Moldura própria" ref={prenderFoco} tabIndex={-1}>
            <button type="button">Primeiro</button>
            <button type="button" onClick={() => setAberto(false)}>
              Fechar a moldura
            </button>
          </div>
        )}
      </>
    );
  }

  it('entra ao montar, gira no Tab e devolve o foco a quem abriu ao desmontar', () => {
    render(<Moldura />);
    const gatilho = screen.getByRole('button', { name: 'Abrir a moldura' });
    act(() => gatilho.focus());
    fireEvent.click(gatilho);
    const dialogo = screen.getByRole('dialog', { name: 'Moldura própria' });
    const primeiro = within(dialogo).getByRole('button', { name: 'Primeiro' });
    const fechar = within(dialogo).getByRole('button', { name: 'Fechar a moldura' });
    expect(document.activeElement).toBe(primeiro);
    act(() => fechar.focus());
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
    expect(document.activeElement).toBe(primeiro);
    fireEvent.click(fechar);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(gatilho);
  });

  it('um diálogo de verdade (estorno da OS) recebe o foco ao abrir', () => {
    render(
      <EstornoOsDialog os={{ id: 'os-1', number: 7, total_cents: 1000 }} onEstornado={() => {}} onCancel={() => {}} />,
    );
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
  });
});
