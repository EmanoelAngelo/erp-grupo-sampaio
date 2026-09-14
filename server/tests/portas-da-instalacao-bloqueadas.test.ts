import { describe, expect, it } from 'vitest';

/**
 * GAP-PRD-135 (lado do servidor): nenhum teste pode chamar a API ou o Vite que
 * rodam nesta máquina. Se o guarda do setup sumir, este teste fica vermelho.
 */
describe('a suíte do servidor não fala com a instalação da loja', () => {
  it.each(['http://localhost:8787/api/v1/health', 'http://127.0.0.1:8787/', 'http://localhost:3000/'])('recusa %s', async (url) => {
    await expect(fetch(url)).rejects.toThrow(/porta é da instalação da loja/);
  });
});
