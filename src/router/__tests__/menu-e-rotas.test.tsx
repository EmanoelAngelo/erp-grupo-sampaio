/**
 * O menu e o roteador contam a mesma história?
 *
 * ## Por que este arquivo existe
 *
 * O sistema já teve 18 roteadores inteiros inalcançáveis — código escrito,
 * testado e aprovado que devolvia 403 para todo mundo. E teve o caso inverso:
 * telas construídas que nunca entraram no menu, existindo só para quem soubesse
 * digitar a URL.
 *
 * Nenhum dos dois foi encontrado por teste. Foram encontrados por auditoria,
 * meses depois, lendo arquivo por arquivo. O único teste que teria pego os dois
 * sozinho é este — e ele não existia.
 *
 * ## O que se cobra
 *
 * 1. todo item de menu leva a uma rota que existe;
 * 2. nenhum item marcado como "em breve" tem link;
 * 3. o AMBIENTE que o menu declara cabe dentro do que a rota exige;
 * 4. o PERFIL que o menu declara cabe dentro do que a rota exige.
 *
 * O terceiro é o menos óbvio e o mais útil: um item que aparece para o
 * mecânico apontando para uma rota `ROTA_GESTAO` não vaza nada — o guarda
 * devolve — mas oferece uma porta que bate na cara de quem tenta abrir, e isso
 * chega como "o sistema está com defeito".
 *
 * O quarto nasceu com "Empresas do grupo", a primeira tela cujo guarda de
 * servidor é mais estreito que o ambiente inteiro (`requireProfile` sem perfil
 * extra: só `admin_geral` e `gestor`). Sem ele, a declaração de perfil poderia
 * sair da rota, ficar no menu — ou o contrário — e os dois lados divergiriam
 * em silêncio, que é como o desalinhamento de ambiente durou tanto tempo.
 */
import { describe, expect, it } from 'vitest';
import type { ReactElement } from 'react';
import type { RouteObject } from 'react-router-dom';
import { gsRoutes } from '../gsRoutes';
import { NAV_ITEMS, type NavChild } from '@/components/gs/navItems';
import type { Environment } from '../environments';

/** O que uma rota exige: ambiente e, quando declara, perfil. */
interface ExigenciaDaRota {
  environments: Environment[] | null;
  profiles: readonly string[] | null;
}

/** Caminho → exigências. Rota pública entra com ambiente `null`. */
function rotasDeclaradas(): Map<string, ExigenciaDaRota> {
  const mapa = new Map<string, ExigenciaDaRota>();
  for (const rota of gsRoutes as RouteObject[]) {
    if (!rota.path) continue;
    // `protectedRoute` embrulha em `<Protected environments={...}>`; rota
    // pública guarda a página direto. A ausência da prop É a informação.
    const props = (rota.element as ReactElement | undefined)?.props as
      | { environments?: Environment[]; profiles?: readonly string[] }
      | undefined;
    mapa.set(rota.path, {
      environments: props?.environments ?? null,
      profiles: props?.profiles ?? null,
    });
  }
  return mapa;
}

interface ItemDeMenu {
  label: string;
  to?: string;
  pending?: boolean;
  environments?: Environment[];
  profiles?: readonly string[];
}

/** Todos os itens clicáveis do menu, com ambiente e perfil efetivos. */
function itensDoMenu(): ItemDeMenu[] {
  const saida: ItemDeMenu[] = [];
  for (const grupo of NAV_ITEMS) {
    if (grupo.to) {
      saida.push({
        label: grupo.label,
        to: grupo.to,
        environments: grupo.environments,
        profiles: grupo.profiles,
      });
    }
    for (const filho of (grupo.children ?? []) as NavChild[]) {
      saida.push({
        label: `${grupo.label} › ${filho.label}`,
        to: filho.to,
        pending: filho.pending,
        // Filho sem declaração herda o do grupo — é a regra que `navItems`
        // documenta, e o teste tem de usar a mesma, senão mede outra coisa.
        environments: filho.environments ?? grupo.environments,
        profiles: filho.profiles ?? grupo.profiles,
      });
    }
  }
  return saida;
}

describe('todo item de menu leva a algum lugar', () => {
  it('nenhum item aponta para caminho sem rota', () => {
    const rotas = rotasDeclaradas();
    const quebrados = itensDoMenu()
      .filter((i) => i.to && !i.pending && !rotas.has(i.to))
      .map((i) => `${i.label} → ${i.to}`);

    expect(quebrados.join('\n')).toBe('');
  });

  it('item marcado como "em breve" não vira link', () => {
    // Link quebrado para preencher menu é pior que ausência — é a decisão que
    // o próprio `navItems` declara no cabeçalho.
    const comLink = itensDoMenu()
      .filter((i) => i.pending && i.to)
      .map((i) => i.label);

    expect(comLink.join(', ')).toBe('');
  });

  it('a varredura encontra menu de verdade (senão não prova nada)', () => {
    // Se `NAV_ITEMS` mudar de forma e a leitura acima parar de enxergar os
    // filhos, os dois casos acima ficariam verdes varrendo uma lista vazia.
    expect(itensDoMenu().filter((i) => i.to).length).toBeGreaterThan(40);
    expect(rotasDeclaradas().size).toBeGreaterThan(40);
  });
});

describe('menu e guarda concordam sobre quem entra', () => {
  it('o ambiente do item cabe no que a rota exige', () => {
    const rotas = rotasDeclaradas();
    const divergentes: string[] = [];

    for (const item of itensDoMenu()) {
      if (!item.to || item.pending) continue;
      if (!rotas.has(item.to)) continue; // já cobrado acima

      const exigidos = rotas.get(item.to)!.environments;
      if (exigidos === null) continue; // rota pública aceita qualquer um

      // Item sem declaração herda o padrão do menu, que é a gestão.
      const oferecidos = item.environments ?? (['gestao'] as Environment[]);
      const sobrando = oferecidos.filter((amb) => !exigidos.includes(amb));

      if (sobrando.length > 0) {
        divergentes.push(
          `${item.label} (${item.to}) aparece para [${sobrando.join(', ')}], ` +
            `mas a rota só aceita [${exigidos.join(', ')}]`,
        );
      }
    }

    expect(divergentes.join('\n')).toBe('');
  });

  /**
   * O PERFIL do item cabe no que a rota exige.
   *
   * A assimetria com o ambiente é intencional e vale a pena explicar: rota sem
   * `profiles` aceita todo perfil do ambiente, então item sem `profiles`
   * apontando para ela está certo. O que não pode acontecer é o contrário — a
   * ROTA restringir e o MENU não —, porque aí o item aparece para quem o
   * guarda devolve para casa. Sem o clique, a pessoa nem descobre por quê:
   * ela só vê o menu piscar e voltar ao painel.
   *
   * Este caso fica vermelho se `profiles` sair do item "Empresas do grupo" em
   * `navItems.ts` mantendo-se na rota, e o de baixo fica vermelho no inverso.
   */
  it('o perfil do item cabe no que a rota exige', () => {
    const rotas = rotasDeclaradas();
    const divergentes: string[] = [];

    for (const item of itensDoMenu()) {
      if (!item.to || item.pending) continue;
      const exigencia = rotas.get(item.to);
      if (!exigencia || exigencia.environments === null) continue;

      const exigidos = exigencia.profiles;
      if (exigidos === null) continue; // a rota não restringe perfil

      const oferecidos = item.profiles;
      if (!oferecidos) {
        divergentes.push(
          `${item.label} (${item.to}) aparece para todo perfil do ambiente, ` +
            `mas a rota só aceita [${exigidos.join(', ')}]`,
        );
        continue;
      }

      const sobrando = oferecidos.filter((p) => !exigidos.includes(p));
      if (sobrando.length > 0) {
        divergentes.push(
          `${item.label} (${item.to}) aparece para [${sobrando.join(', ')}], ` +
            `mas a rota só aceita [${exigidos.join(', ')}]`,
        );
      }
    }

    expect(divergentes.join('\n')).toBe('');
  });

  /**
   * A recíproca: item restrito só existe sobre rota restrita.
   *
   * Um item que some do menu de quem a rota deixaria entrar é o defeito
   * simétrico — a tela vira segredo, alcançável só por quem souber digitar a
   * URL. O sistema já teve telas assim, e só apareceram em auditoria.
   */
  it('item restrito por perfil aponta para rota igualmente restrita', () => {
    const rotas = rotasDeclaradas();
    const soltos = itensDoMenu()
      .filter((i) => i.to && !i.pending && i.profiles)
      .filter((i) => {
        const exigencia = rotas.get(i.to!);
        return !exigencia || exigencia.profiles === null;
      })
      .map((i) => `${i.label} → ${i.to}`);

    expect(soltos.join('\n')).toBe('');
  });

  /**
   * A varredura enxerga a dimensão de perfil de verdade.
   *
   * Sem este caso, os dois acima ficariam verdes para sempre no dia em que a
   * leitura de `profiles` parasse de funcionar — comparariam `null` com `null`
   * em todas as linhas e não provariam nada. É a mesma armadilha que o caso
   * "a varredura encontra menu de verdade" já cobre para o resto do arquivo.
   */
  it('existe ao menos uma rota e um item declarando perfil', () => {
    const rotasComPerfil = [...rotasDeclaradas().values()].filter((r) => r.profiles !== null);
    const itensComPerfil = itensDoMenu().filter((i) => i.profiles);

    expect(rotasComPerfil.length).toBeGreaterThan(0);
    expect(itensComPerfil.length).toBeGreaterThan(0);
  });
});
