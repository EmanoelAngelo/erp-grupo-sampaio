/**
 * Ícones do sistema, desenhados aqui dentro.
 *
 * POR QUE SVG EMBUTIDO E NÃO UMA BIBLIOTECA
 *
 * O menu usava glifos de texto (`⌂`, `☺`, `▣`) porque a `lucide-react` foi uma
 * das 12 dependências removidas na rodada 19. Glifo de fonte não tem espessura
 * de traço controlável, muda de desenho conforme a fonte instalada e desalinha
 * na vertical — três motivos pelos quais o menu não parecia com a referência.
 *
 * Voltar a biblioteca resolveria o desenho e desfaria a limpeza. Como são
 * catorze ícones e nenhum deles muda, desenhar aqui custa menos que carregar um
 * pacote inteiro para usar catorze símbolos.
 *
 * O TRAÇO É A IDENTIDADE. Todos compartilham o mesmo `viewBox`, a mesma
 * espessura e as mesmas pontas arredondadas — é isso que faz catorze desenhos
 * diferentes lerem como um conjunto. Ícone novo entra por aqui, com os mesmos
 * atributos, nunca com `fill` sólido no meio de um conjunto de contorno.
 *
 * `currentColor` no traço: quem decide a cor é o CSS de quem usa, então o
 * mesmo ícone serve no menu, no botão e no estado vazio sem variante nova.
 */
import type { SVGProps } from 'react';

export type NavIconName =
  | 'inicio'
  | 'pessoas'
  | 'produtos'
  | 'estoque'
  | 'vendas'
  | 'financeiro'
  | 'compras'
  | 'oficina'
  | 'ecommerce'
  | 'fiscal'
  | 'crm'
  | 'locacao'
  | 'relatorios'
  | 'configuracoes';

/** Os traços de cada ícone. Só o miolo — o invólucro é comum a todos. */
const DESENHOS: Record<NavIconName, React.ReactNode> = {
  inicio: (
    <>
      <path d="M3.5 10.7 12 3.6l8.5 7.1" />
      <path d="M5.8 9.6V19.4a1 1 0 0 0 1 1h10.4a1 1 0 0 0 1-1V9.6" />
      <path d="M9.7 20.4v-5.6h4.6v5.6" />
    </>
  ),
  pessoas: (
    <>
      <circle cx="12" cy="8" r="3.6" />
      <path d="M4.8 20.4a7.2 7.2 0 0 1 14.4 0" />
    </>
  ),
  produtos: (
    <>
      <path d="M4.4 8h15.2l-1.1 11.5a1 1 0 0 1-1 .9H6.5a1 1 0 0 1-1-.9L4.4 8Z" />
      <path d="M9 8V6.2a3 3 0 0 1 6 0V8" />
    </>
  ),
  estoque: (
    <>
      <path d="M3.8 7.6 12 3.8l8.2 3.8v8.8L12 20.2l-8.2-3.8V7.6Z" />
      <path d="M3.8 7.6 12 11.4l8.2-3.8" />
      <path d="M12 11.4v8.8" />
    </>
  ),
  vendas: (
    <>
      <path d="M2.8 4h2.1l2.3 10.6a1.4 1.4 0 0 0 1.4 1.1h8.1a1.4 1.4 0 0 0 1.4-1.1L21 7.4H6" />
      <circle cx="9.2" cy="19.4" r="1.3" />
      <circle cx="17.4" cy="19.4" r="1.3" />
    </>
  ),
  financeiro: (
    <>
      <path d="M12 3.2v17.6" />
      <path d="M16.2 7.6c0-1.8-1.9-2.9-4.2-2.9s-4.2 1.1-4.2 2.9c0 4.3 8.4 2.4 8.4 6.7 0 1.8-1.9 2.9-4.2 2.9s-4.2-1.1-4.2-2.9" />
    </>
  ),
  compras: (
    <>
      <path d="M12 3.4v9.8" />
      <path d="m8.2 9.6 3.8 3.8 3.8-3.8" />
      <path d="M4.2 15.8v3.4a1.4 1.4 0 0 0 1.4 1.4h12.8a1.4 1.4 0 0 0 1.4-1.4v-3.4" />
    </>
  ),
  oficina: (
    <>
      <path d="M20.1 5.3a4.9 4.9 0 0 1-6.4 6.4l-6.8 6.8a2.2 2.2 0 0 1-3.1-3.1l6.8-6.8a4.9 4.9 0 0 1 6.4-6.4l-2.9 2.9.3 3.2 3.2.3 2.5-3.3Z" />
    </>
  ),
  ecommerce: (
    <>
      <circle cx="12" cy="12" r="8.4" />
      <path d="M3.6 12h16.8" />
      <path d="M12 3.6a13 13 0 0 1 0 16.8 13 13 0 0 1 0-16.8Z" />
    </>
  ),
  fiscal: (
    <>
      <path d="M6.4 3.4h6.4l5 5v12.2a1 1 0 0 1-1 1H6.4a1 1 0 0 1-1-1V4.4a1 1 0 0 1 1-1Z" />
      <path d="M12.6 3.4v5.2h5.2" />
      <path d="M8.6 13.4h6.8" />
      <path d="M8.6 16.8h6.8" />
    </>
  ),
  crm: (
    <>
      <path d="M6.4 3.4h11.2l3 4.8-8.6 11.8L3.4 8.2l3-4.8Z" />
      <path d="M3.4 8.2h17.2" />
      <path d="m9 3.4 3 4.8 3-4.8" />
    </>
  ),
  locacao: (
    <>
      <circle cx="12" cy="12" r="8.4" />
      <path d="M12 7.2V12l3.2 2" />
    </>
  ),
  relatorios: (
    <>
      <path d="M3.8 20.2h16.4" />
      <path d="M7.6 20.2v-5.8" />
      <path d="M12 20.2V7.8" />
      <path d="M16.4 20.2v-8.8" />
    </>
  ),
  configuracoes: (
    <>
      <circle cx="12" cy="12" r="8.4" />
      <circle cx="12" cy="12" r="4.4" />
      <circle cx="12" cy="12" r="1.3" />
    </>
  ),
};

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: NavIconName;
  /** Lado do quadrado, em pixels. O traço não engrossa junto: é vetor. */
  size?: number;
}

/**
 * Ícone do menu.
 *
 * `aria-hidden` porque o rótulo vem sempre ao lado, em texto. Ícone que se
 * anuncia ao leitor de tela junto de um rótulo idêntico faz a pessoa ouvir tudo
 * duas vezes.
 */
export function NavIcon({ name, size = 20, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
      {...rest}
    >
      {DESENHOS[name]}
    </svg>
  );
}

/** Sinais pequenos de interface. Mesmo traço dos ícones do menu. */
function SinalPequeno({
  d,
  size = 14,
  ...rest
}: SVGProps<SVGSVGElement> & { d: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
      {...rest}
    >
      <path d={d} />
    </svg>
  );
}

export function IconeMais(props: Omit<SVGProps<SVGSVGElement>, 'd'> & { size?: number }) {
  return <SinalPequeno d="M12 5.5v13M5.5 12h13" {...props} />;
}

export function IconeCruz(props: Omit<SVGProps<SVGSVGElement>, 'd'> & { size?: number }) {
  return <SinalPequeno d="M6.5 6.5l11 11M17.5 6.5l-11 11" {...props} />;
}

/**
 * Seta do grupo do menu.
 *
 * UMA seta que GIRA, não duas diferentes. Trocar `›` por `⌄` fazia o ícone
 * saltar de tamanho e de posição na hora de abrir, porque são dois glifos com
 * métricas distintas. Girando o mesmo desenho, o olho acompanha o movimento e
 * entende que é o mesmo controle.
 */
export function Chevron({
  open,
  size = 16,
  className = '',
  ...rest
}: Omit<SVGProps<SVGSVGElement>, 'name'> & { open: boolean; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
      className={`transition-transform duration-150 ${open ? 'rotate-90' : ''} ${className}`}
      {...rest}
    >
      <path d="m9 5 7 7-7 7" />
    </svg>
  );
}
