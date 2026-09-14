/**
 * O menu abre recolhido.
 *
 * O DEFEITO QUE ORIGINOU ISTO
 *
 * A sidebar iniciava com `['Estoque', 'Vendas', 'Oficina']` expandidos. Três
 * grupos abertos de uma vez enchem a coluna: quem entrava no sistema via uma
 * lista rolável e tinha de FECHAR grupo para achar o que queria — trabalho
 * antes do trabalho. Fechado, cada grupo ocupa uma linha, o menu inteiro cabe
 * na tela e um clique abre o que interessa.
 *
 * `Sidebar` não é exportada (só `AppShell`, que exige router e sessão), então
 * a garantia é sobre a fonte — mesmo caminho do teste de atalhos do PDV.
 */
import { describe, expect, it } from 'vitest';
import FONTE from '../AppShell.tsx?raw';

/** Estado inicial do `useState` que controla os grupos abertos. */
function estadoInicial(): string {
  const m = FONTE.match(/const \[expanded, setExpanded\] = useState<string\[\]>\(([^)]*)\)/);
  if (!m) throw new Error('não achei o useState de `expanded` em AppShell.tsx');
  return m[1].trim();
}

describe('sidebar', () => {
  it('nenhum grupo vem aberto', () => {
    expect(estadoInicial()).toBe('[]');
  });

  it('não cita grupo nenhum no estado inicial', () => {
    // Basta um rótulo reaparecer aqui para o menu voltar a abrir preenchido.
    for (const grupo of ['Estoque', 'Vendas', 'Oficina', 'Financeiro', 'Produtos']) {
      expect(estadoInicial()).not.toContain(grupo);
    }
  });

  it('o grupo continua abrindo por clique', () => {
    // Recolher por padrão só vale se `toggle` seguir ligado ao botão.
    expect(FONTE).toContain('onClick={() => toggle(item.label)}');
    expect(FONTE).toContain('aria-expanded={isOpen}');
  });
});
