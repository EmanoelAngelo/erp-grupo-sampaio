import { describe, expect, it } from 'vitest';

/**
 * GAP-PRD-135: a suíte de tela chegou a gravar no banco de produção porque um
 * `fetch` não dublado alcançava `localhost:8787`. Este teste prova que a rede
 * real não existe mais aqui dentro — se alguém remover o bloqueio do setup, ele
 * fica vermelho.
 */
describe('a suíte de tela não sai para a rede', () => {
  it('fetch real para a porta da API recusa como erro de rede', async () => {
    await expect(fetch('http://localhost:8787/api/v1/health')).rejects.toThrow(TypeError);
    await expect(fetch('http://localhost:8787/api/v1/health')).rejects.toThrow(/Rede real bloqueada/);
  });

  it('qualquer outro destino também é recusado', async () => {
    await expect(fetch('https://example.com/')).rejects.toThrow(/Rede real bloqueada/);
  });

  it('XMLHttpRequest real também não envia', () => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', 'http://localhost:8787/api/v1/health');
    expect(() => xhr.send()).toThrow(/Rede real bloqueada/);
  });
});
