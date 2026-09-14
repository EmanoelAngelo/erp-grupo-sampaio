/**
 * "/sistema" É A PORTA DO SISTEMA, E NÃO UMA LOJA.
 *
 * Na verificação em navegador da remediação, o endereço /sistema — o que a
 * pessoa digita para chegar à gestão — caía na rota dinâmica /:storeSlug e
 * mostrava "Esta loja não existe". Agora ele abre o painel, com o mesmo guarda
 * de /sistema/painel (sem sessão, o guarda manda ao login). Que a tela monta e
 * sobrevive à API fora do ar, `toda-tela-monta` prova — ela lê as rotas daqui.
 */
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { gsRoutes } from '../gsRoutes';

function elementoDe(caminho: string): ReactElement<Record<string, unknown>> {
  const rota = gsRoutes.find((r) => r.path === caminho);
  expect(rota, caminho).toBeDefined();
  return rota!.element as ReactElement<Record<string, unknown>>;
}

describe('/sistema é a porta do sistema', () => {
  it('/sistema abre a mesma tela de /sistema/painel, com o mesmo guarda', () => {
    const porta = elementoDe('/sistema');
    const painel = elementoDe('/sistema/painel');
    // O mesmo componente de guarda, com as mesmas regras de acesso…
    expect(porta.type).toBe(painel.type);
    const { children: telaDaPorta, ...guardaDaPorta } = porta.props;
    const { children: telaDoPainel, ...guardaDoPainel } = painel.props;
    expect(guardaDaPorta).toEqual(guardaDoPainel);
    // …e, dentro dele, a mesma tela.
    expect((telaDaPorta as ReactElement).type).toBe((telaDoPainel as ReactElement).type);
  });
});
