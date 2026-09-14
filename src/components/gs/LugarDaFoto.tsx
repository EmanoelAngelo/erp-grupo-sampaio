/**
 * O LUGAR DA FOTO — rodada 56.
 *
 * ============================================================================
 * POR QUE ISTO É O COMPONENTE MAIS IMPORTANTE DA RODADA
 * ============================================================================
 *
 * Medido no banco real: dos produtos publicados nas cinco lojas do grupo,
 * ZERO tem foto. Nenhuma loja tem logo. Nenhuma tem capa. Então o placeholder
 * não é um detalhe de borda — é o que o cliente vê na vitrine inteira, hoje, e
 * vai continuar vendo até o dono terminar de fotografar o estoque.
 *
 * O que havia era um retângulo `bg-surface-hover` com a palavra "sem imagem"
 * em cinza, repetido em QUATRO lugares e escrito de duas maneiras diferentes
 * ("sem imagem" no card e no carrossel, "Sem foto cadastrada" na página do
 * produto). Um retângulo cinza vazio lê como DEFEITO: o cliente conclui que a
 * página não carregou.
 *
 * ============================================================================
 * O QUE MUDA, E POR QUE NÃO É UMA IMAGEM GENÉRICA
 * ============================================================================
 *
 * O comentário que estava na página do produto tinha razão e continua valendo:
 * "uma imagem genérica no lugar faria o cliente achar que é outra coisa". Uma
 * silhueta de camiseta numa loja que vende tênis mente sobre o produto.
 *
 * Então o lugar da foto não finge ser foto. Ele mostra o que o sistema SABE:
 * a inicial da loja, na cor da marca, e o nome do produto. É o mesmo gesto de
 * uma etiqueta escrita à mão numa peça que ainda não foi para o estúdio — lê
 * como "a foto ainda vem", não como "quebrou".
 *
 * As cores saem dos tokens da marca (`data-marca` na casca, rodada 40), então
 * o mesmo componente sai verde na Preço Justo e rosa na Me Mimei sem uma linha
 * de condicional.
 */

import { useEffect, useState } from 'react';
import { coreApi } from '@/lib/api/core';

interface LugarDaFotoProps {
  /** Nome da loja — vira a inicial e o rótulo. */
  loja: string;
  /** Roupa é alta; frasco é quadrado. Vem do arranjo do negócio. */
  proporcao?: 'quadrado' | 'retrato';
  /** Para o teste achar o lugar exato, e para a tela poder medir. */
  testId?: string;
}

/**
 * O NOME DO PRODUTO NÃO ENTRA AQUI, e a ausência é deliberada.
 *
 * Ele já está logo abaixo, no card, junto do preço — que é onde a pessoa lê.
 * Repeti-lo dentro do quadro faria a mesma peça aparecer duas vezes no mesmo
 * cartão, e num card de 160px isso é metade do espaço gasto dizendo a mesma
 * coisa. O que o quadro precisa dizer é DE QUEM É e QUE ELE VAI SER PREENCHIDO.
 */
export function LugarDaFoto({ loja, proporcao = 'quadrado', testId }: LugarDaFotoProps) {
  const inicial = String(loja ?? '?').trim().charAt(0).toUpperCase() || '?';

  return (
    <div
      data-testid={testId}
      /*
        `aria-hidden` de propósito: o nome do produto está logo abaixo, no
        próprio card. Um leitor de tela que anunciasse "G, Gringa, Jaqueta
        Corta-Vento" e depois "Jaqueta Corta-Vento" leria a mesma peça duas
        vezes — e a segunda é a que tem o preço junto.
      */
      aria-hidden="true"
      /*
        `container-type: inline-size` NÃO é enfeite: sem ele o `cqw` da inicial
        mede o VIEWPORT em vez deste quadro, e a letra sai do mesmo tamanho no
        card de 160px e na página do produto — batendo sempre no teto do
        `clamp`. Medido no navegador: 48px nos dois. Com o contêiner declarado,
        a inicial acompanha a largura do próprio lugar da foto.
      */
      style={{ containerType: 'inline-size' }}
      className={`w-full ${
        proporcao === 'retrato' ? 'aspect-[3/4]' : 'aspect-square'
      } rounded-[var(--gs-radius)] overflow-hidden flex flex-col items-center justify-center
        gap-1 px-3 text-center select-none
        bg-[var(--gs-purple-100)] border border-[var(--gs-border)]`}
    >
      <span
        className="text-[var(--gs-purple-700)] font-bold leading-none opacity-70"
        style={{ fontSize: 'clamp(1.5rem, 26cqw, 5rem)' }}
      >
        {inicial}
      </span>
      <span className="text-[length:var(--gs-text-sm)] text-[var(--gs-purple-800)] font-semibold opacity-80">
        {loja}
      </span>
      {/*
        "Foto em breve" e não "sem imagem": as duas frases descrevem o mesmo
        estado e mandam recados opostos. A primeira diz que a loja está
        trabalhando; a segunda, que falta alguma coisa — e o cliente que lê
        "sem imagem" conclui que a página quebrou.
      */}
      <span className="text-[length:var(--gs-text-xs)] text-[var(--gs-muted)] uppercase tracking-wide">
        Foto em breve
      </span>
    </div>
  );
}

interface FotoDeProdutoProps {
  /** Caminho relativo do banco (`/uploads/...`) — o resolvedor da API entra aqui. */
  url: string | null | undefined;
  alt: string;
  /** Sem foto (ou com foto morta), o quadro é do LugarDaFoto desta loja. */
  loja: string;
  proporcao?: 'quadrado' | 'retrato';
  /**
   * `cover` preenche o quadro cortando as bordas — certo para o card, onde a
   * foto é convite. `contain` mostra a peça INTEIRA — certo para a página do
   * produto, onde cortar a barra da roupa é esconder o que se está vendendo.
   */
  modo?: 'cover' | 'contain';
  /**
   * A grade carrega preguiçoso por padrão: o servidor serve o arquivo
   * ORIGINAL, sem redimensionar, e uma home com 12 originais de câmera
   * baixando de uma vez trava o celular. A foto principal do detalhe é o
   * contrário — é o que o cliente veio ver — e pede `eager`.
   */
  eager?: boolean;
  testId?: string;
}

/**
 * A MOLDURA QUE SABE FALHAR — rodada 57.
 *
 * Toda foto da loja passava direto do banco para o `src`, sem plano B: URL
 * morta (arquivo apagado de uploads/, nome errado no lote de fotos,
 * restauração sem a pasta) virava o ícone de imagem quebrada do navegador
 * dentro da vitrine. Aqui a falha volta sozinha para o LugarDaFoto — mesma
 * proporção, mesma moldura, a grade nem se mexe.
 *
 * É UM componente porque eram QUATRO cópias do mesmo par moldura+img (grade,
 * ofertas, destaques, prateleira de relacionados) — e quatro cópias divergem
 * no primeiro conserto feito em três delas, que é a cicatriz que este
 * repositório já conhece.
 */
export function FotoDeProduto({
  url,
  alt,
  loja,
  proporcao = 'quadrado',
  modo = 'cover',
  eager = false,
  testId,
}: FotoDeProdutoProps) {
  const [morta, setMorta] = useState(false);

  // A moldura é reusada entre produtos (carrossel, prateleira): a foto morta
  // de um não pode condenar a do próximo.
  useEffect(() => {
    setMorta(false);
  }, [url]);

  if (!url || morta) {
    return <LugarDaFoto loja={loja} proporcao={proporcao} testId={testId} />;
  }

  return (
    <div
      data-testid={testId}
      className={`${
        proporcao === 'retrato' ? 'aspect-[3/4]' : 'aspect-square'
      } bg-[var(--gs-surface-hover)] rounded-[var(--gs-radius)] overflow-hidden
        flex items-center justify-center`}
    >
      <img
        src={coreApi.imageUrl(url)}
        alt={alt}
        loading={eager ? undefined : 'lazy'}
        decoding="async"
        onError={() => setMorta(true)}
        className={`w-full h-full ${modo === 'contain' ? 'object-contain' : 'object-cover'}`}
      />
    </div>
  );
}
