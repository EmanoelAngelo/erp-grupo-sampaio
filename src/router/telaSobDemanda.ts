/**
 * ============================================================================
 * TELA SOB DEMANDA — `React.lazy` + `Suspense`, sem remontar e sem piscar
 * (GAP-PRD-210)
 * ============================================================================
 *
 * O roteador importava as setenta telas de uma vez, e o build saía num pacote
 * único de 1,7 MB que todo caixa baixava para abrir o PDV. Cada tela agora é um
 * `import()` próprio, e o Vite corta um pedaço para cada módulo de página.
 *
 * ## Por que uma fábrica, e não `lazy()` solto em cada rota
 *
 * 1. **O `Suspense` vem junto.** Toda tela carrega dentro do próprio limite,
 *    com o estado de carregamento acessível (`CarregandoTela`). Quem monta a
 *    tela fora do roteador — os testes que varrem `gsRoutes` — não precisa
 *    lembrar de pôr um.
 * 2. **Pedaço que falha vira aviso, não estouro.** O `import()` que rejeita
 *    (rede caída, deploy com a aba aberta) resolve para `TelaNaoCarregou`. O
 *    erro de RENDER da tela continua subindo para a fronteira de erro como
 *    antes: a fábrica só troca a falha de carregar, e por isso a varredura de
 *    `toda-tela-monta.test.tsx` segue enxergando tela que estoura.
 * 3. **Tela já carregada desenha na hora.** Se o módulo já chegou (por
 *    `carregar()` ou por uma visita anterior), o `lazy` recebe um thenable que
 *    resolve de forma SÍNCRONA, e o React desenha a tela sem mostrar o
 *    carregando nem por um quadro. A árvore é sempre a mesma
 *    (`Suspense > lazy`), então nada remonta: o carrinho e o formulário meio
 *    preenchido não se perdem quando o pai redesenha.
 * 4. **O nome da exportação é conferido.** `exportacao` é uma chave do módulo
 *    (erro de compilação se não existir), e um módulo que chegue sem ela
 *    derruba `carregar()` com o nome da tela — que é o que a varredura de
 *    `toda-tela-monta.test.tsx` chama antes de montar.
 */
import { createElement, lazy, Suspense, type ComponentType } from 'react';
import { CarregandoTela, TelaNaoCarregou } from './EstadosDaTela';

export interface TelaSobDemanda<P extends object = any> {
  (props: P): ReturnType<typeof createElement>;
  displayName?: string;
  /** Baixa o pedaço da tela sem desenhá-la. Repetir não baixa de novo. */
  carregar(): Promise<void>;
  /** Marca que o roteador e os testes leem. */
  readonly sobDemanda: true;
}

const registradas: Array<() => Promise<void>> = [];

/**
 * Cria a tela a partir do `import()` do módulo dela.
 *
 * `nome` serve ao DevTools e às mensagens. `exportacao` é o export do módulo
 * que é a tela — `default` quando omitido:
 *
 *   telaSobDemanda('PainelPage', () => import('@/pages/gs/PainelPage'))
 *   telaSobDemanda('PedidosPage', () => import('@/pages/gs/GestaoPages'), 'PedidosPage')
 */
export function telaSobDemanda<M extends object, P extends object = any>(
  nome: string,
  importar: () => Promise<M>,
  exportacao?: Extract<keyof M, string>,
): TelaSobDemanda<P> {
  const chave: string = exportacao ?? 'default';
  let pronta: ComponentType<P> | null = null;
  let emCurso: Promise<ComponentType<P>> | null = null;

  const buscar = (): Promise<ComponentType<P>> => {
    if (!emCurso) {
      emCurso = importar().then(
        (modulo) => {
          const componente = (modulo as Record<string, unknown>)[chave];
          if (typeof componente !== 'function' && (typeof componente !== 'object' || componente === null)) {
            throw new Error(`o módulo da tela ${nome} não exporta "${chave}"`);
          }
          pronta = componente as ComponentType<P>;
          return pronta;
        },
        (erro: unknown) => {
          // Uma falha não fica guardada: a próxima tentativa busca de novo.
          emCurso = null;
          throw erro;
        },
      );
    }
    return emCurso;
  };

  const Preguicosa = lazy<ComponentType<P>>(() => {
    if (pronta) {
      const componente = pronta;
      // Thenable síncrono: o `lazy` lê o estado logo depois de chamar `then`,
      // e com o módulo já na mão ele desenha sem suspender.
      const imediato = {
        then(resolver: (modulo: { default: ComponentType<P> }) => void) {
          resolver({ default: componente });
        },
      };
      return imediato as unknown as Promise<{ default: ComponentType<P> }>;
    }
    return buscar().then(
      (componente) => ({ default: componente }),
      (erro: unknown) => {
        console.error(`[telas] a tela ${nome} não carregou`, erro);
        return { default: TelaNaoCarregou as unknown as ComponentType<P> };
      },
    );
  });

  const Tela = ((props: P) =>
    createElement(
      Suspense,
      { fallback: createElement(CarregandoTela) },
      createElement(Preguicosa as ComponentType<P>, props),
    )) as TelaSobDemanda<P>;
  Tela.displayName = `TelaSobDemanda(${nome})`;

  const carregar = async (): Promise<void> => {
    await buscar();
  };
  registradas.push(carregar);

  return Object.assign(Tela, { carregar, sobDemanda: true as const });
}

/** A tela do roteador é sob demanda? (O PDV e o login não são, de propósito.) */
export function ehTelaSobDemanda(tipo: unknown): tipo is TelaSobDemanda {
  return typeof tipo === 'function' && (tipo as { sobDemanda?: unknown }).sobDemanda === true;
}

/**
 * Baixa o pedaço de TODAS as telas criadas até aqui.
 *
 * Os testes que montam o roteador inteiro chamam antes de montar, para medir a
 * tela e não o carregamento dela. Uma tela que não importa — ou cujo módulo
 * perdeu a exportação — derruba a promessa, e o teste com ela.
 */
export async function carregarTodasAsTelas(): Promise<void> {
  await Promise.all(registradas.map((carregar) => carregar()));
}
