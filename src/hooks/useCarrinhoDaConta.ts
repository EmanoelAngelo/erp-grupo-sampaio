/**
 * O CARRINHO DA VITRINE, SINCRONIZADO COM A CONTA (GAP-PRD-193).
 *
 * A vitrine continua dona do estado do carrinho (a lista que ela desenha);
 * este gancho só o mantém igual ao da conta enquanto alguém está logado:
 *
 *   1. ao entrar (ou abrir a vitrine já logado): se a cópia do navegador é
 *      desta conta, o SERVIDOR é a verdade (o outro aparelho pode ter
 *      mudado); se não é, o carrinho do aparelho se FUNDE na conta (mesmo
 *      produto = a maior quantidade) e a cópia passa a ser desta conta;
 *   2. a cada mudança do carrinho depois disso, a conta recebe a lista nova
 *      (com um respiro de 400 ms, para cliques seguidos virarem um envio);
 *   3. sem sessão, a cópia deixa de ser "da conta" — o próximo login funde;
 *   4. "Sair" de propósito esquece o carrinho da conta na tela também.
 *
 * O que saiu da vitrine volta em `descartados` e vira um aviso na tela.
 */
import { useEffect, useRef, useState } from 'react';
import { carrinhoApi, type CarrinhoDoServidor, type ProdutoDoCarrinho } from '@/lib/api/carrinho';
import { CARRINHO_ESQUECIDO, donoDoCarrinhoLocal, marcarDonoDoCarrinho } from '@/lib/carrinhoLocal';
import type { SessaoPortal } from '@/lib/portalSession';

interface LinhaMinima {
  product: { id: string };
  quantity: number;
}

function itensDe(linhas: LinhaMinima[]) {
  return linhas.map((l) => ({ productId: l.product.id, quantity: l.quantity }));
}

function chave(linhas: LinhaMinima[]): string {
  return JSON.stringify(itensDe(linhas));
}

export function useCarrinhoDaConta<L extends LinhaMinima>({
  sessao,
  cart,
  setCart,
  paraLinha,
}: {
  sessao: SessaoPortal | null;
  cart: L[];
  setCart: (linhas: L[]) => void;
  /** Como a vitrine monta a linha dela a partir do que o servidor devolveu. */
  paraLinha: (produto: ProdutoDoCarrinho, quantidade: number) => L;
}): { aviso: string | null } {
  const [aviso, setAviso] = useState<string | null>(null);
  /** A conta cujo carrinho já foi carregado nesta tela (e pode receber envios). */
  const pronto = useRef<string | null>(null);
  /** O que a conta tem, pelo último envio ou leitura. */
  const sincronizado = useRef<string | null>(null);
  const carrinhoAtual = useRef(cart);
  carrinhoAtual.current = cart;

  const token = sessao?.token ?? null;
  const conta = sessao?.account.id ?? null;

  const adotar = (r: CarrinhoDoServidor) => {
    const linhas = r.items.map((i) => paraLinha(i.product, i.quantity));
    sincronizado.current = chave(linhas);
    setCart(linhas);
    setAviso(
      r.descartados.length > 0
        ? `${r.descartados.length === 1 ? 'Um item saiu' : `${r.descartados.length} itens saíram`} do carrinho: não está mais à venda na loja (ou precisa escolher o tamanho na página do produto).`
        : null,
    );
  };

  // 1 e 3: entrar funde (ou lê); sem sessão, a cópia deixa de ser da conta.
  useEffect(() => {
    pronto.current = null;
    if (!token || !conta) {
      marcarDonoDoCarrinho(null);
      return;
    }
    let vivo = true;
    const daConta = donoDoCarrinhoLocal() === conta;
    const pedido = daConta
      ? carrinhoApi.ler(token)
      : carrinhoApi.mesclar(token, itensDe(carrinhoAtual.current));
    pedido
      .then((r) => {
        if (!vivo) return;
        adotar(r);
        marcarDonoDoCarrinho(conta);
        pronto.current = conta;
      })
      .catch(() => {
        // Sem a conta agora (rede, sessão vencida): o carrinho da tela segue
        // valendo, e nada é enviado até a próxima entrada dar certo.
      });
    return () => {
      vivo = false;
    };
    // `adotar`/`paraLinha` mudam a cada render da vitrine; o gatilho é a conta.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, conta]);

  // 2: cada mudança depois de carregado vai para a conta.
  useEffect(() => {
    if (!token || !conta || pronto.current !== conta) return;
    const agora = chave(cart);
    if (agora === sincronizado.current) return;
    const espera = setTimeout(() => {
      carrinhoApi
        .trocar(token, itensDe(cart))
        .then(() => {
          sincronizado.current = agora;
        })
        .catch(() => {
          // Falhou o envio: a próxima mudança tenta de novo com a lista toda.
        });
    }, 400);
    return () => clearTimeout(espera);
  }, [cart, token, conta]);

  // 4: "Sair" esquece o carrinho da conta na tela aberta.
  useEffect(() => {
    const esquecer = () => {
      sincronizado.current = null;
      setCart([]);
    };
    window.addEventListener(CARRINHO_ESQUECIDO, esquecer);
    return () => window.removeEventListener(CARRINHO_ESQUECIDO, esquecer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { aviso };
}
